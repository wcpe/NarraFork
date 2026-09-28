/**
 * 编排开销归集的纯逻辑断言。
 *
 * 这里不碰数据库：`usage.ts` 的 I/O 只有"枚举子会话"与"一次分组聚合"两步，
 * 而容易出错的全在**归集口径**上——它们都是纯函数，因此可以直接逐条钉住。
 *
 * 三条口径各自会静默出错：
 * - 复核者（`orch-review--…`）的开销必须进总量但**不进任何一档**，否则"这一档花了
 *   多少 token"会混进不是执行者的开销；
 * - 枚举与读取之间隔着一次 await，可能读到不在枚举里的 narrator，多出来的行必须忽略；
 * - 读取预算用尽时必须如实带出 `truncated`，不能装作是全集。
 */

import { describe, expect, test } from "bun:test";
import type { OrchestrationUsageBucket } from "@shared/orchestration-status";
import {
	buildOrchestrationUsage,
	classifyChild,
	normalizeOrchestrationInputTokens,
	orchestrationUsageResponse,
	sumUsageBuckets,
} from "../usage";

function bucket(over: Partial<OrchestrationUsageBucket> = {}): OrchestrationUsageBucket {
	return {
		requests: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
		outputTokens: 0,
		sources: { measured: 0, estimated: 0, unknown: 0 },
		...over,
	};
}

describe("sumUsageBuckets", () => {
	test("五个字段各自相加（四档与编制者之间没有包含关系）", () => {
		const total = sumUsageBuckets([
			bucket({ requests: 1, inputTokens: 10, cachedInputTokens: 100, outputTokens: 5 }),
			bucket({ requests: 2, inputTokens: 20, cacheCreationInputTokens: 7, outputTokens: 6 }),
		]);
		expect(total).toEqual({
			requests: 3,
			inputTokens: 30,
			cachedInputTokens: 100,
			cacheCreationInputTokens: 7,
			cacheCreation5mTokens: 0,
			cacheCreation1hTokens: 0,
			outputTokens: 11,
			sources: { measured: 0, estimated: 0, unknown: 0 },
		});
	});

	test("没有桶时是全零，而不是 undefined", () => {
		expect(sumUsageBuckets([])).toEqual(bucket());
	});
});

describe("normalizeOrchestrationInputTokens", () => {
	test("provider total-input semantics subtracts cache once in orchestration aggregation", () => {
		expect(normalizeOrchestrationInputTokens(100, 30, "total_input")).toBe(70);
		expect(normalizeOrchestrationInputTokens(100, 30, "prompt_total")).toBe(70);
	});

	test("non-cached and unknown semantics preserve the stored provider input", () => {
		expect(normalizeOrchestrationInputTokens(100, 30, "non_cached_input")).toBe(100);
		expect(normalizeOrchestrationInputTokens(100, 30, "unknown")).toBe(100);
	});
});

describe("classifyChild", () => {
	test("执行者类型解析出它的档位", () => {
		expect(classifyChild("orch--abcd1234--heavy")).toBe("heavy");
		expect(classifyChild("orch--abcd1234--chore")).toBe("chore");
	});

	test("复核者没有档位：它进总量，但四档里没有它的位置", () => {
		// 复核者的模型池取自 reviewTier 配置，把它塞进那一档会让人以为「这一档跑了这么多」，
		// 而那一档的池是执行者池，两者不是一回事。
		expect(classifyChild("orch-review--abcd1234--quick")).toBeNull();
	});

	test("非编排子代理与空值一律没有档位", () => {
		expect(classifyChild("general")).toBeNull();
		expect(classifyChild("explore")).toBeNull();
		expect(classifyChild(null)).toBeNull();
		expect(classifyChild("orch--abcd1234--unknown")).toBeNull();
	});
});

