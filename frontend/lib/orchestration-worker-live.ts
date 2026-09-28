/**
 * 编排面板的**事件驱动** worker 视图（纯逻辑，可脱离 DOM 与网络断言）。
 *
 * ## 为什么不是再加一个轮询
 *
 * `subagent_status_changed` 与 `context_usage` 两个帧本来就已经在这条连接上流过去
 * （见 `useNarratorWS` 的分发），只是编排面板此前没有消费它们。把面板从"按秒轮询"
 * 改成"消费已有事件"既省主线程（CLAUDE.md 明确把"提高轮询频率"列为错误解法），
 * 也让状态真正跟着变化走。
 *
 * ## 覆盖层（overlay）而不是直接改服务端清单
 *
 * 服务端清单是**周期性的快照**（谁在这个编排名下、档位、模型），事件是**增量的修正**
 * （某只 worker 现在什么状态、上下文多满）。两者形状不同、到达节奏也不同，硬塞进
 * 同一份状态会互相覆盖。因此事件写进一个独立的覆盖层，渲染时叠加在快照上：
 * - 收到未知 worker 的事件**不会凭空造行**（它可能属于别的编排会话，或清单还没刷新到），
 *   覆盖层把它记下来，但没有对应快照行的键永远不会被渲染；
 * - 快照刷新后旧事件自然被更新的快照取代，不需要任何清理逻辑；
 * - 覆盖层有界（见 {@link MAX_ORCHESTRATION_WORKER_OVERLAY_ENTRIES}），长会话不会无限增长。
 */

import type { OrchestrationWorkerStatus } from "@shared/orchestration-status";

/**
 * 一条 worker 级的实时更新；同一只 worker 的多次事件会合并到一条上。
 *
 * 字段**互不覆盖**：状态与上下文来自两个不同的帧（`subagent_status_changed` 与
 * `context_usage`），因此两边都是可选的，缺席表示"这一帧没说这件事"，而不是"清空"。
 */
export interface OrchestrationWorkerLiveUpdate {
	workerId: string;
	/** 编排运行 id；旧 WS 事件没有该字段。 */
	runId?: string;
	/** 新观测事件的单调序号；旧 WS 事件没有该字段。 */
	sequence?: number;
	/** worker 或 reviewer。 */
	workerRole?: "worker" | "reviewer";
	/** 实时事件报告的档位。 */
	tier?: OrchestrationWorkerStatus["tier"];
	/** 当前阶段。 */
	phase?: string;
	/** 当前事件来源。 */
	source?: string;
	/** 当前工具名或阶段细节。 */
	toolName?: string;
	/** `narrators.status` 的原样值（`working` / `idle` / `waiting` / `archived`）。 */
	status?: string;
	/** 上下文占用百分比（0–100）。 */
	contextPercent?: number;
	/** 上下文来源。 */
	contextSource?: "measured" | "provider" | "estimated" | "unknown";
	/** 收到这条事件的本机时间（epoch ms）。 */
	receivedAtMs: number;
}

/** workerId → 该 worker 最近一次事件带来的值。 */
export type OrchestrationWorkerLiveOverlay = ReadonlyMap<string, OrchestrationWorkerLiveUpdate>;

/** 空覆盖层；模块级单例让"没有事件"这条路径不产生新的引用身份。 */
export const EMPTY_ORCHESTRATION_WORKER_OVERLAY: OrchestrationWorkerLiveOverlay = new Map();

/**
 * 覆盖层的条目上限。
 *
 * 覆盖层只会为"这个编排会话收到过事件的 worker"建键，正常规模是几十；上限存在的
 * 意义是长会话（面板开着一整天）不会把 map 撑到无界。到顶后淘汰**最早收到事件**的
 * 那一条：它离最新一次轮询最远，丢掉的后果只是那一只 worker 退回快照的旧值。
 */
export const MAX_ORCHESTRATION_WORKER_OVERLAY_ENTRIES = 200;

/** 事件保鲜窗口：这么久没收到任何事件就认为事件通道没在起作用。 */
export const ORCHESTRATION_LIVE_EVENT_FRESH_MS = 60_000;

/** 事件通道有效时的兜底轮询间隔（低频：事件才是主要来源）。 */
export const ORCHESTRATION_FALLBACK_REFETCH_MS = 60_000;

/**
 * 完全没有事件时的轮询间隔。
 *
 * 与改动前保持一致，作为"事件通道没生效"时的兜底：这时面板只剩轮询这一条路，
 * 把它也调慢会让面板看起来像坏的。
 */
export const ORCHESTRATION_BASELINE_REFETCH_MS = 10_000;

