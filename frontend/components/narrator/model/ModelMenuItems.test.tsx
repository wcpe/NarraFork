import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider, Menu } from "@mantine/core";
import type { SubagentModelInheritance } from "@shared/model-inheritance";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import {
	FOLLOW_PARENT_MODEL,
	type ModelAggregation,
	type ModelOption,
	ORCHESTRATION_PROVIDER_KEY,
	resolveDisplayModel,
} from "../../../lib/constants";
import narratorLocale from "../../../locales/en/narrator.json";
import settingsLocale from "../../../locales/en/settings.json";
import narratorZhLocale from "../../../locales/zh-CN/narrator.json";
import { ModelMenuItems } from "./ModelMenuItems";

const aggregations: ModelAggregation[] = [
	{ id: "group", name: "Group", routingMode: "priority", models: ["a:one", "a:two"] },
];
const models: ModelOption[] = [
	{ value: "__default__", label: "Follow default", provider: "__default__" },
	{ value: "__agg__:group", label: "Group", provider: "__agg__" },
	{ value: "a:one", label: "One", provider: "a" },
	{ value: "a:two", label: "Two", provider: "a" },
];
/** 一个四档齐全的编排方案选项（provider 即编排分组哨兵）。 */
const orchestrationOption: ModelOption = {
	value: "__orch__:prof1",
	label: "Team profile",
	provider: ORCHESTRATION_PROVIDER_KEY,
	orchestration: {
		id: "prof1",
		name: "Team profile",
		description: "Two-tier review pipeline",
		orchestratorModels: ["a:one"],
		tierPools: { chore: ["a:one"], quick: [], medium: ["a:two"], heavy: ["a:two"] },
	},
};
const orchestrationModels: ModelOption[] = [...models, orchestrationOption];
let root: Root;
let host: HTMLDivElement;
let instance: i18n;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let selected: string[];
let refreshed: number;
let setAsDefault: string[];
let setAsSummary: string[];
let editDefault: number;
let editSummary: number;
let exitOrchestration: number;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	frames = new Map();
	nextFrame = 0;
	selected = [];
	refreshed = 0;
	setAsDefault = [];
	setAsSummary = [];
	editDefault = 0;
	editSummary = 0;
	exitOrchestration = 0;
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	instance = i18next.createInstance();
	await instance.use(initReactI18next).init({
		lng: "en",
		resources: {
			en: { narrator: narratorLocale, settings: settingsLocale },
			"zh-CN": { narrator: narratorZhLocale },
		},
		react: { useSuspense: false },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

async function render(
	currentModel: string | null,
	allModels = models,
	mounted = true,
	opened = true,
	options?: {
		withGlobalRoleActions?: boolean;
		withRoleEditors?: boolean;
		onShowPrice?: (model: ModelOption) => void;
		defaultModelValue?: string | null;
		summaryModelValue?: string | null;
		canFollowParent?: boolean;
		inheritance?: SubagentModelInheritance | null;
		/** 子代理上下文：编排分组整体隐藏。 */
		hideOrchestration?: boolean;
		/** 是否接上「退出编排模式」入口。 */
		withOrchestrationExit?: boolean;
	},
) {
	const withGlobalRoleActions = options?.withGlobalRoleActions ?? false;
	const withRoleEditors = options?.withRoleEditors ?? false;
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={instance}>
					<Menu opened>
						<div data-model-menu-scroll>
							{mounted && (
								<ModelMenuItems
									opened={opened}
									allModels={allModels}
									currentModel={currentModel}
									totalCostUsd={null}
									aggregations={aggregations}
									providerLabels={{ a: "Provider A", xiaomi: "Xiaomi" }}
									onSelect={(value) => selected.push(value)}
									onShowPrice={options?.onShowPrice}
									canFollowParent={options?.canFollowParent}
									inheritance={options?.inheritance}
									onPickerOpened={() => {
										refreshed++;
									}}
									defaultModelValue={options?.defaultModelValue}
									summaryModelValue={options?.summaryModelValue}
									hideOrchestration={options?.hideOrchestration}
									{...(options?.withOrchestrationExit
										? { onExitOrchestration: () => exitOrchestration++ }
										: {})}
									{...(withGlobalRoleActions
										? {
												onSetAsDefaultModel: (value: string) => setAsDefault.push(value),
												onSetAsSummaryModel: (value: string) => setAsSummary.push(value),
											}
										: {})}
									{...(withRoleEditors
										? {
												onEditDefaultModel: () => editDefault++,
												onEditSummaryModel: () => editSummary++,
											}
										: {})}
								/>
							)}
						</div>
					</Menu>
				</I18nextProvider>
			</MantineProvider>,
		);
	});
}

