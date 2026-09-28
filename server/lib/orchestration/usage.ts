/**
 * 编排会话的 token 开销归集（编排状态面板的数据源）。
 *
 * `api_requests` 已经有逐请求的 token / model，但它没有"这属于哪个编排会话、哪个档位"
 * 这一维。那一维**不需要新增字段**：编排的 worker 与复核者都是编制者的直接子会话
 * （`narrators.parent_narrator_id`，有索引 `idx_narrators_parent`），而它们的档位就写在
 * `subagent_type` 的编码里（`orch--<profileId>--<tier>` / `orch-review--<profileId>--<tier>`）。
 * 于是「编制者 + 它的子会话」就是一个可直接枚举的集合，按 `api_requests.narrator_id`
 * （有索引 `idx_api_requests_narrator`）分组即可。
 *
 * **为什么不去 join `orchestration_runs.worker_narrator_id`**：那张表只记执行者，复核者
 * 不在其中（它刻意不是合法 worker 类型）。独立复核是编排实打实的一笔开销，漏掉它会让
 * "这次编排花了多少"系统性地少算，而少算的钱恰恰是用户最想知道的那部分。
 *
 * **读取预算**（CLAUDE.md 的主线程铁律）：
 * - 子会话枚举有上限 {@link MAX_CHILD_SCAN}，用尽时如实置 `truncated`——宁可说"这是部分和"，
 *   也不要在主线程上按会话长度无上限地扫；
 * - `api_requests` 只 select 四个 token 列与 `narrator_id`，**绝不碰** `raw_dump_json`
 *   这类大字段（它们在同一行里）；
 * - 全模块只读，不写任何行，因此可以在任意频率轮询。
 */

import { db } from "@server/db";
import { apiRequests, narrators } from "@server/db/schema";
import { logger } from "@server/lib/logger";
import type {
	OrchestrationUsage,
	OrchestrationUsageBucket,
	OrchestrationUsageResponse,
	OrchestrationUsageRunDetail,
} from "@shared/orchestration-status";
import type { OrchestrationWorkerTier } from "@shared/orchestration-worker-type";
import { count, eq, inArray, sql } from "drizzle-orm";
import { usageInputSemantics } from "../usage-semantics";
import { ORCHESTRATION_TYPE_PREFIX, type OrchestrationTier, parseOrchestrationType } from "./types";

/**
 * 一次开销查询最多枚举多少个子会话。
 *
 * 这是**读取预算**而不是数量上限：超出的部分不扩大读取，只是没被计进总数，并通过
 * `truncated` 如实告知消费方。这个数取 500 是因为它与 `audit.ts` 的聚合预算同量级——
 * 停放池会让执行者的数量远小于派发次数，真正会累积的是复核者（每复核一次一只）。
 */
const MAX_CHILD_SCAN = 500;

/** 复核者的类型前缀。与 `review.ts` 的 `buildReviewerSubagentType` 同源。 */
const REVIEW_TYPE_PREFIX = "orch-review--";

function emptyBucket(): OrchestrationUsageBucket {
	return {
		requests: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
		outputTokens: 0,
		sources: { measured: 0, estimated: 0, unknown: 0 },
	};
}

function sourceCounts(bucket: OrchestrationUsageBucket): {
	measured: number;
	estimated: number;
	unknown: number;
} {
	return bucket.sources ?? { measured: 0, estimated: 0, unknown: bucket.requests };
}

function emptyTierBuckets(): Record<OrchestrationWorkerTier, OrchestrationUsageBucket> {
	return {
		chore: emptyBucket(),
		quick: emptyBucket(),
		medium: emptyBucket(),
		heavy: emptyBucket(),
	};
}

/** 五个桶相加。**用加法而不是取最大值**，因为四档与编制者之间没有任何包含关系。 */
export function sumUsageBuckets(
	buckets: readonly OrchestrationUsageBucket[],
): OrchestrationUsageBucket {
	const total = emptyBucket();
	for (const bucket of buckets) {
		total.requests += bucket.requests;
		total.inputTokens += bucket.inputTokens;
		total.cachedInputTokens += bucket.cachedInputTokens;
		total.cacheCreationInputTokens += bucket.cacheCreationInputTokens;
		total.cacheCreation5mTokens =
			(total.cacheCreation5mTokens ?? 0) + (bucket.cacheCreation5mTokens ?? 0);
		total.cacheCreation1hTokens =
			(total.cacheCreation1hTokens ?? 0) + (bucket.cacheCreation1hTokens ?? 0);
		total.outputTokens += bucket.outputTokens;
		const sources = sourceCounts(bucket);
		const totalSources = sourceCounts(total);
		totalSources.measured += sources.measured;
		totalSources.estimated += sources.estimated;
		totalSources.unknown += sources.unknown;
		total.sources = totalSources;
	}
	return total;
}

