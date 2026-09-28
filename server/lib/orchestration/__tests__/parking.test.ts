import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { narrators } from "../../../db/schema";
import type { ToolContext } from "../../agent/types";
// 只取类型：静态 import parking 模块会先于下面的 @server/db 替身执行，
// 那样 parking 拿到的就是真库句柄而不是测试库。
import type { ParkedWorker } from "../parking";
import { ORCHESTRATOR_TOOLS } from "../tier-definition";
import type { OrchestrationProfile, OrchestrationSettings } from "../types";
import { buildReviewerSubagentType, parseOrchestrationType } from "../types";

/**
 * 停放池的单元测试。
 *
 * 纯匹配部分是黑盒断言；登记簿/重建部分用真实的测试库（`getTestDb`）验证，因为
 * "哪些归档行能被认领"正是这个模块要解决的唯一问题，用桩替掉数据库就等于没测。
 */

const { db, sqlite } = getTestDb();
// 只用 `db` / `sqlite` 两个句柄就够了：本模块与它动态加载的服务都只从 @server/db 取这两个。
// 这里刻意不 `import("@server/db")` 再展开命名空间——那会实例化第二份 db 单例，
// 与本文件用的测试库不是同一个连接。
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-narrator";
const OTHER_PARENT_ID = "other-parent";
const WORKER_ID = "orch-worker-1";
const QUICK_TYPE = `orch--${PROFILE_ID}--quick`;
const MEDIUM_TYPE = `orch--${PROFILE_ID}--medium`;
const HEAVY_TYPE = `orch--${PROFILE_ID}--heavy`;

/**
 * 阶段 5 的用例要把自审**要出来**：自审现在默认不跑，而这一组验的是
 * 「执行者 → 自审 → 独立复核」这条缝本身，不是"要不要自审"。
 *
 * 档位用的是 medium 而不是 quick：只读档位根本不接受自审（quick/chore 上要自审
 * 会被派发侧直接拒掉），那是另一条独立的规则，由
 * `services/__tests__/orchestration-self-review-optin.test.ts` 钉住。
 */
const SELF_REVIEWED_DISPATCH = { tier: "medium", self_review: true } as const;

const runCalls: Array<Record<string, unknown>> = [];
const resumeCalls: Array<Record<string, unknown>> = [];
let resumeShouldFail = false;
/** 自审轮的终态输出；阶段 5 的用例要能按轮次换掉它。 */
let resumeOutput = "";
/** 每次 `runSubagent` 的输出；阶段 5 的用例要能按轮次换掉它（执行者 / 复核者）。 */
let runHandler: ((input: Record<string, unknown>) => Promise<string>) | undefined;
const FRESH_OUTPUT = "<subagent_id>w2</subagent_id>\n\nFRESH";
const REUSED_OUTPUT = "<subagent_id>w1</subagent_id>\n\nREUSED";

const realSubagent = { ...(await import("@server/services/narrator-subagent")) };
mock.module("@server/services/narrator-subagent", () => ({
	...realSubagent,
	runSubagent: mock(async (input: Record<string, unknown>) => {
		runCalls.push(input);
		if (runHandler) return await runHandler(input);
		return FRESH_OUTPUT;
	}),
	resumeSubagent: mock(async (input: Record<string, unknown>) => {
		resumeCalls.push(input);
		if (resumeShouldFail) throw new Error("worker is gone");
		return {
			started: true,
			resumedSuspendedRunner: false,
			originToolUseId: "origin-tool-use",
			terminalCompletion: Promise.resolve(resumeOutput || REUSED_OUTPUT),
		};
	}),
}));

const { resolveRuntimePolicy } = await import("@server/services/agent-runtime/policy");
const { tryClaimExecution } = await import("@server/services/agent-runtime/ownership");
const { __resetInFlightForTests } = await import("../runtime");
const { settings } = await import("@server/lib/settings");
const { agentTool } = await import("../../agent/tools/task");
const parking = await import("../parking");

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
		// 复用路径不接管这个租约（接管了就没法在原lease被消耗后退回新建），
		// 这里只要求它存在，因为派发前的校验会检查它。
		updateExecutionLease: {} as ToolContext["updateExecutionLease"],
		userId: null,
	} as ToolContext;
}

/**
 * 测试方案。
 *
 * 默认**关掉**两项复核：本文件大多数用例检验的是停放与复用，若默认开着复核，
 * 每次派发都会多出一次自审续跑和一次复核派发，断言就只能在"多出来的那几次调用"上
 * 绕来绕去。阶段 5 的用例显式打开它们。
 */
function makeProfile(
	model: string,
	review?: Partial<OrchestrationProfile["review"]>,
): OrchestrationProfile {
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
			...review,
		},
		tiers: { chore: tier(), quick: tier(), medium: tier(), heavy: tier() },
	};
}

function parked(overrides: Partial<ParkedWorker> = {}): ParkedWorker {
	return {
		narratorId: WORKER_ID,
		parentNarratorId: PARENT_ID,
		profileId: PROFILE_ID,
		tier: "quick",
		model: "provA:worker",
		lastUsedAt: 1000,
		...overrides,
	};
}

/** `narrators.parent_narrator_id` 是有外键的，插入子行前必须先有父行。 */
async function insertParent(id: string): Promise<void> {
	const stamp = "2026-01-01T00:00:00.000Z";
	await db
		.insert(narrators)
		.values({
			id,
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: stamp,
			updatedAt: stamp,
		})
		.onConflictDoNothing();
}

