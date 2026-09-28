/**
 * RenderSubagent.tsx — Render copy for the SubagentCard (batch-2 P12).
 *
 * Pairs with measure-subagent.ts. Draws the composite card (header + recent
 * calls + LazyCollapse body) at the geometry the measure layer computed, with
 * zero DOM measurement. Visual parity target: SubagentCard.tsx.
 *
 * Regions (top → bottom), each an absolutely-positioned box at its measured top:
 *   - header       (always): badge row + description (truncate collapsed / wrap
 *                  expanded) + optional collapsed result preview.
 *   - recent calls (always when present): title row + ≤3 activity rows. Both the
 *                  title button and each row open the child session (parity with
 *                  SubagentCard, whose rows are UnstyledButtons).
 *   - body         (effectiveExpanded): selfPermission (RenderInlinePermission,
 *                  P11) + prompt toggle/body + pending cards (P10 placeholder) +
 *                  resolveOverride button + result (RenderMarkdown, maxHeight).
 *
 * Wrapping text (expanded description, result markdown) is materialized from the
 * SAME pretext flow the measure layer produced so rendered wrapping matches the
 * predicted height. This is a VISUAL copy: live interaction (navigation, detach,
 * cancel, i18n) lives in SubagentCard.tsx outside vlist/; callers inject handlers.
 *
 * Follows the RenderReasoning.tsx / RenderSystemSimple.tsx / RenderPermission.tsx
 * template.
 */

