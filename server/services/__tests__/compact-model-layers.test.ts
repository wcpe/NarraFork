/**
 * compact-model-layers.test.ts — 压缩到底用哪个模型。
 *
 * 用户实机遇到的"上下文爆掉"发生在**会话自己的模型**上，因此压缩的顺序改为：
 * 显式 override → 会话自己的模型 → `settings.agent.summaryModel`（回落）。
 * 本文件锁住四件事：
 *
 * 1. 默认用会话自己的模型（而不是固定用 summaryModel）；
 * 2. 只有第一层失败才回落，且**只回落一次**（不递归、不循环）；
 * 3. 成功路径**不**多发一次回落调用（回落是兜底，不是每次都付的税）；
 * 4. 归属可观测 —— 记录里能看出这一层是会话模型还是回落模型。
 *
 * 另外锁住两条边界：哨兵模型必须被解析成真实模型（不能原样发给 provider），
 * 取消/超时中止不得触发回落（那次运行正在被拆解，再发一次只会拖住它）。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { chapters, narratorMessages, narrators, projects } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
let broadcasts: Array<Record<string, unknown>> = [];
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: (_narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push(message);
	},
}));

const { logger } = await import("../../lib/logger");
const { settings } = await import("../../lib/settings");
const { narratorContext } = await import("../narrator-context");
const { compactLocks, runCustomCompact } = await import("../narrator-compact");
const { resolveCompactModelLayers } = await import("../compact-model-selection");

const NARRATOR_ID = "n-compact-model";
const SESSION_MODEL = "provA:session";
const SUMMARY_MODEL = "provS:summary";

const realGenerateCompactSummary = narratorContext.generateCompactSummary.bind(narratorContext);
const realLoggerInfo = logger.info;
const realLoggerWarn = logger.warn;

/** 实际发给"摘要模型"的模型序列 —— 断言回落次数就看它。 */
let summaryModels: Array<string | undefined> = [];
let infoLogs: Array<{ msg: string; data: Record<string, unknown> }> = [];

/**
 * 按调用序号决定每次摘要请求的结果。
 * `attempt` 从 0 开始（第 1 次调用是 0）。
 */
function stubSummary(behavior: (attempt: number) => "ok" | "fail" | "abort"): void {
	summaryModels = [];
	narratorContext.generateCompactSummary = ((
		_narratorId: string,
		_locale: string,
		_messages?: unknown,
		_signal?: AbortSignal,
		modelOverride?: string,
	) => {
		const attempt = summaryModels.length;
		summaryModels.push(modelOverride);
		const outcome = behavior(attempt);
		if (outcome === "abort") {
			return Promise.reject(new DOMException("Compact summary aborted", "AbortError"));
		}
		if (outcome === "fail") return Promise.reject(new Error(`boom-${attempt}`));
		return Promise.resolve({ summary: `summary-${attempt}`, contextPercent: 42 });
	}) as typeof narratorContext.generateCompactSummary;
}

function seed(model: string | null): void {
	const now = new Date().toISOString();
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter",
			branch: "chapter/ch1",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: NARRATOR_ID,
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			model,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "m-before",
			narratorId: NARRATOR_ID,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
			contentText: "before",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "m-target",
			narratorId: NARRATOR_ID,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
			createdAt: now,
		})
		.run();
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('r1', ?, 'm-before', 0), ('r2', ?, 'm-target', 1)",
		[NARRATOR_ID, NARRATOR_ID],
	);
}

/** 读取压缩标记里的 attempts（归属在这里可观测）。 */
interface RecordedAttempt {
	attempt: number;
	model: string;
	status: string;
	error?: string;
}

function readAttempts(): RecordedAttempt[] {
	const rows = db
		.select()
		.from(narratorMessages)
		.where(and(eq(narratorMessages.narratorId, NARRATOR_ID), eq(narratorMessages.role, "system")))
		.all();
	const blocks = Array.isArray(rows.at(-1)?.contentJson)
		? (rows.at(-1)?.contentJson as Array<{ attempts?: RecordedAttempt[] }>)
		: [];
	return blocks.at(0)?.attempts ?? [];
}

function findInfo(msg: string): Record<string, unknown> | undefined {
	return infoLogs.find((entry) => entry.msg === msg)?.data;
}

