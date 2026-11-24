"use client";

/**
 * RoundRailMobile.tsx — 窄屏下的轮次导航：滚动口右下角浮动胶囊（`当前轮/总轮数`），
 * 点按弹出底部抽屉，里面是可以滚动的轮次卡片列表，点哪张跳哪轮。
 *
 * 为什么不是桌面那排横条：16px 的 gutter 在手机上太细，指头点不准 tick；
 * 而且窄屏里 hover 卡根本不存在（触摸没有悬停），轨道失去了唯一的「先看清再跳」
 * 手段。抽屉列表把每张卡片放大成一整行——预览、时间、耗时、收藏都在——
 * 这与桌面悬停卡是同一信息密度，只是入口从「划过」换成「点开」。
 *
 * 定位：跟桌面轨道同一招——零高度 + `position: sticky`，只不过它钉的是
 * **底部**（`bottom` 而不是 `top`）。元素放在滚动内容末尾，`bottom` 约束让它
 * 在整段文档里始终浮在滚动口下缘；滚到文档末尾时它就地归位。悬浮胶囊压在
 * 「滚到底部」按钮上方，两者垂直错开。
 */

import { Drawer, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { NarratorRound } from "@shared/narrator-rounds";
import { IconTimeline } from "@tabler/icons-react";
import * as React from "react";
import { useMobileDrawerHistory } from "../../../../hooks/useMobileDrawerHistory";
import { RoundCard, type RoundRailLabels } from "./RoundRail";

export function RoundRailMobile({
	rounds,
	activeIndex,
	onJumpToRound,
	favorites,
	onToggleFavorite,
	labels,
}: {
	rounds: readonly NarratorRound[];
	activeIndex: number;
	onJumpToRound: (round: NarratorRound) => void;
	favorites: ReadonlySet<number>;
	onToggleFavorite?: (seq: number) => void;
	labels: RoundRailLabels;
}) {
	const [open, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);
	const listRef = React.useRef<HTMLDivElement>(null);
	useMobileDrawerHistory(open, closeDrawer);

	// 打开时把当前轮滚到列表中央，否则每次都要从头滑。
	React.useEffect(() => {
		if (!open) return;
		const list = listRef.current;
		if (!list) return;
		const active = list.querySelector<HTMLElement>("[data-round-card-active='1']");
		active?.scrollIntoView({ block: "center" });
	}, [open]);

	const jumpTo = (round: NarratorRound | undefined) => {
		if (!round) return;
		closeDrawer();
		onJumpToRound(round);
	};

	return (
		<>
			{/* 零高度 sticky：不往文档里加布局，滚口下缘上方悬浮。`float: right`
			    与桌面轨道 `float: left` 对称；内部 capsule 才是实体。 */}
			<div
				data-nf-round-rail-mobile=""
				data-nf-round-count={rounds.length}
				style={{
					position: "sticky",
					bottom: 12,
					float: "right",
					marginRight: 8,
					width: 0,
					height: 0,
					overflow: "visible",
					zIndex: 30,
					pointerEvents: "auto",
				}}
			>
				<button
					type="button"
					aria-label={labels.rail}
					title={labels.railTitle(rounds.length)}
					onClick={openDrawer}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "6px 10px",
						// 宿主是右缘锚点的零宽盒子：(-100%,-100%) 让胶囊右下角恰好落在
						// 锚点上（右缘内缩见 marginRight、下缘上抬见宿主 bottom）。
						transform: "translate(-100%, -100%)",
						borderRadius: 999,
						background: "var(--mantine-color-body)",
						border: "1px solid var(--mantine-color-default-border)",
						boxShadow: "0 4px 14px rgba(0, 0, 0, 0.35)",
						color: "var(--mantine-color-text)",
						fontSize: "var(--mantine-font-size-sm)",
						fontWeight: 600,
						cursor: "pointer",
						whiteSpace: "nowrap",
					}}
				>
					<IconTimeline size={14} style={{ flexShrink: 0 }} />
					<span aria-hidden="true">
						{activeIndex >= 0 ? `${activeIndex + 1}/${rounds.length}` : rounds.length}
					</span>
				</button>
			</div>

			<Drawer
				opened={open}
				onClose={closeDrawer}
				position="bottom"
				size="62%"
				title={
					<Text size="sm" fw={600} truncate>
						{labels.railTitle(rounds.length)}
					</Text>
				}
				closeButtonProps={{ size: "sm" }}
				data-testid="round-rail-mobile-drawer"
			>
				<div
					ref={listRef}
					style={{
						display: "grid",
						gridTemplateColumns: "minmax(0, 1fr)",
						gap: 4,
						padding: 4,
					}}
				>
					{rounds.map((round, index) => (
						<div key={round.seq} data-round-card-active={index === activeIndex ? "1" : undefined}>
							<button
								type="button"
								onClick={() => jumpTo(round)}
								style={{
									display: "block",
									width: "100%",
									padding: 0,
									border: "none",
									background: "transparent",
									textAlign: "left",
									cursor: "pointer",
								}}
							>
								<RoundCard
									round={round}
									active={index === activeIndex}
									ordinal={index + 1}
									total={rounds.length}
									favorited={favorites.has(round.seq)}
									onToggleFavorite={onToggleFavorite}
									labels={labels}
								/>
							</button>
						</div>
					))}
				</div>
			</Drawer>
		</>
	);
}
