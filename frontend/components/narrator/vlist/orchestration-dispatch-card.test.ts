/**
 * orchestration-dispatch-card.test.ts —— 编排编制者的派发必须落成一张子代理卡片。
 *
 * 用户的反馈是：编排模式下编制者的派发（`Agent` 工具调用）在会话里看不到卡片。
 * 这份测试从**真实链路**上回答那个问题：`segmentMessages` → `groupRenderUnits` →
 * `adaptRenderUnits` / `buildPretextLayoutManifest`，而消息形状就是 vlist 加载器
 * 真正收到的那一份 —— `enrichToolUseBlocks` + `stripRedundantToolCallRows` 之后
 * （字段都在 `tool_use` 块上，`toolCalls` 已被投影成 `[]`）。
 *
 * 编排派发与普通子代理的差别只在输入：`subagent_type` 是空的（类型由 `tier` 派生）、
 * `tier` 在 schema 里必填、`description` 而**不是**必填（`required: ["tier"]`）。所以
 * 这里刻意用"只有 tier"的最瘦形状作为基线，再逐个加回可选项。
 *
 * 断言两件事，缺一不可：
 *  1. 每一档 LOD 上，每次派发都产生一张**可寻址**的 `subagent-card`
 *     （`data.toolUseId` 指回那次调用），且**没有**被折进 `tool-run-count`
 *     （匿名计数行）或降级成 `activity-trace` 的普通行 —— 那两种形状正是
 *     "看不到卡片"仅有的两种可能；
 *  2. 那张卡片有**非零高度**（真的会被画出来），并带出编排身份（档位 / 子代理 id）。
 *
 * "卡片被折进计数行"这个风险不是假想的：前台阻塞的派发在整个执行期间没有流式输出，
 * 任何"非活动工具就折叠"的规则都会命中它。折叠层两处（`groupToolItemsForLod` 与
 * `isKeptToolItem`）都对 `item.isSubagent` 做了例外，这份测试把那条约定钉在行为上。
 */

import { afterAll, describe, expect, it } from "bun:test";
import type { RenderLod } from "../lod/RenderLodCtx";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { groupRenderUnits } from "../trace/render-units";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextLayoutManifest } from "./pretext-layout-manifest";
import { type AdapterContext, type AdapterRenderUnit, adaptRenderUnits } from "./segment-adapter";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

/** 每一档都要过一遍：折叠规则按 LOD 分支，单档通过说明不了别的档。 */
const ALL_LODS: RenderLod[] = [1, 2, 3, 4, 5];

/** 编排执行者的子代理 narrator（卡片上的 Worker 身份来自它的活动摘要）。 */
const WORKER_NARRATOR_ID = "narrator-worker-1";

/** 子代理活动摘要：vlist 收到的就是这些字段（recent calls + 模型 + 子会话 id）。 */
function workerActivity(tier: string) {
	return {
		subagentNarratorId: WORKER_NARRATOR_ID,
		model: `provA:worker-${tier}`,
		latestToolCalls: [{ toolName: "Read", status: "success" }],
	};
}

type DispatchShape = {
	name: string;
	/** 直接被写进 `tool_use` 块的输入——就是模型实际发出的那份。 */
	input: Record<string, unknown>;
	status?: string;
	/** 覆盖 `_subagentActivity`（默认给一份编排 worker 的活动摘要）。 */
	activity?: unknown;
	/** 挂在该次调用下的子消息（子代理消息树）。 */
	children?: NarratorMsg[];
};

/**
 * 一次编排派发的 `tool_use` 块（vlist 加载器收到的那一份形状）。
 *
 * `tier` 必填而 `description` 可选是编排 schema 的真实形状：`buildRawJsonSchema` 在
 * 编排上下文里把 `required` 收窄成 `["tier"]`。这正是基线用"只有 tier"的原因。
 */
function dispatchBlock(id: string, shape: DispatchShape) {
	const activity =
		shape.activity === undefined
			? workerActivity(String(shape.input.tier ?? "quick"))
			: shape.activity;
	return {
		type: "tool_use",
		id,
		name: "Agent",
		status: shape.status ?? "success",
		input: shape.input,
		inputJson: shape.input,
		outputJson: { _text: '回执：{verdict:"pass"}' },
		...(activity ? { _subagentActivity: activity } : {}),
	};
}