async function insertNarrator(input: {
	id: string;
	subagentType?: string | null;
	status?: "idle" | "working" | "waiting" | "archived";
	isBackground?: boolean;
	updatedAt?: string;
	parentNarratorId?: string | null;
	/** 阶段 5：执行者/复核者都是"某次 Agent 调用创建出来的"，这里把关联写进去。 */
	originToolCallId?: string | null;
}): Promise<void> {
	const stamp = input.updatedAt ?? "2026-01-01T00:00:00.000Z";
	const parentNarratorId =
		input.parentNarratorId === undefined ? PARENT_ID : input.parentNarratorId;
	if (parentNarratorId) await insertParent(parentNarratorId);
	await db.insert(narrators).values({
		id: input.id,
		type: "subagent",
		variant: `subagent:${input.subagentType ?? "general"}`,
		subagentType: input.subagentType ?? "general",
		parentNarratorId,
		originToolCallId: input.originToolCallId ?? null,
		status: input.status ?? "idle",
		isBackground: input.isBackground ?? false,
		model: "provA:worker",
		createdAt: stamp,
		updatedAt: stamp,
	});
}

async function statusOf(id: string): Promise<string | undefined> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { status: true },
	});
	return row?.status;
}

async function modelOf(id: string): Promise<string | null | undefined> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { model: true },
	});
	return row?.model;
}

const claimedOwners: Array<{ release: () => void }> = [];
let originalOrchestration: OrchestrationSettings | undefined;

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	parking.__resetParkingRegistryForTests();
	runCalls.length = 0;
	resumeCalls.length = 0;
	resumeShouldFail = false;
	resumeOutput = "";
	runHandler = undefined;
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	for (const owner of claimedOwners.splice(0)) owner.release();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	__resetInFlightForTests();
	cleanDb(sqlite);
});

afterAll(() => {
	// `@server/db` 的替身不用还原：`--isolate` 下每个测试文件一份模块注册表，它不会外溢。
	mock.module("@server/services/narrator-subagent", () => realSubagent);
	mock.restore();
});

describe("selectReusableWorker", () => {
	const request = { parentNarratorId: PARENT_ID, profileId: PROFILE_ID, tier: "quick" as const };

	test("同 parent / 同方案 / 同档位命中", () => {
		const candidate = parked();
		expect(parking.selectReusableWorker([candidate], request)).toEqual(candidate);
	});

	test("跨 parent、跨方案、跨档位都不命中", () => {
		expect(
			parking.selectReusableWorker([parked({ parentNarratorId: OTHER_PARENT_ID })], request),
		).toBeUndefined();
		expect(
			parking.selectReusableWorker([parked({ profileId: "otherprofile" })], request),
		).toBeUndefined();
		expect(parking.selectReusableWorker([parked({ tier: "heavy" })], request)).toBeUndefined();
	});

	test("多候选取 lastUsedAt 最大者", () => {
		const cold = parked({ narratorId: "b-cold", lastUsedAt: 10 });
		const hot = parked({ narratorId: "a-hot", lastUsedAt: 900 });
		const warm = parked({ narratorId: "c-warm", lastUsedAt: 500 });
		expect(parking.selectReusableWorker([cold, hot, warm], request)).toEqual(hot);
	});

	test("lastUsedAt 并列时取 narratorId 字典序最小者", () => {
		const b = parked({ narratorId: "worker-b", lastUsedAt: 7 });
		const a = parked({ narratorId: "worker-a", lastUsedAt: 7 });
		expect(parking.selectReusableWorker([b, a], request)).toEqual(a);
	});

	test("空数组返回 undefined", () => {
		expect(parking.selectReusableWorker([], request)).toBeUndefined();
	});

	test("输入数组与其中的项都不被修改", () => {
		// 冻结之后任何写入都会抛（ESM 严格模式），比事后深比较更能定位问题。
		const candidates = Object.freeze([
			Object.freeze(parked({ narratorId: "worker-b", lastUsedAt: 7 })),
			Object.freeze(parked({ narratorId: "worker-a", lastUsedAt: 7 })),
		]);
		const picked = parking.selectReusableWorker(candidates, request);
		expect(picked?.narratorId).toBe("worker-a");
		expect(candidates[0].narratorId).toBe("worker-b");
		expect(candidates[1].narratorId).toBe("worker-a");
	});
});

describe("停放登记簿", () => {
	const request = { parentNarratorId: PARENT_ID, profileId: PROFILE_ID, tier: "quick" as const };

	test("匹配成功后不再被第二次 claim", async () => {
		parking.registerParkedWorker(parked());
		expect((await parking.claimReusableWorker(request))?.narratorId).toBe(WORKER_ID);
		expect(await parking.claimReusableWorker(request)).toBeUndefined();
	});

	test("同 parent 但不同方案/档位取不到", async () => {
		parking.registerParkedWorker(parked());
		expect(
			await parking.claimReusableWorker({ ...request, profileId: "otherprofile" }),
		).toBeUndefined();
		expect(await parking.claimReusableWorker({ ...request, tier: "heavy" })).toBeUndefined();
		// 前面两次不匹配的尝试不能把它摘掉。
		expect((await parking.claimReusableWorker(request))?.narratorId).toBe(WORKER_ID);
	});

	test("同 narratorId 重复登记以最后一次为准", async () => {
		parking.registerParkedWorker(parked({ lastUsedAt: 1 }));
		parking.registerParkedWorker(parked({ lastUsedAt: 2, model: "provA:newer" }));
		const claimed = await parking.claimReusableWorker(request);
		expect(claimed?.model).toBe("provA:newer");
		expect(await parking.claimReusableWorker(request)).toBeUndefined();
	});

	test("单个编制者的池子上限按最近使用淘汰", async () => {
		const cap = 256;
		for (let index = 0; index <= cap; index++) {
			parking.registerParkedWorker(parked({ narratorId: `worker-${index}`, lastUsedAt: index }));
		}
		const seen = new Set<string>();
		for (let index = 0; index < cap + 5; index++) {
			const claimed = await parking.claimReusableWorker(request);
			if (!claimed) break;
			seen.add(claimed.narratorId);
		}
		expect(seen.size).toBe(cap);
		// 最旧的那个被淘汰，最新的仍在。
		expect(seen.has("worker-0")).toBe(false);
		expect(seen.has(`worker-${cap}`)).toBe(true);
	});
});

