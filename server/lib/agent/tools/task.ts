import type { Locale } from "@shared/i18n-locales";
import type { OrchestrationLiveIdentity } from "@shared/orchestration-live";
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@shared/reasoning-effort";
import { isSubagentReasoningEffort, SUBAGENT_POOL_TYPES } from "@shared/subagent-model-policy";
import { z } from "zod/v4";
import {
	type RuntimePolicy,
	runtimePolicyForContext,
} from "../../../services/agent-runtime/policy";
import { broadcastToNarrator, type NarratorServerMessage } from "../../../websocket/narrator-ws";
import { logger } from "../../logger";
// 审计模块静态引入（与 parking 的动态引入形成对照）：它只依赖 db / id / logger，
// 不会反向引用服务层，因此不存在 parking 那条"静态引入会闭合出环"的顾虑；
// 而把写入留在派发路径上也要能一眼看到它从哪来。
import {
	finishOrchestrationRun,
	type OrchestrationRunHandle,
	recordOrchestrationRunFailure,
	startOrchestrationRun,
} from "../../orchestration/audit";
import {
	beginOrchestrationLiveRun,
	bindOrchestrationWorker,
	nextOrchestrationObservation,
	releaseOrchestrationLiveRun,
} from "../../orchestration/live";
// 只取类型：parking 在派发路径上是动态加载的（它会反向引用服务层，静态引入会闭合出环）。
import type { ParkedWorker } from "../../orchestration/parking";
import {
	type IndependentReviewSection,
	parseOrchestrationReceipt,
	type ReceiptParseResult,
	renderOrchestrationDispatchResult,
	type SelfReviewSection,
} from "../../orchestration/receipt";
import {
	resolveExecutorNarratorId,
	runIndependentReview,
	runSelfReview,
} from "../../orchestration/review";
import {
	acquireModelSlot,
	findEnabledProfile,
	selectPoolEntryForTier,
} from "../../orchestration/runtime";
// 静态引入（与 parking 的动态引入形成对照）：shared-facts 只依赖 node 内置模块、
// i18n 与 orchestration/types，不会反向引用服务层，因此不存在环。
import { inspectSharedFacts, renderSharedFactsBlock } from "../../orchestration/shared-facts";
import {
	buildOrchestrationWorkerDefinition,
	type OrchestrationWorkerDefinition,
	supportsSelfReview,
} from "../../orchestration/tier-definition";
// 只取 chore 指令的轻量校验：它是纯函数，与提示词同源放在一起，
// 免得"提示词要求精确"与"派发时不看指令"这两件事各说各话。
import {
	CHORE_INSTRUCTION_MIN_CHARS,
	isChoreInstructionTooVague,
} from "../../orchestration/tier-prompts";
import {
	buildOrchestrationType,
	type OrchestrationTier,
	resolveOrchestrationReviewConfig,
} from "../../orchestration/types";
import { normalizePathForComparison, resolvePath } from "../../platform-path";
import { shouldUseNativeSearch } from "../../search/native";
import { expandAllowedPoolForDisplay, getSubagentVisibleModels, settings } from "../../settings";
import type {
	AgentConfig,
	ToolCallBinding,
	ToolDefinition,
	ToolResult,
	ToolUpdateExecutionLease,
} from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

const TAKEOVER_BY_USER_DESCRIPTION =
	"Set to true to create this subagent directly in user takeover mode for further human interaction. " +
	"The Agent call returns immediately without requiring run_in_background. The initial prompt still runs, " +
	"but completion does not notify or wake the parent; the subagent stays taken over until the user explicitly ends takeover. " +
	"Do not automatically Await this agent.";

/** 发送派发观测；payload 只包含标量，避免把任务正文带入实时链路。 */
function broadcastDispatchObservation(
	identity: OrchestrationLiveIdentity,
	details: Record<string, string | number | boolean | null>,
): void {
	const observation = nextOrchestrationObservation(identity, {
		phase: "dispatch",
		source: "dispatch",
		details,
	});
	if (!observation) return;
	const parentMessage: NarratorServerMessage = {
		type: "orchestration_observation",
		narratorId: identity.coordinatorNarratorId,
		observation,
		...(identity.parentToolUseId ? { parentToolUseId: identity.parentToolUseId } : {}),
	};
	broadcastToNarrator(identity.coordinatorNarratorId, parentMessage);
}

const REASONING_EFFORT_DESCRIPTION =
	'Reasoning/thinking effort for this subagent. Use "none" to disable thinking where supported. ' +
	'Valid values: "none", "low", "medium", "high", "xhigh", "max" ("max" is only honored by some providers like DeepSeek; other providers clamp it down). ' +
	"If the selected model/provider does not support configurable thinking intensity, this option is ignored. " +
	"A fixed reasoning effort configured in the matching model pool overrides this parameter.";

/** 档位取值，与 orchestration/types.ts 的 ORCHESTRATION_TIERS 同源（顺序也一致）。 */
const TIER_VALUES = [
	"chore",
	"quick",
	"medium",
	"heavy",
] as const satisfies readonly OrchestrationTier[];

const TIER_DESCRIPTION =
	"Orchestration tier for this dispatch (required in orchestration mode). " +
	'"chore": trivial one-step lookup or verification (read-only). ' +
	'"quick": small read-only investigation (read-only). ' +
	'"medium": scoped implementation in one module (can write). ' +
	'"heavy": multi-file implementation or refactor (can write). ' +
	"The model comes from the profile's pool for that tier — do not also pass `model`.";

const SELF_REVIEW_DESCRIPTION =
	"Orchestration only. Ask the executor to run one extra self-review turn after it finishes, in the SAME worker with the SAME context: it re-reads its own diff, re-runs the relevant tests, and re-checks its own receipt line by line. " +
	"Defaults to FALSE, and you should leave it that way for a plain lookup or a first reconnaissance pass — you are not billed less by reviewing nothing. " +
	'Only the writable tiers support it: "medium" and "heavy" are accepted, "chore" and "quick" are rejected (a read-only worker has no change to look back at). ' +
	"Set it to true when the dispatch is one you cannot cheaply redo and nothing else is checking it: the change is hard to undo (deletions, migrations, behaviour other code depends on), it spans several files, no independent review is configured for this profile, or you expect a receipt with confidence below `high` or verdict `partial`.";

const SUBAGENT_TYPE_DESCRIPTION =
	'The type of specialized agent to use for this task. Built-in types: "explore" (read-only codebase exploration), "plan" (architecture planning, only in plan mode), "general" (full write access). You can also use any custom subagent type name defined by the user.';

const ORCHESTRATED_SUBAGENT_TYPE_DESCRIPTION =
	"In orchestration mode the subagent type is derived from `tier`; leave this unset.";

// Use text import so the bundler inlines the file content at build time
import baseDescription from "./task.txt" with { type: "text" };

/** Build a dynamic model list string from all visible models. */
function getAvailableModelsList(): string {
	const models = getSubagentVisibleModels();
	if (models.length > 0) {
		return models.join(", ");
	}
	return "(no models configured yet)";
}

function filterSubagentModels(models: string[]): string[] {
	const visible = new Set(getSubagentVisibleModels());
	return models.filter((model) => visible.has(model));
}

const MODEL_PARAM_BASE =
	"Override the model for this subagent. An explicit model or a selected per-type/custom model preference pins the child independently. Otherwise it follows the parent narrator's current model, including later switches when resumed or before the next model request. Allowed model pools still apply.";

