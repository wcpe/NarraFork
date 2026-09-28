import { describe, expect, test } from "bun:test";
import {
	buildAggModelValue,
	buildOrchestrationModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelAggregation,
} from "../../../lib/constants";
import {
	applyModelMenuMaxHeight,
	canAssignGlobalModelRole,
	centerModelMenuSelection,
	MODEL_MENU_POSITIONING,
	modelMenuSelection,
	modelProviderPrefix,
	shouldAutoFocusModelFilter,
} from "./model-menu-selection";

const aggregations: ModelAggregation[] = [
	{ id: "group", name: "Group", models: ["a:model", "b:model:variant"], routingMode: "priority" },
];

describe("model menu selection", () => {
	test.each([
		null,
		undefined,
		"",
		FOLLOW_DEFAULT_MODEL,
	])("normalizes default selection %s", (value) => {
		expect(modelMenuSelection(value, aggregations).targetValue).toBe(FOLLOW_DEFAULT_MODEL);
	});
	test("keeps ordinary and summary model values", () => {
		for (const value of ["a:model", "__summary__", FOLLOW_PARENT_MODEL, "removed:model"]) {
			expect(modelMenuSelection(value, aggregations).targetValue).toBe(value);
		}
	});
	test("resolves automatic aggregation and exposes members", () => {
		const selection = modelMenuSelection(buildAggModelValue("group"), aggregations);
		expect(selection.targetValue).toBe("__agg__:group");
		expect(selection.members).toEqual(aggregations[0].models);
	});
	test("preserves pinned member including embedded colons", () => {
		const value = buildAggModelValue("group", "b:model:variant");
		expect(modelMenuSelection(value, aggregations).targetValue).toBe(value);
	});
	test("falls back to aggregation for missing members or configuration", () => {
		expect(modelMenuSelection("__agg__:group:missing:model", aggregations).targetValue).toBe(
			"__agg__:group",
		);
		expect(modelMenuSelection("__agg__:group:a:model", []).targetValue).toBe("__agg__:group");
	});
	test("recognizes an orchestration value and keeps it intact", () => {
		const value = buildOrchestrationModelValue("prof1");
		const selection = modelMenuSelection(value, aggregations);
		expect(selection.isOrchestration).toBe(true);
		expect(selection.orchestrationProfileId).toBe("prof1");
		// 编排值是会话的当前状态，不能被折叠成聚合根或跟随默认。
		expect(selection.value).toBe(value);
		expect(selection.baseValue).toBe(value);
		expect(selection.targetValue).toBe(value);
		expect(selection.members).toEqual([]);
	});
	test("does not mistake the other sentinels or concrete models for orchestration", () => {
		for (const value of [
			"a:model",
			FOLLOW_DEFAULT_MODEL,
			FOLLOW_SUMMARY_MODEL,
			FOLLOW_PARENT_MODEL,
			buildAggModelValue("group"),
			// 前缀单独出现（没有 profileId）不是编排值：服务端同样不认。
			"__orch__",
		]) {
			const selection = modelMenuSelection(value, aggregations);
			expect(selection.isOrchestration).toBe(false);
			expect(selection.orchestrationProfileId).toBeNull();
		}
	});
});

describe("model provider prefix for role rows", () => {
	test("extracts the provider prefix from a concrete model value", () => {
		expect(modelProviderPrefix("codex:gpt-6-astra")).toBe("codex");
		expect(modelProviderPrefix("xiaomi:codex:gpt-6-astra")).toBe("xiaomi");
		expect(modelProviderPrefix("a:model:variant")).toBe("a");
	});
	test("returns null for empty values and meta sentinels", () => {
		expect(modelProviderPrefix(null)).toBeNull();
		expect(modelProviderPrefix(undefined)).toBeNull();
		expect(modelProviderPrefix("")).toBeNull();
		expect(modelProviderPrefix("no-colon")).toBeNull();
		expect(modelProviderPrefix(FOLLOW_DEFAULT_MODEL)).toBeNull();
		expect(modelProviderPrefix(FOLLOW_SUMMARY_MODEL)).toBeNull();
		expect(modelProviderPrefix(FOLLOW_PARENT_MODEL)).toBeNull();
		expect(modelProviderPrefix(buildAggModelValue("group"))).toBeNull();
		expect(modelProviderPrefix(buildAggModelValue("group", "a:model"))).toBeNull();
	});
});

