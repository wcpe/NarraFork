export { FOLLOW_PARENT_MODEL } from "../../shared/model-inheritance";

export {
	CHAPTER_ROLE_ICONS,
	CHAPTER_STATUS_COLORS,
	CONTAINER_STATUS_COLORS,
	EDGE_TYPE_COLORS,
	NARRATOR_STATUS_COLORS,
	statusRegistry,
	TOOL_CALL_STATUS_COLORS,
} from "./status-registry";

export type ModelPricingInfo = {
	billingMode?: string;
	unitName?: string;
	tokenUnit?: number;
	input?: number | string;
	output?: number | string;
	cacheCreationInput?: number | string;
	cacheReadInput?: number | string;
	credit?: number | string;
};

export type ModelOption = {
	value: string;
	label: string;
	provider?: string;
	channel?: string;
	channelType?: string;
	bareModel?: string;
	rateMultiplier?: number;
	/** NUG models: the thinking tiers the gateway reports this model accepts.
	 * Tri-state — a non-empty list is authoritative, `[]` asserts the model has
	 * no thinking tiers, and an absent field means the gateway did not report
	 * them (fall back to inferring from the model id). Never collapse `[]` into
	 * undefined; the two carry opposite meanings. */
	effortLevels?: string[];
	/** NUG model pricing info (only present for NUG models that have configured
	 * prices). Used for the model-info price popup. */
	pricing?: ModelPricingInfo;
	officialInputUsd?: number;
	officialOutputUsd?: number;
	officialCacheCreationInputUsd?: number;
	officialCacheReadInputUsd?: number;
	channelMultiplier?: number;
	contextWindow?: number;
	usdRate?: number;
	/** NUG models: false when the model's upstream is temporarily unavailable
	 * (its whole credential pool is disabled). The option is shown but marked
	 * "temporarily unavailable" so the user knows selecting it will wait for
	 * recovery. Absent/true means available. */
	available?: boolean;
	/**
	 * True when this option is only present because a default/summary (or
	 * provider-default) selection still points at it, while the provider
	 * catalog no longer lists it (delisted after a model-list refresh).
	 * The UI must prompt the user to reassign those roles rather than treat
	 * this as an ordinary catalog row (and must not offer "set as default/
	 * summary" as the fix — that would keep the dead pin).
	 */
	catalogMissing?: boolean;
	/**
	 * Global roles that keep a `catalogMissing` option in the list.
	 * Empty/absent means it is not currently pinned as default or summary.
	 */
	pinnedAs?: Array<"default" | "summary">;
	/**
	 * 编排方案的载荷（`provider === ORCHESTRATION_PROVIDER_KEY` 时才有）。
	 *
	 * 模型菜单按 `provider` 分组后只拿到 ModelOption，没有别的通道能把方案的
	 * 编制者模型与四档池摘要送到菜单行上，因此载荷挂在选项本身。
	 */
	orchestration?: OrchestrationMenuProfile;
};

/** Sentinel value stored in DB to mean "follow the default model from settings". */
export const FOLLOW_DEFAULT_MODEL = "__default__";

/** Sentinel value stored in DB to mean "follow the summary model from settings". */
export const FOLLOW_SUMMARY_MODEL = "__summary__";

/** Human-readable label for a NUG model's channelType (request protocol). */
export function nugChannelTypeLabel(channelType?: string): string {
	switch (channelType) {
		case "codex":
			return "codex 兼容";
		case "responses":
			return "responses 兼容";
		case "openai":
			return "openai 兼容";
		case "anthropic":
			return "anthropic";
		default:
			return channelType ?? "";
	}
}

/** Prefix for model aggregation values. */
export const AGG_MODEL_PREFIX = "__agg__:";

export interface ModelAggregation {
	id: string;
	name: string;
	models: string[];
	routingMode: "priority" | "balanced";
}

/**
 * Parse an aggregation model value.
 * Returns null if the value is not an aggregation.
 */