import {
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Paper,
	Text,
	ThemeIcon,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { FOLLOW_PARENT_MODEL, type SubagentModelInheritance } from "@shared/model-inheritance";
import type {
	OrchestrationWorkerTier,
	OrchestrationWorkerType,
} from "@shared/orchestration-worker-type";
// The row height comes from the shared row metrics, resolved at RENDER time, so it
// tracks the reader's typography exactly as the measure side does.
import { bareRowMetrics } from "@shared/pretext-layout/row-metrics";
import {
	IconAlertTriangle,
	IconBan,
	IconChevronDown,
	IconChevronRight,
	IconCircleCheck,
	IconCircleX,
	IconLink,
	IconRobot,
} from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import {
	BLOCK_PADDING_X,
	badgeRowHeight,
	CARD_PADDING,
	CHEVRON_SIZE,
	DESC_LEFT,
	DESC_MARGIN_TOP,
	FILE_CHANGE_MAX_ROWS,
	FILE_CHANGE_STACK_GAP,
	type MeasuredSubagent,
	PENDING_CARD_BORDER,
	PROMPT_BODY_MARGIN_TOP,
	PROMPT_TOGGLE_ROW_HEIGHT,
	RECENT_STACK_GAP,
	RECENT_TITLE_MARGIN_BOTTOM,
	SELF_PERMISSION_MARGIN_X,
	STATUS_ICON_SIZE,
	type SubagentFileChangesData,
	subagentFileChangeIdentityKey,
	subagentFileChangeScopeKey,
	THEME_ICON_SIZE,
} from "../measure/measure-subagent";
import { HEADER_CELL_GAP, type ToolCategory } from "../measure/measure-tool-call";
// The recent-call rows ARE trace rows, so their lane geometry comes from the trace
// height model rather than a second set of numbers.
import { TRACE_CHEVRON, TRACE_ROW_GAP, TRACE_ROW_ICON } from "../measure/measure-tool-run";
import { typographyMetrics } from "../pretext-fonts";
import type { VListViewControls } from "../VListContentViewHost";
import { findViewTarget, type VListViewTarget } from "../vlist-content-view-target";
import { CategoryChip } from "./category-chip";
import { categoryIcon } from "./category-icons";
import { DiffStatsText } from "./diff-stats-text";
import { swallowSelectionClick } from "./key-activate";
import { RenderMarkdown } from "./RenderMarkdown";
import { RenderInlinePermission } from "./RenderPermission";
import {
	CATEGORY_COLOR,
	RenderToolBody,
	ToolTimingArea,
	type ToolTimingLabels,
} from "./RenderToolCall";
import { subagentFilePathDisplays } from "./subagent-file-paths";
import {
	isTerminalToolRowStatus,
	resolveToolRowStatusMark,
	type ToolRowStatusMark,
	TRACE_ROW_STATUS_SLOT_STYLE,
	TraceRowStatusGlyph,
} from "./trace-row-status";

/** i18n-facing labels, injected by the dispatch/registry layer. English defaults
 * keep this self-contained (no i18n import across the vlist edge). */
export interface SubagentLabels {
	/** Recent-calls section title ("Recent calls"). */
	recentCalls?: string;
	/** "Open full session" button label. */
	openSession?: string;
	/** Prompt toggle label ("Prompt"). */
	prompt?: string;
	/** Pending-permission section title ("Waiting for permission"). */
	pendingTitle?: string;
	/** Resolve-override button label ("Resolve override"). */
	resolveOverride?: string;
	/** Waiting-permission badge label (header). */
	waitingBadge?: string;
	/** Background badge label. */
	backgroundBadge?: string;
	/** "Taken over by user" badge label. */
	takenOverBadge?: string;
	/** The model follows the parent's live selection, not a concrete snapshot. */
	followParent?: string;
	/** Tooltip on a followed-parent badge. */
	followTooltip?: string;
	/** Tooltip on a pool-fallback badge: `{parentModel}` / `{pool}` placeholders. */
	fallbackReason?: string;
	/** 编排 worker 的模型 badge：等待模型恢复时的替代文案。 */
	waitingModel?: string;
	/** 编排 worker 的模型 badge：可点时的 tooltip。 */
	switchWorkerModelTooltip?: string;
	/**
	 * 编排 worker 的档位 badge 文案，四档齐全（与服务端 `orchestrationTier_*` 同源）。
	 *
	 * 允许缺档：`RenderSubagent` 对这一项做了深合并，缺的档位用内置英文名兜底
	 * （它是 labels 里唯一的对象型字段，浅合并会静默吃掉其余档位）。
	 */
	workerTier?: Partial<Record<OrchestrationWorkerTier, string>>;
	/**
	 * 编排 worker 的**身份 chip** 文案：执行者 / 复核者。
	 *
	 * 类型 chip 回答的是"这是谁"，而编排派发恰好回答不了：编排模式里 `subagent_type`
	 * 刻意留空（类型由 `tier` 派生，见 task.ts 的 `buildParameters`），`agentType` 因此
	 * 回退成工具名 `Agent`；复核者那边则是原始编码串
	 * （`orch-review--<profileId>--<tier>`）。两者都看不出角色，这两个文案就是那个位置
	 * 要画的字。
	 *
	 * 刻意用**两个平铺的字符串**而不是一个对象：`labels` 是浅合并的，对象型字段会被
	 * 部分对象整个替换掉，缺的那几项静默变成 undefined（`workerTier` 就得为此单独
	 * 做一次深合并）。平铺字段没有这个坑。
	 */
	workerExecutor?: string;
	workerReviewer?: string;
	/** File-changes section title ("Changed files"). */
	fileChanges?: string;
	/** Suffix for a file whose line counts are unknown. */
	linesNotMeasured?: string;
	/**
	 * Marker for a file the parent's revert will NOT restore (the subagent ran with a
	 * different `workdir`, so the change landed in another worktree).
	 */
	outsideWorkspace?: string;
	/** Overflow row: `{count}` more files. */
	moreFiles?: string;
	/** Overflow row: `{count}` files touched by shell commands. */
	shellTouched?: string;
	/** Legacy churn is neither exact per-attempt ownership nor net contribution. */
	fileChangeLegacy?: string;
	/** A requested execution window is not a verified attempt boundary. */
	fileChangeWindow?: string;
	unknownDevice?: string;
	unknownWorkspace?: string;
	/** Unknown parent comparison must not read as known inside/revert coverage. */
	unknownCoverage?: string;
	/** Overflow row: `{count}` changes with missing line measurements. */
	unmeasuredChanges?: string;
	countsTruncated?: string;
	/** Per-file churn qualifier: `{count}` edits. */
	fileEdits?: string;
	collapseFiles?: string;
	/**
	 * Timing popover strings for the header + recent-call rows. Absent → the render
	 * layer's English fallbacks. Height-neutral (portaled popover / fixed rows).
	 */
	timing?: ToolTimingLabels;
	/**
	 * Names for a recent-call row's status MARK, for readers who get neither the
	 * glyph's colour nor its shape. Absent → the glyph's own English fallbacks.
	 * Attributes only → height-neutral.
	 */
	statusMark?: Partial<Record<ToolRowStatusMark, string>>;
}

const DEFAULT_LABELS: Required<Omit<SubagentLabels, "timing" | "statusMark">> = {
	recentCalls: "Recent calls",
	openSession: "Open full session",
	prompt: "Prompt",
	pendingTitle: "Waiting for permission",
	resolveOverride: "Resolve override",
	waitingBadge: "Awaiting permission",
	backgroundBadge: "Background",
	takenOverBadge: "Taken over by user",
	followParent: "Follow parent",
	followTooltip: "Following the parent model",
	fallbackReason: "The parent's {parentModel} is not in the {pool} pool",
	waitingModel: "Waiting for model",
	switchWorkerModelTooltip: "This model is unavailable — switch to another and keep going",
	// 编排档位的英文兜底：外壳（useVListLabels）会用 i18n 覆盖这四个。
	workerTier: { chore: "Chore", quick: "Quick", medium: "Medium", heavy: "Heavy" },
	// 编排 worker 的身份兜底：外壳（useVListLabels）会用 i18n 覆盖这两个。
	workerExecutor: "Executor",
	workerReviewer: "Reviewer",
	fileChanges: "Changed files",
	linesNotMeasured: "lines not measured",
	moreFiles: "{count} more files",
	shellTouched: "{count} touched by shell",
	outsideWorkspace: "outside this workspace",
	fileChangeLegacy: "Legacy/unscoped · not per-attempt or net changes",
	fileChangeWindow: "Requested boundary only; not verified attempt evidence",
	unknownDevice: "unknown device",
	unknownWorkspace: "unknown workspace",
	unknownCoverage: "parent workspace coverage unknown",
	unmeasuredChanges: "{count} changes not measured",
	countsTruncated: "counts truncated; totals are lower bounds",
	fileEdits: "{count} edits",
	collapseFiles: "Show fewer files",
};

/**
 * The single trailing row under a file list: hidden files, shell-touched files, and
 * the unmeasured tally, joined with `·`.
 *
 * One row rather than one per fact, because the row is MEASURED — each additional
 * line would make every such card taller. The tallies must still all appear: a list
 * that silently omits its unmeasured count reads as complete (see the NULL contract
 * in `subagent-file-changes.ts`).
 */
function overflowSummary(
	changes: SubagentFileChangesData,
	hidden: number,
	expanded: boolean,
	labels: ResolvedSubagentLabels,
): string {
	const parts: string[] = [];
	if (expanded) parts.push(labels.collapseFiles);
	if (hidden > 0) parts.push(withCount(labels.moreFiles, hidden));
	if (changes.bashTouchedCount > 0) {
		parts.push(withCount(labels.shellTouched, changes.bashTouchedCount));
	}
	if (changes.totalUnmeasured > 0) {
		parts.push(withCount(labels.unmeasuredChanges, changes.totalUnmeasured));
	}
	if (changes.countsTruncated) parts.push(labels.countsTruncated);
	return parts.join(" · ");
}

/** Labels may use i18next's {{count}} or the renderer's {count} fallback. */
function withCount(template: string, count: number): string {
	return template.replace("{{count}}", String(count)).replace("{count}", String(count));
}

/**
 * Labels after merging the defaults: every string is present, while `timing` and
 * `statusMark` stay optional because `ToolTimingArea` and `TraceRowStatusGlyph` own
 * their own English fallback bundles.
 */
type ResolvedSubagentLabels = Required<Omit<SubagentLabels, "timing" | "statusMark">> &
	Pick<SubagentLabels, "timing" | "statusMark">;

interface RenderSubagentProps {
	measured: MeasuredSubagent;
	/** Description line text (collapsed truncate / expanded wrap). */
	description: string;
	/** Agent-type badge label. */
	agentType?: string;
	/** Extra background badge. */
	isBackground?: boolean;
	/**
	 * Extra "taken over by user" badge: the parent's tool call is parked until the
	 * user releases the child. The Loader stays — the child really is being worked
	 * on — so the badge is what says the session is waiting on a PERSON.
	 */
	isTakenOver?: boolean;
	/** Extra model badge. */
	model?: string;
	/** Follow/fallback decision when `model` is `__parent__`. */
	modelInheritance?: SubagentModelInheritance;
	/**
	 * 编排 worker 的档位 badge（chore/quick/medium/heavy）。
	 *
	 * 只有编排 worker 才有值：它来自派发输入 / 类型编码的解析结果（见
	 * segment-adapter 的 `orchestrationTier`），普通子代理永远拿不到一个档位。
	 * 无法识别档位时**什么也不画**——一个"看起来同样权威"的假档位比没有更糟。
	 */
	workerTier?: string;
	/**
	 * 编排 worker 的角色（执行者 / 复核者），只用于身份 chip。
	 *
	 * **只认类型编码**（`workerKind` 由 `parseOrchestrationWorkerType` 从
	 * `agentType` 解出，见 segment-adapter）。执行者的 `subagent_type` 是空的，因此
	 * 这里通常是 undefined——那正是执行者的实际情况，按执行者显示。拿不到编码时
	 * 宁可少说一句角色，也不能把一个执行者画成复核者。
	 */
	workerKind?: OrchestrationWorkerType["kind"];
	/**
	 * 编排 worker 的「换模型继续」入口（阶段 6）。
	 *
	 * 只有编排 worker（执行者 / 复核者）撞上模型不可用或配额等待时，模型 badge
	 * 才变成可点。其余情况（非编排子代理、或一切正常的 worker）保持只读——
	 * 一个平时也能点的 badge 会让人以为"随便换模型"是这个卡片的常规操作。
	 */
	onSwitchWorkerModel?: () => void;
	/** 当前是否正停在模型不可用的等待上（决定 badge 可点 + 等待文案）。 */
	modelWait?: { waitKind?: "credentials" | "quota"; model?: string; resumeAt?: number } | null;
	/** Extra thinking-effort badge (cyan), mirroring SubagentCard.tsx. */
	reasoningEffort?: string;
	/** Collapsed result preview text (first ~120 chars). */
	resultPreview?: string;
	/** Recent activity call tool names (≤3 drawn). */
	recentCallNames?: string[];
	/**
	 * Files the child changed, with `+N -N` per path. Absent → no file block.
	 *
	 * Passed alongside `measured` rather than read out of it because the measure layer
	 * keeps only what decides height (the row COUNT); the row contents live here.
	 */
	fileChanges?: SubagentFileChangesData;
	/** Header status: active shows a Loader, else a status glyph (per `status`). */
	isActive?: boolean;
	/** Raw terminal status for the glyph (success/fail/cancelled). Render-only. */
	status?: string;
	labels?: SubagentLabels;
	/** Header + description toggle (expand/collapse). */
	onToggle?: () => void;
	/** Prompt toggle click. */
	onTogglePrompt?: () => void;
	/** Expand/collapse the file-change list (its trailing overflow row). */
	onToggleFileChanges?: () => void;
	/** "Open full session" click. */
	onOpenSession?: () => void;
	/** Resolve-override click. */
	onResolveOverride?: () => void;
	/**
	 * Live permission form node (real InlinePermission / AskUserQuestionBanner) for
	 * a subagent that is itself requesting permission. When set, the card grows to
	 * fit it (real height corrected after paint via the shell's onUnknownHeight)
	 * instead of clipping to the arithmetic height.
	 */
	permissionSlot?: ReactNode;
	/**
	 * Fullscreen-viewer wiring for this card's prompt / result bodies
	 * (`resolveSubagentViewTargets`) plus the shell's per-body wrap + source state.
	 * Both absent → the bodies render exactly as before, with no action bar.
	 *
	 * Height-neutral: the action bar is a zero-height absolute overlay, and both
	 * bodies already have measure-fixed heights that scroll internally.
	 */
	viewTargets?: readonly VListViewTarget[];
	viewControls?: VListViewControls;
}

function cssColor(color: string, shade: number): string {
	return `var(--mantine-color-${color}-${shade})`;
}

/**
 * Terminal-status glyph (StatusIcon parity): green check on success, red X on
 * fail/error, orange ban on cancelled. Falls back to a green check for unknown
 * terminal states. Height-neutral (fixed 14px header slot).
 */
function SubagentStatusGlyph({ status }: { status?: string }) {
	if (status === "fail" || status === "error") {
		return <IconCircleX size={STATUS_ICON_SIZE} style={{ color: cssColor("red", 6) }} />;
	}
	if (status === "cancelled") {
		return <IconBan size={STATUS_ICON_SIZE} style={{ color: cssColor("orange", 6) }} />;
	}
	return <IconCircleCheck size={STATUS_ICON_SIZE} style={{ color: cssColor("green", 6) }} />;
}

/**
 * The chevron/dot lane of a trace row. Restated here (rather than imported from
 * `RenderToolRun`) only because that module's copy is module-private; both derive
 * from the same `TRACE_CHEVRON` width, so they cannot disagree on geometry.
 */
const TRACE_CHEVRON_SLOT_STYLE = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	width: TRACE_CHEVRON,
	minWidth: TRACE_CHEVRON,
	flexShrink: 0,
} as const satisfies CSSProperties;

