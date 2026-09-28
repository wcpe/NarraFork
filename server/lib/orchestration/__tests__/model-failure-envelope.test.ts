/**
 * 模型级失败信封必须活到「换模型继续」读它的那一刻。
 *
 * `errorMessage` 是这类失败**唯一的载体**（`errorCode` / `diagnostics` 都不落库），
 * 而写入方有两个：orchestrator 先写结构化信封（配额墙 / 模型不可用 / 余额不足），
 * 子代理到达终态时 `finalizeSubagent` 再写一句人类可读的纯文本（错误卡片的正文，
 * 不能取消）。后者无条件覆盖前者，于是"是哪一次请求被哪个模型拒了"这条第一手证据
 * 就此消失——`parseModelFailureModel` 只认信封，`isTierPoolFullyUnavailable` 随即
 * 退化成只剩"提供者停用 / NUG 目录不可用"，而"池里全是同一个用尽的计划"这种最该
 * 放开池外的场景反而**永远不放开**，用户被锁在必然失败的池内选项里。
 *
 * 本文件按真实顺序验证：先让 orchestrator 写过的信封躺在行里，再跑真实的
 * `finalizeSubagent`，再看它有没有被抹掉，最后一路走到 `recoverOrchestrationWorker`。
 *
 * 替身只有一处：`updateNarratorModel`（它会去碰进程内会话注册表，与本题无关）。
 * `finalizeSubagent`、`narratorService.updateStatus`、`isTierPoolFullyUnavailable`
 * 与 `recoverOrchestrationWorker` 全部走真实实现。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { KIMI_QUOTA_EXHAUSTED } from "@shared/agent-protocol/quota-exhausted";
import { parseModelFailureModel } from "@shared/orchestration-worker-type";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { narrators } from "../../../db/schema";
import type { OrchestrationProfile, OrchestrationSettings } from "../types";

const { db, sqlite } = getTestDb();
// 只取 `db` / `sqlite`，不展开命名空间：避免实例化第二份 db 单例。
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const realSession = { ...(await import("@server/services/narrator-session")) };
mock.module("@server/services/narrator-session", () => ({
	...realSession,
	updateNarratorModel: () => {},
}));

const resumeCalls: Array<Record<string, unknown>> = [];
mock.module("@server/services/subagent-resume", () => ({
	resumeSubagent: async (input: Record<string, unknown>) => {
		resumeCalls.push(input);
		return { started: true, resumedSuspendedRunner: false, originToolUseId: "origin-tool-use" };
	},
}));

const { finalizeSubagent } = await import("@server/services/subagent-executor");
const { settings } = await import("@server/lib/settings");
const { isTierPoolFullyUnavailable, recoverOrchestrationWorker } = await import("../recover");
const { buildOrchestrationType } = await import("../types");

const PROFILE_ID = "env1kq7d";
const PARENT_ID = "parent-orch-envelope";
const WORKER_ID = "orch-envelope-worker";
const HEAVY_TYPE = buildOrchestrationType(PROFILE_ID, "heavy");
const STAMP = "2026-01-01T00:00:00.000Z";
/** 编排状态由 primary 的 model 哨兵承载。 */
const ORCHESTRATOR_MODEL = `__orch__:${PROFILE_ID}`;
/** 池里唯一的模型：非 NUG 提供者，配额墙只以"一次被拒的请求"留下证据。 */
const POOL_MODEL = "kimik:plan-model";
const PLAIN_TEXT = "Kimi 配额已用尽，本次任务未能完成";

const QUOTA_ENVELOPE = JSON.stringify({
	type: KIMI_QUOTA_EXHAUSTED,
	reason: "reset-beyond-budget",
	model: POOL_MODEL,
	provider: "kimik",
	providerPrefix: "kimik",
	quotaResetAt: null,
});

const PAYMENT_ENVELOPE = JSON.stringify({
	type: "payment_required",
	providerId: "provA",
	providerPrefix: "provA",
	balance: 0,
	required: 1,
});

let originalOrchestration: OrchestrationSettings | undefined;
let originalDisabledProviders: string[] | undefined;

function makeProfile(): OrchestrationProfile {
	const tier = () => ({ pool: [{ model: "provA:pool-model" }] });
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
		// heavy 档只有一个模型，且正是这次被配额墙拒掉的那一个。
		tiers: {
			chore: tier(),
			quick: tier(),
			medium: tier(),
			heavy: { pool: [{ model: POOL_MODEL }] },
		},
	};
}

