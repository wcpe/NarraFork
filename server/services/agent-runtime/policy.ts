import { BASH_TOOL_NAME, SESSION_FACT_TOOL_NAME } from "@server/lib/agent/tool-name";

/** Server-resolved capabilities, not model-supplied authorization or lifecycle hooks. */
export interface RuntimePolicy {
	readonly variant: "primary" | "subagent";
	/** Search tools may only call the selected provider directly, never the channel router. */
	readonly searchOnly?: boolean;
	readonly tools: {
		readonly builtin: "all" | readonly string[];
		readonly mcp: "none" | "readOnly" | "nonDenied";
		readonly mcpNames: "all" | readonly string[];
		readonly readOnly: boolean;
	};
	readonly capabilities: {
		readonly spawnAgent: boolean;
		readonly awaitAgent: boolean;
		readonly sendAwait: boolean;
		readonly askUserQuestion: "sync-or-async" | "disabled";
		/** Waiting on an existing own question does not grant permission to create one. */
		readonly awaitOwnQuestion: boolean;
		readonly planApproval: boolean;
		readonly stopHooks: boolean;
	};
	/**
	 * 当前会话所处的编排方案。
	 *
	 * 与 `tools` 是正交的两件事：工具面收窄决定"编制者能看到什么"，
	 * 这里决定"派发时该去哪个方案的档位池取模型"。Agent 工具需要在
	 * execute 里拿到 profileId 才能按档位选模型，而工具面无法表达方案身份。
	 */
	readonly orchestration?: { readonly profileId: string };
}

export interface RuntimePolicyInput {
	variant: RuntimePolicy["variant"];
	subagentType?: string;
	customDefinition?: {
		toolAccess: "readOnly" | "general" | "custom";
		customTools: readonly string[];
	} | null;
	/** An inherited restriction may narrow, never widen, the selected profile. */
	readOnly?: boolean;
	/**
	 * 只允许这些内置工具名（与既有白名单取交集，绝不放大权限）。空数组视同未提供。
	 *
	 * 供编排编制者使用：编制者只能派发，不该自己找代码。
	 */
	extraToolNames?: readonly string[];
	/** 编排模式下的方案 ID；非空即该会话是编制者。 */
	orchestrationProfileId?: string;
}

/**
 * 只读工具集。编排档位（chore/quick）直接复用这个集合定义自己的工具等级，
 * 因此对外导出——但**不要**在别处另抄一份，两处漂移会让"只读"名不副实。
 */
export const READ_TOOLS = Object.freeze([
	"Read",
	"Glob",
	"Grep",
	"StructView",
	"WebSearch",
	"WebFetch",
	BASH_TOOL_NAME,
	"TeamStatus",
	"Await",
	"Question",
	"ContextAsk",
	"Send",
	// 编排会话的共享事实：它写的是进程内、随会话消失的内存结构，不碰工作区里的任何
	// 文件，所以放在只读集里不改变"只读档位不能动项目代码"这条边界。
	// 放在这里（而不是只挂在编排档位上）是因为四个档位、以及独立复核者都要能写：
	// 只读档位（chore/quick）恰恰是探查结论的主要来源，把它们排除在外等于废掉一半用途。
	SESSION_FACT_TOOL_NAME,
]);
/** 可写工具集（只读集 + 写入类工具）。 */
export const GENERAL_TOOLS = Object.freeze([...READ_TOOLS, "Write", "Edit", "Skill"]);
const SEARCH_TOOLS = Object.freeze([
	"WebSearch",
	"WebFetch",
	"TeamStatus",
	"Await",
	"Question",
	"ContextAsk",
	"Send",
]);

