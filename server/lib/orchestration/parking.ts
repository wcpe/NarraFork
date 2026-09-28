/**
 * 编排 worker 的停放池（阶段 4b）。
 *
 * 「停放」= 把一个已完成、空闲的编排子代理**归档**（`narrators.status = "archived"`）。
 * 归档的语义是「不参与广播、不接受直接 Send」，消息历史一条都不删
 * （`narrator_messages` / `narrator_message_refs` / `narrator_tool_calls` 全留）。
 * 因此**复用 = 把一个归档的 worker 解除归档后继续用**：同一段前缀历史仍在，
 * 模型的提示词前缀缓存也还是热的。
 *
 * 本模块只解决「哪些 worker 空闲可借」这一件事：
 * - `selectReusableWorker` 是纯匹配（无 I/O、无副作用，便于测试）；
 * - 登记簿是**纯内存**的按键分组 Map。进程重启后丢失是可接受的——下一次派发会从
 *   `narrators` 表惰性重建（`ensureRegistryHydrated`）。它**不是持久存储**，
 *   事实来源永远是 `narrators.status`，登记簿只是它的一个加速视图；
 * - `parkWorker` 只负责「归档 + 登记」，永不抛异常。
 */

import { db } from "@server/db";
import { narrators } from "@server/db/schema";
import { logger } from "@server/lib/logger";
import { hasWakeableInboxWork } from "@server/services/agent-runtime/inbox";
import { isNarratorRuntimeBusy } from "@server/services/narrator-session-state";
import { and, desc, eq, like } from "drizzle-orm";
import { ORCHESTRATION_TYPE_PREFIX, type OrchestrationTier, parseOrchestrationType } from "./types";

/** 一个停放中的 worker 的索引项。 */
export interface ParkedWorker {
	narratorId: string;
	parentNarratorId: string;
	/** 编制者（primary）。 */
	profileId: string;
	tier: OrchestrationTier;
	model: string;
	lastUsedAt: number;
}

/**
 * 惰性重建时最多认领多少行。
 *
 * 这不是"能停多少"的上限，而是**读取预算**：SQLite 没有 `status` / `subagent_type`
 * 上的索引，超出的部分不扩大读取，只记一条日志——少认领一个 worker 的后果只是
 * 下一次派发多建一个子代理，没有正确性损失。
 */
const HYDRATION_LIMIT = 500;

/** 单个编制者的池子上限；超出按 least-recently-used 淘汰，避免长会话无限增长。 */
const MAX_PARKED_PER_PARENT = 256;

/** 归档行里的类型前缀，与 `parseOrchestrationType` 同源。 */
const ORCHESTRATED_TYPE_LIKE = `${ORCHESTRATION_TYPE_PREFIX}%`;

/** parentNarratorId → 该编制者名下停放中的 worker。 */
const parkedByParent = new Map<string, ParkedWorker[]>();

/** 模块级 promise：并发调用只会触发一次重建（见 `ensureRegistryHydrated`）。 */
let hydration: Promise<void> | undefined;

/**
 * 从候选里挑一个可复用的 worker。
 *
 * 匹配规则刻意"宁新建不误用"：
 * - `parentNarratorId` 必须相等——跨编排会话复用会把别人的上下文带进来，ACL root 也会混；
 * - `profileId` 必须相等——换方案意味着换了模型池与提示词，复用旧 worker 会让
 *   "这个方案用什么模型"失真；
 * - `tier` 必须相等——工具等级由档位决定，跨档位复用会让只读 worker 提权，
 *   破坏"它只读过代码"这一前提。
 *
 * **在这些硬条件之上，`model` 是一条偏好而不是过滤**：复用唯一真正省下的东西是提示词
 * 前缀缓存，而前缀缓存是**按模型分开**的——把一个用 A 模型跑热的 worker 唤醒到 B 模型上，
 * 它那段历史必须被完整重读一遍，前缀比新建一只还要长。因此同模型的候选优先。
 * 但池子里只有别的模型时仍然复用（退回原来的"最近使用优先"），因为这时候 worker
 * 记得自己做过什么，那仍有价值；只是不再享有缓存红利而已。
 *
 * 其余情况取 `lastUsedAt` 最大者（前缀缓存最热）；并列时取 `narratorId` 字典序
 * 最小者（确定性，便于测试）。不修改传入数组，也不修改其中的项。
 */