/**
 * 只读快照。
 *
 * 它是观测接口的唯一数据来源，因此"不改动登记簿"与计数正确同等重要：一个会顺手
 * 摘除陈旧项的"快照"在下一次派发时就会让池子少一个 worker，而且完全没有信号。
 */
describe("parkedWorkerSnapshot", () => {
	test("空登记簿：total 为 0，四档都在且都是 0", () => {
		expect(parking.parkedWorkerSnapshot()).toEqual({
			total: 0,
			byTier: { chore: 0, quick: 0, medium: 0, heavy: 0 },
		});
	});

	test("按档位分组计数", () => {
		parking.registerParkedWorker(parked({ narratorId: "w-quick", tier: "quick" }));
		parking.registerParkedWorker(parked({ narratorId: "w-quick-2", tier: "quick" }));
		parking.registerParkedWorker(parked({ narratorId: "w-heavy", tier: "heavy" }));

		expect(parking.parkedWorkerSnapshot()).toEqual({
			total: 3,
			byTier: { chore: 0, quick: 2, medium: 0, heavy: 1 },
		});
	});

	test("限定 parent 时只统计该 parent 名下的池子", () => {
		parking.registerParkedWorker(parked({ narratorId: "w-a1", tier: "quick" }));
		parking.registerParkedWorker(
			parked({ narratorId: "w-b1", tier: "medium", parentNarratorId: OTHER_PARENT_ID }),
		);
		parking.registerParkedWorker(
			parked({ narratorId: "w-b2", tier: "medium", parentNarratorId: OTHER_PARENT_ID }),
		);

		expect(parking.parkedWorkerSnapshot(PARENT_ID)).toEqual({
			total: 1,
			byTier: { chore: 0, quick: 1, medium: 0, heavy: 0 },
		});
		expect(parking.parkedWorkerSnapshot(OTHER_PARENT_ID)).toEqual({
			total: 2,
			byTier: { chore: 0, quick: 0, medium: 2, heavy: 0 },
		});
		// 没停放过任何东西的 parent 是"空池"，不是"查不到"。
		expect(parking.parkedWorkerSnapshot("nobody")).toEqual({
			total: 0,
			byTier: { chore: 0, quick: 0, medium: 0, heavy: 0 },
		});
	});

	test("同一个 worker 重复登记只算一个（以最后一次的档位为准）", () => {
		parking.registerParkedWorker(parked({ narratorId: WORKER_ID, tier: "quick" }));
		parking.registerParkedWorker(parked({ narratorId: WORKER_ID, tier: "heavy" }));

		expect(parking.parkedWorkerSnapshot()).toEqual({
			total: 1,
			byTier: { chore: 0, quick: 0, medium: 0, heavy: 1 },
		});
	});

	test("只读性：调用之后登记簿原样，worker 仍能被下一次派发取走", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		parking.registerParkedWorker(parked());

		const before = parking.parkedWorkerSnapshot(PARENT_ID);
		// 反复读不会累积出任何差异（若快照顺手摘除/重建，这里就会开始漂移）。
		const first = parking.parkedWorkerSnapshot(PARENT_ID);
		const second = parking.parkedWorkerSnapshot(PARENT_ID);
		expect(first).toEqual(before);
		expect(second).toEqual(before);

		expect(
			(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier: "quick",
				})
			)?.narratorId,
		).toBe(WORKER_ID);
		// 取走之后快照如实归零。
		expect(parking.parkedWorkerSnapshot(PARENT_ID).total).toBe(0);
	});
});

describe("ensureRegistryHydrated", () => {
	test("从归档的编排 worker 行重建，解析失败与后台/活跃行被跳过", async () => {
		await insertNarrator({
			id: "w-old",
			subagentType: QUICK_TYPE,
			status: "archived",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await insertNarrator({
			id: "w-new",
			subagentType: QUICK_TYPE,
			status: "archived",
			updatedAt: "2026-02-01T00:00:00.000Z",
		});
		await insertNarrator({
			id: "w-heavy",
			subagentType: HEAVY_TYPE,
			status: "archived",
			updatedAt: "2026-03-01T00:00:00.000Z",
		});
		// profileId 含大写与 `-`，parseOrchestrationType 会拒绝它。
		await insertNarrator({
			id: "w-bad",
			subagentType: "orch--NOT-UPPER--quick",
			status: "archived",
		});
		// 前缀对不上，连查询都不会命中。
		await insertNarrator({ id: "w-plain", subagentType: "general", status: "archived" });
		// 还没归档的 worker 不在池子里。
		await insertNarrator({
			id: "w-live",
			subagentType: `orch--${PROFILE_ID}--medium`,
			status: "working",
		});

		expect(
			await parking.claimReusableWorker({
				parentNarratorId: OTHER_PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
			}),
		).toBeUndefined();
		// quick 档同理，两个归档 worker 都归 PARENT_ID。
		expect(
			(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier: "quick",
				})
			)?.narratorId,
		).toBe("w-new");
		expect(
			(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier: "quick",
				})
			)?.narratorId,
		).toBe("w-old");
		expect(
			await parking.claimReusableWorker({
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
			}),
		).toBeUndefined();
		expect(
			(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier: "heavy",
				})
			)?.narratorId,
		).toBe("w-heavy");
		// working 的 medium worker 没进池子。
		expect(
			await parking.claimReusableWorker({
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "medium",
			}),
		).toBeUndefined();
	});

	test("只查询一次，并发调用共享同一次重建", async () => {
		const reads = spyOn(db, "select");
		try {
			await Promise.all([
				parking.ensureRegistryHydrated(),
				parking.ensureRegistryHydrated(),
				parking.ensureRegistryHydrated(),
			]);
			await parking.ensureRegistryHydrated();
			expect(reads.mock.calls.length).toBe(1);
		} finally {
			reads.mockRestore();
		}
	});
});

