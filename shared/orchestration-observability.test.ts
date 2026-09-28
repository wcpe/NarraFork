import { describe, expect, test } from "bun:test";
import {
	MAX_ORCHESTRATION_OBSERVATION_TOKENS,
	MAX_ORCHESTRATION_PROGRESS_SEQ,
	normalizeOrchestrationContextSource,
	normalizeOrchestrationInputTokenSemantics,
	normalizeOrchestrationObservationInteger,
	normalizeOrchestrationRequestRole,
	normalizeOrchestrationRunCurrentPhase,
	normalizeOrchestrationUsageSource,
} from "./orchestration-observability";

describe("编排观测共享契约", () => {
	test("旧行缺失或未知值统一读取为 unknown", () => {
		expect(normalizeOrchestrationRequestRole(null)).toBe("unknown");
		expect(normalizeOrchestrationUsageSource(undefined)).toBe("unknown");
		expect(normalizeOrchestrationContextSource("future_source")).toBe("unknown");
		expect(normalizeOrchestrationInputTokenSemantics("legacy_input")).toBe("unknown");
		expect(normalizeOrchestrationRunCurrentPhase(null)).toBe("unknown");
	});

	test("已知观测枚举保持原值", () => {
		expect(normalizeOrchestrationRequestRole("worker")).toBe("worker");
		expect(normalizeOrchestrationUsageSource("provider")).toBe("provider");
		expect(normalizeOrchestrationContextSource("estimated")).toBe("estimated");
		expect(normalizeOrchestrationInputTokenSemantics("prompt_total")).toBe("prompt_total");
		expect(normalizeOrchestrationRunCurrentPhase("reviewing")).toBe("reviewing");
	});

	test("进度与 token 数值拒绝越界、负数和小数", () => {
		expect(normalizeOrchestrationObservationInteger(42, MAX_ORCHESTRATION_PROGRESS_SEQ)).toBe(42);
		expect(normalizeOrchestrationObservationInteger(-1, MAX_ORCHESTRATION_PROGRESS_SEQ)).toBeNull();
		expect(
			normalizeOrchestrationObservationInteger(1.5, MAX_ORCHESTRATION_PROGRESS_SEQ),
		).toBeNull();
		expect(
			normalizeOrchestrationObservationInteger(
				MAX_ORCHESTRATION_OBSERVATION_TOKENS + 1,
				MAX_ORCHESTRATION_OBSERVATION_TOKENS,
			),
		).toBeNull();
	});
});
