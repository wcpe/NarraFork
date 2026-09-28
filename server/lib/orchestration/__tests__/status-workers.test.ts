/**
 * 编排面板的**代理清单**（逐 worker 明细）。
 *
 * 这个接口的价值全在"如实"上，因此断言集中在三条容易被画错的边界：
 * - **未知不等于 0**：没有占用率记录的 worker 必须给出 `null`，而不是 0
 *   （0% 会被读成"上下文还很空"，与真相相反）；
 * - **未知不等于 false**：不在有界派发窗口里的 worker，其"是否复用而来"是 `null`，
 *   不能默认成"新建的"——那会让人在调停放池参数时得到反向结论；
 * - **有界**：清单必须有上限并如实报告被省略的数量，而不是随会话无限增长。
 *
 * 另有一组关于**上下文占用的回溯**（占用率不是每次请求都会写，因此"最后一次请求那一行
 * 没有值"是常态）：取的是有界窗口内最近一个**有值**的行，窗口内没有就仍是 `null`；窗口
 * 本身的边界被逐行钉住，因为它是这条查询的扫描上界，放宽了就等于把主线程交出去。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { apiRequests, narrators, orchestrationRuns } from "../../../db/schema";
import type { OrchestrationProfile, OrchestrationSettings } from "../types";

const { db, sqlite } = getTestDb();
// 与 status.test.ts 同样的替身方式：只取这三个句柄，避免实例化第二份单例。
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-workers";
const OTHER_PARENT_ID = "other-parent-workers";
const STAMP = "2026-01-01T00:00:00.000Z";

const parking = await import("../parking");
const {
	buildOrchestrationWorkers,
	readOrchestrationStatus,
	WORKER_CONTEXT_LOOKBACK_ROWS,
	WORKER_LIST_LIMIT,
} = await import("../status");
const { __resetInFlightForTests } = await import("../runtime");
const { settings } = await import("@server/lib/settings");

function makeProfile(): OrchestrationProfile {
	const tier = () => ({ pool: [{ model: "provA:worker" }] });
	return {
		id: PROFILE_ID,
		name: "测试方案",
		enabled: true,
		review: {
			selfReview: false,
			independentReview: false,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: { chore: tier(), quick: tier(), medium: tier(), heavy: tier() },
	};
}

/** 一个 worker 行；`lastMessageAt` 用来控制清单的排序（最近活动优先）。 */
async function insertWorker(input: {
	id: string;
	tier?: string;
	status?: "idle" | "working" | "waiting" | "archived";
	model?: string | null;
	lastMessageAt?: string | null;
	parentNarratorId?: string;
	subagentType?: string | null;
}): Promise<void> {
	const parentNarratorId = input.parentNarratorId ?? PARENT_ID;
	await db
		.insert(narrators)
		.values({
			id: parentNarratorId,
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.onConflictDoNothing();
	await db.insert(narrators).values({
		id: input.id,
		type: "subagent",
		variant: `subagent:${input.subagentType ?? `orch--${PROFILE_ID}--${input.tier ?? "quick"}`}`,
		subagentType: input.subagentType ?? `orch--${PROFILE_ID}--${input.tier ?? "quick"}`,
		parentNarratorId,
		status: input.status ?? "idle",
		model: input.model === undefined ? "provA:worker" : input.model,
		lastMessageAt: input.lastMessageAt ?? null,
		createdAt: STAMP,
		updatedAt: STAMP,
	});
}

/** 插一条该 worker 的请求记录（`context_percent` 是清单里上下文那一行的来源）。 */
async function insertApiRequest(input: {
	id: string;
	narratorId: string;
	contextPercent: number | null;
	createdAt: string;
}): Promise<void> {
	await db.insert(apiRequests).values({
		id: input.id,
		narratorId: input.narratorId,
		kind: "narrator",
		contextPercent: input.contextPercent,
		createdAt: input.createdAt,
	});
}

/** 插一条派发审计行（`reused` 那一列唯一的来源）。 */
async function insertRun(input: {
	id: string;
	workerNarratorId: string;
	reusedWorker: boolean;
	startedAt: string;
	coordinatorNarratorId?: string;
}): Promise<void> {
	await db.insert(orchestrationRuns).values({
		id: input.id,
		coordinatorNarratorId: input.coordinatorNarratorId ?? PARENT_ID,
		profileId: PROFILE_ID,
		tier: "quick",
		model: "provA:worker",
		workerNarratorId: input.workerNarratorId,
		phase: "dispatched",
		reusedWorker: input.reusedWorker,
		startedAt: input.startedAt,
	});
}

let originalOrchestration: OrchestrationSettings | undefined;

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile()],
	};
	parking.__resetParkingRegistryForTests();
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	__resetInFlightForTests();
	cleanDb(sqlite);
});

