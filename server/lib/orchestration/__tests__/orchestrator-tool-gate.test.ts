import { describe, expect, test } from "bun:test";
import {
	isRuntimeToolAllowed,
	READ_TOOLS,
	type RuntimePolicy,
	resolveRuntimePolicy,
} from "@server/services/agent-runtime/policy";
import {
	__resetInFlightForTests,
	acquireModelSlot,
	getInFlight,
	selectModelForTier,
} from "../runtime";
import { ORCHESTRATOR_TOOLS } from "../tier-definition";

/**
 * 编排编制者的工具闸门：编制者只能派发，不该自己翻代码。
 *
 * 这份测试盯住的是"**收窄而不是替换**"这件事——`extraToolNames` 必须与既有白名单
 * 取交集。一旦它变成"直接赋值"，子代理/受限 primary 的白名单就会被绕过，
 * 而症状（某个受限会话忽然多出工具）在别处看不出来。
 */

function builtinSet(policy: RuntimePolicy): readonly string[] {
	const builtin = policy.tools.builtin;
	return builtin === "all" ? ["<all>"] : builtin;
}

describe("resolveRuntimePolicy 的 extraToolNames", () => {
	test('primary 的 builtin: "all" 被收成给定集合', () => {
		const policy = resolveRuntimePolicy({
			variant: "primary",
			extraToolNames: ORCHESTRATOR_TOOLS,
		});
		expect(policy.tools.builtin).not.toBe("all");
		expect([...builtinSet(policy)]).toEqual([...ORCHESTRATOR_TOOLS]);
		// 编制者看不到 MCP：MCP 的能力不由档位池定义，无法按档位解释
		expect(policy.tools.mcp).toBe("none");
		// readOnly 不由这次收窄决定，保持原值
		expect(policy.tools.readOnly).toBe(false);
	});

	test("空数组视同未提供，不收窄", () => {
		const policy = resolveRuntimePolicy({ variant: "primary", extraToolNames: [] });
		expect(policy.tools.builtin).toBe("all");
		expect(policy.tools.mcp).toBe("nonDenied");
	});

	test("只读子代理白名单取交集，绝不放大", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "explore",
			extraToolNames: ORCHESTRATOR_TOOLS,
		});
		expect([...builtinSet(policy)].sort()).toEqual(["Await", "Read", "Send", "TeamStatus"]);
		// ContextAsk / Glob / Grep 等只读工具不在编制者集子里，必须已被剔除
		for (const name of ["ContextAsk", "Glob", "Grep"]) {
			expect(isRuntimeToolAllowed(policy, name)).toBe(false);
		}
		for (const name of builtinSet(policy)) {
			expect((READ_TOOLS as readonly string[]).includes(name)).toBe(true);
		}
	});

	test("可写子代理白名单同样取交集", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "general",
			extraToolNames: ORCHESTRATOR_TOOLS,
		});
		// `Skill` 已从 ORCHESTRATOR_TOOLS 移除（任意指令注入通道），而 `Write`/`Edit`
		// 加入是为了让编制者能维护 Dynamic Spec 任务清单——它们能被 general 子代理
		// 交集命中只是"交集按名字算"的结果，子代理不受"只能写 spec://"那条约束
		// （那条约束只认编制者上下文，见 orchestrator-spec-write-guard.test.ts）。
		expect([...builtinSet(policy)].sort()).toEqual([
			"Await",
			"Edit",
			"Read",
			"Send",
			"TeamStatus",
			"Write",
		]);
		// Bash 既不在 general 之外也不在编制者集子里，必须已经消失
		for (const name of ["Bash", "Skill", "Glob", "Grep"]) {
			expect(isRuntimeToolAllowed(policy, name)).toBe(false);
		}
	});

	test("自定义白名单取交集（不放大到白名单之外）", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			customDefinition: { toolAccess: "custom", customTools: ["Write", "Read", "Grep"] },
			extraToolNames: ORCHESTRATOR_TOOLS,
		});
		// 交集结果跟随 `builtin` 的顺序：["Write","Read","Grep"] 里只有 Write/Read 在
		// 编制者集子内（Grep 不在）。Write 现在出现是本次修复的预期变化。
		expect([...builtinSet(policy)]).toEqual(["Write", "Read"]);
	});

	test("与 readOnly 组合时 readOnly 语义保持", () => {
		const policy = resolveRuntimePolicy({
			variant: "primary",
			readOnly: true,
			extraToolNames: [...ORCHESTRATOR_TOOLS, "Write"],
		});
		expect(policy.tools.readOnly).toBe(true);
		for (const name of builtinSet(policy)) {
			expect((READ_TOOLS as readonly string[]).includes(name)).toBe(true);
		}
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
	});

	test("编制者仍能派发，但用不了自找代码的工具", () => {
		const policy = resolveRuntimePolicy({
			variant: "primary",
			extraToolNames: ORCHESTRATOR_TOOLS,
			orchestrationProfileId: "abcd1234",
		});
		expect(isRuntimeToolAllowed(policy, "Agent")).toBe(true);
		// `TodoWrite` 从编制者集子里移除：本仓库从未注册过这个名字
		// （核心工具表见 server/lib/agent/tools/index.ts），原来这条断言授予的是一个
		// **不存在**的工具，等于用一条绿测试掩盖了"编制者没有任何任务清单工具"。
		expect(isRuntimeToolAllowed(policy, "TodoWrite")).toBe(false);
		// `Skill` 同样移除：它会把任意 markdown 原文作为指令注入对话，
		// 是一条不受档位约束的任意指令通道（见 skill.ts 的注入路径）。
		expect(isRuntimeToolAllowed(policy, "Skill")).toBe(false);
		// "自己去找代码"的手段一律没有
		for (const name of ["Grep", "Glob", "Bash"]) {
			expect(isRuntimeToolAllowed(policy, name)).toBe(false);
		}
		// `Write`/`Edit` **在可见性层是保留的**：编制者要维护 `spec://tasks.json`，
		// 而系统级提醒每轮都在要求它更新。真正"只能写 spec://、不动项目代码"的约束
		// 不在这里表达（可见性挡不住模型硬发一次调用），而在执行期守卫里，
		// 见 server/lib/agent/tools/orchestrator-spec-write-guard.ts 及其测试。
		for (const name of ["Write", "Edit"]) {
			expect(isRuntimeToolAllowed(policy, name)).toBe(true);
		}
	});

	test("orchestrationProfileId 随策略带出，未提供时缺省", () => {
		expect(
			resolveRuntimePolicy({ variant: "primary", orchestrationProfileId: "abcd1234" }).orchestration
				?.profileId,
		).toBe("abcd1234");
		expect(resolveRuntimePolicy({ variant: "primary" }).orchestration).toBeUndefined();
	});
});

