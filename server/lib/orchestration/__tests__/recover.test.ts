import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { narrators } from "../../../db/schema";
import type { OrchestrationProfile, OrchestrationSettings } from "../types";

/**
 * 「换模型继续」的单元测试。
 *
 * 用真实测试库：本模块要证明的核心事实全部与数据库有关——worker 归属、类型编码、
 * 当前状态、以及**落库的模型**。用桩替掉数据库就等于没测那几条。
 *
 * 只有两处替身：`resumeSubagent`（起一条真实 agent 循环不是这里的题目）与
 * `updateNarratorModel`（会去碰进程内会话注册表）。两者的调用顺序正是要断言的。
 */

const { db, sqlite } = getTestDb();
// 与 parking.test.ts 同理：不展开命名空间，避免实例化第二份 db 单例。
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "rev1kc9p";
const OTHER_PROFILE_ID = "oth9zz11";
const PARENT_ID = "parent-narrator";
const WORKER_ID = "orch-worker-1";
const REVIEWER_ID = "orch-reviewer-1";

/** 调用顺序账本：断言"先落库再续跑"靠它。 */
const callOrder: string[] = [];
const resumeCalls: Array<Record<string, unknown>> = [];
let resumeStarted = true;
let resumeShouldThrow: Error | null = null;

// 先替 @server/db（上一行），再加载真实模块——否则真实模块抓到的是生产库句柄。
const realResume = { ...(await import("@server/services/subagent-resume")) };
mock.module("@server/services/subagent-resume", () => ({
	...realResume,
	resumeSubagent: mock(async (input: Record<string, unknown>) => {
		callOrder.push("resumeSubagent");
		resumeCalls.push(input);
		if (resumeShouldThrow) throw resumeShouldThrow;
		return {
			started: resumeStarted,
			resumedSuspendedRunner: false,
			originToolUseId: "origin-tool-use",
		};
	}),
}));

const realSession = { ...(await import("@server/services/narrator-session")) };
mock.module("@server/services/narrator-session", () => ({
	...realSession,
	updateNarratorModel: mock((narratorId: string) => {
		callOrder.push(`updateNarratorModel:${narratorId}`);
	}),
}));

const { narratorService } = await import("@server/services/narrator-service");
const { settings } = await import("@server/lib/settings");
const { ValidationError } = await import("@server/lib/errors");
const { deleteNugCachedModels, setNugCachedModels } = await import("@server/lib/nug-model-cache");
const {
	createModelUnavailabilityProbe,
	isModelInTierPool,
	isOrchestrationWorkerType,
	isPoolFullyUnavailable,
	recoverOrchestrationWorker,
	resolveOrchestrationRecoverState,
	resolveOrchestrationWorkerScope,
	tierPoolModels,
} = await import("../recover");
const { buildReviewerSubagentType, buildOrchestrationType } = await import("../types");
const { parseModelFailureModel } = await import("@shared/orchestration-worker-type");

const QUICK_TYPE = buildOrchestrationType(PROFILE_ID, "quick");
const HEAVY_TYPE = buildOrchestrationType(PROFILE_ID, "heavy");
const REVIEWER_TYPE = buildReviewerSubagentType(PROFILE_ID, "quick");

let originalOrchestration: OrchestrationSettings | undefined;
let originalDisabledProviders: string[] | undefined;
let originalNugProviders: typeof settings.nugProviders;
let updateModelSpy: ReturnType<typeof spyOn>;
let updateStatusSpy: ReturnType<typeof spyOn>;

/** NUG 目录证据用的提供者：前缀参与模型值的解析，id 参与缓存查询。 */
const NUG_PROVIDER_ID = "nugtest1";
const NUG_PREFIX = "nugtest";

