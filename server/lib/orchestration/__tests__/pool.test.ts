/**
 * 池选取与在飞计数的测试。
 *
 * runtime 的槽位计数（acquireModelSlot/getInFlight）是池容量判断的状态侧，
 * 与 selectModelFromPool 的输入快照同一套语义，因此放在本文件一起验证：
 * 二者拆开测试会漏掉「计数漂移导致容量判断失真」这类跨层问题。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { settings } from "@server/lib/settings";

import { selectModelFromPool } from "../pool";
import {
	__resetInFlightForTests,
	acquireModelSlot,
	findEnabledProfile,
	getInFlight,
	inFlightSnapshot,
	listEnabledProfiles,
	selectModelForTier,
} from "../runtime";
import type { OrchestrationPoolEntry, OrchestrationProfile } from "../types";

/** 便捷构造：把在飞计数写成普通对象，语义上等价于 ReadonlyMap。 */
function flight(entries: Record<string, number> = {}): ReadonlyMap<string, number> {
	return new Map(Object.entries(entries));
}

describe("selectModelFromPool", () => {
	test("空池返回 empty", () => {
		expect(selectModelFromPool({ pool: [], inFlight: flight() })).toEqual({ kind: "empty" });
	});

	test("全部条目字段非法时同样返回 empty", () => {
		const pool = [null, { model: 123 }] as unknown as OrchestrationPoolEntry[];
		expect(selectModelFromPool({ pool, inFlight: flight() })).toEqual({ kind: "empty" });
	});

	test("取优先级最小的条目", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:slow", priority: 5 },
			{ model: "p:fast", priority: 1 },
			{ model: "p:mid", priority: 3 },
		];
		const result = selectModelFromPool({ pool, inFlight: flight() });
		expect(result.kind).toBe("selected");
		if (result.kind !== "selected") return;
		expect(result.model).toBe("p:fast");
		expect(result.effectivePriority).toBe(1);
		expect(result.inFlight).toBe(0);
		expect(result.entry).toBe(pool[1]);
	});

	test("省略 priority 视同 1", () => {
		const pool: OrchestrationPoolEntry[] = [{ model: "p:a" }, { model: "p:b", priority: 1 }];
		const result = selectModelFromPool({ pool, inFlight: flight() });
		expect(result.kind).toBe("selected");
		if (result.kind !== "selected") return;
		// 优先级并列后按在飞数（都为 0）再按模型名字典序定胜负
		expect(result.model).toBe("p:a");
		expect(result.effectivePriority).toBe(1);
	});

	test("同优先级下挑在飞数最少的模型（负载均摊）", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:a", priority: 1 },
			{ model: "p:b", priority: 1 },
			{ model: "p:c", priority: 1 },
		];
		const result = selectModelFromPool({
			pool,
			inFlight: flight({ "p:a": 3, "p:b": 1, "p:c": 2 }),
		});
		expect(result.kind).toBe("selected");
		if (result.kind !== "selected") return;
		expect(result.model).toBe("p:b");
		expect(result.inFlight).toBe(1);
	});

	test("连续派发会把负载铺匀而不是压在一个模型上", () => {
		const pool: OrchestrationPoolEntry[] = [{ model: "p:a" }, { model: "p:b" }];
		const counts = new Map<string, number>();
		const picks: string[] = [];
		for (let i = 0; i < 4; i += 1) {
			const result = selectModelFromPool({ pool, inFlight: counts });
			expect(result.kind).toBe("selected");
			if (result.kind !== "selected") return;
			picks.push(result.model);
			counts.set(result.model, (counts.get(result.model) ?? 0) + 1);
		}
		expect(picks).toEqual(["p:a", "p:b", "p:a", "p:b"]);
	});

	test("受并发上限约束的条目被跳过，仍可挑到不限条目", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:limited", priority: 1, maxConcurrent: 1 },
			{ model: "p:open", priority: 9 },
		];
		const result = selectModelFromPool({ pool, inFlight: flight({ "p:limited": 1 }) });
		expect(result.kind).toBe("selected");
		if (result.kind !== "selected") return;
		expect(result.model).toBe("p:open");
		expect(result.effectivePriority).toBe(9);
	});

	test("全部条目都到顶时返回 waiting，并按模型名升序列出阻塞项", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:c", maxConcurrent: 2 },
			{ model: "p:a", maxConcurrent: 1 },
			{ model: "p:b", maxConcurrent: 3 },
		];
		const result = selectModelFromPool({
			pool,
			inFlight: flight({ "p:a": 1, "p:b": 3, "p:c": 2 }),
		});
		expect(result).toEqual({
			kind: "waiting",
			blockedBy: [
				{ model: "p:a", inFlight: 1, maxConcurrent: 1 },
				{ model: "p:b", inFlight: 3, maxConcurrent: 3 },
				{ model: "p:c", inFlight: 2, maxConcurrent: 2 },
			],
		});
	});

	test("waiting 的 blockedBy 不含不限并发的条目（0 与负数都不算受限）", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:unlimitedZero", maxConcurrent: 0 },
			{ model: "p:unlimitedNegative", maxConcurrent: -5 },
			{ model: "p:blocked", maxConcurrent: 1 },
		];
		// 不限条目永远可用，因此这里其实是「选中」而非「等待」
		const selected = selectModelFromPool({ pool, inFlight: flight({ "p:blocked": 1 }) });
		expect(selected.kind).toBe("selected");

		// 只有把不限条目也塞满（不可能，所以改用仅含受限条目的池）才能触发 waiting，
		// 这里直接验证 blockedBy 的过滤逻辑：受限条目满、不限条目在飞很高也不会被列出
		const onlyBlocked = selectModelFromPool({
			pool: [{ model: "p:blocked", maxConcurrent: 1 }],
			inFlight: flight({ "p:blocked": 1 }),
		});
		expect(onlyBlocked).toEqual({
			kind: "waiting",
			blockedBy: [{ model: "p:blocked", inFlight: 1, maxConcurrent: 1 }],
		});
	});

	test("maxConcurrent 为负数按不限处理，不抛异常", () => {
		const pool: OrchestrationPoolEntry[] = [{ model: "p:a", maxConcurrent: -1 }];
		const result = selectModelFromPool({ pool, inFlight: flight({ "p:a": 999 }) });
		expect(result.kind).toBe("selected");
		if (result.kind !== "selected") return;
		expect(result.model).toBe("p:a");
		expect(result.inFlight).toBe(999);
	});

	test("maxConcurrent 省略或为 0 视为不限", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:omitted" },
			{ model: "p:zero", maxConcurrent: 0 },
		];
		const result = selectModelFromPool({
			pool,
			inFlight: flight({ "p:omitted": 100, "p:zero": 50 }),
		});
		expect(result.kind).toBe("selected");
		if (result.kind !== "selected") return;
		// 两条都不限，按在飞数最少者胜出
		expect(result.model).toBe("p:zero");
	});

	test("优先级、在飞数、模型名三级判定，结果完全确定", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:zeta", priority: 1 },
			{ model: "p:alpha", priority: 1 },
			{ model: "p:beta", priority: 1 },
		];
		const first = selectModelFromPool({ pool, inFlight: flight() });
		const second = selectModelFromPool({ pool: [...pool].reverse(), inFlight: flight() });
		expect(first.kind).toBe("selected");
		expect(second.kind).toBe("selected");
		if (first.kind !== "selected" || second.kind !== "selected") return;
		// 三者优先级与在飞数都一样，取模型名字典序最小者；且与池中书写顺序无关
		expect(first.model).toBe("p:alpha");
		expect(second.model).toBe("p:alpha");
	});

	test("重复 model 按第一条为准，不重复计数", () => {
		const pool: OrchestrationPoolEntry[] = [
			{ model: "p:a", priority: 5, maxConcurrent: 1 },
			{ model: "p:a", priority: 1, maxConcurrent: 9 },
			{ model: "p:b", priority: 9 },
		];
		const result = selectModelFromPool({ pool, inFlight: flight({ "p:a": 1 }) });
		expect(result.kind).toBe("selected");
		if (result.kind !== "selected") return;
		// 以第一条为准：p:a 上限 1 且已满，因此被跳过，选中无需受限的 p:b
		expect(result.model).toBe("p:b");

		// 未满时回报的也是第一条的优先级
		const loose = selectModelFromPool({ pool, inFlight: flight() });
		expect(loose.kind).toBe("selected");
		if (loose.kind !== "selected") return;
		expect(loose.model).toBe("p:a");
		expect(loose.effectivePriority).toBe(5);
	});

	test("不修改传入的 pool 与 inFlight", () => {
		const pool: OrchestrationPoolEntry[] = [{ model: "p:a" }, { model: "p:b", maxConcurrent: 1 }];
		const poolSnapshot = JSON.parse(JSON.stringify(pool));
		const counts = flight({ "p:b": 1 });
		selectModelFromPool({ pool, inFlight: counts });
		expect(pool).toEqual(poolSnapshot as OrchestrationPoolEntry[]);
		expect([...counts.entries()]).toEqual([["p:b", 1]]);
	});
});

