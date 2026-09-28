export type UsageInputSemantics = "cache-exclusive" | "cache-inclusive" | "unknown";

export interface UsageSemanticsInput {
	inputTokens?: number | null;
	cachedInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
	cacheCreation5mInputTokens?: number | null;
	cacheCreation1hInputTokens?: number | null;
}

export interface NormalizedUsageSemantics {
	semantics: UsageInputSemantics;
	unknown: boolean;
	uncachedInput: number;
	cachedInput: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	totalInput: number;
	cacheReadRate: number;
}

const CACHE_INCLUSIVE_PROVIDERS = new Set(["openai", "codex", "nug", "gemini"]);

function nonNegativeFinite(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function usageInputSemantics(provider: string): UsageInputSemantics {
	const normalizedProvider = provider.trim().toLowerCase();
	if (normalizedProvider === "anthropic") return "cache-exclusive";
	if (CACHE_INCLUSIVE_PROVIDERS.has(normalizedProvider)) return "cache-inclusive";
	return "unknown";
}

export function normalizeUsageSemantics(
	usage: UsageSemanticsInput,
	provider: string,
): NormalizedUsageSemantics {
	const semantics = usageInputSemantics(provider);
	const reportedInput = nonNegativeFinite(usage.inputTokens);
	const cachedInput = nonNegativeFinite(usage.cachedInputTokens);
	const detailedCacheWrite5m = nonNegativeFinite(usage.cacheCreation5mInputTokens);
	const detailedCacheWrite1h = nonNegativeFinite(usage.cacheCreation1hInputTokens);
	const aggregateCacheWrite = nonNegativeFinite(usage.cacheCreationInputTokens);
	const detailedCacheWrite = detailedCacheWrite5m + detailedCacheWrite1h;
	const totalCacheWrite = Math.max(aggregateCacheWrite, detailedCacheWrite);
	const cacheWrite1h = detailedCacheWrite1h;
	const cacheWrite5m =
		detailedCacheWrite > 0
			? Math.max(detailedCacheWrite5m, totalCacheWrite - cacheWrite1h)
			: totalCacheWrite;
	const uncachedInput =
		semantics === "cache-inclusive" ? Math.max(reportedInput - cachedInput, 0) : reportedInput;
	const totalInput = uncachedInput + cachedInput + cacheWrite5m + cacheWrite1h;
	const inputWithoutWrites = uncachedInput + cachedInput;

	return {
		semantics,
		unknown: semantics === "unknown",
		uncachedInput,
		cachedInput,
		cacheWrite5m,
		cacheWrite1h,
		totalInput,
		cacheReadRate: inputWithoutWrites > 0 ? cachedInput / inputWithoutWrites : 0,
	};
}
