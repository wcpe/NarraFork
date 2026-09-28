/**
 * 编排面板的实时覆盖层（纯逻辑）。
 *
 * 这里用**事件桩**驱动整条链路：喂进与真实 WS 帧同形状的对象，断言面板最终拿到的
 * 行数据确实变了。这样"面板是事件驱动的"不靠读代码相信，而是可以被断言的东西。
 *
 * 另外两条边界同样是重点：
 * - **未知 worker 的事件**不能崩、不能凭空造行（它可能属于别的编排会话）；
 * - **未知上下文**必须保持 `null`（"未知"），不能变成 0。
 */

import { describe, expect, it } from "bun:test";
import type { OrchestrationWorkerStatus } from "@shared/orchestration-status";
import {
	applyOrchestrationWorkerUpdate,
	EMPTY_ORCHESTRATION_WORKER_OVERLAY,
	MAX_ORCHESTRATION_WORKER_OVERLAY_ENTRIES,
	mergeOrchestrationWorkers,
	ORCHESTRATION_BASELINE_REFETCH_MS,
	ORCHESTRATION_FALLBACK_REFETCH_MS,
	orchestrationRefetchIntervalMs,
	orchestrationWorkerActivityMs,
	readOrchestrationWorkerUpdate,
} from "./orchestration-worker-live";

const PARENT = "parent-1";
/** 必须比快照里的 `lastActivityAt`（2026-01-01）更新，否则"取更新的那个"测不出来。 */
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

function worker(over: Partial<OrchestrationWorkerStatus> = {}): OrchestrationWorkerStatus {
	return {
		narratorId: "w1",
		role: "worker",
		tier: "quick",
		model: "provA:worker",
		status: "working",
		reused: null,
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		contextPercent: null,
		...over,
	};
}

/** 与 `narrator-event-handler` 广播的形状一致：发给父级时带 `subagentNarratorId`。 */
function statusFrame(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "subagent_status_changed",
		narratorId: PARENT,
		subagentNarratorId: "w1",
		status: "idle",
		...over,
	};
}

function contextFrame(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "context_usage",
		narratorId: PARENT,
		subagentNarratorId: "w1",
		percentage: 61,
		isSubagent: true,
		...over,
	};
}

describe("readOrchestrationWorkerUpdate", () => {
	it("读得出状态帧与上下文帧", () => {
		expect(readOrchestrationWorkerUpdate(statusFrame(), PARENT, NOW)).toEqual({
			workerId: "w1",
			status: "idle",
			receivedAtMs: NOW,
		});
		expect(readOrchestrationWorkerUpdate(contextFrame(), PARENT, NOW)).toEqual({
			workerId: "w1",
			contextPercent: 61,
			receivedAtMs: NOW,
		});
	});

	it("别的父级的帧一律丢弃（订阅过滤不是数据完整性保证）", () => {
		expect(
			readOrchestrationWorkerUpdate(statusFrame({ narratorId: "someone-else" }), PARENT, NOW),
		).toBeNull();
	});

	it("缺 subagentNarratorId 的帧丢弃，不猜测归属", () => {
		const frame = statusFrame();
		delete frame.subagentNarratorId;
		expect(readOrchestrationWorkerUpdate(frame, PARENT, NOW)).toBeNull();
		expect(
			readOrchestrationWorkerUpdate(contextFrame({ subagentNarratorId: undefined }), PARENT, NOW),
		).toBeNull();
	});

	it("父级自己那条普通 context_usage 不算任何 worker 的", () => {
		// `isSubagent` 缺失/为假时它是父级自身的占用率，混进来会把它算成一只 worker。
		expect(
			readOrchestrationWorkerUpdate(contextFrame({ isSubagent: false }), PARENT, NOW),
		).toBeNull();
		const frame = contextFrame();
		delete frame.isSubagent;
		expect(readOrchestrationWorkerUpdate(frame, PARENT, NOW)).toBeNull();
	});

	it("未知事件类型、坏数据类型都不抛异常，返回 null", () => {
		const garbage: unknown[] = [
			{},
			{ type: "subagent_status_changed", narratorId: PARENT, subagentNarratorId: "w1" },
			statusFrame({ status: 42 }),
			statusFrame({ status: "" }),
			contextFrame({ percentage: "61" }),
			contextFrame({ percentage: Number.NaN }),
			contextFrame({ percentage: Number.POSITIVE_INFINITY }),
			{ type: "totally_unknown", narratorId: PARENT, subagentNarratorId: "w1" },
		];
		for (const frame of garbage) {
			expect(
				readOrchestrationWorkerUpdate(frame as Record<string, unknown>, PARENT, NOW),
			).toBeNull();
		}
	});

	it("状态帧里多余的字段（如 substatus）不影响读出的结果", () => {
		// 面板不展示 substatus，因此它既不该被带进覆盖层，也不该让整帧被拒。
		const update = readOrchestrationWorkerUpdate(
			statusFrame({ substatus: ["reasoning", 7, null] }),
			PARENT,
			NOW,
		);
		expect(update).toEqual({ workerId: "w1", status: "idle", receivedAtMs: NOW });
	});
});