function getModelParameterDescription(config?: AgentConfig): string {
	// Per-narrator custom restriction trait takes precedence and already describes the pools.
	if (config?.subagentModelRestrictionDescription) {
		return `${MODEL_PARAM_BASE}\n\n${config.subagentModelRestrictionDescription}`;
	}

	// Global per-type pool restriction (settings.agent.subagentAllowedModels).
	const pools = settings.agent.subagentAllowedModels;
	const restrictedParts: string[] = [];
	const unrestrictedTypes: string[] = [];
	if (pools) {
		for (const type of SUBAGENT_POOL_TYPES) {
			const pool = pools[type];
			if (pool && pool.length > 0) {
				const availablePool = filterSubagentModels(pool);
				const efforts = settings.agent.subagentModelReasoningEfforts?.[type];
				// Keep the old compact display untouched when this pool has no fixed tiers.
				const models = availablePool.some((model) => isSubagentReasoningEffort(efforts?.[model]))
					? availablePool.map((model) => {
							const display = expandAllowedPoolForDisplay([model]).join(", ");
							const effort = efforts?.[model];
							return isSubagentReasoningEffort(effort)
								? `${display} [fixed reasoning_effort=${effort}]`
								: display;
						})
					: expandAllowedPoolForDisplay(availablePool);
				restrictedParts.push(`${type}: ${models.join(", ")}`);
			} else {
				unrestrictedTypes.push(type);
			}
		}
	}

	// No restriction configured at all — list every visible model.
	if (restrictedParts.length === 0) {
		return `${MODEL_PARAM_BASE} Available models: ${getAvailableModelsList()}`;
	}

	// At least one type is restricted: describe the allowed pool per type instead of
	// dumping every visible model (which would be misleading).
	let note = `${MODEL_PARAM_BASE}\n\nNote: Subagent model selection is restricted per type. Allowed models — ${restrictedParts.join("; ")}. Models outside the pool for a given type will be ignored.`;
	if (unrestrictedTypes.length > 0) {
		note += ` For ${unrestrictedTypes.join(", ")} (not restricted), any available model may be used: ${getAvailableModelsList()}.`;
	}
	return note;
}

/**
 * 判定给定的运行期策略是否属于编排编制者。
 *
 * 用**结构化字段** `orchestration.profileId`，不从工具面形状反推。
 * 早先的写法是"能看到 Agent、且看不到 Write 与 Bash"——那是个脆弱的间接判断：
 * 编制者为了维护 Dynamic Spec 任务队列必须保留 `Write`（仅限 `spec://`，
 * 见 orchestrator-spec-write-guard），工具面一变动，这个判断就静默失效，
 * 症状是 `tier` 参数从编制者的 schema 里消失（派发没有档位可依）而没有任何报错。
 * 该字段由 `resolveRuntimePolicy` 在装配时写入，每轮重新解析，恢复/续跑同样成立。
 */
function isOrchestratorPolicy(policy: RuntimePolicy | undefined): boolean {
	return Boolean(policy?.orchestration?.profileId);
}

/** 编制者上下文的 schema 判定，供调用方与测试直接使用。 */
export function isOrchestratorSchemaContext(config?: AgentConfig): boolean {
	return isOrchestratorPolicy(config?.runtimePolicy);
}

/** 判断字符串是否为合法档位取值。 */
function isOrchestrationTierValue(value: string): value is OrchestrationTier {
	return (TIER_VALUES as readonly string[]).includes(value);
}

function buildParameters(config?: AgentConfig) {
	const orchestrated = isOrchestratorSchemaContext(config);
	const shape = {
		description: z
			.string()
			.optional()
			.describe("A short (3-5 word) description of the task (required when launching a new agent)"),
		subagent_type: z
			.string()
			.optional()
			.describe(orchestrated ? ORCHESTRATED_SUBAGENT_TYPE_DESCRIPTION : SUBAGENT_TYPE_DESCRIPTION),
		run_in_background: z
			.boolean()
			.optional()
			.describe(
				"Set to true to run this agent in the background. You will be notified when it completes.",
			),
		takeover_by_user: z.boolean().optional().describe(TAKEOVER_BY_USER_DESCRIPTION),
		timeout: looseNumber(
			"Optional execution timeout for this subagent in milliseconds. Background runs default to 5 hours when omitted; use 0 for no wall-clock limit or provide any positive safe integer. This controls the Agent run itself, not Await waiting.",
		),
		model: z.string().optional().describe(getModelParameterDescription()),
		reasoning_effort: z
			.enum(REASONING_EFFORT_VALUES)
			.optional()
			.describe(REASONING_EFFORT_DESCRIPTION),
		workdir: z
			.string()
			.optional()
			.describe(
				"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
			),
		prompt: z
			.string()
			.optional()
			.describe("The task for the agent to perform (required when launching a new agent)"),
		alias: z
			.string()
			.optional()
			.describe(
				'A short human-readable alias for this background task (e.g. "run-tests", "build-frontend"). ' +
					"Must be unique within the current session. If omitted, an alias is auto-generated from the description. " +
					"Use this alias with Await or Send to reference the task later.",
			),
		stop: z
			.string()
			.optional()
			.describe(
				"Stop a running background agent task by its ID or alias. When provided, no new agent is launched.",
			),
		archive: z
			.string()
			.optional()
			.describe(
				"Archive a subagent by its ID or alias. When provided, no new agent is launched. " +
					"Running work is stopped first. Archived subagents are excluded from TeamStatus " +
					"broadcast (@all members) and will not be woken by broadcasts; direct Send to them is also rejected.",
			),
		unarchive: z
			.string()
			.optional()
			.describe(
				"Restore an archived subagent by its ID or alias so it can receive messages and " +
					"broadcasts again. When provided, no new agent is launched.",
			),
	};
	// 非编排上下文里 schema 中**绝不能**出现 tier：模型看到不存在的参数会开始猜它，
	// 而这里没有任何东西能让那个猜测落地。编排上下文里 tier 是必填——缺了它，
	// "派发"就没有档位可依，静默降级成 general 会让编制者以为自己在分层调度。
	//
	// `self_review` 同理只在编排上下文里出现：它是编排的校验开关，在别的会话里
	// 没有任何东西能让它落地，而"以为要了自审、其实没有"正是本参数要消除的那类误解。
	return orchestrated
		? z.object({
				...shape,
				tier: z.enum(TIER_VALUES).describe(TIER_DESCRIPTION),
				self_review: z.boolean().optional().describe(SELF_REVIEW_DESCRIPTION),
			})
		: z.object(shape);
}

function usesNativeWebSearch(config: AgentConfig): boolean {
	return shouldUseNativeSearch(config.provider, config.model);
}

