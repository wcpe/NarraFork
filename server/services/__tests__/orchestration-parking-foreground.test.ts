/**
 * 前台派发的编排 worker：终态归档与复用的端到端测试。
 *
 * 这里刻意**不用**桩替掉 runner：本文件的核心断言就是"停放发生在租约归还之后"，
 * 而那件事只体现在 `startForegroundRun` 的真实终态路径上（`finalizeSubagent` →
 * 归还执行租约 → `publishTerminal` → 停放）。只替身两处与本题无关的东西：
 * - `executeSubagent`：真跑一轮 agent loop 需要模型与网络，与终态收尾无关；
 * - `@server/services/agent-runtime/publication`：测试库缺 `runtime_publication_outbox`
 *   （该表只在 `server/db/schema.ts` 里，`drizzle/` 没有对应迁移；这是既存缺陷——
 *   `agent-runtime-publication-outbox.test.ts` 在本分支上 20/20 全红）。本文件考察的是
 *   终态/租约/停放的顺序，与投递额度无关，所以只把这一处换成内存实现。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { ORCHESTRATOR_TOOLS } from "../../lib/orchestration/tier-definition";
import type { OrchestrationProfile, OrchestrationSettings } from "../../lib/orchestration/types";
import { buildReviewerSubagentType } from "../../lib/orchestration/types";

const { db, sqlite } = getTestDb();
// 只取 `db` / `sqlite`：本文件与它动态加载的服务都只从 @server/db 取这两个。
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-orch-fg";
const WORKER_ID = "orch-fg-worker";
const QUICK_TYPE = `orch--${PROFILE_ID}--quick`;
const REVIEWER_TYPE = buildReviewerSubagentType(PROFILE_ID, "quick");
const STAMP = "2026-01-01T00:00:00.000Z";

/** 每次 `executeSubagent` 的入参，供"是否真跑了 agent loop"之外的断言使用。 */
const executorCalls: Record<string, unknown>[] = [];
const runCalls: Array<Record<string, unknown>> = [];
const resumeCalls: Array<Record<string, unknown>> = [];
const REUSED_OUTPUT = "<subagent_id>w1</subagent_id>\n\nREUSED";

// 替身 1：只换 `executeSubagent`，终态收尾全部走真实实现。
const realExecutor = { ...(await import("@server/services/subagent-executor")) };
mock.module("@server/services/subagent-executor", () => ({
	...realExecutor,
	executeSubagent: mock(async (opts: Record<string, unknown>) => {
		executorCalls.push(opts);
		return {
			finalText: "done",
			hasError: false,
			aborted: false,
			contextLengthExceeded: false,
			allowInboxWake: false,
			finalUserId: null,
		};
	}),
}));

// 替身 2：投递额度（见文件头注释）。
const FAKE_RUN = { producerKind: "agent", taskId: WORKER_ID, logicalRunId: "logical-run-1" };
const realPublication = { ...(await import("@server/services/agent-runtime/publication")) };
mock.module("@server/services/agent-runtime/publication", () => ({
	...realPublication,
	runtimePublication: { startAgentRun: () => FAKE_RUN, stop: () => {} },
	getRuntimePublicationService: () => ({
		startAgentRun: async () => FAKE_RUN,
		releaseUnusedRunSlots: async () => 0,
		stop: () => {},
	}),
}));

// 替身 3：把"派发"这一层固定住，才能断言"复用路径不新建"。
const realSubagent = { ...(await import("@server/services/narrator-subagent")) };
mock.module("@server/services/narrator-subagent", () => ({
	...realSubagent,
	runSubagent: mock(async (input: Record<string, unknown>) => {
		runCalls.push(input);
		return "<subagent_id>w-new</subagent_id>\n\nFRESH";
	}),
	resumeSubagent: mock(async (input: Record<string, unknown>) => {
		resumeCalls.push(input);
		return {
			started: true,
			resumedSuspendedRunner: false,
			originToolUseId: "origin-tool-use",
			terminalCompletion: Promise.resolve(REUSED_OUTPUT),
		};
	}),
}));

const parking = await import("../../lib/orchestration/parking");
const { resolveRuntimePolicy } = await import("../agent-runtime/policy");
const { settings } = await import("../../lib/settings");
const { agentTool } = await import("../../lib/agent/tools/task");
const { startForegroundRun } = await import("../subagent-runner");

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
		// 复用路径不接管这个租约（接管了就没法在原 lease 被消耗后退回新建），
		// 这里只要求它存在，因为派发前的校验会检查它。
		updateExecutionLease: {} as ToolContext["updateExecutionLease"],
		userId: null,
	} as ToolContext;
}