/** The "•" marker's own metrics (parity with RenderToolRun / CollapsibleTrace). */
const DOT_STYLE = { opacity: 0.5, lineHeight: 1, fontSize: 10 } as const satisfies CSSProperties;

/** Glyph inset inside the 14px category chip (parity with the trace row). */
const TRACE_ROW_GLYPH_SIZE = 9;

/** Row titles are capped so one long summary cannot dominate the card. */
const RECENT_TITLE_MAX_CHARS = 80;

/**
 * `Tool · summary` for one recent-call row — the same wording a folded trace row
 * uses (`truncateTitle` + `Task → Agent` in the adapter).
 *
 * Restated inside vlist/ rather than imported from `tool-display`: the isolation
 * guard forbids vlist from statically importing the chunk render path, which is
 * what keeps the flag-off bundle free of vlist and vice versa. The rule is small
 * enough that a copy is safe; the SUMMARY itself still comes from the one shared
 * formatter, through the resolver the shell injects.
 *
 * Height-neutral: the result is painted on a single truncating line.
 */
function recentCallTitle(
	toolName: string,
	summary: string | null,
): { name: string; detail: string } {
	const name = toolName === "Task" ? "Agent" : toolName;
	// The name is BOLD and carries no separator (see the trace row, whose wording this
	// mirrors), but the truncation budget is still the whole visible label — otherwise a
	// long summary would clip at a different point in the two forms.
	const text = summary ? `${name} ${summary}` : name;
	const clipped =
		text.length > RECENT_TITLE_MAX_CHARS ? `${text.slice(0, RECENT_TITLE_MAX_CHARS - 3)}…` : text;
	// Split the (possibly clipped) label back into its bold head and the rest. A clip that
	// ate into the name itself leaves no detail, which is correct: there is nothing left of
	// the summary to show.
	if (!clipped.startsWith(name)) return { name: clipped, detail: "" };
	return { name, detail: clipped.slice(name.length).trimStart() };
}

