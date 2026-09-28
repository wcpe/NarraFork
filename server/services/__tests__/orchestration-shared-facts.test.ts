/**
 * 跨档位信息共享：**走真实派发路径**的接入测试。
 *
 * `lib/orchestration/__tests__/shared-facts.test.ts` 钉住存储与失效判定本身；本文件证明
 * 那套东西真的接在了编排上，而且接的方向是对的：
 *
 * - 子代理能**写**（`SessionFact` 工具，判定身份用的是 narrators 那一行，走过真实的 DB）；
 * - 另一个档位能**读**（同一个编制者下的 medium worker 看到 quick worker 写下的结论）；
 * - 编制者能**看到**（派发结果里带出这一段）；
 * - 执行者能**收到**（派发出去的 prompt 里带出这一段）；
 * - 锚定文件一变，**两条路都不再带出那句结论**（这是"绝不静默注入过期结论"的端到端版本）。
 *
 * 最后一条必须在派发这一层再测一次：工具层的判定再正确，只要调用方拿到的是缓存过的
 * 旧文本，过期结论照样会流到下游。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { __resetSharedFactsForTests } from "../../lib/orchestration/shared-facts";
import { ORCHESTRATOR_TOOLS } from "../../lib/orchestration/tier-definition";
import type { OrchestrationProfile, OrchestrationSettings } from "../../lib/orchestration/types";

const { db, sqlite } = getTestDb();
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const COORDINATOR_ID = "coordinator-shared-facts";
const QUICK_WORKER_ID = "worker-quick";
const MEDIUM_WORKER_ID = "worker-medium";
const EXPLORE_ID = "worker-explore";
const WORKER_MODEL = "provA:worker";
const STAMP = "2026-01-01T00:00:00.000Z";

const ANCHOR_PATH = "server/lib/retry.ts";
const ORIGINAL_SOURCE = "export const shouldRetry = (status: number) => status >= 500;\n";
const CHANGED_SOURCE = "export const shouldRetry = () => true;\n";
const STATEMENT = "shouldRetry 只在 5xx 上返回 true";

const runCalls: Array<Record<string, unknown>> = [];
const realSubagent = { ...(await import("@server/services/narrator-subagent")) };
mock.module("@server/services/narrator-subagent", () => ({
	...realSubagent,
	runSubagent: mock(async (input: Record<string, unknown>) => {
		runCalls.push(input);
		return "FRESH";
	}),
	resumeSubagent: mock(async () => ({
		started: true,
		resumedSuspendedRunner: false,
		originToolUseId: "origin-tool-use",
		terminalCompletion: Promise.resolve(""),
	})),
}));

const parking = await import("../../lib/orchestration/parking");
const { resolveRuntimePolicy } = await import("../agent-runtime/policy");
const { settings } = await import("../../lib/settings");
const { sessionFactTool } = await import("../../lib/agent/tools/session-fact");
const { agentTool } = await import("../../lib/agent/tools/task");

const orchestratorPolicy = resolveRuntimePolicy({
	variant: "primary",
	extraToolNames: ORCHESTRATOR_TOOLS,
	orchestrationProfileId: PROFILE_ID,
});

let root = "";

async function writeSource(content: string): Promise<void> {
	const absolute = join(root, ANCHOR_PATH);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content, "utf8");
}

/** 子代理调用工具的上下文：`cwd` 就是工作区根，锚点相对它解析。 */
function workerContext(narratorId: string): ToolContext {
	return {
		narratorId,
		cwd: root,
		signal: new AbortController().signal,
		locale: "zh-CN",
		userId: null,
	} as ToolContext;
}

function coordinatorContext(): ToolContext {
	return {
		narratorId: COORDINATOR_ID,
		cwd: root,
		signal: new AbortController().signal,
		locale: "zh-CN",
		runtimePolicy: orchestratorPolicy,
		currentToolUseId: "tool-use-1",
		toolCallBinding: { toolCallId: "tool-call-1", attempt: 1 },
		updateExecutionLease: {} as ToolContext["updateExecutionLease"],
		userId: null,
	} as ToolContext;
}

function makeProfile(): OrchestrationProfile {
	const tier = () =>
		({ pool: [{ model: WORKER_MODEL }] }) as unknown as OrchestrationProfile["tiers"]["chore"];
	return {
		id: PROFILE_ID,
		name: "测试方案",
		enabled: true,
		// 两个复核路径都关掉，好让断言只盯着"共享事实"这一件事。
		review: {
			selfReview: false,
			independentReview: false,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: { chore: tier(), quick: tier(), medium: tier(), heavy: tier() },
	};
}

async function insertNarrator(row: {
	id: string;
	type: "primary" | "subagent";
	variant: string;
	subagentType?: string | null;
	parentNarratorId?: string | null;
}): Promise<void> {
	await db
		.insert(narrators)
		.values({
			id: row.id,
			type: row.type,
			variant: row.variant,
			subagentType: row.subagentType ?? null,
			parentNarratorId: row.parentNarratorId ?? null,
			status: "idle",
			model: WORKER_MODEL,
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.onConflictDoNothing();
}

/** 编制者 + 两个档位的执行者 + 一只普通 explore 子代理。 */
async function insertCast(): Promise<void> {
	await insertNarrator({ id: COORDINATOR_ID, type: "primary", variant: "primary" });
	await insertNarrator({
		id: QUICK_WORKER_ID,
		type: "subagent",
		variant: `subagent:orch--${PROFILE_ID}--quick`,
		subagentType: `orch--${PROFILE_ID}--quick`,
		parentNarratorId: COORDINATOR_ID,
	});
	await insertNarrator({
		id: MEDIUM_WORKER_ID,
		type: "subagent",
		variant: `subagent:orch--${PROFILE_ID}--medium`,
		subagentType: `orch--${PROFILE_ID}--medium`,
		parentNarratorId: COORDINATOR_ID,
	});
	await insertNarrator({
		id: EXPLORE_ID,
		type: "subagent",
		variant: "subagent:explore",
		subagentType: "explore",
		parentNarratorId: COORDINATOR_ID,
	});
}

/** quick worker 写下一条锚定在那个文件上的结论。 */
async function quickWorkerRecordsFact() {
	return sessionFactTool.execute(
		{
			action: "add",
			statement: STATEMENT,
			evidence: `读了 ${ANCHOR_PATH} 里 shouldRetry() 的分支`,
			files: [ANCHOR_PATH],
		},
		workerContext(QUICK_WORKER_ID),
	);
}

let originalOrchestration: OrchestrationSettings | undefined;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "nf-orch-shared-facts-"));
});