describe("buildOrchestrationUsage", () => {
	test("编制者的开销单列，并计入总量", () => {
		const usage = buildOrchestrationUsage({
			orchestratorBucket: bucket({ requests: 3, inputTokens: 100 }),
			targets: [
				{ narratorId: "w1", tier: "quick" },
				{ narratorId: "w2", tier: "quick" },
			],
			rows: [
				{ ...bucket({ requests: 1, inputTokens: 40 }), narratorId: "w1" },
				{ ...bucket({ requests: 1, inputTokens: 60 }), narratorId: "w2" },
			],
			truncated: false,
		});
		expect(usage.orchestrator.inputTokens).toBe(100);
		expect(usage.tiers.quick.inputTokens).toBe(100);
		// 总量 = 编制者 100 + quick 100
		expect(usage.total.inputTokens).toBe(200);
		expect(usage.total.requests).toBe(5);
	});

	test("编制者明细按 runId 与 role 保留，不退化成 legacy", () => {
		const usage = buildOrchestrationUsage({
			orchestratorBucket: bucket({ requests: 3, inputTokens: 100 }),
			orchestratorRows: [
				{
					...bucket({ requests: 1, inputTokens: 40 }),
					narratorId: "coordinator",
					runId: "run-1",
					role: "orchestrator",
				},
				{
					...bucket({ requests: 2, inputTokens: 60 }),
					narratorId: "coordinator",
					runId: "run-2",
					role: "orchestrator",
				},
			],
			targets: [],
			rows: [],
			truncated: false,
		});
		expect(usage.runDetails.map((detail) => detail.runId)).toEqual(["run-1", "run-2"]);
		expect(usage.runDetails[0]?.roles.orchestrator.inputTokens).toBe(40);
		expect(usage.runDetails[1]?.roles.orchestrator.inputTokens).toBe(60);
	});

	test("复核者计入总量但进 reviewers、不进任何档位", () => {
		const usage = buildOrchestrationUsage({
			orchestratorBucket: bucket({ requests: 1, inputTokens: 10 }),
			targets: [
				{ narratorId: "w1", tier: "medium" },
				// 复核者：tier 为 null
				{ narratorId: "r1", tier: null },
			],
			rows: [
				{ ...bucket({ requests: 1, inputTokens: 100 }), narratorId: "w1" },
				{ ...bucket({ requests: 1, inputTokens: 500 }), narratorId: "r1" },
			],
			truncated: false,
		});
		expect(usage.tiers.medium.inputTokens).toBe(100);
		// 四档之和里没有复核者的那 500
		expect(usage.tiers.chore.inputTokens).toBe(0);
		expect(usage.tiers.quick.inputTokens).toBe(0);
		expect(usage.tiers.heavy.inputTokens).toBe(0);
		// 复核者单列，并且总量里必须包含它
		expect(usage.reviewers.inputTokens).toBe(500);
		expect(usage.total.inputTokens).toBe(610);
		expect(usage.childCount).toBe(2);
	});

	test("「编制者 + 复核 + 四档 = 总计」这个等式恒成立", () => {
		// 界面上用户会把这几块加起来，对不上就是 bug。这条断言把它钉住。
		const usage = buildOrchestrationUsage({
			orchestratorBucket: bucket({ requests: 2, inputTokens: 7, outputTokens: 3 }),
			targets: [
				{ narratorId: "w1", tier: "chore" },
				{ narratorId: "w2", tier: "heavy" },
				{ narratorId: "r1", tier: null },
			],
			rows: [
				{ ...bucket({ requests: 1, inputTokens: 11, cachedInputTokens: 13 }), narratorId: "w1" },
				{ ...bucket({ requests: 1, inputTokens: 17, outputTokens: 19 }), narratorId: "w2" },
				{
					...bucket({ requests: 1, inputTokens: 23, cacheCreationInputTokens: 29 }),
					narratorId: "r1",
				},
			],
			truncated: false,
		});
		const sum = sumUsageBuckets([
			usage.orchestrator,
			usage.reviewers,
			usage.tiers.chore,
			usage.tiers.quick,
			usage.tiers.medium,
			usage.tiers.heavy,
		]);
		expect(sum).toEqual(usage.total);
	});

	test("枚举之外的行被忽略：读取与枚举之间隔着一次 await", () => {
		const usage = buildOrchestrationUsage({
			orchestratorBucket: bucket(),
			targets: [{ narratorId: "w1", tier: "chore" }],
			rows: [
				{ ...bucket({ requests: 1, inputTokens: 20 }), narratorId: "w1" },
				// 不在 targets 里（例如子代理刚被删掉，或它根本不是编排子会话）
				{ ...bucket({ requests: 9, inputTokens: 9000 }), narratorId: "stranger" },
				{ ...bucket({ requests: 9, inputTokens: 9000 }), narratorId: null },
			],
			truncated: false,
		});
		expect(usage.tiers.chore.inputTokens).toBe(20);
		expect(usage.total.inputTokens).toBe(20);
		expect(usage.total.requests).toBe(1);
	});

	test("一个子会话都没有时四档全零，总量等于编制者自己", () => {
		const usage = buildOrchestrationUsage({
			orchestratorBucket: bucket({ requests: 2, outputTokens: 30 }),
			targets: [],
			rows: [],
			truncated: false,
		});
		expect(usage.childCount).toBe(0);
		expect(usage.tiers).toEqual({
			chore: bucket(),
			quick: bucket(),
			medium: bucket(),
			heavy: bucket(),
		});
		expect(usage.total.outputTokens).toBe(30);
	});

	test("读取预算用尽时如实带出 truncated，不装作是全集", () => {
		const usage = buildOrchestrationUsage({
			orchestratorBucket: bucket(),
			targets: [],
			rows: [],
			truncated: true,
		});
		expect(usage.truncated).toBe(true);
	});
});

describe("orchestrationUsageResponse", () => {
	test("非编排会话显式给 null，而不是省略字段或报错", () => {
		expect(orchestrationUsageResponse(null)).toEqual({ usage: null });
	});
});