function buttons() {
	return Array.from(host.querySelectorAll<HTMLButtonElement>("[data-menu-item]"));
}
function button(text: string) {
	const found = buttons().find((item) => item.textContent === text);
	if (!found) throw new Error(`Missing menu item: ${text}`);
	return found;
}
/** 编排方案行：文本里除了方案名还有档位徽标与描述，不能按整段文本精确匹配。 */
function orchestrationRow(name: string) {
	const found = buttons().find((item) => item.textContent?.includes(name));
	if (!found) throw new Error(`Missing orchestration row: ${name}`);
	return found;
}
function prepareGeometry() {
	const dropdown = host.querySelector<HTMLElement>("[data-model-menu-scroll]");
	if (!dropdown) throw new Error("Missing dropdown");
	dropdown.scrollTop = 0;
	Object.defineProperties(dropdown, {
		clientHeight: { configurable: true, value: 200 },
		clientTop: { configurable: true, value: 0 },
		scrollHeight: { configurable: true, value: 2000 },
	});
	dropdown.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
	buttons().forEach((item, index) => {
		item.getBoundingClientRect = () =>
			({ top: 100 + index * 100 - dropdown.scrollTop, height: 20 }) as DOMRect;
	});
	return dropdown;
}
async function flushFrames() {
	await act(async () => {
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(0);
	});
}

describe("follow parent selection", () => {
	test.each([
		["en", "Follow parent"],
		["zh-CN", "跟随主代理"],
	])("shows an honest follow label in %s and keeps concrete selection working", async (language, label) => {
		await instance.changeLanguage(language);
		await render(FOLLOW_PARENT_MODEL, models, true, true, {
			withGlobalRoleActions: true,
			onShowPrice: () => {
				throw new Error("Parent has no resolved price metadata");
			},
		});
		const follow = button(label);
		expect(follow.disabled).toBe(true);
		expect(follow.querySelector('[role="button"]')).toBeNull();
		expect(host.textContent).not.toContain(FOLLOW_PARENT_MODEL);
		await act(async () => button("One").click());
		expect(selected).toEqual(["a:one"]);
	});

	test("does not invent a concrete model from the global default", () => {
		expect(
			resolveDisplayModel(FOLLOW_PARENT_MODEL, { defaultModelValue: "a:one", aggregations }),
		).toBe(FOLLOW_PARENT_MODEL);
	});

	test("does not offer follow-parent for a concrete or primary selection", async () => {
		await render("a:one");
		expect(host.textContent).not.toContain("Follow parent");
	});

	test("resolves the followed parent model exactly like the default/summary role rows", async () => {
		await render(FOLLOW_PARENT_MODEL, models, true, true, {
			inheritance: { source: "parent", model: "a:one", parentModel: "a:one" },
		});
		// Group header + provider prefix line + resolved model label.
		expect(host.textContent).toContain("Follow parent");
		expect(host.textContent).toContain("One");
		const follow = button("aOne");
		expect(follow.disabled).toBe(true);
		expect(host.textContent).not.toContain(narratorLocale["inheritance.fallbackReason"]);
	});

	test("warns with the pool-fallback reason under the resolved fallback model", async () => {
		await render(FOLLOW_PARENT_MODEL, models, true, true, {
			inheritance: {
				source: "pool-fallback",
				model: "a:two",
				parentModel: "a:one",
				poolKey: "general",
			},
		});
		expect(host.textContent).toContain("Two");
		expect(host.textContent).toContain(
			narratorLocale["inheritance.fallbackReason"]
				.replace("{{parentModel}}", "a:one")
				.replace("{{pool}}", "general"),
		);
	});

	test("offers a clickable follow-parent entry to undo a manual pin", async () => {
		await render("a:one", models, true, true, { canFollowParent: true });
		const follow = button("Follow parent");
		expect(follow.disabled).toBe(false);
		await act(async () => follow.click());
		expect(selected).toEqual([FOLLOW_PARENT_MODEL]);
	});
});