/**
 * 判断一个自定义工具集是否"恰好只读"。
 *
 * 存在的理由：`toolAccess: "custom"` 走的是自定义白名单分支，早先无条件把
 * `readOnly` 写成 false、MCP 写成 "nonDenied"——于是"全部候选都是只读工具"这种
 * 配置会被当成可写。回退恢复、审计与 UI 都依赖 `readOnly` 表达真实语义，
 * 所以这里按工具集的**实际内容**推导，而不是按调用方声明。
 *
 * MCP 名字（`mcp__*`）不参与判定：白名单里带 MCP 名是有意义的用法，
 * 而 MCP 的可写性由 `tools.mcp` 与每次调用的行为元数据单独把关，不该污染
 * 「内置工具是否全为只读」这个判断。
 *
 * 剩下的内置部分为空时**不算只读**：那是"没有内置工具"的退化配置
 * （可能只挂了几个 MCP 工具），描述成"只读"是过度承诺。
 */
function isReadOnlyToolSet(tools: readonly string[]): boolean {
	const builtin = tools.filter((name) => !name.startsWith("mcp__"));
	if (builtin.length === 0) return false;
	return builtin.every((name) => (READ_TOOLS as readonly string[]).includes(name));
}

export function resolveRuntimePolicy(input: RuntimePolicyInput): RuntimePolicy {
	const primary = input.variant === "primary";
	let builtin: RuntimePolicy["tools"]["builtin"] = primary ? "all" : READ_TOOLS;
	let mcp: RuntimePolicy["tools"]["mcp"] = primary ? "nonDenied" : "readOnly";
	let mcpNames: RuntimePolicy["tools"]["mcpNames"] = "all";
	let readOnly = !primary;
	if (!primary) {
		switch (input.subagentType) {
			case "general":
				builtin = GENERAL_TOOLS;
				mcp = "nonDenied";
				readOnly = false;
				break;
			case "search":
				builtin = SEARCH_TOOLS;
				mcp = "none";
				break;
			case "explore":
			case "plan":
			case "review":
				break;
			default:
				// Missing/invalid custom definitions fail closed to the read-only profile.
				if (input.customDefinition?.toolAccess === "general") {
					builtin = GENERAL_TOOLS;
					mcp = "nonDenied";
					readOnly = false;
				} else if (input.customDefinition?.toolAccess === "custom") {
					builtin = Object.freeze([...input.customDefinition.customTools]);
					mcpNames = builtin;
					// 按工具集实际内容推导，而不是按声明无条件放开：
					// 全员只读的候选集必须保持只读语义（MCP 也要收成 readOnly，
					// 否则显式白名单挡不住可写的 MCP 工具）。
					const readOnlySet = isReadOnlyToolSet(builtin);
					mcp = readOnlySet ? "readOnly" : "nonDenied";
					readOnly = readOnlySet;
				}
		}
	}
	if (input.readOnly) {
		builtin = builtin === "all" ? READ_TOOLS : builtin.filter((name) => READ_TOOLS.includes(name));
		if (mcp !== "none") mcp = "readOnly";
		readOnly = true;
	}
	// 工具面收窄（编排编制者）：只与既有白名单取交集，绝不放大权限。
	// 空数组视同未提供——那通常只是「没配」，而不是「一个工具都不给」，
	// 后者会把会话变成没有工具的会话，且症状与配置错误无法区分。
	const extraToolNames = input.extraToolNames;
	if (extraToolNames && extraToolNames.length > 0) {
		builtin =
			builtin === "all"
				? Object.freeze([...extraToolNames])
				: Object.freeze(builtin.filter((name) => extraToolNames.includes(name)));
		// 编制者不该看到 MCP 工具：MCP 的能力不由档位池定义，无法按档位解释。
		mcp = "none";
	}
	return Object.freeze({
		variant: input.variant,
		searchOnly: !primary && input.subagentType === "search",
		tools: Object.freeze({
			builtin: builtin === "all" ? builtin : Object.freeze(builtin),
			mcp,
			mcpNames,
			readOnly,
		}),
		...(input.orchestrationProfileId
			? { orchestration: Object.freeze({ profileId: input.orchestrationProfileId }) }
			: {}),
		capabilities: Object.freeze({
			spawnAgent: primary,
			awaitAgent: primary,
			sendAwait: primary,
			// Subagents cannot ask the user at all: a delegated task must proceed with
			// what it was given. The capability gate (not just the builtin list) is what
			// stops a custom definition from re-enabling the tool via customTools.
			askUserQuestion: primary ? "sync-or-async" : "disabled",
			awaitOwnQuestion: true,
			planApproval: primary,
			stopHooks: primary,
		}),
	});
}

