/**
 * 编排 worker 的「换模型继续」——纯判定部分（阶段 6）。
 *
 * 这里只有函数，没有任何 React / REST：换模型入口该不该出现、能选哪些模型，
 * 都由这几个纯函数回答，因此可以直接单测（组件层要挂载整个列表，挂不起来）。
 *
 * 模型列表来自 `useAllModels().orchestrationOptions`——阶段 3 补建立的编排菜单
 * 数据源，里面已经带好每档的 `tierPools`。**不再另造一份池数据**：两份池一旦漂移，
 * 菜单里显示"池内"的模型会被服务端按另一份池拒绝，而用户看到的是"这个模型不能选"
 * 却在自己刚刚点过的分组里。
 */

import {
	isOrchestrationWorkerType,
	type OrchestrationWorkerTier,
	parseModelFailureModel,
	parseOrchestrationWorkerType,
	type SubagentModelWait,
} from "@shared/orchestration-worker-type";
import {
	type ModelOption,
	type OrchestrationMenuProfile,
	parseOrchestrationModelValue,
} from "../../../lib/constants";

export interface WorkerModelSwitchScope {
	kind: "executor" | "reviewer";
	profileId: string;
	tier: OrchestrationWorkerTier;
}

/** 该子代理类型对应的编排档位；非编排 worker 返回 null。 */
export function resolveWorkerModelSwitchScope(
	subagentType: string | null | undefined,
): WorkerModelSwitchScope | null {
	return parseOrchestrationWorkerType(subagentType);
}

/**
 * 该 worker 档位池内的模型，按池内声明顺序返回。
 *
 * 方案不在 `orchestrationOptions` 里（被停用、被删掉、或方案缺档）时返回空数组：
 * 一个"看起来可选"的模型列表最终会被服务端拒绝，不如让入口本身不出现。
 */
export function workerTierPoolModels(
	scope: WorkerModelSwitchScope,
	orchestrationOptions: readonly ModelOption[] | undefined,
): string[] {
	const profile = findProfile(scope.profileId, orchestrationOptions);
	if (!profile) return [];
	const pool = profile.tierPools?.[scope.tier];
	return Array.isArray(pool) ? pool.filter((model) => model.trim().length > 0) : [];
}

function findProfile(
	profileId: string,
	orchestrationOptions: readonly ModelOption[] | undefined,
): OrchestrationMenuProfile | undefined {
	for (const option of orchestrationOptions ?? []) {
		const profile = option.orchestration;
		if (profile && profile.id === profileId) return profile;
	}
	return undefined;
}

/**
 * 该 worker 现在是否应该提供「换模型继续」入口。
 *
 * 三个条件缺一不可：
 *
 *  - 类型是编排 worker（执行者或复核者）。普通子代理换模型没有意义，也不该由
 *    这个入口承担——那会绕过子代理模型策略；
 *  - 它的编排会话仍在**同一个方案**上。服务端拿编制者的 `model` 哨兵取方案，
 *    因此父级退出编排（或换了方案）之后这个入口必然失败；与其让用户点开再收到
 *    一条拒绝，不如不显示；
 *  - 池里至少有一个模型可用。空池时按钮点开只能看到一个空列表。
 *
 * 调用方负责"是否处于出错/等待态"那一半：它是逐行/逐次读的运行时事实。
 */
export function canOfferWorkerModelSwitch(input: {
	subagentType: string | null | undefined;
	/** 该 worker 的父叙述者（编排会话）当前的 `model` 值。 */
	primaryModel: string | null | undefined;
	orchestrationOptions: readonly ModelOption[] | undefined;
}): boolean {
	const scope = resolveWorkerModelSwitchScope(input.subagentType);
	if (!scope) return false;
	const activeProfileId = parseOrchestrationModelValue(input.primaryModel)?.profileId;
	if (activeProfileId !== scope.profileId) return false;
	return workerTierPoolModels(scope, input.orchestrationOptions).length > 0;
}

/**
 * 池内模型的显示名：优先用设置菜单里那份 label（与用户在菜单里看到的完全一致），
 * 找不到时退回模型引用本身——显示一个陌生但真实的 id，好过显示空白。
 */
export function labelForPoolModel(
	model: string,
	allModels: readonly ModelOption[] | undefined,
): string {
	const found = allModels?.find((option) => option.value === model);
	return found?.label ?? model;
}

/**
 * 服务端判定的镜像：目标模型是否在该 worker 的档位池内。
 *
 * 前端保留一份是为了**在提交前**就能给池外模型一个明确反馈（服务端仍然会再校验，
 * 它是权威）——例如设置在本页打开后被别的管理员改过。
 */