function makeProfile(model: string): OrchestrationProfile {
	const tier = () => ({ pool: [{ model }] });
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

/** `narrators.parent_narrator_id` 有外键，插入子行前先有父行。 */
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

async function insertWorker(input: {
	id: string;
	subagentType: string;
	isBackground?: boolean;
}): Promise<void> {
	await insertParent(PARENT_ID);
	await db.insert(narrators).values({
		id: input.id,
		type: "subagent",
		variant: `subagent:${input.subagentType}`,
		subagentType: input.subagentType,
		parentNarratorId: PARENT_ID,
		status: "working",
		isBackground: input.isBackground ?? false,
		model: "provA:worker",
		createdAt: STAMP,
		updatedAt: STAMP,
	});
}

async function statusOf(id: string): Promise<string | undefined> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { status: true },
	});
	return row?.status;
}

/** 真正跑一遍前台终态路径：只把 agent loop 换成固定输出。 */
async function runForegroundTerminal(id: string, subagentType: string): Promise<void> {
	const run = startForegroundRun({
		subagentId: id,
		parentNarratorId: PARENT_ID,
		toolUseId: "tool-use-1",
		subagentType,
		model: "provA:worker",
		provider: "provA",
		locale: "zh-CN",
		signal: new AbortController().signal,
		systemPrompt: "system",
		initialHistory: [],
		customDef: null,
		rebuildSystemPrompt: async () => "system",
	} as never);
	await run.terminal;
}

/** 走一次真正的复用认领（派发侧就是这么做第一步的）。 */
function claimQuick(): Promise<{ narratorId: string } | undefined> {
	return parking.claimReusableWorker({
		parentNarratorId: PARENT_ID,
		profileId: PROFILE_ID,
		tier: "quick",
	});
}

let originalOrchestration: OrchestrationSettings | undefined;

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile("provA:worker")],
	};
	parking.__resetParkingRegistryForTests();
	executorCalls.length = 0;
	runCalls.length = 0;
	resumeCalls.length = 0;
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	cleanDb(sqlite);
});

afterAll(() => {
	// `@server/db` 等替身不用还原：`--isolate` 下每个测试文件一份模块注册表，它们不会外溢。
	mock.restore();
});

describe("前台派发的编排 worker 的终态停放", () => {
	test("跑完就被归档进停放池", async () => {
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });

		await runForegroundTerminal(WORKER_ID, QUICK_TYPE);

		// 走到真实终态路径（不是直接调用停放函数）。
		expect(executorCalls).toHaveLength(1);
		expect(await statusOf(WORKER_ID)).toBe("archived");
		expect((await claimQuick())?.narratorId).toBe(WORKER_ID);
	});

	test("跑完后的下一次同 parent/同方案/同档位派发命中复用，不再新建", async () => {
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });
		await runForegroundTerminal(WORKER_ID, QUICK_TYPE);
		// 复用前它是归档状态；`resumeSubagent` 会拒绝 archived，所以派发侧必须先解除归档。
		expect(await statusOf(WORKER_ID)).toBe("archived");

		const result = await agentTool.execute(
			{ description: "task", prompt: "do it", tier: "quick" },
			contextOf(),
		);

		expect(result.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);
		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0].subagentId).toBe(WORKER_ID);
		expect(resumeCalls[0].intent).toBe("follow_up");
		expect(result.output).toStartWith(REUSED_OUTPUT);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("非编排子代理跑完仍是 idle，不进池", async () => {
		await insertWorker({ id: "plain-worker", subagentType: "general" });

		await runForegroundTerminal("plain-worker", "general");

		expect(await statusOf("plain-worker")).toBe("idle");
		expect(await claimQuick()).toBeUndefined();
	});

	test("复核者（orch-review--）跑完仍是 idle，不进池", async () => {
		await insertWorker({ id: "reviewer-1", subagentType: REVIEWER_TYPE });

		await runForegroundTerminal("reviewer-1", REVIEWER_TYPE);

		expect(await statusOf("reviewer-1")).toBe("idle");
		expect(await claimQuick()).toBeUndefined();
	});

	test("后台模式的编排 worker 不停放（既有排除条件未被破坏）", async () => {
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE, isBackground: true });

		await runForegroundTerminal(WORKER_ID, QUICK_TYPE);

		expect(await statusOf(WORKER_ID)).toBe("idle");
		expect(await claimQuick()).toBeUndefined();
	});
});
