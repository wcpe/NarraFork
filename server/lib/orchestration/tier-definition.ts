/**
 * 档位 → 运行期定义的合成（阶段 2）。
 *
 * 关键设计：档位不引入新的 `RuntimePolicy` 输入维度，而是复用既有的
 * `customDefinition` —— 它在同一处同时驱动「工具集」与「系统提示词」，
 * 且续跑路径已会重新加载它。新开一条编排专用分支等于把同一件事实现两遍。
 */

import { GENERAL_TOOLS, READ_TOOLS } from "@server/services/agent-runtime/policy";
import { DEFAULT_LOCALE, type Locale } from "@shared/i18n-locales";
import { buildTierPrompt } from "./tier-prompts";
import {
	type OrchestrationTier,
	type OrchestrationToolTier,
	parseOrchestrationType,
	TIER_TOOL_TIER,
} from "./types";

// 编制者提示词与档位提示词同源，一并从这里转出，让编排消费者只需认这一个入口
export { buildOrchestratorPrompt, buildTierPrompt } from "./tier-prompts";

/**
 * 编制者（只调度者）可见的工具集。
 *
 * 刻意收窄：没有 Bash / Glob / Grep —— 那些才是"自己去找代码"的实际手段，
 * 而这一模式要求编制者只能通过派发来了解代码。
 *
 * `Read`、`Write`、`Edit` 是**有意的例外**：编制者要维护自己的 Dynamic Spec
 * （`spec://tasks.json` 任务队列），而系统级指令（Dynamic Spec 提醒、blocked/doing
 * 续跑消息）每一轮都在要求它更新这个文件。一个工具都不给，它就只能空转。
 *
 * 但"编制者不动项目代码"必须仍然成立，而且**读也要算**：`Read` 当初放行的理由只是
 * "看自己的任务清单"，它却是通用工具，实测被拿去翻源码，于是"编制者不干活"那条设计
 * 失效。因此真正的约束放在**执行期**而不是可见性：编制者上下文
 * （`runtimePolicy.orchestration?.profileId` 有值）下，`Read` 只允许 `spec://`、
 * `Write` / `Edit` 同样只允许 `spec://`，本地路径一律拒绝并提示改用 Agent 派发，
 * 见 `orchestrator-spec-write-guard.ts`。工具面收窄与执行期守卫是两道独立的闸门，
 * 只靠工具面表达这条约束会被"模型硬发一次调用"绕过。
 *
 * 刻意**不含** `EnterPlanMode` / `ExitPlanMode`：这两个工具把人引向"出计划 → 等用户
 * 批准 → 才允许派发"那道关卡，而本模式的要求恰恰相反——想法谈清楚就直接派发，
 * 计划的内容进 `Agent` 的 `prompt`（派单本身就是计划）。留着 `ExitPlanMode` 尤其危险：
 * 它的工具描述里写着"完成计划后用它请求批准"，等于在编制者手边放一个"提交计划并等待"
 * 的按钮，只要它按下去，用户看到的就是"出完计划卡住、什么都不干"。
 * 没有它不会造成死路：计划模式仍可由用户手动开（`POST /api/narrators/:id/plan-mode/enter`），
 * 出口是同一个 UI 开关（`/plan-mode/exit`），不经过编制者的工具面。
 *
 * 刻意**不含** `Skill`：它会把任意 markdown 原文当作指令注入对话，是一条不受档位
 * 约束的任意指令通道，而编制者的能力只应由档位池定义。
 * 也**不含** `TodoWrite`：本仓库从未注册过这个名字，授予它等于授予以空。
 */
export const ORCHESTRATOR_TOOLS: readonly string[] = Object.freeze([
	"Agent",
	"Await",
	"Send",
	"TeamStatus",
	"AskUserQuestion",
	"Read",
	"Write",
	"Edit",
]);

/**
 * 编排编制者的**执行期**工具白名单。
 *
 * 与 `ORCHESTRATOR_TOOLS`（可见性）是两件事：可见性只决定"发给模型的工具数组里有什么"，
 * 模型硬发一个没列出的工具调用时挡不住它（`tool-executor` 的执行期闸门才挡得住）。
 *
 * 与既有 OAuth 白名单**取交集**，绝不覆盖：编排模式是另一条授权来源，
 * 不能因为会话进了编排就拿到 OAuth 受限之外的工具。没有 OAuth 白名单时
 * 就是编制者集合本身。
 */
export function resolveOrchestratorExecutionAllowedTools(
	oauthAllowedTools?: ReadonlySet<string> | readonly string[] | null,
): Set<string> {
	if (!oauthAllowedTools) return new Set(ORCHESTRATOR_TOOLS);
	// OAuth 侧给的是 ReadonlySet，普通调用方给的是数组；`new Set` 对两者都成立。
	const oauth = new Set(oauthAllowedTools);
	return new Set(ORCHESTRATOR_TOOLS.filter((name) => oauth.has(name)));
}

