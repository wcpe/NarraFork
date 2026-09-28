import { describe, expect, test } from "bun:test";
import { awaitTool, listRunningAwaits } from "@server/lib/agent/tools/await";
import { sendTool } from "@server/lib/agent/tools/send";
import type { AgentConfig, ToolContext } from "@server/lib/agent/types";
import {
	isRuntimeToolAllowed,
	type RuntimePolicyInput,
	resolveRuntimePolicy,
	runtimeAwaitTargets,
	runtimeInteractionHint,
} from "../agent-runtime/policy";
import {
	assertSubagentCanAwaitAgent,
	assertSubagentSendIsAsync,
	SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
	SUBAGENT_SEND_ASYNC_ONLY_ERROR,
} from "../subagent-communication-policy";
import { resolveToolFilter, runtimeToolFilter } from "../subagent-tools";

const profiles: RuntimePolicyInput[] = [
	{ variant: "primary" },
	...["general", "explore", "plan", "review", "search", "missing-custom"].map((subagentType) => ({
		variant: "subagent" as const,
		subagentType,
	})),
	{
		variant: "subagent",
		subagentType: "custom",
		customDefinition: { toolAccess: "readOnly", customTools: [] },
	},
	{
		variant: "subagent",
		subagentType: "custom",
		customDefinition: { toolAccess: "general", customTools: [] },
	},
	{
		variant: "subagent",
		subagentType: "custom",
		customDefinition: {
			toolAccess: "custom",
			customTools: [
				"Send",
				"Await",
				"AskUserQuestion",
				"Agent",
				"Task",
				"ContinueTask",
				"ForkNarrator",
				"EnterPlanMode",
				"ExitPlanMode",
				"Write",
			],
		},
	},
];

