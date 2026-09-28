import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentConfig, ToolContext } from "@server/lib/agent/types";
import { ORCHESTRATOR_TOOLS, supportsSelfReview } from "@server/lib/orchestration/tier-definition";
import {
	ORCHESTRATION_TIERS,
	type OrchestrationProfile,
	type OrchestrationSettings,
} from "@server/lib/orchestration/types";
import { settings } from "@server/lib/settings";
import { type RuntimePolicy, resolveRuntimePolicy } from "@server/services/agent-runtime/policy";
import { agentTool, isOrchestratorSchemaContext } from "../task";

/**
 * `tier` 参数只在编制者的 schema 里存在。
 *
 * 两份断言缺一不可：编制者必须看到 required 的 tier（否则"派发"没有档位可依），
 * 其他会话的 schema 里**绝不能**出现它（模型看到不存在的参数就会开始猜它）。
 */

const PROFILE_ID = "of7k2m9q";

const orchestratorPolicy = resolveRuntimePolicy({
	variant: "primary",
	extraToolNames: ORCHESTRATOR_TOOLS,
	orchestrationProfileId: PROFILE_ID,
});
const primaryPolicy = resolveRuntimePolicy({ variant: "primary" });
const subagentPolicy = resolveRuntimePolicy({ variant: "subagent", subagentType: "general" });

function configOf(runtimePolicy: RuntimePolicy): AgentConfig {
	// 只关心 schema 判定所需的字段；permissionHandler 等由服务端装配，这里用断言省略
	return {
		narratorId: "narrator-1",
		conversationId: "conv-1",
		model: "provA:model",
		provider: "provA",
		cwd: ".",
		signal: new AbortController().signal,
		runtimePolicy,
	} as AgentConfig;
}

function contextOf(runtimePolicy: RuntimePolicy): ToolContext {
	return {
		narratorId: "narrator-1",
		cwd: ".",
		signal: new AbortController().signal,
		locale: "zh-CN",
		runtimePolicy,
	} as ToolContext;
}

interface RawSchema {
	properties: Record<string, { description?: string; enum?: string[] }>;
	required: string[];
}

function schemaOf(config: AgentConfig): RawSchema {
	const schema = agentTool.getRawJsonSchema?.(config);
	if (!schema) throw new Error("Agent tool must expose getRawJsonSchema");
	return schema as unknown as RawSchema;
}

function makeTierConfig(pool: Array<{ model: string }>) {
	return { pool };
}

function makeProfile(pool: Array<{ model: string }>): OrchestrationProfile {
	return {
		id: PROFILE_ID,
		name: "测试方案",
		enabled: true,
		review: {
			selfReview: true,
			independentReview: true,
			reviewTier: "quick",
			maxReworkAttempts: 2,
		},
		tiers: {
			chore: makeTierConfig(pool),
			quick: makeTierConfig(pool),
			medium: makeTierConfig(pool),
			heavy: makeTierConfig(pool),
		},
	};
}

describe("isOrchestratorSchemaContext", () => {
	test("编制者（工具面已被编排收窄的 primary）为 true", () => {
		expect(isOrchestratorSchemaContext(configOf(orchestratorPolicy))).toBe(true);
	});

	test("普通 primary 为 false", () => {
		expect(isOrchestratorSchemaContext(configOf(primaryPolicy))).toBe(false);
	});

	test("子代理为 false", () => {
		expect(isOrchestratorSchemaContext(configOf(subagentPolicy))).toBe(false);
		expect(
			isOrchestratorSchemaContext(
				configOf(resolveRuntimePolicy({ variant: "subagent", subagentType: "explore" })),
			),
		).toBe(false);
	});

	test("没有运行期策略时为 false（fail closed）", () => {
		expect(isOrchestratorSchemaContext(undefined)).toBe(false);
		expect(isOrchestratorSchemaContext(configOf(primaryPolicy))).toBe(false);
	});
});

describe("Agent 工具 schema 的 tier 参数", () => {
	test("编制者上下文里 tier 是必填且取值整齐", () => {
		const schema = schemaOf(configOf(orchestratorPolicy));
		expect(Object.keys(schema.properties)).toContain("tier");
		expect(schema.required).toEqual(["tier"]);
		expect(schema.properties.tier.enum).toEqual([...ORCHESTRATION_TIERS]);
	});

	test("编制者上下文里 subagent_type 的说明已改写", () => {
		const schema = schemaOf(configOf(orchestratorPolicy));
		expect(schema.properties.subagent_type.description).toContain("derived from `tier`");
		expect(schema.properties.subagent_type.description).toContain("leave this unset");
	});

	test("非编排上下文里 schema 里绝对没有 tier", () => {
		for (const config of [configOf(primaryPolicy), configOf(subagentPolicy)]) {
			const schema = schemaOf(config);
			expect(Object.keys(schema.properties)).not.toContain("tier");
			expect(schema.required).toEqual([]);
			// 说明也必须还是"正常"那份，而不是编制者版的残留
			expect(schema.properties.subagent_type.description).not.toContain("derived from `tier`");
		}
	});

	test("无 config 的 rawJsonSchema 同样不带 tier", () => {
		const schema = agentTool.rawJsonSchema as unknown as RawSchema;
		expect(Object.keys(schema.properties)).not.toContain("tier");
	});

	test("内部 zod 校验保持宽容：缺 tier 的非编排输入仍合法", () => {
		// tool-executor / 权限判定读的是这个 schema；若它把 tier 设成必填，
		// 每一次普通派发都会被判成"参数非法"。
		const parsed = agentTool.parameters.safeParse({
			prompt: "hello",
			subagent_type: "general",
		});
		expect(parsed.success).toBe(true);
	});
});