// --- runtime：设置读取与在飞计数 ---

/** 构造一个四档齐全的测试方案。 */
function makeProfile(overrides: Partial<OrchestrationProfile> = {}): OrchestrationProfile {
	return {
		id: "of7k2m9q",
		name: "默认方案",
		enabled: true,
		review: {
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: {
			chore: { pool: [{ model: "p:chore" }] },
			quick: { pool: [{ model: "p:quick" }] },
			medium: { pool: [{ model: "p:medium" }] },
			heavy: { pool: [{ model: "p:heavy" }] },
		},
		...overrides,
	};
}

describe("runtime", () => {
	// 直接改写 settings 单例，测完必须还原，否则会影响同进程内的其他测试文件
	const originalOrchestration = settings.agent.orchestration;

	beforeEach(() => {
		__resetInFlightForTests();
	});

	afterEach(() => {
		__resetInFlightForTests();
		settings.agent.orchestration = originalOrchestration;
	});

	test("listEnabledProfiles 过滤未启用项", () => {
		settings.agent.orchestration = {
			orchestratorModels: ["p:orch"],
			profiles: [makeProfile({ id: "aaaa" }), makeProfile({ id: "bbbb", enabled: false })],
		};
		expect(listEnabledProfiles().map((profile) => profile.id)).toEqual(["aaaa"]);
	});

	test("listEnabledProfiles 跳过 tiers 缺失的坏数据", () => {
		const broken = { id: "cccc", name: "坏数据", enabled: true } as unknown as OrchestrationProfile;
		const missingTier = {
			id: "dddd",
			name: "缺档",
			enabled: true,
			review: makeProfile().review,
			tiers: { chore: { pool: [] }, quick: { pool: [] }, medium: { pool: [] } },
		} as unknown as OrchestrationProfile;
		settings.agent.orchestration = {
			orchestratorModels: [],
			profiles: [broken, missingTier, makeProfile({ id: "eeee" })],
		};
		expect(listEnabledProfiles().map((profile) => profile.id)).toEqual(["eeee"]);
	});

	test("settings 中根本没有 orchestration 时返回空列表", () => {
		settings.agent.orchestration = undefined;
		expect(listEnabledProfiles()).toEqual([]);
		expect(findEnabledProfile("of7k2m9q")).toBeUndefined();
	});

	test("findEnabledProfile 对 null/undefined/未知 id 返回 undefined", () => {
		settings.agent.orchestration = { orchestratorModels: [], profiles: [makeProfile()] };
		expect(findEnabledProfile(null)).toBeUndefined();
		expect(findEnabledProfile(undefined)).toBeUndefined();
		expect(findEnabledProfile("")).toBeUndefined();
		expect(findEnabledProfile("nope")).toBeUndefined();
		expect(findEnabledProfile("of7k2m9q")?.id).toBe("of7k2m9q");
	});

	test("acquireModelSlot 计数并在释放后归零", () => {
		const release = acquireModelSlot("p:a");
		expect(getInFlight("p:a")).toBe(1);
		release();
		expect(getInFlight("p:a")).toBe(0);
		// 归零的模型不留在快照里
		expect(inFlightSnapshot().has("p:a")).toBe(false);
	});

	test("释放函数幂等：重复调用只减一次", () => {
		const releaseA = acquireModelSlot("p:a");
		const releaseB = acquireModelSlot("p:a");
		expect(getInFlight("p:a")).toBe(2);

		releaseA();
		expect(getInFlight("p:a")).toBe(1);
		// finally 重复执行时不能把计数打成负数
		releaseA();
		releaseA();
		expect(getInFlight("p:a")).toBe(1);

		releaseB();
		releaseB();
		expect(getInFlight("p:a")).toBe(0);
	});

	test("inFlightSnapshot 是副本，改动不影响内部计数", () => {
		acquireModelSlot("p:a");
		const snapshot = inFlightSnapshot() as Map<string, number>;
		snapshot.set("p:a", 99);
		snapshot.set("p:b", 7);
		expect(getInFlight("p:a")).toBe(1);
		expect(getInFlight("p:b")).toBe(0);
	});

	test("selectModelForTier 按档位取池并遵循并发上限", () => {
		settings.agent.orchestration = {
			orchestratorModels: ["p:orch"],
			profiles: [
				makeProfile({
					id: "of7k2m9q",
					tiers: {
						chore: { pool: [{ model: "p:chore" }] },
						quick: { pool: [{ model: "p:quick" }] },
						medium: { pool: [{ model: "p:medium" }] },
						heavy: { pool: [{ model: "p:heavy", maxConcurrent: 1 }] },
					},
				}),
			],
		};
		expect(selectModelForTier("of7k2m9q", "heavy")).toBe("p:heavy");
		const release = acquireModelSlot("p:heavy");
		// 池里只有这一条且已到上限，选择器应回报「选不出」而不是硬塞
		expect(selectModelForTier("of7k2m9q", "heavy")).toBeNull();
		release();
		expect(selectModelForTier("of7k2m9q", "heavy")).toBe("p:heavy");
	});

	test("selectModelForTier 对未知方案或空池返回 null", () => {
		settings.agent.orchestration = {
			orchestratorModels: [],
			profiles: [
				makeProfile({
					id: "of7k2m9q",
					tiers: {
						chore: { pool: [] },
						quick: { pool: [] },
						medium: { pool: [] },
						heavy: { pool: [] },
					},
				}),
			],
		};
		expect(selectModelForTier("nope", "chore")).toBeNull();
		expect(selectModelForTier("of7k2m9q", "chore")).toBeNull();
	});
});