/**
 * A recent-call row's category chip — the SAME 14px tinted tile a folded trace row
 * shows, so one child tool call reads identically in both places.
 *
 * `category` is resolved by the adapter (the row carries no full tool input, so it
 * comes from the tool NAME alone, exactly as the chunked row does). Absent →
 * `categoryIcon`'s generic fallback, which keeps the slot occupied rather than
 * collapsing it and shortening the row.
 */
function RecentCallCategoryChip({
	category,
	toolName,
}: {
	category: string | null;
	toolName: string;
}) {
	const resolved = (category ?? "generic") as ToolCategory;
	const Icon = categoryIcon(resolved, toolName);
	return (
		// Same `data-trace-row-chip` marker a folded trace row's chip carries — the two
		// rows are one shape, so a parity test must be able to find both the same way.
		// Shared CategoryChip: ThemeIcon light + CATEGORY_COLOR, identical to the card header.
		<CategoryChip
			data-trace-row-chip
			size={TRACE_ROW_ICON}
			color={CATEGORY_COLOR[resolved] ?? "gray"}
			data-testid="subagent-activity-category-chip"
		>
			<Icon size={TRACE_ROW_GLYPH_SIZE} />
		</CategoryChip>
	);
}

/**
 * One recent-call row's timing slot.
 *
 * Absent when the measure layer carried no timing for that row (a header that
 * arrived without a `timing` payload), so an activity row without stamps looks
 * exactly as it does today.
 */
function RecentCallTiming({
	timing,
	labels,
}: {
	timing: MeasuredSubagent["recentCallTimings"][number] | undefined;
	labels?: ToolTimingLabels;
}) {
	if (!timing) return null;
	return (
		<ToolTimingArea
			running={!isTerminalToolRowStatus(timing.status)}
			startedAt={timing.startedAt ?? timing.createdAt}
			durationMs={timing.durationMs}
			timing={timing}
			labels={labels}
		/>
	);
}

/** Render a SubagentCard from its MeasuredSubagent. */
/**
 * Narrow model badge: the model actually running, with an icon for how it was
 * chosen. The reason for a pool fallback lives in the tooltip, not the badge,
 * so the fixed badge row does not grow.
 */
function SubagentModelBadge({
	model,
	inheritance,
	labels,
}: {
	model: string;
	inheritance?: SubagentModelInheritance;
	labels: Required<Omit<SubagentLabels, "timing" | "statusMark">>;
}) {
	if (model !== FOLLOW_PARENT_MODEL || !inheritance) {
		return (
			<Badge data-testid="subagent-model" size="xs" variant="light" color="violet">
				{model === FOLLOW_PARENT_MODEL ? labels.followParent : model}
			</Badge>
		);
	}
	const fallback = inheritance.source === "pool-fallback";
	const tooltip = fallback
		? labels.fallbackReason
				.replace("{parentModel}", inheritance.parentModel)
				.replace("{pool}", inheritance.poolKey ?? "general")
		: labels.followTooltip;
	const Icon = fallback ? IconAlertTriangle : IconLink;
	return (
		<Tooltip label={tooltip} withinPortal>
			<Badge
				data-testid="subagent-model"
				data-inheritance={inheritance.source}
				size="xs"
				variant="light"
				color={fallback ? "yellow" : "violet"}
				leftSection={<Icon size={10} aria-hidden />}
				aria-label={`${inheritance.model} — ${tooltip}`}
			>
				{inheritance.model}
			</Badge>
		</Tooltip>
	);
}

export function RenderSubagent(props: RenderSubagentProps) {
	const { measured, permissionSlot } = props;
	const labels = {
		...DEFAULT_LABELS,
		...props.labels,
		// 档位文案是唯一一个**对象**型 label，浅合并会被部分对象整个替换掉：缺的
		// 那几档变成 undefined，badge 静默消失（看起来像"这不是编排 worker"）。
		// 这一处单独深合并，缺档仍有英文兜底。
		workerTier: { ...DEFAULT_LABELS.workerTier, ...props.labels?.workerTier },
	};
	const inner = <SubagentInner {...props} labels={labels} />;
	const hasPermission = permissionSlot !== undefined;

	// A live permission form is a relative-flow block appended below the absolutely
	// positioned card content, pushed down by the card's arithmetic height. It
	// grows the card naturally; the shell measures the resulting row height and
	// corrects geometry (onUnknownHeight), so the fixed-height/clip model is
	// dropped only while a permission is pending.
	const permissionRegion = hasPermission ? (
		<div style={{ position: "relative", padding: "0 var(--mantine-spacing-xs)" }}>
			{permissionSlot}
		</div>
	) : null;

	// inRun (borderHeight 0) → no frame; else wrap in a bordered Paper.
	if (measured.borderHeight === 0) {
		return (
			<div
				style={
					hasPermission
						? { position: "relative" }
						: { position: "relative", height: measured.height }
				}
			>
				<div style={{ position: "relative", height: measured.height }}>{inner}</div>
				{permissionRegion}
			</div>
		);
	}
	return (
		<Paper
			withBorder
			radius="sm"
			style={{
				overflow: hasPermission ? "visible" : "hidden",
				...(hasPermission ? { minHeight: measured.height } : { height: measured.height }),
				boxSizing: "border-box",
				borderColor:
					hasPermission || measured.selfPermissionBlockHeight > 0 || measured.pendingBlockHeight > 0
						? cssColor("yellow", 6)
						: undefined,
			}}
		>
			<div style={{ position: "relative", height: measured.height - measured.borderHeight }}>
				{inner}
			</div>
			{permissionRegion}
		</Paper>
	);
}

