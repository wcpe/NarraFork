import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { Fragment } from "react";
import {
	type OrchestrationWorkerView,
	orchestrationWorkerActivityMs,
} from "../../../lib/orchestration-worker-live";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** `narrators.status` 的四个合法值；界面文案由这里的映射决定。 */
const WORKER_STATUS_KEYS: Record<string, string> = {
	working: "orchestrationWorkerStatusWorking",
	idle: "orchestrationWorkerStatusIdle",
	waiting: "orchestrationWorkerStatusWaiting",
	archived: "orchestrationWorkerStatusArchived",
};

/** 状态标记的配色：归档（停放）刻意用暗色，它不在干活。 */
const WORKER_STATUS_COLORS: Record<string, string> = {
	working: "indigo",
	idle: "gray",
	waiting: "yellow",
	archived: "dark",
};

/**
 * 上下文占用的显示。
 *
 * `null`（未知）显示为「未知」而**不是** `0%`：0% 会被读成"这只 worker 的上下文还很空"，
 * 而真相是这个 worker 还没有过一条能报出占用率的请求。这两件事在界面上必须能区分，
 * 否则"上下文快满了"这个正是想看它的理由的信号会被静默吞掉。
 */
export function formatWorkerContextPercent(percent: number | null, t: Translate): string {
	if (percent === null || !Number.isFinite(percent)) return t("orchestrationWorkerContextUnknown");
	return `${Math.round(percent)}%`;
}

/**
 * 最近活动的显示。
 *
 * 没有任何记录时显示「—」而不是"很久以前"或"0 分钟前"：没有记录与"确实很久没动"
 * 是两件事，后者会让人去查一个根本不存在的卡住问题。
 */
export function formatWorkerActivity(
	activityMs: number | null,
	nowMs: number,
	t: Translate,
): string {
	if (activityMs === null) return t("orchestrationWorkerActivityUnknown");
	const elapsedMinutes = Math.max(0, Math.floor((nowMs - activityMs) / 60_000));
	if (elapsedMinutes < 1) return t("orchestrationWorkerActivityJustNow");
	if (elapsedMinutes < 60)
		return t("orchestrationWorkerActivityMinutes", { count: elapsedMinutes });
	return t("orchestrationWorkerActivityHours", { count: Math.floor(elapsedMinutes / 60) });
}

/**
 * 这一行能不能点进去看它的会话。
 *
 * 只认一件事：**拿得到这只 worker 自己的 narratorId**。拿不到就不可点——把它画成
 * 可点、点下去却没有目标，与"按钮点了没作用"是同一类错误。空字符串与只含空白的值
 * 一律按"拿不到"处理：这一列虽然是有类型的契约，但数据来自网络，没有运行时保证。
 */
export function isOrchestrationWorkerOpenable(
	worker: Pick<OrchestrationWorkerView, "narratorId">,
): boolean {
	return typeof worker.narratorId === "string" && worker.narratorId.trim().length > 0;
}

/**
 * 代理清单（编排面板的详情区）。
 *
 * 与 Popover 的分工：Popover 只给容量与历史（速览），逐 worker 的明细放在这里。
 * 拆成纯组件与 `OrchestrationUsageDetails` 同一条理由——**面板与任何未来的第二处
 * 展示共用同一份展示逻辑**，而不是各画一份；同时让"未知不等于 0"这类容易画错的
 * 分支可以被直接断言。
 *
 * `nowMs` 由调用方传入而不是内部 `Date.now()`：相对时间一旦在渲染里现取，
 * 同一份数据在不同时刻渲染出不同字符串，断言与截图都会莫名漂移。
 *
 * `onOpenWorker` 同样是**注入**而不是组件内部去读 dock 上下文与路由：这样这个纯
 * 组件在 SSR 与测试里都能直接渲染，而"先试 dock、不行就路由"这条规则仍旧只有一份
 * 实现（`useOpenNarratorSession`，调用方接上）。**没拿到这个回调时行一律不可点**，
 * 而不是画成可点却点了没反应。
 */
