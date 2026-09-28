/**
 * 编排派发的审计记录（`orchestration_runs` 的读写出口）。
 *
 * 编排模式此前完全不留痕：`api_requests` 有逐请求的 token / model / cost，却没有
 * "这是第几次派发、哪个档位"这一维，于是"第三次派发比第一次快了多少、省了多少"
 * 与"编排本身花了多少"这两句话都无从算起——而它们正是判断编排模式到底省不省钱的
 * 唯一依据。本模块把那一维补上：每次派发一行，`coordinatorNarratorId` /
 * `workerNarratorId` 就是对账的 join 键。
 *
 * **写入点只有三个**，都在派发路径上：
 *   1. {@link startOrchestrationRun} —— 派发开始，插入一行（`phase = "dispatched"`）；
 *   2. {@link finishOrchestrationRun} —— 收尾，更新同一行（终态阶段 / verdict / 耗时）；
 *   3. {@link recordOrchestrationRunFailure} —— 派发整体失败，更新为 `failed` + 原因。
 *
 * **三条不可动摇的规矩**：
 * - **审计绝不影响派发**。所有写入都自带 try/catch，失败只 `logger.warn` 并返回
 *   `null`；调用方拿到的 `null` 句柄让后续更新变成空操作。审计是旁路，不是流程的一部分。
 * - **不存无上限的文本**。`error` 写入前按 {@link MAX_ORCHESTRATION_ERROR_CHARS} 截断，
 *   `verdict` 只存枚举值——回执正文已经在叙述者消息里，重复存一份只会让这张表跟着
 *   对话一起长，而它在派发热路径上。
 * - **读取有界**。聚合只统计该编制者最近 {@link AGGREGATE_SCAN_LIMIT} 次派发
 *   （子查询先按主索引取窗口，再 GROUP BY），`recent` 的条数由调用方给且封顶
 *   {@link ORCHESTRATION_RUN_MAX_LIMIT}。不做全表扫描、不做无上限 `.all()`。
 */

import { db } from "@server/db";
import { orchestrationRuns } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import type {
	OrchestrationRunAudit,
	OrchestrationRunPhase,
	OrchestrationRunSummary,
	OrchestrationRunTierStats,
	OrchestrationRunVerdict,
} from "@shared/orchestration-status";
import type { OrchestrationWorkerTier } from "@shared/orchestration-worker-type";
import { count, desc, eq, sql } from "drizzle-orm";
import type { OrchestrationTier } from "./types";

/**
 * 结局阶段的权威取值（数据库 enum、线上契约、写入方三处共用这一份）。
 *
 * 与实现对齐说明：派发分支的真实流程是「执行者 → 自审（续跑同一个 worker）→
 * 独立复核（另一只只读 worker）」，因此终态是"走到哪一步"而不是我的猜测：
 * - `dispatched`：派发结束但没跑过任何复核（两个开关都关着）；
 * - `self_reviewed`：自审轮真的跑了；
 * - `reviewed`：独立复核者真的跑了；
 * - `failed`：这次派发整体失败。
 * "复核没跑成"（`selfReview = failed` / `independentReview = failed`）不是阶段，
 * 它是一个**缺席**——阶段因此退回它能证明的最后一步，而不是编一个没发生的结局。
 */
export const ORCHESTRATION_RUN_PHASES = [
	"dispatched",
	"self_reviewed",
	"reviewed",
	"failed",
] as const satisfies readonly OrchestrationRunPhase[];

/** verdict 的权威取值，与 `receipt.ts` 的回执解析同源。 */
export const ORCHESTRATION_RUN_VERDICTS = [
	"pass",
	"fail",
	"partial",
] as const satisfies readonly OrchestrationRunVerdict[];

/**
 * `error` 列的字符上限。
 *
 * 2000 是"足够装下一次上游报错与它的调用栈，又不至于让一行变成大字段"的位置：
 * 这张表在派发热路径上写入，而列表接口会读 `error`。
 */
export const MAX_ORCHESTRATION_ERROR_CHARS = 2000;

/** 最近派发列表的默认条数。 */
export const ORCHESTRATION_RUN_DEFAULT_LIMIT = 20;

/** 最近派发列表的条数上限（超过按上限截断，而不是报错）。 */
export const ORCHESTRATION_RUN_MAX_LIMIT = 100;

/**
 * 聚合的读取预算：只统计该编制者最近的这么多次派发。
 *
 * 这是**读取预算**而不是数量上限——超出的部分不扩大读取，只是聚合只反映最近的账。
 * 宁可让"总耗时"少算一些旧账，也不在主线程上按会话长度无上限地扫描。
 */
