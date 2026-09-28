import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTool } from "@server/lib/agent/tool-executor";
import { toolRegistry } from "@server/lib/agent/tool-registry";
import type { AgentConfig, AgentToolUse, ToolCallBinding } from "@server/lib/agent/types";
import { z } from "zod/v4";
import {
	buildOrchestratorPrompt,
	ORCHESTRATOR_TOOLS,
	resolveExecutionAllowedTools,
	resolveOrchestratorExecutionAllowedTools,
} from "../tier-definition";

/**
 * 编制者的**执行期**闸门。
 *
 * 可见性（policy 的 `extraToolNames` + loop 的 `toolFilter`）只决定"发给模型的工具数组
 * 里有什么"——模型硬发一个未列出的调用时，只有 `AgentConfig.allowedTools` 挡得住。
 * 这份测试盯住的正是"这一层真的被下发、且真的能拒绝"，因此分三块：
 *  1. 下发集合的语义（与 OAuth 取交集，非编制者不变）；
 *  2. 该集合在真实执行器里确实拦下一个越界调用；
 *  3. 装配处（orchestrator.ts / narrator-session.ts）确实调用了它。
 */

const OAUTH_SAMPLE: readonly string[] = ["Read", "Write", "Bash", "Agent", "Glob"];

describe("resolveExecutionAllowedTools 的语义", () => {
	test("编制者：无 OAuth 白名单时就是编制者集合，且不含自找代码的工具", () => {
		const allowed = resolveExecutionAllowedTools({ isOrchestrator: true });
		expect(allowed).toBeInstanceOf(Set);
		expect([...(allowed ?? [])].sort()).toEqual([...ORCHESTRATOR_TOOLS].sort());
		for (const name of ["Bash", "Glob", "Grep", "Skill", "TodoWrite"]) {
			expect(allowed?.has(name)).toBe(false);
		}
	});

	test("编制者 + OAuth 白名单取交集，而不是覆盖", () => {
		const allowed = resolveOrchestratorExecutionAllowedTools(OAUTH_SAMPLE);
		// Bash/Glob 在 OAuth 里但不在编制者集子里 → 必须被剔除（工具面收窄仍然生效）
		// Edit 在编制者集子里但不在 OAuth 里 → 必须被剔除（编排不是绕过 OAuth 的授权来源）
		expect([...(allowed ?? [])].sort()).toEqual(["Agent", "Read", "Write"]);
		expect(allowed.has("Edit")).toBe(false);
		expect(allowed.has("Bash")).toBe(false);
		expect(allowed.has("Glob")).toBe(false);
		// 取交集绝不会放大：结果一定是两侧的子集
		for (const name of allowed) {
			expect(ORCHESTRATOR_TOOLS).toContain(name);
			expect(OAUTH_SAMPLE).toContain(name);
		}
	});

	test("OAuth 白名单装不下任何编制者工具时，交集为空而不是退回全集", () => {
		const allowed = resolveOrchestratorExecutionAllowedTools(["Bash", "Glob"]);
		expect([...allowed]).toEqual([]);
	});

	test("非编制者（普通 primary 与所有子代理）行为与改动前逐字相同", () => {
		// 有 OAuth 白名单 → 照抄（含编制者集子里没有的 Bash/Glob）
		const allowed = resolveExecutionAllowedTools({
			isOrchestrator: false,
			oauthAllowedTools: OAUTH_SAMPLE,
		});
		expect([...(allowed ?? [])]).toEqual([...OAUTH_SAMPLE]);
		expect(allowed?.has("Bash")).toBe(true);
		expect(allowed?.has("Glob")).toBe(true);
		// 没有 OAuth 白名单 → undefined（不设闸门），不是空集
		expect(resolveExecutionAllowedTools({ isOrchestrator: false })).toBeUndefined();
		expect(
			resolveExecutionAllowedTools({ isOrchestrator: false, oauthAllowedTools: null }),
		).toBeUndefined();
		// ReadonlySet 形态（OAuth 侧实际传的就是 Set）同样照抄
		const fromSet = resolveExecutionAllowedTools({
			isOrchestrator: false,
			oauthAllowedTools: new Set(["Bash", "Read"]),
		});
		expect([...(fromSet ?? [])]).toEqual(["Bash", "Read"]);
	});
});

const FORBIDDEN_TOOL_NAME = "__OrchestratorForbiddenBash";

