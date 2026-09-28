/**
 * open-narrator-session 的断言。
 *
 * 这个模块存在的理由是**"点进去看会话"只有一份实现**：编排面板的代理行与后台任务里的
 * agent 行从前各写一份"先试 dock、不行就路由"，两份会漂移，而漂移的表现是"点了没反应"
 * ——看起来可点、实际什么也没发生，正是最难排查的形状。
 *
 * 三件事分开断言：
 *   1. **去哪儿**（`planNarratorSessionOpen`）：有 dock 就开面板，没有就路由，拿不到
 *      id 就哪儿也不去（而不是路由到一个空 id 上）；
 *   2. **真的交给了谁**（`openNarratorSession`）：用调用桩断言收到的是**正确的
 *      narratorId**，并如实回报"打开了没有"；
 *   3. **两处调用点确实共用它**：面板与后台任务都只调 `useOpenNarratorSession`，各自
 *      不再带一份 navigate。这道断言读源码文本，因为这两个组件都挂着 query / dock /
 *      路由，单元挂载不起来；而"某段代码不存在"本就是模块图性质，运行时观察不到。
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openNarratorSession, planNarratorSessionOpen } from "./open-narrator-session";

const OPENER = readFileSync(join(import.meta.dir, "open-narrator-session.ts"), "utf8");
const PANELS = readFileSync(join(import.meta.dir, "panels.tsx"), "utf8");
const BACKGROUND = readFileSync(
	join(import.meta.dir, "..", "background", "BackgroundTasksDrawer.tsx"),
	"utf8",
);

/** 取出一个具名函数/组件的源码块（到下一个顶层 `export` 或文件末尾为止）。 */
function blockOf(source: string, startMarker: string): string {
	const start = source.indexOf(startMarker);
	if (start < 0) throw new Error(`未找到 ${startMarker}`);
	const next = source.indexOf("\nexport ", start + startMarker.length);
	return next < 0 ? source.slice(start) : source.slice(start, next);
}

describe("planNarratorSessionOpen", () => {
	it("有 dock 的界面把会话开在对话旁边，而不是换一页", () => {
		expect(planNarratorSessionOpen({ targetNarratorId: "sub-1", canOpenInDock: true })).toEqual({
			mode: "dock",
			targetNarratorId: "sub-1",
		});
	});

	it("没有 dock（窄屏页面、拆出来的画布面板）时回落为路由", () => {
		expect(planNarratorSessionOpen({ targetNarratorId: "sub-1", canOpenInDock: false })).toEqual({
			mode: "route",
			targetNarratorId: "sub-1",
		});
	});

	it("拿不到 id 时哪儿也不去，而不是路由到一个空 id", () => {
		for (const targetNarratorId of [null, undefined, "", "   "]) {
			expect(planNarratorSessionOpen({ targetNarratorId, canOpenInDock: true })).toEqual({
				mode: "none",
			});
			expect(planNarratorSessionOpen({ targetNarratorId, canOpenInDock: false })).toEqual({
				mode: "none",
			});
		}
	});

	it("交出去的 id 去掉首尾空白，一个带空格的 id 不该变成坏路由", () => {
		expect(planNarratorSessionOpen({ targetNarratorId: "  sub-1 ", canOpenInDock: false })).toEqual(
			{ mode: "route", targetNarratorId: "sub-1" },
		);
	});
});

describe("openNarratorSession", () => {
	function stubs(input: { canOpenInDock: boolean }): {
		opened: string[];
		routed: string[];
		openInDock: ((id: string) => void) | null;
		navigateToNarrator: (id: string) => void;
	} {
		const opened: string[] = [];
		const routed: string[] = [];
		return {
			opened,
			routed,
			openInDock: input.canOpenInDock ? (id: string) => opened.push(id) : null,
			navigateToNarrator: (id: string) => routed.push(id),
		};
	}

	it("把正确的 narratorId 交给 dock，且不碰路由", () => {
		const performers = stubs({ canOpenInDock: true });
		const opened = openNarratorSession(
			{ targetNarratorId: "sub-42", canOpenInDock: true },
			performers,
		);

		expect(opened).toBe(true);
		expect(performers.opened).toEqual(["sub-42"]);
		expect(performers.routed).toEqual([]);
	});

	it("没有 dock 时把同一个 id 交给路由，且不碰 dock", () => {
		const performers = stubs({ canOpenInDock: false });
		const opened = openNarratorSession(
			{ targetNarratorId: "sub-42", canOpenInDock: false },
			performers,
		);

		expect(opened).toBe(true);
		expect(performers.routed).toEqual(["sub-42"]);
		expect(performers.opened).toEqual([]);
	});

	it("没有目标时两个宿主都不被调用，并如实回报「没打开」", () => {
		const performers = stubs({ canOpenInDock: true });
		const opened = openNarratorSession(
			{ targetNarratorId: "   ", canOpenInDock: true },
			performers,
		);

		expect(opened).toBe(false);
		expect(performers.opened).toEqual([]);
		expect(performers.routed).toEqual([]);
	});

	it("计划说走 dock 而 bridge 其实缺席时不假装打开过", () => {
		// 两个参数本该一致（`canOpenInDock` 就来自 `!!openInDock`），但这层兜底让
		// 不一致的调用方得到一个明确的 false，而不是静默什么都不做。
		const performers = stubs({ canOpenInDock: false });
		const opened = openNarratorSession(
			{ targetNarratorId: "sub-42", canOpenInDock: true },
			performers,
		);

		expect(opened).toBe(false);
		expect(performers.opened).toEqual([]);
		expect(performers.routed).toEqual([]);
	});
});

describe("两处调用点共用同一个打开函数", () => {
	it("编排面板的代理行把打开回调接在共享 hook 上", () => {
		const panel = blockOf(PANELS, "export function OrchestrationDockPanel");
		expect(panel).toContain("useOpenNarratorSession()");
		expect(panel).toContain("onOpenWorker={openWorkerSession}");
		// 面板自己不该再有一份"先试 dock、不行就路由"。
		expect(panel).not.toContain('to: "/narrators/$narratorId"');
	});

	it("后台任务的 agent 行走的是同一个 hook", () => {
		const openBlock = blockOf(BACKGROUND, "const handleOpenSubagent = useCallback(");
		expect(openBlock).toContain("openNarratorSession(subagentNarratorId)");
		// 这里从前自己写了一遍 dock / 路由的分支，那正是会漂移的那一份。
		expect(openBlock).not.toContain("openInDock");
		expect(openBlock).not.toContain('to: "/narrators/$narratorId"');
		expect(BACKGROUND).toContain("useOpenNarratorSession()");
	});

	it("路由落在共享模块里，而且只落在一处", () => {
		expect(OPENER).toContain('navigate({ to: "/narrators/$narratorId"');
	});
});