const AGGREGATE_SCAN_LIMIT = 500;

/** 一次已登记派发的句柄：`startedAt` 留在内存里，收尾时用来算耗时（不必回读行）。 */
export interface OrchestrationRunHandle {
	id: string;
	/** ISO 时间戳，与库里那一行写的是同一个值。 */
	startedAt: string;
}

/** 一次派发开始时要记下的东西（其余字段由 `startOrchestrationRun` 自己填）。 */
export interface OrchestrationRunStart {
	coordinatorNarratorId: string;
	profileId: string;
	tier: OrchestrationTier;
	/** 本次档位选中的模型；挑选阶段就失败时为 `null`。 */
	model: string | null;
}

/** 收尾时要更新到同一行的字段。 */
export interface OrchestrationRunFinish {
	phase: OrchestrationRunPhase;
	workerNarratorId?: string | null;
	reusedWorker?: boolean;
	verdict?: OrchestrationRunVerdict | null;
	error?: string | null;
}

export interface OrchestrationRunProgress {
	currentPhase:
		| "dispatching"
		| "executing"
		| "self_reviewing"
		| "reviewing"
		| "completed"
		| "failed";
	lastProgressSeq: number;
	lastProgressAt?: string;
}

const ORCHESTRATION_PROGRESS_ORDER: Record<OrchestrationRunProgress["currentPhase"], number> = {
	dispatching: 0,
	executing: 1,
	self_reviewing: 2,
	reviewing: 3,
	completed: 4,
	failed: 4,
};

/** 四档骨架：每档一份独立的值（共用同一个对象会让四档串在一起）。 */
function emptyTierStatsRecord(): Record<OrchestrationWorkerTier, OrchestrationRunTierStats> {
	const create = (): OrchestrationRunTierStats => ({
		runs: 0,
		finished: 0,
		totalDurationMs: 0,
		avgDurationMs: null,
		reused: 0,
		failed: 0,
	});
	return { chore: create(), quick: create(), medium: create(), heavy: create() };
}

/**
 * 空审计（无记录，或读取失败）。
 *
 * 读取失败时也用这一份而不是抛出去：这是观测接口，读不到历史应当"少显示一块"，
 * 与 `status.ts` 里在场计数的处理一致——让整个状态查询因为一张审计表报错，
 * 会把"池子里有几个 worker"这种能回答的问题一起弄没。
 */
export function emptyOrchestrationRunAudit(): OrchestrationRunAudit {
	return { aggregate: emptyTierStatsRecord(), recent: [] };
}

/**
 * 截断失败原因。
 *
 * 末尾换一个省略号而不是硬切：读的人要能一眼看出这段是被截断的，而不是原本就到此为止。
 * 返回值长度**不超过**上限（截断时是恰好等于上限：内容取上限减一，再加一个省略号）。
 */
export function truncateOrchestrationError(text: string): string {
	if (text.length <= MAX_ORCHESTRATION_ERROR_CHARS) return text;
	return `${text.slice(0, MAX_ORCHESTRATION_ERROR_CHARS - 1)}…`;
}

/** 毫秒差；任一端不是合法时间戳时返回 `null`（而不是 0）。 */
function durationBetween(startedAt: string, finishedAt: string): number | null {
	const start = Date.parse(startedAt);
	const end = Date.parse(finishedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	// 时钟回拨时给 0 而不是负数：负耗时会让所有平均值与图表都失去意义。
	return Math.max(0, end - start);
}

/** 把列表条数收进 [1, 上限]；非法值（NaN / 负数 / 0）退回默认值。 */
function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return ORCHESTRATION_RUN_DEFAULT_LIMIT;
	const truncated = Math.trunc(limit);
	if (truncated <= 0) return ORCHESTRATION_RUN_DEFAULT_LIMIT;
	return Math.min(truncated, ORCHESTRATION_RUN_MAX_LIMIT);
}

/**
 * 登记一次派发开始，返回可用来收尾的句柄；写入失败返回 `null`。
 *
 * 调用方把返回值原样传给收尾函数即可——`null` 会让收尾变成空操作，
 * 因此"审计坏了"这件事不会以任何形式改变派发本身的成败。
 */
