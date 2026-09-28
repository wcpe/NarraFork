/**
 * 编排的执行后校验：自审（同一 worker 续跑）与独立复核（另一只只读 worker）。
 *
 * 顺序与归属都在这里定死，调用方（`lib/agent/tools/task.ts` 的编排派发分支）只负责
 * 把它们串起来并组装返回文本：
 *
 *   执行者（runSubagent） → 自审（resume 同一个 worker） → 独立复核（新建只读 worker）
 *
 * 两个函数都**不抛异常**：校验是派发的附加价值，不是派发的一部分。任何一步失败都只是
 * "这次没校验成"，调用方会把它如实写进返回文本（"复核没能跑起来"），而不是把一次已经
 * 干完活的派发判成失败——那等于因为复核失败而丢掉执行者的全部成果。
 *
 * 提示词集中在 `tier-prompts.ts`；这里只管"谁来跑、用什么模型、怎么算账"。
 */

import type { ToolCallBinding, ToolUpdateExecutionLease } from "@server/lib/agent/types";
import { logger } from "@server/lib/logger";
import { READ_TOOLS } from "@server/services/agent-runtime/policy";
import type { Locale } from "@shared/i18n-locales";
import { and, desc, eq } from "drizzle-orm";
import { type ReceiptParseResult, renderReceiptForParent } from "./receipt";
import { acquireModelSlot, selectModelForTier } from "./runtime";
import {
	buildIndependentReviewBrief,
	buildIndependentReviewerPrompt,
	buildSelfReviewPrompt,
} from "./tier-prompts";
import { buildReviewerSubagentType, type OrchestrationTier } from "./types";

/**
 * 找出本次 Agent 调用创建出来的执行者。
 *
 * 需要它是因为自审必须知道"续跑谁"，而 `runSubagent` 只回一个字符串（还带着 alias 标签）。
 * 反解那个标签会把正确性押在 alias 注册表上——它是内存态（进程重启后为空）、
 * 别名冲突时还会被改名——所以这里用创建时就写死的关联：
 * `narrators.origin_tool_call_id` 就是本次调用的 tool-call 行 id，且
 * `idx_narrators_origin_tool_call` 上有索引，是一次单行查找。
 *
 * 取不到就返回 null：调用方会跳过自审（并如实说明），而不是拿一个猜出来的 id 去续跑。
 */