describe("parkWorker", () => {
	test("运行中的 worker 不被归档且返回 false", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "idle" });
		const owner = tryClaimExecution(WORKER_ID, "subagent");
		expect(owner).not.toBeNull();
		if (owner) claimedOwners.push(owner);

		expect(
			await parking.parkWorker({
				narratorId: WORKER_ID,
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
				model: "provA:worker",
			}),
		).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("idle");
		expect(
			await parking.claimReusableWorker({
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
			}),
		).toBeUndefined();
	});

	test("归档失败时不抛异常，只返回 false", async () => {
		expect(
			await parking.parkWorker({
				narratorId: "does-not-exist",
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
				model: "provA:worker",
			}),
		).toBe(false);
	});

	test("归档成功后可被认领", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "idle" });
		expect(
			await parking.parkWorker({
				narratorId: WORKER_ID,
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
				model: "provA:worker",
			}),
		).toBe(true);
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

describe("parkCompletedOrchestrationWorker", () => {
	const inspect = (id: string) =>
		parking.parkCompletedOrchestrationWorker({ narratorId: id, parentNarratorId: PARENT_ID });

	test("空闲的编排 worker 会被归档进池子", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "idle" });
		expect(await inspect(WORKER_ID)).toBe(true);
		expect(await statusOf(WORKER_ID)).toBe("archived");
	});

	test("后台模式的 worker 不停放（后台任务投影尚未落定）", async () => {
		await insertNarrator({
			id: WORKER_ID,
			subagentType: QUICK_TYPE,
			status: "idle",
			isBackground: true,
		});
		expect(await inspect(WORKER_ID)).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("还在 working 的 worker 不停放", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "working" });
		expect(await inspect(WORKER_ID)).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("working");
	});

	test("非编排子代理不停放", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: "general", status: "idle" });
		expect(await inspect(WORKER_ID)).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("父级与来路不一致时不停放", async () => {
		await insertNarrator({
			id: WORKER_ID,
			subagentType: QUICK_TYPE,
			status: "idle",
			parentNarratorId: OTHER_PARENT_ID,
		});
		expect(await inspect(WORKER_ID)).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});
});

describe("子代理终态出口与停放的关系", () => {
	test("finalizeSubagent 时刻租约仍握在自己手上，所以它不停放；非编排子代理同样不进池", async () => {
		// 停放（= 归档）的判定把"执行租约还挂在自己名下"算作"还在跑"（见 parking 模块），
		// 而 `finalizeSubagent` 恰恰是执行者自己还在跑的那一刻——所以**停放不挂在这里**，
		// 它挂在租约归还之后的终态出口（`subagent-runner.ts` 的 `releaseForegroundLease`）。
		// 本文件不替身 runner，只断言这个分工的前一半；真实出口上的端到端覆盖在
		// `server/services/__tests__/orchestration-parking-foreground.test.ts`。
		const { finalizeSubagent } = await import("@server/services/subagent-executor");

		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "working" });
		await finalizeSubagent(WORKER_ID, PARENT_ID, "tool-use-1", false, null);
		expect(await statusOf(WORKER_ID)).toBe("idle");
		expect(
			await parking.claimReusableWorker({
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
			}),
		).toBeUndefined();

		// 非编排子代理跑完之后仍然只是 idle：停放只认编排 worker。
		await insertNarrator({ id: "plain-worker", subagentType: "general", status: "working" });
		await finalizeSubagent("plain-worker", PARENT_ID, "tool-use-2", false, null);
		expect(await statusOf("plain-worker")).toBe("idle");
	});
});