afterAll(() => {
	mock.restore();
});

describe("buildOrchestrationWorkers（纯装配）", () => {
	const baseRows = [
		{
			id: "w1",
			subagentType: `orch--${PROFILE_ID}--heavy`,
			model: "provA:worker",
			status: "working",
			lastMessageAt: "2026-01-02T00:00:00.000Z",
		},
	];

	test("执行者与复核者都进入清单，并显式带出角色和档位", () => {
		const workers = buildOrchestrationWorkers({
			rows: [
				...baseRows,
				{
					id: "reviewer-1",
					subagentType: `orch-review--${PROFILE_ID}--quick`,
					model: "provA:reviewer",
					status: "working",
					lastMessageAt: "2026-01-03T00:00:00.000Z",
				},
			],
			reusedByWorker: new Map(),
			contextPercentByWorker: new Map([["reviewer-1", 25]]),
		});
		expect(workers).toEqual([
			expect.objectContaining({ narratorId: "w1", role: "worker", tier: "heavy" }),
			expect.objectContaining({
				narratorId: "reviewer-1",
				role: "reviewer",
				tier: "quick",
				model: "provA:reviewer",
				status: "working",
				contextPercent: 25,
			}),
		]);
	});

	test("解析不出档位的行被跳过，而不是编一个档位", () => {
		const workers = buildOrchestrationWorkers({
			rows: [
				...baseRows,
				{ id: "bad", subagentType: "general", model: "m", status: "idle", lastMessageAt: null },
				{ id: "bad2", subagentType: null, model: "m", status: "idle", lastMessageAt: null },
			],
			reusedByWorker: new Map(),
			contextPercentByWorker: new Map(),
		});
		expect(workers.map((worker) => worker.narratorId)).toEqual(["w1"]);
	});

	test("没有占用率记录时 contextPercent 是 null，不是 0", () => {
		const [worker] = buildOrchestrationWorkers({
			rows: baseRows,
			reusedByWorker: new Map(),
			contextPercentByWorker: new Map(),
		});
		expect(worker.contextPercent).toBeNull();
	});

	test("占用率为 0 时如实给出 0（「真的是 0」与「不知道」必须可区分）", () => {
		const [worker] = buildOrchestrationWorkers({
			rows: baseRows,
			reusedByWorker: new Map(),
			contextPercentByWorker: new Map([["w1", 0]]),
		});
		expect(worker.contextPercent).toBe(0);
	});

	test("不在派发窗口里的 worker，其 reused 是 null（不是 false）", () => {
		const [unknown] = buildOrchestrationWorkers({
			rows: baseRows,
			reusedByWorker: new Map(),
			contextPercentByWorker: new Map(),
		});
		expect(unknown.reused).toBeNull();

		const [known] = buildOrchestrationWorkers({
			rows: baseRows,
			reusedByWorker: new Map([["w1", true]]),
			contextPercentByWorker: new Map(),
		});
		expect(known.reused).toBe(true);
	});

	test("停放状态原样带出，空白 model 读成 null", () => {
		const [worker] = buildOrchestrationWorkers({
			rows: [{ ...baseRows[0], status: "archived", model: "   " }],
			reusedByWorker: new Map(),
			contextPercentByWorker: new Map(),
		});
		// 停放就是 archived，没有第二个字段表达同一件事。
		expect(worker.status).toBe("archived");
		expect(worker.model).toBeNull();
		expect(worker.lastActivityAt).toBe("2026-01-02T00:00:00.000Z");
	});
});

