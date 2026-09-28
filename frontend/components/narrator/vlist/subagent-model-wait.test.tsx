/**
 * 编排 worker 的「模型不可用等待」在父会话里的完整传递链（阶段 6）。
 *
 * 两个 WS 帧（`subagent_model_unavailable_waiting` / `..._recovered`）此前被静默
 * 丢弃，因此这里要钉住三件互相独立的事实：
 *
 *   1. 帧 → 卡片上的运行期标记（`_modelWait`），且**清除是对称的**；
 *   2. 适配器只认这一个来源、且只认运行中的调用；
 *   3. 渲染层只有"编排 worker + 等待中 + 有处理器"三者齐备时，模型 badge 才可点。
 *
 * 第 3 条同时是"非编排 worker 不出现换模型入口"的渲染侧证据：没有处理器时
 * （shell 只对编排 worker 绑定）badge 保持只读。
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import {
	type AdapterToolItem,
	resolveSubagentModelWait,
} from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureSubagentCard, type SubagentCardData } from "./measure/measure-subagent";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { RenderSubagent } from "./render/RenderSubagent";
import { patchSubagentModelWaitByNarrator } from "./vlist-live-patch";

const DIR = import.meta.dir;
const WS = readFileSync(join(DIR, "..", "..", "..", "hooks", "useNarratorWS.ts"), "utf8");
const PANEL_WS = readFileSync(join(DIR, "..", "useNarratorPanelWS.ts"), "utf8");
const LIVE_PATCHES = readFileSync(join(DIR, "useVListLivePatches.ts"), "utf8");

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

/** 最小消息树：一条消息 + 一个带子代理身份的 tool_use 块。 */
function toolDoc(subagentNarratorId: string | null) {
	const block: Record<string, unknown> = {
		type: "tool_use",
		id: "tu-1",
		name: "Task",
		status: "running",
		_subagentActivity: {
			subagentNarratorId,
			model: "provA:quick-a",
			latestToolCalls: [],
		},
	};
	return [
		{
			id: "msg-1",
			role: "assistant",
			contentJson: [block],
			toolCalls: [
				{ toolUseId: "tu-1", status: "running", _subagentActivity: block._subagentActivity },
			],
		},
	] as never;
}

function firstBlock(messages: readonly unknown[]): Record<string, unknown> {
	const message = messages[0] as { contentJson: Record<string, unknown>[] };
	return message.contentJson[0] as Record<string, unknown>;
}

function firstCall(messages: readonly unknown[]): Record<string, unknown> {
	const message = messages[0] as { toolCalls: Record<string, unknown>[] };
	return message.toolCalls[0] as Record<string, unknown>;
}

describe("等待帧 → 卡片上的运行期标记", () => {
	it("等待帧在块与行记录上都落下标记，且不动调用状态", () => {
		const result = patchSubagentModelWaitByNarrator(toolDoc("sub-w"), "sub-w", {
			model: "provA:quick-a",
			waitKind: "quota",
			resumeAt: 1234,
		});
		expect(result.changed).toBe(true);
		expect(firstBlock(result.messages)._modelWait).toEqual({
			model: "provA:quick-a",
			waitKind: "quota",
			resumeAt: 1234,
		});
		expect(firstCall(result.messages)._modelWait).toEqual({
			model: "provA:quick-a",
			waitKind: "quota",
			resumeAt: 1234,
		});
		// 调用仍在运行：等待的是模型恢复，不是这次调用结束了。
		expect(firstBlock(result.messages).status).toBe("running");
	});

	it("恢复帧把标记删掉（否则一个已恢复的 worker 一直带着可点的换模型入口）", () => {
		const waiting = patchSubagentModelWaitByNarrator(toolDoc("sub-w"), "sub-w", {
			model: "provA:quick-a",
			waitKind: "credentials",
		});
		const recovered = patchSubagentModelWaitByNarrator(waiting.messages, "sub-w", null);
		expect(recovered.changed).toBe(true);
		expect("_modelWait" in firstBlock(recovered.messages)).toBe(false);
		expect("_modelWait" in firstCall(recovered.messages)).toBe(false);
	});

	it("重复的同一帧不产生变化（重连不会让整行重建）", () => {
		const wait = { model: "provA:quick-a", waitKind: "credentials" as const };
		const first = patchSubagentModelWaitByNarrator(toolDoc("sub-w"), "sub-w", wait);
		const second = patchSubagentModelWaitByNarrator(first.messages, "sub-w", wait);
		expect(second.changed).toBe(false);
		expect(second.messages).toBe(first.messages);
	});

	it("别的子代理的帧不动这张卡片", () => {
		const doc = toolDoc("sub-w");
		const result = patchSubagentModelWaitByNarrator(doc, "sub-other", { model: "m" });
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(doc);
	});
});