describe("shared capability projections", () => {
	for (const [index, input] of profiles.entries()) {
		test(`${index}: ${input.variant}/${input.subagentType ?? "default"}: tools, schemas, hints and service guards agree`, () => {
			const policy = resolveRuntimePolicy(input);
			const child = input.variant === "subagent";
			const config = { parentNarratorId: child ? "parent" : undefined } as AgentConfig;
			const custom = input.customDefinition
				? {
						...input.customDefinition,
						customTools: [...input.customDefinition.customTools],
						name: "custom",
						description: "test",
						defaultModel: "",
						prompt: "test",
						location: "test",
					}
				: undefined;
			const filter = child
				? resolveToolFilter(input.subagentType ?? "general", custom)
				: runtimeToolFilter(policy);
			expect(filter?.(sendTool)).toBe(true);
			expect(filter?.(awaitTool)).toBe(true);
			for (const name of [
				"Agent",
				"Task",
				"ContinueTask",
				"ForkNarrator",
				"EnterPlanMode",
				"ExitPlanMode",
			]) {
				const tool = { ...sendTool, name };
				expect(filter?.(tool)).toBe(!child);
				expect(filter?.(tool)).toBe(isRuntimeToolAllowed(policy, name));
			}
			const sendProperties = sendTool.getRawJsonSchema?.(config).properties as Record<
				string,
				unknown
			>;
			const awaitProperties = awaitTool.getRawJsonSchema?.(config).properties as {
				type: { enum: string[] };
			};
			expect(Boolean(sendProperties.await)).toBe(policy.capabilities.sendAwait);
			expect(awaitProperties.type.enum).toEqual(runtimeAwaitTargets(policy));
			expect(awaitProperties.type.enum).toContain("question");
			const sendGuard = () => assertSubagentSendIsAsync(child, true);
			const awaitGuard = () => assertSubagentCanAwaitAgent(child);
			if (child) {
				expect(sendGuard).toThrow(SUBAGENT_SEND_ASYNC_ONLY_ERROR);
				expect(awaitGuard).toThrow(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
				// Subagents cannot ask the user at all — even a custom definition that
				// explicitly lists AskUserQuestion (the last profile) is gated off.
				expect(policy.capabilities.askUserQuestion).toBe("disabled");
				expect(filter?.({ ...sendTool, name: "AskUserQuestion" })).toBe(false);
				expect(policy.capabilities.spawnAgent).toBe(false);
				expect(policy.capabilities.planApproval).toBe(false);
				expect(policy.capabilities.stopHooks).toBe(false);
				expect(runtimeInteractionHint(policy, "en")).toContain("AskUserQuestion is unavailable");
				expect(runtimeInteractionHint(policy, "zh-CN")).toContain("不可调用 AskUserQuestion");
			} else {
				expect(sendGuard).not.toThrow();
				expect(awaitGuard).not.toThrow();
				expect(runtimeInteractionHint(policy, "en")).toBe("");
			}
		});
	}

	test("inherited readOnly narrows custom MCP and file access without widening its allowlist", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			readOnly: true,
			customDefinition: { toolAccess: "custom", customTools: ["Read", "Write", "mcp__test__read"] },
		});
		expect(policy.tools.readOnly).toBe(true);
		expect(isRuntimeToolAllowed(policy, "Read")).toBe(true);
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
		expect(isRuntimeToolAllowed(policy, "Grep")).toBe(false);
		expect(isRuntimeToolAllowed(policy, "mcp__test__read", "readOnly")).toBe(true);
		for (const behavior of ["readWrite", "allow", "ask", "deny", null, undefined]) {
			expect(isRuntimeToolAllowed(policy, "mcp__test__read", behavior)).toBe(false);
		}
		expect(isRuntimeToolAllowed(policy, "mcp__test__other", "readOnly")).toBe(false);
	});

	test("missing custom definition and built-in readOnly cannot be upgraded by a custom override", () => {
		for (const subagentType of ["missing", "explore", "plan", "review"]) {
			const policy = resolveRuntimePolicy({
				variant: "subagent",
				subagentType,
				customDefinition:
					subagentType === "missing" ? null : { toolAccess: "general", customTools: [] },
			});
			expect(policy.tools.readOnly).toBe(true);
			expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
			expect(isRuntimeToolAllowed(policy, "mcp__test__write", "readWrite")).toBe(false);
			expect(isRuntimeToolAllowed(policy, "mcp__test__read", "readOnly")).toBe(true);
		}
	});

	test("policy snapshots custom tool names rather than sharing mutable configuration", () => {
		const customTools = ["Read"];
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			customDefinition: { toolAccess: "custom", customTools },
		});
		customTools.push("Write");
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
		expect(Object.isFrozen(policy.capabilities)).toBe(true);
		expect(Object.isFrozen(policy.tools.builtin)).toBe(true);
	});

	// 回归：`toolAccess: "custom"` 曾无条件把 readOnly 写成 false、MCP 写成 "nonDenied"，
	// 于是"候选全是只读工具"这种配置被描述成可写，MCP 白名单也挡不住可写的 MCP 工具。
	// 现在按工具集的**实际内容**推导，这条断言就是为了防止它被改回声明式判定。
	test("a custom tool set made only of read tools stays read-only", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			customDefinition: { toolAccess: "custom", customTools: ["Read", "Grep", "mcp__test__read"] },
		});
		expect(policy.tools.readOnly).toBe(true);
		expect(policy.tools.mcp).toBe("readOnly");
		expect(isRuntimeToolAllowed(policy, "Read")).toBe(true);
		expect(isRuntimeToolAllowed(policy, "mcp__test__read", "readOnly")).toBe(true);
		// 只读语义下即使工具名在白名单里，可写的 MCP 行为也必须被挡住
		expect(isRuntimeToolAllowed(policy, "mcp__test__read", "readWrite")).toBe(false);
	});

	test("a custom tool set containing a write tool is not read-only", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			customDefinition: { toolAccess: "custom", customTools: ["Read", "Write"] },
		});
		expect(policy.tools.readOnly).toBe(false);
		expect(policy.tools.mcp).toBe("nonDenied");
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(true);
	});

	test("an empty custom tool set is not described as read-only", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			customDefinition: { toolAccess: "custom", customTools: [] },
		});
		// 空集是"没有任何工具"的退化配置，不是"只读"——两者都不该被误报成可写
		expect(policy.tools.readOnly).toBe(false);
		expect(isRuntimeToolAllowed(policy, "Read")).toBe(false);
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
	});

	test("direct tool execution rejects legacy synchronous child inputs before service work or wait registration", async () => {
		const ctx = {
			narratorId: "child",
			parentNarratorId: "parent",
			currentToolUseId: "policy-denied",
			signal: new AbortController().signal,
		} as ToolContext;
		expect(
			sendTool.parameters.safeParse({ id: "sibling", message: "hello", await: true }).success,
		).toBe(true);
		const send = await sendTool.execute({ id: "sibling", message: "hello", await: true }, ctx);
		expect(send.isError).toBe(true);
		expect(send.output).toContain(SUBAGENT_SEND_ASYNC_ONLY_ERROR);
		expect(awaitTool.parameters.safeParse({ type: "agent", id: "sibling" }).success).toBe(true);
		const result = await awaitTool.execute({ type: "agent", id: "sibling" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
		expect(listRunningAwaits().some((entry) => entry.toolUseId === ctx.currentToolUseId)).toBe(
			false,
		);
	});
});
