/**
 * 派发返回文本的尺寸约束（上下文与缓存优化的一项）。
 *
 * 这条 `tool_result` 会成为编制者上下文里的**常驻前缀**：它此后每一轮都要被重新发一遍。
 * 一次派发的执行者原文动辄上万字，不设上限的话，编排跑上十几次派发就是十万字级别的
 * 每轮开销——那比任何一次派发本身都贵，而且它增长得完全没有信号。
 *
 * 因此这里钉住两件事：
 * - 长原文被截断，并且在截断处**明说**被截断了（不能让人以为原文本来就这么短）；
 * - 短原文原样保留，而且截断**不碰**回执与复核那两节——编制者据以行动的东西一个字都不能少。
 */

import { describe, expect, test } from "bun:test";
import {
	EXECUTOR_ECHO_MAX_CHARS,
	type OrchestrationDispatchReport,
	renderOrchestrationDispatchResult,
} from "../receipt";

const RECEIPT_JSON = [
	"```json",
	"{",
	'  "verdict": "pass",',
	'  "changedFiles": ["server/lib/orchestration/receipt.ts"],',
	'  "testsRun": ["bun test — 12 pass"],',
	'  "notDone": [],',
	'  "confidence": "high",',
	'  "blockers": []',
	"}",
	"```",
].join("\n");

function report(executorOutput: string): OrchestrationDispatchReport {
	const receipt = {
		kind: "parsed" as const,
		receipt: {
			verdict: "pass" as const,
			changedFiles: ["server/lib/orchestration/receipt.ts"],
			testsRun: ["bun test — 12 pass"],
			notDone: [],
			confidence: "high" as const,
			blockers: [],
		},
		raw: RECEIPT_JSON,
	};
	return {
		executorOutput,
		receipt,
		selfReview: { kind: "executed" },
		independentReview: { kind: "executed", result: receipt },
	};
}

describe("renderOrchestrationDispatchResult 的尺寸约束", () => {
	test("超长原文被截断，并在截断处说明被截断了", () => {
		const output = renderOrchestrationDispatchResult(
			report(`${"x".repeat(EXECUTOR_ECHO_MAX_CHARS)}${"y".repeat(5000)}`),
			"zh-CN",
		);
		// 截断处之后的内容不该出现
		expect(output).not.toContain("y".repeat(100));
		// 必须明说，而不是让人以为原文就这么短
		expect(output).toContain("截断");
		expect(output.length).toBeLessThan(EXECUTOR_ECHO_MAX_CHARS + 2000);
	});

	test("英文 locale 用英文的截断说明", () => {
		const output = renderOrchestrationDispatchResult(
			report("x".repeat(EXECUTOR_ECHO_MAX_CHARS + 1)),
			"en",
		);
		expect(output).toContain("cut off");
	});

	test("短原文原样保留，不加任何截断标记", () => {
		const output = renderOrchestrationDispatchResult(report("执行者的原话"), "zh-CN");
		expect(output).toContain("执行者的原话");
		expect(output).not.toContain("截断");
	});

	test("恰好等于上限时不截断（边界取 <=）", () => {
		const exact = "z".repeat(EXECUTOR_ECHO_MAX_CHARS);
		const output = renderOrchestrationDispatchResult(report(exact), "zh-CN");
		expect(output).toContain(exact);
		expect(output).not.toContain("截断");
	});

	test("截断只作用于执行者原文：回执与复核两节一个字都不少", () => {
		const output = renderOrchestrationDispatchResult(
			report("x".repeat(EXECUTOR_ECHO_MAX_CHARS + 10_000)),
			"zh-CN",
		);
		// 回执那一节照常给出结构化字段
		expect(output).toContain("## 结构化回执");
		expect(output).toContain("`pass`");
		expect(output).toContain("server/lib/orchestration/receipt.ts");
		expect(output).toContain("bun test — 12 pass");
		// 复核那一节也在
		expect(output).toContain("## 独立复核");
		expect(output).toContain("来自执行者收尾后跑的");
	});
});
