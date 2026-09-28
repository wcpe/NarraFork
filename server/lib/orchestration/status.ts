/**
 * 编排状态的只读观测（阶段 7）。
 *
 * 编排模式此前完全没有仪表：用户看不到本轮用了哪个档位 / 哪个模型、池子里停放着
 * 什么、容量配得合不合理。结果是四档池的配置只能盲调——配错的表现是"派发变慢"或
 * "总是在新建 worker"，两者都没有任何可见信号。
 *
 * 本模块把三组数据一次读出来（其余一概不读）：
 *   1. 会话身份：方案 id / 方案名 / 编制者模型；
 *   2. 每档的停放数与在场数（停放来自登记簿快照，在场来自 `narrators` 行）；
 *   3. 每档池条目的「在飞数 / 并发上限」，上限为 0 或缺省时表示为「不限」。
 *
 * 另有一块**历史**由 `audit.ts` 提供（`runs`）：分档的次数 / 平均耗时 / 复用命中与
 * 最近若干条派发。它回答的是与上面三组"现在是什么"相反的问题——"过去几次的账"。
 *
 * **整个模块只读**：不写任何行、不改登记簿、不占并发位。仅有的几次 I/O 都是有界的
 * 小查询——按 `id` 取一行（主键），按 `parent_narrator_id`（有索引
 * `idx_narrators_parent`）取该会话的直接子代，以及按 `coordinator_narrator_id`
 * 取有界的派发窗口，且都只取需要的列；逐 worker 的上下文占用是每行一次索引点查，
 * 各自有 {@link WORKER_CONTEXT_LOOKBACK_ROWS} 行的扫描上界。
 *
 * 明确的**不做**：
 * - 清单只返回有界的 worker/reviewer 标量快照；不携带消息正文或完整会话历史。
 * - 不返回"这次是复用来的还是新建的"：**派发历史里有**（`runs`，`reusedWorker` 由
 *   派发路径自己写下），但容量视图里没有，因为没有任何地方持久化"当前在跑的这只
 *   是不是复用来的"——编一个出来就是假数据。
 */

import { db } from "@server/db";
import { apiRequests, narrators } from "@server/db/schema";
import { logger } from "@server/lib/logger";
import {
	parseOrchestrationModelValue,
	resolveEffectiveModel,
	settings,
} from "@server/lib/settings";
import { firstUsableOrchestratorModel } from "@shared/orchestration-orchestrator-model";
import type {
	OrchestrationPoolStatus,
	OrchestrationStatus,
	OrchestrationStatusResponse,
	OrchestrationTierStatus,
	OrchestrationWorkerStatus,
} from "@shared/orchestration-status";

import { and, desc, eq, like, ne, or } from "drizzle-orm";
import { readOrchestrationRunAudit } from "./audit";
import { ensureRegistryHydrated, parkedWorkerSnapshot } from "./parking";
import { findEnabledProfile, inFlightSnapshot } from "./runtime";
import {
	ORCHESTRATION_TIERS,
	ORCHESTRATION_TYPE_PREFIX,
	type OrchestrationProfile,
	type OrchestrationTier,
	parseOrchestrationType,
	parseReviewerType,
	REVIEWER_TYPE_PREFIX,
} from "./types";

/**
 * 线上形状定义在 `shared/orchestration-status.ts`（前端读同一份契约）。
 * 这里只做再导出，让服务端调用方从本模块取类型即可。
 *
 * `running` 的口径在这里补充说明：它是本编排的直接执行者子代理里**未归档**的数量，
 * 刻意不是"status = working"——跑完但还没停放的 worker 一样占着这个档位，而
 * "跑完就没了"正是用户需要看到的信号（它说明停放判定没成立）。
 */
export type {
	OrchestrationPoolStatus,
	OrchestrationStatus,
	OrchestrationStatusResponse,
	OrchestrationTierStatus,
	OrchestrationWorkerRole,
	OrchestrationWorkerStatus,
} from "@shared/orchestration-status";

/**
 * 一次状态查询最多看多少个子代行。
 *
 * 这是**读取预算**而不是数量上限：超出的部分不扩大读取，只是一部分 worker 没被
 * 计进 `running`（少算几个计数不会误导决策，而拖住主线程会）。
 */
const LIVE_WORKER_READ_LIMIT = 500;

/** 四档骨架：每个档位一份独立的可变值（共用同一个对象会让四档串在一起）。 */
function emptyTierRecord<T>(create: () => T): Record<OrchestrationTier, T> {
	return {
		chore: create(),
		quick: create(),
		medium: create(),
		heavy: create(),
	};
}

