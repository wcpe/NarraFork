/**
 * 结构化回执的解析与渲染测试。
 *
 * 这一层是纯函数，所以用例刻意覆盖"模型不守约"的各种形状——那是它存在的全部理由：
 * 丢结果的代价远大于拿到一份降级的回执。
 */

import { describe, expect, test } from "bun:test";
import {
	type OrchestrationReceipt,
	parseOrchestrationReceipt,
	renderOrchestrationDispatchResult,
	renderReceiptForParent,
} from "../receipt";

const VALID: OrchestrationReceipt = {
	verdict: "pass",
	changedFiles: ["server/a.ts", "frontend/b.tsx"],
	testsRun: ["bun test server/a.test.ts — pass"],
	notDone: ["nothing"],
	confidence: "high",
	blockers: [],
};

function fence(json: unknown, language = "json"): string {
	return `说明文字\n\n\`\`\`${language}\n${JSON.stringify(json, null, 2)}\n\`\`\``;
}

describe("parseOrchestrationReceipt", () => {
	test("解析带语言标注的 fenced JSON", () => {
		const result = parseOrchestrationReceipt(fence(VALID));
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt).toEqual(VALID);
		expect(result.raw).toContain("```json");
	});

	test("无语言标注的 fenced block 一样能解析", () => {
		const result = parseOrchestrationReceipt(fence(VALID, ""));
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.verdict).toBe("pass");
	});

	test("多个 block 时取最后一个能解析的", () => {
		const text = ['```json\n{"verdict":"fail"}\n```', "中间解释", fence(VALID)].join("\n\n");
		const result = parseOrchestrationReceipt(text);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.verdict).toBe("pass");
		expect(result.receipt.changedFiles).toEqual(VALID.changedFiles);
	});

	test("最后一个 block 坏掉时，仍接受前一个能解析的（宽松优先）", () => {
		const text = [fence(VALID), "```json\n{ broken\n```"].join("\n\n");
		const result = parseOrchestrationReceipt(text);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.verdict).toBe("pass");
	});

	test("没有 fenced block 时接受裸 JSON", () => {
		const result = parseOrchestrationReceipt(`我做完了。\n${JSON.stringify(VALID)}`);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt).toEqual(VALID);
	});

	test("夹带解释文字、且 JSON 不是最后一个对象时，取最后一个平衡对象", () => {
		const text = [
			"先看一个配置示例：",
			'{"config": {"a": 1}}',
			"然后是我的回执：",
			JSON.stringify(VALID),
			"以上。",
		].join("\n");
		const result = parseOrchestrationReceipt(text);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.verdict).toBe("pass");
	});

	test("字符串里的花括号不会破坏平衡扫描", () => {
		const text = `note: "a } brace in a string { here" ${JSON.stringify(VALID)}`;
		const result = parseOrchestrationReceipt(text);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.verdict).toBe("pass");
	});

	test("字段级容错：verdict 非法→partial，confidence 非法→low", () => {
		const result = parseOrchestrationReceipt(
			fence({ verdict: "sure", confidence: "very", changedFiles: [], testsRun: [] }),
		);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt).toEqual({
			verdict: "partial",
			confidence: "low",
			changedFiles: [],
			testsRun: [],
			notDone: [],
			blockers: [],
		});
	});

	test("字段级容错：缺省字段各自取默认值，不整条丢弃", () => {
		const result = parseOrchestrationReceipt(fence({ verdict: "fail" }));
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.verdict).toBe("fail");
		expect(result.receipt.confidence).toBe("low");
		expect(result.receipt.changedFiles).toEqual([]);
		expect(result.receipt.notDone).toEqual([]);
	});

	test("字段级容错：数组里的非字符串项被丢弃，合法项保留", () => {
		const result = parseOrchestrationReceipt(
			fence({
				verdict: "partial",
				changedFiles: ["a.ts", 42, null, { path: "b.ts" }, "", "  ", "c.ts"],
				testsRun: "not-an-array",
				notDone: ["真的没做完"],
				confidence: "medium",
				blockers: [["nested"], "缺一个接口"],
			}),
		);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.changedFiles).toEqual(["a.ts", "c.ts"]);
		expect(result.receipt.testsRun).toEqual([]);
		expect(result.receipt.notDone).toEqual(["真的没做完"]);
		expect(result.receipt.blockers).toEqual(["缺一个接口"]);
	});

	test("空对象也是合法回执（全部字段走默认值）", () => {
		const result = parseOrchestrationReceipt(fence({}));
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") return;
		expect(result.receipt.verdict).toBe("partial");
		expect(result.receipt.confidence).toBe("low");
	});

	test("null / undefined / 空串 / 纯空白都是 unparsed", () => {
		for (const input of [null, undefined, "", "   \n\t "]) {
			const result = parseOrchestrationReceipt(input);
			expect(result.kind).toBe("unparsed");
		}
	});

	test("畸形 JSON 与未闭合花括号都是 unparsed，且带出原文", () => {
		for (const text of ['```json\n{"verdict": "pass",}\n```', "```json\n{ broken {\n```", "{{{"]) {
			const result = parseOrchestrationReceipt(text);
			expect(result.kind).toBe("unparsed");
			expect(result.raw).toBe(text);
		}
	});

	test("fenced block 里不是对象（数组/字符串）时视为 unparsed", () => {
		for (const text of [
			"```json\n[1, 2, 3]\n```",
			'```json\n"just a string"\n```',
			"```\n7\n```",
		]) {
			expect(parseOrchestrationReceipt(text).kind).toBe("unparsed");
		}
	});

	test("超长文本不抛异常：有回执时仍能找出它", () => {
		const noise = "x".repeat(200_000);
		expect(parseOrchestrationReceipt(`${noise}\n${fence(VALID)}`).kind).toBe("parsed");
		expect(parseOrchestrationReceipt(noise).kind).toBe("unparsed");
	});

	test("任何输入都不抛异常", () => {
		const hostile = [
			"\u0000\u0001",
			"{".repeat(5_000),
			"}".repeat(5_000),
			'{"a": "\\',
			"```json",
			"```json\n```",
			["{", "}", "[", "]"].join(""),
			`${"{".repeat(100)}{"verdict":"pass"}`,
		];
		for (const text of hostile) {
			expect(() => parseOrchestrationReceipt(text)).not.toThrow();
		}
	});
});