function buildRawJsonSchema(config?: AgentConfig): Record<string, unknown> {
	const orchestrated = isOrchestratorSchemaContext(config);
	return {
		type: "object" as const,
		properties: {
			description: {
				description:
					"A short (3-5 word) description of the task (required when launching a new agent)",
				type: "string",
			},
			subagent_type: {
				description: orchestrated
					? ORCHESTRATED_SUBAGENT_TYPE_DESCRIPTION
					: 'The type of specialized agent to use for this task. Built-in types: "explore", "plan", "search", "general". Custom types are also supported.',
				type: "string",
			},
			run_in_background: {
				description:
					"Set to true to run this agent in the background. You will be notified when it completes.",
				type: "boolean",
			},
			takeover_by_user: {
				description: TAKEOVER_BY_USER_DESCRIPTION,
				type: "boolean",
			},
			timeout: {
				description:
					"Optional execution timeout in milliseconds. Background runs default to 5 hours when omitted; use 0 for no wall-clock limit or provide any positive safe integer. This controls the Agent run, not Await waiting.",
				type: "number",
			},
			model: {
				description: getModelParameterDescription(config),
				type: "string",
			},
			reasoning_effort: {
				description: REASONING_EFFORT_DESCRIPTION,
				type: "string",
				enum: REASONING_EFFORT_VALUES,
			},
			workdir: {
				description:
					"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
				type: "string",
			},
			alias: {
				description:
					'A short human-readable alias for this background task (e.g. "run-tests", "build-frontend"). ' +
					"Must be unique within the current session. If omitted, an alias is auto-generated from the description. " +
					"Use this alias with Await or Send to reference the task later.",
				type: "string",
			},
			stop: {
				description:
					"Stop a running background agent task by its ID or alias. When provided, no new agent is launched.",
				type: "string",
			},
			archive: {
				description:
					"Archive a subagent by its ID or alias. When provided, no new agent is launched. " +
					"Running work is stopped first. Archived subagents are excluded from TeamStatus " +
					"broadcast (@all members) and will not be woken by broadcasts; direct Send to them is also rejected.",
				type: "string",
			},
			unarchive: {
				description:
					"Restore an archived subagent by its ID or alias so it can receive messages and " +
					"broadcasts again. When provided, no new agent is launched.",
				type: "string",
			},
			prompt: {
				description: "The task for the agent to perform (required when launching a new agent)",
				type: "string",
			},
			// tier 与 self_review 只在编排上下文的 schema 里出现（判定与理由见 buildParameters）
			...(orchestrated
				? {
						tier: {
							description: TIER_DESCRIPTION,
							type: "string",
							enum: [...TIER_VALUES],
						},
						self_review: {
							description: SELF_REVIEW_DESCRIPTION,
							type: "boolean",
						},
					}
				: {}),
		},
		required: orchestrated ? ["tier"] : ([] as string[]),
		additionalProperties: false,
	};
}

/**
 * Resolve an Agent archive/unarchive selector to a narrator id.
 *
 * Order mirrors stop mode, then falls through to the shared Send/Await selector
 * grammar so a title or slug printed by TeamStatus can be archived directly.
 */
async function resolveArchiveTargetId(callerNarratorId: string, selector: string): Promise<string> {
	const trimmed = selector.trim();
	const { resolveTaskAlias } = await import("@server/services/narrator-subagent");
	const fromAlias = resolveTaskAlias(callerNarratorId, trimmed);
	if (fromAlias !== trimmed) return fromAlias;

	const { backgroundTaskService } = await import("@server/services/background-task-service");
	const task = await backgroundTaskService.getByAlias(trimmed, callerNarratorId);
	if (task?.subagentNarratorId) return task.subagentNarratorId;
	if (task) return task.id;

	const { resolveSubagentTargets } = await import("@server/services/agent-communication");
	const targets = await resolveSubagentTargets({
		callerNarratorId,
		id: trimmed,
	}).catch(() => []);
	if (targets.length === 1) return targets[0].id;
	return trimmed;
}

/**
 * 停放中的编排 worker 只在**与新建语义等价**时才复用。
 *
 * 复用走的是"唤醒既有 worker 而不是新建"：工作目录、显式别名、推理强度都由
 * worker 的既有记录决定，复用给不出这些本次才提出的要求。后台运行的差别更根本——
 * 那条路要把结论发布到 worker **首次派发时**那次调用的工具结果上，而当前这轮需要
 * 的是一个能拿去 Await 的新句柄，两者不是同一件事。只要调用方要求了其中任何一项，
 * 复用就不再等价于新建——此时宁可新建一个。
 */
function canReuseParkedWorkerForDispatch(raw: {
	run_in_background?: boolean;
	background?: boolean;
	workdir?: string;
	alias?: string;
	reasoning_effort?: ReasoningEffort;
}): boolean {
	if (raw.run_in_background || raw.background) return false;
	if (raw.workdir) return false;
	if (raw.alias) return false;
	return raw.reasoning_effort === undefined;
}

interface ReuseParkedWorkerInput {
	/** 本次派发的新 run 身份；复用 worker 不得沿用旧 run。 */
	orchestration?: OrchestrationLiveIdentity;
	/** 认领回来的登记项：复用失败时要靠它把 worker 原样放回池子。 */
	parked: ParkedWorker;
	model: string;
	/**
	 * 本次派发给该档位选中的池条目上的思考强度（没配则 `undefined`）。
	 *
	 * 复用路径必须同样应用它：worker 上一次是用旧配置跑热的，池条目改了强度之后
	 * 若不复用侧不写，`复用的那些派发` 会一直沿用旧等级——而复用恰恰是跑过几次之后
	 * 的常态路径，于是"改了配置没生效"会稳定复现且极难归因。
	 */
	reasoningEffort?: ReasoningEffort;
	prompt: string;
	locale: string;
	signal: AbortSignal;
	timeoutMs: number | undefined;
	userId: string | null;
	/**
	 * 本次派发的工具卡片（provider `tool_use` id）。
	 *
	 * 复用与新建的差别就在这里：新建时"谁执行了这次调用"由 `origin_tool_call_id`
	 * 记下（创建溯源），复用时不新建、那一列不动（它被 ACL / revert / COW 共用），
	 * 于是本次派发与执行者的对应关系只能靠 worker 这一轮消息的落点表达。
	 */
	toolUseId: string;
}

/**
 * 把一个停放中的编排 worker 唤醒，并把本次任务交给它。
 *
 * 成功返回它的终态输出（形态与新建前台派发一致：`<subagent_id>` 标签 + 最终文本）。
 * 失败一律返回 `undefined` 让调用方回退新建——复用是优化，不是任务的一部分，
 * 任何一步出错都不能让整个派发被判失败。
 *
 * **三条失败出口都必须把 worker 归还池子**（{@link giveUp}）：认领已经把它从登记簿
 * 摘掉了，而为了续跑又必须先把状态从 archived 写成 idle，于是失败之后它既不在池子里、
 * 也不是归档态。没有任何路径会修复这个组合（唯一会重新登记的是"某个 run 归还租约"，
 * 而它再也不会跑；登记簿重建是每进程一次且只认 archived），池子就静默缩水并留下一个
 * `idle` 孤儿——它参与 TeamStatus 广播、还能被 Send 驱动，与"已归档 = 不接受 Send"
 * 直接矛盾。
 *
 * 有副作用的写入（idle / model / 运行时 model）刻意排在**只读校验之后**：它们一旦写下
 * 去，失败就只能靠回滚收拾，而回滚本身也可能失败。
 */
