/**
 * OrchestrationStatusPopover 的**真实交互**测试。
 *
 * 存在的理由（这条不能删）：
 * 同目录的 `OrchestrationStatusPopover.test.tsx` 用 `renderToStaticMarkup`（SSR）渲染，
 * 它**只产出 HTML 字符串，完全不执行任何事件处理器**。因此那个文件能证明"面板里的数字
 * 画对了"，却**证明不了"按钮点得开"**——而真实发生过的缺陷正是后者：
 * `ActionIcon` 上少了 `onClick`，面板照常渲染、样式照常正确，只是点了没反应。
 * 根因在 Mantine 的 `Popover.Target`：它只在**非受控**时才替子元素接上开关
 * （`...!ctx.controlled ? { onClick: ... } : null`），而本组件传了
 * `opened` + `onChange`（受控），于是它什么都不接，开关必须由调用方自己写。
 *
 * 所以：**不要把这个文件退回 SSR 写法**。SSR 渲染一次就能通过的断言，
 * 在这里必须靠真实点击来通过。DOM 环境用 linkedom + `react-dom/client`，
 * 与 `composer/FileReferencePopover.test.tsx`、`compact/compact-summary-modal.retry.test.tsx`
 * 同一套范式；`MantineProvider env="test"` 关掉过渡与 portal，
 * 于是"面板是否打开"就等于"`orchestration-status-popover` 是否在树里"。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OrchestrationStatus } from "@shared/orchestration-status";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../../lib/api";
import { OrchestrationStatusPopover } from "./OrchestrationStatusPopover";

/** 只用真实 zh-CN 文案做插值，因此不需要 i18n 实例（与 SSR 测试同一套替身）。 */
const t = ((key: string) => key) as never;

/** 面板里"已打开"的可观测标志：dropdown 上的 testid。 */
const POPOVER = "orchestration-status-popover";
const TRIGGER = "orchestration-status-trigger";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;
let statusSpy: ReturnType<typeof spyOn<typeof api, "getOrchestrationStatus">> | undefined;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function status(): OrchestrationStatus {
	const emptyTier = () => ({
		runs: 0,
		finished: 0,
		totalDurationMs: 0,
		avgDurationMs: null,
		reused: 0,
		failed: 0,
	});
	return {
		profileId: "of7k2m9q",
		profileName: "省成本",
		orchestratorModel: "provA:orchestrator",
		tiers: {
			chore: { parked: 0, running: 0 },
			quick: { parked: 0, running: 0 },
			medium: { parked: 0, running: 0 },
			heavy: { parked: 0, running: 0 },
		},
		pools: { chore: [], quick: [], medium: [], heavy: [] },
		// 逐 worker 明细属于 dock 面板；Popover 只画容量与历史，因此这里留空。
		workers: [],
		workerCount: 0,
		workersTruncated: false,
		runs: {
			aggregate: {
				chore: emptyTier(),
				quick: emptyTier(),
				medium: emptyTier(),
				heavy: emptyTier(),
			},
			recent: [],
		},
	};
}

/**
 * 安装最小 DOM 环境。
 *
 * 只覆盖本组件真正会碰到的东西：`Event`（派发点击）、`HTMLElement`（Mantine 的
 * 类型守卫）、`getComputedStyle` / `matchMedia`（Mantine 主题与媒体查询）、
 * `requestAnimationFrame`（floating 定位的调度）。不铺无关 stub。
 */
function installDom(): void {
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
	Object.assign(window, {
		matchMedia,
		innerWidth: 1280,
		innerHeight: 720,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle:
			window.getComputedStyle?.bind(window) ??
			(() => ({ getPropertyValue: () => "", direction: "ltr" })),
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

/** 触发按钮：**只从真实 DOM 里取**，不靠组件内部引用，否则测不出"连没连上事件"。 */
function triggerButton(): HTMLElement {
	const element = document.querySelector<HTMLElement>(`[data-testid="${TRIGGER}"]`);
	if (!element) throw new Error(`trigger not found: ${TRIGGER}`);
	return element;
}

/** 面板是否已打开 —— 由 dropdown 是否挂载来判定。 */
const panelMounted = () => document.querySelector(`[data-testid="${POPOVER}"]`) !== null;

async function clickTrigger(): Promise<void> {
	await act(async () => {
		triggerButton().dispatchEvent(new Event("click", { bubbles: true }));
		await Promise.resolve();
	});
	// 打开后还有一次 react-query 取数要落定；点开只关心是否挂载，多等一拍即可。
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, refetchInterval: false },
			mutations: { retry: false },
		},
	});
	statusSpy = spyOn(api, "getOrchestrationStatus").mockResolvedValue({ orchestration: status() });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	statusSpy?.mockRestore();
	queryClient?.clear();
	container?.remove();
	root = undefined;
	queryClient = undefined;
	container = undefined;
	statusSpy = undefined;
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

async function render(): Promise<void> {
	if (!root || !queryClient) throw new Error("test harness is not initialized");
	const client = queryClient;
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<QueryClientProvider client={client}>
					<OrchestrationStatusPopover narratorId="n1" t={t} />
				</QueryClientProvider>
			</MantineProvider>,
		);
	});
}

describe("OrchestrationStatusPopover 的开合", () => {
	test("初始是关着的：按钮在、面板不在", async () => {
		await render();
		expect(triggerButton()).toBeDefined();
		expect(panelMounted()).toBe(false);
	});

	test("点一次真的打开面板（SSR 测不出这一步）", async () => {
		await render();
		await clickTrigger();
		expect(panelMounted()).toBe(true);
		// 打开才拉：这一步同时证明 `enabled: opened` 的接线是通的。
		expect(statusSpy).toHaveBeenCalledTimes(1);
		expect(statusSpy?.mock.calls[0]?.[0]).toBe("n1");
	});

	test("再点一次关回去", async () => {
		await render();
		await clickTrigger();
		expect(panelMounted()).toBe(true);
		await clickTrigger();
		expect(panelMounted()).toBe(false);
	});

	test("可以反复开合，不会卡在某一态", async () => {
		await render();
		for (let i = 0; i < 3; i++) {
			await clickTrigger();
			expect(panelMounted()).toBe(true);
			await clickTrigger();
			expect(panelMounted()).toBe(false);
		}
	});
});