/**
 * 子会话 id → 归集桶的归类结果。
 *
 * 只读、纯函数，因此"复核者算进总量但不单独占一档"这条口径可以被直接断言，
 * 不需要连数据库。
 */
export interface ChildBucketTarget {
	narratorId: string;
	/** 编排执行者的档位；复核者与无关子代理为 `null`，只计入总量。 */
	tier: OrchestrationTier | null;
}

/**
 * 把 `subagent_type` 归类到桶。
 *
 * 复核者（`orch-review--…`）**刻意不给档位**：它不占四档里的任何一档（那四档是执行者的
 * 编制），但它的开销仍是编排的开销，所以进总量、不进分档。把它塞进 `reviewTier` 那一档
 * 会让人以为"这一档跑了这么多 token"，而那一档的模型池是执行者池，两者不是一回事。
 */
export function classifyChild(subagentType: string | null): OrchestrationTier | null {
	if (typeof subagentType !== "string") return null;
	if (!subagentType.startsWith(ORCHESTRATION_TYPE_PREFIX)) return null;
	const parsed = parseOrchestrationType(subagentType);
	return parsed.ok ? parsed.tier : null;
}

/** 该子代理类型是否属于本次编排会话的开销（执行者或复核者）。 */
function isOrchestrationChild(subagentType: string | null): boolean {
	if (typeof subagentType !== "string") return false;
	return (
		subagentType.startsWith(ORCHESTRATION_TYPE_PREFIX) ||
		subagentType.startsWith(REVIEW_TYPE_PREFIX)
	);
}

/**
 * 从「子会话归类 + 每会话的原始聚合行」组装出线上形状。纯函数（无 I/O），便于逐条断言。
 *
 * `rows` 里可能出现枚举之外的 narrator id（理论上不会，但读取与枚举之间隔着一次 await），
 * 因此这里以 `targets` 为准来找桶，多出来的行忽略——把不认识的行硬塞进某个桶才是错的。
 *
 * **没有档位的编排子会话（复核者）单独攒一份 `reviewers`**：它们属于编排开销，但不属于
 * 四档中的任何一档。把它们直接丢掉会让总量偏小（复核的钱是真花了的），把它们硬塞进
 * 某一档又会让那一档的数字名不副实。单列一份还顺带让"编制者 + 四档 + 复核 = 总量"
 * 这个等式成立——否则用户在面板上把数字加一遍就会发现对不上。
 */
export function buildOrchestrationUsage(input: {
	orchestratorBucket: OrchestrationUsageBucket;
	orchestratorRows?: readonly (OrchestrationUsageBucket & {
		narratorId: string | null;
		runId?: string | null;
		role?: string | null;
	})[];
	targets: readonly ChildBucketTarget[];
	rows: readonly (OrchestrationUsageBucket & {
		narratorId: string | null;
		runId?: string | null;
		role?: string | null;
	})[];
	truncated: boolean;
}): OrchestrationUsage {
	const tiers = emptyTierBuckets();
	const reviewers = emptyBucket();
	const runDetails = new Map<string, OrchestrationUsageRunDetail>();
	const createRoleBuckets = () => ({
		orchestrator: emptyBucket(),
		worker: emptyBucket(),
		reviewer: emptyBucket(),
		unknown: emptyBucket(),
	});
	// 先把 id → 目标档位记下来，再按行归集；同一个 worker 在多次派发里都是同一档，
	// 但一只 worker 只会在 targets 里出现一次（枚举是按 narrators 主键去的重）。
	const tierByNarrator = new Map<string, OrchestrationTier | null>();
	for (const target of input.targets) tierByNarrator.set(target.narratorId, target.tier);
	const addRunDetail = (
		row: OrchestrationUsageBucket & {
			narratorId?: string | null;
			runId?: string | null;
			role?: string | null;
		},
	): void => {
		const runId = row.runId ?? null;
		const key = runId ?? "__legacy__";
		let detail = runDetails.get(key);
		if (!detail) {
			detail = { runId, roles: createRoleBuckets(), total: emptyBucket() };
			runDetails.set(key, detail);
		}
		const role =
			row.role === "orchestrator" || row.role === "worker" || row.role === "reviewer"
				? row.role
				: "unknown";
		addBucketInto(detail.roles[role], row);
		addBucketInto(detail.total, row);
	};
	if (input.orchestratorRows?.length) {
		for (const row of input.orchestratorRows) addRunDetail(row);
	} else {
		addRunDetail({ ...input.orchestratorBucket, narratorId: null, role: "orchestrator" });
	}
	for (const row of input.rows) {
		addRunDetail(row);
		if (!row.narratorId) continue;
		if (!tierByNarrator.has(row.narratorId)) continue;
		const tier = tierByNarrator.get(row.narratorId);
		// 档位为 null 的编排子会话是复核者：进 reviewers，不进任何一档。
		addBucketInto(tier ? tiers[tier] : reviewers, row);
	}
	const total = sumUsageBuckets([input.orchestratorBucket, reviewers, ...Object.values(tiers)]);
	return {
		orchestrator: input.orchestratorBucket,
		reviewers,
		tiers,
		total,
		childCount: input.targets.length,
		truncated: input.truncated,
		runDetails: [...runDetails.values()],
	};
}