function makeProfile(): OrchestrationProfile {
	return {
		id: PROFILE_ID,
		name: "测试方案",
		enabled: true,
		review: {
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: {
			chore: { pool: [{ model: "provA:chore-model" }] },
			quick: { pool: [{ model: "provA:quick-a" }, { model: "provA:quick-b" }] },
			medium: { pool: [{ model: "provA:medium-model" }] },
			heavy: { pool: [{ model: "provA:heavy-model" }] },
		},
	};
}

/** 编制者：编排状态由 model 的哨兵承载，因此这里直接写哨兵值。 */
async function insertPrimary(input: { id?: string; model?: string } = {}): Promise<void> {
	const stamp = "2026-01-01T00:00:00.000Z";
	await db
		.insert(narrators)
		.values({
			id: input.id ?? PARENT_ID,
			type: "primary",
			variant: "primary",
			model: input.model ?? `__orch__:${PROFILE_ID}`,
			status: "working",
			createdAt: stamp,
			updatedAt: stamp,
		})
		.onConflictDoNothing();
}

async function insertWorker(input: {
	id: string;
	subagentType: string;
	status?: "idle" | "working" | "waiting" | "archived";
	substatus?: string[] | null;
	errorMessage?: string | null;
	parentNarratorId?: string | null;
	model?: string;
}): Promise<void> {
	const stamp = "2026-01-01T00:00:00.000Z";
	await db
		.insert(narrators)
		.values({
			id: input.id,
			type: "subagent",
			variant: `subagent:${input.subagentType}`,
			subagentType: input.subagentType,
			parentNarratorId: input.parentNarratorId === undefined ? PARENT_ID : input.parentNarratorId,
			status: input.status ?? "idle",
			model: input.model ?? "provA:quick-a",
			substatus: JSON.stringify(input.substatus ?? []),
			errorMessage: input.errorMessage ?? null,
			createdAt: stamp,
			updatedAt: stamp,
		})
		.onConflictDoNothing();
}

async function workerRow(id: string) {
	return await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
}

function recover(overrides: Record<string, unknown> = {}) {
	return recoverOrchestrationWorker({
		primaryNarratorId: PARENT_ID,
		workerNarratorId: WORKER_ID,
		model: "provA:quick-b",
		action: "continue",
		locale: "zh-CN",
		createdBy: "user-1",
		...overrides,
	} as Parameters<typeof recoverOrchestrationWorker>[0]);
}

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile()],
	};
	// 停用集合只影响"提供者被停用"这一条证据，显式清空让判定不受外部配置影响。
	originalDisabledProviders = settings.agent.disabledProviders;
	settings.agent.disabledProviders = [];
	originalNugProviders = settings.nugProviders;
	callOrder.length = 0;
	resumeCalls.length = 0;
	resumeStarted = true;
	resumeShouldThrow = null;
	// spyOn 而不是 mock.module：recover 动态 import 的就是同一个模块对象，
	// 替身能直接落在它调用的那个方法上，也不必连带替掉服务里别的东西。
	updateModelSpy = spyOn(narratorService, "updateModel").mockImplementation((async (
		id: string,
		model: string,
	) => {
		callOrder.push(`updateModel:${id}`);
		// 真实实现写的就是这一列；测试替身也要写，否则"续跑用的是新模型"这条
		// 断言会退化成"我被调用过"。
		await db
			.update(narrators)
			.set({ model, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, id));
	}) as never);
	updateStatusSpy = spyOn(narratorService, "updateStatus").mockImplementation((async (
		id: string,
		status: string,
	) => {
		callOrder.push(`updateStatus:${id}:${status}`);
		await db
			.update(narrators)
			.set({ status: status as "idle" | "working" | "waiting" | "archived" })
			.where(eq(narrators.id, id));
	}) as never);
});

afterEach(() => {
	updateModelSpy.mockRestore();
	updateStatusSpy.mockRestore();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	settings.agent.disabledProviders = originalDisabledProviders;
	settings.nugProviders = originalNugProviders;
	deleteNugCachedModels(NUG_PROVIDER_ID);
	cleanDb(sqlite);
});

/** 装上一个 NUG 提供者 + 它的目录缓存条目，用来验证"目录明确记着不可用"这条证据。 */
function installNugCatalog(models: Array<Record<string, unknown>>): void {
	settings.nugProviders = [
		{
			id: NUG_PROVIDER_ID,
			name: "测试 NUG",
			prefix: NUG_PREFIX,
			apiKey: "k",
			baseUrl: "http://127.0.0.1:1",
			defaultModel: "chan:model",
		},
	];
	setNugCachedModels(NUG_PROVIDER_ID, models);
}