export function isModelInWorkerPool(
	model: string,
	scope: WorkerModelSwitchScope,
	orchestrationOptions: readonly ModelOption[] | undefined,
): boolean {
	const target = model.trim();
	return workerTierPoolModels(scope, orchestrationOptions).includes(target);
}

/** 「模型是否可用」的证据来源。语义与服务端 `recover.ts` 的同名判定逐条对齐。 */
export interface WorkerModelSwitchCatalog {
	/**
	 * 读 `available` 标记用的全量模型（含被用户隐藏的模型，隐藏不是不可用）。
	 *
	 * 与 `visibleModels` 分开是必要的：判断"这个池内模型能不能用"必须能看到被
	 * 隐藏的条目，而"池外可选"只能列用户看得见的模型。
	 */
	allModels: readonly ModelOption[] | undefined;
	/** 池外候选的来源：用户可见的模型（已排除停用的 provider 与隐藏项）。 */
	visibleModels: readonly ModelOption[] | undefined;
	/** 被停用的 provider 前缀（provider 自身 disabled，或全局 disabledProviders）。 */
	disabledProviders?: ReadonlySet<string>;
	/**
	 * 本次失败归因的模型（narrator 行 `errorMessage` 信封里的 `model`）。
	 *
	 * 第一手证据：一次真实被拒的请求。NUG 之外提供者的配额墙（Kimicode 计划用尽
	 * 等）不会体现在任何 `available` 标记上，只有它能覆盖。
	 */
	failedModel?: string | null;
}

/** 模型值里的提供者前缀（首个冒号之前）；没有前缀时返回空串。 */
function modelProviderPrefix(model: string): string {
	const colon = model.indexOf(":");
	return colon > 0 ? model.slice(0, colon) : "";
}

/**
 * 这个模型是否**确定**不可用。
 *
 * 与服务端 `createModelUnavailabilityProbe` 同一套证据、同一条保守方向：只有
 * "取消前必须承认的否定"才算不可用，其余一律当作可用。
 *
 * 刻意**不**把"模型不在模型清单里"当作不可用：清单可能只是还没拉取（首次打开、
 * 刚清过缓存、该 provider 的目录为空），而那样会把每个池都判成"满"，等于永远放开
 * 池外——正是这个改进要避免的反面。
 */
export function isWorkerModelUnavailable(
	model: string,
	catalog: WorkerModelSwitchCatalog,
): boolean {
	const target = model.trim();
	if (!target) return false;
	// 哨兵（follow-default / follow-parent）与聚合不是具体模型：它们的可用性取决于
	// 解析结果，不在这一层判定；判错会让"池里放了个聚合"变成静默放开全部模型。
	if (target.startsWith("__")) return false;
	const failedModel = catalog.failedModel?.trim();
	if (failedModel && failedModel === target) return true;
	const option = catalog.allModels?.find((candidate) => candidate.value === target);
	if (option?.available === false) return true;
	const prefix = modelProviderPrefix(target);
	if (!prefix) return false;
	return catalog.disabledProviders?.has(prefix) === true;
}

/** 该档位池是否已经一个可用模型都没有（空池不算，那是配置错误）。 */
export function isWorkerTierPoolFullyUnavailable(
	pool: readonly string[],
	catalog: WorkerModelSwitchCatalog,
): boolean {
	if (pool.length === 0) return false;
	return pool.every((model) => isWorkerModelUnavailable(model, catalog));
}

/** 选择器里的一个候选：模型引用 + 它是否在池外。 */
export interface WorkerModelCandidate {
	model: string;
	/** true = 本次不在池内（只在池内全部不可用时才可能出现）。 */
	outOfPool: boolean;
}

/**
 * 选择器该列出哪些模型。
 *
 * - 池内还有可用模型（含"看不出来不可用"）：只列池内，保持阶段 6 的池内调度语义；
 * - 池内一个可用的都没有：列池内（顺序在前，它仍是这个 worker 的归属）再补上**全部
 *   可用**的池外模型。只放池外而不列池内会让"换回来"变得不可能，而池内模型的
 *   "不可用"只是此刻的观测（配额窗口会重置）。
 * - 池为空：返回空列表，与服务端的"空池仍然报配置错误"一致——选择器不该在此时
 *   放开，否则会把一个配置错误伪装成"池满"。
 */
