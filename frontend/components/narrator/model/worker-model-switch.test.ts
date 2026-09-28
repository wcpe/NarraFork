import { describe, expect, it } from "bun:test";
import { buildOrchestrationModelValue, type ModelOption } from "../../../lib/constants";
import {
	applySubagentModelWaitToCachedRow,
	canOfferWorkerModelSwitch,
	isModelInWorkerPool,
	isWorkerModelSwitchPoolExhausted,
	isWorkerModelUnavailable,
	isWorkerTierPoolFullyUnavailable,
	labelForPoolModel,
	resolveWorkerModelSwitchScope,
	subagentModelWaitFromEvent,
	type WorkerModelSwitchCatalog,
	workerFailedModelFromErrorMessage,
	workerModelSwitchCandidates,
	workerModelSwitchSuccessMessageKey,
	workerTierPoolModels,
} from "./worker-model-switch";

/**
 * 「换模型继续」的纯判定测试（阶段 6）。
 *
 * 这些函数决定两件很容易做错的事：入口该不该出现、能选哪些模型。两者都必须能
 * 直接单测——组件层要挂载整个列表（滚动容器 + 文档协调器 + WS 订阅），挂不起来，
 * 而"该出现却没出现 / 不该出现却出现了"在界面上都只是少一个/多一个按钮。
 */

const PROFILE_ID = "of7k2m9q";
const OTHER_PROFILE_ID = "oth9zz11";
const EXECUTOR_QUICK = `orch--${PROFILE_ID}--quick`;
const REVIEWER_QUICK = `orch-review--${PROFILE_ID}--quick`;

function orchestrationOption(): ModelOption {
	return {
		value: buildOrchestrationModelValue(PROFILE_ID),
		label: "标准编排",
		provider: "__orchestration__",
		orchestration: {
			id: PROFILE_ID,
			name: "标准编排",
			orchestratorModels: ["provA:orchestrator"],
			tierPools: {
				chore: ["provA:chore-model"],
				quick: ["provA:quick-a", "provA:quick-b"],
				medium: [],
				heavy: ["provA:heavy-model"],
			},
		},
	};
}

const OPTIONS: ModelOption[] = [
	orchestrationOption(),
	{ value: "provA:quick-a", label: "Quick A" },
];

describe("worker-model-switch — 档位与池", () => {
	it("执行者与复核者都能解析出档位", () => {
		expect(resolveWorkerModelSwitchScope(EXECUTOR_QUICK)).toEqual({
			kind: "executor",
			profileId: PROFILE_ID,
			tier: "quick",
		});
		expect(resolveWorkerModelSwitchScope(REVIEWER_QUICK)).toEqual({
			kind: "reviewer",
			profileId: PROFILE_ID,
			tier: "quick",
		});
	});

	it("非编排类型解析不出档位", () => {
		// 普通子代理不该由这个入口换模型——那会绕过子代理模型策略。
		for (const type of ["explore", "plan", "general", "review", "orch--", "orch--only", null]) {
			expect(resolveWorkerModelSwitchScope(type)).toBeNull();
		}
	});

	it("列出本档位的池，按池内声明顺序", () => {
		const scope = resolveWorkerModelSwitchScope(EXECUTOR_QUICK);
		if (!scope) throw new Error("scope");
		expect(workerTierPoolModels(scope, OPTIONS)).toEqual(["provA:quick-a", "provA:quick-b"]);
		// 复核者用自己的档位（这里恰好也是 quick）——池来自方案，不是另一份数据。
		const reviewer = resolveWorkerModelSwitchScope(REVIEWER_QUICK);
		if (!reviewer) throw new Error("scope");
		expect(workerTierPoolModels(reviewer, OPTIONS)).toEqual(["provA:quick-a", "provA:quick-b"]);
	});

	it("空池的档位返回空列表（入口据此不出现）", () => {
		const scope = resolveWorkerModelSwitchScope(`orch--${PROFILE_ID}--medium`);
		if (!scope) throw new Error("scope");
		expect(workerTierPoolModels(scope, OPTIONS)).toEqual([]);
	});

	it("方案不在数据源里时返回空列表，而不是全部模型", () => {
		const scope = resolveWorkerModelSwitchScope(EXECUTOR_QUICK);
		if (!scope) throw new Error("scope");
		// 停用/删除的方案：给一个"看起来可选"的列表最终只会被服务端拒绝。
		expect(workerTierPoolModels(scope, [])).toEqual([]);
		expect(workerTierPoolModels(scope, undefined)).toEqual([]);
	});

	it("池内判定与显示名", () => {
		const scope = resolveWorkerModelSwitchScope(EXECUTOR_QUICK);
		if (!scope) throw new Error("scope");
		expect(isModelInWorkerPool("provA:quick-b", scope, OPTIONS)).toBe(true);
		expect(isModelInWorkerPool("  provA:quick-a ", scope, OPTIONS)).toBe(true);
		expect(isModelInWorkerPool("provA:heavy-model", scope, OPTIONS)).toBe(false);
		expect(labelForPoolModel("provA:quick-a", OPTIONS)).toBe("Quick A");
		// 找不到 label 时退回模型引用本身：显示一个陌生但真实的 id 好过空白。
		expect(labelForPoolModel("provC:unknown", OPTIONS)).toBe("provC:unknown");
	});
});

