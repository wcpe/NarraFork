/**
 * 编排派发的审计记录：**走真实派发路径**的接入测试。
 *
 * `audit.test.ts` 逐条钉住了这张表的读写契约，但"派发时到底有没有记、记的是不是
 * 这次派发"只有穿过 `agentTool.execute` 的编排分支才能证明。因此本文件只替身
 * 真正需要模型与网络的那一层（`runSubagent` / `resumeSubagent`），其余全部真跑：
 * 真实选模、真实 `resolveExecutorNarratorId`、真实自审/复核编排、真实审计写入。
 *
 * 断言的重心是**归因**：这一行必须记在这次派发的编制者、方案、档位、模型与执行者上，
 * 否则"编排开销与执行开销的归集对比"就无从建立。另有一条断言是反向的：
 * **审计写不进去时派发必须照常成功**——审计是旁路，坏掉不许改变化派发的结果。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, orchestrationRuns } from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { ORCHESTRATOR_TOOLS } from "../../lib/orchestration/tier-definition";
import type { OrchestrationProfile, OrchestrationSettings } from "../../lib/orchestration/types";

const { db, sqlite } = getTestDb();
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-orch-audit";
const WORKER_ID = "orch-audit-worker";
const WORKER_MODEL = "provA:worker";
const QUICK_TYPE = `orch--${PROFILE_ID}--quick`;
const STAMP = "2026-01-01T00:00:00.000Z";

/** 每次派发打印在派发侧的那几次调用，供"复核者确实被派过"这类断言使用。 */
const runCalls: Array<Record<string, unknown>> = [];
let runSubagentImpl: () => Promise<string> = async () => "FRESH";
let selfReviewOutput = "";

/** 一份能被 `parseOrchestrationReceipt` 认下的回执（判定 pass）。 */
const PASS_RECEIPT = [
	"done",
	"```json",
	JSON.stringify({
		verdict: "pass",
		changedFiles: ["server/lib/orchestration/audit.ts"],
		testsRun: ["bun test"],
		notDone: [],
		confidence: "high",
		blockers: [],
	}),
	"```",
].join("\n");

// 替身：执行/复核都要跑真实 agent loop（模型 + 网络），与审计归因无关。
const realSubagent = { ...(await import("@server/services/narrator-subagent")) };
mock.module("@server/services/narrator-subagent", () => ({
	...realSubagent,
	runSubagent: mock(async (input: Record<string, unknown>) => {
		runCalls.push(input);
		return runSubagentImpl();
	}),
	resumeSubagent: mock(async () => ({
		started: true,
		resumedSuspendedRunner: false,
		originToolUseId: "origin-tool-use",
		terminalCompletion: Promise.resolve(selfReviewOutput),
	})),
}));

const parking = await import("../../lib/orchestration/parking");
const { resolveRuntimePolicy } = await import("../agent-runtime/policy");
const { settings } = await import("../../lib/settings");
const { agentTool } = await import("../../lib/agent/tools/task");

const orchestratorPolicy = resolveRuntimePolicy({
	variant: "primary",
	extraToolNames: ORCHESTRATOR_TOOLS,
	orchestrationProfileId: PROFILE_ID,
});

function contextOf(): ToolContext {
	return {
		narratorId: PARENT_ID,
		cwd: ".",
		signal: new AbortController().signal,
		locale: "zh-CN",
		runtimePolicy: orchestratorPolicy,
		currentToolUseId: "tool-use-1",
		toolCallBinding: { toolCallId: "tool-call-1", attempt: 1 },
		updateExecutionLease: {} as ToolContext["updateExecutionLease"],
		userId: null,
	} as ToolContext;
}

function makeProfile(
	review: Partial<OrchestrationProfile["review"]> = {},
	poolEntry: Record<string, unknown> = { model: WORKER_MODEL },
): OrchestrationProfile {
	const tier = () => ({ pool: [poolEntry] }) as unknown as OrchestrationProfile["tiers"]["chore"];
	return {
		id: PROFILE_ID,
		name: "测试方案",
		enabled: true,
		review: {
			selfReview: false,
			independentReview: false,
			reviewTier: "quick",
			maxReworkAttempts: 2,
			...review,
		},
		tiers: { chore: tier(), quick: tier(), medium: tier(), heavy: tier() },
	};
}

/** 编制者（`narrators.parent_narrator_id` 有外键，子行之前必须先有父行）。 */
async function insertParent(id: string): Promise<void> {
	await db
		.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.onConflictDoNothing();
}

/**
 * 插一只执行者 worker。
 *
 * `originToolCallId` 是 `resolveExecutorNarratorId` 的唯一线索（它按 parent + 这次
 * 工具调用行反查执行者），因此派发前必须先把这一行建好，否则审计里的
 * `workerNarratorId` 会是 null——那不是缺陷，而是"没能确认执行者"的如实结果。
 */
async function insertWorker(over: { status?: (typeof narrators.$inferInsert)["status"] } = {}) {
	await insertParent(PARENT_ID);
	await db
		.insert(narrators)
		.values({
			id: WORKER_ID,
			type: "subagent",
			variant: `subagent:${QUICK_TYPE}`,
			subagentType: QUICK_TYPE,
			parentNarratorId: PARENT_ID,
			status: over.status ?? "working",
			originToolCallId: "tool-call-1",
			model: WORKER_MODEL,
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.onConflictDoNothing();
}

/** 这个编制者名下的全部审计行。 */
function auditRows() {
	return db
		.select()
		.from(orchestrationRuns)
		.where(eq(orchestrationRuns.coordinatorNarratorId, PARENT_ID));
}

const DISPATCH_ARGS = { description: "task", prompt: "do it", tier: "quick" } as const;

let originalOrchestration: OrchestrationSettings | undefined;

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile()],
	};
	parking.__resetParkingRegistryForTests();
	runCalls.length = 0;
	runSubagentImpl = async () => "FRESH";
	selfReviewOutput = "";
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	cleanDb(sqlite);
});

