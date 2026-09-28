/**
 * 编排派发审计（`orchestration_runs`）的单元测试。
 *
 * 这张表存在的唯一理由是可对账：把"编排本身花了多少"与"执行花了多少"分开算。
 * 因此断言围绕三件事——**一次派发恰好一行且收尾更新的是同一行**、**写不进去时
 * 绝不换一个结果**（审计是旁路）、**读的规模有界**（聚合有窗口、最近列表有上限）。
 *
 * 写入侧（`startOrchestrationRun` / `finishOrchestrationRun`）走真库真 SQL；
 * 读取侧的聚合与排序断言直接插行来构造数据——只有直接写入才能把 `durationMs`
 * 固定成确定的值，从而让"平均/总和/复用命中"这些数字可以被逐条核对。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { narrators, orchestrationRuns } from "../../../db/schema";

const { db, sqlite } = getTestDb();
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const {
	MAX_ORCHESTRATION_ERROR_CHARS,
	ORCHESTRATION_RUN_DEFAULT_LIMIT,
	ORCHESTRATION_RUN_MAX_LIMIT,
	emptyOrchestrationRunAudit,
	finishOrchestrationRun,
	readOrchestrationRunAudit,
	recordOrchestrationRunFailure,
	recordOrchestrationRunProgress,
	startOrchestrationRun,
	truncateOrchestrationError,
} = await import("../audit");

const COORDINATOR_ID = "orchestration-audit-coordinator";
const PROFILE_ID = "of7k2m9q";
const STAMP = "2026-01-01T00:00:00.000Z";

/** 直接插一行（读取侧测试用的固定数据；写入侧另有走真函数的用例）。 */
async function insertRun(over: {
	id: string;
	tier?: "chore" | "quick" | "medium" | "heavy";
	phase?: "dispatched" | "self_reviewed" | "reviewed" | "failed";
	reusedWorker?: boolean;
	verdict?: "pass" | "fail" | "partial" | null;
	workerNarratorId?: string | null;
	startedAt?: string;
	finishedAt?: string | null;
	durationMs?: number | null;
	coordinatorNarratorId?: string;
}): Promise<void> {
	await db.insert(orchestrationRuns).values({
		id: over.id,
		coordinatorNarratorId: over.coordinatorNarratorId ?? COORDINATOR_ID,
		profileId: PROFILE_ID,
		tier: over.tier ?? "quick",
		workerNarratorId: over.workerNarratorId ?? null,
		model: "provA:worker",
		phase: over.phase ?? "dispatched",
		attempt: 0,
		reusedWorker: over.reusedWorker ?? false,
		verdict: over.verdict ?? null,
		error: null,
		startedAt: over.startedAt ?? STAMP,
		finishedAt: over.finishedAt ?? null,
		durationMs: over.durationMs ?? null,
	});
}

/** 该行的全部列（用于"收尾更新的是同一行、没有多插一行"的断言）。 */
function runRows(id: string) {
	return db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, id));
}

beforeEach(() => {
	cleanDb(sqlite);
});

afterEach(() => {
	cleanDb(sqlite);
});

afterAll(() => {
	mock.restore();
});

