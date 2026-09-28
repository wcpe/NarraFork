import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

// 查询定时器策略在模块加载时决定，因此先装 DOM 再 import 真实的 QueryClient / hook，
// 与 useGitWorkspace.test.tsx 的做法一致。
const globalKeys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = globalKeys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: false,
});

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { ORCHESTRATION_PROVIDER_KEY } = await import("../lib/constants");
const { api } = await import("../lib/api");
const { getConfiguredFallbackModels, getOrchestrationModelOptions, useAllModels } = await import(
	"./useModels"
);

/** 一份四档齐全的最小方案。 */
function profile(overrides: Record<string, unknown> = {}) {
	return {
		id: "prof1",
		name: "Team profile",
		enabled: true,
		review: {
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: {
			chore: { pool: [{ model: "a:one" }] },
			quick: { pool: [] },
			medium: { pool: [{ model: "a:two" }, { model: "a:three" }] },
			heavy: { pool: [{ model: "a:two" }] },
		},
		...overrides,
	};
}

function orchestrationSettings(
	orchestration: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		agent: {
			orchestration: {
				orchestratorModels: ["a:one"],
				profiles: [profile()],
				...orchestration,
			},
		},
	};
}

afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("orchestration model options", () => {
	test("synthesizes an option per enabled profile with complete tiers", () => {
		const options = getOrchestrationModelOptions(orchestrationSettings());
		expect(options).toHaveLength(1);
		const [option] = options;
		expect(option).toMatchObject({
			value: "__orch__:prof1",
			label: "Team profile",
			provider: ORCHESTRATION_PROVIDER_KEY,
		});
		// 编制者模型与四档池明细随选项一起送到菜单行（菜单分组后只拿得到 ModelOption）。
		expect(option.orchestration).toEqual({
			id: "prof1",
			name: "Team profile",
			orchestratorModels: ["a:one"],
			tierPools: { chore: ["a:one"], quick: [], medium: ["a:two", "a:three"], heavy: ["a:two"] },
		});
	});

	test("carries the description when present", () => {
		const options = getOrchestrationModelOptions(
			orchestrationSettings({ profiles: [profile({ description: "  for reviews  " })] }),
		);
		expect(options[0]?.orchestration?.description).toBe("for reviews");
	});

	test("omits disabled profiles", () => {
		const options = getOrchestrationModelOptions(
			orchestrationSettings({ profiles: [profile({ enabled: false })] }),
		);
		expect(options).toEqual([]);
	});

	test("omits profiles missing any tier", () => {
		// 故意缺 heavy 一档：缺档的方案在服务端会被丢掉，菜单里也不该出现。
		const incomplete = {
			...profile(),
			tiers: {
				chore: { pool: [] },
				quick: { pool: [] },
				medium: { pool: [] },
			},
		};
		expect(getOrchestrationModelOptions(orchestrationSettings({ profiles: [incomplete] }))).toEqual(
			[],
		);
	});

	test("offers nothing while orchestration has no orchestrator model", () => {
		// 没有编制者模型等于功能关闭：服务端 PATCH 一定拒绝进入，给出一个永远选不中的
		// 选项只会让用户拿到一条看不懂的报错。
		expect(getOrchestrationModelOptions(orchestrationSettings({ orchestratorModels: [] }))).toEqual(
			[],
		);
		expect(
			getOrchestrationModelOptions(orchestrationSettings({ orchestratorModels: ["  "] })),
		).toEqual([]);
	});

	test("falls back to the id when a profile has no name and de-duplicates ids", () => {
		const options = getOrchestrationModelOptions(
			orchestrationSettings({
				profiles: [profile({ name: "   " }), profile({ id: "prof1" }), profile({ id: "prof2" })],
			}),
		);
		expect(options.map((option) => option.value)).toEqual(["__orch__:prof1", "__orch__:prof2"]);
		expect(options[0]?.label).toBe("prof1");
	});

	test("tolerates missing or malformed settings", () => {
		expect(getOrchestrationModelOptions(undefined)).toEqual([]);
		expect(getOrchestrationModelOptions({})).toEqual([]);
		expect(getOrchestrationModelOptions({ agent: { orchestration: "nope" } })).toEqual([]);
		expect(
			getOrchestrationModelOptions({ agent: { orchestration: { profiles: "nope" } } }),
		).toEqual([]);
	});
});

describe("orchestration values versus configured fallback models", () => {
	test("the fallback builder drops orchestration values instead of transporting them", () => {
		// 这条断言说明为什么编排选项必须在 getConfiguredFallbackModels **之外**合成：
		// 该函数只认「已配置的 provider 前缀」，编排值在那里连一道过滤都过不了，
		// 静默地什么都不剩——菜单上就永远看不到编排分组。
		const settings = orchestrationSettings();
		expect(getConfiguredFallbackModels(settings)).toEqual([]);
		expect(getOrchestrationModelOptions(settings).map((option) => option.value)).toEqual([
			"__orch__:prof1",
		]);
	});
});

describe("useAllModels menu data source", () => {
	let root: Root | undefined;
	let client: InstanceType<typeof QueryClient>;
	let container: HTMLElement;

	async function flush() {
		for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	}

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	});

	afterEach(async () => {
		root?.unmount();
		root = undefined;
		// 让 React 调度器里已排队的回调在当前 DOM 下跑完：全局 window 被 afterAll
		// 撤掉之后，残留回调会抛 "window is not defined" 污染测试输出。
		await flush();
		container.remove();
		client.clear();
	});

	test("appends orchestration options to the menu models and keeps them out of groupedModels", async () => {
		spyOn(api, "getSettings").mockResolvedValue(
			orchestrationSettings({
				profiles: [profile(), profile({ id: "prof2", enabled: false })],
			}) as never,
		);

		function Probe() {
			const { menuModels, groupedModels, orchestrationOptions } = useAllModels();
			return (
				<output>
					{JSON.stringify({
						menu: menuModels.map((option) => option.value),
						grouped: groupedModels.flatMap((group) => group.items.map((item) => item.value)),
						orchestration: orchestrationOptions.map((option) => option.value),
					})}
				</output>
			);
		}

		root = createRoot(container);
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		);
		await flush();

		const text = container.querySelector("output")?.textContent ?? "";
		const result = JSON.parse(text) as {
			menu: string[];
			grouped: string[];
			orchestration: string[];
		};
		expect(result.orchestration).toEqual(["__orch__:prof1"]);
		expect(result.menu).toContain("__orch__:prof1");
		// groupedModels 被设置页的全局默认/摘要选择器共用：编排值出现在那里会被
		// 写进一个解析不出模型的全局槽位。
		expect(result.grouped).not.toContain("__orch__:prof1");
	});
});