export function parseAggModelValue(raw?: string | null): {
	aggId: string;
	pinnedModel?: string;
} | null {
	if (!raw?.startsWith(AGG_MODEL_PREFIX)) return null;
	const rest = raw.slice(AGG_MODEL_PREFIX.length);
	const firstColon = rest.indexOf(":");
	if (firstColon < 0) return { aggId: rest };
	const aggId = rest.slice(0, firstColon);
	const pinnedModel = rest.slice(firstColon + 1);
	return { aggId, pinnedModel: pinnedModel || undefined };
}

/**
 * Build an aggregation model value string.
 */
export function buildAggModelValue(aggId: string, pinnedModel?: string): string {
	if (pinnedModel) return `${AGG_MODEL_PREFIX}${aggId}:${pinnedModel}`;
	return `${AGG_MODEL_PREFIX}${aggId}`;
}

/**
 * 编排模式哨兵前缀。
 *
 * 会话处于编排模式时 `narrators.model` 存的是 `__orch__:<profileId>` 而不是任何
 * 具体模型。必须与服务端 `server/lib/settings/provider.ts` 的
 * ORCHESTRATION_MODEL_PREFIX 逐字一致——两边一旦漂移，前端显示的是编排方案、
 * 后端读到的却是一个解析不出模型的普通模型名。
 */
export const ORCHESTRATION_MODEL_PREFIX = "__orch__:";

/**
 * 编排分组在 `ModelOption.provider` 里的哨兵 key，与 `__default__` / `__agg__`
 * 同源：菜单按 provider 分组，这个值就是「编排模式」这一组的身份。
 */
export const ORCHESTRATION_PROVIDER_KEY = "__orchestration__";

/** profileId 的合法字符集，与服务端 parseOrchestrationModelValue 一致。 */
const ORCHESTRATION_PROFILE_ID_PATTERN = /^[a-z0-9]+$/;

/**
 * 解析编排哨兵，非编排值一律返回 null。
 *
 * 与服务端同样是严格匹配：`model` 里可能出现任意历史值，把近似值当成编排会让
 * 一个手填的模型名意外把界面切成编排模式。
 */
export function parseOrchestrationModelValue(raw?: string | null): { profileId: string } | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed.startsWith(ORCHESTRATION_MODEL_PREFIX)) return null;
	const profileId = trimmed.slice(ORCHESTRATION_MODEL_PREFIX.length);
	if (!ORCHESTRATION_PROFILE_ID_PATTERN.test(profileId)) return null;
	return { profileId };
}

/** 把方案 id 编码成模型引用（写入 narrators.model 的值）。 */
export function buildOrchestrationModelValue(profileId: string): string {
	return `${ORCHESTRATION_MODEL_PREFIX}${profileId}`;
}

/** 当前模型引用是否表示「处于编排模式」。 */
export function isOrchestrationModelValue(raw?: string | null): boolean {
	return parseOrchestrationModelValue(raw) !== null;
}

/** 编排的四个档位，顺序即界面顺序（由轻到重）。 */
export type OrchestrationTierName = "chore" | "quick" | "medium" | "heavy";

/** 四档的固定顺序，供遍历共用。 */
export const ORCHESTRATION_TIER_NAMES: readonly OrchestrationTierName[] = [
	"chore",
	"quick",
	"medium",
	"heavy",
];

/** 编排方案在模型菜单里需要的字段（前端本地形状，不 import 服务端模块）。 */
export interface OrchestrationMenuProfile {
	id: string;
	name: string;
	description?: string;
	/** 编制者候选模型（有序，取第一个可用者）。 */
	orchestratorModels: string[];
	/** 每档模型池的模型引用（"provider:modelId"）；空数组表示该档为空。 */
	tierPools: Record<OrchestrationTierName, string[]>;
}

