/**
 * 阶段 5 提示词的测试。
 *
 * 这些断言看起来像"抄了一遍文案"，但它们守的是三件会静默出事的事：
 * - 自审/复核也必须带**同一份**回执契约（少了它，自己产出的回执就解析不出来）；
 * - 只读档位的自审必须知道"不要动手"（否则它会白跑一轮再报失败）；
 * - 复核者的用户消息里只有事实清单，**没有**执行者的推理过程（喂了就等于复核被锚定）。
 */

import { describe, expect, test } from "bun:test";
import {
	buildIndependentReviewBrief,
	buildIndependentReviewerPrompt,
	buildReceiptContract,
	buildSelfReviewPrompt,
} from "../tier-prompts";

const CONTRACT_MARKER = '"verdict": "pass" | "fail" | "partial"';

describe("buildReceiptContract", () => {
	test("两种语言都给出同一份 JSON 形状", () => {
		expect(buildReceiptContract("en")).toContain(CONTRACT_MARKER);
		expect(buildReceiptContract("zh-CN")).toContain(CONTRACT_MARKER);
		expect(buildReceiptContract("zh-CN")).toContain('"notDone"');
	});
});

describe("buildSelfReviewPrompt", () => {
	test("带上回执契约，并要求回看 diff、跑测试、如实报账", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const prompt = buildSelfReviewPrompt("medium", locale);
			expect(prompt).toContain(CONTRACT_MARKER);
		}
		const zh = buildSelfReviewPrompt("medium", "zh-CN");
		expect(zh).toContain("git diff");
		expect(zh).toContain("不要扩大范围");
		// 可写档位允许修自己刚弄坏的东西
		expect(zh).toContain("可以修正自己刚才在这件事里犯下的错误");
	});

	test("只读档位明确要求不要动手修，而是写进 notDone / blockers", () => {
		const zh = buildSelfReviewPrompt("quick", "zh-CN");
		expect(zh).toContain("只读");
		expect(zh).toContain("不要");
		expect(zh).not.toContain("可以修正自己刚才在这件事里犯下的错误");
		const en = buildSelfReviewPrompt("chore", "en");
		expect(en).toContain("READ-ONLY");
	});
});

describe("buildIndependentReviewerPrompt", () => {
	test("说明自己是只读且没拿到执行者的推理链，并带上回执契约", () => {
		const en = buildIndependentReviewerPrompt("en");
		expect(en).toContain(CONTRACT_MARKER);
		expect(en).toContain("READ-ONLY");
		expect(en).toContain("deliberately not been given the executor's reasoning");
		const zh = buildIndependentReviewerPrompt("zh-CN");
		expect(zh).toContain(CONTRACT_MARKER);
		expect(zh).toContain("只读");
		expect(zh).toContain("不得修改任何东西");
		expect(zh).toContain("刻意没有");
		// 判定口径：pass 必须说明"是怎么验证的"
		expect(zh).toContain("是怎么验证的");
	});
});

describe("buildIndependentReviewBrief", () => {
	test("只有事实清单：原始要求 + 改动文件 + 执行者结论 + 自己取证的指令", () => {
		const brief = buildIndependentReviewBrief({
			taskBrief: "把 a.ts 的返回值改成 Promise",
			changedFiles: ["server/a.ts", "server/a.test.ts"],
			executorNarratorId: "exec-1",
			executorReport: "- 结论: `pass`",
			locale: "zh-CN",
		});
		expect(brief).toContain("把 a.ts 的返回值改成 Promise");
		expect(brief).toContain("- server/a.ts");
		expect(brief).toContain("- server/a.test.ts");
		expect(brief).toContain("- 结论: `pass`");
		expect(brief).toContain("exec-1");
		expect(brief).toContain("不要修改任何东西");
		// 明确告诉它推理链是被刻意隐去的，免得它去猜
		expect(brief).toContain("被刻意隐去");
	});

	test("改动清单为空时说明是执行者没报，而不是留一个空标题", () => {
		const brief = buildIndependentReviewBrief({
			taskBrief: "改一下",
			changedFiles: [],
			executorNarratorId: null,
			executorReport: "- 未按契约回执",
			locale: "zh-CN",
		});
		expect(brief).toContain("没有改动任何文件");
		// 反查不到执行者时宁可不给句柄，也不给一个猜出来的 id
		expect(brief).toContain("未知");
	});

	test("英文 locale 走英文文案", () => {
		const brief = buildIndependentReviewBrief({
			taskBrief: "change it",
			changedFiles: ["a.ts"],
			executorNarratorId: "exec-1",
			executorReport: "- verdict: `pass`",
			locale: "en",
		});
		expect(brief).toContain("Do not modify anything");
		expect(brief).toContain("## What was asked for");
	});
});