describe("orchestration_observation 的顺序合并", () => {
	it("按 runId + workerId + sequence 忽略乱序和重复帧", () => {
		const frame = (sequence: number, phase: string) => ({
			type: "orchestration_observation",
			narratorId: PARENT,
			observation: {
				runId: "run-1",
				workerNarratorId: "w1",
				workerRole: "worker",
				tier: "quick",
				phase,
				sequence,
				source: "runner",
				occurredAt: "2026-06-01T00:00:00.000Z",
				details: { toolName: phase },
			},
		});
		let overlay = EMPTY_ORCHESTRATION_WORKER_OVERLAY;
		overlay = applyOrchestrationWorkerUpdate(
			overlay,
			readOrchestrationWorkerUpdate(frame(2, "tool"), PARENT, NOW) as never,
		);
		overlay = applyOrchestrationWorkerUpdate(
			overlay,
			readOrchestrationWorkerUpdate(frame(1, "dispatch"), PARENT, NOW + 1) as never,
		);
		overlay = applyOrchestrationWorkerUpdate(
			overlay,
			readOrchestrationWorkerUpdate(frame(2, "tool"), PARENT, NOW + 2) as never,
		);
		expect(overlay.get("w1")?.sequence).toBe(2);
		expect(overlay.get("w1")?.phase).toBe("tool");
	});

	it("把 contextSource/source 归一化为 measured、estimated 或 unknown", () => {
		const observation = (details: Record<string, unknown>) =>
			readOrchestrationWorkerUpdate(
				{
					type: "orchestration_observation",
					narratorId: PARENT,
					observation: {
						runId: "run-source",
						workerNarratorId: "w1",
						workerRole: "worker",
						tier: "quick",
						phase: "context",
						sequence: 1,
						source: "runtime",
						occurredAt: "2026-06-01T00:00:00.000Z",
						details,
					},
				},
				PARENT,
				NOW,
			);

		expect(observation({ contextSource: "provider" })?.contextSource).toBe("measured");
		expect(observation({ contextSource: "measured" })?.contextSource).toBe("measured");
		expect(observation({ source: "estimated" })?.contextSource).toBe("estimated");
		expect(observation({ source: "runner" })?.contextSource).toBe("unknown");
	});
});

describe("applyOrchestrationWorkerUpdate", () => {
	it("状态与上下文来自两个不同的帧，后到的不会抹掉先到的", () => {
		let overlay = EMPTY_ORCHESTRATION_WORKER_OVERLAY;
		overlay = applyOrchestrationWorkerUpdate(
			overlay,
			readOrchestrationWorkerUpdate(statusFrame(), PARENT, NOW) as never,
		);
		overlay = applyOrchestrationWorkerUpdate(
			overlay,
			readOrchestrationWorkerUpdate(contextFrame(), PARENT, NOW + 1) as never,
		);
		expect(overlay.get("w1")).toEqual({
			workerId: "w1",
			status: "idle",
			contextPercent: 61,
			receivedAtMs: NOW + 1,
		});
	});

	it("重复收到同一条事件是幂等的", () => {
		const update = readOrchestrationWorkerUpdate(contextFrame(), PARENT, NOW) as never;
		const once = applyOrchestrationWorkerUpdate(EMPTY_ORCHESTRATION_WORKER_OVERLAY, update);
		const twice = applyOrchestrationWorkerUpdate(once, update);
		expect(twice.get("w1")).toEqual(once.get("w1"));
		expect(twice.size).toBe(1);
	});

	it("不接受跳过身份的事件（把归属未知的东西写进覆盖层只会污染渲染）", () => {
		const overlay = applyOrchestrationWorkerUpdate(EMPTY_ORCHESTRATION_WORKER_OVERLAY, {
			workerId: "w1",
			receivedAtMs: NOW,
		});
		expect(overlay.get("w1")).toEqual({ workerId: "w1", receivedAtMs: NOW });
	});

	it("条目有上限，到顶后淘汰最早收到事件的那一条", () => {
		let overlay = EMPTY_ORCHESTRATION_WORKER_OVERLAY;
		const total = MAX_ORCHESTRATION_WORKER_OVERLAY_ENTRIES + 10;
		for (let index = 0; index < total; index++) {
			overlay = applyOrchestrationWorkerUpdate(overlay, {
				workerId: `w${index}`,
				contextPercent: index,
				receivedAtMs: NOW + index,
			});
		}
		expect(overlay.size).toBe(MAX_ORCHESTRATION_WORKER_OVERLAY_ENTRIES);
		// 最早的那些被淘汰，最新的那些还在。
		expect(overlay.has("w0")).toBe(false);
		expect(overlay.has(`w${total - 1}`)).toBe(true);
	});
});