export function workerModelSwitchCandidates(
	scope: WorkerModelSwitchScope,
	orchestrationOptions: readonly ModelOption[] | undefined,
	catalog: WorkerModelSwitchCatalog,
): WorkerModelCandidate[] {
	const pool = workerTierPoolModels(scope, orchestrationOptions);
	if (pool.length === 0) return [];
	const candidates: WorkerModelCandidate[] = pool.map((model) => ({ model, outOfPool: false }));
	if (!isWorkerTierPoolFullyUnavailable(pool, catalog)) return candidates;
	const inPool = new Set(pool);
	for (const option of catalog.visibleModels ?? []) {
		const value = option.value.trim();
		if (!value || inPool.has(value)) continue;
		// 元引用（follow-default / follow-parent / 聚合）不作为池外候选：它们不是
		// 具体模型，选中它们等于把"跟随默认模型"塞进一个 worker 的模型列，语义完全
		// 不同（而且下次复用会漂回池内）。这里与池内判定保持同一个边界。
		if (value.startsWith("__")) continue;
		if (isWorkerModelUnavailable(value, catalog)) continue;
		candidates.push({ model: value, outOfPool: true });
	}
	return candidates;
}

/**
 * 该 worker 的档位池是否已经全不可用——顶部说明用它判定。
 *
 * 刻意不写成"候选里有池外项"：池满时**池外也可能一个可用的都没有**，此时按候选
 * 列表判定就等于什么都不说，用户只看到一个全是不可用模型的列表，不知道系统为什么
 * 没有别的可选。说明按池的真实状态给，池外有没有东西可选是另一回事。
 */
export function isWorkerModelSwitchPoolExhausted(
	scope: WorkerModelSwitchScope,
	orchestrationOptions: readonly ModelOption[] | undefined,
	catalog: WorkerModelSwitchCatalog,
): boolean {
	return isWorkerTierPoolFullyUnavailable(
		workerTierPoolModels(scope, orchestrationOptions),
		catalog,
	);
}

/**
 * 成功反馈该用哪条文案。
 *
 * 池外换模型必须**显式**说出来（"本次不在池内，容量统计不含它"）：容量均摊只认
 * 池内模型，用户以为这次仍按池记账时会得到一份对不上的统计。因此 `outOfPool` 优先
 * 于 `continuation` 决定文案，而不是在两条既有文案后面缀一句。
 */
export function workerModelSwitchSuccessMessageKey(input: {
	continuation: "restarted" | "in_place";
	outOfPool?: boolean | null;
}): string {
	if (input.outOfPool) {
		return input.continuation === "in_place"
			? "workerModelSwitchSuccessOutOfPoolInPlace"
			: "workerModelSwitchSuccessOutOfPoolRestarted";
	}
	return input.continuation === "in_place"
		? "workerModelSwitchSuccessInPlace"
		: "workerModelSwitchSuccessRestarted";
}

/** 从 narrator 行的 `errorMessage` 取失败归因模型（供选择器判定池是否已满）。 */
export function workerFailedModelFromErrorMessage(
	errorMessage: string | null | undefined,
): string | null {
	return parseModelFailureModel(errorMessage);
}

/**
 * WS 帧 → 运行期等待标记。两个事件（waiting / recovered）共用一个形状，
 * 字段缺失时**不写空值**：`waitKind` 缺失就是"不知道是哪一种"，用 `undefined`
 * 表达比用 `"credentials"` 猜一个更诚实——猜错会让文案说"凭据不可用"而实际是配额。
 */
export function subagentModelWaitFromEvent(info: {
	model: string;
	waitKind?: "credentials" | "quota";
	resumeAt?: number;
}): SubagentModelWait {
	return {
		model: info.model,
		...(info.waitKind ? { waitKind: info.waitKind } : {}),
		...(info.resumeAt != null ? { resumeAt: info.resumeAt } : {}),
	};
}

/**
 * 把等待标记打到缓存的 narrator 行上（`_modelWait`），或清除它。
 *
 * 单独抽出来是为了"标记 / 清除"这一对**对称**：任何一处忘了清，一个已经恢复的
 * 子代理会一直显示成"还在等模型"，而它还带着一个可点的换模型入口。函数返回同一个
 * 引用表示没有变化，让调用方可以省掉一次无谓的失效。
 *
 * 刻意不碰 `substatus`：状态与子状态是会话运行时的事实，由 `subagent_status_changed`
 * 与状态接口负责同步；这里只写"是否在等模型"这一件事，两个来源就不会互相打架。
 */
export function applySubagentModelWaitToCachedRow<T extends Record<string, unknown>>(
	row: T | undefined,
	wait: SubagentModelWait | null,
): T | undefined {
	if (!row) return row;
	const current = row._modelWait as SubagentModelWait | undefined;
	if (!wait) {
		if (current === undefined) return row;
		const { _modelWait: _cleared, ...rest } = row;
		return rest as T;
	}
	if (
		current &&
		current.model === wait.model &&
		current.waitKind === wait.waitKind &&
		current.resumeAt === wait.resumeAt
	) {
		return row;
	}
	return { ...row, _modelWait: wait };
}

/** 是否属于任一编排（错误卡片用它判定"这个错误属于编排 worker"）。 */
export { isOrchestrationWorkerType };
