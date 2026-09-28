/**
 * 编排设置校验里的思考强度字段。
 *
 * 这个文件守三件容易悄悄坏掉的事：
 * - **往返**：池条目上配的强度经校验后必须原样读得回来（否则界面看起来配上了，
 *   实际存进去的是被丢掉的版本）；
 * - **省略不注入**：没配强度的条目校验后**不能**多出一个 `reasoningEffort` 键。
 *   这是「用户没配」与「用户配成某一档」唯一的区分，一旦被默认值填平，
 *   界面上"跟随默认"这个选项保存一次就会变成一个明确的等级；
 * - **向后兼容**：`orchestratorModels` 的历史写法是纯字符串数组，它必须继续被接受。
 */

import { describe, expect, test } from "bun:test";
import { orchestrationSettingsSchema } from "../orchestration";

/** 一个结构完整的最小方案（四档齐全，方案启用）。 */
function profile(over: Record<string, unknown> = {}): Record<string, unknown> {
	const tier = (pool: unknown) => ({ pool });
	return {
		id: "of7k2m9q",
		name: "测试方案",
		enabled: true,
		review: {
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: {
			chore: tier([]),
			quick: tier([]),
			medium: tier([]),
			heavy: tier([]),
		},
		...over,
	};
}

function parse(raw: unknown) {
	return orchestrationSettingsSchema.safeParse(raw);
}

describe("池条目的 reasoningEffort", () => {
	test("配置的强度往返读到同一个值", () => {
		for (const effort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
			const result = parse({
				orchestratorModels: [],
				profiles: [profile(withPool([{ model: "p:m", reasoningEffort: effort }]))],
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.profiles[0]?.tiers.quick.pool[0]).toEqual({
				model: "p:m",
				reasoningEffort: effort,
			});
		}
	});

	test("省略强度的条目不会多出一个 reasoningEffort 键", () => {
		const result = parse({
			orchestratorModels: [],
			profiles: [profile(withPool([{ model: "p:m", priority: 3 }]))],
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		const entry = result.data.profiles[0]?.tiers.quick.pool[0] as object;
		// `toEqual` 会忽略 undefined 属性，所以这里必须显式查键是否存在。
		expect(Object.hasOwn(entry, "reasoningEffort")).toBe(false);
		expect(entry).toEqual({ model: "p:m", priority: 3 });
	});

	test("非法强度被拒绝，而不是被静默丢弃", () => {
		const result = parse({
			orchestratorModels: [],
			profiles: [profile(withPool([{ model: "p:m", reasoningEffort: "gigantic" }]))],
		});
		expect(result.success).toBe(false);
	});

	test("池条目上限仍然是 50", () => {
		const tooMany = Array.from({ length: 51 }, (_value, index) => ({ model: `p:m${index}` }));
		expect(parse({ orchestratorModels: [], profiles: [profile(withPool(tooMany))] }).success).toBe(
			false,
		);
	});
});

describe("orchestratorModels 的形状", () => {
	test("历史写法（纯字符串数组）继续可用", () => {
		const result = parse({
			orchestratorModels: ["provA:orchestrator", "provB:second"],
			profiles: [],
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.orchestratorModels).toEqual(["provA:orchestrator", "provB:second"]);
	});

	test("字符串与对象可以混在同一个数组里", () => {
		const result = parse({
			orchestratorModels: ["provA:plain", { model: "provB:strong", reasoningEffort: "high" }],
			profiles: [],
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.orchestratorModels).toEqual([
			"provA:plain",
			{ model: "provB:strong", reasoningEffort: "high" },
		]);
	});

	test("对象条目省略强度时不会多出 reasoningEffort 键", () => {
		const result = parse({ orchestratorModels: [{ model: "provA:m" }], profiles: [] });
		expect(result.success).toBe(true);
		if (!result.success) return;
		const entry = result.data.orchestratorModels[0] as object;
		expect(Object.hasOwn(entry, "reasoningEffort")).toBe(false);
	});

	test("非法强度与未知字段都被拒绝", () => {
		expect(
			parse({ orchestratorModels: [{ model: "p:m", reasoningEffort: "ludicrous" }], profiles: [] })
				.success,
		).toBe(false);
		expect(parse({ orchestratorModels: [{ model: "p:m", nope: 1 }], profiles: [] }).success).toBe(
			false,
		);
	});

	test("空模型引用被拒绝", () => {
		expect(parse({ orchestratorModels: [""], profiles: [] }).success).toBe(false);
		expect(parse({ orchestratorModels: [{ model: "" }], profiles: [] }).success).toBe(false);
	});

	test("编制者条目上限仍然是 20", () => {
		const tooMany = Array.from({ length: 21 }, (_value, index) => `p:m${index}`);
		expect(parse({ orchestratorModels: tooMany, profiles: [] }).success).toBe(false);
	});
});

/** 把一份池塞进四个档位（缺档会被 listEnabledProfiles 丢掉，因此四档必须都有）。 */
function withPool(pool: unknown[]): Record<string, unknown> {
	const tier = { pool };
	return { tiers: { chore: tier, quick: tier, medium: tier, heavy: tier } };
}
