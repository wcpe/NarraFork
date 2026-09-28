/**
 * 复用派发的活动摘要归属：**一个 worker 可被派发多次**。
 *
 * 停放池允许同一个 worker 被复用（`parking.ts`），于是"一次 Agent 调用 ↔ 一只 worker"
 * 不再成立。此前活动摘要按 `narrators.origin_tool_call_id` 反推 owner，而那一列只记得
 * **首次**派发（它被 ACL / revert / COW 校验共用，不能改写），复用那次既找不到 owner、
 * 也过不了"owner 有落在本次 tool_use id 下的消息"这条证据——卡片于是拿到占位值
 * `{subagentNarratorId: null, model: null, latestToolCalls: []}`：模型徽标、最近调用、
 * "打开完整会话"三样全缺。
 *
 * 本文件因此只钉一件事：**复用派发的卡片必须挂到本次派发上**，且同一只 worker 的历史
 * 派发互不覆盖。两条边界同时在场：
 * - 同一 worker 的多次派发是合法血缘（要放开）；
 * - 冒充他人工具调用（另一个 worker 声称自己执行了别人的那一次）绝不放行（变异实验见
 *   最后一个 describe）。
 *
 * 替身只换真正需要模型/网络的东西，派发、续跑、落点写入、活动聚合全部真跑：
 * - `executeSubagent`：真跑一轮 agent loop 需要模型与网络；
 * - `@server/services/agent-runtime/publication`：测试库缺 `runtime_publication_outbox`
 *   （该表只在 `server/db/schema.ts` 里，`drizzle/` 没有对应迁移；既存缺陷）；
 * - `runSubagent`：把"新建一个 worker"固定住，才能断言复用路径没有新建。
 * `resumeSubagent` 保持真实——本次修复的落点写入就在它汇出的续跑出口上。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { ORCHESTRATOR_TOOLS } from "../../lib/orchestration/tier-definition";
import type { OrchestrationProfile, OrchestrationSettings } from "../../lib/orchestration/types";

const { db, sqlite } = getTestDb();
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-reuse-activity";
const WORKER_ID = "orch-reuse-worker";
/** 另一只同编制的 worker：用来验证"别人的工具调用不会被这只抢走"。 */
const OTHER_WORKER_ID = "orch-reuse-other";
/** 归属不明：这只 worker 的 parentNarratorId 指向别的编制者。 */
const FOREIGN_ID = "orch-reuse-foreign";
const FOREIGN_PARENT_ID = "parent-someone-else";
const QUICK_TYPE = `orch--${PROFILE_ID}--quick`;
const WORKER_MODEL = "provA:worker";
const STAMP = "2026-01-01T00:00:00.000Z";

/** 页面上的一张 Agent 卡片：父级那条工具消息 + 它对应的工具调用行。 */
interface Card {
	messageId: string;
	toolCallId: string;
	toolUseId: string;
}

/** 首次派发（创建溯源指向它）。 */
const FIRST: Card = {
	messageId: "parent-msg-first",
	toolCallId: "tool-call-first",
	toolUseId: "tool-use-first",
};
/** 复用派发（本次）。`ctx.currentToolUseId` / `ctx.toolCallBinding` 与它一致。 */
const REUSE: Card = {
	messageId: "parent-msg-reuse",
	toolCallId: "tool-call-reuse",
	toolUseId: "tool-use-reuse",
};
/** 另一只 worker 的那一次派发。 */
const OTHER: Card = {
	messageId: "parent-msg-other",
	toolCallId: "tool-call-other",
	toolUseId: "tool-use-other",
};

const runCalls: Array<Record<string, unknown>> = [];
const FRESH_OUTPUT = "<subagent_id>w-new</subagent_id>\n\nFRESH";
const REUSED_FINAL_TEXT = "done";