/** 判断值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function normalizeContextSource(value: unknown): "measured" | "estimated" | "unknown" {
	if (value === "provider" || value === "measured") return "measured";
	if (value === "estimated") return "estimated";
	return "unknown";
}

/**
 * 从一帧 WS 数据读出 worker 级更新；不认识或读不出来时返回 `null`。
 *
 * 容错是这一层的**主要职责**（它是唯一会碰到不受信帧的地方）：
 * - `narratorId` 必须等于本面板的父叙述者：订阅过滤器已经筛过一遍，但过滤器是
 *   客户端侧的约定，不能当作数据完整性保证；
 * - `context_usage` 必须带 `subagentNarratorId`。父级收到的副本里 `narratorId`
 *   是父级自己，没有这个字段就无从知道占用率属于哪只 worker——**宁可丢掉它**，
 *   也不能把它算到父级头上（那会让面板显示一个看起来合理的错数字）；
 * - 非有限数、非数组的 substatus 一律丢弃对应字段，而不是写进覆盖层。
 */
export function readOrchestrationWorkerUpdate(
	frame: Record<string, unknown>,
	parentNarratorId: string,
	receivedAtMs: number,
): OrchestrationWorkerLiveUpdate | null {
	if (frame.narratorId !== parentNarratorId) return null;

	if (frame.type === "orchestration_observation") {
		const observation = frame.observation;
		if (!observation || typeof observation !== "object" || Array.isArray(observation)) return null;
		const raw = observation as Record<string, unknown>;
		const runId = isNonEmptyString(raw.runId) ? raw.runId : null;
		const workerId = isNonEmptyString(raw.workerNarratorId) ? raw.workerNarratorId : null;
		const sequence = raw.sequence;
		if (!runId || !workerId || typeof sequence !== "number" || !Number.isSafeInteger(sequence)) {
			return null;
		}
		const details =
			raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)
				? (raw.details as Record<string, unknown>)
				: undefined;
		const percentage = details?.contextPercent ?? details?.percentage;
		const contextPercent =
			typeof percentage === "number" && Number.isFinite(percentage) ? percentage : undefined;
		const toolName = isNonEmptyString(details?.toolName)
			? details.toolName
			: isNonEmptyString(details?.tool)
				? details.tool
				: undefined;
		const contextSource = normalizeContextSource(details?.contextSource ?? details?.source);
		return {
			workerId,
			runId,
			sequence,
			workerRole: raw.workerRole === "reviewer" ? "reviewer" : "worker",
			tier:
				typeof raw.tier === "string" ? (raw.tier as OrchestrationWorkerStatus["tier"]) : undefined,
			phase: isNonEmptyString(raw.phase) ? raw.phase : undefined,
			source: isNonEmptyString(raw.source) ? raw.source : undefined,
			contextSource,
			...(toolName ? { toolName } : {}),
			...(contextPercent !== undefined ? { contextPercent } : {}),
			receivedAtMs,
		};
	}

	const workerId = frame.subagentNarratorId;
	if (!isNonEmptyString(workerId)) return null;

	if (frame.type === "subagent_status_changed") {
		if (!isNonEmptyString(frame.status)) return null;
		return { workerId, status: frame.status, receivedAtMs };
	}

	if (frame.type === "context_usage") {
		// 只有 `isSubagent` 的那些帧属于某只 worker；普通会话自己的占用率走另一条路径。
		if (frame.isSubagent !== true) return null;
		const percentage = frame.percentage;
		if (typeof percentage !== "number" || !Number.isFinite(percentage)) return null;
		return { workerId, contextPercent: percentage, receivedAtMs };
	}

	return null;
}

/**
 * 把一条更新并入覆盖层（不可变，幂等）。
 *
 * 合并而不是替换：状态与上下文来自**两个不同的帧**，后到的那个不该把先到的抹掉。
 * 同一个 worker 重复收到同一条事件（重放、重连后的补发）得到的结果与收到一次相同。
 */