export function selectReusableWorker(
	candidates: readonly ParkedWorker[],
	request: {
		parentNarratorId: string;
		profileId: string;
		tier: OrchestrationTier;
		/** 本次派发为该档位选中的模型；省略则不做模型偏好（保持原来的规则）。 */
		model?: string;
	},
): ParkedWorker | undefined {
	let best: ParkedWorker | undefined;
	for (const candidate of candidates) {
		if (candidate.parentNarratorId !== request.parentNarratorId) continue;
		if (candidate.profileId !== request.profileId) continue;
		if (candidate.tier !== request.tier) continue;
		if (!best) {
			best = candidate;
			continue;
		}
		if (betterReusableCandidate(candidate, best, request.model)) best = candidate;
	}
	return best;
}

/**
 * `candidate` 是否比当前最优更该被选中。
 *
 * 分两层，且顺序不能颠倒：先比模型是否与本次派发一致（缓存红利），一致与不一致打平时
 * 才比最近使用时间。反过来写的话，一只刚用别的模型跑完的 worker 会一直压住同模型的那只，
 * 而它恰好是唯一不能带来缓存命中的候选。
 */
function betterReusableCandidate(
	candidate: ParkedWorker,
	best: ParkedWorker,
	model: string | undefined,
): boolean {
	if (model) {
		const candidateMatches = candidate.model === model;
		const bestMatches = best.model === model;
		if (candidateMatches !== bestMatches) return candidateMatches;
	}
	if (candidate.lastUsedAt !== best.lastUsedAt) return candidate.lastUsedAt > best.lastUsedAt;
	return candidate.narratorId < best.narratorId;
}

/** 停放登记簿的只读快照（见 `parkedWorkerSnapshot`）。 */
export interface ParkedWorkerSnapshot {
	/** 快照覆盖到的停放 worker 总数。 */
	total: number;
	/** 按档位分组的计数；四档恒在（没有的档位是 0，不是缺键）。 */
	byTier: Record<OrchestrationTier, number>;
}

/** 四档全 0 的计数字典；缺档会让调用方拿到 undefined 而不是 0。 */
function emptyTierCounts(): Record<OrchestrationTier, number> {
	return { chore: 0, quick: 0, medium: 0, heavy: 0 };
}

/**
 * 当前登记的停放 worker 快照（按档位分组计数）。只读，不影响登记簿状态。
 *
 * 存在的理由：登记簿此前只有 `claimReusableWorker` 这一个破坏性出口，于是"池子里
 * 到底停着什么、容量配得合不合理"完全没有观测手段——调池参数就只能盲调。
 *
 * 三条刻意的性质：
 * - **只读**：只累加计数，既不摘除也不改写任何项，也不触发惰性重建（重建是
 *   `claimReusableWorker` / 调用方的职责，见 `ensureRegistryHydrated`）。因此
 *   调用它不会让某次派发错失一个 worker。
 * - **同步**：整个函数没有任何 await，读的就是内存登记簿的当前状态。
 * - **不传参数即全局**：`parentNarratorId` 省略时统计所有编制者；传入时只统计
 *   该编制者名下的池子。worker 只会登记在唯一一个 parent 键下，两种口径都不会
 *   重复计数。
 */
export function parkedWorkerSnapshot(parentNarratorId?: string): ParkedWorkerSnapshot {
	const byTier = emptyTierCounts();
	let total = 0;
	// 不传 parent 时看全部桶，传了就看一个桶（不存在即空）。
	const buckets =
		parentNarratorId === undefined
			? [...parkedByParent.values()]
			: [parkedByParent.get(parentNarratorId) ?? []];
	for (const bucket of buckets) {
		for (const worker of bucket) {
			byTier[worker.tier] += 1;
			total += 1;
		}
	}
	return { total, byTier };
}

/** 把一个 worker 登记为停放可用（同一个 narratorId 以最后一次登记为准）。 */
export function registerParkedWorker(worker: ParkedWorker): void {
	const existing = parkedByParent.get(worker.parentNarratorId) ?? [];
	const next = [
		...existing.filter((candidate) => candidate.narratorId !== worker.narratorId),
		worker,
	];
	parkedByParent.set(
		worker.parentNarratorId,
		next.length > MAX_PARKED_PER_PARENT ? trimToCap(next) : next,
	);
}

