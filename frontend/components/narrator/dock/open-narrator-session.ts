/**
 * open-narrator-session.ts — 「打开某个叙述者的会话」这件事的**唯一**实现。
 *
 * 有三处界面想让用户"点进去看某个子会话"：后台任务里的 agent 行、编排面板里的
 * 代理行，以及将来任何一张列出子会话的清单。它们此前各写一份"先试 dock、不行就
 * navigate"，两份逻辑迟早会漂移（一边改了回落策略、另一边没改），而漂移的代价是
 * **点了没反应**——看起来可点、实际上什么也没发生，正是最难排查的那种。
 *
 * 规则是**界面内优先，路由兜底**：
 *
 *   - 有 dock（`openSubagentPanel` 存在）→ 在对话旁边开一个会话面板。
 *     子会话是"看一眼就回来"的东西，离开当前页面会丢掉正在进行的那段对话
 *     （滚动位置、草稿、以及让人想点它的那个上下文）；
 *   - 没有 dock → 路由到 `/narrators/$narratorId`。这是窄屏页面与分离出来的画布
 *     面板：它们没有第二块区域可以放面板。
 *
 * 判据是 **bridge 是否存在**，而不是 `dock` 是否存在：一块被拖到故事网络画布上的
 * 工具面板**有** dock 上下文（所以 `dock?.` 不是 undefined），但它的源节点折叠时
 * 没有第二块区域，bridge 缺席。用 `dock?.openSubagentPanel(...)` 会"看起来成功了"
 * 却什么也没做，比直说没有更糟。
 *
 * 拆出纯函数（{@link planNarratorSessionOpen} / {@link openNarratorSession}）是为了
 * 两件事分别可断言：去哪儿（dock / 路由 / 无处可去），以及真的把正确的 narratorId
 * 交给了哪一个宿主。
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useNarratorDockContext } from "./NarratorDockContext";

/** 一次打开动作的目标：能开到哪儿，以及落到哪个会话。 */
export type NarratorSessionOpenPlan =
	| { mode: "dock"; targetNarratorId: string }
	| { mode: "route"; targetNarratorId: string }
	| { mode: "none" };

export interface NarratorSessionOpenInputs {
	/** 要打开的会话；拿不到时没有可去的地方。 */
	targetNarratorId: string | null | undefined;
	/** 周围界面能否在对话旁边再摆一个会话面板（dock 的 bridge 是否存在）。 */
	canOpenInDock: boolean;
}

/**
 * 决定怎么打开一个会话。
 *
 * id 为空时给 `"none"` 而不是"路由到一个空 id"：那会把用户送到一张坏页面上，
 * 而一张点不动的行至少是诚实的。前端的字段虽然有类型，但运行时数据来自网络，
 * 不在这里兜一次就等于把"点了没反应"换成"跳到坏页面"。
 */
export function planNarratorSessionOpen(
	inputs: NarratorSessionOpenInputs,
): NarratorSessionOpenPlan {
	const targetNarratorId = inputs.targetNarratorId?.trim();
	if (!targetNarratorId) return { mode: "none" };
	return inputs.canOpenInDock
		? { mode: "dock", targetNarratorId }
		: { mode: "route", targetNarratorId };
}

/** 真正的执行：把计划交给对应的宿主。依赖以参数注入，因此可以直接用调用桩断言。 */
export interface NarratorSessionOpenPerformers {
	/** dock 的 `openSubagentPanel`；缺席表示这个界面没有第二块区域。 */
	openInDock: ((targetNarratorId: string) => void) | null | undefined;
	/** 路由兜底（`/narrators/$narratorId`），由调用方注入而不是在这里 import 路由。 */
	navigateToNarrator: (targetNarratorId: string) => void;
}

/**
 * 打开一个会话，返回**是否真的打开了**。
 *
 * 返回值不是装饰：调用方可以据此区分"点了有作用"与"点了什么也没发生"，而后者
 * 正是这条路径最容易出的问题。
 */
export function openNarratorSession(
	inputs: NarratorSessionOpenInputs,
	performers: NarratorSessionOpenPerformers,
): boolean {
	const plan = planNarratorSessionOpen(inputs);
	if (plan.mode === "none") return false;
	if (plan.mode === "dock") {
		// bridge 是判据，因此这里不可能落到"计划说走 dock、实际没有 bridge"：
		// `canOpenInDock` 就来自 `!!openInDock`。仍然挡一层，避免将来有人传入
		// 不一致的两个参数时静默什么也不做。
		if (!performers.openInDock) return false;
		performers.openInDock(plan.targetNarratorId);
		return true;
	}
	performers.navigateToNarrator(plan.targetNarratorId);
	return true;
}

/**
 * 组件里用的版本：自动接上 dock 上下文与路由。
 *
 * 两个依赖都在**渲染时**读取（而不是在某处缓存一次）：dock 上下文在面板被拖出来
 * 之后会变（bridge 消失），缓存会让"先在 dock 里、后来被拆出去"的面板一直走旧路径。
 */
export function useOpenNarratorSession(): (targetNarratorId: string | null | undefined) => boolean {
	const navigate = useNavigate();
	const dock = useNarratorDockContext();
	// 只取 bridge，理由见文件头：有 dock 上下文不等于有地方放面板。
	const openInDock = dock?.openSubagentPanel;

	return useCallback(
		(targetNarratorId: string | null | undefined) =>
			openNarratorSession(
				{ targetNarratorId, canOpenInDock: !!openInDock },
				{
					openInDock,
					navigateToNarrator: (id) =>
						navigate({ to: "/narrators/$narratorId", params: { narratorId: id } }),
				},
			),
		[openInDock, navigate],
	);
}
