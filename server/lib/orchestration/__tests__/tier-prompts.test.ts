/**
 * 档位与编制者提示词的断言。
 *
 * 这些断言看起来像"抄了一遍文案"，但它们守的都是**不报错、只会静默变差**的接线：
 * - chore 档必须知道"指令不可执行就停下"，否则它会用最便宜的模型去猜，而编制者会把
 *   猜出来的结论当成事实（这正是用户报的那条产品问题）；
 * - 编制者必须知道 chore 的派发要写出可机械执行的指令，否则上一条永远触发不了；
 * - 自审轮与复核者都必须把结论**作为消息**发回编制者，否则结论只躺在一个工具结果里；
 * - 编制者必须知道"副编排代理"就是那个可复用的 quick worker，否则它只能无限接受子代理的说法；
 * - 编制者**不能**再被要求"等用户批准计划"，也必须被告知"探查要并行"——这两条都是
 *   用户实机反馈的缺陷：出完计划卡住什么都不干，以及一次只派一个探查、把墙钟时间叠加。
 */

import { describe, expect, test } from "bun:test";
import {
	buildIndependentReviewerPrompt,
	buildOrchestratorPrompt,
	buildSelfReviewPrompt,
	buildTierPrompt,
	CHORE_INSTRUCTION_MIN_CHARS,
	isChoreInstructionTooVague,
} from "../tier-prompts";

const LOCALES = ["en", "zh-CN"] as const;

describe("chore 档提示词：指令不精确就停下回报", () => {
	test("两种语言都授权它在指令不可机械执行时停下并把缺的东西写进 blockers", () => {
		for (const locale of LOCALES) {
			const prompt = buildTierPrompt("chore", locale);
			expect(prompt).toContain("blockers");
		}
		const en = buildTierPrompt("chore", "en");
		expect(en).toContain("mechanically executable");
		expect(en).toContain("STOP and report it — do not guess");
		// 三类缺口都要点名：哪条命令 / 什么算成功失败 / 要回报什么
		expect(en).toContain("which** command, file, directory or test");
		expect(en).toContain("what counts as success or failure");
		expect(en).toContain("what to report back");

		const zh = buildTierPrompt("chore", "zh-CN");
		expect(zh).toContain("机械执行");
		expect(zh).toContain("不要猜着做");
		expect(zh).toContain("哪一条");
		expect(zh).toContain("什么算成功、什么算失败");
		expect(zh).toContain("要回报什么");
	});

	test("其余档位的提示词没有这条安全阀（它们本来就要判断）", () => {
		for (const locale of LOCALES) {
			expect(buildTierPrompt("quick", locale)).not.toContain(
				locale === "en" ? "mechanically executable" : "机械执行",
			);
			expect(buildTierPrompt("heavy", locale)).not.toContain(
				locale === "en" ? "mechanically executable" : "机械执行",
			);
		}
	});
});

describe("自审轮提示词：把结论作为消息发回编制者", () => {
	test("要求 Send 给 parent，并且说明回执才是权威、Send 失败不算失败", () => {
		for (const locale of LOCALES) {
			const prompt = buildSelfReviewPrompt("medium", locale);
			expect(prompt).toContain("Send");
			expect(prompt).toContain("parent");
		}
		const en = buildSelfReviewPrompt("medium", "en");
		expect(en).toContain('`Send` once with `id: "parent"`');
		// 只发一条、别发进度更新
		expect(en).toContain("do not send progress updates");
		// 回执仍是权威记录，Send 失败不重试也不算任务失败
		expect(en).toContain("authoritative record");
		expect(en).toContain("do not retry");

		const zh = buildSelfReviewPrompt("quick", "zh-CN");
		expect(zh).toContain('`id` 用 `"parent"`');
		expect(zh).toContain("不要发进度更新");
		expect(zh).toContain("权威记录");
		expect(zh).toContain("不要重试");
	});
});