function makeConfig(allowedTools: Set<string> | undefined): {
	config: AgentConfig;
	executed: () => boolean;
	permissionCalls: () => number;
} {
	let executed = false;
	let permissionCalls = 0;
	toolRegistry.register({
		name: FORBIDDEN_TOOL_NAME,
		description: "orchestrator execution gate fixture",
		parameters: z.object({}),
		execute: async () => {
			executed = true;
			return { output: "executed" };
		},
	});
	const abortController = new AbortController();
	const config: AgentConfig = {
		narratorId: "orchestrator-gate-narrator",
		conversationId: "orchestrator-gate-conversation",
		model: "codex:gpt-5.5",
		provider: "codex",
		cwd: "/tmp",
		signal: abortController.signal,
		allowedTools,
		permissionHandler: async () => {
			permissionCalls++;
			return { behavior: "allow" };
		},
		requireToolCallBinding: true,
		toolExecutionBindings: new (class extends WeakMap<AgentToolUse, ToolCallBinding> {
			override get(tool: AgentToolUse): ToolCallBinding {
				const binding = super.get(tool) ?? { toolCallId: `row-${tool.toolUseId}`, attempt: 1 };
				super.set(tool, binding);
				return binding;
			}
		})(),
		onToolExecutionStarting: async (_toolUseId, binding) => binding,
	};
	return { config, executed: () => executed, permissionCalls: () => permissionCalls };
}

describe("编制者越界调用被执行期闸门拒绝", () => {
	test("编制者集合之外的工具在权限判定与执行之前就被拒绝", async () => {
		const fixture = makeConfig(resolveExecutionAllowedTools({ isOrchestrator: true }));
		try {
			const result = await executeTool(
				{ toolUseId: "orchestrator-cross-boundary", name: FORBIDDEN_TOOL_NAME, input: {} },
				fixture.config,
			);
			expect(result.isError).toBe(true);
			expect(result.fatal).toBe(true);
			expect(result.output).toContain("not allowed by this narrator's runtime policy");
			expect(fixture.executed()).toBe(false);
			expect(fixture.permissionCalls()).toBe(0);
		} finally {
			toolRegistry.unregister(FORBIDDEN_TOOL_NAME);
		}
	});

	// 闸门的**放行**方向不在这里重复验证：`allowedTools` 命中后仍要经过 pipeline 状态、
	// 证据落库等真实 DB 依赖，那需要 agent-runtime 的整集成 fixture。放行方向由
	// server/lib/agent/__tests__/tool-executor.test.ts 覆盖（"enforces the runtime
	// allow-list before permission or execution" 之后的授权守卫用例只有白名单命中才会
	// 走到）。本文件负责的是"编制者集合确实被下发，且确实能拦下集合外的调用"。
});

describe("编制者提示词与工具面一致", () => {
	test("提示词不再声称自己没有任何写能力，并点明唯一可写目标是 Dynamic Spec", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const prompt = buildOrchestratorPrompt(locale);
			// `Write`/`Edit` 现在对编制者可见（只对 spec:// 生效），因此"你没有任何写工具"
			// 这句绝对表述已经不成立——它会与 Dynamic Spec 提醒里"更新 spec://tasks.json"
			// 的每轮指令互相打脸，模型很可能因此干脆不维护任务清单。
			expect(prompt).not.toContain("You have no Write, no Edit");
			expect(prompt).not.toContain("你没有 Write、没有 Edit");
			expect(prompt).toContain("Dynamic Spec");
		}
	});
});

/**
 * 装配处守卫。
 *
 * 为什么是源码文本断言：要观察真实的 `AgentConfig.allowedTools` 必须跑起整套 agent
 * 运行时（DB + provider fixture），那份集成测试在本机因 publication 的模块级副作用
 * 加载失败，与本次改动无关。而"这一层**有没有**被下发"恰恰是本次缺陷的全部内容——
 * 删掉装配处，上面所有关于集合语义与执行器行为的测试都仍然全绿（它们各自成立），
 * 只有这里会变红。因此它盯的不是"文本长这样"，而是"闸门确实接上了"。
 */
describe("AgentConfig.allowedTools 的装配处", () => {
	const serverRoot = join(import.meta.dir, "..", "..", "..");

	function readSource(relative: string): string {
		return readFileSync(join(serverRoot, relative), "utf8");
	}

	function executableSource(relative: string): string {
		return readSource(relative)
			.replace(/\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
	}

	test("主循环按当前 AgentConfig 装配结构化编制者闸门", () => {
		const source = executableSource("services/agent-runtime/orchestrator.ts");
		expect(source).toMatch(
			/allowedTools:\s*resolveExecutionAllowedTools\(\{[\s\S]*?isOrchestrator:\s*runtimePolicy\.orchestration\?\.profileId\s*!==\s*undefined[\s\S]*?oauthAllowedTools:\s*oauthRuntime\?\.allowedTools/,
		);
		expect(source).not.toContain(
			"allowedTools: oauthRuntime ? new Set(oauthRuntime.allowedTools) : undefined",
		);
	});

	test("工具重跑路径复用同一条执行期闸门", () => {
		const source = executableSource("services/narrator-session.ts");
		expect(source).toMatch(
			/allowedTools:\s*resolveExecutionAllowedTools\(\{[\s\S]*?isOrchestrator:\s*!isSubagent\s*&&\s*active\._orchestrationProfileId\s*!==\s*undefined[\s\S]*?oauthAllowedTools:\s*oauthRuntime\?\.allowedTools/,
		);
		expect(source).not.toContain(
			"allowedTools: oauthRuntime ? new Set(oauthRuntime.allowedTools) : undefined",
		);
	});
});