async function insertPrimary(): Promise<void> {
	await db
		.insert(narrators)
		.values({
			id: PARENT_ID,
			type: "primary",
			variant: "primary",
			model: ORCHESTRATOR_MODEL,
			status: "working",
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.onConflictDoNothing();
}

async function insertWorker(input: {
	status: "idle" | "working" | "waiting" | "archived";
	errorMessage?: string | null;
}): Promise<void> {
	await insertPrimary();
	await db.insert(narrators).values({
		id: WORKER_ID,
		type: "subagent",
		variant: `subagent:${HEAVY_TYPE}`,
		subagentType: HEAVY_TYPE,
		parentNarratorId: PARENT_ID,
		status: input.status,
		substatus: JSON.stringify([]),
		errorMessage: input.errorMessage ?? null,
		model: POOL_MODEL,
		createdAt: STAMP,
		updatedAt: STAMP,
	});
}

async function workerRow(id: string) {
	return await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
}

async function substatusOf(id: string): Promise<string[]> {
	const row = await workerRow(id);
	return row?.substatus ? (JSON.parse(row.substatus) as string[]) : [];
}

/** 真实的终态写入：子代理跑到终态时就是这么被收尾的。 */
function terminate(hasError: boolean, errorText: string | null): Promise<void> {
	return finalizeSubagent(WORKER_ID, PARENT_ID, "tool-use-1", hasError, errorText);
}

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile()],
	};
	// 停用集合会影响"提供者被停用"这条证据：显式清空，让判定只能靠失败归因。
	originalDisabledProviders = settings.agent.disabledProviders;
	settings.agent.disabledProviders = [];
	resumeCalls.length = 0;
});

afterEach(() => {
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	settings.agent.disabledProviders = originalDisabledProviders;
	cleanDb(sqlite);
});

afterAll(() => {
	// 替身不用还原：`--isolate` 下每个测试文件一份模块注册表，它们不会外溢。
	mock.restore();
});

describe("终态写入不覆盖模型级失败信封（B5）", () => {
	test("配额墙信封在终态写入后原样保留，且仍能被解析出 model", async () => {
		await insertWorker({ status: "working", errorMessage: QUOTA_ENVELOPE });

		await terminate(true, PLAIN_TEXT);

		const row = await workerRow(WORKER_ID);
		// 没有被换成那句纯文本。
		expect(row?.errorMessage).toBe(QUOTA_ENVELOPE);
		expect(parseModelFailureModel(row?.errorMessage)).toBe(POOL_MODEL);
		// 它仍然是"出错了"这一次终态：保留的是载体，不是状态。
		expect(row?.status).toBe("idle");
		expect(await substatusOf(WORKER_ID)).toContain("error");
	});

	test("余额不足（payment_required）信封同样不被覆盖", async () => {
		await insertWorker({ status: "working", errorMessage: PAYMENT_ENVELOPE });

		await terminate(true, "Error: 余额不足");

		const row = await workerRow(WORKER_ID);
		expect(JSON.parse(row?.errorMessage ?? "{}")).toMatchObject({ type: "payment_required" });
	});

	test("没有信封时照旧写纯文本：错误卡片的正文不能消失", async () => {
		await insertWorker({ status: "working", errorMessage: null });

		await terminate(true, "Subagent error: boom");

		const row = await workerRow(WORKER_ID);
		expect(row?.errorMessage).toBe("Subagent error: boom");
		expect(parseModelFailureModel(row?.errorMessage)).toBeNull();
	});

	test("已有的纯文本会被新的纯文本覆盖（保留只针对结构化信封）", async () => {
		await insertWorker({ status: "working", errorMessage: "old plain failure" });

		await terminate(true, "new plain failure");

		expect((await workerRow(WORKER_ID))?.errorMessage).toBe("new plain failure");
	});

	test("非失败的终态不会顺手把信封留下", async () => {
		await insertWorker({ status: "working", errorMessage: QUOTA_ENVELOPE });

		await terminate(false, null);

		// 成功收尾照旧清空：这里不能被"保留"逻辑牵连。
		expect((await workerRow(WORKER_ID))?.errorMessage).toBeNull();
		expect(await substatusOf(WORKER_ID)).not.toContain("error");
	});
});

describe("池因配额全不可用 → 放开池外（B5 端到端）", () => {
	test("池内唯一的模型正是失败归因的那个：判定为「满」，恢复入口接受池外目标", async () => {
		// orchestrator 先写下信封（真实顺序），紧接着才是子代理的终态收尾。
		await insertWorker({ status: "working", errorMessage: QUOTA_ENVELOPE });
		await terminate(true, PLAIN_TEXT);

		const row = await workerRow(WORKER_ID);
		// 判定与恢复读的是同一列。
		expect(isTierPoolFullyUnavailable([POOL_MODEL], row?.errorMessage)).toBe(true);
		// 反证：这正是修复前的落库值（纯文本），判定会退化，池外目标被拒。
		expect(isTierPoolFullyUnavailable([POOL_MODEL], PLAIN_TEXT)).toBe(false);

		const outcome = await recoverOrchestrationWorker({
			primaryNarratorId: PARENT_ID,
			workerNarratorId: WORKER_ID,
			model: "provB:rescue",
			action: "continue",
			locale: "zh-CN",
		});

		expect(outcome).toMatchObject({
			ok: true,
			model: "provB:rescue",
			tier: "heavy",
			outOfPool: true,
			tierPool: [POOL_MODEL],
			continuation: "restarted",
		});
		expect(resumeCalls).toHaveLength(1);
	});
});
