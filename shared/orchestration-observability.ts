/**
 * 编排运行级观测字段的共享契约。
 *
 * 这些值会落在数据库的窄字段中，不能把请求正文、提示词或完整上下文写入观测行。
 * 历史行上的 NULL、旧版本字符串和未知的新值统一归一为 `unknown`，这样升级前的
 * 数据仍然可以安全显示，而不会被猜成某个已知阶段。
 */

export type OrchestrationRequestRole = "orchestrator" | "worker" | "reviewer" | "unknown";
export type OrchestrationUsageSource = "provider" | "estimated" | "unknown";
export type OrchestrationContextSource = "provider" | "estimated" | "unknown";
export type OrchestrationInputTokenSemantics =
	| "non_cached_input"
	| "total_input"
	| "prompt_total"
	| "unknown";
export type OrchestrationRunCurrentPhase =
	| "dispatching"
	| "executing"
	| "self_reviewing"
	| "reviewing"
	| "completed"
	| "failed"
	| "unknown";

export const ORCHESTRATION_REQUEST_ROLES = [
	"orchestrator",
	"worker",
	"reviewer",
	"unknown",
] as const satisfies readonly OrchestrationRequestRole[];

export const ORCHESTRATION_USAGE_SOURCES = [
	"provider",
	"estimated",
	"unknown",
] as const satisfies readonly OrchestrationUsageSource[];
export const ORCHESTRATION_CONTEXT_SOURCES = [
	"provider",
	"estimated",
	"unknown",
] as const satisfies readonly OrchestrationContextSource[];
export const ORCHESTRATION_INPUT_TOKEN_SEMANTICS = [
	"non_cached_input",
	"total_input",
	"prompt_total",
	"unknown",
] as const satisfies readonly OrchestrationInputTokenSemantics[];
export const ORCHESTRATION_RUN_CURRENT_PHASES = [
	"dispatching",
	"executing",
	"self_reviewing",
	"reviewing",
	"completed",
	"failed",
	"unknown",
] as const satisfies readonly OrchestrationRunCurrentPhase[];

/** 观测数值的统一上限，防止异常上游值污染统计。 */
export const MAX_ORCHESTRATION_OBSERVATION_TOKENS = 2_000_000_000;
export const MAX_ORCHESTRATION_PROGRESS_SEQ = 2_000_000_000;

function normalizeEnum<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

/** 把请求角色读成共享契约值；缺失或未来值都保守归为 unknown。 */
export function normalizeOrchestrationRequestRole(value: unknown): OrchestrationRequestRole {
	return normalizeEnum(value, ORCHESTRATION_REQUEST_ROLES, "unknown");
}

/** 把 usage 来源读成共享契约值；旧行没有来源时返回 unknown。 */
export function normalizeOrchestrationUsageSource(value: unknown): OrchestrationUsageSource {
	return normalizeEnum(value, ORCHESTRATION_USAGE_SOURCES, "unknown");
}

/** 把上下文来源读成共享契约值；旧行没有来源时返回 unknown。 */
export function normalizeOrchestrationContextSource(value: unknown): OrchestrationContextSource {
	return normalizeEnum(value, ORCHESTRATION_CONTEXT_SOURCES, "unknown");
}

/** 把输入 token 的口径读成共享契约值；不能根据数值猜测口径。 */
export function normalizeOrchestrationInputTokenSemantics(
	value: unknown,
): OrchestrationInputTokenSemantics {
	return normalizeEnum(value, ORCHESTRATION_INPUT_TOKEN_SEMANTICS, "unknown");
}

/** 把运行当前阶段读成共享契约值；历史行缺失该列时返回 unknown。 */
export function normalizeOrchestrationRunCurrentPhase(
	value: unknown,
): OrchestrationRunCurrentPhase {
	return normalizeEnum(value, ORCHESTRATION_RUN_CURRENT_PHASES, "unknown");
}

/** 读取有界的非负整数；NULL、负数、小数和超界值都视为未知。 */
export function normalizeOrchestrationObservationInteger(
	value: unknown,
	max: number,
): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
		? value
		: null;
}

export interface OrchestrationRequestObservation {
	orchestrationRunId: string | null;
	role: OrchestrationRequestRole;
	usageSource: OrchestrationUsageSource;
	contextSource: OrchestrationContextSource;
	inputTokenSemantics: OrchestrationInputTokenSemantics;
	promptTokens: number | null;
	contextWindow: number | null;
}

export interface OrchestrationRunProgressSnapshot {
	currentPhase: OrchestrationRunCurrentPhase;
	lastProgressSeq: number | null;
	lastProgressAt: string | null;
}