/** 把池配置压成状态条目：按 model 去重、把上限 0/缺省表示成 `null`（不限）。 */
function buildPoolStatus(
	pool: unknown,
	inFlight: ReadonlyMap<string, number>,
): OrchestrationPoolStatus[] {
	if (!Array.isArray(pool)) return [];
	// 与 `pool.ts` 的 `dedupeByModel` 同一条规则（保留首次出现的条目）：同一条池里
	// 写了两遍同一个模型时，它在飞数是**同一个计数器**，列两行会让人以为容量翻倍。
	const seen = new Set<string>();
	const entries: OrchestrationPoolStatus[] = [];
	for (const raw of pool as unknown[]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const model = (raw as { model?: unknown }).model;
		if (typeof model !== "string" || model.trim().length === 0) continue;
		const trimmed = model.trim();
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		const limit = (raw as { maxConcurrent?: unknown }).maxConcurrent;
		entries.push({
			model: trimmed,
			inFlight: inFlight.get(trimmed) ?? 0,
			// 与 `pool.ts` 的 `limitOf` 同源：缺省与 ≤ 0 都是不限，负数按不限容错。
			maxConcurrent:
				typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : null,
		});
	}
	return entries;
}

/**
 * 组装状态的全部纯逻辑（无 I/O），便于逐条断言容量与档位的表示。
 *
 * 返回类型刻意排除了三类东西——`runs`（派发历史）、`workers` / `workerCount` /
 * `workersTruncated`（逐 worker 明细）：它们都要真库读取，由
 * {@link readOrchestrationStatus} 挂上。让这个纯函数去碰 I/O 会把"容量表示"
 * 与"明细读取"两件事绑在一起，而前者正是最需要能单独断言的部分。
 */
export function buildOrchestrationStatus(input: {
	profileId: string;
	profileName: string;
	orchestratorModel: string | null;
	profile: OrchestrationProfile | undefined;
	parkedByTier: Readonly<Record<OrchestrationTier, number>>;
	runningByTier: Readonly<Record<OrchestrationTier, number>>;
	inFlight: ReadonlyMap<string, number>;
}): Omit<OrchestrationStatus, "runs" | "workers" | "workerCount" | "workersTruncated"> {
	const tiers = emptyTierRecord<OrchestrationTierStatus>(() => ({ parked: 0, running: 0 }));
	const pools = emptyTierRecord<OrchestrationPoolStatus[]>(() => []);
	for (const tier of ORCHESTRATION_TIERS) {
		// 计数一律走 ?? 0：快照缺键时显示 0，而不是 NaN/undefined。
		tiers[tier] = {
			parked: input.parkedByTier[tier] ?? 0,
			running: input.runningByTier[tier] ?? 0,
		};
		// 方案不存在（被删/被禁用）时池子留空：假装有池会让容量数字无从解释。
		pools[tier] = buildPoolStatus(input.profile?.tiers?.[tier]?.pool, input.inFlight);
	}
	return {
		profileId: input.profileId,
		profileName: input.profileName,
		orchestratorModel: input.orchestratorModel,
		tiers,
		pools,
	};
}

/**
 * 编制者模型。
 *
 * 复用会话装配那一套解析（`resolveEffectiveModel`），否则这里显示的会是聚合引用
 * 这类"设置里写着、实际不发给上游"的值。解析失败（例如编制者模型指向了另一个
 * 编排哨兵）时不编一个模型名，退回配置里的原始条目——至少是用户自己写下的值。
 *
 * 局限：不传 stickyProvider，因此"被锁定的提供商"这一层在显示上与真正装配时可能
 * 差一个前缀。观测用途下这个偏差可接受，而为此把整条装配路径拉进来不值得。
 */
function resolveOrchestratorModelForDisplay(): string | null {
	// 「取第一个可用者」与 `settings/provider.ts` 的 `resolveOrchestratorModel`
	// 共用同一份容错解析：两处各挑一次就会出现"界面显示 A、实际发给上游 B"。
	const candidate = firstUsableOrchestratorModel(
		settings.agent?.orchestration?.orchestratorModels,
	)?.model;
	if (!candidate) return null;
	try {
		return resolveEffectiveModel(candidate);
	} catch {
		return candidate;
	}
}

/**
 * 统计本编排**在场**（未归档）的执行者 worker 数，按档位分组。
 *
 * 两条口径都刻意与停放池保持一致：
 * - 只看直接子代（`parent_narrator_id`，有索引），别的编排会话的 worker 不算；
 * - 剔除归档行，且因为查询用的是 `orch--%`，复核者（`orch-review--…`）永远不在内
 *   ——与停放池"复核者不进池"是同一条边界。
 *
 * 失败一律吞掉并记 warn：这是观测接口，读不到计数时应当"少显示一个数字"，
 * 而不是让整次状态查询报错。
 */