describe("mergeOrchestrationWorkers", () => {
	it("事件驱动更新：状态与上下文随事件变化，且标记为实时", () => {
		const workers = [worker()];
		const before = mergeOrchestrationWorkers({
			workers,
			overlay: EMPTY_ORCHESTRATION_WORKER_OVERLAY,
		});
		expect(before[0]).toMatchObject({ status: "working", contextPercent: null, live: false });

		let overlay = EMPTY_ORCHESTRATION_WORKER_OVERLAY;
		overlay = applyOrchestrationWorkerUpdate(
			overlay,
			readOrchestrationWorkerUpdate(statusFrame(), PARENT, NOW) as never,
		);
		overlay = applyOrchestrationWorkerUpdate(
			overlay,
			readOrchestrationWorkerUpdate(contextFrame(), PARENT, NOW) as never,
		);
		const after = mergeOrchestrationWorkers({ workers, overlay });
		expect(after[0]).toMatchObject({
			status: "idle",
			contextPercent: 61,
			live: true,
			liveAtMs: NOW,
			// 快照里的字段没有被事件波及。
			tier: "quick",
			model: "provA:worker",
		});
	});

	it("未知 worker 的事件不会凭空造行", () => {
		const overlay = applyOrchestrationWorkerUpdate(EMPTY_ORCHESTRATION_WORKER_OVERLAY, {
			workerId: "ghost",
			status: "working",
			contextPercent: 99,
			receivedAtMs: NOW,
		});
		const merged = mergeOrchestrationWorkers({ workers: [worker()], overlay });
		expect(merged).toHaveLength(1);
		expect(merged[0]?.narratorId).toBe("w1");
	});

	it("事件没带上下文字段时保留快照里的值（含 null）", () => {
		const merged = mergeOrchestrationWorkers({
			workers: [worker({ contextPercent: null })],
			overlay: applyOrchestrationWorkerUpdate(EMPTY_ORCHESTRATION_WORKER_OVERLAY, {
				workerId: "w1",
				status: "waiting",
				receivedAtMs: NOW,
			}),
		});
		expect(merged[0]?.contextPercent).toBeNull();
		expect(merged[0]?.status).toBe("waiting");
	});
});

describe("orchestrationWorkerActivityMs", () => {
	it("取事件时间与快照时间中更新的那个", () => {
		const snapshotMs = Date.parse("2026-01-01T00:00:00.000Z");
		expect(
			orchestrationWorkerActivityMs({
				lastActivityAt: new Date(snapshotMs).toISOString(),
				liveAtMs: NOW,
			}),
		).toBe(NOW);
		expect(
			orchestrationWorkerActivityMs({
				lastActivityAt: new Date(snapshotMs).toISOString(),
				liveAtMs: snapshotMs - 1000,
			}),
		).toBe(snapshotMs);
	});

	it("两边都没有记录时是 null（不是 0、也不是「很久以前」）", () => {
		expect(orchestrationWorkerActivityMs({ lastActivityAt: null, liveAtMs: null })).toBeNull();
		expect(
			orchestrationWorkerActivityMs({ lastActivityAt: "not-a-date", liveAtMs: null }),
		).toBeNull();
	});
});

describe("orchestrationRefetchIntervalMs", () => {
	it("事件在流动时降级为低频兜底轮询", () => {
		expect(orchestrationRefetchIntervalMs({ lastEventAtMs: NOW - 1000, now: NOW })).toBe(
			ORCHESTRATION_FALLBACK_REFETCH_MS,
		);
	});

	it("事件长时间未达时回到基线间隔（事件通道没生效就只剩轮询）", () => {
		expect(
			orchestrationRefetchIntervalMs({
				lastEventAtMs: NOW - ORCHESTRATION_FALLBACK_REFETCH_MS * 2,
				now: NOW,
			}),
		).toBe(ORCHESTRATION_BASELINE_REFETCH_MS);
		expect(orchestrationRefetchIntervalMs({ lastEventAtMs: null, now: NOW })).toBe(
			ORCHESTRATION_BASELINE_REFETCH_MS,
		);
	});

	it("兜底间隔不短于基线（「实时」不能靠更快的轮询假装出来）", () => {
		expect(ORCHESTRATION_FALLBACK_REFETCH_MS).toBeGreaterThanOrEqual(
			ORCHESTRATION_BASELINE_REFETCH_MS,
		);
	});
});