const originalSummaryModel = settings.agent.summaryModel;
const originalDefaultModel = settings.agent.defaultModel;
const originalOrchestration = settings.agent.orchestration;

beforeEach(() => {
	cleanDb(sqlite);
	compactLocks.clear();
	broadcasts = [];
	infoLogs = [];
	summaryModels = [];
	settings.agent.summaryModel = SUMMARY_MODEL;
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
	logger.info = ((msg: string, data?: Record<string, unknown>) => {
		infoLogs.push({ msg, data: data ?? {} });
	}) as typeof logger.info;
	logger.warn = (() => {}) as typeof logger.warn;
});

afterEach(() => {
	settings.agent.summaryModel = originalSummaryModel;
	settings.agent.defaultModel = originalDefaultModel;
	settings.agent.orchestration = originalOrchestration;
});

afterAll(() => {
	narratorContext.generateCompactSummary = realGenerateCompactSummary;
	logger.info = realLoggerInfo;
	logger.warn = realLoggerWarn;
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
});

describe("压缩模型分层", () => {
	test("无 override 时用会话自己的模型，而不是 summaryModel", async () => {
		seed(SESSION_MODEL);
		stubSummary(() => "ok");

		await runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });

		// 只发了一次请求，且用的是会话模型。
		expect(summaryModels).toEqual([SESSION_MODEL]);
		expect(summaryModels).not.toContain(SUMMARY_MODEL);
		expect(findInfo("Starting custom compact")?.modelSource).toBe("session");
		expect(findInfo("Custom compact completed")).toMatchObject({
			model: SESSION_MODEL,
			modelLayer: "primary",
			primaryModel: SESSION_MODEL,
		});
	});

	test("会话模型失败后用 summaryModel 再试一次，且只再试一次", async () => {
		seed(SESSION_MODEL);
		stubSummary((attempt) => (attempt === 0 ? "fail" : "ok"));

		const compacted = await runCustomCompact(NARRATOR_ID, "en", "m-target", {
			mode: "background",
		});

		expect(compacted).toBe(true);
		// 长度恰好 2：没有第三次（不递归、不循环）。
		expect(summaryModels).toEqual([SESSION_MODEL, SUMMARY_MODEL]);
		expect(findInfo("Custom compact completed")).toMatchObject({
			model: SUMMARY_MODEL,
			modelLayer: "fallback",
			primaryModel: SESSION_MODEL,
		});
	});

	test("回落会写进压缩记录：两次尝试的模型与失败原因都留着", async () => {
		seed(SESSION_MODEL);
		stubSummary((attempt) => (attempt === 0 ? "fail" : "ok"));

		await runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });

		const attempts = readAttempts();
		expect(attempts.map((a) => [a.attempt, a.model, a.status])).toEqual([
			[1, SESSION_MODEL, "failed"],
			[2, SUMMARY_MODEL, "completed"],
		]);
		// 第一层失败的原因留在记录里，回落成功不会把它抹掉。
		expect(attempts[0]?.error).toBe("boom-0");
	});

	test("两层都失败时不再试第三次，错误里带上两层", async () => {
		seed(SESSION_MODEL);
		stubSummary(() => "fail");

		const promise = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });
		await expect(promise).rejects.toThrow(/both models/);
		await expect(promise).rejects.toThrow(/boom-0/);
		await expect(promise).rejects.toThrow(/boom-1/);

		expect(summaryModels).toEqual([SESSION_MODEL, SUMMARY_MODEL]);
		const attempts = readAttempts();
		expect(attempts.map((a) => [a.attempt, a.model, a.status])).toEqual([
			[1, SESSION_MODEL, "failed"],
			[2, SUMMARY_MODEL, "failed"],
		]);
		// 失败上报的既有语义没被绕开：卡片仍能拿到两层的原因。
		const failed = broadcasts.find((event) => event.type === "compact_failed");
		expect(String(failed?.error)).toContain(SESSION_MODEL);
		expect(String(failed?.error)).toContain(SUMMARY_MODEL);
	});

	test("显式 override 压过会话模型；它失败时仍然回落到 summaryModel", async () => {
		seed(SESSION_MODEL);
		stubSummary((attempt) => (attempt === 0 ? "fail" : "ok"));

		await runCustomCompact(NARRATOR_ID, "en", "m-target", {
			mode: "background",
			model: "provX:override",
		});

		expect(summaryModels).toEqual(["provX:override", SUMMARY_MODEL]);
		expect(summaryModels).not.toContain(SESSION_MODEL);
		expect(findInfo("Starting custom compact")?.modelSource).toBe("explicit");
	});

	test("会话模型不可用时退化为 summaryModel，且不做重复的第二次", async () => {
		// 会话没有模型、默认模型也未配置 → 会话模型解析不出来（这里把默认模型
		// 显式置空，让断言不依赖跑测试那台机器上的 settings.json）。
		settings.agent.defaultModel = "";
		seed(null);
		stubSummary((attempt) => (attempt === 0 ? "fail" : "ok"));

		// 第一层就是 summaryModel，因此没有可回落的第二层。
		const promise = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });
		await expect(promise).rejects.toThrow(/boom-0/);

		expect(summaryModels).toEqual([SUMMARY_MODEL]);
	});

	test("取消/中止不触发回落（那次运行正在被拆解）", async () => {
		seed(SESSION_MODEL);
		stubSummary(() => "abort");

		const promise = runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });

		expect(summaryModels).toEqual([SESSION_MODEL]);
	});
});