/**
 * `self_review` 与 `tier` 同一套可见性规则：只在编制者的 schema 里出现。
 *
 * 它对模型的作用是**改变行为**（默认不自审、想要就得写出来），因此它和 tier 一样
 * 不能出现在看不到它的会话里——模型看到不存在的参数就会写它，而写下来的东西
 * 没有任何地方会兑现，症状是"以为要到了自审、其实没有"。
 */
describe("Agent 工具 schema 的 self_review 参数", () => {
	test("编制者上下文里 self_review 可见但不是必填", () => {
		const schema = schemaOf(configOf(orchestratorPolicy));
		expect(Object.keys(schema.properties)).toContain("self_review");
		// 必填会把"默认不自审"变成"必须显式选择"，而默认值正是这次改动的要点。
		expect(schema.required).toEqual(["tier"]);
	});

	test("编制者上下文里的说明写明默认关闭与档位限制", () => {
		const schema = schemaOf(configOf(orchestratorPolicy));
		const description = schema.properties.self_review.description ?? "";
		expect(description).toContain("Defaults to FALSE");
		// 只读档不接受这件事必须在 schema 里就说清，否则编制者只能靠撞一次报错学到。
		expect(description).toContain('"chore" and "quick" are rejected');
		expect(description).toContain("Set it to true");
	});

	test("非编排上下文里 schema 里绝对没有 self_review", () => {
		for (const config of [configOf(primaryPolicy), configOf(subagentPolicy)]) {
			expect(Object.keys(schemaOf(config).properties)).not.toContain("self_review");
		}
		expect(Object.keys((agentTool.rawJsonSchema as unknown as RawSchema).properties)).not.toContain(
			"self_review",
		);
	});
});

describe("supportsSelfReview", () => {
	test("只有可写档位支持自审", () => {
		expect(supportsSelfReview("chore")).toBe(false);
		expect(supportsSelfReview("quick")).toBe(false);
		expect(supportsSelfReview("medium")).toBe(true);
		expect(supportsSelfReview("heavy")).toBe(true);
	});
});

describe("Agent 工具的编排派发参数互斥", () => {
	let originalOrchestration: OrchestrationSettings | undefined;

	beforeEach(() => {
		originalOrchestration = settings.agent.orchestration;
	});

	afterEach(() => {
		settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
	});

	test("编排模式下缺少 tier 直接报错，不静默降级", async () => {
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("必须指定档位");
	});

	test("编排模式下 tier 与 model 互斥", async () => {
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", tier: "heavy", model: "provA:model" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("不能指定 model");
	});

	test("编排模式下 tier 与 stop / archive / unarchive 互斥", async () => {
		for (const key of ["stop", "archive", "unarchive"]) {
			const result = await agentTool.execute(
				{ prompt: "do it", description: "task", tier: "medium", [key]: "alias-1" },
				contextOf(orchestratorPolicy),
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("互斥");
		}
	});

	test("非法档位被拒绝", async () => {
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", tier: "gigantic" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("无效档位");
	});

	test("非编排会话带上 tier 时明确报错，而不是忽略它", async () => {
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", tier: "heavy" },
			contextOf(primaryPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("不在编排模式下");
	});

	test("档位模型池为空时给出可读错误", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile([])],
		};
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", tier: "quick" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("没有可用的执行者模型");
	});

	test("合法档位派发越过编排校验（停在既有的 toolUseId 前置检查）", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", tier: "quick" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("missing toolUseId");
	});

	/**
	 * 只读档位要自审必须**在派发之前**就被拒。
	 *
	 * 放它过去再跳过自审是不够的：编制者会以为要到了复核，而唯一的信号藏在长报告
	 * 的一段说明里，它下一步的规划就建立在错误前提上。报错只有编制者一个来回的代价，
	 * 而且默认值是 false，只有主动写错才会撞上。
	 */
	test("只读档位要求自审被拒，且没有真的派发出去", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		for (const tier of ["chore", "quick"] as const) {
			const result = await agentTool.execute(
				// chore 的指令长度下限要绕过，否则先撞上的是那条校验，测的就不是自审这道闸门了。
				{
					prompt: "run `bun test --isolate server/` and report the failing test names",
					tier,
					self_review: true,
				},
				contextOf(orchestratorPolicy),
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("不支持自审");
			expect(result.output).toContain(tier);
			// 卡在校验就说明它连 toolUseId 那一步都没走到：没有半个派发被建出来。
			expect(result.output).not.toContain("missing toolUseId");
		}
	});

	test("可写档位要求自审时越过这道闸门", async () => {
		settings.agent.orchestration = {
			orchestratorModels: ["provA:orchestrator"],
			profiles: [makeProfile([{ model: "provA:worker" }])],
		};
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", tier: "medium", self_review: true },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("missing toolUseId");
	});

	test("非编排会话带 self_review: true 时明确报错，而不是忽略它", async () => {
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", self_review: true },
			contextOf(primaryPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("不在编排模式下");
	});

	test("非编排会话带 self_review: false 不报错（它要的正是「不要自审」）", async () => {
		const result = await agentTool.execute(
			{ prompt: "do it", description: "task", self_review: false },
			contextOf(primaryPolicy),
		);
		expect(result.isError).toBe(true);
		// 越过 self_review 那道闸门，停在既有的前置检查上。
		expect(result.output).toContain("missing toolUseId");
	});
});