describe("ORCHESTRATOR_TOOLS 的成分", () => {
	test("不含 Skill 与 TodoWrite，保留维护任务清单所需的读写工具", () => {
		// Skill：任意指令注入通道，编制者的能力只应由档位池定义。
		expect(ORCHESTRATOR_TOOLS).not.toContain("Skill");
		// TodoWrite：本仓库没有注册过这个名字，授予它等于授予以空。
		expect(ORCHESTRATOR_TOOLS).not.toContain("TodoWrite");
		for (const name of ["Agent", "Read", "Write", "Edit"]) {
			expect(ORCHESTRATOR_TOOLS).toContain(name);
		}
	});

	test("不含 EnterPlanMode / ExitPlanMode（等批准那道关卡的入口与提交按钮）", () => {
		// 用户实机反馈的缺陷是「出计划给我自己卡住」：编制者进了计划模式、写完计划、
		// 然后停在等批准上。这两个工具就是那条路径的全部入口（EnterPlanMode）与
		// 唯一的提交动作（ExitPlanMode），而 ExitPlanMode 的工具描述里还写着
		// 「完成计划后用它请求批准」——留在手边等于给它一个「提交计划并等待」的按钮。
		// 本模式的要求相反：想法谈清楚就派发，计划内容进 Agent 的 prompt。
		expect(ORCHESTRATOR_TOOLS).not.toContain("EnterPlanMode");
		expect(ORCHESTRATOR_TOOLS).not.toContain("ExitPlanMode");
		// Read 仍在（编制者要读自己的 Dynamic Spec），但执行期只放行 spec://，
		// 见 orchestrator-spec-write-guard.ts 及其测试。
		expect(ORCHESTRATOR_TOOLS).toContain("Read");
	});
});

describe("派发容量计数", () => {
	test("acquireModelSlot 的释放幂等，计数不漂移也不残留", () => {
		__resetInFlightForTests();
		const release = acquireModelSlot("provA:worker");
		expect(getInFlight("provA:worker")).toBe(1);
		release();
		// 释放函数会被 finally 与异常路径各调一次。真减两次的话，该模型的并发
		// 容量会凭空变大——池子会"越失败越松"，容量判断随之失真。
		release();
		expect(getInFlight("provA:worker")).toBe(0);
		__resetInFlightForTests();
	});

	test("方案不存在时选不出模型（调用方据此报错而不是静默降级）", () => {
		expect(selectModelForTier("nosuchid", "quick")).toBeNull();
	});
});