export async function resolveExecutorNarratorId(input: {
	parentNarratorId: string;
	originToolCallId: string;
}): Promise<string | null> {
	try {
		const [{ db }, { narrators }] = await Promise.all([
			import("@server/db"),
			import("@server/db/schema"),
		]);
		const row = await db.query.narrators.findFirst({
			where: and(
				eq(narrators.parentNarratorId, input.parentNarratorId),
				eq(narrators.originToolCallId, input.originToolCallId),
			),
			columns: { id: true },
			orderBy: [desc(narrators.createdAt)],
		});
		return row?.id ?? null;
	} catch (err) {
		logger.warn("Failed to resolve the executor created by this Agent call", {
			parentNarratorId: input.parentNarratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * 让刚干完活的执行者回看自己的产物。返回它这一轮的最终文本（失败时返回空串）。
 *
 * **为什么续跑同一个 worker**：自审的价值几乎全部来自"它还记着刚才发生了什么"。
 * 换一个 worker、换一个模型都不难，但那等于让另一个人从零复核，成本更高、结论更差。
 * 当前架构也不支持"同一个子代理切到审查模型"——子代理在运行中换模型会丢掉上下文
 * 连续性，而那是这次续跑唯一的优势。因此这里**不换模型**。
 *
 * **为什么先 ensure idle**：`runSubagent` 返回时，执行者自己的终态收尾
 * （`finalizeSubagent`）已经跑过，且编排 worker 已经被停放归档
 * （`narrators.status = "archived"`）；`resumeSubagent` 明确拒绝 archived。
 * 停放的挂载点在租约归还之后（`subagent-runner.ts` 的 `releaseForegroundLease`），
 * 所以此刻它确实是 archived；反过来，若这次派发没有停放它（例如自审与复核都关着、
 * 或它带有未消费的 mailbox 消息），这一步就只是把 idle 再写一遍。
 * 两种状态都必须能自审，所以这里无条件先回到 idle：
 * 与派发侧复用停放 worker 的第一步（`runReusedOrchestrationWorker`）是同一个动作。
 */
export async function runSelfReview(input: {
	narratorId: string;
	parentNarratorId: string;
	tier: OrchestrationTier;
	locale: Locale;
	/** 父级中断必须能停住自审：它是这次派发的一部分，不是独立的后台任务。 */
	signal?: AbortSignal;
	timeoutMs?: number;
	/** 与执行者同一身份，否则知识库 ACL 与快速模式会退化到匿名。 */
	userId?: string | null;
}): Promise<string> {
	if (input.signal?.aborted) return "";
	try {
		const { narratorService } = await import("@server/services/narrator-service");
		const { resumeSubagent } = await import("@server/services/narrator-subagent");
		await narratorService.updateStatus(input.narratorId, "idle");
		const resumed = await resumeSubagent({
			subagentId: input.narratorId,
			// `follow_up` 是唯一会把新用户消息持久化下来的 intent，也正是"再交给它一件事"。
			intent: "follow_up",
			actor: "parent_agent",
			prompt: buildSelfReviewPrompt(input.tier, input.locale),
			locale: input.locale,
			signal: input.signal,
			timeoutMs: input.timeoutMs,
			createdBy: input.userId ?? null,
			resumableUpdateLease: true,
			// 本次派发的结论归**当前**这次 Agent 调用。不跳过的话，`deliverCompletedResume`
			// 会把自审文本写回执行者那条原始工具结果，父级历史里看到的结论就被换掉了。
			skipConclusionDelivery: true,
		});
		if (!resumed.started) return "";
		return (await resumed.terminalCompletion) ?? "";
	} catch (err) {
		// 自审失败不该掀翻派发：调用方按"未自审"渲染（回执退回执行者自己的输出）。
		logger.warn("Orchestration self-review failed; continuing without it", {
			narratorId: input.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return "";
	}
}

/** 独立复核的结果：`output` 为空表示这次复核没有跑成（原因由 `failure` 说明）。 */
export interface IndependentReviewOutcome {
	output: string;
	/** 复核没能跑起来的原因，供调用方如实渲染。 */
	failure?: "no_model" | "aborted" | "error";
}

/**
 * 派一只只读复核者检查执行者的产物。返回它的最终文本。
 *
 * **不复用执行者、也不会被复用**：
 * - 复核者用 `orch-review--<profileId>--<tier>` 这个类型，它**不是**合法的编排 worker
 *   类型（`parseOrchestrationType` 与停放池的 `like 'orch--%'` 都拒它），
 *   因此既不会被登记进停放池，也不会在下次派发时被当成执行者唤醒。
 * - 复用会把"只读过代码、没有实现上下文"的 worker 送去干活，症状是它看起来像个正常
 *   子代理却什么都不知道，极难排查；所以这条边界是结构性的，不靠约定。
 *
 * **工具集强制只读**：档位取自 `profile.review.reviewTier`（默认 quick），但无论那一档
 * 配得多高，复核者的 `toolAccess` 都是 `readOnly`。它只能读、跑命令、报告，不能改。
 *
 * **不喂执行者的推理过程**：用户消息里只有"原始要求 + 改动文件 + 执行者自己的结论"，
 * 执行者的原始输出与对话一概不给（见 `buildIndependentReviewBrief`）。
 */
export async function runIndependentReview(input: {
	executorNarratorId: string | null;
	parentNarratorId: string;
	profileId: string;
	reviewTier: OrchestrationTier;
	/** 派给执行者的原始要求：复核要对照的"契约"。 */
	taskBrief: string;
	changedFiles: readonly string[];
	executorReceipt: ReceiptParseResult;
	locale: Locale;
	/**
	 * 本次 Agent 调用的 toolUseId：只用于把复核者的消息挂到同一条工具调用下。
	 */
	toolUseId: string;
	/**
	 * 本次 Agent 调用的持久化绑定。
	 *
	 * 接收但**刻意不转发**给 `runSubagent`：执行者那次 `runSubagent` 已经用它建了子代理，
	 * 而 `narrator_tool_calls.resultMessageId` 是按"该子代理自己的 origin"定位同一个槽位的
	 * （见 `narrator-persistence.resolveSubagentConclusionReference`）。复核者若共享这个
	 * origin，它的收尾会把父级那条 Agent 工具结果的 `resultMessageId` 改写成复核者的消息，
	 * 父级看到的结论就变成了复核意见。不传绑定，复核者仍通过 `toolUseId` 归属到这条调用，
	 * 只是不占用它的结论槽位。
	 */
	toolCallBinding: ToolCallBinding;
	/**
	 * 本次 Agent 调用的执行租约。
	 *
	 * 同样接收但**刻意不转发**：`ToolUpdateExecutionLease.transfer()` 是一次性的
	 * （见 `lib/agent/tool-executor.ts` 的 `updateLeaseTransferred` 守卫），执行者那一次
	 * 已经把它转走了；再转一次会直接抛
	 * "Agent could not transfer its update execution lease"，复核连启动都做不到。
	 * 复核者是**另一只**子代理运行，需要自己的租约——不传时 `runSubagent` 会自己申请。
	 */
	updateExecutionLease: ToolUpdateExecutionLease;
	cwd: string;
	signal: AbortSignal;
	userId: string | null;
	timeoutMs?: number;
}): Promise<IndependentReviewOutcome> {
	if (input.signal.aborted) return { output: "", failure: "aborted" };
	const model = selectModelForTier(input.profileId, input.reviewTier);
	if (!model) {
		logger.warn("No model available for the orchestration review tier; skipping review", {
			profileId: input.profileId,
			reviewTier: input.reviewTier,
		});
		return { output: "", failure: "no_model" };
	}
	// 与派发路径同一套记账：选模与占位之间不留 await，否则并发判断会失真。
	const releaseModelSlot = acquireModelSlot(model);
	try {
		const { runSubagent } = await import("@server/services/narrator-subagent");
		const reviewerType = buildReviewerSubagentType(input.profileId, input.reviewTier);
		const output = await runSubagent({
			parentNarratorId: input.parentNarratorId,
			toolUseId: input.toolUseId,
			subagentType: reviewerType,
			prompt: buildIndependentReviewBrief({
				taskBrief: input.taskBrief,
				changedFiles: input.changedFiles,
				executorNarratorId: input.executorNarratorId,
				executorReport: renderReceiptForParent(input.executorReceipt, input.locale),
				locale: input.locale,
			}),
			cwd: input.cwd,
			signal: input.signal,
			locale: input.locale,
			model,
			customDefinition: {
				name: reviewerType,
				description: "Orchestration independent reviewer",
				toolAccess: "readOnly",
				customTools: [...READ_TOOLS],
				// 空串 = 不覆盖调用方显式传入的模型（与自定义子代理的语义一致）。
				defaultModel: "",
				prompt: buildIndependentReviewerPrompt(input.locale),
				location: "",
			},
			background: false,
			title: "orchestration-review",
			userId: input.userId,
			timeoutMs: input.timeoutMs,
		});
		return { output };
	} catch (err) {
		logger.warn("Orchestration independent review failed; continuing without it", {
			profileId: input.profileId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { output: "", failure: "error" };
	} finally {
		releaseModelSlot();
	}
}
