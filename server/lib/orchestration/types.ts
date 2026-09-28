/**
 * 编排模式的核心类型与纯逻辑（阶段 1a）。
 *
 * 本文件刻意不依赖 `@server/lib/settings`：settings 的类型会反向引入本模块的类型，
 * 若在这里回头 import settings 就会形成循环依赖。因此这里只放数据结构与字符串编解码。
 */

import type { OrchestratorModelEntry } from "@shared/orchestration-orchestrator-model";
import type { ReasoningEffort } from "@shared/reasoning-effort";

/** 干活档位。四档，按能力与成本递增。 */
export type OrchestrationTier = "chore" | "quick" | "medium" | "heavy";

/** 工具等级。chore/quick 为只读，medium/heavy 可写。 */
export type OrchestrationToolTier = "readOnly" | "general";

/** 四个档位的固定顺序，供遍历与校验共用。 */
export const ORCHESTRATION_TIERS: readonly OrchestrationTier[] = [
	"chore",
	"quick",
	"medium",
	"heavy",
];

/** 档位到工具等级的映射：低两档只读，高两档可写。 */
export const TIER_TOOL_TIER: Record<OrchestrationTier, OrchestrationToolTier> = {
	chore: "readOnly",
	quick: "readOnly",
	medium: "general",
	heavy: "general",
};

/** 档位类型编码前缀，形如 orch--<profileId>--<tier> */
export const ORCHESTRATION_TYPE_PREFIX = "orch--";

/**
 * 只读复核者的类型前缀（阶段 5），形如 `orch-review--<profileId>--<tier>`。
 *
 * 刻意**不**以 `orch--` 开头，因此 `parseOrchestrationType` 在第一层就拒绝它，
 * `parking` 的归档查询（`subagent_type like 'orch--%'`）也永远查不到它。
 * 复核者绝不能被当成执行者复用——它只读过代码，没有实现上下文，
 * 复用它会得到"接了活却什么都不知道"的 worker，且最难排查（它看起来像个正常子代理）。
 *
 * 两道闸门是刻意重复的：这里是编码层，`parking` 的 `like` 是查询层。
 * 任何一侧被后人"顺手放宽"（例如让解析器接受第三段），另一侧仍然拦得住。
 */
export const REVIEWER_TYPE_PREFIX = "orch-review--";

/** profileId 的合法字符集：仅小写字母与数字（生成侧用 nanoid）。 */
const PROFILE_ID_PATTERN = /^[a-z0-9]+$/;

/** 编码分隔符（两个连字符），profileId 不含 `-`，因此不会与 profileId 混淆。 */
const TYPE_SEPARATOR = "--";

export interface OrchestrationPoolEntry {
	/** 完整模型引用，形如 "provider:modelId"。 */
	model: string;
	/** 请求优先级，数字越小越优先。省略视同 1。 */
	priority?: number;
	/** 并发上限。省略或 0 视同不限。 */
	maxConcurrent?: number;
	/**
	 * 该池条目被选中时的思考强度。
	 *
	 * **省略 = 跟随该模型/provider 的既有默认**，刻意不在任何地方补默认值：
	 * 补了之后"用户没配"与"用户配成中等"就是同一份数据，界面与审计都再也
	 * 说不清这个值是谁定的。语义与 `SubagentModelUse.reasoningEffort`
	 * （`shared/subagent-model-policy.ts`）一致——那里也是"池条目携带一个固定等级，
	 * 缺席即继承"。
	 */
	reasoningEffort?: ReasoningEffort;
}

export interface OrchestrationTierConfig {
	/** 模型池。数组顺序即默认优先级顺序。空数组表示该档位不可用。 */
	pool: OrchestrationPoolEntry[];
}

export interface OrchestrationReviewConfig {
	/** 执行者干完后是否续跑一轮自审。默认 true。 */
	selfReview: boolean;
	/** 是否额外派独立只读复核者。默认 true。 */
	independentReview: boolean;
	/** 复核者使用的档位。默认 "quick"。 */
	reviewTier: OrchestrationTier;
	/** 自审或复核未通过时的最大重派次数。默认 2。 */
	maxReworkAttempts: number;
}

export interface OrchestrationProfile {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	review: OrchestrationReviewConfig;
	tiers: Record<OrchestrationTier, OrchestrationTierConfig>;
}

export interface OrchestrationSettings {
	/**
	 * 编制者候选模型（有序，取第一个可用者）。空数组表示功能关闭。
	 *
	 * 条目可以是历史写法（纯字符串）或带思考强度的对象；两种写法可以混用，
	 * 读取一律走 `shared/orchestration-orchestrator-model.ts` 的容错解析
	 * （见该文件对"为什么不做成平行映射"的说明）。
	 */
	orchestratorModels: OrchestratorModelEntry[];
	profiles: OrchestrationProfile[];
}

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断 tiers 是否四档齐全——缺档的坏数据不能作为方案候选。 */
function hasCompleteTiers(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	return ORCHESTRATION_TIERS.every((tier) => isPlainObject(value[tier]));
}

/**
 * 从原始设置里的 profiles 数组筛出可用方案（跳过未启用与坏数据）。
 *
 * 刻意留在本模块而不是 runtime：settings 侧的模型解析也需要这份过滤规则，
 * 而 runtime 反过来 import settings —— 让 provider 依赖 runtime 会形成
 * settings → provider → runtime → settings 的环。本模块不依赖 settings，
 * 因此两边共用同一份实现，不会各自漂移出一套「什么算可用方案」。
 */