describe("写入侧：一次派发恰好一行", () => {
	test("开始登记一行，收尾更新同一行并补上耗时", async () => {
		const handle = await startOrchestrationRun({
			coordinatorNarratorId: COORDINATOR_ID,
			profileId: PROFILE_ID,
			tier: "medium",
			model: "provA:worker",
		});
		expect(handle).not.toBeNull();
		if (!handle) throw new Error("unreachable");

		const started = await runRows(handle.id);
		expect(started).toHaveLength(1);
		expect(started[0].phase).toBe("dispatched");
		expect(started[0].workerNarratorId).toBeNull();
		expect(started[0].finishedAt).toBeNull();
		expect(started[0].durationMs).toBeNull();
		// 未收尾的行不该有判定；`attempt` 目前恒为 0（不做自动重派）。
		expect(started[0].verdict).toBeNull();
		expect(started[0].error).toBeNull();
		expect(started[0].attempt).toBe(0);
		expect(started[0].reusedWorker).toBe(false);
		expect(started[0].startedAt).toBe(handle.startedAt);

		await finishOrchestrationRun(handle, {
			phase: "reviewed",
			workerNarratorId: "worker-1",
			reusedWorker: true,
			verdict: "pass",
		});

		const finished = await runRows(handle.id);
		// 关键：仍是一行（收尾是 UPDATE，不是又一次 INSERT）。
		expect(finished).toHaveLength(1);
		expect(finished[0].phase).toBe("reviewed");
		expect(finished[0].workerNarratorId).toBe("worker-1");
		expect(finished[0].reusedWorker).toBe(true);
		expect(finished[0].verdict).toBe("pass");
		expect(finished[0].finishedAt).not.toBeNull();
		expect(typeof finished[0].durationMs).toBe("number");
		expect(finished[0].durationMs).toBeGreaterThanOrEqual(0);
		// 耗时与两个时间戳自洽。
		expect(finished[0].durationMs).toBe(
			Date.parse(finished[0].finishedAt as string) - Date.parse(finished[0].startedAt),
		);
	});

	test("进度写入单调推进，收尾进入 completed/failed", async () => {
		const handle = await startOrchestrationRun({
			coordinatorNarratorId: COORDINATOR_ID,
			profileId: PROFILE_ID,
			tier: "quick",
			model: "provA:worker",
		});
		if (!handle) throw new Error("unreachable");
		await recordOrchestrationRunProgress(handle.id, {
			currentPhase: "executing",
			lastProgressSeq: 2,
			lastProgressAt: "2026-01-01T00:00:02.000Z",
		});
		await recordOrchestrationRunProgress(handle.id, {
			currentPhase: "dispatching",
			lastProgressSeq: 3,
			lastProgressAt: "2026-01-01T00:00:03.000Z",
		});
		const progressing = await runRows(handle.id);
		expect(progressing[0]).toMatchObject({
			currentPhase: "executing",
			lastProgressSeq: 2,
			lastProgressAt: "2026-01-01T00:00:02.000Z",
		});
		await finishOrchestrationRun(handle, { phase: "dispatched" });
		await recordOrchestrationRunProgress(handle.id, {
			currentPhase: "reviewing",
			lastProgressSeq: 99,
		});
		const finished = await runRows(handle.id);
		expect(finished[0]?.currentPhase).toBe("completed");
		expect(finished[0]?.lastProgressSeq).toBe(3);
	});

	test("失败路径：阶段为 failed 且原因被截断存储", async () => {
		const handle = await startOrchestrationRun({
			coordinatorNarratorId: COORDINATOR_ID,
			profileId: PROFILE_ID,
			tier: "heavy",
			model: "provA:worker",
		});
		const long = "x".repeat(MAX_ORCHESTRATION_ERROR_CHARS * 3);

		await recordOrchestrationRunFailure(handle, long);

		const rows = handle ? await runRows(handle.id) : [];
		expect(rows).toHaveLength(1);
		expect(rows[0].phase).toBe("failed");
		const stored = rows[0].error ?? "";
		expect(stored.length).toBe(MAX_ORCHESTRATION_ERROR_CHARS);
		expect(stored.at(-1)).toBe("…");
		expect(stored.slice(0, 10)).toBe("xxxxxxxxxx");
		expect(rows[0].finishedAt).not.toBeNull();
		expect(typeof rows[0].durationMs).toBe("number");
	});

	test("短原因原样存储，不加省略号", () => {
		expect(truncateOrchestrationError("boom")).toBe("boom");
		expect(truncateOrchestrationError("y".repeat(MAX_ORCHESTRATION_ERROR_CHARS))).toHaveLength(
			MAX_ORCHESTRATION_ERROR_CHARS,
		);
	});

	test("没有登记过（句柄为 null）时收尾是空操作", async () => {
		await finishOrchestrationRun(null, { phase: "reviewed", verdict: "pass" });
		await recordOrchestrationRunFailure(null, "boom");
		const rows = await db.select().from(orchestrationRuns);
		expect(rows).toHaveLength(0);
	});
});