/**
 * Resolve a (possibly meta) model reference to a concrete "provider:model" value
 * for display/capability lookups (context window, reasoning effort, codex controls).
 *
 * Handles:
 *   - "follow default" sentinel  -> the configured default model value
 *   - aggregation, pinned         -> the pinned member
 *   - aggregation, auto           -> the first member (mirrors backend "priority"
 *                                     routing default; the backend resolves the
 *                                     actual member at request time)
 *
 * This intentionally does not honor the "balanced" round-robin order or
 * provider-disabled filtering — it only needs a representative concrete model
 * for client-side display. Concrete and unknown values pass through unchanged.
 */
export function resolveDisplayModel(
	model: string | null | undefined,
	options: { defaultModelValue?: string; aggregations?: ModelAggregation[] } = {},
): string {
	const { defaultModelValue, aggregations } = options;
	const raw = model?.trim();
	if (!raw || raw === FOLLOW_DEFAULT_MODEL) {
		// Avoid infinite recursion if the default is itself a sentinel.
		const fallback = defaultModelValue?.trim();
		if (!fallback || fallback === FOLLOW_DEFAULT_MODEL) return raw ?? "";
		return resolveDisplayModel(fallback, options);
	}

	const agg = parseAggModelValue(raw);
	if (!agg) return raw;

	if (agg.pinnedModel) return resolveDisplayModel(agg.pinnedModel, options);

	const members = aggregations?.find((a) => a.id === agg.aggId)?.models ?? [];
	const first = members[0];
	if (!first) return raw;
	return resolveDisplayModel(first, options);
}

/**
 * Build a "provider:model" composite value.
 * This allows the same model ID to appear under different providers.
 */
export function modelValue(provider: string, modelId: string): string {
	return `${provider}:${modelId}`;
}

/**
 * Merge multiple ModelOption arrays, deduplicating by value.
 * Earlier entries win for identity/display fields (label, provider, rate).
 * Status annotations accumulate across duplicates: a later catalog-missing or
 * pinned fallback must not be dropped just because an unmarked catalog row
 * with the same value came first — those flags are what the UI reads to warn
 * about a delisted default/summary pin.
 */
export function mergeModels(...sources: ModelOption[][]): ModelOption[] {
	const byValue = new Map<string, ModelOption>();
	for (const list of sources) {
		for (const m of list) {
			const existing = byValue.get(m.value);
			if (!existing) {
				byValue.set(m.value, { ...m, ...(m.pinnedAs ? { pinnedAs: [...m.pinnedAs] } : {}) });
				continue;
			}
			if (m.catalogMissing) existing.catalogMissing = true;
			if (m.available === false) existing.available = false;
			if (m.pinnedAs?.length) {
				const pins = new Set([...(existing.pinnedAs ?? []), ...m.pinnedAs]);
				existing.pinnedAs = [...pins];
			}
		}
	}
	return [...byValue.values()];
}

/** Group ModelOption[] by provider for Mantine Select's grouped data format. */
export function groupModelsByProvider(
	models: ModelOption[],
	providerLabels: Record<string, string> = {},
): { group: string; items: { value: string; label: string }[] }[] {
	const defaultLabels: Record<string, string> = {
		openai: "OpenAI",
		anthropic: "Anthropic",
	};
	const labels = { ...defaultLabels, ...providerLabels };
	const groups = new Map<string, { value: string; label: string }[]>();
	const seen = new Set<string>();
	for (const m of models) {
		if (seen.has(m.value)) continue;
		seen.add(m.value);
		const prov = m.provider ?? "unknown";
		if (!groups.has(prov)) groups.set(prov, []);
		const suffix = m.rateMultiplier != null ? ` (×${m.rateMultiplier})` : "";
		groups.get(prov)?.push({ value: m.value, label: `${m.label}${suffix}` });
	}
	return [...groups.entries()].map(([prov, items]) => ({
		group: labels[prov] ?? prov,
		items,
	}));
}
