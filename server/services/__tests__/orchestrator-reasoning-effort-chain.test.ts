/**
 * 会话思考强度的**三档回落链**。
 *
 * 这条链存在的全部理由是"设置页里配的等级要真的用上"。写反了不会报错，表现只是
 * **配置看起来生效、实际不生效**——而用户没有任何办法从界面上看出来。所以这里逐档
 * 钉住顺序：
 *
 *   跟随父级继承 > 会话自己的显式选择 > 编排配置（编制者） > provider 默认
 *
 * 编排配置排在显式选择之后（否则用户永远调不动一个编排会话），又排在默认值之前
 * （否则这一项配置完全无效果）。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolveDefaultReasoningEffort, settings } from "@server/lib/settings";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import type { OrchestrationSettings } from "../../lib/orchestration/types";
import { resolveSessionReasoningEffort } from "../narrator-session";

const PROFILE_ID = "of7k2m9q";

const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-4-20250514";

/**
 * provider 默认强度**按环境可变**（它来自 `settings.agent.defaultReasoningEffort`）。
 * 因此每个"配置压过默认"的断言都先把这个值读出来，再挑一个与它不同的配置值：
 * 写死一个字面量时，一旦环境里的默认恰好等于它，断言就会在"真的生效"与
 * "碰巧一样"之间失去分辨力。
 */
const providerDefault = resolveDefaultReasoningEffort(PROVIDER, MODEL) as ReasoningEffort;
const nonDefaultEffort: ReasoningEffort = providerDefault === "high" ? "none" : "high";

const originalOrchestration = settings.agent.orchestration;

/** 把编制者配置成指定的强度；`undefined` 表示"没配"。 */
function setOrchestratorEffort(effort?: ReasoningEffort) {
	settings.agent.orchestration = {
		orchestratorModels: [
			effort
				? { model: "anthropic:orchestrator", reasoningEffort: effort }
				: "anthropic:orchestrator",
		],
		profiles: [],
	} as unknown as OrchestrationSettings;
}

afterEach(() => {
	settings.agent.orchestration = originalOrchestration as OrchestrationSettings;
});

describe("resolveSessionReasoningEffort 的优先级", () => {
	test("编排配置压过 provider 默认（这一项配置存在的意义）", () => {
		// 先确认基线确实是 provider 默认，这样"配了就变"才说明是配置起了作用。
		setOrchestratorEffort(undefined);
		expect(
			resolveSessionReasoningEffort({
				provider: PROVIDER,
				model: MODEL,
				orchestrationProfileId: PROFILE_ID,
				explicit: null,
			}),
		).toBe(providerDefault);

		setOrchestratorEffort(nonDefaultEffort);
		expect(
			resolveSessionReasoningEffort({
				provider: PROVIDER,
				model: MODEL,
				orchestrationProfileId: PROFILE_ID,
				explicit: null,
			}),
		).toBe(nonDefaultEffort);
	});

	test("用户的显式选择压过编排配置（否则编排会话调不动）", () => {
		setOrchestratorEffort(nonDefaultEffort);
		expect(
			resolveSessionReasoningEffort({
				provider: PROVIDER,
				model: MODEL,
				orchestrationProfileId: PROFILE_ID,
				explicit: "none",
			}),
		).toBe("none");
	});

	test("跟随父级继承的值压过显式选择与编制者配置", () => {
		setOrchestratorEffort(nonDefaultEffort);
		expect(
			resolveSessionReasoningEffort({
				provider: PROVIDER,
				model: MODEL,
				orchestrationProfileId: PROFILE_ID,
				explicit: "none",
				inherited: "xhigh",
			}),
		).toBe("xhigh");
	});

	test("没有配强度时回落到 provider 默认，而不是某个固定档位", () => {
		setOrchestratorEffort(undefined);
		const withProfile = resolveSessionReasoningEffort({
			provider: PROVIDER,
			model: MODEL,
			orchestrationProfileId: PROFILE_ID,
			explicit: null,
		});
		const withoutProfile = resolveSessionReasoningEffort({
			provider: PROVIDER,
			model: MODEL,
			explicit: null,
		});
		expect(withProfile).toBe(withoutProfile);
		expect(withProfile).toBe(providerDefault);
	});

	test("非编排会话（没有方案 id）绝不继承编制者的强度", () => {
		setOrchestratorEffort(nonDefaultEffort);
		const plain = resolveSessionReasoningEffort({
			provider: PROVIDER,
			model: MODEL,
			explicit: null,
		});
		expect(plain).toBe(providerDefault);
		// 同一份配置，只要带上方案 id 就会生效——这正好证明上面的结果是因为"没有方案"，
		// 而不是因为配置压根没被读到。
		expect(
			resolveSessionReasoningEffort({
				provider: PROVIDER,
				model: MODEL,
				explicit: null,
				orchestrationProfileId: PROFILE_ID,
			}),
		).toBe(nonDefaultEffort);
	});
});
