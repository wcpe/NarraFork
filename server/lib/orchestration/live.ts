import { generateId } from "@server/lib/id";
import type {
	OrchestrationLiveIdentity,
	OrchestrationLiveObservation,
	OrchestrationLivePhase,
	OrchestrationLiveSource,
	OrchestrationLiveWorkerRole,
} from "@shared/orchestration-live";
import type { OrchestrationWorkerTier } from "@shared/orchestration-worker-type";
import { parseOrchestrationType, parseReviewerType } from "./types";

interface LiveRunState {
	identity: OrchestrationLiveIdentity;
	nextSequence: number;
	lastPublishedSequence: number;
	createdAt: number;
}

const MAX_LIVE_RUNS = 1024;
const runs = new Map<string, LiveRunState>();
const workerToRun = new Map<string, string>();
const dispatchToRun = new Map<string, string>();

function trimLiveRuns(): void {
	if (runs.size <= MAX_LIVE_RUNS) return;
	const oldest = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
	if (!oldest) return;
	runs.delete(oldest.identity.runId);
	if (
		oldest.identity.workerNarratorId &&
		workerToRun.get(oldest.identity.workerNarratorId) === oldest.identity.runId
	) {
		workerToRun.delete(oldest.identity.workerNarratorId);
	}
	if (oldest.identity.parentToolUseId) {
		const dispatchKey = `${oldest.identity.coordinatorNarratorId}:${oldest.identity.parentToolUseId}`;
		if (dispatchToRun.get(dispatchKey) === oldest.identity.runId) dispatchToRun.delete(dispatchKey);
	}
}

export function beginOrchestrationLiveRun(input: {
	runId?: string | null;
	coordinatorNarratorId: string;
	tier: OrchestrationWorkerTier;
	parentToolUseId: string;
}): OrchestrationLiveIdentity {
	const identity: OrchestrationLiveIdentity = {
		runId: input.runId ?? generateId(),
		coordinatorNarratorId: input.coordinatorNarratorId,
		workerRole: "worker",
		tier: input.tier,
		parentToolUseId: input.parentToolUseId,
	};
	if (runs.has(identity.runId)) releaseOrchestrationLiveRun(identity.runId);
	runs.set(identity.runId, {
		identity,
		nextSequence: 1,
		lastPublishedSequence: 0,
		createdAt: Date.now(),
	});
	dispatchToRun.set(`${input.coordinatorNarratorId}:${input.parentToolUseId}`, identity.runId);
	trimLiveRuns();
	return identity;
}

export function bindOrchestrationWorker(
	identity: OrchestrationLiveIdentity,
	workerNarratorId: string,
	workerRole: OrchestrationLiveWorkerRole = identity.workerRole,
): OrchestrationLiveIdentity {
	const next = { ...identity, workerNarratorId, workerRole };
	const state = runs.get(identity.runId);
	if (state) {
		const previousWorkerId = state.identity.workerNarratorId;
		if (previousWorkerId && previousWorkerId !== workerNarratorId) {
			if (workerToRun.get(previousWorkerId) === identity.runId)
				workerToRun.delete(previousWorkerId);
		}
		state.identity = next;
		workerToRun.set(workerNarratorId, identity.runId);
	}
	return next;
}

export function resolveOrchestrationLiveIdentity(input: {
	workerNarratorId?: string;
	coordinatorNarratorId?: string;
	parentToolUseId?: string;
	subagentType?: string | null;
}): OrchestrationLiveIdentity | undefined {
	let runId = input.workerNarratorId ? workerToRun.get(input.workerNarratorId) : undefined;
	if (!runId && input.coordinatorNarratorId && input.parentToolUseId) {
		runId = dispatchToRun.get(`${input.coordinatorNarratorId}:${input.parentToolUseId}`);
	}
	if (!runId) return undefined;
	const state = runs.get(runId);
	if (!state) return undefined;
	const reviewer = parseReviewerType(input.subagentType);
	if (reviewer.ok) {
		return {
			...state.identity,
			workerRole: "reviewer",
			tier: reviewer.tier,
			...(input.workerNarratorId ? { workerNarratorId: input.workerNarratorId } : {}),
		};
	}
	return state.identity;
}

export function inferOrchestrationIdentity(input: {
	coordinatorNarratorId: string;
	parentToolUseId: string;
	subagentType: string | null | undefined;
	workerNarratorId?: string;
}): OrchestrationLiveIdentity | undefined {
	const parsedWorker = parseOrchestrationType(input.subagentType);
	const parsedReviewer = parseReviewerType(input.subagentType);
	const existing = resolveOrchestrationLiveIdentity(input);
	if (!existing) return undefined;
	if (parsedReviewer.ok) {
		return {
			...existing,
			workerRole: "reviewer",
			tier: parsedReviewer.tier,
			...(input.workerNarratorId ? { workerNarratorId: input.workerNarratorId } : {}),
		};
	}
	if (parsedWorker.ok) {
		return {
			...existing,
			workerRole: "worker",
			tier: parsedWorker.tier,
			...(input.workerNarratorId ? { workerNarratorId: input.workerNarratorId } : {}),
		};
	}
	return existing;
}

export function nextOrchestrationObservation(
	identity: OrchestrationLiveIdentity,
	input: {
		phase: OrchestrationLivePhase;
		source: OrchestrationLiveSource;
		details?: Record<string, string | number | boolean | null>;
		sequence?: number;
	},
): OrchestrationLiveObservation | null {
	const state = runs.get(identity.runId);
	if (!state) return null;
	const sequence = input.sequence ?? state.nextSequence++;
	if (!Number.isSafeInteger(sequence) || sequence <= state.lastPublishedSequence) return null;
	state.lastPublishedSequence = sequence;
	if (sequence >= state.nextSequence) state.nextSequence = sequence + 1;
	const occurredAt = new Date().toISOString();
	const observation: OrchestrationLiveObservation = {
		runId: identity.runId,
		coordinatorNarratorId: identity.coordinatorNarratorId,
		workerNarratorId: identity.workerNarratorId ?? identity.coordinatorNarratorId,
		workerRole: identity.workerRole,
		tier: identity.tier,
		phase: input.phase,
		sequence,
		source: input.source,
		occurredAt,
		...(input.details ? { details: input.details } : {}),
	};
	const currentPhase =
		input.phase === "dispatch"
			? "dispatching"
			: input.phase === "review" && input.details?.reviewKind === "self"
				? "self_reviewing"
				: input.phase === "review" && identity.workerRole === "reviewer"
					? "reviewing"
					: "executing";
	void import("./audit")
		.then(({ recordOrchestrationRunProgress }) =>
			recordOrchestrationRunProgress(identity.runId, {
				currentPhase,
				lastProgressSeq: sequence,
				lastProgressAt: occurredAt,
			}),
		)
		.catch(() => {});
	return observation;
}

export function releaseOrchestrationLiveRun(runId: string): void {
	const state = runs.get(runId);
	if (!state) return;
	runs.delete(runId);
	if (
		state.identity.workerNarratorId &&
		workerToRun.get(state.identity.workerNarratorId) === runId
	) {
		workerToRun.delete(state.identity.workerNarratorId);
	}
	if (state.identity.parentToolUseId) {
		const dispatchKey = `${state.identity.coordinatorNarratorId}:${state.identity.parentToolUseId}`;
		if (dispatchToRun.get(dispatchKey) === runId) dispatchToRun.delete(dispatchKey);
	}
}

export function __resetOrchestrationLiveForTests(): void {
	runs.clear();
	workerToRun.clear();
	dispatchToRun.clear();
}