/**
 * 模型 badge。默认是所有子代理都有的只读标签；当这张卡片是编排 worker（执行者/
 * 复核者）且它的 turn 正停在模型不可用 / 配额的等待上时，它变成换模型入口。
 *
 * 为什么挂在 badge 上而不是再加一个按钮：等待中的卡片唯一"有话要说"的地方就是它
 * 停在哪个模型上——用户要换的也正是那个东西。多一个按钮只会让这条固定高度的
 * header 行变宽，而这里一个字都不用多占。
 *
 * badge 用 `component="button"` 而不是包一层 ActionIcon：它本来就是 header 行里的
 * 一个固定高度元素，换标签只会让这一行多一个可聚焦节点，行高不变（测量层按
 * badge 行整体测量）。点击必须 `stopPropagation`——badge 位于折叠整张卡的 header
 * 里，不拦的话"换模型"会顺手把卡片收起来。
 */
function ModelBadge({
	model,
	wait,
	onSwitch,
	labels,
}: {
	model: string;
	wait: { waitKind?: "credentials" | "quota"; model?: string; resumeAt?: number } | null;
	onSwitch?: () => void;
	labels: ResolvedSubagentLabels;
}) {
	const switchable = wait !== null && onSwitch !== undefined;
	const text = wait
		? labels.waitingModel
		: model === FOLLOW_PARENT_MODEL
			? labels.followParent
			: model;
	if (!switchable) {
		return (
			<Badge
				data-testid="subagent-model"
				data-waiting={wait ? "1" : undefined}
				size="xs"
				variant="light"
				color={wait ? "orange" : "violet"}
			>
				{wait ? `${text} · ${model}` : text}
			</Badge>
		);
	}
	return (
		<Tooltip label={labels.switchWorkerModelTooltip} withArrow>
			<Badge
				component="button"
				type="button"
				data-testid="subagent-model"
				data-waiting="1"
				data-switchable="1"
				size="xs"
				variant="filled"
				color="orange"
				style={{ cursor: "pointer" }}
				onClick={(event: React.MouseEvent) => {
					event.stopPropagation();
					onSwitch?.();
				}}
			>
				{`${text} · ${model}`}
			</Badge>
		</Tooltip>
	);
}

/**
 * 编排 worker 的档位 badge（chore/quick/medium/heavy）。
 *
 * 只读、不可点，也不带 tooltip：档位是这次派发的既定事实，卡片上没有可以改变它的
 * 操作（换模型入口在模型 badge 上，而它换的是模型、不是档位）。
 *
 * 未识别的档位值返回 null：宁可不显示，也不显示一个看起来同样权威的错档位。
 */
function TierBadge({ tier, labels }: { tier: string; labels: ResolvedSubagentLabels }) {
	const text = labels.workerTier?.[tier as OrchestrationWorkerTier];
	if (!text) return null;
	return (
		<Badge data-testid="subagent-worker-tier" size="xs" variant="light" color="indigo">
			{text}
		</Badge>
	);
}

