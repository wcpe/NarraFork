/**
 * 续跑（复用）路径的编排 worker：终态归档与复用的端到端测试。
 *
 * 与 `orchestration-parking-foreground.test.ts` 是同一件事的另一半。首派路径的停放挂在
 * `subagent-runner.ts` 的 `releaseForegroundLease`（三个归还出口都收敛在那里），
 * 而复用时 `startForegroundRun` 拿到的是借来的 owner、`releaseOnTerminal` 因此为 false，
 * 那条路根本不会被执行——租约由调用方在结论落定后归还（`subagent-resume.ts` 的续跑释放出口）。
 * 停放漏挂在这一侧的后果不是"少停一次"，而是**复用隔次生效**：
 * 被复用过的 worker 停在 `idle` 不回池，下一次同档派发只能新建。
 *
 * 因此本文件断言的是完整的两轮循环：首派归档 → 复用命中 → **复用后再次归档** → 再次命中。
 *
 * 替身与前台那一个文件一致，只换三处与本题无关的东西：
 * - `executeSubagent`：真跑一轮 agent loop 需要模型与网络；
 * - `@server/services/agent-runtime/publication`：测试库缺 `runtime_publication_outbox`
 *   （该表只在 `server/db/schema.ts` 里，`drizzle/` 没有对应迁移；既存缺陷）；
 * - `runSubagent`：把"新建一个 worker"固定住，才能断言复用路径没有新建。
 * `resumeSubagent` **保持真实**——本次缺陷的修复点就在它汇出的释放出口上，
 * 替掉它等于把要测的东西测没了。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators } from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { ORCHESTRATOR_TOOLS } from "../../lib/orchestration/tier-definition";
import type { OrchestrationProfile, OrchestrationSettings } from "../../lib/orchestration/types";
import { buildReviewerSubagentType } from "../../lib/orchestration/types";

const { db, sqlite } = getTestDb();
// 只取 `db` / `sqlite`：本文件与它动态加载的服务都只从 @server/db 取这两个。
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-orch-resume";
const WORKER_ID = "orch-resume-worker";
const QUICK_TYPE = `orch--${PROFILE_ID}--quick`;
const REVIEWER_TYPE = buildReviewerSubagentType(PROFILE_ID, "quick");
const STAMP = "2026-01-01T00:00:00.000Z";

const executorCalls: Record<string, unknown>[] = [];
const runCalls: Array<Record<string, unknown>> = [];
const FRESH_OUTPUT = "<subagent_id>w-new</subagent_id>\n\nFRESH";
/** 已跑完的 worker 被继续使用时，执行者（被替身）返回的终态文本。 */
const REUSED_FINAL_TEXT = "done";