afterAll(() => {
	mock.module("@server/services/subagent-resume", () => realResume);
	mock.module("@server/services/narrator-session", () => realSession);
	mock.restore();
});

describe("纯判定：类型编码与档位池", () => {
	test("执行者/复核者都能解析出档位，且必须属于本方案", () => {
		expect(resolveOrchestrationWorkerScope(QUICK_TYPE, PROFILE_ID)).toEqual({
			kind: "executor",
			profileId: PROFILE_ID,
			tier: "quick",
		});
		expect(resolveOrchestrationWorkerScope(REVIEWER_TYPE, PROFILE_ID)).toEqual({
			kind: "reviewer",
			profileId: PROFILE_ID,
			tier: "quick",
		});
		// 别的方案的 worker 不属于本编排：它的池与容量记账都是别人的。
		expect(resolveOrchestrationWorkerScope(QUICK_TYPE, OTHER_PROFILE_ID)).toBeNull();
		expect(resolveOrchestrationWorkerScope(REVIEWER_TYPE, OTHER_PROFILE_ID)).toBeNull();
		// 非编排类型一律拒绝（普通子代理不能被"救活"）。
		expect(resolveOrchestrationWorkerScope("explore", PROFILE_ID)).toBeNull();
		expect(resolveOrchestrationWorkerScope("general", PROFILE_ID)).toBeNull();
		expect(resolveOrchestrationWorkerScope(null, PROFILE_ID)).toBeNull();
		// 复核者类型不是合法的执行者类型，反向也必须不成立。
		expect(isOrchestrationWorkerType(REVIEWER_TYPE)).toBe(true);
		expect(isOrchestrationWorkerType(QUICK_TYPE)).toBe(true);
		expect(isOrchestrationWorkerType("reviewer")).toBe(false);
	});

	test("档位池按顺序列出模型，池外模型不算命中", () => {
		const profile = makeProfile();
		expect(tierPoolModels(profile, "quick")).toEqual(["provA:quick-a", "provA:quick-b"]);
		expect(isModelInTierPool(profile, "quick", "provA:quick-b")).toBe(true);
		// trim 后才能比较：只差空白不该被算成池外。
		expect(isModelInTierPool(profile, "quick", "  provA:quick-a ")).toBe(true);
		// 别的档位的模型不在本档位池内。
		expect(isModelInTierPool(profile, "quick", "provA:heavy-model")).toBe(false);
		expect(tierPoolModels({ tiers: { quick: { pool: "nope" } } }, "quick")).toEqual([]);
	});

	test("失败信封里的模型归因：只认三种模型级失败类型", () => {
		expect(
			parseModelFailureModel(JSON.stringify({ type: "model_unavailable", model: "provA:a" })),
		).toBe("provA:a");
		expect(
			parseModelFailureModel(JSON.stringify({ type: "quota_exhausted", model: " provA:b " })),
		).toBe("provA:b");
		expect(
			parseModelFailureModel(
				JSON.stringify({
					type: "kimi_quota_exhausted",
					reason: "wait-budget-spent",
					model: "nugX:c:m",
				}),
			),
		).toBe("nugX:c:m");
		// 纯文本错误（402 / 网络错误）没有归因，宁可不给证据。
		expect(parseModelFailureModel("Error: 402 insufficient balance")).toBeNull();
		// 别的信封类型即使带 model 字段也不认：它们不是"这个模型被拒"的证据。
		expect(
			parseModelFailureModel(JSON.stringify({ type: "payment_required", model: "provA:a" })),
		).toBeNull();
		expect(parseModelFailureModel(JSON.stringify({ type: "model_unavailable" }))).toBeNull();
		expect(
			parseModelFailureModel(JSON.stringify({ type: "model_unavailable", model: "  " })),
		).toBeNull();
		expect(parseModelFailureModel(null)).toBeNull();
		expect(parseModelFailureModel(undefined)).toBeNull();
		expect(parseModelFailureModel("[1,2]")).toBeNull();
	});

	test("可恢复状态：idle/archived/模型等待态放行，运行中与其它等待拒绝", () => {
		expect(resolveOrchestrationRecoverState({ status: "idle" })).toEqual({
			ok: true,
			mode: "resume",
		});
		expect(resolveOrchestrationRecoverState({ status: "idle", substatus: ["error"] })).toEqual({
			ok: true,
			mode: "resume",
		});
		expect(resolveOrchestrationRecoverState({ status: "archived" })).toEqual({
			ok: true,
			mode: "unarchive",
		});
		expect(
			resolveOrchestrationRecoverState({ status: "waiting", substatus: ["model_unavailable"] }),
		).toEqual({ ok: true, mode: "parked" });
		expect(
			resolveOrchestrationRecoverState({ status: "waiting", substatus: ["quota_exhausted"] }),
		).toEqual({ ok: true, mode: "parked" });
		// substatus 被覆盖时靠 errorMessage 信封兜底。
		expect(
			resolveOrchestrationRecoverState({
				status: "waiting",
				substatus: [],
				errorMessage: JSON.stringify({ type: "quota_exhausted", model: "provA:quick-a" }),
			}),
		).toEqual({ ok: true, mode: "parked" });
		// 权限等待不是模型等待：换模型对它没有帮助。
		expect(
			resolveOrchestrationRecoverState({ status: "waiting", substatus: ["permission"] }).ok,
		).toBe(false);
		// 正在生成的请求已经冻结了模型。
		expect(resolveOrchestrationRecoverState({ status: "working" }).ok).toBe(false);
		expect(resolveOrchestrationRecoverState({ status: "deleted" }).ok).toBe(false);
	});
});

