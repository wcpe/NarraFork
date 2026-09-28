/**
 * 自审**按需**：默认不跑，只有编制者显式要求、且档位是可写档时才跑。
 *
 * 走的是真实派发路径（`agentTool.execute` 的编排分支），只替身真正需要模型与网络的那一层
 * （`runSubagent` / `resumeSubagent` / `runSelfReview`），其余全部真跑：真实选模、
 * 真实 `resolveExecutorNarratorId`、真实回执渲染与审计写入。
 *
 * 断言的重心有两处：
 *
 * 1. **默认路径上不自审**——落点是 `runSelfReview` 的调用次数。这是这次改动唯一的
 *    经济性主张：探查类派发不再付一次完整模型调用。断言"返回文本里没有那句话"是不够的，
 *    文本可以说没跑、模型照样被调了一次。
 * 2. **没跑就如实说没跑**——编制者必须能分辨"这次我没要""方案不给""跑了但挂了"，
 *    否则一份 `pass` 会被读成"已经有人复核过"。
 *
 * 另有一条反向断言：**独立复核不受这个参数影响**。用户抱怨的是自审，不是独立复核；
 * 顺手把两者一起关掉会让"改完自审"变成"改完复核"，那是另一种缺陷。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ToolContext } from "../../lib/agent/types";
import { ORCHESTRATOR_TOOLS } from "../../lib/orchestration/tier-definition";
import type { OrchestrationProfile, OrchestrationSettings } from "../../lib/orchestration/types";

const { db, sqlite } = getTestDb();
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-orch-selfreview";
const WORKER_ID = "orch-selfreview-worker";
const WORKER_MODEL = "provA:worker";
const STAMP = "2026-01-01T00:00:00.000Z";

const MEDIUM_TYPE = `orch--${PROFILE_ID}--medium`;

/** 派发侧发生的调用，供"到底有没有真的派/续跑"的断言使用。 */
const runCalls: Array<Record<string, unknown>> = [];
const resumeCalls: Array<Record<string, unknown>> = [];
let resumeOutput = "";

/** 一份能被 `parseOrchestrationReceipt` 认下的回执（判定 pass）。 */
const PASS_RECEIPT = [
	"done",
	"```json",
	JSON.stringify({
		verdict: "pass",
		changedFiles: ["server/lib/orchestration/review.ts"],
		testsRun: ["bun test"],
		notDone: [],
		confidence: "high",
		blockers: [],
	}),
	"```",
].join("\n");

const realSubagent = { ...(await import("@server/services/narrator-subagent")) };
mock.module("@server/services/narrator-subagent", () => ({
	...realSubagent,
	runSubagent: mock(async (input: Record<string, unknown>) => {
		runCalls.push(input);
		return "FRESH";
	}),
	resumeSubagent: mock(async (input: Record<string, unknown>) => {
		resumeCalls.push(input);
		return {
			started: true,
			resumedSuspendedRunner: false,
			originToolUseId: "origin-tool-use",
			terminalCompletion: Promise.resolve(resumeOutput),
		};
	}),
}));