// 替身 1：只换 `executeSubagent`，终态收尾与租约归还全部走真实实现。
const realExecutor = { ...(await import("@server/services/subagent-executor")) };
mock.module("@server/services/subagent-executor", () => ({
	...realExecutor,
	executeSubagent: mock(async () => ({
		finalText: REUSED_FINAL_TEXT,
		hasError: false,
		aborted: false,
		contextLengthExceeded: false,
		allowInboxWake: false,
		finalUserId: null,
	})),
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

// 替身 3：只固定"新建派发"，`resumeSubagent` 保持真实（落点写入在它下游）。
const realSubagent = { ...(await import("@server/services/narrator-subagent")) };
mock.module("@server/services/narrator-subagent", () => ({
	...realSubagent,
	runSubagent: mock(async (input: Record<string, unknown>) => {
		runCalls.push(input);
		return FRESH_OUTPUT;
	}),
}));

/**
 * 续跑会去解析"这个 worker 用哪个供应商"（首派是调用方把 provider 传进来的）。
 * 测试里没有配置任何供应商，所以照 `agent-runtime-ownership.test.ts` 的做法注册一个外部
 * 解析器。`chat()` 直接抛错：本文件绝不真跑一轮模型。
 */
const unregisterProvider = (
	await import("../../lib/agent/provider")
).registerExternalProviderResolver((name) =>
	name === "provA"
		? {
				formatTools: () => [],
				buildHistory: async () => ({ history: [], trailingToolResults: [] }),
				injectSystemPrompt: () => {},
				chat() {
					throw new Error("Reused-dispatch test must never call a model");
				},
				formatToolResult: (toolUseId: string, output: string, isError: boolean) => ({
					toolUseId,
					output,
					isError,
				}),
				pushUserTurn: () => {},
				pushAssistantTurn: () => {},
				generate: async () => "",
				generateWithMeta: async () => ({ text: "" }),
				generateWithHistory: async () => "",
			}
		: null,
);

const parking = await import("../../lib/orchestration/parking");
const { resolveRuntimePolicy } = await import("../agent-runtime/policy");
const { settings } = await import("../../lib/settings");
const { agentTool } = await import("../../lib/agent/tools/task");
const { narratorService } = await import("../narrator-service");

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
		currentToolUseId: REUSE.toolUseId,
		toolCallBinding: { toolCallId: REUSE.toolCallId, attempt: 1 },
		updateExecutionLease: {} as ToolContext["updateExecutionLease"],
		userId: null,
	} as ToolContext;
}

function makeProfile(): OrchestrationProfile {
	const tier = () => ({ pool: [{ model: WORKER_MODEL }] });
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

/**
 * 插一条父级的 Agent 卡片：消息 + ref + 工具调用行三者齐备，`parents` 才认得出它。
 * `executionIdentityVersion` 必须是 1：0 是 legacy/未验证，页面不会为它找 owner。
 */
async function insertCard(card: Card, seq: number): Promise<void> {
	db.insert(narratorMessages)
		.values({
			id: card.messageId,
			narratorId: PARENT_ID,
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{ type: "tool_use", id: card.toolUseId, name: "Agent", input: { prompt: "do it" } },
			],
			createdAt: STAMP,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `${card.messageId}-ref`,
			narratorId: PARENT_ID,
			messageId: card.messageId,
			seq,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: card.toolCallId,
			narratorId: PARENT_ID,
			messageId: card.messageId,
			toolUseId: card.toolUseId,
			toolName: "Agent",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionSegmentId: card.toolCallId,
			status: "success",
			createdAt: STAMP,
		})
		.run();
}

/** 编制者（primary）；第 1/3 个测试各自插入自己需要的编制者。 */
function insertPrimaryNarrator(id: string): void {
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.run();
}

async function insertNarratorRow(input: {
	id: string;
	parentNarratorId: string;
	originToolCallId: string | null;
	status?: "idle" | "working" | "waiting" | "archived";
}): Promise<void> {
	db.insert(narrators)
		.values({
			id: input.id,
			type: "subagent",
			variant: `subagent:${QUICK_TYPE}`,
			subagentType: QUICK_TYPE,
			parentNarratorId: input.parentNarratorId,
			originToolCallId: input.originToolCallId,
			status: input.status ?? "idle",
			isBackground: false,
			model: WORKER_MODEL,
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.run();
}

/** 一条"落到某张工具卡片下"的 worker 消息 + 它自己的作者引用。 */
async function insertAnchoredTurn(input: {
	id: string;
	narratorId: string;
	parentToolUseId: string;
	seq: number;
	role?: "user" | "assistant";
	createdAt?: string;
}): Promise<void> {
	db.insert(narratorMessages)
		.values({
			id: input.id,
			narratorId: input.narratorId,
			parentToolUseId: input.parentToolUseId,
			role: input.role ?? "user",
			contentJson: [{ type: "text", text: input.id }],
			contentText: input.id,
			createdAt: input.createdAt ?? STAMP,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `${input.id}-ref`,
			narratorId: input.narratorId,
			messageId: input.id,
			seq: input.seq,
		})
		.run();
}

/**
 * 一只编排 worker 的既有状态：创建溯源指向首次派发，且**首次派发的落点**已经记在
 * 它那一轮提示上（创建时由 `persistSubagentUserMessage` 写下），另有一条真实工具调用
 * 供卡片上的"最近调用"使用。与停放池里的 worker 完全同形，只是省掉了真跑首派。
 */
async function insertWorkerWithHistory(input: {
	id: string;
	parentNarratorId?: string;
	originCard: Card;
	anchoredCards: Card[];
}): Promise<void> {
	await insertNarratorRow({
		id: input.id,
		parentNarratorId: input.parentNarratorId ?? PARENT_ID,
		originToolCallId: input.originCard.toolCallId,
	});
	let seq = 1;
	for (const card of input.anchoredCards) {
		await insertAnchoredTurn({
			id: `${input.id}-turn-${card.toolUseId}`,
			narratorId: input.id,
			parentToolUseId: card.toolUseId,
			seq: seq++,
		});
	}
	const workMessageId = `${input.id}-work`;
	db.insert(narratorMessages)
		.values({
			id: workMessageId,
			narratorId: input.id,
			parentToolUseId: null,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: `${input.id}-read`, name: "Read" }],
			createdAt: STAMP,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `${workMessageId}-ref`,
			narratorId: input.id,
			messageId: workMessageId,
			seq: seq++,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${input.id}-read-call`,
			narratorId: input.id,
			messageId: workMessageId,
			toolUseId: `${input.id}-read`,
			toolName: "Read",
			status: "success",
			inputJson: { file_path: "/tmp/worker.ts" },
			executionIdentityVersion: 1,
			createdAt: "2026-01-01T00:00:01.000Z",
		})
		.run();
	// 停放：事实来源是 `narrators.status`，登记簿由惰性重建从它恢复。
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, input.id)).run();
}

/** 走一次真实的编排派发：命中停放池就用续跑，否则新建。 */
function dispatchQuick() {
	return agentTool.execute({ description: "task", prompt: "do it", tier: "quick" }, contextOf());
}

/** 页面上某张卡片的活动摘要（真正的读路径产物，不是函数返回值）。 */
// biome-ignore lint/suspicious/noExplicitAny: 聚合结果形状由服务层定义
function activityOf(range: any, card: Card) {
	const message = range.messages?.find((m: { id: string }) => m.id === card.messageId);
	const block = message?.contentJson?.find(
		(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === card.toolUseId,
	);
	return block?._subagentActivity as
		| {
				subagentNarratorId: string | null;
				model: string | null;
				latestToolCalls: Array<{ toolName: string; toolUseId: string }>;
		  }
		| undefined;
}

async function readPage() {
	return narratorService.getPretextDocumentPage(PARENT_ID, { limit: 20 });
}

let originalOrchestration: OrchestrationSettings | undefined;

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile()],
	};
	parking.__resetParkingRegistryForTests();
	runCalls.length = 0;
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	cleanDb(sqlite);
});

afterAll(() => {
	unregisterProvider();
	// `@server/db` 等替身不用还原：`--isolate` 下每个测试文件一份模块注册表，它们不会外溢。
	mock.restore();
});

describe("复用派发的活动摘要挂到本次派发", () => {
	test("复用跑完，卡片拿到 model / latestToolCalls / subagentNarratorId", async () => {
		insertPrimaryNarrator(PARENT_ID);
		await insertCard(FIRST, 1);
		await insertCard(REUSE, 2);
		await insertWorkerWithHistory({
			id: WORKER_ID,
			originCard: FIRST,
			anchoredCards: [FIRST],
		});

		// 走真实派发：worker 已在池子里 → 复用 → 真实 `resumeSubagent` 写下本次落点。
		const dispatched = await dispatchQuick();
		expect(dispatched.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);

		const page = await readPage();
		const reused = activityOf(page, REUSE);
		// 修复前这里是占位值 `{subagentNarratorId: null, model: null, latestToolCalls: []}`。
		expect(reused?.subagentNarratorId).toBe(WORKER_ID);
		expect(reused?.model).toBe(WORKER_MODEL);
		expect(reused?.latestToolCalls.map((call) => call.toolName)).toEqual(["Read"]);

		// 同一只 worker 的历史派发不被覆盖：首次派发那张卡片仍在。
		const first = activityOf(page, FIRST);
		expect(first?.subagentNarratorId).toBe(WORKER_ID);
		expect(first?.model).toBe(WORKER_MODEL);
	});

	test("同一 worker 被派发多次时，每一张卡片都挂到它、互不覆盖", async () => {
		insertPrimaryNarrator(PARENT_ID);
		await insertCard(FIRST, 1);
		await insertCard(REUSE, 2);
		await insertWorkerWithHistory({
			id: WORKER_ID,
			originCard: FIRST,
			anchoredCards: [FIRST],
		});

		// 第一次复用：worker 跑完再次归档回池。
		expect((await dispatchQuick()).isError).toBeUndefined();
		// 第二次复用：同一个 worker 的第三次派发。
		expect((await dispatchQuick()).isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);

		const page = await readPage();
		for (const card of [FIRST, REUSE]) {
			const activity = activityOf(page, card);
			expect(activity?.subagentNarratorId).toBe(WORKER_ID);
			expect(activity?.model).toBe(WORKER_MODEL);
		}
	});
});

describe("冒充他人工具调用的绑定拿不到 owner（变异实验）", () => {
	/** 三张卡片 + 两只同编制的 worker：本次派发归 WORKER_ID，另一张归 OTHER_WORKER_ID。 */
	async function seedTwoWorkers() {
		insertPrimaryNarrator(PARENT_ID);
		insertPrimaryNarrator(FOREIGN_PARENT_ID);
		await insertCard(FIRST, 1);
		await insertCard(REUSE, 2);
		await insertCard(OTHER, 3);
		await insertWorkerWithHistory({
			id: WORKER_ID,
			originCard: FIRST,
			anchoredCards: [FIRST, REUSE],
		});
		await insertWorkerWithHistory({
			id: OTHER_WORKER_ID,
			originCard: OTHER,
			anchoredCards: [OTHER],
		});
	}

	/** 变异：把另一只 worker 的落点改到**不属于它**的那次派发上（它"声称"自己执行了别人的调用）。 */
	function stealAnchor() {
		db.update(narratorMessages)
			.set({ parentToolUseId: REUSE.toolUseId })
			.where(eq(narratorMessages.id, `${OTHER_WORKER_ID}-turn-${OTHER.toolUseId}`))
			.run();
	}

	test("静止（无冒充）：每张卡片的 owner 是它自己那次派发的执行者", async () => {
		await seedTwoWorkers();
		const page = await readPage();
		expect(activityOf(page, REUSE)?.subagentNarratorId).toBe(WORKER_ID);
		expect(activityOf(page, OTHER)?.subagentNarratorId).toBe(OTHER_WORKER_ID);
	});

	test("变异：把落点改到别人的那次派发上 —— 冒充不会得手（整组作废，不误判）", async () => {
		await seedTwoWorkers();
		// 对照组：同一份数据、没有冒充时，本次派发的 owner 就是真实执行者。
		expect(activityOf(await readPage(), REUSE)?.subagentNarratorId).toBe(WORKER_ID);

		stealAnchor();

		const page = await readPage();
		// 冒充者拿不到 owner 位置：这次派发的 owner 组里出现了两个不同 worker，
		// 于是整组按"归属不明"作废（与既有的"多个真实 owner 保持未知、不做 last-row-wins"
		// 同一条规则），而不是把本次派发改记到冒充者名下。
		expect(activityOf(page, REUSE)?.subagentNarratorId).not.toBe(OTHER_WORKER_ID);
		expect(activityOf(page, REUSE)?.subagentNarratorId).toBeNull();
		// 无辜的那一侧不受影响。
		expect(activityOf(page, FIRST)?.subagentNarratorId).toBe(WORKER_ID);
	});

	test("变异：换成另一个编制者名下的 worker —— 跨编制者冒充仍被拒", async () => {
		await seedTwoWorkers();
		// 冒充者：一只属于**别的编制者**的 worker，却在本次派发的卡片下落了一轮消息。
		await insertWorkerWithHistory({
			id: FOREIGN_ID,
			parentNarratorId: FOREIGN_PARENT_ID,
			originCard: OTHER,
			anchoredCards: [REUSE],
		});

		const page = await readPage();
		expect(activityOf(page, REUSE)?.subagentNarratorId).not.toBe(FOREIGN_ID);
		expect(activityOf(page, REUSE)?.subagentNarratorId).toBe(WORKER_ID);
	});
});
