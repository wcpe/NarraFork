import { ActionIcon, Badge, Divider, Group, Popover, Stack, Text, Tooltip } from "@mantine/core";
import type { OrchestrationRunAudit, OrchestrationStatus } from "@shared/orchestration-status";
import { ORCHESTRATION_WORKER_TIERS } from "@shared/orchestration-worker-type";
import { IconGauge } from "@tabler/icons-react";
import { useState } from "react";
import { useOrchestrationStatus } from "../../../hooks/useOrchestrationStatus";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 面板里最多列几条最近的派发：这是速览，不是审计流水（完整历史走接口的 `limit`）。 */
const RECENT_RUN_ROWS = 5;

/**
 * 复用命中率：停放池里被重新唤醒的 worker 占全部派发的比例。
 *
 * 这个数字值得单独给一行，因为**复用是这套机制唯一真正省下前缀缓存的地方**：
 * 新建 worker 要从头付一次完整前缀，唤醒停放中的 worker 则接着它已有的上下文往下走。
 * 一次派发都没有时返回 `null` 而不是 0——0% 会被读成"复用坏了"，
 * 而真相是"还没有过派发"。
 */
export function orchestrationReuseRate(runs: OrchestrationRunAudit): {
	reused: number;
	runs: number;
	rate: number | null;
} {
	const tiers = ORCHESTRATION_WORKER_TIERS.map((tier) => runs.aggregate[tier]);
	const totalRuns = tiers.reduce((sum, stats) => sum + stats.runs, 0);
	const reused = tiers.reduce((sum, stats) => sum + stats.reused, 0);
	return { reused, runs: totalRuns, rate: totalRuns > 0 ? reused / totalRuns : null };
}

/**
 * 已收尾派发的耗时总和。
 *
 * 逐档的「平均」已经在上面，但"这次编排一共跑了多久"是四档之和——把四个平均值加起来
 * 是错的（各档次数不同），逐档看也看不出来。`null` 表示一次都还没收尾，与
 * {@link formatDuration} 同一条口径：没收到尾显示「—」而不是 0ms。
 */
export function orchestrationTotalDurationMs(runs: OrchestrationRunAudit): number | null {
	const tiers = ORCHESTRATION_WORKER_TIERS.map((tier) => runs.aggregate[tier]);
	const finished = tiers.reduce((sum, stats) => sum + stats.finished, 0);
	if (finished === 0) return null;
	return tiers.reduce((sum, stats) => sum + stats.totalDurationMs, 0);
}

/**
 * 耗时显示。
 *
 * `null` 显示为「—」而不是 `0`：`null` 的意思是"没收到尾"（后台派发还在跑，
 * 或进程中途退出），把它显示成 0ms 会让人以为那次派发瞬间就结束了。
 */