// `runSelfReview` 自己的调用桩。断言必须落在"有没有被调用"上，而不是它内部的副作用：
// 内部副作用在替身环境里可能被绕过，而调用次数不会。
const reviewModule = await import("../../lib/orchestration/review");
const realRunSelfReview = reviewModule.runSelfReview;
const selfReviewCalls: Array<Record<string, unknown>> = [];
mock.module("@server/lib/orchestration/review", () => ({
	...reviewModule,
	runSelfReview: mock(async (input: Record<string, unknown>) => {
		selfReviewCalls.push(input);
		return realRunSelfReview(input as Parameters<typeof realRunSelfReview>[0]);
	}),
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

/** 方案允许自审（"允许"是本次改动的另一半：允许 ≠ 触发）。 */
function makeProfile(review: Partial<OrchestrationProfile["review"]> = {}): OrchestrationProfile {
	const tier = () =>
		({ pool: [{ model: WORKER_MODEL }] }) as unknown as OrchestrationProfile["tiers"]["chore"];
	return {
		id: PROFILE_ID,
		name: "测试方案",
		enabled: true,
		review: {
			selfReview: true,
			independentReview: false,
			reviewTier: "quick",
			maxReworkAttempts: 2,
			...review,
		},
		tiers: { chore: tier(), quick: tier(), medium: tier(), heavy: tier() },
	};
}

function applyProfile(review: Partial<OrchestrationProfile["review"]> = {}): void {
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile(review)],
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
 * `originToolCallId` 是 `resolveExecutorNarratorId` 的唯一线索（按 parent + 这次工具调用行
 * 反查执行者），自审要续跑的正是这一只，所以派发前必须先把它建好。
 */
async function insertWorker(subagentType: string): Promise<void> {
	await insertParent(PARENT_ID);
	await db
		.insert(narrators)
		.values({
			id: WORKER_ID,
			type: "subagent",
			variant: `subagent:${subagentType}`,
			subagentType,
			parentNarratorId: PARENT_ID,
			status: "working",
			originToolCallId: "tool-call-1",
			model: WORKER_MODEL,
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.onConflictDoNothing();
}

const CHORE_PROMPT =
	"run `bun test --isolate server/lib/orchestration/` and paste the failing names";

let originalOrchestration: OrchestrationSettings | undefined;

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	applyProfile();
	parking.__resetParkingRegistryForTests();
	runCalls.length = 0;
	resumeCalls.length = 0;
	selfReviewCalls.length = 0;
	resumeOutput = "";
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	cleanDb(sqlite);
});

afterAll(() => {
	mock.restore();
});

describe("默认不自审", () => {
	test("不传 self_review 时 runSelfReview 一次都不被调用，且文本如实标明未审", async () => {
		await insertWorker(MEDIUM_TYPE);

		const result = await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium" },
			contextOf(),
		);

		expect(result.isError).toBeUndefined();
		// 这就是这次改动的全部经济性主张：探查/实现类派发不再被无条件加一轮自审。
		expect(selfReviewCalls).toHaveLength(0);
		expect(resumeCalls).toHaveLength(0);
		// 没有自审不等于不写：编制者必须能区分"没审"与"审过了"。
		expect(result.output).toContain("**未执行**自审");
		expect(result.output).toContain("没有要求自审");
		expect(result.output).not.toContain("来自执行者收尾后跑的自审轮");
	});
});

describe("显式要求才自审", () => {
	test("self_review: true 且档位可写时跑一轮，续跑的是同一个执行者", async () => {
		await insertWorker(MEDIUM_TYPE);
		resumeOutput = PASS_RECEIPT;

		const result = await agentTool.execute(
			{
				description: "task",
				prompt: "删掉遗留的 migrate() 并更新调用点",
				tier: "medium",
				self_review: true,
			},
			contextOf(),
		);

		expect(result.isError).toBeUndefined();
		expect(selfReviewCalls).toHaveLength(1);
		// 自审必须续跑**这一次派发**的执行者，不能是别人、也不能是猜出来的 id。
		expect(selfReviewCalls[0].narratorId).toBe(WORKER_ID);
		expect(selfReviewCalls[0].tier).toBe("medium");
		expect(resumeCalls).toHaveLength(1);
		expect(result.output).toContain("自审轮");
		expect(result.output).not.toContain("**未执行**自审");
	});

	test("自审跑不起来（查不到执行者）时如实写「未经自审」，不留白", async () => {
		// 故意不插 worker 行：resolveExecutorNarratorId 返回 null，自审无从续跑。
		applyProfile();

		const result = await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium", self_review: true },
			contextOf(),
		);

		expect(result.isError).toBeUndefined();
		expect(selfReviewCalls).toHaveLength(0);
		expect(result.output).toContain("未经自审");
	});
});

describe("只读档位要自审被拒", () => {
	test("quick 与 chore 都在派发之前就被挡住，没有半个派发被建出来", async () => {
		for (const [tier, prompt] of [
			["quick", "看一下编排的自审是在哪里触发的"],
			["chore", CHORE_PROMPT],
		] as const) {
			const result = await agentTool.execute(
				{ description: "task", prompt, tier, self_review: true },
				contextOf(),
			);

			expect(result.isError).toBe(true);
			expect(result.output).toContain("不支持自审");
			expect(result.output).toContain(tier);
			// 只读 worker 没有改动可回看；拒绝之后不应留下任何执行痕迹。
			expect(runCalls).toHaveLength(0);
			expect(selfReviewCalls).toHaveLength(0);
			expect(resumeCalls).toHaveLength(0);
		}
	});
});

describe("方案开关与按需要求是两件事", () => {
	test("方案关闭自审时，显式要求也不跑，并且说明是方案关闭", async () => {
		applyProfile({ selfReview: false });
		await insertWorker(MEDIUM_TYPE);

		const result = await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium", self_review: true },
			contextOf(),
		);

		expect(result.isError).toBeUndefined();
		expect(selfReviewCalls).toHaveLength(0);
		// 与"这次没要求"必须说出不同的话：一个是配置定的，一个是它自己的选择。
		expect(result.output).toContain("关闭了自审");
		expect(result.output).not.toContain("没有要求自审");
	});
});

describe("独立复核不受 self_review 影响", () => {
	test("方案开着独立复核时，不要求自审也照样派复核者", async () => {
		applyProfile({ selfReview: true, independentReview: true });
		await insertWorker(MEDIUM_TYPE);

		const result = await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium" },
			contextOf(),
		);

		expect(result.isError).toBeUndefined();
		expect(selfReviewCalls).toHaveLength(0);
		// 执行者 + 复核者：把自审改成按需，不能顺手把独立复核也一起关掉。
		expect(runCalls).toHaveLength(2);
		expect(result.output).toContain("**未执行**自审");
		expect(result.output).not.toContain("关闭了独立复核");
	});

	test("要求自审时两条路径都在，各自如实标注", async () => {
		applyProfile({ selfReview: true, independentReview: true });
		await insertWorker(MEDIUM_TYPE);
		resumeOutput = PASS_RECEIPT;

		const result = await agentTool.execute(
			{ description: "task", prompt: "实现 X", tier: "medium", self_review: true },
			contextOf(),
		);

		expect(result.isError).toBeUndefined();
		expect(selfReviewCalls).toHaveLength(1);
		expect(runCalls).toHaveLength(2);
		expect(result.output).toContain("自审轮");
		expect(result.output).not.toContain("关闭了独立复核");
	});
});
