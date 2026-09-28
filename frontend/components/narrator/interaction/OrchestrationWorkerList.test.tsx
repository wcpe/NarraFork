/**
 * OrchestrationWorkerList 的呈现断言。
 *
 * 与同目录其它编排测试同一条分工：SSR 断言"数字与状态怎么画"。这里重点守三件事：
 * - **未知不是 0**：拿不到占用率的 worker 必须画成「未知」，画成 `0%` 会被读成
 *   "上下文还很空"，与真相正好相反；
 * - **截断要说出来**：清单有上限时不能让读者以为一共就这么多；
 * - **四种状态各有各的说法**：把「已停放」画成「空闲」会让人以为它随时能接活。
 */

import { describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OrchestrationWorkerStatus } from "@shared/orchestration-status";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import {
	mergeOrchestrationWorkers,
	type OrchestrationWorkerView,
} from "../../../lib/orchestration-worker-live";
import zh from "../../../locales/zh-CN/narrator.json";
import { OrchestrationWorkerList } from "./OrchestrationWorkerList";

/** 只用真实 zh-CN 文案做插值，因此这里不需要 i18n 实例。 */
const t = ((key: string, options?: Record<string, unknown>) => {
	const template = (zh as unknown as Record<string, string>)[key] ?? `missing:${key}`;
	if (!options) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ""));
}) as never;

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

function worker(over: Partial<OrchestrationWorkerStatus> = {}): OrchestrationWorkerStatus {
	return {
		narratorId: "w1",
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

function render(input: {
	workers: readonly OrchestrationWorkerView[];
	workerCount?: number;
	truncated?: boolean;
}): Element {
	const { document } = parseHTML(
		`<!doctype html><html><body><div id="r">${renderToStaticMarkup(
			<MantineProvider>
				<OrchestrationWorkerList
					workers={input.workers}
					workerCount={input.workerCount ?? input.workers.length}
					truncated={input.truncated ?? false}
					nowMs={NOW}
					t={t}
				/>
			</MantineProvider>,
		)}</div></body>`,
	);
	const root = document.getElementById("r");
	if (!root) throw new Error("no root");
	return root as unknown as Element;
}

/** 走一遍"服务端快照 → 事件覆盖"，拿到与面板完全一致的那份行数据。 */
function viewOf(
	workers: readonly OrchestrationWorkerStatus[],
	overlay: Parameters<typeof mergeOrchestrationWorkers>[0]["overlay"] = new Map(),
): OrchestrationWorkerView[] {
	return mergeOrchestrationWorkers({ workers, overlay });
}

describe("未知上下文必须画成「未知」", () => {
	it("contextPercent 为 null 时不画成 0%", () => {
		const root = render({ workers: viewOf([worker()]) });
		const cell = root.querySelector('[data-testid="orchestration-worker-context-w1"]');
		expect(cell?.textContent).toContain("未知");
		expect(cell?.textContent).not.toContain("0%");
	});

	it("真的是 0 时如实画 0%（「不知道」与「空」必须能区分）", () => {
		const root = render({ workers: viewOf([worker({ contextPercent: 0 })]) });
		const cell = root.querySelector('[data-testid="orchestration-worker-context-w1"]');
		expect(cell?.textContent).toContain("0%");
		expect(cell?.textContent).not.toContain("未知");
	});

	it("有值时四舍五入到整数百分比", () => {
		const root = render({ workers: viewOf([worker({ contextPercent: 61.4 })]) });
		expect(
			root.querySelector('[data-testid="orchestration-worker-context-w1"]')?.textContent,
		).toContain("61%");
	});
});

describe("状态与来源", () => {
	it("四种状态各有各的文案，「已停放」不会被画成「空闲」", () => {
		const workers = viewOf([
			worker({ narratorId: "a", status: "working" }),
			worker({ narratorId: "b", status: "idle" }),
			worker({ narratorId: "c", status: "waiting" }),
			worker({ narratorId: "d", status: "archived" }),
		]);
		const root = render({ workers });
		expect(root.querySelector('[data-testid="orchestration-worker-status-a"]')?.textContent).toBe(
			"运行中",
		);
		expect(root.querySelector('[data-testid="orchestration-worker-status-b"]')?.textContent).toBe(
			"空闲",
		);
		expect(root.querySelector('[data-testid="orchestration-worker-status-c"]')?.textContent).toBe(
			"等待中",
		);
		expect(root.querySelector('[data-testid="orchestration-worker-status-d"]')?.textContent).toBe(
			"已停放",
		);
	});

	it("复用而来的 worker 标「复用」；复用情况未知时不冒充「新建」", () => {
		const reused = render({ workers: viewOf([worker({ reused: true })]) });
		expect(reused.textContent).toContain("复用");

		const unknown = render({ workers: viewOf([worker({ reused: null })]) });
		expect(unknown.textContent).toContain("复用情况未知");
		expect(unknown.textContent).not.toContain("新建");
	});

	it("没有模型名时画「未知模型」，不画空白", () => {
		const root = render({ workers: viewOf([worker({ model: null })]) });
		expect(root.textContent).toContain("未知模型");
	});

	it("没有活动记录时画「—」，不画成「很久以前」", () => {
		const root = render({ workers: viewOf([worker({ lastActivityAt: null })]) });
		const cell = root.querySelector('[data-testid="orchestration-worker-activity-w1"]');
		expect(cell?.textContent).toBe("—");
	});
});

describe("总量与截断", () => {
	it("空清单给出空态说明", () => {
		const root = render({ workers: [] });
		expect(root.querySelector('[data-testid="orchestration-workers-empty"]')).not.toBeNull();
	});

	it("列出总数", () => {
		const root = render({ workers: viewOf([worker()]), workerCount: 3 });
		expect(root.querySelector('[data-testid="orchestration-workers-count"]')?.textContent).toBe(
			"共 3 只",
		);
	});

	it("截断时如实说明被省略的数量", () => {
		const root = render({ workers: viewOf([worker()]), workerCount: 57, truncated: true });
		const note = root.querySelector('[data-testid="orchestration-workers-truncated"]');
		expect(note?.textContent).toContain("1");
		expect(note?.textContent).toContain("56");
	});

	it("没有截断时不出现那句话", () => {
		const root = render({ workers: viewOf([worker()]), workerCount: 1 });
		expect(root.querySelector('[data-testid="orchestration-workers-truncated"]')).toBeNull();
	});
});