async function runReusedOrchestrationWorker(
	input: ReuseParkedWorkerInput,
): Promise<string | undefined> {
	const narratorId = input.parked.narratorId;
	/**
	 * 放弃这次复用：把 worker 放回池子，然后让调用方回退新建。
	 *
	 * 归还失败时 `restoreParkedWorker` 自己会记一条 warn 说明它已掉出池子并给出 id；
	 * 这里绝不因为归还失败而把整个派发判失败。
	 */
	const giveUp = async (reason: string): Promise<undefined> => {
		logger.warn("Failed to reuse a parked orchestration worker; falling back to a new dispatch", {
			narratorId,
			reason,
		});
		const { restoreParkedWorker } = await import("../../orchestration/parking");
		await restoreParkedWorker(input.parked);
		return undefined;
	};

	try {
		const { narratorService } = await import("@server/services/narrator-service");
		const { resumeSubagent } = await import("@server/services/narrator-subagent");
		const { updateNarratorModel } = await import("@server/services/narrator-session");
		// 与停放判定同源：停放把"执行租约还挂在自己名下"算作"还在跑"。
		const { isNarratorRuntimeBusy } = await import("@server/services/narrator-session-state");

		// 1. 只读校验：确认这一次真能起来。`claimReusableWorker` 已经复核过一遍，
		//    这里是同一断言的第二次机会——认领与这里之间隔着一次 await，中间可能有人
		//    把它跑起来。查完这三条再动任何有副作用的东西。
		const worker = await narratorService.getById(narratorId);
		if (!worker || worker.parentNarratorId !== input.parked.parentNarratorId) {
			return await giveUp("the worker row is gone or changed owner");
		}
		if (worker.status !== "archived") return await giveUp(`the worker is ${worker.status}`);
		if (isNarratorRuntimeBusy(narratorId)) return await giveUp("the worker is still running");

		// 2. 解除归档。归档的语义是"不参与广播、不接受直接 Send"，而
		//    `resumeSubagent` 显式拒绝 archived 状态，所以必须先回到 idle。
		await narratorService.updateStatus(narratorId, "idle");
		// 3. 复用时模型可能因池调度而不同。写库与写运行时两步的顺序与
		//    `PATCH /:id/model` 一致（会话已随归档关闭时第二步是空操作）。
		await narratorService.updateModel(narratorId, input.model);
		updateNarratorModel(narratorId, input.model);
		// 3b. 池条目上的思考强度同样要跟着这次复用写下去。只在确实配了值时才写：
		//     `undefined` 表示"编制者没有意见"，此时必须让 worker 保留它自己的值
		//     （可能是用户手动调的），而不是把历史配置强行改成 provider 默认。
		//     两条写库/写运行时的顺序与 `PATCH /:id/reasoning-effort` 一致。
		if (input.reasoningEffort) {
			const { updateNarratorReasoningEffort } = await import("@server/services/narrator-session");
			await narratorService.updateReasoningEffort(narratorId, input.reasoningEffort);
			updateNarratorReasoningEffort(narratorId, input.reasoningEffort);
		}
		// 4. 走既有续跑入口。`follow_up` 是唯一会持久化新用户消息的 intent，
		//    正是"再交给它一件事"的语义。
		const resumed = await resumeSubagent({
			orchestration: input.orchestration,
			subagentId: narratorId,
			intent: "follow_up",
			actor: "parent_agent",
			prompt: input.prompt,
			locale: input.locale as Locale,
			signal: input.signal,
			timeoutMs: input.timeoutMs,
			createdBy: input.userId,
			resumableUpdateLease: true,
			// 本次派发的结论归**当前**这次 Agent 调用。这个 worker 首次派发时那次
			// 调用的历史工具结果已经被告知过一次，改写它等于篡改历史。
			skipConclusionDelivery: true,
			// 把"这次派发"记下来：worker 的创建溯源只记得首次派发，而它这一轮的提示
			// 必须落在**本次**卡片下——活动摘要（模型徽标 / 最近调用 / 打开完整会话）
			// 正是按落点找执行者的。不给的话，复用派发的卡片只会拿到占位值。
			dispatchAnchorToolUseId: input.toolUseId,
		});
		if (!resumed.started) return await giveUp("the resume was refused");
		const output = await resumed.terminalCompletion;
		// 起跑却没给出终态文本：调用方会回退新建，所以它同样算这次复用没成。
		// （空串是"跑完了但没说话"，与原来的 `?? undefined` 语义一致地照常返回。）
		if (output === undefined) return await giveUp("the resumed run produced no conclusion");
		return output;
	} catch (err) {
		return await giveUp(err instanceof Error ? err.message : String(err));
	}
}

// ---------------------------------------------------------------------------
// 阶段 5：派发之后的校验（自审 + 独立复核）
// ---------------------------------------------------------------------------

/** 一次编排派发在碰任何数据之前就定下来的全部参数。 */
interface OrchestrationDispatchPlan {
	model: string;
	/**
	 * 该档位池条目上配置的思考强度；没配就是 `undefined`。
	 *
	 * `undefined` 与"配成某一档"必须一直可区分：它只表示"编制者没有意见"，
	 * 最终用哪个值由 `runSubagent` 那条既有回落链决定（类型池固定值 → 本值
	 * → 子代理自己记录的值 → provider 默认）。在这里补一个默认值会把这个
	 * 区分抹掉，也会让"没配"凭空变成一次显式覆盖。
	 */
	reasoningEffort?: ReasoningEffort;
	subagentType: string;
	customDefinition: OrchestrationWorkerDefinition;
	profileId: string;
	tier: OrchestrationTier;
	/**
	 * 这次派发**是否要求**自审。默认 false。
	 *
	 * 与 `profile.review.selfReview` 是两件事，二者都成立才会跑自审：
	 * 方案开关是管理员层面的"允许/禁止"，本字段是编制者这一次的决定。
	 * 合成一个开关就必然要在"某个方案不开自审"和"某次派发不要自审"之间做取舍，
	 * 而两者的应对方式完全不同（前者找管理员，后者换个参数再派一次）。
	 */
	selfReview: boolean;
}

/**
 * 执行者的最终文本。
 *
 * 优先用既有 API（它跨 compact 边界，比解析 runner 的返回值更可靠——后者带着
 * `<subagent_id>` 标签与文件变更摘要）。取不到时必须退回空串而不是 `"(no output)"`：
 * 那是 `getSubagentFinalText` 自己的兜底文案，把它当文本解析只会得到一份假的未回执。
 */
/**
 * 渲染本会话的共享事实块，交给即将派出的执行者。
 *
 * 每读一次都重新对着工作区验一遍锚点（见 `shared-facts.ts`），因此这里**不能**缓存：
 * 上一次派发时还成立的事实，这一次可能已经不成立了，而缓存正好会把那个差别抹掉。
 *
 * 任何失败都退回空串：共享是增益，让一次派发因为"事实池坏了"而失败是本末倒置。
 */
async function loadSharedFactsBlock(
	sessionKey: string,
	workspaceRoot: string,
	locale: Locale,
): Promise<string> {
	try {
		const inventory = await inspectSharedFacts(sessionKey);
		if (!inventory) return "";
		// 池子的工作区与本次派发的工作区不一致时**不注入**：相对路径在不同工作区里
		// 指的是不同文件，而 `renderSharedFactsBlock` 无法表达这件事。宁可这一轮少共享。
		if (
			normalizePathForComparison(workspaceRoot) !==
			normalizePathForComparison(inventory.workspaceRoot)
		) {
			return "";
		}
		return renderSharedFactsBlock(inventory, locale);
	} catch (err) {
		logger.warn("Failed to render the orchestration shared-facts block; continuing without it", {
			sessionKey,
			error: err instanceof Error ? err.message : String(err),
		});
		return "";
	}
}

async function readExecutorFinalText(narratorId: string | null): Promise<string> {
	if (!narratorId) return "";
	const { getSubagentFinalText } = await import("@server/services/narrator-session");
	const text = await getSubagentFinalText(narratorId).catch(() => "");
	const trimmed = text.trim();
	return trimmed && trimmed !== "(no output)" ? text : "";
}

/**
 * 编排派发跑完之后的收尾：自审 → 独立复核 → 组装成编制者读到的那一条文本。
 *
 * 顺序是硬约束，不能挪进 `finalizeSubagent`：那里执行者已到终态，而执行者的停放
 * （`narrators.status = "archived"`）发生在它自己的执行租约归还之后，
 * 归档之后 `resumeSubagent` 会拒绝续跑（见 `runSelfReview` 关于"先 ensure idle"的说明）。
 *
 * **不做自动重派**：`profile.review.maxReworkAttempts` 在本阶段不用于自动重派。
 * 是否重派是编制者的决定——它手上有 `blockers` / `notDone` / `confidence`，
 * 而且它知道这次派发在整盘计划里的位置；引擎按次数盲目重试同一件事，
 * 只会把一份"没做成"的活重复烧钱，还掩盖了真正该改的是任务描述这一事实。
 * 该字段因此暂时只是配置预留，不是"实现了但没接上"。
 *
 * **自审是按需的**（`dispatch.selfReview`，默认 false）：方案开关只表示"允许"，
 * 真正的触发条件是这次派发显式要了它。默认不跑是刻意的——探查类的派发没有改动可审，
 * 无条件跑一轮就是把一次完整模型调用扔在了没有任何东西可看的地方。
 *
 * 无论哪条复核路径最终跑了、哪条没跑，返回文本**总是**带齐这两段：编制者必须能区分
 * "没人验证过"与"验证通过了"，以及"这次我没要"与"方案不给"。少了这些，一份 `pass`
 * 会被读成"已经有人复核过"。
 */