describe("编排派发优先复用停放 worker", () => {
	function dispatch(args: Record<string, unknown>) {
		return agentTool.execute({ description: "task", ...args }, contextOf());
	}

	beforeEach(() => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile("provA:worker")],
		};
	});

	test("命中停放 worker 时不新建，把任务交给既有的那个", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		parking.registerParkedWorker(parked());

		const result = await dispatch({ prompt: "do it", tier: "quick" });

		expect(result.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);
		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0].subagentId).toBe(WORKER_ID);
		expect(resumeCalls[0].intent).toBe("follow_up");
		expect(resumeCalls[0].actor).toBe("parent_agent");
		expect(resumeCalls[0].skipConclusionDelivery).toBe(true);
		expect(result.output).toStartWith(REUSED_OUTPUT);
		// resumeSubagent 显式拒绝 archived，所以复用前必须已解除归档。
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("没有停放 worker 时走既有的新建路径", async () => {
		const result = await dispatch({ prompt: "do it", tier: "quick" });
		expect(resumeCalls).toHaveLength(0);
		expect(runCalls).toHaveLength(1);
		expect(result.output).toStartWith(FRESH_OUTPUT);
	});

	test("唤醒失败时回退新建，整个派发不判失败", async () => {
		resumeShouldFail = true;
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		parking.registerParkedWorker(parked());

		const result = await dispatch({ prompt: "do it", tier: "quick" });

		expect(resumeCalls).toHaveLength(1);
		expect(runCalls).toHaveLength(1);
		expect(result.isError).toBeUndefined();
		expect(result.output).toStartWith(FRESH_OUTPUT);
	});

	test("跨档位/跨方案的 worker 不会被挪用", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: HEAVY_TYPE, status: "archived" });
		parking.registerParkedWorker(parked({ tier: "heavy" }));

		const result = await dispatch({ prompt: "do it", tier: "quick" });

		expect(resumeCalls).toHaveLength(0);
		expect(runCalls).toHaveLength(1);
		expect(result.output).toStartWith(FRESH_OUTPUT);
		// 池子没有被取走。
		expect(
			(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier: "heavy",
				})
			)?.narratorId,
		).toBe(WORKER_ID);
	});

	test("调用方要求 workdir / alias / 后台运行时不复用（这些语义复用给不出）", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		parking.registerParkedWorker(parked());

		for (const extra of [{ workdir: "sub" }, { alias: "my-worker" }, { run_in_background: true }]) {
			runCalls.length = 0;
			await dispatch({ prompt: "do it", tier: "quick", ...extra });
			expect(resumeCalls).toHaveLength(0);
			expect(runCalls).toHaveLength(1);
		}
		// 三次都被拒绝之后，池子里那个 worker 仍然在。
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

	test("复用选中的是 lastUsedAt 最大的那个", async () => {
		await insertNarrator({
			id: "w-cold",
			subagentType: QUICK_TYPE,
			status: "archived",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		await insertNarrator({
			id: "w-hot",
			subagentType: QUICK_TYPE,
			status: "archived",
			updatedAt: "2026-02-01T00:00:00.000Z",
		});
		parking.registerParkedWorker(parked({ narratorId: "w-cold", lastUsedAt: 1 }));
		parking.registerParkedWorker(parked({ narratorId: "w-hot", lastUsedAt: 99 }));

		await dispatch({ prompt: "do it", tier: "quick" });

		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0].subagentId).toBe("w-hot");
		expect(await statusOf("w-hot")).toBe("idle");
		expect(await statusOf("w-cold")).toBe("archived");
	});
});

// ---------------------------------------------------------------------------
// 复用失败后的归还
// ---------------------------------------------------------------------------

/**
 * 复用的三条失败出口都必须把 worker 放回池子。
 *
 * 认领已经把它从登记簿摘掉了，而为了续跑又必须先把它从 archived 写成 idle：
 * 失败之后它就既不在池子里、也不是归档态，而且**没有任何路径会修复这个组合**
 * （唯一会重新登记的是"某个 run 归还租约"，而它再也不会跑；登记簿重建是每进程
 * 一次且只认 archived）。表现出来就是池子静默缩水 + 一个参与 TeamStatus 广播、
 * 还能被 Send 驱动的 `idle` 孤儿。
 */