function formatDuration(ms: number | null, t: Translate): string {
	if (ms === null) return t("orchestrationStatusDurationUnknown");
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 编排状态详情（阶段 7）的触发按钮 + 弹出面板。
 *
 * 放在会话状态栏里模型位**旁边**而不是再造一个"编排：方案名"标识——那个标识已经
 * 由模型位承担（`orchestrationModelLabel`），重复一个只会让同一件事有两个来源。
 * 这里补的是它给不出的东西：池子里停着什么、容量配得合不合理。
 *
 * 只在编排会话里渲染（由调用方判定），因此非编排会话的状态栏看不出任何变化。
 *
 * 拉取时机：**打开才拉**。状态是"想看时才需要"的观测数据，没有对应的 WS 变更事件，
 * 也没有任何渲染决策依赖它；挂载即拉会给每个打开的面板都加一条常驻请求。
 */
export function OrchestrationStatusPopover({
	narratorId,
	t,
}: {
	narratorId: string;
	t: Translate;
}) {
	const [opened, setOpened] = useState(false);
	const { data, isFetching, isError } = useOrchestrationStatus(narratorId, { enabled: opened });

	return (
		<Popover
			opened={opened}
			onChange={setOpened}
			onClose={() => setOpened(false)}
			position="top"
			withArrow
			withinPortal
			shadow="md"
			width={340}
		>
			<Popover.Target>
				<Tooltip label={t("orchestrationStatusTooltip")} withArrow>
					<ActionIcon
						data-testid="orchestration-status-trigger"
						variant="subtle"
						color="indigo"
						size="sm"
						aria-label={t("orchestrationStatusTooltip")}
						// 必须显式接线：Mantine 的 `Popover.Target` 只负责定位与锚定，
						// **不会**自己把点击转成开关。少了这一行，按钮会渲染出来但点了没反应
						// ——而只渲染面板内容、不模拟点击的测试抓不到它。
						onClick={() => setOpened((current) => !current)}
					>
						<IconGauge size={16} />
					</ActionIcon>
				</Tooltip>
			</Popover.Target>
			<Popover.Dropdown data-testid="orchestration-status-popover">
				<OrchestrationStatusDetails
					status={data ?? null}
					loading={isFetching && !data}
					failed={isError}
					t={t}
				/>
			</Popover.Dropdown>
		</Popover>
	);
}

/**
 * 弹出面板的正文。拆成纯组件是为了能直接断言三组数据的呈现——尤其是
 * `maxConcurrent: null`（不限）与空池这两条容易被渲染成"0"的分支。
 */
export function OrchestrationStatusDetails({
	status,
	loading,
	failed,
	t,
}: {
	status: OrchestrationStatus | null;
	loading: boolean;
	failed: boolean;
	t: Translate;
}) {
	if (failed) {
		return (
			<Text size="xs" c="red" data-testid="orchestration-status-failed">
				{t("orchestrationStatusFailed")}
			</Text>
		);
	}
	if (loading) {
		return (
			<Text size="xs" c="dimmed" data-testid="orchestration-status-loading">
				{t("orchestrationStatusLoading")}
			</Text>
		);
	}
	// 服务端说"这个会话不在编排模式"（哨兵已消失，例如刚退出编排）。不编造数字。
	if (!status) {
		return (
			<Text size="xs" c="dimmed" data-testid="orchestration-status-unavailable">
				{t("orchestrationStatusUnavailable")}
			</Text>
		);
	}

	return (
		<Stack gap={8}>
			<Text size="xs" fw={600}>
				{t("orchestrationStatusProfile", { name: status.profileName })}
			</Text>
			<Text size="xs" c="dimmed">
				{t("orchestrationStatusOrchestratorModel", {
					model: status.orchestratorModel ?? t("orchestrationStatusUnknownModel"),
				})}
			</Text>

			<Divider />

			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" fw={600}>
					{t("orchestrationStatusTiers")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("orchestrationStatusTierColumns")}
				</Text>
			</Group>
			<Stack gap={2}>
				{ORCHESTRATION_WORKER_TIERS.map((tier) => (
					<Group
						key={tier}
						gap={6}
						wrap="nowrap"
						justify="space-between"
						data-testid={`orchestration-status-tier-${tier}`}
					>
						<Badge size="xs" variant="light" color="indigo">
							{t(`orchestrationTier_${tier}`)}
						</Badge>
						<Text size="xs" data-testid={`orchestration-status-tier-${tier}-counts`}>
							{`${status.tiers[tier].parked} / ${status.tiers[tier].running}`}
						</Text>
					</Group>
				))}
			</Stack>

			<Divider />

			<Text size="xs" fw={600}>
				{t("orchestrationStatusPools")}
			</Text>
			{ORCHESTRATION_WORKER_TIERS.map((tier) => (
				<Stack key={tier} gap={2} data-testid={`orchestration-status-pool-${tier}`}>
					<Text size="xs" c="dimmed">
						{t(`orchestrationTier_${tier}`)}
					</Text>
					{status.pools[tier].length === 0 ? (
						<Text size="xs" c="dimmed">
							{t("orchestrationPoolEmpty")}
						</Text>
					) : (
						status.pools[tier].map((entry) => (
							<Group key={entry.model} gap={6} wrap="nowrap" justify="space-between">
								<Text size="xs" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
									{entry.model}
								</Text>
								<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
									{entry.maxConcurrent === null
										? `${entry.inFlight} / ${t("orchestrationStatusUnlimited")}`
										: `${entry.inFlight} / ${entry.maxConcurrent}`}
								</Text>
							</Group>
						))
					)}
				</Stack>
			))}

			<Divider />

			{/* 派发审计：与上半部分的"现在"相反，这一块回答"过去几次的账"。 */}
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" fw={600}>
					{t("orchestrationStatusRuns")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("orchestrationStatusRunsColumns")}
				</Text>
			</Group>
			<Stack gap={2}>
				{ORCHESTRATION_WORKER_TIERS.map((tier) => (
					<Group
						key={tier}
						gap={6}
						wrap="nowrap"
						justify="space-between"
						data-testid={`orchestration-status-runs-${tier}`}
					>
						<Badge size="xs" variant="light" color="indigo">
							{t(`orchestrationTier_${tier}`)}
						</Badge>
						<Text size="xs">
							{t("orchestrationStatusTierRuns", {
								runs: status.runs.aggregate[tier].runs,
								avg: formatDuration(status.runs.aggregate[tier].avgDurationMs, t),
								reused: status.runs.aggregate[tier].reused,
							})}
						</Text>
					</Group>
				))}
			</Stack>

			{/* 全档合计的复用命中率。逐档的「复用 N」已经在上面，但"这套配置到底有没有
			    在用停放池"是一个整体判断，把四个档的分子分母各自摆一行看不出来。 */}
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationStatusReuseRate")}
				</Text>
				<Text size="xs" data-testid="orchestration-status-reuse-rate">
					{(() => {
						const reuse = orchestrationReuseRate(status.runs);
						if (reuse.rate === null) return t("orchestrationUsageNoData");
						return `${Math.round(reuse.rate * 100)}%（${reuse.reused} / ${reuse.runs}）`;
					})()}
				</Text>
			</Group>

			{/* 全档合计耗时：四档的「平均」相加是错的（各档次数不同），所以这里用同一份
			    聚合里的 totalDurationMs 直接求和。 */}
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationStatusTotalDuration")}
				</Text>
				<Text size="xs" data-testid="orchestration-status-total-duration">
					{formatDuration(orchestrationTotalDurationMs(status.runs), t)}
				</Text>
			</Group>

			{status.runs.recent.length > 0 && (
				<Stack gap={2} data-testid="orchestration-status-recent">
					{status.runs.recent.slice(0, RECENT_RUN_ROWS).map((run) => (
						<Group key={run.id} gap={6} wrap="nowrap" justify="space-between">
							<Text size="xs" c="dimmed" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
								{`${t(`orchestrationTier_${run.tier}`)} · ${t(`orchestrationRunPhase_${run.phase}`)}`}
								{run.progress?.currentPhase
									? ` · ${t("orchestrationStatusProgress", { phase: run.progress.currentPhase })}`
									: ""}
								{run.reusedWorker ? ` · ${t("orchestrationStatusRunReused")}` : ""}
								{run.verdict ? ` · ${run.verdict}` : ""}
							</Text>
							<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
								{formatDuration(run.durationMs, t)}
							</Text>
						</Group>
					))}
				</Stack>
			)}
		</Stack>
	);
}