async function finishOrchestratedDispatch(input: {
	dispatch: OrchestrationDispatchPlan;
	executorNarratorId: string | null;
	executorOutput: string;
	taskBrief: string;
	parentNarratorId: string;
	cwd: string;
	locale: string;
	signal: AbortSignal;
	userId: string | null;
	timeoutMs: number | undefined;
	toolUseId: string;
	toolCallBinding: ToolCallBinding;
	updateExecutionLease: ToolUpdateExecutionLease;
	/** 本次派发的审计句柄；登记失败时为 `null`（收尾随即变成空操作）。 */
	run: OrchestrationRunHandle | null;
	/** 执行者是不是从停放池里复用来的。 */
	reusedWorker: boolean;
	/** 收尾时读出来的共享事实块（空串表示这轮没有可共享的内容）。 */
	sharedFacts: string;
}): Promise<string> {
	const profile = findEnabledProfile(input.dispatch.profileId);
	// 方案在飞的过程中被关掉时，我们连复核档位的模型池都读不到：如实跳过，不猜。
	const review = profile ? resolveOrchestrationReviewConfig(profile.review) : null;
	const executorText = await readExecutorFinalText(input.executorNarratorId);
	// 回执优先取自审轮：那一轮是执行者在看过自己改动之后说的话。
	let receiptSource = executorText || input.executorOutput;
	// 跳过时的原因必须分开写：方案说"不允许自审"（配置事实，再派也不会有）与
	// "这次没要求"（编制者自己的选择，随时可以改）是两件不同的事，合成一句"未自审"
	// 会让编制者无从判断该找管理员还是改参数。两者都还没跑过，所以先记下原因、再决定要不要跑。
	let selfReview: SelfReviewSection = review?.selfReview
		? { kind: "skipped", reason: "not_requested" }
		: { kind: "skipped", reason: "disabled" };

	if (review?.selfReview && input.dispatch.selfReview) {
		if (!input.executorNarratorId) {
			// 没有执行者 id 就续跑不了**同一个** worker。这里刻意不换成"另派一个复核者"：
			// 那会把"自审"（同一段上下文）与"复核"（没有上下文）混为一谈，编制者会误以为
			// 执行者已经回看过自己的产物。
			selfReview = { kind: "failed" };
		} else {
			const text = await runSelfReview({
				narratorId: input.executorNarratorId,
				parentNarratorId: input.parentNarratorId,
				tier: input.dispatch.tier,
				locale: input.locale as Locale,
				signal: input.signal,
				timeoutMs: input.timeoutMs,
				userId: input.userId,
			});
			if (text.trim()) {
				selfReview = { kind: "executed" };
				receiptSource = text;
			} else {
				// 空串 = 自审没能跑成（或中途失败）。此时退回执行者自己的输出，
				// 但状态必须如实写成"未经自审"，否则编制者会把旧回执当成自审结论。
				selfReview = { kind: "failed" };
			}
		}
	}

	const receipt: ReceiptParseResult = parseOrchestrationReceipt(receiptSource);
	let independentReview: IndependentReviewSection = { kind: "skipped", reason: "disabled" };
	if (review?.independentReview) {
		if (input.signal.aborted) {
			independentReview = { kind: "skipped", reason: "aborted" };
		} else {
			const outcome = await runIndependentReview({
				executorNarratorId: input.executorNarratorId,
				parentNarratorId: input.parentNarratorId,
				profileId: input.dispatch.profileId,
				reviewTier: review.reviewTier,
				taskBrief: input.taskBrief,
				// 只有解析成功的回执才有可靠的改动清单；没解析出来就给空表，
				// 让复核者自己去 `git diff` 找（它的提示词本来就要求这么做）。
				changedFiles: receipt.kind === "parsed" ? receipt.receipt.changedFiles : [],
				executorReceipt: receipt,
				locale: input.locale as Locale,
				toolUseId: input.toolUseId,
				toolCallBinding: input.toolCallBinding,
				updateExecutionLease: input.updateExecutionLease,
				cwd: input.cwd,
				signal: input.signal,
				userId: input.userId,
				timeoutMs: input.timeoutMs,
			});
			if (outcome.output.trim()) {
				independentReview = {
					kind: "executed",
					result: parseOrchestrationReceipt(outcome.output),
				};
			} else if (outcome.failure === "no_model" || outcome.failure === "aborted") {
				independentReview = { kind: "skipped", reason: outcome.failure };
			} else {
				independentReview = { kind: "failed", reason: "error" };
			}
		}
	}

	const output = renderOrchestrationDispatchResult(
		{
			executorOutput: input.executorOutput,
			receipt,
			selfReview,
			independentReview,
			sharedFacts: input.sharedFacts,
		},
		input.locale as Locale,
	);

	// 收尾审计：这一行回答"这次派发走到了哪一步、花了多久、判定是什么"。
	//
	// 阶段是**推断出来的**而不是另记一个状态位：走到"独立复核跑过"的才是 `reviewed`，
	// 只有自审跑过的退一档为 `self_reviewed`，两条复核路径都没跑过（开关关着、
	// 这次没要、或都没跑成）就如实停在 `dispatched`——"复核没跑成"是一个缺席，
	// 硬把它升格成阶段会让人以为复核发生过。默认不再自审之后，绝大多数派发都会停在这里。

	await finishOrchestrationRun(input.run, {
		phase:
			independentReview.kind === "executed"
				? "reviewed"
				: selfReview.kind === "executed"
					? "self_reviewed"
					: "dispatched",
		workerNarratorId: input.executorNarratorId,
		reusedWorker: input.reusedWorker,
		// verdict 只取解析成功的回执；没解析出来就留空，而不是编一个 `partial`
		// （`partial` 是"解析到了但字段不合法"的结论，两者不能混）。
		verdict: receipt.kind === "parsed" ? receipt.receipt.verdict : null,
	});
	return output;
}