describe("复核者提示词：判定同样要发到编制者手里", () => {
	test("要求把判定与依据用一条 Send 报回 parent", () => {
		for (const locale of LOCALES) {
			const prompt = buildIndependentReviewerPrompt(locale);
			expect(prompt).toContain("Send");
			expect(prompt).toContain("parent");
		}
		const en = buildIndependentReviewerPrompt("en");
		expect(en).toContain('Call `Send` with `id: "parent"`');
		expect(en).toContain("One message only");
		const zh = buildIndependentReviewerPrompt("zh-CN");
		expect(zh).toContain('调用 `Send`，`id` 用 `"parent"`');
		expect(zh).toContain("只发一条");
	});
});

describe("编制者提示词：chore 的指令必须能机械执行", () => {
	test("两种语言都给出正反例，并把需要判断的活指回 quick", () => {
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("mechanically executable");
		expect(en).toContain("the **exact command**");
		expect(en).toContain("the **exact paths**");
		// 正例里有原样命令，反例被点名成"探查 + 诊断"
		expect(en).toContain("bun test --isolate server/lib/orchestration/");
		expect(en).toContain("Look into why the orchestration tests fail");
		expect(en).toContain("exploration *plus* diagnosis");

		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("机械执行");
		expect(zh).toContain("**精确的命令**");
		expect(zh).toContain("**精确的路径**");
		expect(zh).toContain("查一下编排的测试为什么失败");
		expect(zh).toContain("探查**加**诊断");
	});

	test("说清 chore 执行者会挡回含糊指令，所以含糊派发的代价是白跑一个来回", () => {
		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("杂活档已经被要求");
		expect(zh).toContain("浪费一个来回");
	});
});

describe("编制者提示词：没有计划批准这道关卡", () => {
	test("两种语言都不再要求'等用户批准计划后才派发'", () => {
		const en = buildOrchestratorPrompt("en");
		const zh = buildOrchestratorPrompt("zh-CN");
		// 旧硬规则（"用户批准计划前不要派发 / 先把计划摆出来"）逐字不得残留：
		// 它把编制者停在"出计划 → 等批准"上，用户看到的就是"出完计划卡住、什么都不干"。
		expect(en).not.toContain("Do not dispatch before the user approves the plan");
		expect(en).not.toContain("Present the plan first");
		expect(zh).not.toContain("用户批准计划前不要派发");
		expect(zh).not.toContain("先把计划摆出来");
	});

	test("改成：想法谈清楚就直接派发，计划是派单内容而不是等签字的文档", () => {
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("Do not wait for plan approval");
		expect(en).toContain("Dispatch as soon as the idea is clear");
		// 计划要写成执行者的 briefing（派发的 prompt 参数），而不是给用户签字的文档
		expect(en).toContain("the `prompt` of the dispatch");

		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("不要等计划批准");
		expect(zh).toContain("把想法谈清楚就直接派发");
		expect(zh).toContain("派单内容");
	});

	test("编制者知道自己连代码也不能读，唯一可读目标是 Dynamic Spec", () => {
		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("不能读");
		expect(zh).toContain("Read` 对任何不是 `spec://` 的路径一律拒绝");
		expect(zh).toContain("派一个 `quick` worker 的理由");
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("cannot read, write or edit project files");
		expect(en).toContain("`Read` refuses every path that is not `spec://`");
	});
});

