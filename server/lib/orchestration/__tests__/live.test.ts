import { describe, expect, test } from "bun:test";
import {
	__resetOrchestrationLiveForTests,
	beginOrchestrationLiveRun,
	bindOrchestrationWorker,
	nextOrchestrationObservation,
	releaseOrchestrationLiveRun,
	resolveOrchestrationLiveIdentity,
} from "../live";
import { buildOrchestrationType, buildReviewerSubagentType } from "../types";

describe("编排实时运行身份", () => {
	test("两个 worker 的 run 与序号互不串线", () => {
		__resetOrchestrationLiveForTests();
		const first = beginOrchestrationLiveRun({
			coordinatorNarratorId: "coordinator-a",
			tier: "quick",
			parentToolUseId: "tool-a",
		});
		const second = beginOrchestrationLiveRun({
			coordinatorNarratorId: "coordinator-b",
			tier: "heavy",
			parentToolUseId: "tool-b",
		});
		const firstWorker = bindOrchestrationWorker(first, "worker-a");
		const secondWorker = bindOrchestrationWorker(second, "worker-b");

		const firstObservation = nextOrchestrationObservation(firstWorker, {
			phase: "worker_start",
			source: "runner",
		});
		const secondObservation = nextOrchestrationObservation(secondWorker, {
			phase: "worker_start",
			source: "runner",
		});

		expect(firstObservation?.runId).toBe(first.runId);
		expect(firstObservation?.workerNarratorId).toBe("worker-a");
		expect(firstObservation?.sequence).toBe(1);
		expect(secondObservation?.runId).toBe(second.runId);
		expect(secondObservation?.workerNarratorId).toBe("worker-b");
		expect(secondObservation?.sequence).toBe(1);
	});

	test("拒绝重复与乱序 sequence", () => {
		__resetOrchestrationLiveForTests();
		const run = beginOrchestrationLiveRun({
			coordinatorNarratorId: "coordinator",
			tier: "medium",
			parentToolUseId: "tool",
		});
		const worker = bindOrchestrationWorker(run, "worker");

		expect(
			nextOrchestrationObservation(worker, {
				phase: "dispatch",
				source: "dispatch",
				sequence: 3,
			}),
		).not.toBeNull();
		expect(
			nextOrchestrationObservation(worker, {
				phase: "context",
				source: "event_handler",
				sequence: 3,
			}),
		).toBeNull();
		expect(
			nextOrchestrationObservation(worker, {
				phase: "tool",
				source: "event_handler",
				sequence: 2,
			}),
		).toBeNull();
		expect(
			nextOrchestrationObservation(worker, {
				phase: "terminal",
				source: "runner",
			}),
		).toMatchObject({ sequence: 4 });
	});

	test("旧 run 释放时不会删除新 run 的 worker 或 dispatch 映射", () => {
		__resetOrchestrationLiveForTests();
		const first = bindOrchestrationWorker(
			beginOrchestrationLiveRun({
				coordinatorNarratorId: "coordinator",
				tier: "quick",
				parentToolUseId: "tool",
			}),
			"worker",
		);
		const second = bindOrchestrationWorker(
			beginOrchestrationLiveRun({
				coordinatorNarratorId: "coordinator",
				tier: "heavy",
				parentToolUseId: "tool",
			}),
			"worker",
		);
		releaseOrchestrationLiveRun(first.runId);
		expect(resolveOrchestrationLiveIdentity({ workerNarratorId: "worker" })?.runId).toBe(
			second.runId,
		);
		expect(
			resolveOrchestrationLiveIdentity({
				coordinatorNarratorId: "coordinator",
				parentToolUseId: "tool",
			})?.runId,
		).toBe(second.runId);
	});

	test("后台/复用沿用同一个 run，reviewer 使用独立角色与档位", () => {
		__resetOrchestrationLiveForTests();
		const run = beginOrchestrationLiveRun({
			runId: "run-fixed",
			coordinatorNarratorId: "coordinator",
			tier: "heavy",
			parentToolUseId: "tool",
		});
		bindOrchestrationWorker(run, "worker");
		expect(resolveOrchestrationLiveIdentity({ workerNarratorId: "worker" })).toMatchObject({
			runId: "run-fixed",
			tier: "heavy",
			workerRole: "worker",
		});

		const reviewerType = buildReviewerSubagentType("profile", "quick");
		const reviewer = resolveOrchestrationLiveIdentity({
			coordinatorNarratorId: "coordinator",
			parentToolUseId: "tool",
			subagentType: reviewerType,
			workerNarratorId: "reviewer",
		});
		expect(reviewer).toMatchObject({
			runId: "run-fixed",
			workerNarratorId: "reviewer",
			workerRole: "reviewer",
			tier: "quick",
		});
		expect(buildOrchestrationType("profile", "heavy")).toContain("heavy");
	});
});