/** 把一行的五个计数累加进目标桶（就地修改，调用方持有该桶）。 */
function addBucketInto(target: OrchestrationUsageBucket, row: OrchestrationUsageBucket): void {
	target.requests += row.requests;
	target.inputTokens += row.inputTokens;
	target.cachedInputTokens += row.cachedInputTokens;
	target.cacheCreationInputTokens += row.cacheCreationInputTokens;
	target.cacheCreation5mTokens =
		(target.cacheCreation5mTokens ?? 0) + (row.cacheCreation5mTokens ?? 0);
	target.cacheCreation1hTokens =
		(target.cacheCreation1hTokens ?? 0) + (row.cacheCreation1hTokens ?? 0);
	target.outputTokens += row.outputTokens;
	const sources = sourceCounts(row);
	const targetSources = sourceCounts(target);
	targetSources.measured += sources.measured;
	targetSources.estimated += sources.estimated;
	targetSources.unknown += sources.unknown;
	target.sources = targetSources;
}

/** 把 SQL 聚合回来的行（数字可能是字符串）读成桶。 */
export function normalizeOrchestrationInputTokens(
	inputTokens: number,
	cachedInputTokens: number,
	semantics: string | null | undefined,
): number {
	if (semantics === "total_input" || semantics === "prompt_total") {
		return Math.max(inputTokens - cachedInputTokens, 0);
	}
	return inputTokens;
}

function rowToBucket(row: {
	requests: number | string | null;
	inputTokens: number | string | null;
	cachedInputTokens: number | string | null;
	cacheCreationInputTokens: number | string | null;
	cacheCreation5mTokens?: number | string | null;
	cacheCreation1hTokens?: number | string | null;
	outputTokens: number | string | null;
	provider?: string | null;
	usageSource?: string | null;
	inputTokenSemantics?: string | null;
}): OrchestrationUsageBucket {
	const num = (value: number | string | null | undefined): number => {
		const parsed = Number(value ?? 0);
		return Number.isFinite(parsed) ? parsed : 0;
	};
	const rawInputTokens = num(row.inputTokens);
	const cachedInputTokens = num(row.cachedInputTokens);
	const inferredSemantics = row.provider?.trim()
		? usageInputSemantics(row.provider) === "cache-inclusive"
			? "total_input"
			: usageInputSemantics(row.provider) === "cache-exclusive"
				? "non_cached_input"
				: "unknown"
		: "unknown";
	const inputTokens = normalizeOrchestrationInputTokens(
		rawInputTokens,
		cachedInputTokens,
		row.inputTokenSemantics === "unknown" || row.inputTokenSemantics == null
			? inferredSemantics
			: row.inputTokenSemantics,
	);
	const source =
		row.usageSource === "provider"
			? "measured"
			: row.usageSource === "estimated"
				? "estimated"
				: "unknown";
	return {
		requests: num(row.requests),
		inputTokens,
		cachedInputTokens,
		cacheCreationInputTokens: num(row.cacheCreationInputTokens),
		cacheCreation5mTokens: num(row.cacheCreation5mTokens),
		cacheCreation1hTokens: num(row.cacheCreation1hTokens),
		outputTokens: num(row.outputTokens),
		sources: {
			measured: source === "measured" ? num(row.requests) : 0,
			estimated: source === "estimated" ? num(row.requests) : 0,
			unknown: source === "unknown" ? num(row.requests) : 0,
		},
	};
}