describe("编制者提示词：探查要并行，并分清 chore 与 quick", () => {
	test("明确要求一次回复里发多个 Agent 调用，并说明串行等于叠加墙钟时间", () => {
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("in ONE response");
		expect(en).toContain("sum of their wall-clock times");
		expect(en).toContain("in parallel");
		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("一次回复里多个 `Agent` 调用");
		expect(zh).toContain("墙钟时间叠加");
		expect(zh).toContain("并行");
	});

	test("说清什么交给 quick、什么交给 chore，并给正反例", () => {
		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("需要理解的事");
		expect(zh).toContain("能写成一条命令的机械提取");
		expect(zh).toContain("好的例子（一次回复、两个派发）");
		expect(zh).toContain("坏的例子");
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("anything that needs understanding");
		expect(en).toContain("mechanical extraction you could write down as a command");
		expect(en).toContain("Good (one response, two dispatches)");
		expect(en).toContain("Bad:");
	});

	test("提醒并行不是免费：合并确实属于一次查询的探查，也不要把一个原子事实拆成三次", () => {
		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("一次模型调用");
		expect(zh).toContain("原子事实派三次");
		expect(zh).toContain("并行买到的是延迟，不是省钱");
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("one atomic fact");
		expect(en).toContain("parallelism buys latency, not economy");
	});
});

describe("编制者提示词：副编排代理（可复用的只读核实者）", () => {
	test("用现有 quick 档表达，而不是新造一类代理", () => {
		for (const locale of LOCALES) {
			const prompt = buildOrchestratorPrompt(locale);
			expect(prompt).toContain("quick");
		}
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("auxiliary orchestrator");
		expect(en).toContain('tier: "quick"');
		// 它就是那只跑完会被停放、下次唤醒同一个的 worker
		expect(en).toContain("parked");
		expect(en).toContain("your eyes, not your hands");
		// 什么时候该自己核实
		expect(en).toContain("confidence");
		expect(en).toContain("hard to undo");
		expect(en).toContain("disagree");
		// 要问事实，不要问观点
		expect(en).toContain("never for an opinion");

		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("副编排代理");
		expect(zh).toContain("是你的眼睛，不是你的手");
		expect(zh).toContain("难以撤销");
		expect(zh).toContain("互相矛盾");
		expect(zh).toContain("绝不要问观点");
	});

	test("重申编制者**没有** Glob/Grep：它的'不知道'正是必须派人的原因", () => {
		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("没有 Glob");
		expect(zh).toContain("没有 Grep");
		expect(zh).toContain("刻意");
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("no Glob");
		expect(en).toContain("deliberate");
	});

	test("把'不要无限接受子代理的结论'写成硬规则", () => {
		const zh = buildOrchestratorPrompt("zh-CN");
		expect(zh).toContain("不要无限接受子代理的结论");
		expect(zh).toContain("先用副编排代理核实它");
		const en = buildOrchestratorPrompt("en");
		expect(en).toContain("Do not accept a subagent's conclusion indefinitely");
		expect(en).toContain("verify it with the auxiliary orchestrator");
	});
});

describe("isChoreInstructionTooVague", () => {
	test("空值与只有几个字的模糊指令判为过短", () => {
		expect(isChoreInstructionTooVague(undefined)).toBe(true);
		expect(isChoreInstructionTooVague(null)).toBe(true);
		expect(isChoreInstructionTooVague("")).toBe(true);
		expect(isChoreInstructionTooVague("   ")).toBe(true);
		expect(isChoreInstructionTooVague("看看测试")).toBe(true);
		expect(isChoreInstructionTooVague("run tests")).toBe(true);
	});

	test("写清了命令与回报要求的正常指令一律放过", () => {
		expect(
			isChoreInstructionTooVague("跑 `bunx tsgo --noEmit`，把报错贴回来。不要改任何文件。"),
		).toBe(false);
		// 恰好等于下限就放过：边界取 >=，宁可放过。
		const exact = "x".repeat(CHORE_INSTRUCTION_MIN_CHARS);
		expect(isChoreInstructionTooVague(exact)).toBe(false);
		expect(isChoreInstructionTooVague("x".repeat(CHORE_INSTRUCTION_MIN_CHARS - 1))).toBe(true);
	});

	test("首尾空白不计入长度（避免用空格凑长度绕过）", () => {
		expect(isChoreInstructionTooVague(`   ${"x".repeat(CHORE_INSTRUCTION_MIN_CHARS - 1)}   `)).toBe(
			true,
		);
	});
});