export function listEnabledProfilesFrom(raw: unknown): OrchestrationProfile[] {
	if (!Array.isArray(raw)) return [];
	const result: OrchestrationProfile[] = [];
	for (const candidate of raw as unknown[]) {
		if (!isPlainObject(candidate)) continue;
		if (candidate.enabled === false) continue;
		if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
		if (!hasCompleteTiers(candidate.tiers)) continue;
		result.push(candidate as unknown as OrchestrationProfile);
	}
	return result;
}

/** 从原始设置里按 id 取启用方案；不存在或未启用返回 undefined。 */
export function findEnabledProfileFrom(
	raw: unknown,
	profileId: string | null | undefined,
): OrchestrationProfile | undefined {
	if (!profileId) return undefined;
	return listEnabledProfilesFrom(raw).find((profile) => profile.id === profileId);
}

/**
 * 取方案的复核配置，缺失或非法字段回落到文档化的默认值。
 *
 * 存在的理由是**手工改过的 settings.json**：写入口（`validators/orchestration.ts`）
 * 强制要求完整的 review 块，但文件是用户可以手编的，`profiles` 的默认值又只是空数组——
 * 也就是说文件里出现的方案一定不是默认值填充出来的。少了这一层，一个忘了写 review 的
 * 方案会静默地"不做任何复核"，而那看起来和"复核通过了"没有区别。
 *
 * 默认值取自 {@link OrchestrationReviewConfig} 的文档：自审开、独立复核开、
 * 复核档位 quick、最大重派 2 次。
 */
export function resolveOrchestrationReviewConfig(raw: unknown): OrchestrationReviewConfig {
	const source = isPlainObject(raw) ? raw : {};
	const tierValue = typeof source.reviewTier === "string" ? source.reviewTier : "";
	const reviewTier = isOrchestrationTier(tierValue) ? tierValue : "quick";
	const maxReworkAttempts =
		typeof source.maxReworkAttempts === "number" && Number.isFinite(source.maxReworkAttempts)
			? Math.max(0, Math.trunc(source.maxReworkAttempts))
			: 2;
	return {
		selfReview: source.selfReview !== false,
		independentReview: source.independentReview !== false,
		reviewTier,
		maxReworkAttempts,
	};
}

/** 档位类型编码的解析结果。 */
export type OrchestrationTypeParseResult =
	| { ok: true; profileId: string; tier: OrchestrationTier }
	| { ok: false };

/** 判断字符串是否为合法档位。 */
function isOrchestrationTier(value: string): value is OrchestrationTier {
	return (ORCHESTRATION_TIERS as readonly string[]).includes(value);
}

/** 把 profileId 与档位编码成子代理类型字符串。 */
export function buildOrchestrationType(profileId: string, tier: OrchestrationTier): string {
	return `${ORCHESTRATION_TYPE_PREFIX}${profileId}${TYPE_SEPARATOR}${tier}`;
}

/**
 * 把复核者编码成子代理类型字符串（`orch-review--<profileId>--<tier>`）。
 *
 * 前缀的选取理由见 {@link REVIEWER_TYPE_PREFIX}：它不是合法的编排 worker 类型，
 * 因此既不会被 `parseOrchestrationType` 认成执行者，也不会被停放池的查询捞到。
 */
export function buildReviewerSubagentType(profileId: string, tier: OrchestrationTier): string {
	return `${REVIEWER_TYPE_PREFIX}${profileId}${TYPE_SEPARATOR}${tier}`;
}

/**
 * 解析 `<前缀><profileId>--<tier>` 形式的类型编码。
 *
 * 编码与解码写在同一处是刻意的：前缀一旦分家，就会出现"写得进、认不出"这一类
 * 只在生产数据里才看得见的漂移。
 */
function parseTypedTier(
	prefix: string,
	subagentType: string | null | undefined,
): OrchestrationTypeParseResult {
	if (typeof subagentType !== "string") return { ok: false };
	if (!subagentType.startsWith(prefix)) return { ok: false };
	const rest = subagentType.slice(prefix.length);
	const parts = rest.split(TYPE_SEPARATOR);
	// 必须恰好两段：<prefix><profileId>--<tier>
	if (parts.length !== 2) return { ok: false };
	const [profileId, tier] = parts;
	if (!profileId || !tier) return { ok: false };
	if (!PROFILE_ID_PATTERN.test(profileId)) return { ok: false };
	if (!isOrchestrationTier(tier)) return { ok: false };
	return { ok: true, profileId, tier };
}

/**
 * 解析档位类型编码。
 *
 * 任何不合法输入（非字符串、缺前缀、缺分隔符、profileId 含非法字符、档位未知）
 * 都返回 `{ ok: false }`，绝不抛异常——调用方拿到的可能是任意历史数据。
 * 复核者类型（`orch-review--…`）在这里必然是 `false`，理由见 {@link REVIEWER_TYPE_PREFIX}。
 */
export function parseOrchestrationType(
	subagentType: string | null | undefined,
): OrchestrationTypeParseResult {
	return parseTypedTier(ORCHESTRATION_TYPE_PREFIX, subagentType);
}

/**
 * 解析只读复核者的类型编码。
 *
 * 与 {@link parseOrchestrationType} 是**两个**入口而不是一个宽容的入口：调用方要能
 * 明确说出"我要的是执行者还是复核者"，而一个能同时接受两者的解析器会让"复核者被
 * 当成执行者复用"这种事重新变得可能——那正是前缀分家的原因。
 */
export function parseReviewerType(
	subagentType: string | null | undefined,
): OrchestrationTypeParseResult {
	return parseTypedTier(REVIEWER_TYPE_PREFIX, subagentType);
}
