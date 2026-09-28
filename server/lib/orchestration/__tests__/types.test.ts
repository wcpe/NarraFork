import { describe, expect, test } from "bun:test";

import {
	buildOrchestrationType,
	buildReviewerSubagentType,
	ORCHESTRATION_TIERS,
	ORCHESTRATION_TYPE_PREFIX,
	parseOrchestrationType,
	REVIEWER_TYPE_PREFIX,
	resolveOrchestrationReviewConfig,
	TIER_TOOL_TIER,
} from "../types";

describe("编排档位常量", () => {
	test("四个档位齐全且顺序固定", () => {
		expect([...ORCHESTRATION_TIERS]).toEqual(["chore", "quick", "medium", "heavy"]);
	});

	test("低两档只读，高两档可写", () => {
		expect(TIER_TOOL_TIER).toEqual({
			chore: "readOnly",
			quick: "readOnly",
			medium: "general",
			heavy: "general",
		});
	});

	test("编码前缀固定为 orch--", () => {
		expect(ORCHESTRATION_TYPE_PREFIX).toBe("orch--");
	});
});

describe("buildOrchestrationType", () => {
	test("产出形如 orch--<profileId>--<tier> 的字符串", () => {
		expect(buildOrchestrationType("of7k2m9q", "heavy")).toBe("orch--of7k2m9q--heavy");
	});

	test("对四个档位都产出对应后缀", () => {
		expect(buildOrchestrationType("abcd", "chore")).toBe("orch--abcd--chore");
		expect(buildOrchestrationType("abcd", "quick")).toBe("orch--abcd--quick");
		expect(buildOrchestrationType("abcd", "medium")).toBe("orch--abcd--medium");
		expect(buildOrchestrationType("abcd", "heavy")).toBe("orch--abcd--heavy");
	});
});

describe("parseOrchestrationType 往返", () => {
	test("profileId 与档位可原样还原", () => {
		const profileIds = ["abcd", "of7k2m9q", "a1b2c3d4e5f6g7h8i9j0"];
		for (const profileId of profileIds) {
			for (const tier of ORCHESTRATION_TIERS) {
				const encoded = buildOrchestrationType(profileId, tier);
				expect(parseOrchestrationType(encoded)).toEqual({ ok: true, profileId, tier });
			}
		}
	});

	test("解析结果带上 ok 标记，便于下游做类型收窄", () => {
		const result = parseOrchestrationType(buildOrchestrationType("abcd", "quick"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.profileId).toBe("abcd");
			expect(result.tier).toBe("quick");
		}
	});
});

describe("parseOrchestrationType 非法输入", () => {
	// 解析侧拿到的可能是任意历史数据或用户手填值，任何形态都必须安全地落到 ok:false
	const invalidInputs: Array<string | null | undefined> = [
		null,
		undefined,
		"",
		"orch--",
		"orch--abc",
		"orch--abc--bogus",
		"orch--ABC--heavy",
		"orch--abc--Heavy",
		"orch--abc--",
		"orch--abc-1--heavy",
		"orch--abc def--heavy",
		"orch--abc--heavy--extra",
		"orch--abc--quickextra",
		"xorch--abc--quick",
		"orch__abc__quick",
		"quick",
		"orch",
	];

	for (const input of invalidInputs) {
		test(`拒绝 ${JSON.stringify(input)}`, () => {
			expect(parseOrchestrationType(input)).toEqual({ ok: false });
			expect(() => parseOrchestrationType(input)).not.toThrow();
		});
	}

	test("长度不在 4..32 内的 profileId 仍按字符集判定", () => {
		// 长度约束属于写入侧校验，解析侧只保证字符集与档位合法，
		// 否则历史数据或旧版本写入的短 ID 会整体失效
		expect(parseOrchestrationType("orch--a--heavy")).toEqual({
			ok: true,
			profileId: "a",
			tier: "heavy",
		});
	});
});

describe("buildReviewerSubagentType", () => {
	test("产出形如 orch-review--<profileId>--<tier> 的字符串", () => {
		expect(buildReviewerSubagentType("of7k2m9q", "quick")).toBe("orch-review--of7k2m9q--quick");
		expect(REVIEWER_TYPE_PREFIX).toBe("orch-review--");
	});

	test("复核者类型永远不是合法的编排 worker 类型", () => {
		// 这一条是"复核者不会被当成执行者复用"的第一道闸门：它必须在编码层就不成立，
		// 不能只靠停放池的查询去兜。改解析器（例如接受第三段）时这里会先炸。
		for (const profileId of ["abcd", "of7k2m9q"]) {
			for (const tier of ORCHESTRATION_TIERS) {
				const encoded = buildReviewerSubagentType(profileId, tier);
				expect(parseOrchestrationType(encoded)).toEqual({ ok: false });
				// 停放池按 `like 'orch--%'` 捞行，前缀必须对不上。
				expect(encoded.startsWith(ORCHESTRATION_TYPE_PREFIX)).toBe(false);
			}
		}
	});
});

describe("resolveOrchestrationReviewConfig", () => {
	test("完整的配置原样返回", () => {
		expect(
			resolveOrchestrationReviewConfig({
				selfReview: false,
				independentReview: true,
				reviewTier: "heavy",
				maxReworkAttempts: 3,
			}),
		).toEqual({
			selfReview: false,
			independentReview: true,
			reviewTier: "heavy",
			maxReworkAttempts: 3,
		});
	});

	test("缺省或非法字段回落到文档化的默认值", () => {
		expect(resolveOrchestrationReviewConfig(undefined)).toEqual({
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		});
		expect(resolveOrchestrationReviewConfig("nope")).toEqual({
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		});
		expect(
			resolveOrchestrationReviewConfig({ reviewTier: "bogus", maxReworkAttempts: -3 }),
		).toEqual({
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 0,
		});
	});

	test("显式关掉复核不会被默认值覆盖回来", () => {
		const resolved = resolveOrchestrationReviewConfig({
			selfReview: false,
			independentReview: false,
		});
		expect(resolved.selfReview).toBe(false);
		expect(resolved.independentReview).toBe(false);
	});
});
