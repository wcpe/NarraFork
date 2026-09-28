/**
 * 编排编制者模型清单的形状与容错读取（前后端共用）。
 *
 * ## 为什么是「字符串或对象」的联合，而不是一个平行的映射
 *
 * 编制者模型清单是**有序候选**（取第一个可用者），而思考强度属于**某个具体模型**。
 * 若把强度放进一个按模型引用为键的平行映射（`agent.subagentModelReasoningEfforts`
 * 就是那种形状），就产生了一条两处必须同时维护的隐式耦合：用户重排或改名清单里的
 * 条目后，强度条目会静默变成孤儿——配置还在文件里，却再也没有任何东西会读它。
 * 联合形状让「模型 + 强度」作为一个整体随条目移动，这类失配在类型上就不存在。
 *
 * ## 向后兼容
 *
 * 历史配置（以及所有既有测试用例）写的是纯字符串数组 `["provA:model"]`。
 * 联合里的 `string` 分支就是为它保留的：解析器 {@link normalizeOrchestratorModelEntry}
 * 把字符串读成 `{ model }`（**不带** `reasoningEffort` 键），因此
 * 「没配置强度」与「配成某个等级」在内存里依然可区分——前者根本没有这个键。
 * 用户升级后无需改动任何已有设置，写入时也不会被校验拒绝。
 *
 * 本模块是纯函数、无 IO，前后端都从这里取同一条规则（设置页要能把它读回来，
 * 服务端要在选模与展示时读同一份）。
 */

import { isReasoningEffort, type ReasoningEffort } from "./reasoning-effort";

/** 编制者模型条目的对象形态。 */
export interface OrchestratorModelConfig {
	/** 完整模型引用，形如 "provider:modelId"。 */
	model: string;
	/**
	 * 该模型作为编制者运行时的思考强度。
	 *
	 * **省略 = 跟随该模型/provider 的既有默认**，刻意不在这里补一个默认值：
	 * 补了之后「用户没配」与「用户配成中等」就是同一份数据，界面再也说不清
	 * 这个值是谁定的。
	 */
	reasoningEffort?: ReasoningEffort;
}

/**
 * 配置里允许出现的两种写法。
 *
 * `string` 是历史写法（也是本特性引入前的唯一写法），`OrchestratorModelConfig`
 * 是带强度时的写法；两者可以混在同一个数组里。
 */
export type OrchestratorModelEntry = string | OrchestratorModelConfig;

/** 与子代理模型引用保持同一上限（200），避免两处约束不一致。 */
export const MAX_ORCHESTRATOR_MODEL_REFERENCE_LENGTH = 200;

/** 编制者候选模型数量上限（与服务端校验、设置页 maxValues 一致）。 */
export const MAX_ORCHESTRATOR_MODEL_ENTRIES = 20;

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把一条配置读成对象形态；读不出来返回 `null`（调用方跳过它）。
 *
 * 容错口径与 `shared/subagent-model-policy.ts` 的同名处理一致：
 * - 空白模型引用**丢弃整条**（一个空前缀的模型引用不可能被解析成任何东西）；
 * - `reasoningEffort` **非法就当作没写**，而不是丢弃整条条目——用户手改
 *   settings.json 打错一个字母，不该导致整个编制者模型清单消失；
 * - 字符串分支不带 `reasoningEffort` 键（"没配"与"配了"必须可区分）。
 */
export function normalizeOrchestratorModelEntry(raw: unknown): OrchestratorModelConfig | null {
	if (typeof raw === "string") {
		const model = raw.trim();
		return model.length > 0 ? { model } : null;
	}
	if (!isPlainObject(raw)) return null;
	const model = typeof raw.model === "string" ? raw.model.trim() : "";
	if (model.length === 0) return null;
	return isReasoningEffort(raw.reasoningEffort)
		? { model, reasoningEffort: raw.reasoningEffort }
		: { model };
}

/**
 * 读出一份去重后的编制者模型清单。
 *
 * 去重与 `pool.ts` 的 `dedupeByModel` 同一条规则（保留首次出现的条目）：
 * 同一个模型在清单里写两遍时，只有第一个会被真正使用，列两行会让人以为
 * 后面那个的强度也生效了。
 */
export function listOrchestratorModels(raw: unknown): OrchestratorModelConfig[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const result: OrchestratorModelConfig[] = [];
	for (const candidate of raw as unknown[]) {
		const entry = normalizeOrchestratorModelEntry(candidate);
		if (!entry || seen.has(entry.model)) continue;
		seen.add(entry.model);
		result.push(entry);
	}
	return result;
}

/**
 * 取真正会被用来装配编制者会话的那一条。
 *
 * 「取第一个」这条规则同时是会话装配（`server/lib/settings/provider.ts` 的
 * `resolveOrchestratorModel`）与展示侧的权威口径；两处各写一份的话，
 * 界面上显示的编制者模型会与实际发给上游的那个分叉。
 */
export function firstUsableOrchestratorModel(raw: unknown): OrchestratorModelConfig | null {
	return listOrchestratorModels(raw)[0] ?? null;
}

/** 仅供只看模型引用（不关心强度）的消费方使用。 */
export function listOrchestratorModelRefs(raw: unknown): string[] {
	return listOrchestratorModels(raw).map((entry) => entry.model);
}