describe("纯判定：池是否已经全不可用", () => {
	/** 三条证据各管一段前缀，方便分别构造"有证据 / 没证据"。 */
	function probe() {
		return createModelUnavailabilityProbe({
			isProviderDisabled: (model) => model.startsWith("disabled:"),
			isCatalogUnavailable: (model) => model === "nugX:chan:m",
			failedModel: "provB:failed",
		});
	}

	test("只有池内每个模型都有确定不可用的证据才算「满」", () => {
		expect(isPoolFullyUnavailable(["disabled:a", "disabled:b"], probe())).toBe(true);
		expect(isPoolFullyUnavailable(["nugX:chan:m"], probe())).toBe(true);
		expect(isPoolFullyUnavailable(["provB:failed"], probe())).toBe(true);
		// 三个来源混用也算：它们各自都是"确定不可用"。
		expect(isPoolFullyUnavailable(["disabled:a", "nugX:chan:m", "provB:failed"], probe())).toBe(
			true,
		);
	});

	test("池内只要有一个可用（或看不出来不可用）就判定为「没满」", () => {
		expect(isPoolFullyUnavailable(["disabled:a", "provA:ok"], probe())).toBe(false);
		expect(isPoolFullyUnavailable(["nugX:chan:m", "provA:ok"], probe())).toBe(false);
		// 顺序无关：可用的那个在第一位同样拦住放开。
		expect(isPoolFullyUnavailable(["provA:ok", "disabled:a"], probe())).toBe(false);
	});

	test("空池不是「满」：那是配置错误，保持既有的池为空报错路径", () => {
		expect(isPoolFullyUnavailable([], probe())).toBe(false);
		expect(isPoolFullyUnavailable([], createModelUnavailabilityProbe({}))).toBe(false);
	});

	test("证据缺失或查询失败一律判定为「没满」（保守）", () => {
		// 一个来源都没给：任何池都不算满。
		expect(isPoolFullyUnavailable(["provA:a", "provA:b"], createModelUnavailabilityProbe({}))).toBe(
			false,
		);
		// 查询抛错（坏配置）不能顺势放开池外，也不能把校验变成 500。
		const throwing = createModelUnavailabilityProbe({
			isProviderDisabled: () => {
				throw new Error("boom");
			},
			isCatalogUnavailable: () => {
				throw new Error("boom");
			},
		});
		expect(isPoolFullyUnavailable(["provA:a"], throwing)).toBe(false);
	});

	test("哨兵 / 聚合这类元引用不参与判定", () => {
		const sentinels = createModelUnavailabilityProbe({
			isProviderDisabled: () => true,
			isCatalogUnavailable: () => true,
		});
		// 元引用的可用性取决于解析结果，判定不到这一层；判错等于静默放开整个池。
		expect(isPoolFullyUnavailable(["__default__"], sentinels)).toBe(false);
		expect(isPoolFullyUnavailable(["__agg__:agg1"], sentinels)).toBe(false);
		// 空条目更是什么都说不了（真实的池在 tierPoolModels 里就已经滤掉了）。
		expect(isPoolFullyUnavailable(["  ", "disabled:a"], sentinels)).toBe(false);
		expect(isPoolFullyUnavailable(["disabled:a"], sentinels)).toBe(true);
	});
});

