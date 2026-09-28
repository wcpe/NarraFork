/**
 * 编排模式的设置校验（阶段 1a）。
 *
 * 供 settings PATCH 使用：严格模式只认已知字段，坏数据在写入前就被拒绝，
 * 而不是留到运行时才发现方案不可用。
 */

import {
	MAX_ORCHESTRATOR_MODEL_ENTRIES,
	MAX_ORCHESTRATOR_MODEL_REFERENCE_LENGTH,
} from "@shared/orchestration-orchestrator-model";
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@shared/reasoning-effort";
import { z } from "zod";
import type { OrchestrationSettings } from "../orchestration/types";

/**
 * 思考强度枚举。
 *
 * 取值直接用 `shared/reasoning-effort.ts` 那张表，不在这里另抄一份字面量：
 * 抄一份的后果是某天新增等级时校验器静默拒收一个运行时其实认识的值。
 * 断言成非空元组是为了让 `z.enum` 推断出精确的字面量联合（否则它只能推出
 * `string`，而 `z.ZodType<OrchestrationSettings>` 的对应关系就检查不出来了）。
 */
const REASONING_EFFORT_TUPLE = REASONING_EFFORT_VALUES as unknown as [
	ReasoningEffort,
	...ReasoningEffort[],
];
const reasoningEffortSchema = z.enum(REASONING_EFFORT_TUPLE);

/** 单个档位模型池条目。 */
const poolEntrySchema = z
	.strictObject({
		// 与子代理模型引用保持同一上限（200），避免两处约束不一致
		model: z.string().min(1).max(200),
		priority: z.number().int().min(1).max(100).optional(),
		maxConcurrent: z.number().int().min(0).max(64).optional(),
		reasoningEffort: reasoningEffortSchema.optional(),
	})
	.strict();

/**
 * 编制者候选模型的一条。
 *
 * 联合的两个分支是**向后兼容的全部内容**：历史配置（以及既有测试）写的是纯字符串
 * 数组，因此字符串分支必须一直存在，且它的解析结果**不带** `reasoningEffort` 键
 * ——"没配强度"与"配成某一档"在写入侧就必须可区分。
 */
const orchestratorModelEntrySchema = z.union([
	z.string().min(1).max(MAX_ORCHESTRATOR_MODEL_REFERENCE_LENGTH),
	z
		.strictObject({
			model: z.string().min(1).max(MAX_ORCHESTRATOR_MODEL_REFERENCE_LENGTH),
			reasoningEffort: reasoningEffortSchema.optional(),
		})
		.strict(),
]);

/** 单个档位的配置，最多 50 个候选模型。 */
const tierConfigSchema = z
	.strictObject({
		pool: z.array(poolEntrySchema).max(50),
	})
	.strict();

/** 四个档位必须齐全：缺档意味着某个档位永远选不出模型，属于配置错误。 */
const tiersSchema = z
	.strictObject({
		chore: tierConfigSchema,
		quick: tierConfigSchema,
		medium: tierConfigSchema,
		heavy: tierConfigSchema,
	})
	.strict();

const reviewSchema = z
	.strictObject({
		selfReview: z.boolean(),
		independentReview: z.boolean(),
		reviewTier: z.enum(["chore", "quick", "medium", "heavy"]),
		maxReworkAttempts: z.number().int().min(0).max(5),
	})
	.strict();

const profileSchema = z
	.strictObject({
		// 与 parseOrchestrationType 的字符集一致，长度收窄到 4..32 以防手填过短/过长
		id: z.string().regex(/^[a-z0-9]{4,32}$/, "方案 ID 只能是小写字母与数字，长度 4-32"),
		name: z
			.string()
			.min(1)
			.max(64)
			// 只由空白组成的名字在界面上不可辨认，等同无名
			.refine((value) => value.trim().length > 0, "方案名称不能只有空白"),
		description: z.string().max(256).optional(),
		enabled: z.boolean(),
		review: reviewSchema,
		tiers: tiersSchema,
	})
	.strict();

export const orchestrationSettingsSchema: z.ZodType<OrchestrationSettings> = z
	.strictObject({
		orchestratorModels: z.array(orchestratorModelEntrySchema).max(MAX_ORCHESTRATOR_MODEL_ENTRIES),
		profiles: z.array(profileSchema).max(20),
	})
	.strict();