describe("worker-model-switch — 入口资格", () => {
	const base = {
		subagentType: EXECUTOR_QUICK,
		primaryModel: buildOrchestrationModelValue(PROFILE_ID),
		orchestrationOptions: OPTIONS,
	};

	it("编排 worker 且池非空时出现", () => {
		expect(canOfferWorkerModelSwitch(base)).toBe(true);
		// 复核者同样有资格：它也会撞上配额/余额。
		expect(canOfferWorkerModelSwitch({ ...base, subagentType: REVIEWER_QUICK })).toBe(true);
	});

	it("非编排 worker 不出现", () => {
		for (const subagentType of ["explore", "general", "plan", "review", null, undefined]) {
			expect(canOfferWorkerModelSwitch({ ...base, subagentType })).toBe(false);
		}
	});

	it("别的方案的 worker 不出现（档位池属于那个方案）", () => {
		expect(
			canOfferWorkerModelSwitch({ ...base, subagentType: `orch--${OTHER_PROFILE_ID}--quick` }),
		).toBe(false);
	});

	it("编排会话已退出编排（或换了方案）时不出现", () => {
		// 服务端拿编制者的 model 哨兵取方案；父级退出后这个入口必然失败，
		// 与其让用户点开再收到一条拒绝，不如不显示。
		expect(canOfferWorkerModelSwitch({ ...base, primaryModel: "provA:default" })).toBe(false);
		expect(canOfferWorkerModelSwitch({ ...base, primaryModel: null })).toBe(false);
		expect(
			canOfferWorkerModelSwitch({
				...base,
				primaryModel: buildOrchestrationModelValue(OTHER_PROFILE_ID),
			}),
		).toBe(false);
	});

	it("池为空时不出现（点开只有一个空列表）", () => {
		expect(
			canOfferWorkerModelSwitch({ ...base, subagentType: `orch--${PROFILE_ID}--medium` }),
		).toBe(false);
	});
});