describe("recoverOrchestrationWorker — 校验", () => {
	test("非编排 primary 被拒绝", async () => {
		await insertPrimary({ id: "plain-primary", model: "provA:default" });
		await insertWorker({
			id: WORKER_ID,
			subagentType: QUICK_TYPE,
			parentNarratorId: "plain-primary",
		});
		await expect(recover({ primaryNarratorId: "plain-primary" })).rejects.toThrow(/不在编排模式下/);
		expect(resumeCalls).toHaveLength(0);
	});

	test("非本编排 worker 被拒绝（别的方案 / 别的父级 / 非编排类型）", async () => {
		await insertPrimary();
		// 别的方案的 worker
		await insertWorker({
			id: WORKER_ID,
			subagentType: buildOrchestrationType(OTHER_PROFILE_ID, "quick"),
		});
		await expect(recover()).rejects.toThrow(/不是本编排的执行者或复核者/);

		cleanDb(sqlite);
		await insertPrimary();
		// 别的父级的 worker：深层后代/邻居不能拿本编排的池去记账
		await insertWorker({ id: "other-parent", subagentType: "general", parentNarratorId: null });
		await insertWorker({
			id: WORKER_ID,
			subagentType: QUICK_TYPE,
			parentNarratorId: "other-parent",
		});
		await expect(recover()).rejects.toThrow(/不是此编排会话的直接子代/);

		cleanDb(sqlite);
		await insertPrimary();
		// 普通子代理（哪怕类型前缀撞了字母）
		await insertWorker({ id: WORKER_ID, subagentType: "explore" });
		await expect(recover()).rejects.toThrow(/不是本编排的执行者或复核者/);
		expect(resumeCalls).toHaveLength(0);
	});

	test("运行中拒绝：不写库也不续跑", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "working" });
		await expect(recover()).rejects.toThrow(/仍在运行中/);
		expect(callOrder).toEqual([]);
		expect(resumeCalls).toHaveLength(0);
	});

	test("池内仍有可用模型时，池外模型被拒绝并列出池内候选", async () => {
		await insertPrimary();
		// worker 停在配额等待态：这一次失败归因于 quick-a，而池里的 quick-b 毫无
		// 证据说明它不可用 → 仍然按池拒绝（放开池外只在池"满"时才发生）。
		await insertWorker({
			id: WORKER_ID,
			subagentType: QUICK_TYPE,
			status: "waiting",
			substatus: ["quota_exhausted"],
			errorMessage: JSON.stringify({ type: "quota_exhausted", model: "provA:quick-a" }),
		});
		// 断言语义随文案变化而更新：新文案要把"为什么拒绝"讲清楚（池内仍有可用的，
		// 请从池中选择），因此这里跟上新的措辞，断言本身（拒绝 + 列出候选）不变。
		await expect(recover({ model: "provA:heavy-model" })).rejects.toThrow(
			/不在该 worker 的 quick 档位池内，池内仍有可用模型，请从池中选择：provA:quick-a、provA:quick-b/,
		);
		// 拒绝发生在写入之前。
		expect(callOrder).toEqual([]);
		expect(resumeCalls).toHaveLength(0);
	});

	test("复核者用它自己的档位池（quick），执行者的 heavy 池也各自成立", async () => {
		await insertPrimary();
		await insertWorker({ id: REVIEWER_ID, subagentType: REVIEWER_TYPE });
		await expect(
			recover({ workerNarratorId: REVIEWER_ID, model: "provA:medium-model" }),
		).rejects.toThrow(/quick 档位池内/);

		cleanDb(sqlite);
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: HEAVY_TYPE });
		await expect(recover({ model: "provA:quick-a" })).rejects.toThrow(/heavy 档位池内/);
	});

	test("空池仍然报配置错误，不被当作「池满」而放开", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [{ ...makeProfile(), tiers: { ...makeProfile().tiers, quick: { pool: [] } } }],
		};
		await expect(recover({ model: "provB:anything" })).rejects.toThrow(
			/该 worker 的 quick 档位没有配置任何模型，请先在编排方案里补上/,
		);
		expect(callOrder).toEqual([]);
	});

	test("空 body 字段被拒绝", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });
		await expect(recover({ workerNarratorId: "   " })).rejects.toThrow(ValidationError);
		await expect(recover({ model: "  " })).rejects.toThrow(ValidationError);
	});

	test("续跑没起来时如实报错", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });
		resumeStarted = false;
		await expect(recover()).rejects.toThrow(/没能开始续跑/);
	});
});