/** 分组聚合时要选的列：**只有 token 与 id**，绝不把同行的 `raw_dump_json` 带出来。 */
const usageColumns = {
	narratorId: apiRequests.narratorId,
	runId: apiRequests.orchestrationRunId,
	role: apiRequests.role,
	provider: apiRequests.provider,
	usageSource: apiRequests.usageSource,
	inputTokenSemantics: apiRequests.inputTokenSemantics,
	requests: count(),
	inputTokens: sql<number>`coalesce(sum(${apiRequests.inputTokens}), 0)`,
	cachedInputTokens: sql<number>`coalesce(sum(${apiRequests.cachedInputTokens}), 0)`,
	cacheCreationInputTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreationInputTokens}), 0)`,
	cacheCreation5mTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreation5mTokens}), 0)`,
	cacheCreation1hTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreation1hTokens}), 0)`,
	outputTokens: sql<number>`coalesce(sum(${apiRequests.outputTokens}), 0)`,
};

/**
 * 读取一个编排会话的开销；会话不在编排模式时返回 `null`。
 *
 * 与 `status.ts` 同源：**是否处于编排模式只由 `model` 的哨兵判定**，否则两条路径
 * 迟早会对"这个会话算不算编排"给出不同答案。
 *
 * 查询固定为两次（子会话枚举 + 一次分组聚合），都走索引、都有界、都只取小列。
 * 任何失败都**返回 null** 而不是抛：开销是观测数据，读不到时面板应当显示"读不到"，
 * 而不是把一个正常会话判成出错。
 */
export async function readOrchestrationUsage(
	narratorId: string,
): Promise<OrchestrationUsage | null> {
	const { parseOrchestrationModelValue } = await import("@server/lib/settings");
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		// 只取哨兵所在的那一列：`narrators` 还有 system_prompt 这类大字段。
		columns: { model: true },
	});
	if (!row || !parseOrchestrationModelValue(row.model)) return null;

	try {
		const children = await db
			.select({ id: narrators.id, subagentType: narrators.subagentType })
			.from(narrators)
			.where(eq(narrators.parentNarratorId, narratorId))
			.limit(MAX_CHILD_SCAN + 1);
		// 多取一行只为判断"还有更多"，多出来的那一行不计入统计（否则 `truncated` 就与
		// 实际统计范围不一致）。
		const truncated = children.length > MAX_CHILD_SCAN;
		const targets: ChildBucketTarget[] = [];
		for (const child of children.slice(0, MAX_CHILD_SCAN)) {
			if (!isOrchestrationChild(child.subagentType)) continue;
			targets.push({ narratorId: child.id, tier: classifyChild(child.subagentType) });
		}

		// 编制者自己 + 全部编排子会话，一次分组聚合。编制者本人在总里也要算，
		// 否则"这次编排花了多少"会漏掉调度本身的开销。
		const idList = [narratorId, ...targets.map((target) => target.narratorId)];
		const rows = await db
			.select(usageColumns)
			.from(apiRequests)
			.where(inArray(apiRequests.narratorId, idList))
			.groupBy(
				apiRequests.narratorId,
				apiRequests.orchestrationRunId,
				apiRequests.role,
				apiRequests.provider,
				apiRequests.usageSource,
				apiRequests.inputTokenSemantics,
			);

		const orchestratorBucket = emptyBucket();
		const orchestratorRows: (OrchestrationUsageBucket & {
			narratorId: string | null;
			runId: string | null;
			role: string | null;
		})[] = [];
		const childRows: (OrchestrationUsageBucket & {
			narratorId: string | null;
			runId: string | null;
			role: string | null;
		})[] = [];
		for (const row of rows) {
			const bucket = rowToBucket(row);
			const bucketWithIdentity = {
				...bucket,
				narratorId: row.narratorId,
				runId: row.runId,
				role: row.role ?? "orchestrator",
			};
			if (row.narratorId === narratorId) {
				addBucketInto(orchestratorBucket, bucket);
				orchestratorRows.push(bucketWithIdentity);
				continue;
			}
			childRows.push(bucketWithIdentity);
		}

		return buildOrchestrationUsage({
			orchestratorBucket,
			orchestratorRows,
			targets,
			rows: childRows,
			truncated,
		});
	} catch (err) {
		logger.warn("Failed to read orchestration token usage", {
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** 路由响应的形状：非编排会话显式给 `usage: null`（而不是 404）。 */
export function orchestrationUsageResponse(
	usage: OrchestrationUsage | null,
): OrchestrationUsageResponse {
	return { usage };
}