/** 一条 assistant 消息；`toolCalls: []` 与真实投影一致（字段已挪到块上）。 */
function assistantMessage(
	id: string,
	blocks: unknown[],
	children: NarratorMsg[] = [],
): NarratorMsg {
	return {
		id,
		narratorId: "narrator-coordinator",
		parentToolUseId: null,
		role: "assistant",
		contentJson: blocks,
		contentText: null,
		toolCalls: [],
		createdAt: "2026-01-01T00:00:00Z",
		children,
	} as unknown as NarratorMsg;
}

/** 任何普通工具调用（用来给派发制造"被折进 tool-run"的机会）。 */
function readBlock(id: string) {
	return {
		type: "tool_use",
		id,
		name: "Read",
		status: "success",
		input: { file_path: "spec://tasks.json" },
		inputJson: { file_path: "spec://tasks.json" },
	};
}

/** 跑真实链路，返回该 LOD 下的全部 spec。 */
async function specsAt(messages: NarratorMsg[], lod: RenderLod) {
	const segments = segmentMessages(messages);
	const units = groupRenderUnits(segments, lod <= 2).map((unit, index) =>
		unit.kind === "activity"
			? {
					kind: "activity" as const,
					key: `activity-${index}`,
					items: unit.items as never,
					sourceMessages: unit.sourceMessages as never,
				}
			: { kind: "segment" as const, seg: unit.seg as never },
	) as AdapterRenderUnit[];
	return adaptRenderUnits(units, { lod } as AdapterContext);
}

/** 所有 spec 里以行形式出现的 `tool-<id>`（折叠行也在这里暴露身份）。 */
function foldedToolRowIds(specs: readonly { kind: string; data: unknown }[]): string[] {
	const ids: string[] = [];
	for (const spec of specs) {
		const items = (spec.data as { items?: { key?: string }[] }).items;
		if (!Array.isArray(items)) continue;
		for (const row of items) {
			if (row?.key?.startsWith("tool-")) ids.push(row.key.slice("tool-".length));
		}
	}
	return ids;
}

