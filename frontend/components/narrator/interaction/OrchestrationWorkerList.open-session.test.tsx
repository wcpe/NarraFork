/**
 * OrchestrationWorkerList 的**交互**断言：点代理行进它的会话。
 *
 * 与同目录的 SSR 版本（`OrchestrationWorkerList.test.tsx`）分工不同：那一份只画字符串，
 * 这一份要真的挂载、真的点。用户报的正是"代理不能点进去看历史"——而"能不能点"只在
 * 运行时成立，SSR 出来的 HTML 看不出 onClick 有没有接上。
 *
 * 三条边界：
 * - **可点的行把正确的 narratorId 交出去**（用调用桩断言，不靠肉眼）；
 * - **拿不到 id 的行不可点**，点了也没有任何副作用：画成可点却没有目标是"按钮点了没
 *   作用"那一类错误，用户已经撞过；
 * - **没有打开回调时一行都不假装可点**（SSR/无 dock 的宿主）。
 *
 * 实现细节来源：`onOpenWorker` 是**注入**的（"先试 dock、不行就路由"那条规则只有一份
 * 实现，见 `../dock/open-narrator-session.ts`），因此这里只需要一个调用桩就能把点击
 * 链路完整测到，不必挂载 dock 上下文或路由。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OrchestrationWorkerStatus } from "@shared/orchestration-status";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OrchestrationWorkerView } from "../../../lib/orchestration-worker-live";
import zh from "../../../locales/zh-CN/narrator.json";
import { isOrchestrationWorkerOpenable, OrchestrationWorkerList } from "./OrchestrationWorkerList";

/** 只用真实 zh-CN 文案做插值，因此这里不需要 i18n 实例。 */
const t = ((key: string, options?: Record<string, unknown>) => {
	const template = (zh as unknown as Record<string, string>)[key] ?? `missing:${key}`;
	if (!options) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ""));
}) as never;

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

const GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"Event",
	"MouseEvent",
	"PointerEvent",
	"HTMLElement",
	"HTMLButtonElement",
	"HTMLInputElement",
	"SVGElement",
	"Element",
	"Node",
	"ResizeObserver",
	"matchMedia",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreGlobals: (() => void) | undefined;

/** 装一套隔离的 DOM：linkedom 的全局改动必须逐条还原，否则会漏给后面的测试文件。 */
function installIsolatedDom() {
	const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	for (const key of GLOBAL_KEYS)
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));

	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	// floating-ui（Tooltip 的定位层）会探测 `navigator.platform`，而 linkedom 不提供它；
	// `window.navigator` 每次访问都新建对象，因此要先把补好的那一个装回去。
	const navigator = window.navigator;
	Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });
	Object.defineProperty(window, "navigator", { configurable: true, value: navigator });

	const globals = {
		window,
		document: window.document,
		navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		PointerEvent: window.PointerEvent ?? window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		SVGElement: window.SVGElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: NoopResizeObserver,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			Number(setTimeout(() => callback(0), 0)),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	restoreGlobals = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}

function worker(over: Partial<OrchestrationWorkerStatus> = {}): OrchestrationWorkerView {
	return {
		narratorId: "w1",
		role: "worker",
		tier: "quick",
		model: "provA:worker",
		status: "working",
		reused: null,
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		contextPercent: null,
		live: false,
		liveAtMs: null,
		...over,
	};
}

async function render(
	workers: readonly OrchestrationWorkerView[],
	onOpenWorker?: (narratorId: string) => void,
) {
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<OrchestrationWorkerList
					workers={workers}
					workerCount={workers.length}
					truncated={false}
					nowMs={NOW}
					t={t}
					{...(onOpenWorker ? { onOpenWorker } : {})}
				/>
			</MantineProvider>,
		);
	});
}

/** 挂载后按 testid 取一个元素；取不到就抛，避免断言在 undefined 上静默通过。 */
function element(testId: string): HTMLElement {
	const found = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`no element for ${testId}`);
	return found;
}

async function click(node: HTMLElement | undefined) {
	if (!node) throw new Error("nothing to click");
	await act(async () => {
		node.click();
	});
}

beforeEach(() => {
	installIsolatedDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	container = undefined;
	restoreGlobals?.();
	restoreGlobals = undefined;
});

describe("isOrchestrationWorkerOpenable", () => {
	it("只有拿得到 id 的行才算可点", () => {
		expect(isOrchestrationWorkerOpenable({ narratorId: "w1" })).toBe(true);
	});

	it("空 id 与只含空白的 id 一律不可点", () => {
		for (const narratorId of ["", "   "]) {
			expect(isOrchestrationWorkerOpenable({ narratorId })).toBe(false);
		}
	});
});

describe("点进代理的会话", () => {
	it("点可点的行，唤起到的是这一行自己的 narratorId", async () => {
		const opened: string[] = [];
		await render([worker({ narratorId: "w-alpha" }), worker({ narratorId: "w-beta" })], (id) =>
			opened.push(id),
		);

		await click(element("orchestration-worker-w-beta"));

		expect(opened).toEqual(["w-beta"]);
	});

	it("点行尾的图标是同一个动作，而且只触发一次（不冒泡成两次）", async () => {
		const opened: string[] = [];
		await render([worker({ narratorId: "w-alpha" })], (id) => opened.push(id));

		await click(element("orchestration-worker-open-w-alpha"));

		expect(opened).toEqual(["w-alpha"]);
	});

	it("被复用的（已停放）worker 一样可点：停放只改了状态，id 还在", async () => {
		const opened: string[] = [];
		await render([worker({ narratorId: "w-parked", status: "archived", reused: true })], (id) =>
			opened.push(id),
		);

		await click(element("orchestration-worker-w-parked"));

		expect(opened).toEqual(["w-parked"]);
	});

	it("可点的行有一个明确的门，提示文案是中英都有的那条", async () => {
		await render([worker({ narratorId: "w-alpha" })], () => {});
		const icon = element("orchestration-worker-open-w-alpha");

		expect(icon.getAttribute("aria-label")).toBe(zh.orchestrationWorkerOpen);
		expect(element("orchestration-worker-w-alpha").getAttribute("data-openable")).toBe("true");
		expect(element("orchestration-worker-w-alpha").style.cursor).toBe("pointer");
	});

	it("拿不到 id 的行不可点：没有门、也没有指针光标，点了更是没有任何副作用", async () => {
		const opened: string[] = [];
		await render([worker({ narratorId: "   " })], (id) => opened.push(id));

		// 行本身还在（它是一只真实存在的 worker，只是没有可去的地方），但没有任何可点的表征。
		const row = container?.querySelector<HTMLElement>("[data-openable]");
		expect(row?.getAttribute("data-openable")).toBe("false");
		expect(row?.style.cursor).toBe("default");
		expect(container?.querySelector('[data-testid^="orchestration-worker-open-"]')).toBeNull();

		await click(row ?? undefined);

		expect(opened).toEqual([]);
	});

	it("没有打开回调时一行都不假装可点（SSR / 没有 dock 的宿主）", async () => {
		const opened: string[] = [];
		// 刻意不传 `onOpenWorker`：拿不到打开函数时，行不是"可点但没反应"，而是明确不可点。
		await render([worker({ narratorId: "w-alpha" })]);

		expect(element("orchestration-worker-w-alpha").getAttribute("data-openable")).toBe("false");
		expect(container?.querySelector('[data-testid^="orchestration-worker-open-"]')).toBeNull();

		await click(element("orchestration-worker-w-alpha"));

		expect(opened).toEqual([]);
	});
});