function SubagentInner({
	measured,
	description,
	agentType = "agent",
	isBackground,
	isTakenOver,
	model,
	modelInheritance,
	workerTier,
	workerKind,
	modelWait,
	onSwitchWorkerModel,
	reasoningEffort,
	resultPreview,
	recentCallNames = [],
	fileChanges,
	isActive,
	status,
	labels,
	onToggle,
	onTogglePrompt,
	onToggleFileChanges,
	onOpenSession,
	onResolveOverride,
	viewTargets,
	viewControls,
}: RenderSubagentProps & { labels: ResolvedSubagentLabels }) {
	const active = isActive === true;
	// Agent-type badge colour (mirrors SubagentCard.tsx agentBadgeColor).
	const agentBadgeColor = ["explore", "plan", "general", "agent", "send"].includes(agentType)
		? "indigo"
		: "teal";
	// 类型 chip 上究竟画什么字。
	//
	// 判定只认 `workerTier`：`tier` 参数只存在于编排上下文的 schema 里（非编排上下文
	// 里连 schema 都不带它，见 task.ts 的 `buildParameters`），所以"有档位"就等于
	// "这是一次编排派发"——非编排子代理因此一个字节都不会变。
	//
	// 角色只认 `workerKind`（类型编码是唯一权威来源）：拿不到编码时按执行者显示，
	// 那正是执行者的实际情况（编排派发里 `subagent_type` 刻意留空）。
	//
	// `agentType` 本身**不动**：它同时是"换模型继续"的资格判定依据
	// （`parseOrchestrationWorkerType`）与复核者识别依据，这里只是换一个标签。
	//
	// 高度中性：只替换这枚既有 badge 的文字，badge 行内元素个数不变，而 badge 行是
	// 固定高度的 Group、测量层从不读标签文本（见 measure-subagent 的 `headerHeight`）。
	const identityLabel = workerTier
		? workerKind === "reviewer"
			? labels.workerReviewer
			: labels.workerExecutor
		: agentType;
	let top = 0;

	// ── Header ──────────────────────────────────────────────────────────────
	const header = (
		// Visual copy: the header is a click-to-toggle region (like RenderReasoning's
		// Group onClick). The live keyboard/ARIA affordances live in SubagentCard.tsx
		// outside vlist/. A Mantine Box (not a raw div) keeps the interactive handler
		// off a static host element and avoids invalid nested-interactive HTML when
		// the expanded description renders markdown links.
		<Box
			key="header"
			// A modified click selects the block; only a plain click toggles the card.
			onClick={onToggle ? swallowSelectionClick(onToggle) : undefined}
			style={{
				position: "absolute",
				top,
				left: 0,
				right: 0,
				height: measured.headerHeight,
				padding: CARD_PADDING,
				boxSizing: "border-box",
				cursor: "pointer",
			}}
		>
			<Group gap={5} wrap="nowrap" style={{ height: badgeRowHeight() }}>
				<ThemeIcon size={THEME_ICON_SIZE} variant="light" color={agentBadgeColor} radius="sm">
					<IconRobot size={10} />
				</ThemeIcon>
				<Badge data-testid="subagent-agent-type" size="xs" variant="light" color={agentBadgeColor}>
					{identityLabel}
				</Badge>
				{isBackground ? (
					<Badge size="xs" variant="light" color="blue">
						{labels.backgroundBadge}
					</Badge>
				) : null}
				{/* Grape matches the `taken_over` narrator substatus colour in
				    status-registry.ts, so the same state reads the same way on the card
				    and in the narrator list. */}
				{isTakenOver ? (
					<Badge data-testid="subagent-taken-over" size="xs" variant="light" color="grape">
						{labels.takenOverBadge}
					</Badge>
				) : null}
				{workerTier ? (
					// 档位 badge 紧贴模型 badge：两者合起来正好回答"本轮用了哪个档位、
					// 哪个模型"。识别不出的档位值不画（见 `workerTier` 的文档）。
					<TierBadge tier={workerTier} labels={labels} />
				) : null}
				{model ? (
					workerTier || modelWait || onSwitchWorkerModel ? (
						<ModelBadge
							model={model}
							wait={modelWait ?? null}
							onSwitch={onSwitchWorkerModel}
							labels={labels}
						/>
					) : (
						<SubagentModelBadge model={model} inheritance={modelInheritance} labels={labels} />
					)
				) : null}
				{reasoningEffort ? (
					<Badge data-testid="subagent-reasoning-effort" size="xs" variant="light" color="cyan">
						{reasoningEffort}
					</Badge>
				) : null}
				<Box style={{ flex: 1, minWidth: 0 }} />
				{active ? (
					<Loader size={STATUS_ICON_SIZE} color="blue" />
				) : (
					<SubagentStatusGlyph status={status} />
				)}
				{/* Header timing (SubagentCard.tsx:623 parity): elapsed while the child is
				    still working, else its total duration, with the lifecycle breakdown in
				    a portaled popover. Shares the fixed badge row → height-neutral. */}
				<ToolTimingArea
					running={active}
					startedAt={measured.timing.startedAt ?? measured.timing.createdAt}
					durationMs={measured.timing.durationMs}
					timing={measured.timing}
					labels={labels.timing}
				/>
				{measured.effectiveExpanded ? (
					<IconChevronDown size={CHEVRON_SIZE} />
				) : (
					<IconChevronRight size={CHEVRON_SIZE} />
				)}
			</Group>

			{/* Description: expanded → wrapped markdown-like inline; collapsed → truncate. */}
			<div
				style={{
					marginTop: DESC_MARGIN_TOP,
					marginLeft: DESC_LEFT,
					height: measured.descriptionHeight,
				}}
			>
				{measured.effectiveExpanded && measured.descriptionMeasured ? (
					<RenderMarkdown measured={measured.descriptionMeasured} />
				) : (
					<Text size="xs" c="dimmed" truncate>
						{description}
					</Text>
				)}
			</div>

			{measured.hasResultPreview ? (
				<Text size="xs" c="dimmed" mt={2} ml={DESC_LEFT} truncate opacity={0.7}>
					→ {resultPreview}
				</Text>
			) : null}
		</Box>
	);
	top += measured.headerHeight;

	// ── Recent calls ──────────────────────────────────────────────────────────
	let recentCalls: React.ReactNode = null;
	if (measured.recentCallsHeight > 0) {
		const rows = recentCallNames.slice(0, measured.recentRowCount);
		// Resolved once per row, ahead of the map: the mark decides BOTH whether the
		// 12px slot exists and which glyph fills it, and two separate evaluations of
		// that question are how a slot ends up reserved around nothing.
		const statusMarks = rows.map((_name, i) =>
			resolveToolRowStatusMark(measured.recentCallTimings[i]?.status),
		);
		recentCalls = (
			<div
				key="recent"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.recentCallsHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Group justify="space-between" mb={RECENT_TITLE_MARGIN_BOTTOM} wrap="nowrap">
					<Text size="xs" c="dimmed" fw={500}>
						{labels.recentCalls}
					</Text>
					{measured.hasRecentCallsButton ? (
						<Button
							size="compact-xs"
							variant="subtle"
							onClick={(e) => {
								e.stopPropagation();
								onOpenSession?.();
							}}
						>
							{labels.openSession}
						</Button>
					) : null}
				</Group>
				<div style={{ display: "flex", flexDirection: "column", gap: RECENT_STACK_GAP }}>
					{rows.map((name, i) => (
						// A TRACE ROW, not a tinted button: dot + category chip + one
						// `Tool · summary` line + status + timing, at the trace row's own height
						// (RECENT_ROW_HEIGHT === TRACE_ROW_HEIGHT). Still a button, because
						// clicking opens the child session — disabled (plain surface) when no
						// child is known, so the affordance never no-ops. Fixed height either
						// way, so the measured geometry is unaffected.
						<UnstyledButton
							// biome-ignore lint/suspicious/noArrayIndexKey: recent rows are a stable ordered slice
							key={i}
							data-testid="subagent-activity"
							disabled={!onOpenSession}
							onClick={
								onOpenSession
									? (e) => {
											e.stopPropagation();
											onOpenSession();
										}
									: undefined
							}
							style={{
								display: "block",
								width: "100%",
								height: bareRowMetrics().height,
								boxSizing: "border-box",
								cursor: onOpenSession ? "pointer" : "default",
							}}
						>
							<Group gap={TRACE_ROW_GAP} wrap="nowrap" h="100%" align="center">
								{/* Dot, not a chevron: an activity row has nothing to expand. */}
								<Box style={TRACE_CHEVRON_SLOT_STYLE}>
									<Text span size="xs" c="dimmed" style={DOT_STYLE}>
										•
									</Text>
								</Box>
								<RecentCallCategoryChip
									category={measured.recentCallCategories[i]}
									toolName={name}
								/>
								{/* `flex: 0 1 auto` (not `flex: 1`) keeps the status + duration HUGGING
								    this label rather than pinned to the row's right edge — see the
								    trace row, whose layout this mirrors. */}
								<Text
									data-testid="subagent-activity-label"
									size="xs"
									c="dimmed"
									truncate
									style={{ flex: "0 1 auto", minWidth: 0 }}
								>
									{(() => {
										const label = recentCallTitle(name, measured.recentCallSummaries[i] ?? null);
										return (
											<>
												{/* Flat gap, not a space character — see the trace row's TraceRowTitle. */}
												<span
													style={{
														fontWeight: 600,
														...(label.detail ? { marginRight: HEADER_CELL_GAP } : {}),
													}}
												>
													{label.name}
												</span>
												{label.detail || null}
											</>
										);
									})()}
								</Text>
								{/* Only DEVIATION is marked (in flight / queued / awaiting / failed /
								    cancelled); a successful call draws nothing, so the slot is absent
								    rather than blank — see @shared/tool-row-status.

								    No context is passed: this projection
								    (`SubagentToolCallHeader`) carries no upstream-queue verdict and no
								    gate status, so a queued child call still reads as in flight here.
								    `pending` is nonetheless corrected by the shared rule, which is the
								    case these rows actually hit. */}
								{statusMarks[i] ? (
									<Box data-testid="trace-row-status-slot" style={TRACE_ROW_STATUS_SLOT_STYLE}>
										<TraceRowStatusGlyph
											mark={statusMarks[i] as ToolRowStatusMark}
											labels={labels.statusMark}
										/>
									</Box>
								) : null}
								{/* Per-row timing (SubagentCard.tsx:684 parity). `recentCallTimings`
								    is sliced to the drawn rows by the measure layer, so index i
								    pairs with this row's name. */}
								<RecentCallTiming timing={measured.recentCallTimings[i]} labels={labels.timing} />
								{/* Absorbs the slack so the cells above stay left-packed. */}
								<Box style={{ flex: 1, minWidth: 0 }} />
							</Group>
						</UnstyledButton>
					))}
				</div>
			</div>
		);
		top += measured.recentCallsHeight;
	}

	// ── LazyCollapse body ───────────────────────────────────────────────────────
	let body: React.ReactNode = null;
	if (measured.effectiveExpanded && measured.expandedHeight > 0) {
		body = (
			<div
				key="body"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.expandedHeight,
				}}
			>
				<SubagentBody
					measured={measured}
					labels={labels}
					fileChanges={fileChanges}
					onTogglePrompt={onTogglePrompt}
					onToggleFileChanges={onToggleFileChanges}
					onResolveOverride={onResolveOverride}
					viewTargets={viewTargets}
					viewControls={viewControls}
				/>
			</div>
		);
		top += measured.expandedHeight;
	}

	// ── Divider (inRun && !isLast) ───────────────────────────────────────────────
	const divider =
		measured.dividerHeight > 0 ? (
			<div
				key="divider"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.dividerHeight,
					background: "var(--mantine-color-default-border)",
				}}
			/>
		) : null;

	return (
		<>
			{header}
			{recentCalls}
			{body}
			{divider}
		</>
	);
}