describe("适配器只认那一个来源", () => {
	it("运行中的调用按标记给出等待信息", () => {
		const item = {
			tc: {
				status: "running",
				_modelWait: { model: "provA:quick-a", waitKind: "quota", resumeAt: 9 },
			},
		} as unknown as AdapterToolItem;
		expect(resolveSubagentModelWait(item)).toEqual({
			model: "provA:quick-a",
			waitKind: "quota",
			resumeAt: 9,
		});
	});

	it("终态调用永远不等待（等待只可能发生在运行中的调用上）", () => {
		const item = {
			tc: { status: "success", _modelWait: { model: "provA:quick-a" } },
		} as unknown as AdapterToolItem;
		expect(resolveSubagentModelWait(item)).toBeNull();
	});

	it("活动摘要里的同名事实不会被读走（那会让旧等待在重载后复活）", () => {
		const item = {
			tc: {
				status: "running",
				_subagentActivity: { modelWait: { model: "provA:quick-a" } },
			},
		} as unknown as AdapterToolItem;
		expect(resolveSubagentModelWait(item)).toBeNull();
	});
});

describe("模型 badge 的可点条件", () => {
	const DATA: SubagentCardData = {
		agentType: "orch--abc--quick",
		description: "worker",
		isTerminal: false,
	};

	function renderCard(props: {
		modelWait?: { model: string; waitKind?: "credentials" | "quota"; resumeAt?: number } | null;
		onSwitchWorkerModel?: () => void;
	}): Element {
		const measured = measureSubagentCard({ ...DATA, model: "provA:quick-a" }, 600, 5, {});
		return parse(
			renderToStaticMarkup(
				<MantineProvider>
					<RenderSubagent
						measured={measured}
						description={DATA.description}
						agentType={DATA.agentType}
						model="provA:quick-a"
						modelWait={props.modelWait ?? null}
						onSwitchWorkerModel={props.onSwitchWorkerModel}
						isActive
					/>
				</MantineProvider>,
			),
		);
	}

	it("等待中且绑定了处理器时 badge 可点", () => {
		const root = renderCard({
			modelWait: { model: "provA:quick-a", waitKind: "quota", resumeAt: 1 },
			onSwitchWorkerModel: () => {},
		});
		const badge = root.querySelector('[data-testid="subagent-model"]');
		expect(badge?.getAttribute("data-switchable")).toBe("1");
		expect(badge?.getAttribute("data-waiting")).toBe("1");
		expect(badge?.tagName.toLowerCase()).toBe("button");
	});

	it("非编排 worker（没有处理器）保持只读", () => {
		const root = renderCard({
			modelWait: { model: "provA:quick-a", waitKind: "quota" },
		});
		const badge = root.querySelector('[data-testid="subagent-model"]');
		expect(badge?.getAttribute("data-switchable")).toBeNull();
		expect(badge?.tagName.toLowerCase()).not.toBe("button");
	});

	it("正常态（不在等待）保持只读，即使绑了处理器", () => {
		const root = renderCard({ onSwitchWorkerModel: () => {} });
		const badge = root.querySelector('[data-testid="subagent-model"]');
		expect(badge?.getAttribute("data-switchable")).toBeNull();
		expect(badge?.getAttribute("data-waiting")).toBeNull();
	});
});

describe("事件接线：两个新帧被消费，既有子代理帧不受影响", () => {
	it("useNarratorWS 派发两个新事件", () => {
		expect(WS).toContain('case "subagent_model_unavailable_waiting":');
		expect(WS).toContain('case "subagent_model_unavailable_recovered":');
		// waitKind 必须原样透传：文案要靠它区分"额度用尽"与"凭据不可用"。
		expect(WS).toContain("onSubagentModelUnavailableWaiting?.(");
		expect(WS).toContain("onSubagentModelUnavailableRecovered?.(");
	});

	it("既有子代理事件仍然逐条派发", () => {
		// 新增两个 case 不得挤掉或改写邻居（它们就在这段 switch 的正中间）。
		for (const existing of [
			'case "subagent_started":',
			'case "subagent_suspended":',
			'case "subagent_status_changed":',
			'case "subagent_takeover_changed":',
			'case "subagent_warning":',
			'case "subagent_conclusion_updated":',
		]) {
			expect(WS).toContain(existing);
		}
	});

	it("消息层消费两个帧（落标记 / 清标记）", () => {
		expect(LIVE_PATCHES).toContain("onSubagentModelUnavailableWaiting:");
		expect(LIVE_PATCHES).toContain("onSubagentModelUnavailableRecovered:");
		expect(LIVE_PATCHES).toContain(
			"patchSubagentModelWaitByNarrator(messages, subagentNarratorId, null)",
		);
	});

	it("面板层消费两个帧（子代理行标记 + 可见提示）", () => {
		expect(PANEL_WS).toContain("onSubagentModelUnavailableWaiting:");
		expect(PANEL_WS).toContain("onSubagentModelUnavailableRecovered:");
		// 等待提示是常驻通知（描述一个需要用户决定的状态），恢复提示自动收起。
		expect(PANEL_WS).toContain("autoClose: false");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: assert source text, not interpolation
		expect(PANEL_WS).toContain("subagent-model-unavailable-${subagentNarratorId}");
	});
});
