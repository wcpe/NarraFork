/**
 * RenderSubagent.worker-identity.test.tsx —— 编排派发的卡片必须"看得出身份"。
 *
 * 用户的反馈是：卡片在，但类型 chip 上写的是工具名 `Agent`，看不出这是哪个档位的
 * 哪个 worker。根因在载荷而不是折叠规则：编排模式里 `subagent_type` 刻意留空
 * （类型由 `tier` 派生，见 task.ts 的 `buildParameters`），于是
 * `segment-adapter` 的 `agentType` 回退成 `item.tc.toolName` —— 而 `Agent` 工具
 * 的 `name` 就是 `"Agent"`。复核者那边是另一种失败：chip 上写的是原始编码串
 * `orch--…`/`orch-review--…`，同样看不出角色。
 *
 * 这份测试钉住三件事：
 *  1. **能证伪**：编排派发的卡片不显示 `"Agent"` 字面量，而显示角色 + 档位；
 *     执行者与复核者必须**不同**（判错角色比没有标识更糟）。
 *  2. **不影响别人**：非编排子代理的 chip 逐字仍是它自己的类型名，一个字节不变。
 *  3. **高度中性**：身份只替换既有 badge 的文字，不新增元素、不动固定的 badge 行；
 *     测量层对同一份载荷算出的高度与改动前完全一致。
 *
 * 主链路刻意走**真实管线**：`segmentMessages` → `adaptSegments`（拿到与线上同形的
 * 载荷）→ `resolveRenderExtra` + `renderElement`（与线上同一条 `extra` 构建与渲染
 * 分发）。手写 props 的测试证明不了"数据到得了渲染层"——而 `workerKind` 恰恰就是
 * 在"到了 extra 却没送到组件"这条缝里漏掉的。
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import narratorEn from "../../../../locales/en/narrator.json";
import narratorZh from "../../../../locales/zh-CN/narrator.json";
import { segmentMessages } from "../../message/message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import {
	badgeRowHeight,
	measureSubagentCard,
	type SubagentCardData,
} from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { renderElement, resolveRenderExtra } from "../render-registry";
import type { AdapterContext, AdapterSegment } from "../segment-adapter";

let parse: (html: string) => Element;

beforeAll(() => {
	installCanvasStub();
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const WIDTH = 600;
const LOD = 5;

/** 一条 assistant 消息：`tool_use` 块上的 `inputJson` 就是模型实际发出的参数。 */
function assistantMessage(
	id: string,
	toolUseId: string,
	input: Record<string, unknown>,
): NarratorMsg {
	const block = {
		type: "tool_use",
		id: toolUseId,
		name: "Agent",
		input,
		inputJson: input,
		status: "success",
	};
	return {
		id,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [block],
		contentText: null,
		toolCalls: [
			{
				id: `tc-${toolUseId}`,
				narratorId: "n1",
				messageId: id,
				toolUseId,
				toolName: "Agent",
				createdAt: "2026-01-01T00:00:00.000Z",
				inputJson: input,
				status: "success",
			},
		],
		createdAt: "2026-01-01T00:00:00.000Z",
		children: [],
	} as unknown as NarratorMsg;
}

/** 真实管线：派发输入 → 卡片载荷（`adaptSegments` 出来的那一份）。 */
async function cardPayloadOf(input: Record<string, unknown>): Promise<SubagentCardData> {
	const segments = segmentMessages([
		assistantMessage("m1", "tu-agent", input),
	]) as unknown as AdapterSegment[];
	const { adaptSegments } = await import("../segment-adapter");
	const spec = adaptSegments(segments, { lod: LOD } as AdapterContext).find(
		(item) => item.kind === "subagent-card",
	);
	if (!spec) throw new Error("派发没有渲染出 subagent-card");
	return spec.data as SubagentCardData;
}