// 替身 1：只换 `executeSubagent`，终态收尾与租约归还全部走真实实现。
const realExecutor = { ...(await import("@server/services/subagent-executor")) };
mock.module("@server/services/subagent-executor", () => ({
	...realExecutor,
	executeSubagent: mock(async (opts: Record<string, unknown>) => {
		executorCalls.push(opts);
		return {
			finalText: REUSED_FINAL_TEXT,
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

// 替身 3：只固定"新建派发"，`resumeSubagent` 保持真实（本次修复点就在它下游）。
const realSubagent = { ...(await import("@server/services/narrator-subagent")) };
mock.module("@server/services/narrator-subagent", () => ({
	...realSubagent,
	runSubagent: mock(async (input: Record<string, unknown>) => {
		runCalls.push(input);
		return FRESH_OUTPUT;
	}),
}));

// 替身 4：数停放尝试。真实实现照旧执行，这里只加一层计数——
// "一次运行恰好停放一次"必须在**尝试**这一层计数：重复停放时第二次会被
// `alreadyArchived` 提前返回，从状态或池子上根本看不出来。
const realParking = { ...(await import("@server/lib/orchestration/parking")) };
const parkAttempts: string[] = [];
let parkShouldThrow = false;
mock.module("@server/lib/orchestration/parking", () => ({
	...realParking,
	parkCompletedOrchestrationWorker: async (input: {
		narratorId: string;
		parentNarratorId: string;
	}) => {
		parkAttempts.push(input.narratorId);
		if (parkShouldThrow) throw new Error("parking exploded");
		return realParking.parkCompletedOrchestrationWorker(input);
	},
}));

/**
 * 续跑比首派多一步：它会去解析"这个 worker 用哪个供应商"（首派是调用方把 provider 传进来的）。
 * 测试里没有配置任何供应商，所以照 `agent-runtime-ownership.test.ts` 的做法注册一个外部解析器，
 * 让 `provA` 有适配器可用。`chat()` 直接抛错：本文件绝不真跑一轮模型。
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
					throw new Error("Parking-resume test must never call a model");
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
const { startContinuedSubagent, startForegroundRun } = await import("../subagent-runner");

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

async function insertWorker(input: { id: string; subagentType: string }): Promise<void> {
	await insertParent(PARENT_ID);
	await db.insert(narrators).values({
		id: input.id,
		type: "subagent",
		variant: `subagent:${input.subagentType}`,
		subagentType: input.subagentType,
		parentNarratorId: PARENT_ID,
		status: "working",
		isBackground: false,
		model: "provA:worker",
		createdAt: STAMP,
		updatedAt: STAMP,
	});
	// 续跑要靠这条消息回推出"它是哪次 Agent 调用的子代理"（`resolveSubagentOriginToolUseId`）：
	// 没有 link 的 worker 会被 `resumeSubagent` 直接拒掉，那样测的就成了拒绝而不是复用。
	await db.insert(narratorMessages).values({
		id: `${input.id}-origin`,
		narratorId: input.id,
		parentToolUseId: "tool-use-1",
		role: "user",
		contentJson: [{ type: "text", text: "task" }],
		contentText: "task",
		createdAt: STAMP,
	});
}

async function statusOf(id: string): Promise<string | undefined> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { status: true },
	});
	return row?.status;
}

/**
 * 真正跑一遍**首派**的终态路径（只把 agent loop 换成固定输出）。
 *
 * 复用的前提是"池子里有一个归档的 worker"，而池子的唯一合法来源就是首派跑完归档，
 * 所以这里刻意走真实路径而不是直接改状态——否则测的就不是整条循环了。
 */
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

/** 走一次真实的编排派发：命中停放池就用续跑，否则新建。 */
function dispatchQuick() {
	return agentTool.execute({ description: "task", prompt: "do it", tier: "quick" }, contextOf());
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
	parkAttempts.length = 0;
	parkShouldThrow = false;
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

describe("被复用过的编排 worker 跑完仍要回停放池", () => {
	test("复用跑完归档，随后同 parent/同方案/同档位派发再次命中它（复用不再隔次生效）", async () => {
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });

		// 第一轮：首派跑完 → 归档进池（这一半由前台测试覆盖，这里作为复用的前提）。
		await runForegroundTerminal(WORKER_ID, QUICK_TYPE);
		expect(await statusOf(WORKER_ID)).toBe("archived");
		expect(parkAttempts).toEqual([WORKER_ID]);

		// 第二轮：派发命中池子 → 走真实续跑 → 跑完必须再次归档。
		const firstReuse = await dispatchQuick();
		expect(firstReuse.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);
		expect(await statusOf(WORKER_ID)).toBe("archived");
		// 一次运行只停放一次：归还走的是续跑出口，前台那条 `releaseForegroundLease`
		// 被 `releaseOnTerminal=false` 门控着，两条路径不会同时执行。
		expect(parkAttempts).toEqual([WORKER_ID, WORKER_ID]);

		// 第三轮：上次复用若没回池，这里就只能新建——这正是缺陷原来的表现。
		const secondReuse = await dispatchQuick();
		expect(secondReuse.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);
		expect(runCalls).toEqual([]);
		expect(executorCalls).toHaveLength(3);
		expect(await statusOf(WORKER_ID)).toBe("archived");
		expect(parkAttempts).toEqual([WORKER_ID, WORKER_ID, WORKER_ID]);

		// 池子里始终只有同一个 worker，没有任何"新建"被放过。
		const claimed = await parking.claimReusableWorker({
			parentNarratorId: PARENT_ID,
			profileId: PROFILE_ID,
			tier: "quick",
		});
		expect(claimed?.narratorId).toBe(WORKER_ID);
	});

	test("续跑中的停放失败不影响续跑结果（只记日志）", async () => {
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });
		await runForegroundTerminal(WORKER_ID, QUICK_TYPE);
		expect(await statusOf(WORKER_ID)).toBe("archived");
		parkAttempts.length = 0;

		// 停放这一步（动态导入 parking 或归档本身）炸掉：续跑已经成功，结果必须照常返回。
		parkShouldThrow = true;
		const result = await dispatchQuick();

		expect(result.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);
		expect(result.output).toContain(REUSED_FINAL_TEXT);
		// 尝试过，但没停成：worker 留在 idle（下次派发退回新建，而不是报错）。
		expect(parkAttempts).toEqual([WORKER_ID]);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("复核者与非编排 worker 在续跑出口上仍不进池", async () => {
		// 复核者 `orch-review--` 在类型解析这一步就被拒；普通子代理根本不是编排 worker。
		// 两者都走**非 deferred** 的续跑出口（runner 自己的终态 finally），
		// 与 `releasePublication` 收敛在同一个函数上，所以这一个用例同时覆盖了那一侧。
		await insertParent(PARENT_ID);
		for (const [id, subagentType] of [
			["reviewer-1", REVIEWER_TYPE],
			["plain-1", "general"],
		] as const) {
			await db.insert(narrators).values({
				id,
				type: "subagent",
				variant: `subagent:${subagentType}`,
				subagentType,
				parentNarratorId: PARENT_ID,
				status: "idle",
				isBackground: false,
				model: "provA:worker",
				createdAt: STAMP,
				updatedAt: STAMP,
			});
			const run = await startContinuedSubagent({
				subagentId: id,
				parentNarratorId: PARENT_ID,
				toolUseId: "origin-tool",
				prompt: "continue",
				locale: "zh-CN",
				signal: new AbortController().signal,
				persistPrompt: false,
				initialHistory: [],
				initialTrailingToolResults: [],
				skipConclusionDelivery: true,
			});
			await run.terminalCompletion;

			expect(await statusOf(id)).toBe("idle");
			// 都尝试过停放（说明这一侧的出口确实挂上了），但都被排除了。
			expect(parkAttempts).toEqual([id]);
			for (const tier of ["chore", "quick", "medium", "heavy"] as const) {
				expect(
					await parking.claimReusableWorker({
						parentNarratorId: PARENT_ID,
						profileId: PROFILE_ID,
						tier,
					}),
				).toBeUndefined();
			}
			parkAttempts.length = 0;
		}
	});

	test("非 deferred 的续跑出口（runner 自己的终态 finally）同样会停放", async () => {
		// 不经过 `releasePublication` 直接续跑时，租约由 runner 的终态 finally 归还。
		// 两个出口收敛在同一个函数上，所以这一侧也必须真的停成——只"尝试过"不够：
		// 若停放挂在工作准入释放之前，这里会因为"还在跑"被判忙，静静地永不回池。
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, WORKER_ID));

		const run = await startContinuedSubagent({
			subagentId: WORKER_ID,
			parentNarratorId: PARENT_ID,
			toolUseId: "tool-use-1",
			prompt: "continue",
			locale: "zh-CN",
			signal: new AbortController().signal,
			persistPrompt: false,
			initialHistory: [],
			initialTrailingToolResults: [],
			skipConclusionDelivery: true,
		});
		await run.terminalCompletion;

		expect(parkAttempts).toEqual([WORKER_ID]);
		expect(await statusOf(WORKER_ID)).toBe("archived");
		expect(
			(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier: "quick",
				})
			)?.narratorId,
		).toBe(WORKER_ID);
	});
});