/** 按最近使用时间保留前 N 个；并列时 narratorId 小者优先（与匹配规则同序）。 */
function trimToCap(workers: readonly ParkedWorker[]): ParkedWorker[] {
	return [...workers]
		.sort((a, b) => b.lastUsedAt - a.lastUsedAt || (a.narratorId < b.narratorId ? -1 : 1))
		.slice(0, MAX_PARKED_PER_PARENT);
}

/**
 * 认领前的复核：登记簿是**内存加速视图**，事实来源永远是 `narrators.status`。
 *
 * 登记簿只在两个时刻写入（停放成功、以及本进程这一次惰性重建），中间任何变化都会
 * 让里面留下陈旧项：worker 被别人续跑了起来（状态回到 idle/working），或者已经有人
 * 拿着它的执行租约。把一个正在跑的 worker 交出去不是"复用失败"这么轻——调用方会
 * 先把它写成 idle、再 `resumeSubagent`，后者撞上"仍在运行"而失败，而那次写库已经
 * 把它从归档态捅了出来（这正是"复用失败留下 idle 孤儿"的来源之一）。
 *
 * 只认**确定的否定证据**：读不到行（例如纯登记簿项，或行刚被删）或读取失败都**不算**
 * 不可复用——那只会把本来能用的 worker 误判掉；反过来只要读到行且状态不是 archived，
 * 或运行时说它正忙，就一定不复用。这与 `recover.ts` 里可用性探针的方向一致：
 * 缺失即视为可用。
 */