describe("复用失败后 worker 归还原池（B4）", () => {
	const profileWith = (model: string): OrchestrationSettings => ({
		orchestratorModels: ["provA:orchestrator"],
		profiles: [makeProfile(model)],
	});

	function dispatch(args: Record<string, unknown>) {
		return agentTool.execute({ description: "task", ...args }, contextOf());
	}

	function claim() {
		return parking.claimReusableWorker({
			parentNarratorId: PARENT_ID,
			profileId: PROFILE_ID,
			tier: "quick",
		});
	}

	beforeEach(() => {
		settings.agent.orchestration = profileWith("provA:worker");
	});

	test("复用失败后不留 idle 孤儿：重新归档，并回到池子里等下一次派发", async () => {
		resumeShouldFail = true;
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		parking.registerParkedWorker(parked());

		const result = await dispatch({ prompt: "do it", tier: "quick" });

		// 派发本身照旧成功（回退新建），错不在它——错的是 worker 掉出了池子。
		expect(result.isError).toBeUndefined();
		expect(resumeCalls).toHaveLength(1);
		expect(runCalls).toHaveLength(1);
		// 不是 idle 孤儿：归档态才是"不参与广播、不接受 Send"。
		expect(await statusOf(WORKER_ID)).toBe("archived");
		expect((await claim())?.narratorId).toBe(WORKER_ID);
	});

	test("复用失败一次不会让池子缩水：失败关掉之后下一次派发仍然命中它而不是新建", async () => {
		resumeShouldFail = true;
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		parking.registerParkedWorker(parked());
		await dispatch({ prompt: "do it", tier: "quick" });
		expect(runCalls).toHaveLength(1);

		// 一次失败之后再派发：池子里必须还有它。
		resumeShouldFail = false;
		runCalls.length = 0;
		resumeCalls.length = 0;
		const second = await dispatch({ prompt: "do it", tier: "quick" });

		expect(second.isError).toBeUndefined();
		expect(runCalls).toHaveLength(0);
		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0].subagentId).toBe(WORKER_ID);
		expect(second.output).toStartWith(REUSED_OUTPUT);
	});

	test("复用失败时被改坏的模型写回停放时的那一个", async () => {
		// 这次派发要用的模型与停放时不同：认领后、失败前它已经写进库了。
		settings.agent.orchestration = profileWith("provA:newer");
		resumeShouldFail = true;
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		// 行里的模型与停放项一致：不一致的话"写回"就没有观察对象。
		await db.update(narrators).set({ model: "provA:older" }).where(eq(narrators.id, WORKER_ID));
		parking.registerParkedWorker(parked({ model: "provA:older" }));

		await dispatch({ prompt: "do it", tier: "quick" });

		// 这次派发压根没跑起来，那么它写进去的新模型就是"从未使用过的值"。
		expect(await modelOf(WORKER_ID)).toBe("provA:older");
		expect((await claim())?.model).toBe("provA:older");
	});

	test("认领不会交出一个正在跑的 worker", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "archived" });
		parking.registerParkedWorker(parked());
		const owner = tryClaimExecution(WORKER_ID, "subagent");
		expect(owner).not.toBeNull();
		if (owner) claimedOwners.push(owner);

		// 登记簿是内存加速视图，运行时才是"它到底在不在跑"的事实来源。
		expect(await claim()).toBeUndefined();
	});

	test("认领不会交出登记簿里已经不是归档态的陈旧项", async () => {
		// 某条路径把它写回 idle 之后，登记簿里那一项就成了陈旧项。
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "idle" });
		parking.registerParkedWorker(parked());
		expect(await claim()).toBeUndefined();
	});

	test("陈旧项不堵住整个档位：它被丢掉之后，后面的候选照样能命中", async () => {
		await insertNarrator({ id: "w-stale", subagentType: QUICK_TYPE, status: "idle" });
		await insertNarrator({ id: "w-good", subagentType: QUICK_TYPE, status: "archived" });
		// 陈旧项 lastUsedAt 更大，所以它一定是被选中的那一个。
		parking.registerParkedWorker(parked({ narratorId: "w-stale", lastUsedAt: 99 }));
		parking.registerParkedWorker(parked({ narratorId: "w-good", lastUsedAt: 1 }));

		expect((await claim())?.narratorId).toBe("w-good");
		// 陈旧项被摘掉了，不会每次派发都再挡一次。
		expect(await claim()).toBeUndefined();
	});

	test("登记簿里有、库里已经没有的 worker：只回退新建，不给派发报错", async () => {
		// 纯登记簿条目（行刚被删掉）：只读校验查不到行，写操作的顺序保证此时
		// 还没有任何库改动需要回滚。
		parking.registerParkedWorker(parked());

		const result = await dispatch({ prompt: "do it", tier: "quick" });

		expect(result.isError).toBeUndefined();
		expect(resumeCalls).toHaveLength(0);
		expect(runCalls).toHaveLength(1);
		expect(result.output).toStartWith(FRESH_OUTPUT);
	});
});

// ---------------------------------------------------------------------------
// 阶段 5：自审 + 独立复核 + 结构化回执
// ---------------------------------------------------------------------------