const zhRoleLabels = {
	workerExecutor: narratorZh.orchestrationRole_executor,
	workerReviewer: narratorZh.orchestrationRole_reviewer,
	workerTier: {
		chore: narratorZh.orchestrationTier_chore,
		quick: narratorZh.orchestrationTier_quick,
		medium: narratorZh.orchestrationTier_medium,
		heavy: narratorZh.orchestrationTier_heavy,
	},
};

/** 走线上同一条路：载荷 → 测量 → `resolveRenderExtra` → `renderElement`。 */
function renderCard(data: SubagentCardData, labels?: unknown): Element {
	const measured = measureSubagentCard(data, WIDTH, LOD, {});
	const extra = resolveRenderExtra({ kind: "subagent-card", data, opts: { labels } });
	return parse(
		renderToStaticMarkup(
			<MantineProvider>{renderElement("subagent-card", measured, extra)}</MantineProvider>,
		),
	);
}

/** chip 上的字（身份 chip 与档位 badge 各自可寻址）。 */
const identityText = (root: Element) =>
	root.querySelector('[data-testid="subagent-agent-type"]')?.textContent ?? null;
const tierText = (root: Element) =>
	root.querySelector('[data-testid="subagent-worker-tier"]')?.textContent ?? null;

describe("编排派发的卡片——身份 chip", () => {
	it("执行者：显示角色与档位，绝不显示工具名 Agent", async () => {
		// 编排执行者的真实输入形状：只有 `tier`（`subagent_type` 刻意留空）。
		const data = await cardPayloadOf({ tier: "heavy", prompt: "跨模块重构" });
		const root = renderCard(data, zhRoleLabels);

		expect(identityText(root)).toBe(narratorZh.orchestrationRole_executor);
		expect(tierText(root)).toBe(narratorZh.orchestrationTier_heavy);
		// 这就是用户看到的那件事：整个卡片里不该再出现 `Agent` 这个工具名。
		expect(root.textContent).not.toContain("Agent");
	});

	it("复核者：显示复核者，且与执行者不是同一句话", async () => {
		// 复核者的类型编码由服务端拼出来（不来自模型），角色与档位都从它解析。
		const data = await cardPayloadOf({
			subagent_type: "orch-review--of7k2m9q--heavy",
			prompt: "复核这次改动",
		});
		const root = renderCard(data, zhRoleLabels);

		expect(identityText(root)).toBe(narratorZh.orchestrationRole_reviewer);
		expect(tierText(root)).toBe(narratorZh.orchestrationTier_heavy);
		// 判错角色比没有标识更糟，所以两个角色必须真的不同。
		expect(narratorZh.orchestrationRole_reviewer).not.toBe(narratorZh.orchestrationRole_executor);
		// 原始编码串同样不该出现在 chip 上。
		expect(identityText(root)).not.toContain("orch");
	});

	it("编码形状的执行者（orch--<profile>--<tier>）同样显示执行者", async () => {
		const data = await cardPayloadOf({
			subagent_type: "orch--of7k2m9q--quick",
			prompt: "定位限流实现",
		});
		expect(data.workerKind).toBe("executor");
		expect(identityText(renderCard(data, zhRoleLabels))).toBe(
			narratorZh.orchestrationRole_executor,
		);
	});

	it("英文兜底：没有 labels 时用内置的 Executor / Reviewer", async () => {
		const executor = await cardPayloadOf({ tier: "quick", prompt: "干活" });
		expect(identityText(renderCard(executor))).toBe(narratorEn.orchestrationRole_executor);
		const reviewer = await cardPayloadOf({
			subagent_type: "orch-review--of7k2m9q--quick",
			prompt: "复核",
		});
		expect(identityText(renderCard(reviewer))).toBe(narratorEn.orchestrationRole_reviewer);
	});
});