describe("编排派发 → 子代理卡片", () => {
	/**
	 * 基线：只有 `tier`（没有 `description`、没有 `subagent_type`）的派发。
	 * 这是编排 schema 允许的最瘦形状，也是最容易被折叠规则吃掉的一个。
	 */
	it.each(ALL_LODS)("L%s：最瘦的编排派发（只有 tier）仍是一张可寻址的卡片", async (lod) => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-orch", { name: "极简", input: { tier: "quick", prompt: "跑测试" } }),
			]),
		];
		const specs = await specsAt(messages, lod);

		const cards = specs.filter((spec) => spec.kind === "subagent-card");
		expect(cards).toHaveLength(1);
		// 卡片刻意不是匿名计数行。
		expect(specs.map((spec) => spec.kind)).not.toContain("tool-run-count");
		// 可寻址：卡片指回那次调用。
		expect((cards[0]?.data as { toolUseId?: string }).toolUseId).toBe("tu-orch");
	});

	/**
	 * 真实编排会话的形状：编制者一边维护自己的 Dynamic Spec（Read/Write），
	 * 一边在同一个回合里派发。派发必须保持独立卡片，普通调用照旧折叠。
	 */
	it.each(ALL_LODS)("L%s：派发夹在普通工具调用之间也不会被折进计数行", async (lod) => {
		const messages = [
			assistantMessage("m-1", [
				readBlock("tu-read-1"),
				dispatchBlock("tu-orch-1", {
					name: "探查",
					input: { tier: "quick", prompt: "定位限流实现" },
				}),
				readBlock("tu-read-2"),
				dispatchBlock("tu-orch-2", {
					name: "实现",
					input: { tier: "medium", prompt: "实现限流", description: "实现限流" },
				}),
			]),
		];
		const specs = await specsAt(messages, lod);

		const cardIds = specs
			.filter((spec) => spec.kind === "subagent-card")
			.map((spec) => (spec.data as { toolUseId?: string }).toolUseId);
		expect(cardIds).toEqual(["tu-orch-1", "tu-orch-2"]);
		// 两次派发都没被折成行或计数行。
		const folded = foldedToolRowIds(specs);
		expect(folded).not.toContain("tu-orch-1");
		expect(folded).not.toContain("tu-orch-2");
		expect(specs.map((spec) => spec.kind)).not.toContain("tool-run-count");
	});

	/**
	 * 前台阻塞的派发在执行期间一直是 `running`：这正是"非活动工具"折叠规则的
	 * 高危形状，因此每一档都要单独确认。
	 */
	it.each(ALL_LODS)("L%s：仍在执行的派发（running）保持卡片", async (lod) => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-running", {
					name: "在跑",
					input: { tier: "heavy", prompt: "跨模块重构" },
					status: "running",
				}),
			]),
		];
		const specs = await specsAt(messages, lod);
		expect(specs.filter((spec) => spec.kind === "subagent-card")).toHaveLength(1);
		expect(specs.map((spec) => spec.kind)).not.toContain("tool-run-count");
	});

	/** 模型池选不出来的派发会停在 pending（等待用户/上游），同样不能被折掉。 */
	it.each(ALL_LODS)("L%s：等待中的派发（pending）保持卡片", async (lod) => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-pending", {
					name: "等待",
					input: { tier: "quick", prompt: "等一下" },
					status: "pending",
				}),
			]),
		];
		const specs = await specsAt(messages, lod);
		expect(specs.filter((spec) => spec.kind === "subagent-card")).toHaveLength(1);
	});

	/** 子代理消息树挂在该次调用下时（children 非空）也必须仍是卡片。 */
	it.each(ALL_LODS)("L%s：带子消息的派发保持卡片", async (lod) => {
		const child = assistantMessage("child-1", [{ type: "text", text: "执行中" }]);
		const messages = [
			assistantMessage(
				"m-1",
				[dispatchBlock("tu-child", { name: "带子消息", input: { tier: "quick", prompt: "干活" } })],
				[{ ...child, parentToolUseId: "tu-child" } as NarratorMsg],
			),
		];
		const specs = await specsAt(messages, lod);
		expect(specs.filter((spec) => spec.kind === "subagent-card")).toHaveLength(1);
	});

	/** 连活动摘要都拿不到时（服务端还没关联到 worker），卡片也不能消失。 */
	it.each(ALL_LODS)("L%s：没有活动摘要的派发仍是一张卡片", async (lod) => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-no-activity", {
					name: "无摘要",
					input: { tier: "chore", prompt: "bun test" },
					activity: null,
				}),
			]),
		];
		const specs = await specsAt(messages, lod);
		const cards = specs.filter((spec) => spec.kind === "subagent-card");
		expect(cards).toHaveLength(1);
		expect((cards[0]?.data as { toolUseId?: string }).toolUseId).toBe("tu-no-activity");
	});

	/** 一次回合里连续派发多个 worker（编排的常态）：每一个都要有自己的卡片。 */
	it.each(ALL_LODS)("L%s：连续多个派发各自成卡，无一被吞", async (lod) => {
		const ids = ["tu-a", "tu-b", "tu-c"];
		const messages = [
			assistantMessage(
				"m-1",
				ids.map((id, index) =>
					dispatchBlock(id, {
						name: `第 ${index + 1} 个`,
						input: { tier: "quick", prompt: `任务 ${index + 1}` },
					}),
				),
			),
		];
		const specs = await specsAt(messages, lod);
		expect(
			specs
				.filter((spec) => spec.kind === "subagent-card")
				.map((spec) => (spec.data as { toolUseId?: string }).toolUseId),
		).toEqual(ids);
		expect(specs.map((spec) => spec.kind)).not.toContain("tool-run-count");
	});
});