describe("catalog details access", () => {
	test("metadata details work without billing prices and resolve follow-default to the actual model", async () => {
		const details: ModelOption[] = [];
		await render("a:one", models, true, true, {
			defaultModelValue: "a:two:opaque",
			onShowPrice: (model) => details.push(model),
		});
		const controls = [
			...host.querySelectorAll<HTMLElement>('[aria-label="Model metadata and prices"]'),
		];
		expect(controls).toHaveLength(3);
		await act(async () => {
			for (const control of controls) control.click();
		});
		expect(details.map((model) => model.value)).toEqual(["a:two:opaque", "a:one", "a:two"]);
		expect(selected).toEqual([]);
	});
});

describe("per-model global role actions", () => {
	test("hides the three-dot control when handlers are not provided", async () => {
		await render("a:one");
		expect(host.querySelector("[aria-label='Model actions']")).toBeNull();
	});
	test("expands set-as actions for concrete models and assigns the row value", async () => {
		await render("a:one", models, true, true, {
			withGlobalRoleActions: true,
			defaultModelValue: "a:one",
			summaryModelValue: null,
		});
		const toggles = host.querySelectorAll("[aria-label='Model actions']");
		// Follow-default has no toggle; aggregation + two concrete models do.
		expect(toggles.length).toBe(3);
		// toggles[1] sits on the "One" row (aggregation is first).
		await act(async () => {
			toggles[1]?.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		const defaultAction = Array.from(host.querySelectorAll("[data-menu-item]")).find(
			(item) => item.textContent === narratorLocale.setAsDefaultModel,
		);
		const summaryAction = Array.from(host.querySelectorAll("[data-menu-item]")).find(
			(item) => item.textContent === narratorLocale.setAsSummaryModel,
		);
		if (!defaultAction || !summaryAction) throw new Error("Missing role action items");
		await act(async () =>
			defaultAction.dispatchEvent(new window.Event("click", { bubbles: true })),
		);
		expect(setAsDefault).toEqual(["a:one"]);
		expect(setAsSummary).toEqual([]);
	});
	test("does not offer global roles on follow-default / follow-summary sentinels", async () => {
		const withSentinels: ModelOption[] = [
			{ value: "__default__", label: "Follow default", provider: "__default__" },
			{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
			{ value: "a:one", label: "One", provider: "a" },
		];
		await render("a:one", withSentinels, true, true, { withGlobalRoleActions: true });
		const toggles = host.querySelectorAll("[aria-label='Model actions']");
		expect(toggles.length).toBe(1);
		expect(host.textContent).toContain("One");
	});
	test("warns on a delisted pinned model and offers role pickers instead of re-pinning", async () => {
		const delisted: ModelOption[] = [
			{ value: "__default__", label: "Follow default", provider: "__default__" },
			{
				value: "xiaomi:mimo-x-pro-preview",
				label: "mimo-x-pro-preview",
				provider: "xiaomi",
				catalogMissing: true,
				pinnedAs: ["summary"],
			},
			{ value: "xiaomi:mimo-v2.6-pro", label: "mimo-v2.6-pro", provider: "xiaomi" },
		];
		await render("xiaomi:mimo-v2.6-pro", delisted, true, true, {
			withGlobalRoleActions: true,
			withRoleEditors: true,
			summaryModelValue: "xiaomi:mimo-x-pro-preview",
		});
		expect(host.textContent).toContain(narratorLocale.modelCatalogMissing);
		expect(host.textContent).toContain(
			narratorLocale.modelCatalogMissingHint.replace("{{roles}}", settingsLocale.summaryModel),
		);
		const toggles = host.querySelectorAll("[aria-label='Model actions']");
		// Follow-default has none; both concrete models still have a three-dot.
		expect(toggles.length).toBe(2);
		// toggles[0] is the delisted row.
		await act(async () => {
			toggles[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		const items = Array.from(host.querySelectorAll("[data-menu-item]")).map((i) => i.textContent);
		expect(items).toContain(narratorLocale.editSummaryModel);
		expect(items).not.toContain(narratorLocale.setAsSummaryModel);
	});
});

describe("provider prefix on default/summary rows", () => {
	test("shows the resolved target's provider prefix as a secondary line", async () => {
		const withRoles: ModelOption[] = [
			{ value: "__default__", label: "gpt-6-astra", provider: "__default__" },
			{ value: "__summary__", label: "mimo-v2.6-pro", provider: "__summary__" },
			{ value: "codex:gpt-6-astra", label: "gpt-6-astra", provider: "codex" },
			{ value: "xiaomi:mimo-v2.6-pro", label: "mimo-v2.6-pro", provider: "xiaomi" },
		];
		await render("codex:gpt-6-astra", withRoles, true, true, {
			defaultModelValue: "codex:gpt-6-astra",
			summaryModelValue: "xiaomi:mimo-v2.6-pro",
		});
		expect(host.textContent).toContain("codex");
		expect(host.textContent).toContain("xiaomi");
		// The prefix is a secondary line under the role row label, not a group header.
		const roleRows = Array.from(host.querySelectorAll("[data-menu-item]")).filter(
			(item) =>
				item.textContent?.includes("gpt-6-astra") || item.textContent?.includes("mimo-v2.6-pro"),
		);
		expect(roleRows.length).toBeGreaterThan(0);
	});
	test("omits the prefix line for meta targets and empty slots", async () => {
		const withRoles: ModelOption[] = [
			{ value: "__default__", label: "Follow default", provider: "__default__" },
			{ value: "__summary__", label: "Follow summary", provider: "__summary__" },
		];
		await render(null, withRoles, true, true, {
			defaultModelValue: "__agg__:group",
			summaryModelValue: "",
		});
		// Aggregation/empty targets have no single provider prefix to show.
		const rows = Array.from(host.querySelectorAll("[data-menu-item]")).map((i) => i.textContent);
		expect(rows.some((t) => t === "Follow default" || t === "Follow summary")).toBe(true);
	});
});

describe("aggregation choices inside model menu", () => {
	test("exposes automatic routing and distinguishable provider members; preserves model values", async () => {
		await render("__agg__:group:a:two");
		expect(buttons().map((item) => item.textContent)).toContain(settingsLocale.aggAutoLabel);
		await act(async () => button("Provider A · One").click());
		await act(async () => button(settingsLocale.aggAutoLabel).click());
		expect(selected).toEqual(["__agg__:group:a:one", "__agg__:group"]);
	});
	test("does not show aggregation members for ordinary models", async () => {
		await render("a:one");
		expect(host.textContent).not.toContain("Provider A · One");
	});
});

describe("orchestration profiles in the model menu", () => {
	test("renders the group with tier summaries and enters orchestration on select", async () => {
		await render(null, orchestrationModels);
		expect(host.textContent).toContain(narratorLocale.modelGroupOrchestration);
		// 方案名 + 可辨识后缀，避免与同名模型行混淆。
		expect(host.textContent).toContain(`Team profile · ${narratorLocale.orchestrationSuffix}`);
		// 档位摘要按池是否非空给出徽标（quick 档为空）。
		expect(host.textContent).toContain(`${narratorLocale.orchestrationTier_chore} 1`);
		expect(host.textContent).toContain(`${narratorLocale.orchestrationTier_quick} 0`);
		expect(host.textContent).toContain(`${narratorLocale.orchestrationTier_heavy} 1`);
		// 选中方案写入的是哨兵值，交给编排入口而不是普通模型 PATCH。
		await act(async () => orchestrationRow("Team profile").click());
		expect(selected).toEqual(["__orch__:prof1"]);
	});

	test("expands the orchestrator models and the four tier pools", async () => {
		await render("a:one", orchestrationModels);
		await act(async () => {
			host
				.querySelector<HTMLElement>(`[aria-label='${narratorLocale.orchestrationDetails}']`)
				?.click();
		});
		const info = host.querySelector("[data-orch-info='prof1']");
		if (!info) throw new Error("Missing orchestration details");
		// 编制者模型解析成可读名，四档池展开为空池给出明确说明。
		expect(info.textContent).toContain("One");
		expect(info.textContent).toContain(narratorLocale.orchestrationPoolEmpty);
		expect(info.textContent).toContain("Two");
		expect(selected).toEqual([]);
	});

	test("never offers a global role action on an orchestration row", async () => {
		await render("a:one", orchestrationModels, true, true, { withGlobalRoleActions: true });
		// 聚合行 + 两个具体模型行；编排方案不是模型，不能被写进全局槽位。
		expect(host.querySelectorAll("[aria-label='Model actions']").length).toBe(3);
	});

	test("hides the group for a subagent context", async () => {
		await render(null, orchestrationModels, true, true, { hideOrchestration: true });
		expect(host.textContent).not.toContain(narratorLocale.modelGroupOrchestration);
		expect(host.textContent).not.toContain("Team profile");
		// 普通模型分组不受影响。
		expect(host.textContent).toContain("One");
	});

	test("offers exiting orchestration only while a profile is selected", async () => {
		await render("__orch__:prof1", orchestrationModels, true, true, {
			withOrchestrationExit: true,
		});
		await act(async () => button(narratorLocale.orchestrationExit).click());
		// 退出走的是专用回调（服务端据此落回默认模型语义），不是一次模型选择。
		expect(exitOrchestration).toBe(1);
		expect(selected).toEqual([]);
	});

	test("does not offer exiting orchestration outside orchestration mode", async () => {
		await render("a:one", orchestrationModels, true, true, { withOrchestrationExit: true });
		expect(host.textContent).not.toContain(narratorLocale.orchestrationExit);
	});
});

describe("opening selection positioning", () => {
	test.each([
		["a:two", "Two"],
		["__agg__:group", settingsLocale.aggAutoLabel],
		["__agg__:group:a:two", "Provider A · Two"],
		["__agg__:group:removed", "Group"],
		[null, "Follow default"],
	])("centers %s on %s", async (value, label) => {
		await render(value);
		const dropdown = prepareGeometry();
		const index = buttons().indexOf(button(label));
		await flushFrames();
		expect(dropdown.scrollTop).toBe(Math.max(0, index * 100 - 90));
	});
	test("does not recenter on catalog updates; recenters on reopening", async () => {
		await render("a:two");
		const dropdown = prepareGeometry();
		await flushFrames();
		dropdown.scrollTop = 17;
		await render("a:two", [...models]);
		await flushFrames();
		expect(dropdown.scrollTop).toBe(17);
		expect(refreshed).toBe(1);
		await render("a:two", models, false);
		await render("a:two");
		prepareGeometry();
		await flushFrames();
		expect(dropdown.scrollTop).toBe(210);
		expect(refreshed).toBe(2);
	});
	test("quick reopen before unmount also recenters and refreshes once", async () => {
		await render("a:two");
		const dropdown = prepareGeometry();
		await flushFrames();
		dropdown.scrollTop = 17;
		await render("a:two", models, true, false);
		await render("a:two");
		await flushFrames();
		expect(dropdown.scrollTop).toBe(210);
		expect(refreshed).toBe(2);
	});
	test("missing models leave the scroll position alone", async () => {
		await render("missing:model");
		const dropdown = prepareGeometry();
		dropdown.scrollTop = 23;
		await flushFrames();
		expect(dropdown.scrollTop).toBe(23);
	});
	test("closing cancels scheduled centering", async () => {
		await render("a:two");
		const dropdown = prepareGeometry();
		await render("a:two", models, false);
		await flushFrames();
		expect(dropdown.scrollTop).toBe(0);
	});
});
