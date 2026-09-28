/**
 * RenderSubagent.worker-tier.test.tsx — 编排 worker 的档位 badge。
 *
 * 两件事一起钉住，因为它们合起来才构成"用户能看到本轮用了哪个档位"：
 *
 *  1. **载荷**：档位从哪来。执行者在编排模式下**不传** `subagent_type`（类型由
 *     `tier` 派生，见 task.ts 的 schema 描述），因此只认类型编码会让绝大多数编排
 *     卡片没有档位——而这个 badge 正是要回答"本轮用了哪档"，没有它就等于没做。
 *  2. **渲染**：只有编排 worker 才画。普通子代理拿到 undefined，它不能占用一个
 *     "看起来同样权威"的位置。
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import narratorZh from "../../../../locales/zh-CN/narrator.json";
import { measureSubagentCard, type SubagentCardData } from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderSubagent } from "./RenderSubagent";

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
const DATA: SubagentCardData = {
	agentType: "explore",
	description: "Implement the parser",
	isTerminal: true,
};

function renderCard(extra: { workerTier?: string; labels?: Record<string, unknown> }): Element {
	const measured = measureSubagentCard({ ...DATA, ...extra }, WIDTH, LOD, {});
	return parse(
		renderToStaticMarkup(
			<MantineProvider>
				<RenderSubagent
					measured={measured}
					description={DATA.description}
					agentType={DATA.agentType}
					model="provA:worker"
					workerTier={extra.workerTier}
					// biome-ignore lint/suspicious/noExplicitAny: labels bundle passthrough.
					labels={extra.labels as any}
					isActive={false}
				/>
			</MantineProvider>,
		),
	);
}

const tierBadgeText = (root: Element) =>
	root.querySelector('[data-testid="subagent-worker-tier"]')?.textContent;

describe("RenderSubagent — 编排档位 badge", () => {
	it("编排 worker 画出本地化的档位标识", () => {
		const root = renderCard({
			workerTier: "quick",
			labels: { workerTier: { quick: narratorZh.orchestrationTier_quick } },
		});
		expect(tierBadgeText(root)).toBe(narratorZh.orchestrationTier_quick);
	});

	it("没有档位（非编排子代理）时完全不画", () => {
		const root = renderCard({});
		expect(root.querySelector('[data-testid="subagent-worker-tier"]')).toBeNull();
		// 其余 badge 不受影响：模型 badge 照常在。
		expect(root.querySelector('[data-testid="subagent-model"]')).not.toBeNull();
	});

	it("识别不出的档位值不画（宁缺勿错）", () => {
		const root = renderCard({ workerTier: "turbo", labels: {} });
		expect(root.querySelector('[data-testid="subagent-worker-tier"]')).toBeNull();
	});

	it("英文兜底：没有 labels 时用内置的档位名", () => {
		const root = renderCard({ workerTier: "heavy" });
		expect(tierBadgeText(root)).toBe("Heavy");
	});

	it("只本地化了一部分档位时，其余档位仍有兜底文案（深合并）", () => {
		// labels 是浅合并的，这一项若不做深合并，缺的那三档会静默变成 undefined
		// ——badge 直接消失，看起来像"这不是编排 worker"。
		const root = renderCard({
			workerTier: "medium",
			labels: { workerTier: { quick: narratorZh.orchestrationTier_quick } },
		});
		expect(tierBadgeText(root)).toBe("Medium");
	});

	it("高度中性：档位 badge 骑在既有的固定 badge 行上", () => {
		const withTier = measureSubagentCard({ ...DATA, workerTier: "quick" }, WIDTH, LOD, {});
		const without = measureSubagentCard({ ...DATA }, WIDTH, LOD, {});
		expect(withTier.height).toBe(without.height);
	});
});

/**
 * 载荷侧的断言：档位必须能从**派发输入**读出来。
 *
 * 用真实的 segmentMessages → adaptSegments 管线，而不是手写一个 payload：手写的那份
 * 只能证明"如果能到这里就能显示"，而这里要防的恰恰是"数据根本到不了"。
 */
describe("subagent card payload — 档位来源", () => {
	type Msg = import("@frontend/lib/api").TreeMessage;

	/** 一次 Agent 工具调用，`input` 就是模型实际发出的参数。 */
	async function cardDataOf(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { segmentMessages } = await import("../../message/message-segments");
		const { adaptSegments } = await import("../segment-adapter");
		const blocks = {
			type: "tool_use",
			id: "tu-agent",
			name: "Agent",
			input,
			inputJson: input,
			status: "success",
		};
		const messages = [
			{
				id: "m1",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentJson: [blocks],
				contentText: null,
				toolCalls: [
					{
						id: "tc-agent",
						narratorId: "n1",
						messageId: "m1",
						toolUseId: "tu-agent",
						toolName: "Agent",
						createdAt: "2026-01-01T00:00:00.000Z",
						inputJson: input,
						status: "success",
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
				children: [],
			} as unknown as Msg,
		];
		type Seg = import("../segment-adapter").AdapterSegment;
		const segments = segmentMessages(messages) as unknown as Seg[];
		const spec = adaptSegments(segments, { lod: LOD }).find(
			(item) => item.kind === "subagent-card",
		);
		if (!spec) throw new Error("没有渲染出 subagent-card");
		return spec.data as Record<string, unknown>;
	}

	it("执行者：只有 tier（没有 subagent_type）时仍然带出档位", async () => {
		const data = await cardDataOf({ tier: "medium", prompt: "改一下" });
		expect(data.workerTier).toBe("medium");
	});

	it("非编排子代理：既没有 tier 也没有类型编码时不带档位", async () => {
		const data = await cardDataOf({ subagent_type: "explore", prompt: "看看" });
		expect(data.workerTier).toBeUndefined();
	});

	it("显式类型编码（复核者）时档位由类型编码解析", async () => {
		const data = await cardDataOf({
			subagent_type: "orch-review--of7k2m9q--heavy",
			prompt: "复核",
		});
		expect(data.workerTier).toBe("heavy");
		expect(data.workerKind).toBe("reviewer");
	});

	it("非法档位值不被透传（脏数据不会变成可信的标识）", async () => {
		const data = await cardDataOf({ tier: "turbo", prompt: "改一下" });
		expect(data.workerTier).toBeUndefined();
	});
});
