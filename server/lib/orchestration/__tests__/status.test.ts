import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { narrators } from "../../../db/schema";
import type { OrchestrationProfile, OrchestrationSettings } from "../types";

/**
 * 编排状态查询的测试。
 *
 * 这个接口的全部价值在于"如实"：它要么给出真实计数，要么明确说"这里没有编排"。
 * 因此断言分成两类——纯组装的容量/档位表示（`buildOrchestrationStatus`），以及走
 * 真库的读取路径（非编排会话、计数口径、只读性）。
 */

const { db, sqlite } = getTestDb();
// 与 parking.test.ts 同样的替身方式：只从 @server/db 取这三个句柄，避免实例化第二份单例。
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-narrator";
const OTHER_PARENT_ID = "other-parent";
const ORCH_MODEL = `__orch__:${PROFILE_ID}`;

const { acquireModelSlot, __resetInFlightForTests } = await import("../runtime");
const parking = await import("../parking");
const { buildOrchestrationStatus, orchestrationStatusResponse, readOrchestrationStatus } =
	await import("../status");
const { settings } = await import("@server/lib/settings");

function makeProfile(over: Partial<OrchestrationProfile> = {}): OrchestrationProfile {
	const tier = () => ({ pool: [{ model: "provA:worker" }] });
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
		...over,
	};
}

function emptyCounts(): Record<"chore" | "quick" | "medium" | "heavy", number> {
	return { chore: 0, quick: 0, medium: 0, heavy: 0 };
}

/** `narrators.parent_narrator_id` 有外键，插子行前必须先有父行。 */
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
	parentNarratorId?: string | null;
	model?: string;
}): Promise<void> {
	const stamp = "2026-01-01T00:00:00.000Z";
	const parentNarratorId =
		input.parentNarratorId === undefined ? PARENT_ID : input.parentNarratorId;
	if (parentNarratorId) await insertParent(parentNarratorId);
	await db.insert(narrators).values({
		id: input.id,
		type: parentNarratorId ? "subagent" : "primary",
		variant: parentNarratorId ? `subagent:${input.subagentType ?? "general"}` : "primary",
		subagentType: input.subagentType ?? null,
		parentNarratorId,
		status: input.status ?? "idle",
		model: input.model ?? "provA:worker",
		createdAt: stamp,
		updatedAt: stamp,
	});
}

let originalOrchestration: OrchestrationSettings | undefined;
const claimedSlots: Array<() => void> = [];

beforeEach(() => {
	originalOrchestration = settings.agent.orchestration;
	parking.__resetParkingRegistryForTests();
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	for (const release of claimedSlots.splice(0)) release();
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	__resetInFlightForTests();
	cleanDb(sqlite);
});

afterAll(() => {
	mock.restore();
});