/** Compatibility adapter for existing server-owned AgentConfig / ToolContext. */
export function runtimePolicyForContext(context?: {
	parentNarratorId?: string;
	/** Resolved by server assembly, never read from tool arguments. */
	runtimePolicy?: RuntimePolicy;
}): RuntimePolicy {
	return (
		context?.runtimePolicy ??
		resolveRuntimePolicy({ variant: context?.parentNarratorId ? "subagent" : "primary" })
	);
}

/** Shared by model schema consumers, the permission gate and the executing service. */
export function assertRuntimeCanAskQuestion(policy: RuntimePolicy): void {
	if (policy.capabilities.askUserQuestion === "disabled") {
		throw new Error("AskUserQuestion is not available under this runtime policy.");
	}
}

/** Visibility is an upper bound; the execution permission/ACL gates remain mandatory. */
export function isRuntimeToolAllowed(
	policy: RuntimePolicy,
	toolName: string,
	mcpBehavior?: string | null,
): boolean {
	const caps = policy.capabilities;
	if (toolName === "Question") return caps.awaitOwnQuestion;
	if (toolName === "AskUserQuestion" && caps.askUserQuestion === "disabled") return false;
	if (["Agent", "Task", "ContinueTask", "ForkNarrator"].includes(toolName) && !caps.spawnAgent)
		return false;
	if (["EnterPlanMode", "ExitPlanMode"].includes(toolName) && !caps.planApproval) return false;
	if (toolName.startsWith("mcp__")) {
		if (policy.tools.mcp === "none" || mcpBehavior === "deny") return false;
		if (policy.tools.mcpNames !== "all" && !policy.tools.mcpNames.includes(toolName)) return false;
		return policy.tools.mcp !== "readOnly" || mcpBehavior === "readOnly";
	}
	return policy.tools.builtin === "all" || policy.tools.builtin.includes(toolName);
}

export type RuntimeAwaitTarget = "agent" | "bash" | "transfer" | "question";
export function runtimeAwaitTargets(policy: RuntimePolicy): RuntimeAwaitTarget[] {
	return [
		...(policy.capabilities.awaitAgent ? ["agent" as const] : []),
		"bash",
		"transfer",
		...(policy.capabilities.awaitOwnQuestion ? ["question" as const] : []),
	];
}

/** Interaction instructions are a projection of the same finite capability policy. */
export function runtimeInteractionHint(policy: RuntimePolicy, locale: string): string {
	const lines: string[] = [];
	if (!policy.capabilities.sendAwait)
		lines.push(
			locale === "zh-CN"
				? "Send 只能异步发送，不得设置 await=true。"
				: "Send must be asynchronous; do not set await=true.",
		);
	if (!policy.capabilities.awaitAgent)
		lines.push(
			locale === "zh-CN"
				? "不得使用 Await(agent) 等待其他代理。"
				: "Do not use Await(agent) to wait for other agents.",
		);
	if (policy.capabilities.askUserQuestion === "disabled")
		lines.push(
			locale === "zh-CN"
				? "当前不可调用 AskUserQuestion 发起问题；Await(question) 仅可等待本会话已有的问题，不代表获得提问权限。"
				: "AskUserQuestion is unavailable; Await(question) may only wait on this session's existing questions and does not grant permission to ask new ones.",
		);
	return lines.join("\n");
}