describe("编排派发卡片的载荷", () => {
	/** 档位是编排卡片要回答的第一个问题：本轮用了哪一档。 */
	it("档位从派发输入的 tier 读出（执行者不传 subagent_type）", async () => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-tier", { name: "档位", input: { tier: "heavy", prompt: "干活" } }),
			]),
		];
		const specs = await specsAt(messages, 5);
		const card = specs.find((spec) => spec.kind === "subagent-card");
		expect(card?.data).toMatchObject({ workerTier: "heavy" });
	});

	/**
	 * 复核者的类型编码是档位与角色的权威来源（它由服务端拼出来，不来自模型），
	 * 因此类型编码必须能覆盖输入里缺失的 tier。
	 */
	it("复核者的类型编码同时带出角色与档位", async () => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-reviewer", {
					name: "复核",
					input: { subagent_type: "orch-review--of7k2m9q--heavy", prompt: "复核" },
				}),
			]),
		];
		const specs = await specsAt(messages, 5);
		const card = specs.find((spec) => spec.kind === "subagent-card");
		expect(card?.data).toMatchObject({ workerTier: "heavy", workerKind: "reviewer" });
	});

	/** 卡片要能点进那只 worker：子会话 id 与模型都来自活动摘要。 */
	it("带出子会话 id 与模型", async () => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-id", { name: "身份", input: { tier: "quick", prompt: "干活" } }),
			]),
		];
		const specs = await specsAt(messages, 5);
		const card = specs.find((spec) => spec.kind === "subagent-card");
		expect(card?.data).toMatchObject({
			subagentNarratorId: WORKER_NARRATOR_ID,
			model: "provA:worker-quick",
		});
	});

	/** 没有 `description` 时退到 prompt 摘要，而不是留一行空白（"看不到派发了什么"）。 */
	it("缺少 description 时用 prompt 摘要兜底", async () => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-desc", {
					name: "描述",
					input: { tier: "quick", prompt: "只做这一件事" },
				}),
			]),
		];
		const specs = await specsAt(messages, 5);
		const card = specs.find((spec) => spec.kind === "subagent-card");
		expect((card?.data as { description?: string }).description).toBe("只做这一件事");
	});

	/**
	 * 状态：仍在执行的派发不能被画成"已完成"（`isTerminal`），否则读者会以为结论已经
	 * 到了——编排的整个节奏就是"派发 → 等回执"，把这两态画成一样等于没有状态。
	 */
	it("执行中与已完成的派发在状态字段上可区分", async () => {
		const running = await specsAt(
			[
				assistantMessage("m-1", [
					dispatchBlock("tu-run", {
						name: "在跑",
						input: { tier: "quick", prompt: "干活" },
						status: "running",
					}),
				]),
			],
			5,
		);
		const done = await specsAt(
			[
				assistantMessage("m-1", [
					dispatchBlock("tu-done", { name: "完成", input: { tier: "quick", prompt: "干活" } }),
				]),
			],
			5,
		);
		const dataOf = (specs: Awaited<ReturnType<typeof specsAt>>) =>
			specs.find((spec) => spec.kind === "subagent-card")?.data as { isTerminal?: boolean };
		expect(dataOf(running).isTerminal).toBe(false);
		expect(dataOf(done).isTerminal).toBe(true);
	});

	/**
	 * 可点开：卡片的折叠/展开走 `unitId` 寻址的那条通道（`key === unitId`），
	 * 而 L2 以上默认就是展开的（只有终态的 L1 收成 header）。这是"点得开"的前提——
	 * 若卡片在低 LOD 被折成计数行，就既没有 `unitId` 也没有可点的 header。
	 */
	it("卡片带出可寻址的 unitId，L2 以上默认展开", async () => {
		const messages = [
			assistantMessage("m-1", [
				dispatchBlock("tu-open", { name: "可点开", input: { tier: "quick", prompt: "干活" } }),
			]),
		];
		for (const lod of ALL_LODS) {
			const specs = await specsAt(messages, lod);
			const card = specs.find((spec) => spec.kind === "subagent-card");
			expect(card?.unitId).toBe(card?.key);
			expect(card?.key).toBe("tool-tu-open");
			// `collapsesByLod` 只允许在 L1 收成 header；其余档位保持展开。
			expect(card?.opts?.collapsesByLod).toBe(lod === 1);
		}
	});
});

describe("编排派发卡片真的会被画出来", () => {
	/** 非零高度：行真的存在，而不是一条零高度的"隐身"记录。 */
	it.each(ALL_LODS)("L%s：每次派发的实测高度都大于 0", (lod) => {
		const messages = [
			assistantMessage("m-1", [
				readBlock("tu-read-1"),
				dispatchBlock("tu-orch-1", {
					name: "探查",
					input: { tier: "quick", prompt: "定位限流实现" },
				}),
				dispatchBlock("tu-orch-2", {
					name: "实现",
					input: { tier: "medium", prompt: "实现限流", description: "实现限流" },
				}),
				readBlock("tu-read-2"),
			]),
		];
		const segments = segmentMessages(messages);
		const units = groupRenderUnits(segments, lod <= 2).map((unit, index) =>
			unit.kind === "activity"
				? {
						kind: "activity" as const,
						key: `activity-${index}`,
						items: unit.items,
						sourceMessages: unit.sourceMessages,
					}
				: { kind: "segment" as const, seg: unit.seg },
		) as unknown as AdapterRenderUnit[];
		const built = buildPretextLayoutManifest({
			layoutRevision: `orch-dispatch-${lod}`,
			documentRevision: 1,
			lod,
			widthBucket: "600",
			renderUnits: units,
			contentWidth: 600,
			viewportHeight: 720,
			resolveSource: () => ({ firstSeq: 1, lastSeq: 1, sourceMessageIds: ["m-1"] }),
		});

		const cards = built.items.filter((item) => item.spec.kind === "subagent-card");
		expect(cards.map((item) => (item.spec.data as { toolUseId?: string }).toolUseId)).toEqual([
			"tu-orch-1",
			"tu-orch-2",
		]);
		for (const card of cards) {
			expect(card.measured.height).toBeGreaterThan(0);
		}
	});
});
