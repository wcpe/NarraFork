import { describe, expect, test } from "bun:test";
import {
	buildAggModelValue,
	buildOrchestrationModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelOption,
	ORCHESTRATION_PROVIDER_KEY,
} from "../../../lib/constants";
import { orchestrationSelectionName, resolveModelMenuIntent } from "./orchestration-selection";

const profileId = "prof1";
const orchestrationValue = buildOrchestrationModelValue(profileId);
const allModels: ModelOption[] = [
	{
		value: orchestrationValue,
		label: "Team profile",
		provider: ORCHESTRATION_PROVIDER_KEY,
	},
	{ value: "a:one", label: "One", provider: "a" },
];

describe("model menu selection dispatch", () => {
	test("routes an orchestration value to the dedicated endpoint", () => {
		expect(resolveModelMenuIntent(orchestrationValue)).toEqual({
			kind: "orchestration",
			profileId,
		});
	});
	test("routes every non-orchestration value to the plain model write", () => {
		for (const value of [
			"a:one",
			FOLLOW_DEFAULT_MODEL,
			FOLLOW_SUMMARY_MODEL,
			FOLLOW_PARENT_MODEL,
			buildAggModelValue("group"),
			buildAggModelValue("group", "a:one"),
			"__orch__",
		]) {
			expect(resolveModelMenuIntent(value)).toEqual({ kind: "model", model: value });
		}
	});
});

describe("orchestration selection name", () => {
	test("uses the profile name from the menu catalog", () => {
		expect(orchestrationSelectionName(orchestrationValue, allModels)).toBe("Team profile");
	});
	test("falls back to the profile id when the profile is gone from settings", () => {
		// 方案被删掉后，会话可能仍停在旧哨兵上：此时必须能说出「在哪个方案上」，
		// 而不是显示空白或一个伪造的模型名。
		expect(orchestrationSelectionName(orchestrationValue, [])).toBe(profileId);
	});
	test("returns null outside orchestration mode", () => {
		for (const value of [null, undefined, "", "a:one", FOLLOW_DEFAULT_MODEL]) {
			expect(orchestrationSelectionName(value, allModels)).toBeNull();
		}
	});
});