describe("写入失败不影响调用方", () => {
	test("插入抛错时返回 null，而不是把异常抛给派发路径", async () => {
		const insertSpy = spyOn(db, "insert").mockImplementation(() => {
			throw new Error("disk is on fire");
		});
		try {
			const handle = await startOrchestrationRun({
				coordinatorNarratorId: COORDINATOR_ID,
				profileId: PROFILE_ID,
				tier: "quick",
				model: "provA:worker",
			});
			// 审计坏了 → 句柄为 null → 后续收尾也自动变成空操作。
			expect(handle).toBeNull();
			await finishOrchestrationRun(handle, { phase: "reviewed" });
			await recordOrchestrationRunFailure(handle, "boom");
		} finally {
			insertSpy.mockRestore();
		}
		expect(await db.select().from(orchestrationRuns)).toHaveLength(0);
	});
});

describe("读取侧：分档聚合", () => {
	test("按档位归集次数 / 平均耗时 / 复用命中 / 失败数", async () => {
		// chore：2 次，其中 1 次失败；只有 1 次收尾（1000ms）。
		await insertRun({ id: "c1", tier: "chore", phase: "failed", durationMs: 1000 });
		await insertRun({ id: "c2", tier: "chore", phase: "dispatched", durationMs: null });
		// quick：2 次都收尾（2000ms / 4000ms），其中 1 次是复用。
		await insertRun({ id: "q1", tier: "quick", phase: "reviewed", durationMs: 2000 });
		await insertRun({
			id: "q2",
			tier: "quick",
			phase: "self_reviewed",
			durationMs: 4000,
			reusedWorker: true,
		});
		// 其它编制者的行不许进这份聚合。
		await insertRun({
			id: "other",
			tier: "heavy",
			durationMs: 999,
			coordinatorNarratorId: "other",
		});

		const audit = await readOrchestrationRunAudit({ coordinatorNarratorId: COORDINATOR_ID });

		expect(audit.aggregate.chore).toEqual({
			runs: 2,
			finished: 1,
			totalDurationMs: 1000,
			avgDurationMs: 1000,
			reused: 0,
			failed: 1,
		});
		expect(audit.aggregate.quick).toEqual({
			runs: 2,
			finished: 2,
			totalDurationMs: 6000,
			avgDurationMs: 3000,
			reused: 1,
			failed: 0,
		});
		// 没有任何记录的档位给零值，且平均是 null 而不是 0（0 会被读成"平均 0ms"）。
		expect(audit.aggregate.medium).toEqual({
			runs: 0,
			finished: 0,
			totalDurationMs: 0,
			avgDurationMs: null,
			reused: 0,
			failed: 0,
		});
		expect(audit.aggregate.heavy.runs).toBe(0);
	});

	test("聚合只覆盖有界的最近窗口，不是全部历史", async () => {
		// 上限 500：插 505 行，分档聚合只能看到最新的 500 行。
		const base = Date.parse("2026-02-01T00:00:00.000Z");
		for (let i = 0; i < 505; i += 1) {
			await insertRun({
				id: `bulk-${i}`,
				tier: "quick",
				// 时间戳逐行递增，窗口取"最新的那批"才有确定含义。
				startedAt: new Date(base + i * 1000).toISOString(),
				durationMs: 10,
			});
		}
		const audit = await readOrchestrationRunAudit({ coordinatorNarratorId: COORDINATOR_ID });
		expect(audit.aggregate.quick.runs).toBe(500);
		expect(audit.aggregate.quick.totalDurationMs).toBe(5000);
	});
});