describe("recoverOrchestrationWorker — 池满时放开池外", () => {
	test("池内模型全部在 NUG 目录里标记为不可用时，池外目标被接受并带 outOfPool", async () => {
		await insertPrimary();
		// heavy 池只有一个模型；它就是目录里被标为不可用的那一个。
		installNugCatalog([{ id: "chan:heavy", channel: "chan", model: "heavy", available: false }]);
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [
				{
					...makeProfile(),
					tiers: {
						...makeProfile().tiers,
						heavy: { pool: [{ model: `${NUG_PREFIX}:chan:heavy` }] },
					},
				},
			],
		};
		await insertWorker({ id: WORKER_ID, subagentType: HEAVY_TYPE });

		const outcome = await recover({ model: "provB:rescue" });

		expect(outcome).toMatchObject({
			ok: true,
			model: "provB:rescue",
			tier: "heavy",
			outOfPool: true,
			tierPool: [`${NUG_PREFIX}:chan:heavy`],
		});
		// 放开的判定不改变写入顺序：仍然先落库再续跑。
		expect(callOrder).toEqual([
			`updateModel:${WORKER_ID}`,
			`updateNarratorModel:${WORKER_ID}`,
			"resumeSubagent",
		]);
		expect((await workerRow(WORKER_ID))?.model).toBe("provB:rescue");
	});

	test("池内模型全被停用时，池外目标被接受", async () => {
		await insertPrimary();
		settings.agent.disabledProviders = ["provA"];
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });

		const outcome = await recover({ model: "provB:rescue" });

		expect(outcome).toMatchObject({
			outOfPool: true,
			tierPool: ["provA:quick-a", "provA:quick-b"],
		});
	});

	test("失败归因的模型覆盖整个池时（非 NUG 提供者的配额墙）放开", async () => {
		await insertPrimary();
		// heavy 池只有一个模型，正是这次被拒的那一个：这是配额墙唯一能留下的证据，
		// 目录标记对它完全不会出现。
		await insertWorker({
			id: WORKER_ID,
			subagentType: HEAVY_TYPE,
			status: "waiting",
			substatus: ["quota_exhausted"],
			errorMessage: JSON.stringify({ type: "quota_exhausted", model: "provA:heavy-model" }),
		});

		const outcome = await recover({ model: "provB:rescue" });

		expect(outcome).toMatchObject({ outOfPool: true, continuation: "in_place" });
		// 等待态只写模型，不续跑（活着的 turn 自己会用新模型重发）。
		expect(callOrder).toEqual([`updateModel:${WORKER_ID}`, `updateNarratorModel:${WORKER_ID}`]);
		expect(resumeCalls).toHaveLength(0);
	});

	test("池内目标照旧：行为不变且 outOfPool 为 false", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });

		const outcome = await recover({ model: "provA:quick-b" });

		expect(outcome).toMatchObject({
			outOfPool: false,
			tierPool: ["provA:quick-a", "provA:quick-b"],
		});
	});

	test("池内仍有一个「没有证据」的模型时不放开：目标必须是池内那个", async () => {
		await insertPrimary();
		// 池里两个模型：一个被目录标为不可用（也正是这次失败归因的那个），另一个
		// 毫无证据。少了任何一条证据池就不算满，池外目标仍然被拒。
		installNugCatalog([
			{ id: "chan:quick-a", channel: "chan", model: "quick-a", available: false },
		]);
		await insertWorker({
			id: WORKER_ID,
			subagentType: QUICK_TYPE,
			status: "waiting",
			substatus: ["model_unavailable"],
			errorMessage: JSON.stringify({
				type: "model_unavailable",
				model: `${NUG_PREFIX}:chan:quick-a`,
			}),
		});
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [
				{
					...makeProfile(),
					tiers: {
						...makeProfile().tiers,
						quick: { pool: [{ model: `${NUG_PREFIX}:chan:quick-a` }, { model: "provA:quick-b" }] },
					},
				},
			],
		};

		await expect(recover({ model: "provB:rescue" })).rejects.toThrow(/池内仍有可用模型/);
		expect(resumeCalls).toHaveLength(0);
		// 池内那个"没有证据"的模型照旧可以直接换过去。
		const outcome = await recover({ model: "provA:quick-b" });
		expect(outcome).toMatchObject({ outOfPool: false, model: "provA:quick-b" });
	});
});