async function countLiveWorkersByTier(
	parentNarratorId: string,
): Promise<Record<OrchestrationTier, number>> {
	const counts = emptyTierRecord<number>(() => 0);
	try {
		const rows = await db
			.select({ subagentType: narrators.subagentType })
			.from(narrators)
			.where(
				and(
					eq(narrators.parentNarratorId, parentNarratorId),
					ne(narrators.status, "archived"),
					like(narrators.subagentType, `${ORCHESTRATION_TYPE_PREFIX}%`),
				),
			)
			.limit(LIVE_WORKER_READ_LIMIT);
		for (const row of rows) {
			const parsed = parseOrchestrationType(row.subagentType);
			if (!parsed.ok) continue;
			counts[parsed.tier] += 1;
		}
	} catch (err) {
		logger.warn("Failed to count in-scene orchestration workers", {
			parentNarratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	return counts;
}

/**
 * 清单里最多列多少只 worker。
 *
 * 这是**显示上限**而不是读取预算：多出来的部分仍计入 {@link workerCount}，
 * 界面据此如实标注"还有 N 只没显示"。选 50 是因为再长的清单在面板上已经无法阅读，
 * 而它的主要用途是"看清现在有哪几只、各自什么状态"。
 */
export const WORKER_LIST_LIMIT = 50;

/**
 * 统计 worker 总数时的读取上限。
 *
 * 只在清单确实被截断时才跑这一次 id-only 查询；到顶时 `workerCount` 是一个**下界**
 * （文档已如此说明，界面不把它当作精确值来用）。真实编排会话的 worker 数是几十的量级，
 * 这个上限只是"长会话不该把主线程拖住"的保险丝。
 */
const WORKER_COUNT_CAP = 500;

/** 逐 worker 明细的读取结果。 */
export interface OrchestrationWorkerReadResult {
	workers: OrchestrationWorkerStatus[];
	workerCount: number;
	workersTruncated: boolean;
}

/** 逐 worker 明细的一行（来自 `narrators`，只取需要的列）。 */
interface WorkerRow {
	id: string;
	subagentType: string | null;
	model: string | null;
	status: string;
	lastMessageAt: string | null;
}

/**
 * 把 `narrators` 行装配成清单行（纯逻辑，无 I/O）。
 *
 * 三条刻意的规则：
 * - **解析不出档位的行直接跳过**（`subagent_type` 不是编排编码），而不是编一个档位：
 *   查询已经用 `orch--%` 过滤过，走到这里的只可能是被手改过的脏数据；
 * - `reused` 从**有界的派发窗口**里查，查不到就是 `null`（未知）而不是 `false`——
 *   把一个不在窗口里的 worker 说成"新建的"会让人在调停放池参数时得到反向结论；
 * - `contextPercent` 缺值就是 `null`（未知）。**绝不退化成 0**：0 会被读成
 *   "这只 worker 的上下文还很空"，与真相正好相反。
 */
export function buildOrchestrationWorkers(input: {
	rows: readonly WorkerRow[];
	/** workerNarratorId → 最近那次派发是否由复用而来（来自有界的派发历史窗口）。 */
	reusedByWorker: ReadonlyMap<string, boolean>;
	/** narratorId → 最后一次请求记录的上下文占用率（可能缺项）。 */
	contextPercentByWorker: ReadonlyMap<string, number>;
}): OrchestrationWorkerStatus[] {
	const workers: OrchestrationWorkerStatus[] = [];
	for (const row of input.rows) {
		const parsedWorker = parseOrchestrationType(row.subagentType);
		const parsedReviewer = parseReviewerType(row.subagentType);
		const parsed = parsedWorker.ok ? parsedWorker : parsedReviewer;
		if (!parsed.ok) continue;
		const contextPercent = input.contextPercentByWorker.get(row.id);
		workers.push({
			narratorId: row.id,
			role: parsedWorker.ok ? "worker" : "reviewer",
			tier: parsed.tier,
			model: row.model && row.model.trim().length > 0 ? row.model : null,
			// 停放即 `status === "archived"`：不另给一个 `parked` 布尔，两个字段表达
			// 同一件事迟早会在某一侧漂移（一个说已停放、一个说空闲）。
			status: row.status,
			reused: input.reusedByWorker.get(row.id) ?? null,
			lastActivityAt: row.lastMessageAt ?? null,
			contextPercent:
				typeof contextPercent === "number" && Number.isFinite(contextPercent)
					? contextPercent
					: null,
		});
	}
	return workers;
}

/**
 * 读一只 worker 的上下文占用率时，最多往回看几行请求。
 *
 * 这是**扫描上界**而不是"尽力而为"：配合
 * `idx_api_requests_narrator(narrator_id, created_at)` 的逆序索引扫描，一次点查最多
 * 触及 K 个索引项、K 次行读取（`LIMIT` 让 SQLite 拿到 K 行就停，不会继续往下翻）。
 * 整份清单的上界因此是 `清单上限 × K` 行，与请求总数无关。
 *
 * 取 12 的理由：需要往回看的情形是"最近若干次请求都没能报出占用率"（失败的、
 * 被中断的、上游没给 usage 的那些），正常一次任务里这种行是零星的几条；12 足以跨过
 * 一段连续的重试/失败，同时把每次轮询的代价压在几十行以内。窗口内找不到就如实说
 * 「未知」，不用更早的值冒充当前占用。
 */
export const WORKER_CONTEXT_LOOKBACK_ROWS = 12;

/**
 * 读出一只 worker 最近**有值**的上下文占用率（在有界窗口内）。
 *
 * 按 `idx_api_requests_narrator(narrator_id, created_at)` 逆序取最多
 * {@link WORKER_CONTEXT_LOOKBACK_ROWS} 行，返回其中最靠前的一个有值行。
 *
 * 「最后一个有值的」而不是「最后一次请求」：占用率**不是每次请求都会写**
 * （上游没给 usage、请求失败/被中断的路由都不会记这一列），所以"最后一次请求那一行
 * 没有值"是常态而不是异常。以前只看那一行，结果是 worker 明明刚报过占用率，面板上
 * 却写着「未知」——用户看到的正是这个。
 *
 * 窗口内一个值都没有、或读不出有限数时返回 `null`（未知），**绝不退化成 0**：
 * 0 会被读成"这只 worker 的上下文还很空"，与真相正好相反。
 */
async function readWorkerContextPercent(workerNarratorId: string): Promise<number | null> {
	const rows = await db
		.select({ contextPercent: apiRequests.contextPercent })
		.from(apiRequests)
		.where(eq(apiRequests.narratorId, workerNarratorId))
		.orderBy(desc(apiRequests.createdAt))
		// `LIMIT` 是这条查询的**有界性来源**：没有它，往回找第一个有值的行会退化成
		// "逆序扫描到第一个匹配"，而每次状态轮询都要按清单行数跑 N 遍。
		.limit(WORKER_CONTEXT_LOOKBACK_ROWS);
	for (const row of rows) {
		const value = row.contextPercent;
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

/**
 * 读出该编排名下的执行者清单。
 *
 * 两条有界查询：
 * 1. 明细：按 `parent_narrator_id`（有索引 `idx_narrators_parent`）取最近活动的
 *    `WORKER_LIST_LIMIT + 1` 行——多取一行就是为了知道"是不是还有更多"，
 *    而不必为了知道这件事去跑一次全量 COUNT；
 * 2. 总数：**只在清单确实被截断时**才跑，且只取 `id` 一列、带读取上限。
 *
 * 上下文占用按行补一次点查（≤ 清单上限次，每次都是索引定位、且有
 * {@link WORKER_CONTEXT_LOOKBACK_ROWS} 行的扫描上界）。失败一律吞掉并记
 * warn：这是观测接口，读不到某个数字时应当"少显示一个"，而不是让整次查询报错。
 */
async function readOrchestrationWorkers(
	parentNarratorId: string,
	reusedByWorker: ReadonlyMap<string, boolean>,
): Promise<OrchestrationWorkerReadResult> {
	let rows: WorkerRow[];
	try {
		rows = await db
			.select({
				id: narrators.id,
				subagentType: narrators.subagentType,
				model: narrators.model,
				status: narrators.status,
				lastMessageAt: narrators.lastMessageAt,
			})
			.from(narrators)
			.where(
				and(
					eq(narrators.parentNarratorId, parentNarratorId),
					or(
						like(narrators.subagentType, `${ORCHESTRATION_TYPE_PREFIX}%`),
						like(narrators.subagentType, `${REVIEWER_TYPE_PREFIX}%`),
					),
				),
			)
			// `lastMessageAt` 为空的行排在最后（SQLite 的 DESC 把 NULL 放末尾），
			// 于是"没跑过几次的"不会压掉真正活跃的那些。
			.orderBy(desc(narrators.lastMessageAt))
			.limit(WORKER_LIST_LIMIT + 1);
	} catch (err) {
		logger.warn("Failed to read orchestration workers", {
			parentNarratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { workers: [], workerCount: 0, workersTruncated: false };
	}

	const truncated = rows.length > WORKER_LIST_LIMIT;
	const listed = truncated ? rows.slice(0, WORKER_LIST_LIMIT) : rows;

	const contextPercentByWorker = new Map<string, number>();
	for (const row of listed) {
		const percent = await readWorkerContextPercent(row.id).catch(() => null);
		if (percent !== null) contextPercentByWorker.set(row.id, percent);
	}

	let workerCount = listed.length;
	if (truncated) {
		try {
			const ids = await db
				.select({ id: narrators.id })
				.from(narrators)
				.where(
					and(
						eq(narrators.parentNarratorId, parentNarratorId),
						or(
							like(narrators.subagentType, `${ORCHESTRATION_TYPE_PREFIX}%`),
							like(narrators.subagentType, `${REVIEWER_TYPE_PREFIX}%`),
						),
					),
				)
				.limit(WORKER_COUNT_CAP);
			workerCount = ids.length;
		} catch (err) {
			// 统计失败不改变"清单被截断"这个已确认的事实，只是数字退回已知的下界。
			logger.warn("Failed to count orchestration workers; reporting the listed count", {
				parentNarratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		workers: buildOrchestrationWorkers({ rows: listed, reusedByWorker, contextPercentByWorker }),
		workerCount,
		workersTruncated: truncated,
	};
}

/**
 * 读取一个会话的编排状态；不在编排模式时返回 `null`。
 *
 * 会话是否处于编排模式**只由 `model` 的哨兵判定**（`__orch__:<profileId>`），与
 * 模型位、模型菜单的判定同源——另找一套"像不像编排"的启发式迟早会与它漂移。
 *
 * 登记簿快照之前先 `ensureRegistryHydrated()`：登记簿是进程级的内存加速视图，
 * 冷启动后还没被任何派发触发重建，直接读会给出"池子是空的"这个假象（真实的归档
 * worker 还在库里）。这次重建就是派发路径本来就会做的那一次查询，每进程一次。
 *
 * 全程不做任何写入，因此可以在任意频率轮询。
 */
export async function readOrchestrationStatus(
	narratorId: string,
	options: { runLimit?: number } = {},
): Promise<OrchestrationStatus | null> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		// 只取哨兵所在的那一列：`narrators` 还有 system_prompt 这类大字段。
		columns: { model: true },
	});
	const parsed = row ? parseOrchestrationModelValue(row.model) : null;
	if (!parsed) return null;

	await ensureRegistryHydrated();
	const parked = parkedWorkerSnapshot(narratorId);
	const profile = findEnabledProfile(parsed.profileId);
	const runningByTier = await countLiveWorkersByTier(narratorId);

	const base = buildOrchestrationStatus({
		profileId: parsed.profileId,
		profileName: profile?.name?.trim() || parsed.profileId,
		orchestratorModel: resolveOrchestratorModelForDisplay(),
		profile,
		parkedByTier: parked.byTier,
		runningByTier,
		// 一次查询一份在飞快照（进程级）：逐条读会让同一份状态里的数字来自不同瞬间。
		inFlight: inFlightSnapshot(),
	});

	// 历史单独读出并挂上，而不是塞进 `buildOrchestrationStatus`：那个函数是纯逻辑
	// （它的测试直接逐条断言容量表示），让它去碰 I/O 会把纯组装与真库读取混在一起。
	// 读取自身已有界且失败回落到空聚合，因此这里不需要再兜一层。
	const runs = await readOrchestrationRunAudit({
		coordinatorNarratorId: narratorId,
		// 条数由调用方给（路由的 `?limit=`）；审计模块自己收进上限内，
		// 非法值退回默认，因此这里不做校验也不做截断。
		limit: options.runLimit,
	});

	// 「这只 worker 是不是复用来的」没有任何地方持久化在当前状态上（登记簿只记
	// "现在停着什么"），唯一的线索是有界的派发历史窗口。因此复用它，读不到就是未知。
	// 先读历史再读清单：两处若各读一次，同一个响应里的数字会来自两个瞬间。
	const reusedByWorker = new Map<string, boolean>();
	for (const run of runs.recent) {
		if (run.workerNarratorId) reusedByWorker.set(run.workerNarratorId, run.reusedWorker);
	}
	const workers = await readOrchestrationWorkers(narratorId, reusedByWorker);

	return { ...base, ...workers, runs };
}

/** 路由响应的形状：非编排会话显式给 `orchestration: null`（而不是 404）。 */
export function orchestrationStatusResponse(
	status: OrchestrationStatus | null,
): OrchestrationStatusResponse {
	return { orchestration: status };
}