describe("读取侧：最近派发列表", () => {
	beforeEach(async () => {
		for (let i = 1; i <= 25; i += 1) {
			await insertRun({
				id: `r-${String(i).padStart(2, "0")}`,
				tier: "quick",
				startedAt: `2026-03-01T00:00:${String(i).padStart(2, "0")}.000Z`,
			});
		}
	});

	test("按时间倒序、条数受 limit 控制", async () => {
		const audit = await readOrchestrationRunAudit({
			coordinatorNarratorId: COORDINATOR_ID,
			limit: 5,
		});
		expect(audit.recent).toHaveLength(5);
		expect(audit.recent.map((row) => row.id)).toEqual(["r-25", "r-24", "r-23", "r-22", "r-21"]);
	});

	test("limit 有上限，且非法值退回默认值", async () => {
		// 再加 105 行（比上限多），才能观察到"条数被封顶"而不是"数据不够"。
		for (let i = 0; i < 105; i += 1) {
			await insertRun({
				id: `cap-${String(i).padStart(3, "0")}`,
				startedAt: new Date(Date.parse("2026-04-01T00:00:00.000Z") + i * 1000).toISOString(),
			});
		}
		const capped = await readOrchestrationRunAudit({
			coordinatorNarratorId: COORDINATOR_ID,
			limit: 10_000,
		});
		expect(capped.recent).toHaveLength(ORCHESTRATION_RUN_MAX_LIMIT);

		const fallback = await readOrchestrationRunAudit({
			coordinatorNarratorId: COORDINATOR_ID,
			limit: Number.NaN,
		});
		expect(fallback.recent).toHaveLength(ORCHESTRATION_RUN_DEFAULT_LIMIT);

		const negative = await readOrchestrationRunAudit({
			coordinatorNarratorId: COORDINATOR_ID,
			limit: -3,
		});
		expect(negative.recent).toHaveLength(ORCHESTRATION_RUN_DEFAULT_LIMIT);
	});

	test("最近列表也按编制者隔离", async () => {
		await insertRun({ id: "other-recent", coordinatorNarratorId: "other" });
		const audit = await readOrchestrationRunAudit({ coordinatorNarratorId: COORDINATOR_ID });
		expect(audit.recent.some((row) => row.id === "other-recent")).toBe(false);
	});

	test("空审计的形状是四档全零 + 空列表（不是 undefined）", () => {
		const audit = emptyOrchestrationRunAudit();
		expect(Object.keys(audit.aggregate).sort()).toEqual(["chore", "heavy", "medium", "quick"]);
		expect(audit.recent).toEqual([]);
		expect(audit.aggregate.heavy.avgDurationMs).toBeNull();
	});
});

describe("审计不随 narrator 删除而消失", () => {
	test("worker 被删除后审计行仍在（没有外键，因此没有级联）", async () => {
		await db.insert(narrators).values({
			id: "worker-to-delete",
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: STAMP,
			updatedAt: STAMP,
		});
		await insertRun({ id: "kept", workerNarratorId: "worker-to-delete", durationMs: 1234 });

		// 结构证据：这张表对外没有任何外键，因此"删 narrator 顺手删审计"在 schema 上不可能。
		const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(orchestration_runs)").all();
		expect(foreignKeys).toEqual([]);

		// 外键约束是开着的：如果这里声明了级联，删除会连带删掉（或阻止删除）审计行。
		await db.delete(narrators).where(eq(narrators.id, "worker-to-delete"));

		const rows = await db
			.select()
			.from(orchestrationRuns)
			.where(and(eq(orchestrationRuns.id, "kept")));
		expect(rows).toHaveLength(1);
		expect(rows[0].workerNarratorId).toBe("worker-to-delete");

		const audit = await readOrchestrationRunAudit({ coordinatorNarratorId: COORDINATOR_ID });
		expect(audit.recent.map((row) => row.id)).toEqual(["kept"]);
	});
});