describe("recoverOrchestrationWorker — 写入顺序与生效模型", () => {
	test("先落库再续跑，且顺序是 updateModel → updateNarratorModel → resumeSubagent", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "idle" });

		const outcome = await recover();

		expect(outcome).toMatchObject({
			ok: true,
			workerNarratorId: WORKER_ID,
			model: "provA:quick-b",
			tier: "quick",
			kind: "executor",
			continuation: "restarted",
		});
		expect(callOrder).toEqual([
			`updateModel:${WORKER_ID}`,
			`updateNarratorModel:${WORKER_ID}`,
			"resumeSubagent",
		]);
		// resumeSubagent 没有 model 参数：换的模型必须已经在库里，否则续跑用的还是旧模型。
		expect(resumeCalls[0]).toMatchObject({
			subagentId: WORKER_ID,
			intent: "continue_tool_results",
			actor: "user",
			createdBy: "user-1",
			locale: "zh-CN",
		});
		expect("model" in (resumeCalls[0] ?? {})).toBe(false);
	});

	test("archived worker 先解除归档到 idle 再续跑", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });

		await recover();

		expect(callOrder).toEqual([
			`updateModel:${WORKER_ID}`,
			`updateStatus:${WORKER_ID}:idle`,
			`updateNarratorModel:${WORKER_ID}`,
			"resumeSubagent",
		]);
		expect((await workerRow(WORKER_ID))?.status).toBe("idle");
	});

	test("标了 retry 时改用 retry_last_input", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE });
		await recover({ action: "retry" });
		expect(resumeCalls[0]).toMatchObject({ intent: "retry_last_input" });
	});

	test("续跑解析到的模型就是换上的新模型", async () => {
		await insertPrimary();
		await insertWorker({ id: WORKER_ID, subagentType: QUICK_TYPE, model: "provA:quick-a" });

		await recover({ model: "provA:quick-b" });

		// 1) 库里确实是新模型
		expect((await workerRow(WORKER_ID))?.model).toBe("provA:quick-b");
		// 2) 而 resumeSubagent 只认 DB 行 → 用真实解析函数走一遍，确认它拿到新模型
		const { resolveSubagentModelForRun } = await import("@server/services/subagent-model");
		const row = await workerRow(WORKER_ID);
		const resolved = await resolveSubagentModelForRun(
			{
				model: row?.model ?? null,
				parentNarratorId: row?.parentNarratorId ?? null,
				subagentType: row?.subagentType ?? null,
			},
			"user-1",
		);
		expect(resolved.modelRef).toBe("provA:quick-b");
	});

	test("等待态只写模型：不续跑，因为活着的那个 turn 会自己接着跑", async () => {
		await insertPrimary();
		await insertWorker({
			id: WORKER_ID,
			subagentType: QUICK_TYPE,
			status: "waiting",
			substatus: ["quota_exhausted"],
			errorMessage: JSON.stringify({ type: "quota_exhausted", model: "provA:quick-a" }),
		});

		const outcome = await recover();

		expect(outcome.continuation).toBe("in_place");
		expect(callOrder).toEqual([`updateModel:${WORKER_ID}`, `updateNarratorModel:${WORKER_ID}`]);
		expect(resumeCalls).toHaveLength(0);
		// 状态没有被改写：取消等待是 updateNarratorModel 的职责，不在这一层。
		expect((await workerRow(WORKER_ID))?.status).toBe("waiting");
	});
});