// ── expanded body: stacks the sub-blocks at their measured heights ───────────
function SubagentBody({
	measured,
	labels,
	fileChanges,
	onTogglePrompt,
	onToggleFileChanges,
	onResolveOverride,
	viewTargets,
	viewControls,
}: {
	measured: MeasuredSubagent;
	labels: ResolvedSubagentLabels;
	fileChanges?: SubagentFileChangesData;
	onTogglePrompt?: () => void;
	onToggleFileChanges?: () => void;
	onResolveOverride?: () => void;
	/** The card's viewer bodies (prompt / result) + the shell's view controls. */
	viewTargets?: readonly VListViewTarget[];
	viewControls?: VListViewControls;
}) {
	let top = 0;
	const parts: React.ReactNode[] = [];
	const promptTarget = measured.promptMeasured
		? findViewTarget(viewTargets, measured.promptMeasured.model.source)
		: undefined;
	const resultTarget = measured.resultMeasured
		? findViewTarget(viewTargets, measured.resultMeasured.model.source)
		: undefined;

	// selfPermission (Box mx="xs" mb="xs" + InlinePermission).
	if (measured.selfPermissionBlockHeight > 0 && measured.selfPermissionMeasured) {
		parts.push(
			<div
				key="self-perm"
				style={{
					position: "absolute",
					top,
					left: SELF_PERMISSION_MARGIN_X,
					right: SELF_PERMISSION_MARGIN_X,
					height: measured.selfPermissionBlockHeight,
				}}
			>
				<RenderInlinePermission
					measured={measured.selfPermissionMeasured}
					includeTopMargin={false}
				/>
			</div>,
		);
		top += measured.selfPermissionBlockHeight;
	}

	// prompt (toggle row + optional ContentViewer body).
	if (measured.promptBlockHeight > 0) {
		const promptOpen = measured.promptMeasured != null;
		parts.push(
			<div
				key="prompt"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.promptBlockHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Group
					data-testid="subagent-prompt-toggle"
					gap={4}
					wrap="nowrap"
					style={{ height: PROMPT_TOGGLE_ROW_HEIGHT, cursor: "pointer" }}
					// A modified click selects the block; only a plain click toggles the prompt.
					onClick={onTogglePrompt ? swallowSelectionClick(onTogglePrompt) : undefined}
				>
					{promptOpen ? (
						<IconChevronDown size={CHEVRON_SIZE} />
					) : (
						<IconChevronRight size={CHEVRON_SIZE} />
					)}
					<Text size="xs" c="dimmed" fw={500}>
						{labels.prompt}
					</Text>
				</Group>
				{promptOpen && measured.promptMeasured ? (
					<div style={{ marginTop: PROMPT_BODY_MARGIN_TOP }}>
						<RenderToolBody
							measured={measured.promptMeasured}
							viewTarget={promptTarget}
							viewControls={viewControls}
						/>
					</div>
				) : null}
			</div>,
		);
		top += measured.promptBlockHeight;
	}

	// pendingPermissions (title + placeholder cards — P10 dependency).
	if (measured.pendingBlockHeight > 0) {
		parts.push(
			<div
				key="pending"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.pendingBlockHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Text size="xs" c="yellow" fw={500} mb={4}>
					{labels.pendingTitle}
				</Text>
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
					{Array.from({ length: measured.pendingCardCount }).map((_, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: pending cards are a stable ordered list
							key={i}
							style={{
								border: `${PENDING_CARD_BORDER}px solid ${cssColor("yellow", 6)}`,
								borderRadius: 4,
								minHeight: typographyMetrics().line.xs,
							}}
						/>
					))}
				</div>
			</div>,
		);
		top += measured.pendingBlockHeight;
	}

	// resolveOverride button.
	if (measured.resolveOverrideHeight > 0) {
		parts.push(
			<div
				key="resolve"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.resolveOverrideHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Button
					size="compact-xs"
					variant="light"
					color="yellow"
					onClick={(e) => {
						e.stopPropagation();
						onResolveOverride?.();
					}}
				>
					{labels.resolveOverride}
				</Button>
			</div>,
		);
		top += measured.resolveOverrideHeight;
	}

	// File changes: what the child wrote to disk. Rows reuse the recent-call geometry
	// (one truncating xs mono line each), so the measured height is row count × line.
	if (measured.fileChangesHeight > 0 && fileChanges) {
		const fileDisplays = subagentFilePathDisplays(fileChanges.files, labels);
		const rows = fileChanges.files.slice(0, measured.fileChangeRowCount);
		const hidden = Math.max(0, fileChanges.totalFiles - rows.length);
		const canToggle = fileChanges.files.length > FILE_CHANGE_MAX_ROWS && !!onToggleFileChanges;
		const summary = overflowSummary(
			fileChanges,
			hidden,
			rows.length > FILE_CHANGE_MAX_ROWS,
			labels,
		);
		const scopeKey = subagentFileChangeScopeKey(fileChanges);
		const rowStyle = {
			height: measured.fileChangeRowHeight,
			lineHeight: `${measured.fileChangeRowHeight}px`,
		};
		const scopeDescription = fileChanges.scope
			? `${labels.fileChangeWindow} · ${JSON.stringify(fileChanges.scope)}`
			: "";
		parts.push(
			<div
				key={`file-changes:${scopeKey}`}
				data-testid="subagent-file-changes"
				data-file-change-scope={scopeKey}
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.fileChangesHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<Text size="xs" c="dimmed" fw={500} truncate style={rowStyle}>
					{labels.fileChanges} · {fileChanges.totalFiles}
				</Text>
				{measured.fileChangeNoticeRowCount > 0 ? (
					<Text
						data-testid="subagent-file-changes-legacy"
						size="xs"
						c="yellow"
						truncate
						style={rowStyle}
						title={labels.fileChangeLegacy}
					>
						{labels.fileChangeLegacy}
					</Text>
				) : null}
				{measured.fileChangeNoticeRowCount > 1 ? (
					<Text
						data-testid="subagent-file-changes-window"
						size="xs"
						c="dimmed"
						truncate
						style={rowStyle}
						title={scopeDescription}
					>
						{scopeDescription}
					</Text>
				) : null}
				<div style={{ display: "flex", flexDirection: "column", gap: FILE_CHANGE_STACK_GAP }}>
					{rows.map((file, index) => (
						<Group
							key={subagentFileChangeIdentityKey(file)}
							data-testid="subagent-file-change"
							data-file-identity={subagentFileChangeIdentityKey(file)}
							title={fileDisplays[index].title}
							gap={6}
							wrap="nowrap"
							style={{ ...rowStyle, overflow: "hidden" }}
						>
							{fileDisplays[index].location ? (
								<Text
									data-testid="subagent-file-location"
									size="xs"
									c="dimmed"
									truncate
									ff="monospace"
									style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "40%" }}
									title={fileDisplays[index].title}
								>
									{fileDisplays[index].location}
								</Text>
							) : null}
							<Text
								data-testid="subagent-file-path"
								size="xs"
								c="dimmed"
								truncate
								ff="monospace"
								style={{ flex: "0 1 auto", minWidth: 0 }}
								title={fileDisplays[index].title}
							>
								{fileDisplays[index].path}
							</Text>
							{/* Same green/red plain text the tool cards use, so one file reads
						    identically wherever it appears. */}
							<DiffStatsText
								stats={
									file.linesAdded == null || file.linesRemoved == null
										? null
										: { added: file.linesAdded, removed: file.linesRemoved }
								}
							/>
							{/* The churn qualifier: without it `+42 -3` reads as "this file is now
						    42 lines longer", which these figures do not measure. */}
							{file.editCount > 1 ? (
								<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
									· {withCount(labels.fileEdits, file.editCount)}
								</Text>
							) : null}
							{file.linesAdded == null ||
							file.linesRemoved == null ||
							(file.unmeasuredCount ?? 0) > 0 ? (
								<Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.7 }}>
									{labels.linesNotMeasured}
								</Text>
							) : null}
							{/* Location is not undo authority. null/missing must never read as inside. */}
							{file.outsideParentWorkspace === true ? (
								<Text size="xs" c="yellow" style={{ flexShrink: 0 }} title={file.filePath}>
									· {labels.outsideWorkspace}
								</Text>
							) : null}
							{file.outsideParentWorkspace == null || !file.deviceId || !file.workspacePath ? (
								<Text
									data-testid="subagent-file-coverage-unknown"
									size="xs"
									c="yellow"
									truncate
									style={{ flex: "0 1 auto", minWidth: 0 }}
									title={labels.unknownCoverage}
								>
									· {labels.unknownCoverage}
								</Text>
							) : null}
						</Group>
					))}
				</div>
				{measured.hasFileChangeOverflowRow ? (
					<UnstyledButton
						data-testid="subagent-file-changes-overflow"
						disabled={!canToggle}
						aria-expanded={canToggle ? rows.length > FILE_CHANGE_MAX_ROWS : undefined}
						onClick={(e: React.MouseEvent) => {
							e.stopPropagation();
							onToggleFileChanges?.();
						}}
						style={{
							...rowStyle,
							display: "block",
							width: "100%",
							cursor: canToggle ? "pointer" : "default",
						}}
					>
						<Text size="xs" c="dimmed" truncate style={rowStyle} title={summary}>
							{summary}
						</Text>
					</UnstyledButton>
				) : null}
			</div>,
		);
		top += measured.fileChangesHeight;
	}

	// resultText (ContentViewer maxHeight:300 markdown).
	// Background launch protocol text is suppressed at measure time (hasBackgroundNotice);
	// no notice row is drawn in its place.
	if (measured.resultBlockHeight > 0 && measured.resultMeasured) {
		parts.push(
			<div
				key="result"
				style={{
					position: "absolute",
					top,
					left: 0,
					right: 0,
					height: measured.resultBlockHeight,
					paddingLeft: BLOCK_PADDING_X,
					paddingRight: BLOCK_PADDING_X,
					paddingBottom: BLOCK_PADDING_X,
					boxSizing: "border-box",
				}}
			>
				<RenderToolBody
					measured={measured.resultMeasured}
					viewTarget={resultTarget}
					viewControls={viewControls}
				/>
			</div>,
		);
		top += measured.resultBlockHeight;
	}

	return <>{parts}</>;
}