export function applyOrchestrationWorkerUpdate(
	overlay: OrchestrationWorkerLiveOverlay,
	update: OrchestrationWorkerLiveUpdate,
): OrchestrationWorkerLiveOverlay {
	const previous = overlay.get(update.workerId);
	// 新观测按 runId + workerId + sequence 去重；旧事件没有序号，继续按到达顺序兼容。
	if (
		previous &&
		update.runId &&
		previous.runId === update.runId &&
		update.sequence !== undefined &&
		previous.sequence !== undefined &&
		update.sequence <= previous.sequence
	) {
		return overlay;
	}
	// 逐字段回落到上一次的值：后到的那一帧只说自己知道的事，不该把另一帧带来的
	// 字段抹掉（否则收到上下文会把刚拿到的状态清空，反之亦然）。
	const merged: OrchestrationWorkerLiveUpdate = {
		...previous,
		...update,
		workerId: update.workerId,
		receivedAtMs: update.receivedAtMs,
	};
	const next = new Map(overlay);
	next.delete(update.workerId);
	if (previous === undefined && next.size >= MAX_ORCHESTRATION_WORKER_OVERLAY_ENTRIES) {
		// 到顶：淘汰最早收到事件的那一条（Map 的插入顺序即我们维护的 LRU 顺序）。
		const oldest = next.keys().next().value;
		if (oldest !== undefined) next.delete(oldest);
	}
	next.set(update.workerId, merged);
	return next;
}

/** 面板渲染用的一行：服务端快照 + 事件覆盖。 */
export interface OrchestrationWorkerView extends OrchestrationWorkerStatus {
	/** 实时事件对应的运行 id。 */
	liveRunId?: string | null;
	/** 实时事件的 worker 角色。 */
	liveRole?: "worker" | "reviewer" | null;
	/** 实时事件的阶段。 */
	livePhase?: string | null;
	/** 实时事件携带的工具名。 */
	liveToolName?: string | null;
	/** 上下文来源。 */
	liveContextSource?: "measured" | "provider" | "estimated" | "unknown" | null;
	/** 这一行里是否有字段来自事件（而不是上次轮询的快照）。 */
	live: boolean;
	/** 最近一次事件的本机时间；没有事件时为 `null`。 */
	liveAtMs: number | null;
}

/**
 * 把事件覆盖层叠加到服务端清单上。
 *
 * 只覆盖**快照里已经有的** worker：覆盖层里有、快照里没有的键被忽略（"不凭空造行"）。
 * 那些键会在下一次快照刷新时要么被认领（它确实是本次编排的 worker），要么自然过期。
 */
export function mergeOrchestrationWorkers(input: {
	workers: readonly OrchestrationWorkerStatus[];
	overlay: OrchestrationWorkerLiveOverlay;
}): OrchestrationWorkerView[] {
	return input.workers.map((worker) => {
		const live = input.overlay.get(worker.narratorId);
		if (!live) {
			return {
				...worker,
				liveRunId: null,
				liveRole: null,
				livePhase: null,
				liveToolName: null,
				liveContextSource: null,
				live: false,
				liveAtMs: null,
			};
		}
		return {
			...worker,
			...(live.status !== undefined ? { status: live.status } : {}),
			...(live.contextPercent !== undefined ? { contextPercent: live.contextPercent } : {}),
			liveRunId: live.runId ?? null,
			liveRole: live.workerRole ?? null,
			livePhase: live.phase ?? null,
			liveToolName: live.toolName ?? null,
			liveContextSource: live.contextSource ?? null,
			live: true,
			liveAtMs: live.receivedAtMs,
		};
	});
}

/**
 * 这一行的「最近活动」时间（epoch ms）；两边都没有记录时为 `null`。
 *
 * 取事件时间与快照时间中**更新**的那个：事件刚刚到过而快照还是几分钟前的时候，
 * 显示快照时间会让人以为这只 worker 一直没动。`null` 表示"确实没有任何记录"，
 * 界面据此显示「—」而不是把它算成"很久以前"。
 */
export function orchestrationWorkerActivityMs(
	worker: Pick<OrchestrationWorkerView, "lastActivityAt" | "liveAtMs">,
): number | null {
	const parsed = worker.lastActivityAt ? Date.parse(worker.lastActivityAt) : Number.NaN;
	const snapshotMs = Number.isFinite(parsed) ? parsed : null;
	if (snapshotMs === null) return worker.liveAtMs;
	if (worker.liveAtMs === null) return snapshotMs;
	return Math.max(snapshotMs, worker.liveAtMs);
}

/**
 * 面板下一次轮询的间隔。
 *
 * 事件新鲜（窗口内收到过）→ 低频兜底；事件长时间未达 → 退回原来的基线间隔。
 * 这条规则把"实时"交给事件、把轮询降级为兜底，而不是靠更快地轮询装成实时。
 */
export function orchestrationRefetchIntervalMs(input: {
	lastEventAtMs: number | null;
	now: number;
}): number {
	if (input.lastEventAtMs === null) return ORCHESTRATION_BASELINE_REFETCH_MS;
	return input.now - input.lastEventAtMs <= ORCHESTRATION_LIVE_EVENT_FRESH_MS
		? ORCHESTRATION_FALLBACK_REFETCH_MS
		: ORCHESTRATION_BASELINE_REFETCH_MS;
}