describe("buildOrchestrationStatus", () => {
	const base = {
		profileId: PROFILE_ID,
		profileName: "测试方案",
		orchestratorModel: "provA:orchestrator",
		parkedByTier: emptyCounts(),
		runningByTier: emptyCounts(),
		inFlight: new Map<string, number>(),
	};

	test("池为空数组的档位给出空列表，而不是缺键", () => {
		const profile = makeProfile();
		profile.tiers.heavy = { pool: [] };
		const status = buildOrchestrationStatus({ ...base, profile });

		expect(status.pools.heavy).toEqual([]);
		// 其余三档各自有内容，且四档键恒在。
		expect(status.pools.quick).toEqual([
			{ model: "provA:worker", inFlight: 0, maxConcurrent: null },
		]);
		expect(Object.keys(status.pools).sort()).toEqual(["chore", "heavy", "medium", "quick"]);
	});

	test("maxConcurrent 省略 / 0 / 负数都是「不限」（null），正数原样给出", () => {
		const profile = makeProfile();
		profile.tiers.chore = {
			pool: [
				{ model: "provA:a" },
				{ model: "provA:b", maxConcurrent: 0 },
				{ model: "provA:c", maxConcurrent: -3 },
				{ model: "provA:d", maxConcurrent: 4 },
			],
		};
		const status = buildOrchestrationStatus({ ...base, profile });

		expect(status.pools.chore.map((entry) => [entry.model, entry.maxConcurrent])).toEqual([
			["provA:a", null],
			["provA:b", null],
			["provA:c", null],
			["provA:d", 4],
		]);
	});

	test("在飞数按模型读出：已用/上限成对可算", () => {
		const profile = makeProfile();
		profile.tiers.medium = {
			pool: [
				{ model: "provA:busy", maxConcurrent: 2 },
				{ model: "provA:idle", maxConcurrent: 3 },
			],
		};
		const status = buildOrchestrationStatus({
			...base,
			profile,
			inFlight: new Map([["provA:busy", 2]]),
		});

		expect(status.pools.medium).toEqual([
			{ model: "provA:busy", inFlight: 2, maxConcurrent: 2 },
			// 不在快照里就是 0，而不是 undefined。
			{ model: "provA:idle", inFlight: 0, maxConcurrent: 3 },
		]);
	});

	test("池里重复的模型只列一次（它只有一个在飞计数器）", () => {
		const profile = makeProfile();
		profile.tiers.quick = {
			pool: [
				{ model: "provA:worker", maxConcurrent: 1 },
				{ model: "provA:worker", maxConcurrent: 9 },
			],
		};
		const status = buildOrchestrationStatus({ ...base, profile });

		expect(status.pools.quick).toEqual([{ model: "provA:worker", inFlight: 0, maxConcurrent: 1 }]);
	});

	test("坏条目（缺 model / 非对象）被跳过，不产生空模型名", () => {
		const profile = makeProfile();
		profile.tiers.heavy = { pool: [{}, { model: "  " }, "provA:raw"] as never };
		const status = buildOrchestrationStatus({ ...base, profile });

		expect(status.pools.heavy).toEqual([]);
	});

	test("方案不存在时池子全空，但档位计数照常给出", () => {
		const status = buildOrchestrationStatus({
			...base,
			profile: undefined,
			parkedByTier: { ...emptyCounts(), quick: 3 },
			runningByTier: { ...emptyCounts(), heavy: 1 },
		});

		expect(status.pools).toEqual({ chore: [], quick: [], medium: [], heavy: [] });
		expect(status.tiers.quick).toEqual({ parked: 3, running: 0 });
		expect(status.tiers.heavy).toEqual({ parked: 0, running: 1 });
	});
});

