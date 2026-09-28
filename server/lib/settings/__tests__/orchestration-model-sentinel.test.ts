import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "@server/lib/errors";
import type { OrchestrationProfile, OrchestrationSettings } from "@server/lib/orchestration/types";
import { parseOrchestrationModelValue, resolveEffectiveModel, settings } from "../index";

/**
 * 编排哨兵（`__orch__:<profileId>`）是"会话处于编排模式"的唯一载体，
 * 因此它必须在模型解析处就解析成**编制者的实际模型**：
 * 回退默认模型会让用户看到"选了方案但模型没变"，与"方案生效"无法区分。
 */

const PROFILE_ID = "of7k2m9q";

function makeTierConfig() {
	// 每个档位独立对象：共享引用会让"某档位被改"的测试互相污染
	return { pool: [{ model: "provA:worker" }] };
}

function makeProfile(id = PROFILE_ID, enabled = true): OrchestrationProfile {
	return {
		id,
		name: "测试方案",
		enabled,
		review: {
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: {
			chore: makeTierConfig(),
			quick: makeTierConfig(),
			medium: makeTierConfig(),
			heavy: makeTierConfig(),
		},
	};
}

function setOrchestration(value: Partial<OrchestrationSettings>) {
	const current = settings.agent.orchestration;
	settings.agent.orchestration = {
		orchestratorModels: current?.orchestratorModels ?? [],
		profiles: current?.profiles ?? [],
		...value,
	};
}

const sentinel = (profileId: string) => `__orch__:${profileId}`;

describe("parseOrchestrationModelValue", () => {
	test("合法哨兵解析出 profileId", () => {
		expect(parseOrchestrationModelValue(sentinel("abcd"))).toEqual({ profileId: "abcd" });
		expect(parseOrchestrationModelValue(`  ${sentinel(PROFILE_ID)}  `)).toEqual({
			profileId: PROFILE_ID,
		});
	});

	const invalidInputs: Array<string | null | undefined> = [
		null,
		undefined,
		"",
		"   ",
		"__orch__",
		"__orch__:",
		"__orch__:ABC",
		"__orch__:ab-c",
		"__orch__:ab_c",
		"__orch__:ab cd",
		"__orch__:ab:cd",
		"orch__:abcd",
		"__default__",
		"__agg__:abcd",
		"provA:model",
		"__orch__:abcd:extra",
	];

	for (const input of invalidInputs) {
		test(`拒绝 ${JSON.stringify(input)}`, () => {
			expect(parseOrchestrationModelValue(input)).toBeNull();
		});
	}
});

describe("resolveEffectiveModel 的编排哨兵", () => {
	let originalOrchestration: OrchestrationSettings | undefined;
	let originalDefaultModel: string;

	beforeEach(() => {
		originalOrchestration = settings.agent.orchestration;
		originalDefaultModel = settings.agent.defaultModel;
		settings.agent.defaultModel = "provZ:fallback";
	});

	afterEach(() => {
		settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
		settings.agent.defaultModel = originalDefaultModel;
	});

	test("解析为该方案编制者的实际模型", () => {
		setOrchestration({
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile()],
		});
		expect(resolveEffectiveModel(sentinel(PROFILE_ID))).toBe("provA:orchestrator");
	});

	test("跳过空的编制者模型项，取第一个非空项", () => {
		setOrchestration({
			orchestratorModels: ["", "   ", "provB:second"],
			profiles: [makeProfile()],
		});
		expect(resolveEffectiveModel(sentinel(PROFILE_ID))).toBe("provB:second");
	});

	test("方案不存在时报错，而不是回退默认模型", () => {
		setOrchestration({
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile()],
		});
		expect(() => resolveEffectiveModel(sentinel("nosuchid"))).toThrow(ValidationError);
		expect(() => resolveEffectiveModel(sentinel("nosuchid"))).toThrow(/不存在或未启用/);
	});

	test("方案未启用时报错", () => {
		setOrchestration({
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile(PROFILE_ID, false)],
		});
		expect(() => resolveEffectiveModel(sentinel(PROFILE_ID))).toThrow(/不存在或未启用/);
	});

	test("档位配置不完整（坏数据）时视为方案不存在", () => {
		const broken = makeProfile() as unknown as Record<string, unknown>;
		delete (broken.tiers as Record<string, unknown>).heavy;
		setOrchestration({
			orchestratorModels: ["provA:orchestrator"],
			profiles: [broken as unknown as OrchestrationProfile],
		});
		expect(() => resolveEffectiveModel(sentinel(PROFILE_ID))).toThrow(/不存在或未启用/);
	});

	test("没有配置编制者模型时报错", () => {
		setOrchestration({ orchestratorModels: ["", "  "], profiles: [makeProfile()] });
		expect(() => resolveEffectiveModel(sentinel(PROFILE_ID))).toThrow(/没有配置可用的编制者模型/);
	});

	test("编制者模型自身是编排哨兵时报错（防无限递归）", () => {
		setOrchestration({
			orchestratorModels: [sentinel(PROFILE_ID)],
			profiles: [makeProfile()],
		});
		expect(() => resolveEffectiveModel(sentinel(PROFILE_ID))).toThrow(/不能指向编排方案/);
	});

	test("编制者模型是 __default__ 时沿用默认模型解析", () => {
		setOrchestration({
			orchestratorModels: ["__default__", "provA:orchestrator"],
			profiles: [makeProfile()],
		});
		expect(resolveEffectiveModel(sentinel(PROFILE_ID))).toBe("provZ:fallback");
	});

	test("普通模型引用不受影响", () => {
		setOrchestration({ orchestratorModels: ["provA:orchestrator"], profiles: [makeProfile()] });
		expect(resolveEffectiveModel("provB:plain")).toBe("provB:plain");
		expect(resolveEffectiveModel("__default__")).toBe("provZ:fallback");
	});

	test("默认模型是编排哨兵时报错，而不是把哨兵发给 provider", () => {
		settings.agent.defaultModel = sentinel(PROFILE_ID);
		setOrchestration({ orchestratorModels: ["provA:orchestrator"], profiles: [makeProfile()] });
		// 走 __default__ 这条路（默认模型自身是哨兵）：必须报错，否则哨兵会成为
		// 「模型名」传给 provider，表现为"未知模型"，而根源在设置里。
		expect(() => resolveEffectiveModel("__default__")).toThrow(/不能作为默认模型或聚合成员/);
	});

	test("聚合成员是编排哨兵时报错", () => {
		settings.agent.modelAggregations = [
			{
				id: "aggx",
				name: "x",
				models: [sentinel(PROFILE_ID)],
				routingMode: "priority",
			},
		];
		try {
			expect(() => resolveEffectiveModel("__agg__:aggx")).toThrow(/不能作为默认模型或聚合成员/);
		} finally {
			settings.agent.modelAggregations = undefined;
		}
	});
});
