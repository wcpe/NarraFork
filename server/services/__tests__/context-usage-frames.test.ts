/**
 * `context_usage` 的两份副本（父级 / 子代理自己）。
 *
 * 这条边界错了不会报类型错、也不会让别的测试变红，表现只有两种，都很安静：
 * - 父级那份少一个 `subagentNarratorId` → 编排面板永远显示「未知上下文」（它只能
 *   整条丢掉那条帧，因为无从知道占用率属于哪只 worker）；
 * - 子代理那份多一个 `subagentNarratorId` → 子代理页面把这一行当成"某个 tool_use
 *   的子行"，而那个 tool_use 在它那一侧不存在，于是这一行永远不显示。
 *
 * 因此这里逐字段钉住两份的差别：**只有父级那份带链接字段**。
 */

import { describe, expect, test } from "bun:test";
import { buildContextUsageFrames } from "../narrator-event-handler";

const base = {
	broadcastTargetId: "parent-narrator",
	narratorId: "worker-narrator",
	percentage: 42.5,
	compactStart: 80,
};

describe("buildContextUsageFrames", () => {
	test("子代理：父级那份带归属，自己的那份不带", () => {
		const frames = buildContextUsageFrames({ ...base, isSubagent: true });

		expect(frames.parent).toMatchObject({
			type: "context_usage",
			// 路由字段仍指向父级：帧是发给它的。
			narratorId: "parent-narrator",
			subagentNarratorId: "worker-narrator",
			isSubagent: true,
			percentage: 42.5,
			compactStart: 80,
		});
		expect(frames.self).toMatchObject({
			type: "context_usage",
			narratorId: "parent-narrator",
			percentage: 42.5,
			compactStart: 80,
		});
		// 关键：子代理自己那份**没有**归属字段，也没有 isSubagent 标记。
		expect(Object.hasOwn(frames.self, "subagentNarratorId")).toBe(false);
		expect(Object.hasOwn(frames.self, "isSubagent")).toBe(false);
	});

	test("主叙述者：两份完全相同，且都不带链接字段", () => {
		const frames = buildContextUsageFrames({
			...base,
			narratorId: "parent-narrator",
			isSubagent: false,
		});

		expect(frames.parent).toEqual(frames.self);
		expect(Object.hasOwn(frames.parent, "subagentNarratorId")).toBe(false);
		expect(Object.hasOwn(frames.parent, "isSubagent")).toBe(false);
	});

	test("可选字段只在真的有值时出现（0 与「没有」必须可区分）", () => {
		const withoutOptionals = buildContextUsageFrames({ ...base, isSubagent: true });
		expect(Object.hasOwn(withoutOptionals.parent, "promptTokens")).toBe(false);
		expect(Object.hasOwn(withoutOptionals.parent, "contextWindow")).toBe(false);
		expect(Object.hasOwn(withoutOptionals.parent, "isEstimated")).toBe(false);

		const withOptionals = buildContextUsageFrames({
			...base,
			isSubagent: true,
			promptTokens: 1000,
			contextWindow: 200_000,
			isEstimated: true,
		});
		expect(withOptionals.parent).toMatchObject({
			promptTokens: 1000,
			contextWindow: 200_000,
			isEstimated: true,
		});
		expect(withOptionals.self).toMatchObject({
			promptTokens: 1000,
			contextWindow: 200_000,
			isEstimated: true,
		});
	});
});