async function isStillParkedAndIdle(narratorId: string): Promise<boolean> {
	if (isNarratorRuntimeBusy(narratorId)) return false;
	try {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { status: true },
		});
		if (row && row.status !== "archived") return false;
		return true;
	} catch (err) {
		logger.warn("Failed to re-check a parked orchestration worker before handing it out", {
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return true;
	}
}

/** 从登记簿摘掉一个 worker（不存在时是空操作）。 */
function unregisterParkedWorker(parentNarratorId: string, narratorId: string): void {
	const candidates = parkedByParent.get(parentNarratorId);
	if (!candidates) return;
	const rest = candidates.filter((candidate) => candidate.narratorId !== narratorId);
	if (rest.length > 0) parkedByParent.set(parentNarratorId, rest);
	else parkedByParent.delete(parentNarratorId);
}

/**
 * 取走一个可复用 worker（匹配成功即从登记簿移除，避免两个派发抢同一个）。
 *
 * 返回的是副本而非登记簿里的对象：认领者拿到之后可以随便改。
 *
 * 两处顺序都是刻意的：
 *  - 选中与摘除之间**没有 await**，所以两个并发派发不可能拿到同一个 worker；
 *  - 复核放在摘除之后，所以复核窗口里也不会有第二个派发抢到同一个人。被复核否掉的
 *    项直接从登记簿里丢掉（它已经不是归档态了），并继续看下一个候选——池子因此自愈，
 *    而不是被一个陈旧项堵住整个档位。每轮循环都同步摘掉一项，候选有限，必然终止。
 *  - 每次认领最多为被考察的候选各读一行；派发热路径上每个派发只走一次这个入口。
 */
export async function claimReusableWorker(request: {
	parentNarratorId: string;
	profileId: string;
	tier: OrchestrationTier;
	/**
	 * 本次派发已为该档位选中的模型。
	 *
	 * 传进来只会让"同模型的候选优先"（见 `selectReusableWorker`），
	 * **不会过滤掉别的模型的候选**：池子里只剩别的模型时照样复用，
	 * 只是那次没有前缀缓存红利。
	 */
	model?: string;
}): Promise<ParkedWorker | undefined> {
	await ensureRegistryHydrated();
	for (;;) {
		const candidates = parkedByParent.get(request.parentNarratorId);
		if (!candidates || candidates.length === 0) return undefined;
		const picked = selectReusableWorker(candidates, request);
		if (!picked) return undefined;
		unregisterParkedWorker(request.parentNarratorId, picked.narratorId);
		if (await isStillParkedAndIdle(picked.narratorId)) return { ...picked };
		logger.warn("Dropped a parked orchestration worker that is no longer parked", {
			narratorId: picked.narratorId,
			parentNarratorId: request.parentNarratorId,
		});
	}
}

/**
 * 惰性从数据库重建登记簿（首次访问时执行一次）。
 *
 * 只做一次，用模块级 promise 去重：并发派发不会各自扫一遍库。
 */
export async function ensureRegistryHydrated(): Promise<void> {
	hydration ??= hydrateRegistry();
	await hydration;
}

async function hydrateRegistry(): Promise<void> {
	try {
		// 只取需要的列：`narrators` 还有 system_prompt 这类大字段，重建不该顺带把它们读进来。
		const rows = await db
			.select({
				id: narrators.id,
				parentNarratorId: narrators.parentNarratorId,
				subagentType: narrators.subagentType,
				model: narrators.model,
				updatedAt: narrators.updatedAt,
			})
			.from(narrators)
			.where(
				and(eq(narrators.status, "archived"), like(narrators.subagentType, ORCHESTRATED_TYPE_LIKE)),
			)
			.orderBy(desc(narrators.updatedAt))
			.limit(HYDRATION_LIMIT);
		if (rows.length >= HYDRATION_LIMIT) {
			logger.warn("Parked-worker registry hydration hit its read limit", {
				limit: HYDRATION_LIMIT,
			});
		}
		for (const row of rows) {
			// 解析不了的行直接跳过：可能是历史数据或手改过的 subagentType。
			const parsed = parseOrchestrationType(row.subagentType);
			if (!parsed.ok) continue;
			// 没有编制者就没有池子可归。
			if (!row.parentNarratorId) continue;
			registerParkedWorker({
				narratorId: row.id,
				parentNarratorId: row.parentNarratorId,
				profileId: parsed.profileId,
				tier: parsed.tier,
				model: row.model ?? "",
				lastUsedAt: parseTimestampMs(row.updatedAt),
			});
		}
	} catch (err) {
		// 重建失败不该让任何派发失败：空池的后果只是"下次新建一个 worker"。
		logger.warn("Failed to hydrate the parked-worker registry", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** `updated_at` 是 ISO 文本；解析不出来按 0 处理，排序退化为确定但无意义的值。 */
function parseTimestampMs(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 把一个已完成的编排 worker 停放（= 归档）。失败不应影响任务结果。
 *
 * 用既有的 `interruptAndArchiveSubagent`：它负责停止运行中的活、关闭内存会话、
 * 置 `status = "archived"`，并借 `parentNarratorId` 做归属校验（非直属子代会被拒）。
 * 传 `parentNarratorId` 是为了让那次校验有意义。
 */
export async function parkWorker(worker: {
	narratorId: string;
	parentNarratorId: string;
	profileId: string;
	tier: OrchestrationTier;
	model: string;
}): Promise<boolean> {
	try {
		// 运行中的 worker 一律不归档：归档会先中断并关闭它，那正是"打断别人正在等的活"。
		if (isNarratorRuntimeBusy(worker.narratorId)) {
			logger.warn("Refused to park an orchestration worker that is still busy", {
				narratorId: worker.narratorId,
			});
			return false;
		}
		const { interruptAndArchiveSubagent } = await import("@server/services/subagent-lifecycle");
		const archived = await interruptAndArchiveSubagent(worker.narratorId, {
			parentNarratorId: worker.parentNarratorId,
		});
		if (!archived.ok) {
			logger.warn("Failed to park an orchestration worker", {
				narratorId: worker.narratorId,
				error: archived.error,
			});
			return false;
		}
		registerParkedWorker({ ...worker, lastUsedAt: Date.now() });
		return true;
	} catch (err) {
		// 停放是优化，不是任务的一部分：因为停放失败而让一次成功的派发变成失败
		// 是不可接受的，所以这里只记日志、绝不向上抛。
		logger.warn("Failed to park an orchestration worker", {
			narratorId: worker.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/**
 * 复用失败后把 worker 归还池子（= 重新归档 + 重新登记）。
 *
 * `claimReusableWorker` 已经把它从登记簿摘掉了，而为了续跑又必须先把它写回 idle；
 * 于是唤醒一旦没成，它就处于一个**没有任何路径会修复**的位置：
 * - 唯一会重新登记的是"某个 run 归还租约"，而它再也不会跑；
 * - 登记簿重建是每进程一次，且只认 `status = archived`——它现在是 idle。
 * 结果就是池子静默缩水，还留下一个既参与 TeamStatus 广播、又能被 Send 驱动的
 * `idle` 孤儿（与"已归档 = 不接受 Send"的语义直接矛盾）。
 *
 * 归还走的就是停放本身（`parkWorker` 会重置归档并登记），所以"停放过的东西"与
 * "复用过又失败的东西"回到池子里是同一种对象。模型也一并写回停放时的那一个：
 * 这次派发若压根没跑起来，它写进去的新模型属于**从未使用过的值**，留着会让
 * "这个 worker 用什么模型"失真（也让它下次被复用时按错模型记账）。
 *
 * 归还本身也可能失败（例如它其实已经被跑起来了，归档会撞上"仍在运行"）：那时只记
 * 一条 warn 说明它已掉出池子，绝不把失败上抛——复用是优化，不是任务的一部分。
 */
export async function restoreParkedWorker(worker: ParkedWorker): Promise<boolean> {
	try {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, worker.narratorId),
			columns: { model: true },
		});
		// 只在确实被改过时才回写：失败可能发生在写模型之前，那一次多余的写没必要。
		if (row && row.model !== worker.model) {
			const { narratorService } = await import("@server/services/narrator-service");
			await narratorService.updateModel(worker.narratorId, worker.model);
		}
	} catch (err) {
		logger.warn("Failed to roll the reused worker's model back", {
			narratorId: worker.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	const restored = await parkWorker({ ...worker });
	if (!restored) {
		logger.warn("Reused orchestration worker fell out of the parking pool", {
			narratorId: worker.narratorId,
			parentNarratorId: worker.parentNarratorId,
			profileId: worker.profileId,
			tier: worker.tier,
		});
	}
	return restored;
}

/**
 * 子代理跑到终态时调用的停放入口：自己判断"能不能停"，能停就停。
 *
 * 判定条件（缺一不可）：
 * - `subagentType` 能被 `parseOrchestrationType` 解析（它是编排 worker）；
 * - 不在后台模式——后台任务投影此刻还没落定，归档会走 `cancelBackgroundTask`，
 *   把一个刚跑完的后台任务标成"已取消"，而且它的结果还没被父级消费；
 * - 没有在跑（含等权限、等到期反射）且状态不是 working/waiting；
 * - **没有唤醒会消费的 mailbox 消息**——归档会让这些消息再也送不进来，而发送方
 *   被告知的是"已排队"。这里刻意调用唤醒侧的 `hasWakeableInboxWork`，而不是自己
 *   拼一条查询：两处各写一套 kind 清单的后果是"唤醒算得上、停放没算上"的消息
 *   被永久搁浅（本模块早期只查 `user_input`，于是 Send 进来的 `agent_message`
 *   正好落在两侧判断的缝隙里）；
 * - 数据库里的父级与调用方给的父级一致——登记簿按父级分池，记错会让另一个
 *   编排会话借到这棵树里的 worker。
 *
 * 永不抛异常：任何一步出错都只是"这次没停成"。
 */
export async function parkCompletedOrchestrationWorker(input: {
	narratorId: string;
	parentNarratorId: string;
}): Promise<boolean> {
	try {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, input.narratorId),
			columns: {
				id: true,
				parentNarratorId: true,
				subagentType: true,
				model: true,
				status: true,
				isBackground: true,
			},
		});
		if (!narrator) return false;
		if (narrator.parentNarratorId !== input.parentNarratorId) return false;
		if (!narrator.parentNarratorId) return false;

		const parsed = parseOrchestrationType(narrator.subagentType);
		if (!parsed.ok) return false;

		// 后台任务的投影在 `finalizeSubagent` 之后才落定，此刻归档等于把它的结果标成取消。
		if (narrator.isBackground) return false;

		if (isNarratorRuntimeBusy(narrator.id)) return false;
		if (narrator.status === "working" || narrator.status === "waiting") return false;

		// 与唤醒（`wakeInboxIfEligible`）同源：归档之后唤醒会直接返回 false、Send 也会被
		// 拒，所以"唤醒会消费而这里没算上"的每一种 kind，都会变成一条永远没人读的消息。
		if (await hasWakeableInboxWork(narrator.id)) return false;

		return await parkWorker({
			narratorId: narrator.id,
			parentNarratorId: narrator.parentNarratorId,
			profileId: parsed.profileId,
			tier: parsed.tier,
			model: narrator.model ?? "",
		});
	} catch (err) {
		logger.warn("Failed to evaluate whether an orchestration worker can be parked", {
			narratorId: input.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/** 仅供测试：清空登记簿与"已重建过"的标记，让下一次访问重新走一遍重建。 */
export function __resetParkingRegistryForTests(): void {
	parkedByParent.clear();
	hydration = undefined;
}