describe("renderReceiptForParent", () => {
	test("parsed 渲染出结论、置信度与四个数组字段", () => {
		const rendered = renderReceiptForParent(parseOrchestrationReceipt(fence(VALID)), "zh-CN");
		expect(rendered).toContain("`pass`");
		expect(rendered).toContain("`high`");
		expect(rendered).toContain("server/a.ts");
		expect(rendered).toContain("bun test server/a.test.ts — pass");
		// 空数组写"（无）"，而不是留一个空标题让人以为漏了
		expect(rendered).toContain("（无）");
		expect(rendered).not.toContain("未按契约回执");
	});

	test("unparsed 明确说明未按契约回执，并回显原文", () => {
		const rendered = renderReceiptForParent(
			parseOrchestrationReceipt("我改完了，测试也过了，没跑具体命令。"),
			"zh-CN",
		);
		expect(rendered).toContain("未按契约回执");
		// 不能假装成功：这句话必须出现，否则编制者会把这堆自由文本当成结构化结论
		expect(rendered).toContain("原始输出");
		expect(rendered).toContain("我改完了");
	});

	test("英文 locale 同样明确说明未按契约回执", () => {
		const rendered = renderReceiptForParent(parseOrchestrationReceipt("done, trust me"), "en");
		expect(rendered).toContain("NO CONTRACT COMPLIANT RECEIPT");
	});

	test("unparsed 且原文为空时也能渲染", () => {
		expect(() => renderReceiptForParent(parseOrchestrationReceipt(""), "zh-CN")).not.toThrow();
	});
});