describe("非编排子代理的 chip —— 逐字不变", () => {
	/**
	 * 这些类型名是既有行为：`subagent_type` 在时 chip 就画它。身份只在**编排派发**
	 * 上接管（判定只认 `workerTier`，而 `tier` 参数只存在于编排上下文的 schema）。
	 */
	const TYPES = ["explore", "plan", "general", "review", "send"];

	it.each(TYPES)("%s：chip 逐字就是它自己的类型名，也没有档位 badge", async (type) => {
		const data = await cardPayloadOf({ subagent_type: type, prompt: "干活" });
		const root = renderCard(data, zhRoleLabels);

		expect(identityText(root)).toBe(type);
		expect(tierText(root)).toBeNull();
		// 两个角色文案一个都不能出现——否则说明身份在非编排卡片上接管了。
		expect(root.textContent).not.toContain(narratorZh.orchestrationRole_executor);
		expect(root.textContent).not.toContain(narratorZh.orchestrationRole_reviewer);
	});

	it("模型 / 思考强度 badge 与身份无关，照常各自显示", async () => {
		const data = await cardPayloadOf({ subagent_type: "explore", prompt: "干活" });
		const root = renderCard({ ...data, model: "provA:m", reasoningEffort: "high" }, zhRoleLabels);
		expect(identityText(root)).toBe("explore");
		expect(root.querySelector('[data-testid="subagent-model"]')?.textContent).toBe("provA:m");
		expect(root.querySelector('[data-testid="subagent-reasoning-effort"]')?.textContent).toBe(
			"high",
		);
	});
});

describe("身份 chip 是高度中性的", () => {
	/** 身份与工具名都画在同一处：chip 的行内元素个数不变，只换文字。 */
	it("身份 chip 骑在既有的固定高度 badge 行里（行高由测量层写死）", () => {
		const data: SubagentCardData = { agentType: "Agent", description: "干活", isTerminal: true };
		const root = renderCard({ ...data, workerTier: "heavy" }, zhRoleLabels);
		const chip = root.querySelector('[data-testid="subagent-agent-type"]');
		expect(chip).not.toBeNull();
		const row = chip?.parentElement;
		// 这一行的高度是 `badgeRowHeight()`，与行内画几个 badge、每个多长都无关。
		expect(parseFloat((row as HTMLElement).style.height)).toBe(badgeRowHeight());
	});

	/**
	 * 同一份载荷，无论 chip 上画的是"角色名"还是回退出来的工具名，测量结果必须一致。
	 * 测量层从不读标签文本（`headerHeight` 里没有 badge 的位置），因此这条同时钉住了
	 * "将来也不能把身份挪到一个被测量的块里"。
	 */
	it("同一份载荷的实测高度与 chip 画什么字无关", () => {
		const data: SubagentCardData = { agentType: "Agent", description: "干活", isTerminal: true };
		const asToolName = measureSubagentCard(data, WIDTH, LOD, {});
		const asExecutor = measureSubagentCard({ ...data, workerTier: "heavy" }, WIDTH, LOD, {});
		expect(asExecutor.height).toBe(asToolName.height);
		expect(asExecutor.headerHeight).toBe(asToolName.headerHeight);
	});
});

/** 载荷侧：身份的两个来源都必须能从**真实管线**读出来。 */
describe("身份载荷的来源", () => {
	it("执行者：subagent_type 留空、只有 tier", async () => {
		const data = await cardPayloadOf({ tier: "medium", prompt: "改一下" });
		expect(data.workerTier).toBe("medium");
		// 类型编码是角色唯一的权威来源，执行者这边本来就没有它。
		expect(data.workerKind).toBeUndefined();
		// `agentType` 依旧是回退出来的工具名——它不给展示用，只给"换模型继续"的
		// 资格判定与复核者识别用，因此刻意不动。
		expect(data.agentType).toBe("Agent");
	});

	it("复核者：类型编码同时带出角色与档位", async () => {
		const data = await cardPayloadOf({
			subagent_type: "orch-review--of7k2m9q--heavy",
			prompt: "复核",
		});
		expect(data.workerKind).toBe("reviewer");
		expect(data.workerTier).toBe("heavy");
	});

	it("非编排子代理既没有档位也没有角色", async () => {
		const data = await cardPayloadOf({ subagent_type: "general", prompt: "干活" });
		expect(data.workerTier).toBeUndefined();
		expect(data.workerKind).toBeUndefined();
	});
});
