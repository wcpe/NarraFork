import { Badge, Divider, Group, Stack, Text } from "@mantine/core";
import type { OrchestrationUsage, OrchestrationUsageBucket } from "@shared/orchestration-status";
import { ORCHESTRATION_WORKER_TIERS } from "@shared/orchestration-worker-type";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * token 数的显示。
 *
 * 大数按 `12.3k` / `1.2M` 缩写：面板宽度有限，而这一栏本来只需要看出量级。
 * 刻意**不用** `toLocaleString()`——它随运行环境（Node、浏览器、ICU 版本）变化，
 * 于是同一份数据在两个环境里渲染出不同字符串，断言与截图都会莫名其妙地飘。
 */
export function formatTokens(value: number, t: Translate): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}${t("orchestrationUsageKilo")}`;
	return `${(value / 1_000_000).toFixed(2)}${t("orchestrationUsageMega")}`;
}

/**
 * 缓存读取率：命中缓存的输入 /（未命中缓存的输入 + 命中缓存的输入）。
 *
 * 写入缓存是独立的输出侧动作，不属于读取率分母；把写入计入分母会让同一批
 * 新建前缀写入把读取率人为压低。一次没有可比较的读取输入时返回 `null`，而不是 0。
 */
export function cacheReadRate(bucket: OrchestrationUsageBucket): number | null {
	const readableInput = bucket.inputTokens + bucket.cachedInputTokens;
	if (readableInput <= 0) return null;
	return bucket.cachedInputTokens / readableInput;
}

/** 规范化 token 总量：缓存写入总量只计一次，不再叠加 5m/1h 子项。 */
export function usageBucketTotalTokens(bucket: OrchestrationUsageBucket): number {
	return (
		bucket.inputTokens +
		bucket.cachedInputTokens +
		bucket.cacheCreationInputTokens +
		bucket.outputTokens
	);
}

function formatUsageSources(bucket: OrchestrationUsageBucket, t: Translate): string {
	const sources = bucket.sources;
	if (!sources) return t("orchestrationUsageSourcesUnknown");
	const parts = [
		`${t("orchestrationUsageSourceMeasured")} ${sources.measured}`,
		`${t("orchestrationUsageSourceEstimated")} ${sources.estimated}`,
	];
	if (sources.unknown > 0) parts.push(`${t("orchestrationUsageSourceUnknown")} ${sources.unknown}`);
	if (
		sources.measured === 0 &&
		sources.estimated === 0 &&
		sources.unknown === 0 &&
		bucket.requests > 0
	) {
		return t("orchestrationUsageSourcesUnknown");
	}
	return parts.join(" · ");
}

/**
 * 一个桶的一行：请求数 + 三类输入 + 输出。
 *
 * 三类输入**分开显示**而不是只给一个"总输入"：前缀缓存有没有命中是这一整块的重点，
 * 合起来就看不出来了。这是第 6 项优化（上下文与缓存）唯一能自查的地方。
 */
function BucketRow({ bucket, t }: { bucket: OrchestrationUsageBucket; t: Translate }) {
	return (
		<Stack gap={2} data-testid="orchestration-usage-bucket-row">
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageRequests")}
				</Text>
				<Text size="xs">{String(bucket.requests)}</Text>
			</Group>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageInput")}
				</Text>
				<Text size="xs">{formatTokens(bucket.inputTokens, t)}</Text>
			</Group>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageCachedInput")}
				</Text>
				<Text size="xs">{formatTokens(bucket.cachedInputTokens, t)}</Text>
			</Group>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageCacheCreation")}
				</Text>
				<Text size="xs">{formatTokens(bucket.cacheCreationInputTokens, t)}</Text>
			</Group>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageCacheWrite5m")}
				</Text>
				<Text size="xs">{formatTokens(bucket.cacheCreation5mTokens ?? 0, t)}</Text>
			</Group>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageCacheWrite1h")}
				</Text>
				<Text size="xs">{formatTokens(bucket.cacheCreation1hTokens ?? 0, t)}</Text>
			</Group>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageOutput")}
				</Text>
				<Text size="xs">{formatTokens(bucket.outputTokens, t)}</Text>
			</Group>
			<Text size="xs" c="dimmed" data-testid="orchestration-usage-sources">
				{formatUsageSources(bucket, t)}
			</Text>
		</Stack>
	);
}

/**
 * 编排开销的正文：总 token、缓存命中率、按档位与编制者分组的明细。
 *
 * 拆成纯组件是为了能直接断言三件容易画错的事：
 * - 没有数据（`null`）与读失败是两句不同的话，不能都画成 0；
 * - 一次请求都没有时命中率是「—」而不是 0%（0% 会被读成"缓存坏了"）；
 * - 偏低的缓存命中率要给出解释，而不是只摆一个数字让人猜。
 */
export function OrchestrationUsageDetails({
	usage,
	loading,
	failed,
	t,
}: {
	usage: OrchestrationUsage | null;
	loading: boolean;
	failed: boolean;
	t: Translate;
}) {
	if (failed) {
		return (
			<Text size="xs" c="red" data-testid="orchestration-usage-failed">
				{t("orchestrationUsageFailed")}
			</Text>
		);
	}
	if (loading) {
		return (
			<Text size="xs" c="dimmed" data-testid="orchestration-usage-loading">
				{t("orchestrationUsageLoading")}
			</Text>
		);
	}
	if (!usage) {
		return (
			<Text size="xs" c="dimmed" data-testid="orchestration-usage-unavailable">
				{t("orchestrationUsageUnavailable")}
			</Text>
		);
	}

	const totalTokens = usageBucketTotalTokens(usage.total);
	const rate = cacheReadRate(usage.total);

	return (
		<Stack gap={8}>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" fw={600}>
					{t("orchestrationUsageTotal")}
				</Text>
				<Text size="xs" data-testid="orchestration-usage-total">
					{formatTokens(totalTokens, t)}
				</Text>
			</Group>

			<BucketRow bucket={usage.total} t={t} />

			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationUsageCacheHitRate")}
				</Text>
				<Text size="xs" data-testid="orchestration-usage-cache-rate">
					{rate === null ? t("orchestrationUsageNoData") : `${Math.round(rate * 100)}%`}
				</Text>
			</Group>
			<Text size="xs" c="dimmed" data-testid="orchestration-usage-cache-rate-denominator">
				{t("orchestrationUsageCacheReadRateDenominator")}
			</Text>
			{/* 命中率偏低时补一句"为什么可以低":前缀缓存只在历史前缀一字不差时命中，
			    一次派发的新任务天然是一次 cache write。只摆数字会让人以为缓存失效了。 */}
			{rate !== null && rate < 0.3 && (
				<Text size="xs" c="dimmed" data-testid="orchestration-usage-cache-hint">
					{t("orchestrationUsageCacheLowHint")}
				</Text>
			)}

			<Divider />

			<Text size="xs" fw={600}>
				{t("orchestrationUsageOrchestrator")}
			</Text>
			<BucketRow bucket={usage.orchestrator} t={t} />

			<Divider />

			{/* 复核者单列：它不属于四档中的任何一档，但钱是真花了。放在这里也让
			    "编制者 + 四档 + 复核 = 总计" 这个等式在界面上看得出来。 */}
			<Text size="xs" fw={600}>
				{t("orchestrationUsageReviewers")}
			</Text>
			<BucketRow bucket={usage.reviewers} t={t} />

			<Divider />

			<Text size="xs" fw={600}>
				{t("orchestrationUsageTiers")}
			</Text>
			<Stack gap={6}>
				{ORCHESTRATION_WORKER_TIERS.map((tier) => (
					<Stack key={tier} gap={2} data-testid={`orchestration-usage-tier-${tier}`}>
						<Group gap={6} wrap="nowrap" justify="space-between">
							<Badge size="xs" variant="light" color="indigo">
								{t(`orchestrationTier_${tier}`)}
							</Badge>
							<Text size="xs">
								{t("orchestrationUsageTierSummary", {
									requests: usage.tiers[tier].requests,
									tokens: formatTokens(usageBucketTotalTokens(usage.tiers[tier]), t),
								})}
							</Text>
						</Group>
					</Stack>
				))}
			</Stack>
			<Text size="xs" c="dimmed" data-testid="orchestration-usage-run-summary">
				{t("orchestrationUsageRunSummary", { count: usage.runDetails?.length ?? 0 })}
			</Text>
			<Text size="xs" c="dimmed" data-testid="orchestration-usage-reasoning-unknown">
				{t("orchestrationUsageReasoningUnavailable")}
			</Text>
			<Text size="xs" c="dimmed" data-testid="orchestration-usage-metering-unknown">
				{t("orchestrationUsageMeteringUnavailable")}
			</Text>

			{/* 读取预算用尽时如实说明这是部分和。少算时最不能做的事就是装作是全量。 */}
			{usage.truncated && (
				<Text size="xs" c="orange" data-testid="orchestration-usage-truncated">
					{t("orchestrationUsageTruncated", { count: usage.childCount })}
				</Text>
			)}
		</Stack>
	);
}