describe("readOrchestrationStatus", () => {
	beforeEach(() => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile()],
		};
	});

	test("非编排会话返回 null，响应形状是显式的 orchestration: null", async () => {
		await insertNarrator({ id: PARENT_ID, parentNarratorId: null, model: "provA:plain" });

		expect(await readOrchestrationStatus(PARENT_ID)).toBeNull();
		// "不在编排模式"是正常答案而不是错误：界面据此收起整个详情区。
		expect(orchestrationStatusResponse(null)).toEqual({ orchestration: null });
	});

	test("会话不存在时同样是 null（不抛）", async () => {
		expect(await readOrchestrationStatus("does-not-exist")).toBeNull();
	});

	test("编排会话给出方案名、编制者模型与四档池容量", async () => {
		await insertNarrator({ id: PARENT_ID, parentNarratorId: null, model: ORCH_MODEL });
		const release = acquireModelSlot("provA:worker");
		claimedSlots.push(release);

		const status = await readOrchestrationStatus(PARENT_ID);

		expect(status).not.toBeNull();
		expect(status?.profileId).toBe(PROFILE_ID);
		expect(status?.profileName).toBe("测试方案");
		expect(status?.orchestratorModel).toBe("provA:orchestrator");
		// 四个档位的池内容一致（测试方案的四个档位配的是同一个模型）。
		for (const tier of ["chore", "quick", "medium", "heavy"] as const) {
			expect(status?.pools[tier]).toEqual([
				{ model: "provA:worker", inFlight: 1, maxConcurrent: null },
			]);
		}
		// 响应外壳与查询结果的形状一致。
		expect(orchestrationStatusResponse(status ?? null)).toEqual({ orchestration: status });
	});

	test("方案已从设置里删掉时退回 profileId，池子留空", async () => {
		settings.agent.orchestration = { orchestratorModels: [], profiles: [] };
		await insertNarrator({ id: PARENT_ID, parentNarratorId: null, model: ORCH_MODEL });

		const status = await readOrchestrationStatus(PARENT_ID);

		expect(status?.profileName).toBe(PROFILE_ID);
		// 配置里没有编制者模型时宁可给 null，也不编一个模型名。
		expect(status?.orchestratorModel).toBeNull();
		expect(status?.pools).toEqual({ chore: [], quick: [], medium: [], heavy: [] });
	});

	test("停放数按档位分组，只算这个 parent 名下的池子", async () => {
		await insertNarrator({ id: PARENT_ID, parentNarratorId: null, model: ORCH_MODEL });
		parking.registerParkedWorker({
			narratorId: "w-quick",
			parentNarratorId: PARENT_ID,
			profileId: PROFILE_ID,
			tier: "quick",
			model: "provA:worker",
			lastUsedAt: 1,
		});
		parking.registerParkedWorker({
			narratorId: "w-heavy",
			parentNarratorId: PARENT_ID,
			profileId: PROFILE_ID,
			tier: "heavy",
			model: "provA:worker",
			lastUsedAt: 2,
		});
		parking.registerParkedWorker({
			narratorId: "w-other",
			parentNarratorId: OTHER_PARENT_ID,
			profileId: PROFILE_ID,
			tier: "heavy",
			model: "provA:worker",
			lastUsedAt: 3,
		});

		const status = await readOrchestrationStatus(PARENT_ID);

		expect(status?.tiers).toEqual({
			chore: { parked: 0, running: 0 },
			quick: { parked: 1, running: 0 },
			medium: { parked: 0, running: 0 },
			heavy: { parked: 1, running: 0 },
		});
	});

	test("在场数：归档、复核者、别的 parent 都不算，且按档位分组", async () => {
		await insertNarrator({ id: PARENT_ID, parentNarratorId: null, model: ORCH_MODEL });
		const quick = `orch--${PROFILE_ID}--quick`;
		const heavy = `orch--${PROFILE_ID}--heavy`;
		await insertNarrator({ id: "w-live-quick", subagentType: quick, status: "working" });
		await insertNarrator({ id: "w-idle-quick", subagentType: quick, status: "idle" });
		await insertNarrator({ id: "w-archived", subagentType: quick, status: "archived" });
		await insertNarrator({ id: "w-heavy", subagentType: heavy, status: "waiting" });
		// 复核者（orch-review--…）与普通子代理都不进档位口径。
		await insertNarrator({
			id: "w-reviewer",
			subagentType: `orch-review--${PROFILE_ID}--quick`,
			status: "working",
		});
		await insertNarrator({ id: "w-plain", subagentType: "general", status: "working" });
		await insertNarrator({
			id: "w-other-parent",
			subagentType: quick,
			status: "working",
			parentNarratorId: OTHER_PARENT_ID,
		});

		const status = await readOrchestrationStatus(PARENT_ID);

		// 归档行经登记簿重建后计为**停放**而不是在场：一个 worker 只能落在一边。
		expect(status?.tiers.quick).toEqual({ parked: 1, running: 2 });
		expect(status?.tiers.heavy).toEqual({ parked: 0, running: 1 });
		expect(status?.tiers.chore).toEqual({ parked: 0, running: 0 });
	});

	test("只读性：调用前后在飞计数与登记簿都不变，worker 仍可被认领", async () => {
		await insertNarrator({ id: PARENT_ID, parentNarratorId: null, model: ORCH_MODEL });
		// 一个真实的归档 worker：登记簿重建会认得它，`running` 口径不认。
		await insertNarrator({
			id: "w-parked",
			subagentType: `orch--${PROFILE_ID}--quick`,
			status: "archived",
		});
		const release = acquireModelSlot("provA:worker");
		claimedSlots.push(release);

		const first = await readOrchestrationStatus(PARENT_ID);
		await readOrchestrationStatus(PARENT_ID);
		const second = await readOrchestrationStatus(PARENT_ID);

		expect(second).toEqual(first);
		expect(first?.tiers.quick).toEqual({ parked: 1, running: 0 });
		expect(first?.pools.quick[0].inFlight).toBe(1);
		// 状态查询没有在飞计数可泄漏的地方占位：连查三次，计数仍是 1。
		expect((await readOrchestrationStatus(PARENT_ID))?.pools.quick[0].inFlight).toBe(1);
		// 停放项没被顺手摘掉。
		expect(
			(
				await parking.claimReusableWorker({
					parentNarratorId: PARENT_ID,
					profileId: PROFILE_ID,
					tier: "quick",
				})
			)?.narratorId,
		).toBe("w-parked");
	});
});