export async function startOrchestrationRun(
	input: OrchestrationRunStart,
): Promise<OrchestrationRunHandle | null> {
	const id = generateId();
	const startedAt = new Date().toISOString();
	try {
		await db.insert(orchestrationRuns).values({
			id,
			coordinatorNarratorId: input.coordinatorNarratorId,
			profileId: input.profileId,
			tier: input.tier,
			workerNarratorId: null,
			model: input.model,
			phase: "dispatched",
			currentPhase: "dispatching",
			lastProgressSeq: 0,
			lastProgressAt: startedAt,
			// 当前实现不做自动重派（是否重派由编制者决定），因此恒为 0。
			attempt: 0,
			reusedWorker: false,
			verdict: null,
			error: null,
			startedAt,
			finishedAt: null,
			durationMs: null,
		});
		return { id, startedAt };
	} catch (err) {
		logger.warn("Failed to record the start of an orchestration run; dispatch continues", {
			coordinatorNarratorId: input.coordinatorNarratorId,
			profileId: input.profileId,
			tier: input.tier,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * 收尾：把终态阶段 / verdict / 执行者 / 耗时写回同一行。
 *
 * `handle` 为 `null`（开始那次写失败）时直接返回，不修不补：宁可少一条审计，
 * 也不要在派发路径上为了"补记录"再抛一次错。
 */
export async function recordOrchestrationRunProgress(
	runId: string | null | undefined,
	progress: OrchestrationRunProgress,
): Promise<void> {
	if (!runId || !Number.isSafeInteger(progress.lastProgressSeq) || progress.lastProgressSeq < 0)
		return;
	const lastProgressAt = progress.lastProgressAt ?? new Date().toISOString();
	try {
		const current = await db
			.select({
				currentPhase: orchestrationRuns.currentPhase,
				lastProgressSeq: orchestrationRuns.lastProgressSeq,
				finishedAt: orchestrationRuns.finishedAt,
			})
			.from(orchestrationRuns)
			.where(eq(orchestrationRuns.id, runId))
			.limit(1);
		const row = current[0];
		if (!row) return;
		const currentPhase =
			typeof row.currentPhase === "string" && row.currentPhase in ORCHESTRATION_PROGRESS_ORDER
				? (row.currentPhase as OrchestrationRunProgress["currentPhase"])
				: "dispatching";
		const currentSeq = typeof row.lastProgressSeq === "number" ? row.lastProgressSeq : -1;
		if (
			row.finishedAt ||
			progress.lastProgressSeq <= currentSeq ||
			currentPhase === "completed" ||
			currentPhase === "failed" ||
			ORCHESTRATION_PROGRESS_ORDER[progress.currentPhase] <
				ORCHESTRATION_PROGRESS_ORDER[currentPhase]
		) {
			return;
		}
		await db
			.update(orchestrationRuns)
			.set({
				currentPhase: progress.currentPhase,
				lastProgressSeq: progress.lastProgressSeq,
				lastProgressAt,
			})
			.where(eq(orchestrationRuns.id, runId));
	} catch (err) {
		logger.warn("Failed to record orchestration run progress", {
			runId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export async function finishOrchestrationRun(
	handle: OrchestrationRunHandle | null,
	finish: OrchestrationRunFinish,
): Promise<void> {
	if (!handle) return;
	const finishedAt = new Date().toISOString();
	try {
		await db
			.update(orchestrationRuns)
			.set({
				phase: finish.phase,
				currentPhase: finish.phase === "failed" ? "failed" : "completed",
				lastProgressSeq: sql`coalesce(${orchestrationRuns.lastProgressSeq}, 0) + 1`,
				lastProgressAt: finishedAt,
				workerNarratorId: finish.workerNarratorId ?? null,
				reusedWorker: finish.reusedWorker ?? false,
				verdict: finish.verdict ?? null,
				error: finish.error ? truncateOrchestrationError(finish.error) : null,
				finishedAt,
				durationMs: durationBetween(handle.startedAt, finishedAt),
			})
			.where(eq(orchestrationRuns.id, handle.id));
	} catch (err) {
		logger.warn("Failed to finish an orchestration run record; dispatch result is unaffected", {
			runId: handle.id,
			phase: finish.phase,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * 派发整体失败的收尾：阶段为 `failed`，原因截断后写入 `error`。
 *
 * 与 {@link finishOrchestrationRun} 分开只为让失败路径读起来是一件事——
 * 失败是审计里最需要解释的那一行，调用点不该埋在一长串字段里。
 */
export async function recordOrchestrationRunFailure(
	handle: OrchestrationRunHandle | null,
	error: string,
): Promise<void> {
	await finishOrchestrationRun(handle, { phase: "failed", error });
}

/** 读一个会话的派发审计（分档聚合 + 最近若干条摘要）；失败时返回空审计。 */
export async function readOrchestrationRunAudit(input: {
	coordinatorNarratorId: string;
	limit?: number;
}): Promise<OrchestrationRunAudit> {
	const limit = clampLimit(input.limit);
	try {
		// 聚合窗口：先按 (coordinator_narrator_id, started_at) 索引取有界的一批，再分组。
		// 顺序在外层不保留也无所谓——聚合只看用了多少、多久，不看先后。
		const window = db
			.select({
				tier: orchestrationRuns.tier,
				phase: orchestrationRuns.phase,
				currentPhase: orchestrationRuns.currentPhase,
				lastProgressSeq: orchestrationRuns.lastProgressSeq,
				lastProgressAt: orchestrationRuns.lastProgressAt,
				durationMs: orchestrationRuns.durationMs,
				reusedWorker: orchestrationRuns.reusedWorker,
			})
			.from(orchestrationRuns)
			.where(eq(orchestrationRuns.coordinatorNarratorId, input.coordinatorNarratorId))
			.orderBy(desc(orchestrationRuns.startedAt), desc(orchestrationRuns.id))
			.limit(AGGREGATE_SCAN_LIMIT)
			.as("orchestration_run_window");

		const [stats, recent] = await Promise.all([
			db
				.select({
					tier: window.tier,
					runs: count(),
					// count(列) 只数非空值，正好是"已收尾的次数"。
					finished: sql<number>`count(${window.durationMs})`,
					totalDurationMs: sql<number>`coalesce(sum(${window.durationMs}), 0)`,
					reused: sql<number>`coalesce(sum(case when ${window.reusedWorker} = 1 then 1 else 0 end), 0)`,
					failed: sql<number>`coalesce(sum(case when ${window.phase} = 'failed' then 1 else 0 end), 0)`,
				})
				.from(window)
				.groupBy(window.tier),
			db
				.select({
					id: orchestrationRuns.id,
					tier: orchestrationRuns.tier,
					phase: orchestrationRuns.phase,
					currentPhase: orchestrationRuns.currentPhase,
					lastProgressSeq: orchestrationRuns.lastProgressSeq,
					lastProgressAt: orchestrationRuns.lastProgressAt,
					model: orchestrationRuns.model,
					workerNarratorId: orchestrationRuns.workerNarratorId,
					reusedWorker: orchestrationRuns.reusedWorker,
					verdict: orchestrationRuns.verdict,
					error: orchestrationRuns.error,
					startedAt: orchestrationRuns.startedAt,
					finishedAt: orchestrationRuns.finishedAt,
					durationMs: orchestrationRuns.durationMs,
				})
				.from(orchestrationRuns)
				.where(eq(orchestrationRuns.coordinatorNarratorId, input.coordinatorNarratorId))
				.orderBy(desc(orchestrationRuns.startedAt), desc(orchestrationRuns.id))
				.limit(limit),
		]);

		const aggregate = emptyTierStatsRecord();
		for (const row of stats) {
			const finished = Number(row.finished ?? 0);
			const totalDurationMs = Number(row.totalDurationMs ?? 0);
			aggregate[row.tier] = {
				runs: Number(row.runs ?? 0),
				finished,
				totalDurationMs,
				// 平均值在 JS 里算：SQLite 的 AVG 回字符串，而这里只要一个整数毫秒。
				avgDurationMs: finished > 0 ? Math.round(totalDurationMs / finished) : null,
				reused: Number(row.reused ?? 0),
				failed: Number(row.failed ?? 0),
			};
		}

		const summaries: OrchestrationRunSummary[] = recent.map((row) => ({
			id: row.id,
			tier: row.tier,
			phase: row.phase,
			model: row.model,
			workerNarratorId: row.workerNarratorId,
			reusedWorker: row.reusedWorker,
			verdict: row.verdict,
			error: row.error,
			startedAt: row.startedAt,
			finishedAt: row.finishedAt,
			durationMs: row.durationMs,
			progress: {
				currentPhase:
					row.currentPhase === "dispatching" ||
					row.currentPhase === "executing" ||
					row.currentPhase === "self_reviewing" ||
					row.currentPhase === "reviewing" ||
					row.currentPhase === "completed" ||
					row.currentPhase === "failed"
						? row.currentPhase
						: "unknown",
				lastProgressSeq: typeof row.lastProgressSeq === "number" ? row.lastProgressSeq : null,
				lastProgressAt: row.lastProgressAt ?? null,
			},
		}));

		return { aggregate, recent: summaries };
	} catch (err) {
		logger.warn("Failed to read orchestration run audit; returning an empty history", {
			coordinatorNarratorId: input.coordinatorNarratorId,
			error: err instanceof Error ? err.message : String(err),
		});
		return emptyOrchestrationRunAudit();
	}
}