afterAll(() => {
	mock.restore();
});

describe("成功派发的审计归因", () => {
	test("写入一行，收尾更新同一行，并把编制者/档位/模型/执行者都记上", async () => {
		await insertWorker();

		const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

		expect(result.isError).toBeUndefined();
		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		const run = rows[0];
		expect(run.coordinatorNarratorId).toBe(PARENT_ID);
		expect(run.profileId).toBe(PROFILE_ID);
		expect(run.tier).toBe("quick");
		expect(run.model).toBe(WORKER_MODEL);
		// 复核双关时阶段就是 `dispatched`：派发结束，但没有任何复核发生过。
		expect(run.phase).toBe("dispatched");
		expect(run.workerNarratorId).toBe(WORKER_ID);
		expect(run.reusedWorker).toBe(false);
		expect(run.verdict).toBeNull();
		expect(run.error).toBeNull();
		expect(run.finishedAt).not.toBeNull();
		expect(typeof run.durationMs).toBe("number");
		expect(run.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("自审 + 独立复核都跑过时阶段为 reviewed，verdict 来自回执", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile({ selfReview: true, independentReview: true })],
		};
		await insertWorker();
		// 自审那轮的最终文本就是回执的来源（回执优先取自审轮）。
		selfReviewOutput = PASS_RECEIPT;
		runSubagentImpl = async () => PASS_RECEIPT;

		const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

		expect(result.isError).toBeUndefined();
		// 执行者 + 复核者两次派发（复核者是另一只只读 worker）。
		expect(runCalls).toHaveLength(2);
		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].phase).toBe("reviewed");
		expect(rows[0].verdict).toBe("pass");
	});
});

/**
 * 池条目上的思考强度**确实传到了执行者**。
 *
 * 这是"配了不生效"这一类缺陷唯一的防线：强度能存、界面能改、类型也对，
 * 唯一会出错的地方是选模那一步把它丢掉（或者只传给了一半的派发路径）。
 * 因此这里不看类型、不看配置对象，而是直接查 `runSubagent` 的调用参数。
 */
describe("池条目的思考强度流向执行者", () => {
	test("配了强度时新建派发把它传给 runSubagent", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile({}, { model: WORKER_MODEL, reasoningEffort: "high" })],
		};
		await insertWorker();

		const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

		expect(result.isError).toBeUndefined();
		expect(runCalls).toHaveLength(1);
		expect(runCalls[0].reasoningEffort).toBe("high");
		expect(runCalls[0].model).toBe(WORKER_MODEL);
	});

	test("没配强度时派发里没有显式值（不会凭空注入一个等级）", async () => {
		await insertWorker();

		const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

		expect(result.isError).toBeUndefined();
		expect(runCalls).toHaveLength(1);
		// 工具参数里也没有 reasoning_effort，因此这里必须是 undefined：
		// 任何具体值都意味着"用户没配"被换成了一个凭空出现的覆盖。
		expect(runCalls[0].reasoningEffort).toBeUndefined();
	});

	test("复用停放 worker 时强度同样写下去（复用是跑过几次之后的常态路径）", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile({}, { model: WORKER_MODEL, reasoningEffort: "low" })],
		};
		await insertWorker({ status: "archived" });
		selfReviewOutput = "REUSED";

		const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

		expect(result.isError).toBeUndefined();
		// 复用路径不新建，因此只能查库：worker 行上的等级必须被改成这次池条目的值。
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, WORKER_ID),
			columns: { reasoningEffort: true },
		});
		expect(row?.reasoningEffort).toBe("low");
	});
});

describe("复用停放 worker 的审计", () => {
	test("复用成功时 reusedWorker 为 true，执行者记的是被复用的那只", async () => {
		// 归档 + 停放的 worker：认领会把它从池子里取出并唤醒。
		await insertWorker({ status: "archived" });
		selfReviewOutput = "REUSED";

		const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

		expect(result.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0); // 复用路径不新建
		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].reusedWorker).toBe(true);
		expect(rows[0].workerNarratorId).toBe(WORKER_ID);
	});
});

describe("失败派发的审计", () => {
	test("执行者抛错时留下 failed 行，原因截断存储", async () => {
		await insertWorker();
		runSubagentImpl = async () => {
			throw new Error("z".repeat(5000));
		};

		const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

		expect(result.isError).toBe(true);
		expect(result.output).toStartWith("Subagent error:");
		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].phase).toBe("failed");
		expect(rows[0].finishedAt).not.toBeNull();
		const stored = rows[0].error ?? "";
		expect(stored.length).toBe(2000);
		expect(stored.at(-1)).toBe("…");
	});
});

describe("审计写不进去时派发照常", () => {
	test("审计插入抛错，派发仍返回正常结果", async () => {
		await insertWorker();
		const realInsert = db.insert.bind(db);
		const insertSpy = spyOn(db, "insert").mockImplementation(((table: unknown) => {
			// 只打坏审计这一张表：其它写入（narrator 行等）必须照常，否则测的就不是审计。
			if (table === orchestrationRuns) throw new Error("audit insert exploded");
			return realInsert(table as never);
		}) as typeof db.insert);

		try {
			const result = await agentTool.execute(DISPATCH_ARGS, contextOf());

			expect(result.isError).toBeUndefined();
			// 派发照常：编制者拿到的还是那份渲染好的报告（含执行者输出）。
			expect(result.output).toContain("FRESH");
			expect(await auditRows()).toHaveLength(0);
		} finally {
			insertSpy.mockRestore();
		}
	});
});
