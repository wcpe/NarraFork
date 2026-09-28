/**
 * 编排实时观测的共享契约。
 *
 * 这是独立于历史状态/usage 契约的瞬时事件形状：它只描述当前运行链路，
 * 不改变既有编排状态接口，也不要求数据库新增字段。
 */

import type { OrchestrationWorkerTier } from "./orchestration-worker-type";

export type OrchestrationLiveWorkerRole = "worker" | "reviewer";

export type OrchestrationLivePhase =
	| "dispatch"
	| "worker_start"
	| "api_request"
	| "context"
	| "tool"
	| "review"
	| "terminal";

export type OrchestrationLiveSource =
	| "dispatch"
	| "runner"
	| "event_handler"
	| "review"
	| "runtime";

export interface OrchestrationLiveIdentity {
	runId: string;
	coordinatorNarratorId: string;
	workerNarratorId?: string;
	workerRole: OrchestrationLiveWorkerRole;
	tier: OrchestrationWorkerTier;
	parentToolUseId?: string;
}

export type OrchestrationLiveScalar = string | number | boolean | null;

export interface OrchestrationLiveObservation {
	runId: string;
	/** 父级帧填写；子代理自帧刻意省略，避免泄露父级链接。 */
	coordinatorNarratorId?: string;
	workerNarratorId: string;
	workerRole: OrchestrationLiveWorkerRole;
	tier: OrchestrationWorkerTier;
	phase: OrchestrationLivePhase;
	sequence: number;
	source: OrchestrationLiveSource;
	occurredAt: string;
	/** 仅允许标量，避免实时观测携带大文本或逐 chunk 内容。 */
	details?: Record<string, OrchestrationLiveScalar>;
}