describe("worker-model-switch — 池满时放开池外", () => {
	/** 模型清单：池内的两个都可用，池外有一个可用的和一个不可用的。 */
	const ALL_MODELS: ModelOption[] = [
		{ value: "provA:quick-a", label: "Quick A", provider: "provA" },
		{ value: "provA:quick-b", label: "Quick B", provider: "provA" },
		{ value: "provA:heavy-model", label: "Heavy", provider: "provA" },
		{ value: "provB:rescue", label: "Rescue", provider: "provB" },
		{ value: "provC:dead", label: "Dead", provider: "provC", available: false },
	];

	/** 池内两个模型都已被目录明确标为不可用。 */
	const EXHAUSTED_MODELS: ModelOption[] = ALL_MODELS.map((option) =>
		option.provider === "provA" && option.value !== "provA:heavy-model"
			? { ...option, available: false }
			: option,
	);

	function catalog(overrides: Partial<WorkerModelSwitchCatalog> = {}): WorkerModelSwitchCatalog {
		return {
			allModels: ALL_MODELS,
			visibleModels: ALL_MODELS,
			disabledProviders: new Set<string>(),
			failedModel: null,
			...overrides,
		};
	}

	function scopeOf(tier: "quick" | "medium" | "heavy") {
		const scope = resolveWorkerModelSwitchScope(`orch--${PROFILE_ID}--${tier}`);
		if (!scope) throw new Error("scope");
		return scope;
	}

	it("池内只要还有可用（或看不出不可用）的模型，就只列池内", () => {
		const candidates = workerModelSwitchCandidates(scopeOf("quick"), OPTIONS, catalog());
		expect(candidates).toEqual([
			{ model: "provA:quick-a", outOfPool: false },
			{ model: "provA:quick-b", outOfPool: false },
		]);
		// 池未满时列出池外就等于"永远放开"，正是这个改进要避免的反面。
		expect(candidates.some((candidate) => candidate.outOfPool)).toBe(false);
		// 顶部"池已满"说明的渲染条件同样不成立。
		expect(isWorkerModelSwitchPoolExhausted(scopeOf("quick"), OPTIONS, catalog())).toBe(false);
	});

	it("池满时补上全部可用的池外模型，池内仍在前", () => {
		const candidates = workerModelSwitchCandidates(
			scopeOf("quick"),
			OPTIONS,
			catalog({ allModels: EXHAUSTED_MODELS, visibleModels: EXHAUSTED_MODELS }),
		);
		expect(candidates.map((candidate) => candidate.model)).toEqual([
			// 池内在前：它是这个 worker 的归属，"换回来"必须仍然可行。
			"provA:quick-a",
			"provA:quick-b",
			"provA:heavy-model",
			"provB:rescue",
		]);
		expect(candidates.map((candidate) => candidate.outOfPool)).toEqual([false, false, true, true]);
		// 池外候选只收"可用"的：列一个已知不可用的模型毫无意义。
		expect(candidates.map((candidate) => candidate.model)).not.toContain("provC:dead");
		// 池外徽标 / 逐行说明 / 分区标题的渲染条件：逐行看 outOfPool。
		expect(candidates[2]?.outOfPool).toBe(true);
		// 顶部"池已满"说明的渲染条件。
		expect(
			isWorkerModelSwitchPoolExhausted(scopeOf("quick"), OPTIONS, {
				...catalog({ allModels: EXHAUSTED_MODELS, visibleModels: EXHAUSTED_MODELS }),
			}),
		).toBe(true);
	});

	it("池已满但池外一个可用的都没有时，仍然要说「池已满」", () => {
		// 说明按池的真实状态给：按候选列表判定的话这里会什么都不说，用户只看到一个
		// 全是不可用模型的列表。
		const allDead: ModelOption[] = [
			{ value: "provA:quick-a", label: "Quick A", provider: "provA", available: false },
			{ value: "provA:quick-b", label: "Quick B", provider: "provA", available: false },
			{ value: "provB:also-dead", label: "Also dead", provider: "provB", available: false },
		];
		const catalogWithoutPool = catalog({ allModels: allDead, visibleModels: allDead });
		expect(isWorkerModelSwitchPoolExhausted(scopeOf("quick"), OPTIONS, catalogWithoutPool)).toBe(
			true,
		);
		expect(
			workerModelSwitchCandidates(scopeOf("quick"), OPTIONS, catalogWithoutPool).some(
				(candidate) => candidate.outOfPool,
			),
		).toBe(false);
	});

	it("池内模型全被停用时同样放开（服务端也只认这一条证据）", () => {
		const candidates = workerModelSwitchCandidates(
			scopeOf("quick"),
			OPTIONS,
			catalog({ disabledProviders: new Set(["provA"]) }),
		);
		// provA 整个被停用：它的池内模型（以及池外的 provA:heavy-model）都不可用，
		// 只剩 provB:rescue；provC:dead 是明确的不可用，同样不该被列出。
		expect(candidates.filter((candidate) => candidate.outOfPool).map((c) => c.model)).toEqual([
			"provB:rescue",
		]);
	});

	it("失败归因只覆盖池内一部分时不放开；覆盖整个池时才放开", () => {
		// quick 池两个模型，只有失败归因的那一个算"确定不可用"→ 没满。
		expect(
			workerModelSwitchCandidates(
				scopeOf("quick"),
				OPTIONS,
				catalog({ failedModel: "provA:quick-a" }),
			).some((candidate) => candidate.outOfPool),
		).toBe(false);
		// heavy 池只有一个模型，正是这次被拒的那一个 → 满。
		expect(
			workerModelSwitchCandidates(
				scopeOf("heavy"),
				OPTIONS,
				catalog({ failedModel: "provA:heavy-model" }),
			).map((candidate) => candidate.model),
		).toEqual(["provA:heavy-model", "provA:quick-a", "provA:quick-b", "provB:rescue"]);
	});

	it("空池返回空列表：那是配置错误，选择器不放开（与服务端报错一致）", () => {
		expect(workerModelSwitchCandidates(scopeOf("medium"), OPTIONS, catalog())).toEqual([]);
	});

	it("「模型不在清单里」不算不可用：清单可能只是还没拉取", () => {
		// 空清单（首次打开 / 刚清过缓存）不能把每个池都判成满，否则等于永远放开。
		expect(
			isWorkerTierPoolFullyUnavailable(
				["provA:quick-a", "provA:quick-b"],
				catalog({ allModels: [], visibleModels: [] }),
			),
		).toBe(false);
	});

	it("元引用（哨兵 / 聚合）不参与判定：判错等于静默放开整个池", () => {
		const metaOption: ModelOption = {
			value: buildOrchestrationModelValue(PROFILE_ID),
			label: "标准编排",
			provider: "__orchestration__",
			orchestration: {
				id: PROFILE_ID,
				name: "标准编排",
				orchestratorModels: ["provA:orchestrator"],
				tierPools: { chore: [], quick: ["__default__"], medium: [], heavy: [] },
			},
		};
		expect(isWorkerModelUnavailable("__default__", catalog({ allModels: [] }))).toBe(false);
		expect(
			workerModelSwitchCandidates(scopeOf("quick"), [metaOption], catalog({ allModels: [] })),
		).toEqual([{ model: "__default__", outOfPool: false }]);
	});
});

