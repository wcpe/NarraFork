/**
 * 编排面板实时更新的**接线**测试。
 *
 * 纯逻辑（`frontend/lib/orchestration-worker-live.ts`）已经钉住了"事件怎么变成面板上
 * 的数据"，但"事件到底有没有送到那里"是另一回事：订阅挂在哪个 narrator 上、帧类型
 * 过滤器写没写对、一整场编排到底开了几条订阅——这些错了都不会有类型错误，只会让面板
 * 静默地退回轮询。
 *
 * 因此这里挂真实的 hook、派发真实的帧形状（`dispatchLocalFrame`，与线上帧走同一套
 * 监听器分发），断言两件事：
 * - **面板数据随事件变化**（事件驱动的端到端证据）；
 * - **只订阅一次父叙述者**，不为每只 worker 各开一条订阅。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { OrchestrationWorkerStatus } from "@shared/orchestration-status";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useOrchestrationWorkerLive } from "../../../hooks/useOrchestrationWorkerLive";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { mergeOrchestrationWorkers } from "../../../lib/orchestration-worker-live";

const PARENT = "parent-live";
const OTHER_PARENT = "parent-other";

const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let subscribedCalls: unknown[][];
const spies: Array<{ mockRestore: () => void }> = [];

function worker(
	narratorId: string,
	over: Partial<OrchestrationWorkerStatus> = {},
): OrchestrationWorkerStatus {
	return {
		narratorId,
		role: "worker",
		tier: "quick",
		model: "provA:worker",
		status: "working",
		reused: null,
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		contextPercent: null,
		...over,
	};
}

const WORKERS: OrchestrationWorkerStatus[] = [worker("w1"), worker("w2", { tier: "heavy" })];

/** 把 hook 的结果原样渲染出来，让断言看的就是面板拿到的那份数据。 */
function Harness() {
	const { overlay, lastEventAtMs } = useOrchestrationWorkerLive(PARENT, true);
	const view = mergeOrchestrationWorkers({ workers: WORKERS, overlay });
	return (
		<span data-testid="out">
			{JSON.stringify({
				rows: view.map((row) => [row.narratorId, row.status, row.contextPercent, row.live]),
				lastEventAtMs,
			})}
		</span>
	);
}

function rendered(): {
	rows: Array<[string, string, number | null, boolean]>;
	lastEventAtMs: number | null;
} {
	const cell = document.querySelector('[data-testid="out"]');
	if (!cell?.textContent) throw new Error("harness did not render");
	return JSON.parse(cell.textContent);
}

async function dispatch(frame: Record<string, unknown>): Promise<void> {
	await act(async () => {
		narratorWSManager.dispatchLocalFrame(frame);
	});
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	subscribedCalls = [];
	const subscribeSpy = spyOn(narratorWSManager, "subscribe").mockImplementation((ids, opts) => {
		subscribedCalls.push([ids, opts]);
		return { _id: 1, _narratorIds: ids, _kind: opts?.kind ?? "panel" };
	});
	spies.push(subscribeSpy);
	spies.push(spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {}));
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => {
		root.render(<Harness />);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

describe("事件驱动的面板更新", () => {
	test("初始渲染给出快照值，且上下文是未知而不是 0", () => {
		const { rows, lastEventAtMs } = rendered();
		expect(rows).toEqual([
			["w1", "working", null, false],
			["w2", "working", null, false],
		]);
		expect(lastEventAtMs).toBeNull();
	});

	test("收到状态帧后对应那一行的状态改变", async () => {
		await dispatch({
			type: "subagent_status_changed",
			narratorId: PARENT,
			subagentNarratorId: "w1",
			status: "idle",
		});
		const { rows } = rendered();
		expect(rows[0]).toEqual(["w1", "idle", null, true]);
		// 别的 worker 不受影响。
		expect(rows[1]).toEqual(["w2", "working", null, false]);
	});

	test("收到上下文帧后对应那一行的占用率改变，且不抹掉状态", async () => {
		await dispatch({
			type: "subagent_status_changed",
			narratorId: PARENT,
			subagentNarratorId: "w1",
			status: "waiting",
		});
		await dispatch({
			type: "context_usage",
			narratorId: PARENT,
			subagentNarratorId: "w1",
			percentage: 73.6,
			isSubagent: true,
		});
		const { rows, lastEventAtMs } = rendered();
		expect(rows[0]).toEqual(["w1", "waiting", 73.6, true]);
		expect(lastEventAtMs).not.toBeNull();
	});

	test("未知 worker 的事件不崩、也不凭空造行", async () => {
		await dispatch({
			type: "subagent_status_changed",
			narratorId: PARENT,
			subagentNarratorId: "ghost",
			status: "working",
		});
		await dispatch({
			type: "context_usage",
			narratorId: PARENT,
			subagentNarratorId: "ghost",
			percentage: 12,
			isSubagent: true,
		});
		expect(rendered().rows).toHaveLength(2);
	});

	test("坏帧被丢弃而不是把面板弄坏", async () => {
		await dispatch({ type: "subagent_status_changed", narratorId: PARENT, status: "idle" });
		await dispatch({
			type: "context_usage",
			narratorId: PARENT,
			percentage: "half",
			isSubagent: true,
		});
		await dispatch({ nonsense: true });
		expect(rendered().rows).toEqual([
			["w1", "working", null, false],
			["w2", "working", null, false],
		]);
	});
});

describe("订阅范围", () => {
	test("只为父叙述者订阅一次，不为每只 worker 各开一条", async () => {
		for (const workerId of ["w1", "w2"]) {
			await dispatch({
				type: "subagent_status_changed",
				narratorId: PARENT,
				subagentNarratorId: workerId,
				status: "working",
			});
		}
		expect(subscribedCalls).toHaveLength(1);
		expect(subscribedCalls[0]?.[0]).toEqual([PARENT]);
	});

	test("别的父叙述者的帧不会落到本面板上", async () => {
		await dispatch({
			type: "subagent_status_changed",
			narratorId: OTHER_PARENT,
			subagentNarratorId: "w1",
			status: "archived",
		});
		expect(rendered().rows[0]).toEqual(["w1", "working", null, false]);
	});
});