/**
 * 装配 `AgentConfig.allowedTools`。
 *
 * 非编制者（普通 primary 与所有子代理）必须与此前完全一致：有 OAuth 白名单就照抄，
 * 没有就是 `undefined`（不设闸门）。只有编制者才额外与 `ORCHESTRATOR_TOOLS` 取交集。
 * 写成纯函数是为了让"非编排行为不变"这件事可以被直接断言，而不是只能靠读装配代码。
 */
export function resolveExecutionAllowedTools(input: {
	isOrchestrator: boolean;
	oauthAllowedTools?: ReadonlySet<string> | readonly string[] | null;
}): Set<string> | undefined {
	if (input.isOrchestrator) {
		return resolveOrchestratorExecutionAllowedTools(input.oauthAllowedTools);
	}
	return input.oauthAllowedTools ? new Set(input.oauthAllowedTools) : undefined;
}

/** 一次运行用的档位定义，形状直接对应 `RuntimePolicyInput.customDefinition` + 提示词。 */
export interface TierDefinition {
	toolAccess: "readOnly" | "general";
	customTools: readonly string[];
	prompt: string;
}

/**
 * 由档位合成运行期定义。
 *
 * 用 `"readOnly"` / `"general"` 两个现成枚举值，**不用 `"custom"`**：
 * `custom` 分支会走自定义白名单，而档位的工具集就是 policy 自己的标准集合，
 * 走 `custom` 只会引入一份不必要的拷贝与一次一致性维护负担。
 */
export function buildTierDefinition(tier: OrchestrationTier, locale?: Locale): TierDefinition {
	const toolTier: OrchestrationToolTier = TIER_TOOL_TIER[tier];
	const resolvedLocale = locale ?? DEFAULT_LOCALE;
	return {
		toolAccess: toolTier,
		customTools: toolTier === "general" ? GENERAL_TOOLS : READ_TOOLS,
		prompt: buildTierPrompt(tier, resolvedLocale),
	};
}

/** 该档位是否只读，供调用方做审计与 UI 展示。 */
export function isReadOnlyTier(tier: OrchestrationTier): boolean {
	return TIER_TOOL_TIER[tier] === "readOnly";
}

/**
 * 该档位是否允许自审（只写在编制者**显式要求**时才会跑）。
 *
 * 只读档位（chore/quick）没有可审的东西：自审提示词是围绕 `git diff` 与"重跑相关
 * 测试"组织的，而只读档位根本没有改动，它"重跑"的往往就是刚刚跑过的那一条命令。
 * 把一次完整模型调用花在"再确认一遍自己刚贴回来的输出"上，是纯粹的浪费——而
 * 探查阶段的这轮浪费正是用户明确要求消除的那笔开销。
 *
 * 规则刻意挂在**工具等级**上，而不是另立一份档位名单：两份名单迟早会漂移，
 * 而漂移的表现是"某个只读档位突然开始自审"这种谁也不会去查的症状。
 */
export function supportsSelfReview(tier: OrchestrationTier): boolean {
	return !isReadOnlyTier(tier);
}

/**
 * 编排 worker 的运行期定义。
 *
 * 字段形状刻意与 `CustomSubagentDef` 一致（`name`/`description`/`defaultModel`/
 * `location` 是子代理运行路径会读的占位字段），但不 import 那个类型：
 * 本模块在 lib 层，反向依赖 services 层的类型会把"谁能引用谁"搞乱。
 */
export interface OrchestrationWorkerDefinition {
	name: string;
	description: string;
	toolAccess: "readOnly" | "general";
	customTools: string[];
	defaultModel: string;
	prompt: string;
	location: string;
}

/**
 * 由编排 worker 的类型编码（`orch--<profileId>--<tier>`）还原出它的运行期定义。
 *
 * 存在的理由是**续跑**：worker 被 Send/continue 唤醒时不会重新走派发参数，
 * 只剩数据库里的 subagentType。若这时拿不到档位定义，policy 会 fail closed 到
 * 只读，medium/heavy 的 worker 会在续跑后突然失去写权限——症状是"同一个 worker
 * 有时能改文件有时不能"。
 *
 * 非编排类型返回 null，交由调用方按普通自定义子代理处理。
 */
export function buildOrchestrationWorkerDefinition(
	subagentType: string,
	locale?: Locale,
): OrchestrationWorkerDefinition | null {
	const parsed = parseOrchestrationType(subagentType);
	if (!parsed.ok) return null;
	const def = buildTierDefinition(parsed.tier, locale);
	return {
		name: subagentType,
		description: `Orchestration ${parsed.tier} worker`,
		toolAccess: def.toolAccess,
		customTools: [...def.customTools],
		// 空串表示"不覆盖调用方显式传入的模型"，与自定义子代理的语义一致
		defaultModel: "",
		prompt: def.prompt,
		location: "",
	};
}