afterAll(async () => {
	mock.restore();
	if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
	originalOrchestration = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile()],
	};
	parking.__resetParkingRegistryForTests();
	__resetSharedFactsForTests();
	runCalls.length = 0;
	await writeSource(ORIGINAL_SOURCE);
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	cleanDb(sqlite);
});

describe("谁来写：只有本编排会话的参与者", () => {
	test("编排执行者可以写，确认里带上锚点与内容哈希", async () => {
		await insertCast();

		const result = await quickWorkerRecordsFact();

		expect(result.isError).toBeUndefined();
		expect(result.output).toContain(ANCHOR_PATH);
		// 哈希前 8 位要露出来：写入者能据此核对"锚的确实是我刚读的那份内容"。
		expect(result.output).toMatch(/sha256 [0-9a-f]{8}/);
	});

	test("普通 explore 子代理写不进来：它不属于任何编排会话", async () => {
		await insertCast();

		const result = await sessionFactTool.execute(
			{
				action: "add",
				statement: STATEMENT,
				evidence: "读了 retry.ts 的分支",
				files: [ANCHOR_PATH],
			},
			workerContext(EXPLORE_ID),
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("编排派发");
	});
});

describe("跨档位可读", () => {
	test("quick 档写下的结论，medium 档读得到", async () => {
		await insertCast();
		expect((await quickWorkerRecordsFact()).isError).toBeUndefined();

		// 这一条就是整个需求的核心：跨档位**不复用 worker**，信息必须靠这条通道过去。
		const listed = await sessionFactTool.execute(
			{ action: "list" },
			workerContext(MEDIUM_WORKER_ID),
		);

		expect(listed.isError).toBeUndefined();
		expect(listed.output).toContain(STATEMENT);
		// 档位标签也要在：读的人得知道这条是哪个档位得出的。
		expect(listed.output).toContain("[quick]");
	});

	test("锚定文件变更后，另一个档位读不到那句结论（只剩被扣下的说明）", async () => {
		await insertCast();
		await quickWorkerRecordsFact();
		await writeSource(CHANGED_SOURCE);

		const listed = await sessionFactTool.execute(
			{ action: "list" },
			workerContext(MEDIUM_WORKER_ID),
		);

		expect(listed.output).not.toContain(STATEMENT);
		expect(listed.output).toContain(ANCHOR_PATH);
		expect(listed.output).toContain("被**扣下**");
	});

	test("池子还是空的时候如实说空，而不是一段空标题", async () => {
		await insertCast();
		const listed = await sessionFactTool.execute(
			{ action: "list" },
			workerContext(MEDIUM_WORKER_ID),
		);
		expect(listed.output).toContain("还是空的");
	});
});

describe("派发两侧的注入", () => {
	test("执行者的 prompt 与编制者读到的结果里都带着这条结论", async () => {
		await insertCast();
		expect((await quickWorkerRecordsFact()).isError).toBeUndefined();

		const result = await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium" },
			coordinatorContext(),
		);

		expect(result.isError).toBeUndefined();
		// 读这一侧：即将干活的那只 worker 直接拿到结论，不必重新查一遍。
		expect(runCalls).toHaveLength(1);
		expect(String(runCalls[0].prompt)).toContain(STATEMENT);
		// 编制者那一侧：结论出现在它读的那条 `tool_result` 里，它不必再派一次才看得到。
		expect(result.output).toContain(STATEMENT);
		// 派发出去的原文不能被改写：共享事实是附加上去的，不是替换。
		expect(String(runCalls[0].prompt)).toContain("实现 X");
	});

	test("锚定文件变更后，prompt 与结果都不再带出那句结论", async () => {
		await insertCast();
		await quickWorkerRecordsFact();
		await writeSource(CHANGED_SOURCE);

		const result = await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium" },
			coordinatorContext(),
		);

		expect(result.isError).toBeUndefined();
		expect(String(runCalls[0].prompt)).not.toContain(STATEMENT);
		expect(result.output).not.toContain(STATEMENT);
		// 但要如实说明"有东西被扣下了、涉及哪个文件"，否则编制者会以为从来没人研究过。
		expect(result.output).toContain(ANCHOR_PATH);
	});

	test("独立复核者拿不到这些结论：它必须独立判断", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [
				{
					...makeProfile(),
					review: {
						selfReview: false,
						independentReview: true,
						reviewTier: "quick",
						maxReworkAttempts: 2,
					},
				},
			],
		};
		await insertCast();
		await quickWorkerRecordsFact();

		await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium" },
			coordinatorContext(),
		);

		const reviewer = runCalls.find((call) =>
			String(call.subagentType ?? "").startsWith("orch-review--"),
		);
		expect(reviewer).toBeDefined();
		// 把已有结论喂给复核者，它就会顺着同一套前提走——复核对同一种偏差当场失效。
		expect(String(reviewer?.prompt)).not.toContain(STATEMENT);
	});
});
