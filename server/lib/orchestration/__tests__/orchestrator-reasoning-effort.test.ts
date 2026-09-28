/**
 * 编制者模型的容错解析与「配置侧思考强度」。
 *
 * 两件事必须一起被钉住：
 * - **向后兼容**：历史配置（也是本特性引入前唯一可能的写法）是纯字符串数组，
 *   它必须继续能被读成一个可用的编制者模型，且**不带**任何强度——
 *   "读不出强度"和"强度被补了个默认值"在行为上差别很大，后者会让"我没配"
 *   这件事永远无法再被表达；
 * - **强度确实从配置里来**：`resolveConfiguredOrchestratorReasoningEffort` 是
 *   编制者会话唯一的强度来源，它读错一个键就等于这一项配置整体失效。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { settings } from "@server/lib/settings";
import {
	firstUsableOrchestratorModel,
	listOrchestratorModelRefs,
	listOrchestratorModels,
} from "@shared/orchestration-orchestrator-model";
import { resolveConfiguredOrchestratorReasoningEffort } from "../orchestrator-effort";
import {
	ORCHESTRATION_TIERS,
	type OrchestrationProfile,
	type OrchestrationSettings,
} from "../types";

const PROFILE_ID = "of7k2m9q";

function makeProfile(pool: Array<{ model: string }>): OrchestrationProfile {
	const tier = () => ({ pool });
	return {
		id: PROFILE_ID,
		name: "测试方案",
		enabled: true,
		review: {
			selfReview: false,
			independentReview: false,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: {
			chore: tier(),
			quick: tier(),
			medium: tier(),
			heavy: tier(),
		},
	};
}

describe("listOrchestratorModels 的向后兼容", () => {
	test("纯字符串数组（历史写法）读成「只带模型」的条目", () => {
		const entries = listOrchestratorModels(["provA:orchestrator", "provB:second"]);
		expect(entries).toEqual([{ model: "provA:orchestrator" }, { model: "provB:second" }]);
		// 关键断言：历史写法**不能**凭空得到一个强度。`toEqual` 会忽略 undefined
		// 属性，所以必须显式查键。
		expect(Object.hasOwn(entries[0] as object, "reasoningEffort")).toBe(false);
	});

	test("对象写法保留强度，省略时同样不注入", () => {
		expect(
			listOrchestratorModels([
				{ model: "provA:strong", reasoningEffort: "high" },
				{ model: "provB:m" },
			]),
		).toEqual([{ model: "provA:strong", reasoningEffort: "high" }, { model: "provB:m" }]);
	});

	test("两种写法可以混用，且按首次出现去重", () => {
		const entries = listOrchestratorModels([
			"provA:m",
			{ model: "provA:m", reasoningEffort: "max" },
			{ model: "provB:m", reasoningEffort: "low" },
		]);
		expect(entries).toEqual([{ model: "provA:m" }, { model: "provB:m", reasoningEffort: "low" }]);
	});

	test("空白引用整条丢弃，非法强度只丢强度本身", () => {
		expect(listOrchestratorModels(["", "   ", null, 42, { model: "  " }])).toEqual([]);
		// 手改 settings.json 打错一个字母，不该让整个编制者清单消失。
		expect(listOrchestratorModels([{ model: "provA:m", reasoningEffort: "ludicrous" }])).toEqual([
			{ model: "provA:m" },
		]);
	});

	test("非数组输入读成空清单（不抛异常）", () => {
		for (const raw of [undefined, null, "provA:m", {}, 7]) {
			expect(listOrchestratorModels(raw)).toEqual([]);
		}
	});

	test("firstUsableOrchestratorModel 取第一条（含它的强度）", () => {
		expect(
			firstUsableOrchestratorModel([
				{ model: "provA:first", reasoningEffort: "xhigh" },
				"provB:second",
			]),
		).toEqual({ model: "provA:first", reasoningEffort: "xhigh" });
		expect(firstUsableOrchestratorModel([])).toBeNull();
	});

	test("listOrchestratorModelRefs 只取模型引用（菜单与展示用）", () => {
		expect(
			listOrchestratorModelRefs(["provA:a", { model: "provB:b", reasoningEffort: "low" }]),
		).toEqual(["provA:a", "provB:b"]);
	});
});

describe("resolveConfiguredOrchestratorReasoningEffort", () => {
	const originalOrchestration = settings.agent.orchestration;

	afterEach(() => {
		settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	});

	test("配置了强度就返回它", () => {
		settings.agent.orchestration = {
			orchestratorModels: [{ model: "provA:orch", reasoningEffort: "high" }],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		expect(resolveConfiguredOrchestratorReasoningEffort(PROFILE_ID)).toBe("high");
	});

	test("省略强度返回 null（= 跟随 provider 默认，而不是最低档）", () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orch"],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		expect(resolveConfiguredOrchestratorReasoningEffort(PROFILE_ID)).toBeNull();
	});

	test("没有编排方案 id（普通会话）时返回 null", () => {
		settings.agent.orchestration = {
			orchestratorModels: [{ model: "provA:orch", reasoningEffort: "max" }],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		expect(resolveConfiguredOrchestratorReasoningEffort(null)).toBeNull();
		expect(resolveConfiguredOrchestratorReasoningEffort(undefined)).toBeNull();
		expect(resolveConfiguredOrchestratorReasoningEffort("")).toBeNull();
	});

	test("强度只取第一个可用条目上的那一份（真被用的才是真生效的）", () => {
		settings.agent.orchestration = {
			orchestratorModels: [
				{ model: "provA:first", reasoningEffort: "low" },
				{ model: "provB:second", reasoningEffort: "max" },
			],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		expect(resolveConfiguredOrchestratorReasoningEffort(PROFILE_ID)).toBe("low");
	});

	test("坏数据（非法强度 / 非数组）不抛异常，按未配置处理", () => {
		settings.agent.orchestration = {
			orchestratorModels: [{ model: "provA:orch", reasoningEffort: "ludicrous" }],
			profiles: [],
		} as unknown as OrchestrationSettings;
		expect(resolveConfiguredOrchestratorReasoningEffort(PROFILE_ID)).toBeNull();

		settings.agent.orchestration = {
			orchestratorModels: "provA:orch",
			profiles: [],
		} as unknown as OrchestrationSettings;
		expect(resolveConfiguredOrchestratorReasoningEffort(PROFILE_ID)).toBeNull();
	});
});

describe("orchestration/types 与共享契约的形状一致性", () => {
	test("四档常量未被改动（其它模块按这个顺序遍历）", () => {
		expect([...ORCHESTRATION_TIERS]).toEqual(["chore", "quick", "medium", "heavy"]);
	});

	test("settings 形状同时接受字符串与对象（编译期与运行期都不需要迁移）", () => {
		const settings: OrchestrationSettings = {
			orchestratorModels: ["provA:legacy", { model: "provB:new", reasoningEffort: "high" }],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		expect(listOrchestratorModelRefs(settings.orchestratorModels)).toEqual([
			"provA:legacy",
			"provB:new",
		]);
	});
});