describe("worker-model-switch — 池外提示的判定", () => {
	it("成功文案：池外优先于续跑方式", () => {
		expect(workerModelSwitchSuccessMessageKey({ continuation: "restarted" })).toBe(
			"workerModelSwitchSuccessRestarted",
		);
		expect(workerModelSwitchSuccessMessageKey({ continuation: "in_place" })).toBe(
			"workerModelSwitchSuccessInPlace",
		);
		// 池外必须显式说出来（容量统计不含它），因此覆盖掉续跑方式那两条。
		expect(workerModelSwitchSuccessMessageKey({ continuation: "restarted", outOfPool: true })).toBe(
			"workerModelSwitchSuccessOutOfPoolRestarted",
		);
		expect(workerModelSwitchSuccessMessageKey({ continuation: "in_place", outOfPool: true })).toBe(
			"workerModelSwitchSuccessOutOfPoolInPlace",
		);
		// 显式的 false / null 都走普通文案。
		expect(
			workerModelSwitchSuccessMessageKey({ continuation: "restarted", outOfPool: false }),
		).toBe("workerModelSwitchSuccessRestarted");
		expect(workerModelSwitchSuccessMessageKey({ continuation: "restarted", outOfPool: null })).toBe(
			"workerModelSwitchSuccessRestarted",
		);
	});

	it("失败归因模型从 errorMessage 信封里取", () => {
		expect(
			workerFailedModelFromErrorMessage(
				JSON.stringify({ type: "quota_exhausted", model: "provA:quick-a" }),
			),
		).toBe("provA:quick-a");
		// 纯文本错误（402 / 网络）没有归因，宁可不给证据。
		expect(workerFailedModelFromErrorMessage("Error: 402 payment required")).toBeNull();
		expect(workerFailedModelFromErrorMessage(null)).toBeNull();
		expect(workerFailedModelFromErrorMessage(undefined)).toBeNull();
	});
});

describe("worker-model-switch — 运行期等待标记", () => {
	it("帧 → 标记：字段缺失时不写空值", () => {
		expect(subagentModelWaitFromEvent({ model: "provA:quick-a" })).toEqual({
			model: "provA:quick-a",
		});
		expect(
			subagentModelWaitFromEvent({ model: "provA:quick-a", waitKind: "quota", resumeAt: 123 }),
		).toEqual({ model: "provA:quick-a", waitKind: "quota", resumeAt: 123 });
	});

	it("标记 / 清除是对称的，且没有变化时返回同一个引用", () => {
		// 显式的索引签名：真实的 narrator 行就是一份动态 JSON，标注清楚后
		// 才能对"标记字段"做断言（推断出的字面量类型里没有 `_modelWait`）。
		const row: Record<string, unknown> = { id: "w1", model: "provA:quick-a" };
		const marked = applySubagentModelWaitToCachedRow(row, {
			model: "provA:quick-a",
			waitKind: "quota",
			resumeAt: 456,
		});
		expect(marked).toEqual({
			id: "w1",
			model: "provA:quick-a",
			_modelWait: { model: "provA:quick-a", waitKind: "quota", resumeAt: 456 },
		});
		// 同一个等待重复到达：原引用（否则每次重连都要让订阅它的组件重渲染）。
		expect(
			applySubagentModelWaitToCachedRow(marked, {
				model: "provA:quick-a",
				waitKind: "quota",
				resumeAt: 456,
			}),
		).toBe(marked);
		// 恢复帧必须把标记**删掉**（不是写 null）：否则一个已经恢复的 worker
		// 会一直带着"还在等模型"的标记和一个可点的换模型入口。
		const cleared = applySubagentModelWaitToCachedRow(marked, null);
		expect(cleared).toEqual({ id: "w1", model: "provA:quick-a" });
		expect("_modelWait" in (cleared ?? {})).toBe(false);
		// 本来就没有标记时清除：原引用。
		expect(applySubagentModelWaitToCachedRow(row, null)).toBe(row);
		// 空行：原样返回。
		expect(applySubagentModelWaitToCachedRow(undefined, { model: "m" })).toBeUndefined();
	});
});