export function OrchestrationWorkerList({
	workers,
	workerCount,
	truncated,
	nowMs,
	t,
	onOpenWorker,
	staleAfterMs = 60_000,
}: {
	workers: readonly OrchestrationWorkerView[];
	/** 服务端统计的执行者总数（可能大于 `workers.length`）。 */
	workerCount: number;
	/** 清单被上限截断：`workers` 只是最近的一部分。 */
	truncated: boolean;
	nowMs: number;
	t: Translate;
	/** 点进某只 worker 的会话/历史；缺席时行不可点。 */
	onOpenWorker?: (narratorId: string) => void;
	/** 实时事件超过此时长未更新时显示 stale。 */
	staleAfterMs?: number;
}) {
	if (workers.length === 0) {
		return (
			<Text size="xs" c="dimmed" data-testid="orchestration-workers-empty">
				{t("orchestrationWorkersEmpty")}
			</Text>
		);
	}

	return (
		<Stack gap={4} data-testid="orchestration-workers">
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" c="dimmed">
					{t("orchestrationWorkersColumns")}
				</Text>
				<Text size="xs" c="dimmed" data-testid="orchestration-workers-count">
					{t("orchestrationWorkersCount", { count: workerCount })}
				</Text>
			</Group>
			{workers.map((worker, index) => {
				const isReviewer = worker.liveRole === "reviewer";
				const previousRole = workers[index - 1]?.liveRole === "reviewer";
				// 可点的两个条件都必须在**渲染前**成立：拿得到 id，且调用方给了打开回调。
				const canOpen = !!onOpenWorker && isOrchestrationWorkerOpenable(worker);
				const openWorker = canOpen ? () => onOpenWorker?.(worker.narratorId) : undefined;
				return (
					<Fragment key={worker.narratorId}>
						{(index === 0 || previousRole !== isReviewer) && (
							<Text size="xs" fw={600} c="dimmed">
								{isReviewer
									? t("orchestrationWorkersReviewers")
									: t("orchestrationWorkersExecutors")}
							</Text>
						)}
						<Stack
							key={worker.narratorId}
							gap={2}
							data-testid={`orchestration-worker-${worker.narratorId}`}
							// 整行可点（两行都是纯文本，没有可展开的内容会与点击冲突）。不可点时
							// 连 `onClick` 都不挂：挂一个什么都不做的处理器，就等于假装可点。
							onClick={openWorker}
							style={{
								cursor: canOpen ? "pointer" : "default",
								borderRadius: "var(--mantine-radius-sm)",
							}}
							data-openable={canOpen ? "true" : "false"}
						>
							<Group gap="xs" wrap="nowrap" align="center">
								<Badge size="xs" variant="light" color="indigo" style={{ flexShrink: 0 }}>
									{t(`orchestrationTier_${worker.tier}`)}
								</Badge>
								<Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }}>
									{worker.liveRole === "reviewer"
										? t("orchestrationWorkerRoleReviewer")
										: t("orchestrationWorkerRoleWorker")}
								</Badge>
								<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
									{worker.model ?? t("orchestrationWorkerModelUnknown")}
								</Text>
								<Badge
									size="xs"
									variant="light"
									color={WORKER_STATUS_COLORS[worker.status] ?? "gray"}
									data-testid={`orchestration-worker-status-${worker.narratorId}`}
									style={{ flexShrink: 0 }}
								>
									{t(WORKER_STATUS_KEYS[worker.status] ?? "orchestrationWorkerStatusUnknown")}
								</Badge>
								{/* 可点的行给一个**明确的门**（不只是光标变化）：光标只在指针移到行上时
							    才看得见，而"这一行能点进去看历史"是要在移上去之前就看得出来的事。 */}
								{canOpen && (
									<Tooltip label={t("orchestrationWorkerOpen")} withArrow>
										<ActionIcon
											size="xs"
											variant="subtle"
											color="indigo"
											style={{ flexShrink: 0 }}
											aria-label={t("orchestrationWorkerOpen")}
											data-testid={`orchestration-worker-open-${worker.narratorId}`}
											onClick={(event) => {
												// 图标与整行做的是同一件事，但点击会冒泡到行上再触发一次，
												// 因此这里必须截住。
												event.stopPropagation();
												openWorker?.();
											}}
										>
											<IconExternalLink size={12} />
										</ActionIcon>
									</Tooltip>
								)}
							</Group>
							<Group gap="xs" wrap="nowrap" justify="space-between">
								<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
									{worker.livePhase || worker.liveToolName ? (
										<Text size="xs" c="dimmed" truncate>
											{worker.liveToolName ?? worker.livePhase}
										</Text>
									) : (
										<Text size="xs" c="dimmed">
											{t("orchestrationWorkerPhaseUnknown")}
										</Text>
									)}
									{/* 复用而来的 worker 单独标一下：它省下的前缀缓存是这套机制的
								    主要收益，"到底有没有在用停放池"只有这里看得见。 */}
									{worker.reused === true && (
										<Badge size="xs" variant="outline" color="teal">
											{t("orchestrationWorkerReused")}
										</Badge>
									)}
									{worker.reused === null && (
										<Text size="xs" c="dimmed">
											{t("orchestrationWorkerReuseUnknown")}
										</Text>
									)}
									{worker.live && (
										<Badge size="xs" variant="dot" color="indigo">
											{t("orchestrationWorkerLive")}
										</Badge>
									)}
								</Group>
								<Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
									<Text
										size="xs"
										c="dimmed"
										data-testid={`orchestration-worker-context-${worker.narratorId}`}
									>
										{`${t("orchestrationWorkerContext")} ${formatWorkerContextPercent(worker.contextPercent, t)}${
											worker.liveContextSource !== null && worker.liveContextSource !== undefined
												? ` · ${t(
														worker.liveContextSource === "estimated"
															? "orchestrationSourceEstimated"
															: worker.liveContextSource === "provider" ||
																	worker.liveContextSource === "measured"
																? "orchestrationSourceMeasured"
																: "orchestrationSourceUnknown",
													)}`
												: ""
										}`}
									</Text>
									<Text
										size="xs"
										c="dimmed"
										data-testid={`orchestration-worker-activity-${worker.narratorId}`}
									>
										{formatWorkerActivity(orchestrationWorkerActivityMs(worker), nowMs, t)}
									</Text>
									{worker.liveAtMs !== null && nowMs - worker.liveAtMs > staleAfterMs && (
										<Badge size="xs" variant="outline" color="orange">
											{t("orchestrationWorkerStale")}
										</Badge>
									)}
								</Group>
							</Group>
						</Stack>
					</Fragment>
				);
			})}
			{/* 截断时如实说明：少算时最不能做的事就是装作是全量。 */}
			{truncated && (
				<Text size="xs" c="orange" data-testid="orchestration-workers-truncated">
					{t("orchestrationWorkersTruncated", {
						shown: workers.length,
						omitted: Math.max(0, workerCount - workers.length),
					})}
				</Text>
			)}
		</Stack>
	);
}