describe("renderOrchestrationDispatchResult", () => {
	const executorOutput = "<subagent_id>w1</subagent_id>\n\n执行者的原话";
	const receipt = parseOrchestrationReceipt(fence(VALID));

	test("三段齐全且顺序固定：执行者原话 → 结构化回执 → 独立复核", () => {
		const output = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "executed" },
				independentReview: {
					kind: "executed",
					result: parseOrchestrationReceipt(
						fence({ ...VALID, verdict: "fail", blockers: ["接口对不上"] }),
					),
				},
			},
			"zh-CN",
		);
		expect(output.indexOf("执行者的原话")).toBeLessThan(output.indexOf("## 结构化回执"));
		expect(output.indexOf("## 结构化回执")).toBeLessThan(output.indexOf("## 独立复核"));
		expect(output).toContain("自审轮");
		expect(output).toContain("`fail`");
		expect(output).toContain("接口对不上");
	});

	test("自审被关闭时说明回执来自执行者自己", () => {
		const output = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "skipped" },
				independentReview: { kind: "skipped", reason: "disabled" },
			},
			"zh-CN",
		);
		expect(output).toContain("关闭了自审");
		expect(output).toContain("关闭了独立复核");
	});

	/**
	 * "这次没要求"与"方案关掉了"必须说出不同的话。
	 *
	 * 两者都是跳过，但编制者该做的完全不同：前者是它自己这次的决定（带参数再派一次就好），
	 * 后者是配置定的（再派也一样）。合并成一句就会让报告里出现一句关于本方案配置的**假陈述**，
	 * 而编制者会照着那个假前提去规划下一步。
	 */
	test("没要求自审时说明是这次没要，而不是说方案关闭了自审", () => {
		const notRequested = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "skipped", reason: "not_requested" },
				independentReview: { kind: "skipped", reason: "disabled" },
			},
			"zh-CN",
		);
		expect(notRequested).toContain("没有要求自审");
		// 关键是否定式断言：不能顺手说成"方案关闭了自审"。
		expect(notRequested).not.toContain("关闭了自审");
		// 并且要给出可行的下一步，而不是只宣布"没审"。
		expect(notRequested).toContain("self_review: true");

		const enabledText = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "skipped", reason: "not_requested" },
				independentReview: { kind: "skipped", reason: "disabled" },
			},
			"en",
		);
		expect(enabledText).toContain("Self-review was NOT run: this dispatch did not ask for one");
		// 断言必须指向自审那一句：独立复核那一节本来就会写 "disabled for this profile"。
		expect(enabledText).not.toContain("Self-review was NOT run: it is disabled");
	});

	test("自审失败时说明未经自审，而不是当作已自审", () => {
		const output = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "failed" },
				independentReview: { kind: "skipped", reason: "disabled" },
			},
			"zh-CN",
		);
		expect(output).toContain("未经自审");
		expect(output).not.toContain("来自执行者收尾后跑的自审轮");
	});

	test("复核取不到模型 / 被中止 / 跑挂时分别如实说明", () => {
		const noModel = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "skipped" },
				independentReview: { kind: "skipped", reason: "no_model" },
			},
			"zh-CN",
		);
		expect(noModel).toContain("取不到可用模型");
		const aborted = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "skipped" },
				independentReview: { kind: "skipped", reason: "aborted" },
			},
			"zh-CN",
		);
		expect(aborted).toContain("被中止");
		const failed = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "skipped" },
				independentReview: { kind: "failed", reason: "error" },
			},
			"zh-CN",
		);
		expect(failed).toContain("复核者没能跑起来");
	});

	test("复核者没按契约回执时，复核这一节也明确说出来", () => {
		const output = renderOrchestrationDispatchResult(
			{
				executorOutput,
				receipt,
				selfReview: { kind: "executed" },
				independentReview: {
					kind: "executed",
					result: parseOrchestrationReceipt("我看了一下，没问题。"),
				},
			},
			"zh-CN",
		);
		// 只有复核那一节是未按契约的；结构化回执那一节仍是执行者的合格回执。
		expect(output.split("未按契约回执").length).toBe(2);
	});
});