describe("readOrchestrationStatus 的代理清单", () => {
	beforeEach(async () => {
		await db
			.insert(narrators)
			.values({
				id: PARENT_ID,
				type: "primary",
				variant: "primary",
				status: "idle",
				model: `__orch__:${PROFILE_ID}`,
				createdAt: STAMP,
				updatedAt: STAMP,
			})
			.onConflictDoNothing();
	});

	test("列出该编排的 worker（含已停放的），并按最近活动排序", async () => {
		await insertWorker({ id: "w-old", tier: "chore", lastMessageAt: "2026-01-01T00:00:00.000Z" });
		await insertWorker({
			id: "w-new",
			tier: "heavy",
			status: "archived",
			lastMessageAt: "2026-01-03T00:00:00.000Z",
		});
		// 别的编排会话 / 非编排子代理都不算；同一编排下的复核者应进入清单。
		await insertWorker({
			id: "w-other",
			parentNarratorId: OTHER_PARENT_ID,
			lastMessageAt: "2026-01-04T00:00:00.000Z",
		});
		await insertWorker({
			id: "w-reviewer",
			subagentType: `orch-review--${PROFILE_ID}--quick`,
			lastMessageAt: "2026-01-05T00:00:00.000Z",
		});

		const status = await readOrchestrationStatus(PARENT_ID);

		expect(status?.workers.map((worker) => worker.narratorId)).toEqual([
			"w-reviewer",
			"w-new",
			"w-old",
		]);
		expect(status?.workerCount).toBe(3);
		expect(status?.workersTruncated).toBe(false);
		// reviewer 只进入清单，不占执行者容量 running 计数。
		expect(status?.tiers.quick.running).toBe(0);
		const reviewer = status?.workers.find((worker) => worker.narratorId === "w-reviewer");
		expect(reviewer).toMatchObject({ role: "reviewer", tier: "quick", model: "provA:worker" });
		const archived = status?.workers.find((worker) => worker.narratorId === "w-new");
		expect(archived?.tier).toBe("heavy");
		// 已停放的 worker 一样列出来（否则"池子里停着什么"永远看不到）。
		expect(archived?.status).toBe("archived");
	});

	test("上下文占用取最近一个有值的请求记录；一次记录都没有时是 null 而不是 0", async () => {
		await insertWorker({ id: "w-with", lastMessageAt: "2026-01-02T00:00:00.000Z" });
		await insertWorker({ id: "w-without", lastMessageAt: "2026-01-01T00:00:00.000Z" });
		await insertApiRequest({
			id: "req-1",
			narratorId: "w-with",
			contextPercent: 12,
			createdAt: "2026-01-01T10:00:00.000Z",
		});
		// 更晚的一次请求才是"当前占用"。
		await insertApiRequest({
			id: "req-2",
			narratorId: "w-with",
			contextPercent: 42.5,
			createdAt: "2026-01-01T11:00:00.000Z",
		});

		const status = await readOrchestrationStatus(PARENT_ID);
		const byId = new Map(status?.workers.map((worker) => [worker.narratorId, worker]));

		expect(byId.get("w-with")?.contextPercent).toBe(42.5);
		expect(byId.get("w-without")?.contextPercent).toBeNull();
	});

	/**
	 * 上下文占用的**有界回溯**。
	 *
	 * `context_percent` 不是每次请求都会写：失败的、被中断的、上游没给 usage 的那些行
	 * 这一列是空的。于是"最后一次请求那一行没有值"是常态——而从前只看那一行，结果是
	 * worker 明明刚报过占用率，面板上却写着「未知」。
	 *
	 * 断言同时钉住两端：窗口内要能回看到有值的行，窗口外不许再往外翻（那是扫描上界，
	 * 放宽就等于把主线程交出去），并且始终区分「未知」（`null`）与「真的是 0」。
	 */
	describe("上下文占用：在有界窗口内取最近一个有值的行", () => {
		/** 连续插 n 条"没报出占用率"的请求，模拟几次失败的尝试。 */
		async function insertBlankRequests(
			workerId: string,
			count: number,
			baseMs: number,
		): Promise<void> {
			for (let index = 0; index < count; index++) {
				await insertApiRequest({
					id: `${workerId}-blank-${String(index).padStart(2, "0")}`,
					narratorId: workerId,
					contextPercent: null,
					createdAt: new Date(baseMs + index * 1000).toISOString(),
				});
			}
		}

		test("最后一次请求没有占用率时，回看到更早那条有值的", async () => {
			await insertWorker({ id: "w-prev", lastMessageAt: "2026-01-02T00:00:00.000Z" });
			await insertApiRequest({
				id: "w-prev-valued",
				narratorId: "w-prev",
				contextPercent: 33.5,
				createdAt: "2026-01-02T00:00:00.000Z",
			});
			await insertBlankRequests("w-prev", 3, Date.parse("2026-01-02T00:01:00.000Z"));

			const status = await readOrchestrationStatus(PARENT_ID);
			const byId = new Map(status?.workers.map((worker) => [worker.narratorId, worker]));

			// 这就是本次修复的核心：以前只读最后一行，于是这里会显示「未知」。
			expect(byId.get("w-prev")?.contextPercent).toBe(33.5);
		});

		test("窗口内有多条有值的行时，取最近的那一条", async () => {
			await insertWorker({ id: "w-two", lastMessageAt: "2026-01-02T00:00:00.000Z" });
			await insertApiRequest({
				id: "w-two-old",
				narratorId: "w-two",
				contextPercent: 11,
				createdAt: "2026-01-02T00:00:00.000Z",
			});
			await insertApiRequest({
				id: "w-two-new",
				narratorId: "w-two",
				contextPercent: 77,
				createdAt: "2026-01-02T00:01:00.000Z",
			});
			await insertBlankRequests("w-two", 1, Date.parse("2026-01-02T00:02:00.000Z"));

			const status = await readOrchestrationStatus(PARENT_ID);
			const byId = new Map(status?.workers.map((worker) => [worker.narratorId, worker]));

			expect(byId.get("w-two")?.contextPercent).toBe(77);
		});

		test("窗口内一条有值的行都没有时是 null，不是 0", async () => {
			await insertWorker({ id: "w-blank", lastMessageAt: "2026-01-02T00:00:00.000Z" });
			await insertBlankRequests(
				"w-blank",
				WORKER_CONTEXT_LOOKBACK_ROWS,
				Date.parse("2026-01-02T00:00:00.000Z"),
			);

			const status = await readOrchestrationStatus(PARENT_ID);
			const byId = new Map(status?.workers.map((worker) => [worker.narratorId, worker]));

			expect(byId.get("w-blank")?.contextPercent).toBeNull();
			// 显式区分"不知道"与"真的是 0"：退化成一个数字就等于谎报上下文很空。
			expect(byId.get("w-blank")?.contextPercent).not.toBe(0);
		});

		test("回溯有界：有值的行落在窗口之外时不再被取到", async () => {
			await insertWorker({ id: "w-outside", lastMessageAt: "2026-01-02T00:00:00.000Z" });
			await insertApiRequest({
				id: "w-outside-valued",
				narratorId: "w-outside",
				contextPercent: 55,
				createdAt: "2026-01-02T00:00:00.000Z",
			});
			// 恰好比窗口多一行：那一行有值的记录正好被挤出窗口。
			await insertBlankRequests(
				"w-outside",
				WORKER_CONTEXT_LOOKBACK_ROWS,
				Date.parse("2026-01-02T00:01:00.000Z"),
			);

			const status = await readOrchestrationStatus(PARENT_ID);
			const byId = new Map(status?.workers.map((worker) => [worker.narratorId, worker]));

			expect(byId.get("w-outside")?.contextPercent).toBeNull();
		});

		test("回溯边界就在窗口长度上：窗口内最后一行有值仍然取得到", async () => {
			await insertWorker({ id: "w-edge", lastMessageAt: "2026-01-02T00:00:00.000Z" });
			await insertApiRequest({
				id: "w-edge-valued",
				narratorId: "w-edge",
				contextPercent: 88,
				createdAt: "2026-01-02T00:00:00.000Z",
			});
			// 少一行：那一行有值的记录仍在窗口的最远端。
			await insertBlankRequests(
				"w-edge",
				WORKER_CONTEXT_LOOKBACK_ROWS - 1,
				Date.parse("2026-01-02T00:01:00.000Z"),
			);

			const status = await readOrchestrationStatus(PARENT_ID);
			const byId = new Map(status?.workers.map((worker) => [worker.narratorId, worker]));

			expect(byId.get("w-edge")?.contextPercent).toBe(88);
		});
	});

	test("reused 来自有界的派发窗口；窗口外的 worker 是 null", async () => {
		await insertWorker({ id: "w-reused", lastMessageAt: "2026-01-02T00:00:00.000Z" });
		await insertWorker({ id: "w-outside", lastMessageAt: "2026-01-01T00:00:00.000Z" });
		await insertRun({
			id: "run-1",
			workerNarratorId: "w-reused",
			reusedWorker: true,
			startedAt: "2026-01-02T00:00:00.000Z",
		});

		const status = await readOrchestrationStatus(PARENT_ID);
		const byId = new Map(status?.workers.map((worker) => [worker.narratorId, worker]));

		expect(byId.get("w-reused")?.reused).toBe(true);
		expect(byId.get("w-outside")?.reused).toBeNull();
	});

	/**
	 * 复用（从停放池唤醒）的 worker 也必须带着自己的 `narratorId` 回来。
	 *
	 * 这是"点进这只代理看它的会话"唯一的定位依据：界面据此决定这一行能不能点。停放只是
	 * `narrators.status` 变成 `archived`，行本身还在、id 还在——少了它，被复用的那些行
	 * 就会变成"看起来可点、点了没反应"，而那正是这一轮要修掉的形状。
	 */
	test("被复用的 worker 行照样带得出自己的 narratorId（可点进去的前提）", async () => {
		await insertWorker({ id: "w-parked", status: "archived", lastMessageAt: STAMP });
		await insertRun({
			id: "run-reused",
			workerNarratorId: "w-parked",
			reusedWorker: true,
			startedAt: STAMP,
		});

		const status = await readOrchestrationStatus(PARENT_ID);
		const parked = status?.workers.find((worker) => worker.narratorId === "w-parked");

		expect(parked?.reused).toBe(true);
		expect(parked?.status).toBe("archived");
		expect(parked?.narratorId).toBe("w-parked");
	});

	test("清单有上限，并如实给出总数与被省略的数量", async () => {
		const extra = 5;
		for (let index = 0; index < WORKER_LIST_LIMIT + extra; index++) {
			await insertWorker({
				id: `w-${String(index).padStart(3, "0")}`,
				// 逐渐变新，于是清单取到的必然是最后 50 个。
				lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
			});
		}

		const status = await readOrchestrationStatus(PARENT_ID);

		expect(status?.workers).toHaveLength(WORKER_LIST_LIMIT);
		expect(status?.workersTruncated).toBe(true);
		expect(status?.workerCount).toBe(WORKER_LIST_LIMIT + extra);
		// 最近活动优先：最新那一个必须在清单里，最早的必须不在。
		expect(status?.workers[0]?.narratorId).toBe("w-054");
		expect(status?.workers.some((worker) => worker.narratorId === "w-000")).toBe(false);
	});
});
