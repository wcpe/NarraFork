import { isReasoningEffort, type ReasoningEffort } from "./reasoning-effort";

export const SUBAGENT_POOL_TYPES = ["explore", "plan", "search", "review", "general"] as const;
export type SubagentPoolType = (typeof SUBAGENT_POOL_TYPES)[number];

export interface SubagentModelUse {
	model: string;
	purpose?: string;
	/** A fixed configuration tier for newly created subagents; absent means inherit. */
	reasoningEffort?: ReasoningEffort;
}

export type SubagentModelPools = Record<string, SubagentModelUse[]>;
export type SubagentAllowedModels = Pick<
	Record<SubagentPoolType, string[]>,
	"explore" | "plan" | "general"
> &
	Partial<Pick<Record<SubagentPoolType, string[]>, "search" | "review">>;
export type SubagentModelReasoningEfforts = Partial<
	Record<SubagentPoolType, Record<string, ReasoningEffort>>
>;

export const MAX_SUBAGENT_MODEL_REFERENCE_LENGTH = 200;
export const MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL = 50;

/**
 * Tolerant reads must not turn corrupt optional metadata into a model restriction.
 *
 * 直接委托给共享守卫（`shared/reasoning-effort.ts` 的 `isReasoningEffort`）：这张
 * 合法值表同时服务子代理类型池、编排池条目与编排编制者，写两份必然某天漂移。
 * 保留这个名字是因为它是这套机制既有的对外词汇（前端选择器与设置页都在用它）。
 */
export function isSubagentReasoningEffort(value: unknown): value is ReasoningEffort {
	return isReasoningEffort(value);
}