describe("编排派发的自审与独立复核", () => {
	const receiptText = (head: string, over: Record<string, unknown> = {}) =>
		`${head}\n\n\`\`\`json\n${JSON.stringify({
			verdict: "pass",
			changedFiles: ["server/a.ts"],
			testsRun: ["bun test server/a.test.ts — pass"],
			notDone: [],
			confidence: "high",
			blockers: [],
			...over,
		})}\n\`\`\``;

	const EXECUTOR_FINAL = receiptText("执行者原话：我把 a.ts 改完了。");
	const SELF_REVIEW_FINAL = receiptText("自审原话：回看 diff，b 的测试没跑。", {
		verdict: "partial",
		notDone: ["b.test.ts 没跑"],
	});
	const REVIEWER_FINAL = receiptText("复核原话：我读了 diff，接口签名对不上。", {
		verdict: "fail",
		blockers: ["接口签名不匹配"],
	});

	function dispatch(args: Record<string, unknown>) {
		return agentTool.execute({ description: "task", ...args }, contextOf());
	}

	/**
	 * 模拟 `runSubagent` 真实做的事：为执行者建一行 narrators（带 origin 关联），
	 * 复核者则返回复核结论。阶段 5 的派发侧逻辑依赖"执行者是谁"这个关联，
	 * 所以桩必须把它写出来，否则测到的只是"查不到执行者"那条降级路径。
	 */
	function wireRuns(input: {
		executorId: string;
		executorFinal?: string;
		reviewerFinal?: string;
		reviewerThrows?: boolean;
	}): void {
		runHandler = async (call) => {
			const subagentType = String(call.subagentType ?? "");
			if (subagentType.startsWith("orch-review--")) {
				if (input.reviewerThrows) throw new Error("reviewer exploded");
				return input.reviewerFinal ?? REVIEWER_FINAL;
			}
			const binding = call.toolCallBinding as { toolCallId?: string } | undefined;
			await insertNarrator({
				id: input.executorId,
				subagentType,
				status: "idle",
				originToolCallId: binding?.toolCallId ?? null,
			});
			return input.executorFinal ?? EXECUTOR_FINAL;
		};
	}

	function reviewsOn(over: Partial<OrchestrationProfile["review"]> = {}): void {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [
				makeProfile("provA:worker", { selfReview: true, independentReview: true, ...over }),
			],
		};
	}

	beforeEach(() => {
		reviewsOn();
	});

	test("执行者 → 自审（同一 worker 续跑）→ 独立复核（另建只读 worker），三方一起交付", async () => {
		wireRuns({ executorId: "exec-1" });
		resumeOutput = SELF_REVIEW_FINAL;

		const result = await dispatch({ prompt: "把 a.ts 改好", ...SELF_REVIEWED_DISPATCH });

		expect(result.isError).toBeUndefined();
		// 两次 Agent 工具调用：执行者一次，复核者一次。
		expect(runCalls).toHaveLength(2);
		const reviewer = runCalls[1];
		expect(reviewer.subagentType).toBe(buildReviewerSubagentType(PROFILE_ID, "quick"));
		// 复核者的类型**不是**合法编排 worker 类型 —— 这是"不会被复用"的第一道闸门。
		expect(parseOrchestrationType(String(reviewer.subagentType)).ok).toBe(false);
		// 强制只读：复核者无论档位配成什么，都不给写权限。
		expect((reviewer.customDefinition as { toolAccess?: string }).toolAccess).toBe("readOnly");
		expect((reviewer.customDefinition as { customTools?: string[] }).customTools).not.toContain(
			"Write",
		);
		expect(reviewer.model).toBe("provA:worker");
		// 刻意不转发：转发绑定会改写父级那条 Agent 工具结果的结论槽位，
		// 转发租约则会因 `transfer()` 一次性而直接抛错。
		expect(reviewer.toolCallBinding).toBeUndefined();
		expect(reviewer.updateExecutionLease).toBeUndefined();
		// 复核者拿到的是"事实清单"，没有执行者的推理过程。
		expect(String(reviewer.prompt)).toContain("把 a.ts 改好");
		expect(String(reviewer.prompt)).not.toContain("执行者原话");

		// 自审续跑的是**同一个** worker，且用的是自审提示词而不是原任务。
		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0].subagentId).toBe("exec-1");
		expect(resumeCalls[0].intent).toBe("follow_up");
		expect(resumeCalls[0].actor).toBe("parent_agent");
		expect(resumeCalls[0].skipConclusionDelivery).toBe(true);
		expect(String(resumeCalls[0].prompt)).toContain("自审");
		expect(String(resumeCalls[0].prompt)).not.toBe("把 a.ts 改好");

		// 组装：执行者原话 + 自审回执 + 复核结论（含它拒绝的理由）。
		expect(result.output).toContain("执行者原话");
		expect(result.output).toContain("`partial`");
		expect(result.output).toContain("b.test.ts 没跑");
		expect(result.output).toContain("`fail`");
		expect(result.output).toContain("接口签名不匹配");
	});

	test("只读复核者不会被当成执行者复用（编码层 / 停放层 / 终态出口三道）", async () => {
		const reviewerType = buildReviewerSubagentType(PROFILE_ID, "quick");
		// 1) 编码层
		expect(parseOrchestrationType(reviewerType).ok).toBe(false);
		// 2) 停放层：即使它已经是 archived，重建登记簿也捞不到它。
		await insertNarrator({ id: "reviewer-1", subagentType: reviewerType, status: "archived" });
		for (const tier of ["chore", "quick", "medium", "heavy"] as const) {
			expect(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier,
				}),
			).toBeUndefined();
		}
		// 3) 终态出口：复核者跑完之后保持 idle，不进池子。
		expect(
			await parking.parkCompletedOrchestrationWorker({
				narratorId: "reviewer-1",
				parentNarratorId: PARENT_ID,
			}),
		).toBe(false);
		const { finalizeSubagent } = await import("@server/services/subagent-executor");
		await insertNarrator({ id: "reviewer-2", subagentType: reviewerType, status: "working" });
		await finalizeSubagent("reviewer-2", PARENT_ID, "tool-use-9", false, null);
		expect(await statusOf("reviewer-2")).toBe("idle");
		expect(
			await parking.claimReusableWorker({
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier: "quick",
			}),
		).toBeUndefined();
	});

	test("同一个派发里复核者也不会被下一次派发复用（池子确实是空的）", async () => {
		wireRuns({ executorId: "exec-1" });
		resumeOutput = SELF_REVIEW_FINAL;
		await dispatch({ prompt: "把 a.ts 改好", ...SELF_REVIEWED_DISPATCH });

		// 派发过程中唯一进过池子的只有执行者（tests 里桩不跑终态收尾，所以这里断言的是
		// "复核者没有被注册" —— 它的类型进不了 like 'orch--%' 的查询）。
		const reviewerIds = runCalls
			.filter((call) => String(call.subagentType ?? "").startsWith("orch-review--"))
			.map((call) => call.subagentType);
		expect(reviewerIds).toHaveLength(1);
		for (const tier of ["chore", "quick", "medium", "heavy"] as const) {
			const claimed = await parking.claimReusableWorker({
				parentNarratorId: PARENT_ID,
				profileId: PROFILE_ID,
				tier,
			});
			// 桩没有真的建复核者行，所以这里只能是 undefined；若有行，也只可能是执行者那个
			// （它的类型不以 orch-review-- 开头）。
			expect(claimed?.narratorId ?? "exec-1").toBe("exec-1");
		}
	});

	test("review.selfReview=false 时跳过自审，回执退回执行者自己的输出", async () => {
		reviewsOn({ selfReview: false });
		wireRuns({ executorId: "exec-1" });

		const result = await dispatch({ prompt: "把 a.ts 改好", tier: "quick" });

		expect(resumeCalls).toHaveLength(0);
		expect(runCalls).toHaveLength(2);
		expect(result.output).toContain("关闭了自审");
	});

	test("review.independentReview=false 时跳过复核，仍然照常自审", async () => {
		reviewsOn({ independentReview: false });
		wireRuns({ executorId: "exec-1" });
		resumeOutput = SELF_REVIEW_FINAL;

		const result = await dispatch({ prompt: "把 a.ts 改好", ...SELF_REVIEWED_DISPATCH });

		expect(resumeCalls).toHaveLength(1);
		expect(runCalls).toHaveLength(1);
		expect(result.output).toContain("关闭了独立复核");
		expect(result.output).toContain("b.test.ts 没跑");
	});

	test("复核档位取不到模型时如实说明，且不掀翻派发", async () => {
		reviewsOn();
		// 复核档位是 quick，把它的池清空即可复现"取不到模型"。
		const profile = makeProfile("provA:worker", {
			selfReview: true,
			independentReview: true,
		});
		profile.tiers.quick = { pool: [] };
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [profile],
		};
		wireRuns({ executorId: "exec-1" });
		resumeOutput = SELF_REVIEW_FINAL;

		const result = await dispatch({ prompt: "把 a.ts 改好", ...SELF_REVIEWED_DISPATCH });

		expect(result.isError).toBeUndefined();
		expect(runCalls).toHaveLength(1);
		expect(result.output).toContain("取不到可用模型");
		expect(result.output).toContain("b.test.ts 没跑");
	});

	test("自审抛异常时派发仍返回正常内容，并说明未经自审", async () => {
		wireRuns({ executorId: "exec-1" });
		resumeShouldFail = true;

		const result = await dispatch({ prompt: "把 a.ts 改好", ...SELF_REVIEWED_DISPATCH });

		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("执行者原话");
		expect(result.output).toContain("未经自审");
		// 复核不受自审失败牵连，照常进行。
		expect(runCalls).toHaveLength(2);
	});

	test("复核抛异常时派发仍返回正常内容，并说明复核没跑成", async () => {
		wireRuns({ executorId: "exec-1", reviewerThrows: true });
		resumeOutput = SELF_REVIEW_FINAL;

		const result = await dispatch({ prompt: "把 a.ts 改好", ...SELF_REVIEWED_DISPATCH });

		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("复核者没能跑起来");
		expect(result.output).toContain("b.test.ts 没跑");
	});

	test("后台派发不做自审与复核（执行者此刻还在跑）", async () => {
		wireRuns({ executorId: "exec-1" });
		resumeOutput = SELF_REVIEW_FINAL;

		const result = await dispatch({
			prompt: "把 a.ts 改好",
			tier: "quick",
			run_in_background: true,
		});

		expect(runCalls).toHaveLength(1);
		expect(resumeCalls).toHaveLength(0);
		expect(result.output).toBe(EXECUTOR_FINAL);
	});

	test("复用停放 worker 的路径同样走自审与复核（两种路径语义一致）", async () => {
		await insertNarrator({ id: WORKER_ID, subagentType: MEDIUM_TYPE, status: "archived" });
		parking.registerParkedWorker(parked({ tier: "medium" }));
		// 复用路径不会新建执行者，所以只有复核者会走 `runSubagent`。
		runHandler = async () => REVIEWER_FINAL;
		resumeOutput = SELF_REVIEW_FINAL;

		const result = await dispatch({ prompt: "把 a.ts 改好", ...SELF_REVIEWED_DISPATCH });

		expect(runCalls).toHaveLength(1);
		expect(String(runCalls[0].subagentType)).toBe(buildReviewerSubagentType(PROFILE_ID, "quick"));
		// 两次续跑：第一次是把本次任务交给它，第二次才是自审。
		expect(resumeCalls).toHaveLength(2);
		expect(resumeCalls[0].subagentId).toBe(WORKER_ID);
		expect(String(resumeCalls[0].prompt)).toContain("把 a.ts 改好");
		expect(resumeCalls[1].subagentId).toBe(WORKER_ID);
		expect(String(resumeCalls[1].prompt)).toContain("自审");
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("接口签名不匹配");
	});
});