describe("会话模型哨兵解析", () => {
	test("__default__ 解析成配置的默认模型，不把哨兵发出去", async () => {
		settings.agent.defaultModel = "provD:default";
		seed("__default__");
		stubSummary(() => "ok");

		await runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });

		expect(summaryModels).toEqual(["provD:default"]);
		expect(summaryModels.some((model) => String(model).startsWith("__"))).toBe(false);
	});

	test("__orch__:<profileId> 解析成编制者的实际模型", async () => {
		const profileId = "of7k2m9q";
		settings.agent.orchestration = {
			orchestratorModels: ["provO:orchestrator"],
			profiles: [
				{
					id: profileId,
					name: "测试方案",
					enabled: true,
					review: {
						selfReview: true,
						independentReview: true,
						reviewTier: "quick",
						maxReworkAttempts: 2,
					},
					tiers: {
						chore: { pool: [{ model: "provA:worker" }] },
						quick: { pool: [{ model: "provA:worker" }] },
						medium: { pool: [{ model: "provA:worker" }] },
						heavy: { pool: [{ model: "provA:worker" }] },
					},
				},
			],
		} as unknown as typeof settings.agent.orchestration;
		seed(`__orch__:${profileId}`);
		stubSummary(() => "ok");

		const layers = await resolveCompactModelLayers(NARRATOR_ID);
		expect(layers.primary.model).toBe("provO:orchestrator");

		await runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });
		expect(summaryModels).toEqual(["provO:orchestrator"]);
	});

	test("哨兵解析失败时退化为 summaryModel，而不是让压缩整体失败", async () => {
		// 方案不存在：resolveEffectiveModel 会抛错，压缩不该因此压不动上下文。
		settings.agent.orchestration = {
			orchestratorModels: ["provO:orchestrator"],
			profiles: [],
		} as unknown as typeof settings.agent.orchestration;
		seed("__orch__:missing");
		stubSummary(() => "ok");

		await runCustomCompact(NARRATOR_ID, "en", "m-target", { mode: "background" });

		expect(summaryModels).toEqual([SUMMARY_MODEL]);
	});
});

describe("resolveCompactModelLayers 的分层结果", () => {
	test("三层优先级：override > 会话模型 > summaryModel", async () => {
		seed(SESSION_MODEL);
		expect(await resolveCompactModelLayers(NARRATOR_ID)).toEqual({
			primary: { model: SESSION_MODEL, source: "session" },
			fallback: { model: SUMMARY_MODEL },
		});
		expect(await resolveCompactModelLayers(NARRATOR_ID, "provX:override")).toEqual({
			primary: { model: "provX:override", source: "explicit" },
			fallback: { model: SUMMARY_MODEL },
		});
	});

	test("会话模型与 summaryModel 相同时不提供回落层", async () => {
		seed(SUMMARY_MODEL);
		expect(await resolveCompactModelLayers(NARRATOR_ID)).toEqual({
			primary: { model: SUMMARY_MODEL, source: "session" },
		});
	});
});