export const agentTool: ToolDefinition = {
	name: "Agent",
	description(config: AgentConfig) {
		if (usesNativeWebSearch(config)) {
			return baseDescription.replaceAll("WebSearch", "web_search (native)");
		}
		return baseDescription;
	},
	get parameters() {
		// 无 config 的 zod schema 用于内部校验（tool-executor 的参数校验、权限判定），
		// 因此它必须保持"宽容"：编排档位只约束发给模型的 JSON Schema
		// （getRawJsonSchema(config)），不能让内部校验因为缺少 tier 而把一次
		// 本来合法的非编排调用判成非法。getter 也拿不到 config —— 这是刻意的。
		return buildParameters();
	},
	get rawJsonSchema() {
		return buildRawJsonSchema();
	},
	getRawJsonSchema(config?: AgentConfig) {
		return buildRawJsonSchema(config);
	},
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as {
			prompt?: string;
			description?: string;
			subagent_type?: string;
			tier?: string;
			self_review?: boolean;
			run_in_background?: boolean;
			takeover_by_user?: boolean;
			timeout?: number;
			model?: string;
			reasoning_effort?: ReasoningEffort;
			workdir?: string;
			alias?: string;
			stop?: string;
			archive?: string;
			unarchive?: string;
			// Legacy parameter name (pre-rename compat)
			background?: boolean;
		};

		// Lifecycle commands are mutually exclusive with each other and with launch.
		const lifecycleModes = [raw.stop, raw.archive, raw.unarchive].filter(Boolean);
		if (lifecycleModes.length > 1) {
			return {
				output:
					"Agent tool error: stop, archive, and unarchive are mutually exclusive — provide only one.",
				isError: true,
			};
		}

		// --- 编排模式校验 ---
		// profileId 由服务端解析的运行期策略提供（模型参数不可能伪造它）。
		const runtimePolicy = runtimePolicyForContext(ctx);
		const orchestrationProfileId = runtimePolicy.orchestration?.profileId;
		const tier = typeof raw.tier === "string" ? raw.tier.trim() : "";
		if (orchestrationProfileId) {
			if (!tier) {
				return {
					output: "编排模式下必须指定档位（chore/quick/medium/heavy）",
					isError: true,
				};
			}
			if (!isOrchestrationTierValue(tier)) {
				return {
					output: `无效档位 "${tier}"：只能是 chore / quick / medium / heavy`,
					isError: true,
				};
			}
			if (raw.model) {
				return {
					output:
						"编排模式下不能指定 model：执行者模型由方案在该档位的模型池决定，" +
						"请只给出 tier 与 prompt。",
					isError: true,
				};
			}
			// 自审只对可写档位成立，而这一条**在派发之前**就必须挡住：只读 worker 没有
			// 改动可回看，放它进去只会白发一次完整模型调用——那正是这个参数要消除的浪费。
			//
			// 选择"报错"而不是"忽略并照常派发"：忽略意味着编制者以为要到了自审，
			// 而唯一的信号藏在返回文本的一段说明里，下一条报文的规划就会建立在错误前提上；
			// 报错则立刻显形，代价只有编制者一个来回，而且默认值是 false，只有主动写错才会撞上。
			if (raw.self_review === true && !supportsSelfReview(tier)) {
				return {
					output:
						`档位 "${tier}" 是只读的，不支持自审（self_review）：只读执行者没有改动可以回看，` +
						"自审那一轮只会重复它刚跑过的命令。" +
						"如果你要独立核对这次探查的结论，请另派一次 quick —— 那才是第二双眼睛，而不是自审。",
					isError: true,
				};
			}
			// chore 档的指令必须能机械执行。这里只做**长度下限**这一条轻量校验：它挡住的是
			// "看看测试"这类几乎什么都没写的派发，拦下来比派一只只会猜的便宜模型要划算。
			// 阈值刻意保守（见 `CHORE_INSTRUCTION_MIN_CHARS`），且**通过它不等于指令就精确**——
			// 精确与否由执行者自己判断，它已被授权在指令不可执行时停下回报。所以这是提示
			// 而不是硬闸门：真正的把关在那边，不在这里。
			if (tier === "chore" && isChoreInstructionTooVague(raw.prompt)) {
				return {
					output:
						`派给 chore 档的指令太短，几乎不可能包含一条可执行的命令（少于 ${CHORE_INSTRUCTION_MIN_CHARS} 个字符）。` +
						"请补上精确的命令（原样、带参数）、精确的路径与要回报的内容后重新派发；" +
						"如果你需要先了解代码，请改用 quick 档探查。",
					isError: true,
				};
			}
			// 档位是 launch 态参数，和 stop/archive/unarchive 一样互斥。
			if (lifecycleModes.length > 0) {
				return {
					output: "编排模式下 stop / archive / unarchive 与档位派发互斥：请只提供其中之一。",
					isError: true,
				};
			}
		} else if (tier) {
			// 没有编排模式却给了 tier：不静默忽略——那正是"以为在分层调度、实际没有"的样子。
			return {
				output:
					"当前会话不在编排模式下，tier 参数不可用：请直接指定 subagent_type（与可选的 model）。",
				isError: true,
			};
		} else if (raw.self_review === true) {
			// 没有编排模式却要求自审：不静默忽略——那正是"以为要到了复核、其实没有"的样子。
			// 只在 `true` 时报错：`false` 的语义是"不要自审"，而这个会话本来就不会自审，
			// 为它报错只会把一次完全正确的调用判成失败。
			return {
				output:
					"当前会话不在编排模式下，self_review 参数不可用：自审是编排派发的校验开关，" +
					"只有编制者按档位派发时才存在。",
				isError: true,
			};
		}

		// --- Archive mode: retire a subagent so broadcasts stop waking it ---
		if (raw.archive) {
			try {
				const targetId = await resolveArchiveTargetId(ctx.narratorId, raw.archive);
				const { narratorService } = await import("@server/services/narrator-service");
				const { isSubagentVariant } = await import("@server/lib/narrator-utils");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");

				const narrator = await narratorService.getById(targetId).catch(() => null);
				if (!narrator) {
					return {
						output: `Agent archive error: no subagent found for "${raw.archive}".`,
						isError: true,
					};
				}
				if (!isSubagentVariant(narrator.variant)) {
					return {
						output: `Agent archive error: "${raw.archive}" is not a subagent.`,
						isError: true,
					};
				}
				if (narrator.parentNarratorId !== ctx.narratorId) {
					return {
						output: `Agent archive error: "${raw.archive}" is not a direct child subagent of this narrator.`,
						isError: true,
					};
				}
				const label = agentLabelFromNarrator(narrator, ctx.narratorId);
				if (narrator.status === "archived") {
					return {
						output: `Agent ${label} (${narrator.id}) is already archived. It remains excluded from TeamStatus broadcast (@all members) until unarchived.`,
					};
				}

				const { interruptAndArchiveSubagent } = await import("@server/services/subagent-lifecycle");
				const archived = await interruptAndArchiveSubagent(narrator.id, {
					parentNarratorId: ctx.narratorId,
				});
				if (!archived.ok) {
					return {
						output: `Agent archive error: failed to archive "${raw.archive}" (${archived.error ?? "unknown"}).`,
						isError: true,
					};
				}

				return {
					output:
						`Agent ${label} (${narrator.id}) has been archived.\n` +
						"It will not receive TeamStatus broadcast (@all members) messages or wake-ups. " +
						"Direct Send to an archived subagent is also rejected. " +
						"Use unarchive to restore it, or a user page interaction (which auto-unarchives).",
				};
			} catch (err) {
				return {
					output: `Agent archive error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		// --- Unarchive mode: restore an archived subagent ---
		if (raw.unarchive) {
			try {
				const targetId = await resolveArchiveTargetId(ctx.narratorId, raw.unarchive);
				const { narratorService } = await import("@server/services/narrator-service");
				const { isSubagentVariant } = await import("@server/lib/narrator-utils");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");

				const narrator = await narratorService.getById(targetId).catch(() => null);
				if (!narrator) {
					return {
						output: `Agent unarchive error: no subagent found for "${raw.unarchive}".`,
						isError: true,
					};
				}
				if (!isSubagentVariant(narrator.variant)) {
					return {
						output: `Agent unarchive error: "${raw.unarchive}" is not a subagent.`,
						isError: true,
					};
				}
				if (narrator.parentNarratorId !== ctx.narratorId) {
					return {
						output: `Agent unarchive error: "${raw.unarchive}" is not a direct child subagent of this narrator.`,
						isError: true,
					};
				}
				const label = agentLabelFromNarrator(narrator, ctx.narratorId);
				if (narrator.status !== "archived") {
					return {
						output: `Agent ${label} (${narrator.id}) is not archived (current status: ${narrator.status}).`,
					};
				}
				await narratorService.updateStatus(narrator.id, "idle");
				return {
					output:
						`Agent ${label} (${narrator.id}) has been unarchived. ` +
						"It can receive messages and TeamStatus broadcast (@all members) again.",
				};
			} catch (err) {
				return {
					output: `Agent unarchive error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		// --- Stop mode: cancel a running background agent task ---
		if (raw.stop) {
			try {
				const { resolveTaskAlias, cancelBackgroundTask } = await import(
					"@server/services/narrator-subagent"
				);
				let taskId = resolveTaskAlias(ctx.narratorId, raw.stop);

				// If alias registry didn't resolve (returned raw input), try DB lookup
				if (taskId === raw.stop) {
					const { backgroundTaskService } = await import(
						"@server/services/background-task-service"
					);
					const task = await backgroundTaskService.getByAlias(raw.stop, ctx.narratorId);
					if (task) taskId = task.id;
				}

				const cancelled = await cancelBackgroundTask(taskId);
				if (cancelled) {
					return { output: `Background agent task ${raw.stop} has been cancelled.` };
				}
				return {
					output: `Background agent task ${raw.stop} is not running (may have already completed or does not exist).`,
					isError: true,
				};
			} catch (err) {
				return {
					output: `Agent stop error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		const { prompt, description, subagent_type, model, reasoning_effort, workdir, alias } = raw;
		// Normalize timeout leniently: floats/strings/negatives → sane non-negative int
		// (0 = no wall-clock limit).
		const timeout = normalizeNumber(raw.timeout, { min: 0, max: Number.MAX_SAFE_INTEGER });
		// Prefer new name, fall back to legacy name for in-flight conversations
		const run_in_background = raw.run_in_background ?? raw.background;

		// Resolve effective cwd: use workdir if provided, otherwise parent's cwd
		const resolvedWorkdir = workdir ? resolvePath(ctx.cwd, workdir) : ctx.cwd;

		// 编排模式：档位决定执行者模型、工具等级与提示词，编制者不指定它们。
		// 放在最前面的原因：选不出模型属于"这次派发不成立"，应在触碰 toolUseId /
		// 租约 / 数据库之前就报出来，而不是先建半个子代理再失败。
		let orchestrationDispatch: OrchestrationDispatchPlan | undefined;
		if (orchestrationProfileId && isOrchestrationTierValue(tier)) {
			// 取整条池条目而不是模型名：条目上的思考强度必须与模型一起流到执行者，
			// 否则它会在选模这一步被丢掉，配置看起来生效、实际从不生效。
			const selectedEntry = selectPoolEntryForTier(orchestrationProfileId, tier);
			if (!selectedEntry) {
				return {
					output:
						`编排档位 "${tier}" 没有可用的执行者模型（模型池为空、并发已满或方案未启用）。` +
						"请换一个档位，或调整该档位的模型池后再派发。",
					isError: true,
				};
			}
			const selectedModel = selectedEntry.model;
			const orchestratedType = buildOrchestrationType(orchestrationProfileId, tier);
			// 定义从类型编码反解，与续跑路径共用同一个来源：两处各写一份"档位定义"
			// 迟早会漂移，而漂移的表现是"首次派发能写、续跑后只读"。
			const customDefinition = buildOrchestrationWorkerDefinition(
				orchestratedType,
				ctx.locale as Locale,
			);
			if (!customDefinition) {
				return {
					output: `编排派发失败：无法为档位 "${tier}" 构造执行者定义`,
					isError: true,
				};
			}
			orchestrationDispatch = {
				model: selectedModel,
				// 只在配置里确实写了强度时才带上这个键（见 OrchestrationDispatchPlan 的说明）。
				...(selectedEntry.reasoningEffort && {
					reasoningEffort: selectedEntry.reasoningEffort,
				}),
				subagentType: orchestratedType,
				customDefinition,
				profileId: orchestrationProfileId,
				tier,
				// 只有显式 `true` 才算要求。缺省、`false`、非布尔值一律视为不要自审——
				// 这是"消除探查阶段浪费"的全部实现：默认路径上不再发生任何自审调用。
				selfReview: raw.self_review === true,
			};
		}

		const toolUseId = ctx.currentToolUseId;
		if (!toolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}
		const toolCallBinding = ctx.toolCallBinding;
		if (!toolCallBinding) {
			return { output: "Internal error: missing persisted Agent tool-call binding", isError: true };
		}
		const updateExecutionLease = ctx.updateExecutionLease;
		if (!updateExecutionLease) {
			return { output: "Internal error: missing Agent update execution lease", isError: true };
		}

		// Lazy import to avoid circular dependency at module load time
		const { runSubagent } = await import("@server/services/narrator-subagent");

		if (!prompt) {
			return {
				output: "Missing required parameter: prompt (the task for the agent to perform)",
				isError: true,
			};
		}

		// 跨档位共享事实的**读**这一侧：把本会话累积下来的、刚刚重新核对过的结论交给执行者。
		//
		// 它替代的是"编制者读回执、再抄进下一次 prompt"——编制者自己读不了代码，它转述的
		// 是二手结论，而这里交出去的每条都锚定在文件内容上、且刚被重新校验过。
		//
		// 只给执行者，**不给独立复核者**：复核的全部价值在于它没看过别人的结论。把已有
		// 结论喂进去，它就会顺着同一套前提走，复核对同一种偏差当场失效。
		//
		// 取不到就退回原始 prompt（共享是增益，不是派发的前置条件）。
		const sharedFacts = orchestrationDispatch
			? await loadSharedFactsBlock(ctx.narratorId, resolvedWorkdir, ctx.locale as Locale)
			: "";
		const dispatchPrompt = sharedFacts ? `${sharedFacts}\n\n---\n\n${prompt}` : prompt;

		// 本次派发的审计句柄。声明在 `finishDispatch` 之前：收尾闭包会在调用时读它，
		// 而赋值发生在 try 块里（必须在 `acquireModelSlot` 之后，见那里的说明）。
		let orchestrationRun: OrchestrationRunHandle | null = null;
		let orchestrationLive: OrchestrationLiveIdentity | undefined;
		let orchestrationLiveTransferred = false;

		// 编排派发跑完后的统一收尾。两条路径（复用停放 worker / 新建）必须走同一段逻辑：
		// 复用与新建"语义等价"是阶段 4b 的前提，若只有新建做复核，"这次有没有复核"就会
		// 取决于池子里恰好有没有 worker——那既不可预期也不可复现。
		//
		// `reusedWorker` 由调用方声明：它是"这次到底有没有用上停放池"这个事实，
		// 只有复用成功的那条出口知道（退回新建的那条不算复用）。
		const finishDispatch = async (
			plan: OrchestrationDispatchPlan,
			executor: { narratorId: string | null; output: string },
			reusedWorker: boolean,
		) =>
			finishOrchestratedDispatch({
				dispatch: plan,
				// 收尾时才读共享事实（而不是复用派发前那一份）：这次派发的执行者与复核者
				// 刚写进来的结论必须出现在同一个 `tool_result` 里，否则编制者得再派一次
				// 才能看到它——那正是这次要省的开销。
				sharedFacts: await loadSharedFactsBlock(
					ctx.narratorId,
					resolvedWorkdir,
					ctx.locale as Locale,
				),
				executorNarratorId: executor.narratorId,
				executorOutput: executor.output,
				taskBrief: prompt,
				parentNarratorId: ctx.narratorId,
				cwd: resolvedWorkdir,
				locale: ctx.locale,
				signal: ctx.signal,
				userId: ctx.userId ?? null,
				timeoutMs: timeout,
				toolUseId,
				toolCallBinding,
				updateExecutionLease,
				// 审计句柄（可能为 null：登记失败时审计在收尾处变成空操作）。
				run: orchestrationRun,
				reusedWorker,
			});

		// 占位必须紧接选模：中间没有 await，不存在"选了但没记上"的窗口。
		// 注意它在 prompt 校验之后——提前 acquire 而中途 return 会让计数永远留在池子里。
		const releaseModelSlot = orchestrationDispatch
			? acquireModelSlot(orchestrationDispatch.model)
			: undefined;

		try {
			// 审计：派发开始登记一行。**必须放在 `acquireModelSlot` 之后**——选模与占位
			// 之间刻意不留 await（并发判断会失真），而这次插入正是一个 await。
			// 登记失败返回 null，后续收尾自动变成空操作，派发本身不受任何影响。
			if (orchestrationDispatch) {
				orchestrationRun = await startOrchestrationRun({
					coordinatorNarratorId: ctx.narratorId,
					profileId: orchestrationDispatch.profileId,
					tier: orchestrationDispatch.tier,
					model: orchestrationDispatch.model,
				});
				orchestrationLive = orchestrationRun
					? beginOrchestrationLiveRun({
							runId: orchestrationRun.id,
							coordinatorNarratorId: ctx.narratorId,
							tier: orchestrationDispatch.tier,
							parentToolUseId: toolUseId,
						})
					: undefined;
				if (orchestrationLive) {
					broadcastDispatchObservation(orchestrationLive, {
						event: "dispatch",
						profileId: orchestrationDispatch.profileId,
						tier: orchestrationDispatch.tier,
						model: orchestrationDispatch.model,
						background: !!run_in_background,
					});
				}
			}

			// 编排模式下优先复用停放中的 worker：同一个编制者、同一个方案、同一个档位，
			// 就说明"这次的活和它上次干的是同一类"，接着用它的历史与提示词前缀缓存，
			// 比重新建一个只读到系统提示词的 worker 更省也更准。
			//
			// 放在占位之后而不是选模之后：选模与 `acquireModelSlot` 之间刻意不留 await
			// （见下方注释），复用同样要占一个并发位。
			if (
				orchestrationDispatch &&
				canReuseParkedWorkerForDispatch({
					run_in_background,
					background: raw.background,
					workdir,
					alias: raw.alias,
					reasoning_effort,
				})
			) {
				try {
					const { claimReusableWorker } = await import("../../orchestration/parking");
					const parked = await claimReusableWorker({
						parentNarratorId: ctx.narratorId,
						profileId: orchestrationDispatch.profileId,
						tier: orchestrationDispatch.tier,
						// 把本次选中的模型告诉池子：复用省下的是前缀缓存，而缓存按模型分开，
						// 同模型的候选优先（但不会被当成过滤条件，见 `selectReusableWorker`）。
						model: orchestrationDispatch.model,
					});
					if (parked) {
						if (orchestrationLive) {
							orchestrationLive = bindOrchestrationWorker(
								orchestrationLive,
								parked.narratorId,
								"worker",
							);
						}
						const reused = await runReusedOrchestrationWorker({
							orchestration: orchestrationLive,
							parked,
							model: orchestrationDispatch.model,
							reasoningEffort: orchestrationDispatch.reasoningEffort,
							prompt: dispatchPrompt,
							locale: ctx.locale,
							signal: ctx.signal,
							timeoutMs: timeout,
							userId: ctx.userId ?? null,
							toolUseId,
						});
						if (reused !== undefined) {
							// 执行者的这次派发到此结束，先把它占的并发位还回去：复核档位可能配的是
							// 同一个模型，位不还就会被自己的执行者挡住，表现为"复核总是没执行"。
							// `releaseModelSlot` 幂等，finally 里那次是兜底。
							releaseModelSlot?.();
							return {
								output: await finishDispatch(
									orchestrationDispatch,
									{
										narratorId: parked.narratorId,
										output: reused,
									},
									true,
								),
							};
						}
						// 回退新建。worker 的归还（重新归档 + 重新登记）已经在
						// `runReusedOrchestrationWorker` 的失败出口里做掉了——那样它下次才
						// 还在池子里；这一条 warn 只说明"这次没用上它"。
						logger.warn(
							"Parked orchestration worker could not be reused; falling back to a new dispatch",
							{ narratorId: parked.narratorId, profileId: orchestrationDispatch.profileId, tier },
						);
					}
				} catch (err) {
					// 复用只是优化：认领或唤醒的任何意外失败都必须退回新建，
					// 绝不能让一次本来能成功的派发因为"池子坏了"而失败。
					logger.warn("Failed to attempt reusing a parked orchestration worker", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			const result = await runSubagent({
				orchestrationRun,
				parentNarratorId: ctx.narratorId,
				toolUseId,
				toolCallBinding,
				orchestration: orchestrationLive,
				subagentType: orchestrationDispatch?.subagentType ?? (subagent_type || "general"),
				prompt: dispatchPrompt,
				title: description || undefined,
				cwd: resolvedWorkdir,
				signal: ctx.signal,
				updateExecutionLease,
				locale: ctx.locale,
				model: orchestrationDispatch?.model ?? (model || undefined),
				customDefinition: orchestrationDispatch?.customDefinition,
				// 编排档位下强度由池条目决定（编制者不指定它，schema 里也给不了）；
				// 非编排派发照旧用工具参数。`runSubagent` 那边还有一条更高的优先级
				// （子代理类型池的固定强度），这里无需也不该去和它抢。
				reasoningEffort: orchestrationDispatch?.reasoningEffort ?? reasoning_effort,
				background: run_in_background || false,
				takeoverByUser: raw.takeover_by_user === true,
				timeoutMs: timeout,
				alias: alias || description || undefined,
				// The subagent acts on behalf of whoever triggered this parent turn:
				// knowledge ACL and fast-mode "inherit" both resolve against them.
				userId: ctx.userId ?? null,
			});

			// The runner already writes the alias into the `<subagent_id>` /
			// `<background_task_id>` tag and registers it, so no string surgery is
			// needed here. Conflicts are reported by the runner too.
			if (orchestrationDispatch) {
				// 后台派发到此为止：执行者此刻还在跑，自审会撞上"仍在运行"，
				// 复核也只能在半个改动上给结论。后台结果由它自己的完成通知路径交付。
				//
				// 审计行也**故意留在这里**：`phase` 停在 `dispatched`、`finished_at` 为空
				// ——那是"这次还没收尾"，而不是"它很快就结束了"。后台执行者的完成时间
				// 不在本函数里，硬写一个此刻的时间戳只会把派发耗时冒充成执行耗时。
				if (run_in_background) {
					orchestrationLiveTransferred = true;
					return { output: result };
				}
				const executorNarratorId = await resolveExecutorNarratorId({
					parentNarratorId: ctx.narratorId,
					originToolCallId: toolCallBinding.toolCallId,
				});
				releaseModelSlot?.();
				return {
					output: await finishDispatch(
						orchestrationDispatch,
						{
							narratorId: executorNarratorId,
							output: result,
						},
						false,
					),
				};
			}
			return { output: result };
		} catch (err) {
			// 记一次失败的收尾（原因会被审计模块截断）。句柄为 null 时它是空操作，
			// 因此这里不需要判断"有没有登记过"——失败路径不该再多一个分支。
			await recordOrchestrationRunFailure(
				orchestrationRun,
				err instanceof Error ? err.message : String(err),
			);
			return {
				output: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		} finally {
			// 在飞计数必须在所有出口释放：漏一次，该模型就永久占用一个并发位，
			// 池子会随着失败次数增长而逐渐"满"到无法派发。
			releaseModelSlot?.();
			if (!orchestrationLiveTransferred && orchestrationLive) {
				releaseOrchestrationLiveRun(orchestrationLive.runId);
			}
		}
	},
};