describe("执行者终态与停放钩子的顺序（阶段 5 的排期依据）", () => {
	test("执行者到达终态时执行租约仍在自己手上，归还之后停放才生效", async () => {
		const { finalizeSubagent } = await import("@server/services/subagent-executor");
		const inspect = (id: string) =>
			parking.parkCompletedOrchestrationWorker({ narratorId: id, parentNarratorId: PARENT_ID });
		await insertNarrator({ id: WORKER_ID, subagentType: QUICK_TYPE, status: "working" });
		const owner = tryClaimExecution(WORKER_ID, "subagent");
		expect(owner).not.toBeNull();
		if (owner) claimedOwners.push(owner);

		// 真实顺序：`finalizeSubagent`（执行者到终态）在 `publishTerminal`（归还执行租约）
		// 之前。终态这一刻 `isNarratorRuntimeBusy` 仍为真（`executionAdmissions.has`），
		// 停放入口因此拒绝归档——这也是"停放不能挂在 finalizeSubagent 上"的原因。
		await finalizeSubagent(WORKER_ID, PARENT_ID, "tool-use-1", false, null, {
			owner: owner ?? undefined,
		});
		expect(await statusOf(WORKER_ID)).toBe("idle");
		expect(await inspect(WORKER_ID)).toBe(false);

		// 租约还回去之后（真实路径里这一步发生在前台终态出口
		// `subagent-runner.ts` 的 `releaseForegroundLease`），归档才成立。
		owner?.release();
		expect(await inspect(WORKER_ID)).toBe(true);
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