describe("global model role assignment", () => {
	test("rejects empty values and meta sentinels", () => {
		expect(canAssignGlobalModelRole(null)).toBe(false);
		expect(canAssignGlobalModelRole(undefined)).toBe(false);
		expect(canAssignGlobalModelRole("")).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_DEFAULT_MODEL)).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_SUMMARY_MODEL)).toBe(false);
		expect(canAssignGlobalModelRole(FOLLOW_PARENT_MODEL)).toBe(false);
	});
	test("rejects orchestration values", () => {
		// 编排哨兵不是模型：写进全局槽位后全局默认/摘要都解析不出东西，
		// 而错误会在会话装配时以另一个名字炸出来。
		expect(canAssignGlobalModelRole(buildOrchestrationModelValue("prof1"))).toBe(false);
	});
	test("allows concrete models and aggregation roots", () => {
		expect(canAssignGlobalModelRole("xiaomi:mimo-x-pro-preview")).toBe(true);
		expect(canAssignGlobalModelRole(buildAggModelValue("group"))).toBe(true);
	});
});

describe("dropdown-only centering", () => {
	function center(rowTop: number, scrollTop = 0, scrollHeight = 2000) {
		const container = {
			scrollTop,
			scrollHeight,
			clientHeight: 400,
			clientTop: 1,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLElement;
		const item = { getBoundingClientRect: () => ({ top: rowTop, height: 32 }) } as HTMLElement;
		centerModelMenuSelection(container, item, 48);
		return container.scrollTop;
	}
	test("centers in viewport above sticky search footer", () => {
		expect(center(1000)).toBe(739);
		expect(center(700, 300)).toBe(739);
	});
	test("clamps to both scroll boundaries and handles short lists", () => {
		expect(center(101)).toBe(0);
		expect(center(3000)).toBe(1600);
		expect(center(200, 0, 200)).toBe(0);
	});
});

test("both statusbar variants wire aggregation controls inside the model dropdown", async () => {
	// The model dropdown lives in the interaction status bar (both desktop and
	// mobile variants), not NarratorPanel.
	const statusBar = await Bun.file(
		new URL("../interaction/NarratorInteractionStatusBar.tsx", import.meta.url),
	).text();
	expect(statusBar).not.toContain("AggProviderSwitcher");
	expect(statusBar.match(/data-model-menu-scroll/g)).toHaveLength(2);
	expect(
		statusBar.match(
			/<ModelMenuItems\s+opened=\{menuOpen(?:Desktop|Mobile)\}\s+aggregations=\{model\.aggregations\}/g,
		),
	).toHaveLength(2);
});

describe("model menu viewport fitting", () => {
	test("clamps the dropdown to the visible height left above the keyboard", () => {
		const floating = { style: {} as { maxHeight?: string } } as HTMLElement;
		applyModelMenuMaxHeight(floating, 173.6);
		expect(floating.style.maxHeight).toBe("min(60vh, 173px)");
		applyModelMenuMaxHeight(floating, 10);
		expect(floating.style.maxHeight).toBe("min(60vh, 96px)");
	});

	test("lets the dropdown flip while open and sizes it through floating-ui", () => {
		expect(MODEL_MENU_POSITIONING.preventPositionChangeWhenVisible).toBe(false);
		const floating = { style: {} as { maxHeight?: string } } as HTMLElement;
		MODEL_MENU_POSITIONING.middlewares.size.apply({
			elements: { floating },
			availableHeight: 240,
		} as unknown as Parameters<typeof MODEL_MENU_POSITIONING.middlewares.size.apply>[0]);
		expect(floating.style.maxHeight).toBe("min(60vh, 240px)");
	});

	test("does not auto-focus the search field on touch devices", () => {
		const win = (matches: boolean) => ({ matchMedia: () => ({ matches }) }) as unknown as Window;
		expect(shouldAutoFocusModelFilter(win(true))).toBe(false);
		expect(shouldAutoFocusModelFilter(win(false))).toBe(true);
	});
});

test("every model dropdown uses the viewport-aware positioning", async () => {
	for (const file of [
		"../interaction/NarratorInteractionStatusBar.tsx",
		"../compact/compact-summary-modal.tsx",
	]) {
		const source = await Bun.file(new URL(file, import.meta.url)).text();
		expect(source.match(/data-model-menu-scroll/g)?.length).toBe(
			source.match(/\{\.\.\.MODEL_MENU_POSITIONING\}/g)?.length,
		);
	}
});
