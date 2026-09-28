/**
 * 编排 worker 的「换模型继续」（阶段 6）。
 *
 * 场景：编排的执行者 / 复核者在跑的时候撞上配额、余额或模型不可用，用户希望
 * **换个模型让它带着已有上下文接着干**——而不是整个任务失败、也不是从头再来。
 *
 * 这里只做三件事，且都必须按顺序发生：
 *
 *   1. 判断这个子代理是不是**本编排**的 worker（类型编码 + 父级归属），以及它
 *      现在是否处于可换模型的状态；
 *   2. 校验目标模型确实在**该 worker 档位的模型池**内（编排的语义就是池内调度）。
 *      **例外**：池内一个可用模型都没有时（池整体不可用正是这个入口最常见的场景），
 *      池外模型会被接受，并在返回值里带 `outOfPool: true`。判定见
 *      {@link createModelUnavailabilityProbe}——它只认确定的否定证据，缺失即视为
 *      可用；空池不算"池满"，仍然报配置错误；
 *   3. 先落库再续跑：`updateModel` → 必要时解除归档 → `updateNarratorModel` →
 *      `resumeSubagent`。
 *
 * **为什么必须先落库再续跑**：`resumeSubagent` 没有 `model` 参数，它一律从
 * `narrators.model` 解析本次运行使用的模型。给它加一个 `model` 参数会让"这个
 * worker 到底用的什么模型"不可追溯，也会绕过子代理模型策略，因此那条路是刻意
 * 关着的——调用方唯一正确的姿势就是先把模型写进去。
 *
 * **为什么等待态不续跑**：worker 被 `suspendUntilModelRecovered` 停在
 * `status = "waiting"` 时，它的 turn 仍然活着；`updateNarratorModel` 会取消那次
 * 等待（`_modelUnavailableWaitCancel`），循环在下一轮重新读取 `active.model` 并用
 * 新模型重发同一个请求。此时再调 `resumeSubagent` 只会被"仍在运行"拒绝，强行
 * 放行则会起出第二个运行体。所以等待态只写模型，那本身就是"接着干"。
 */

import { ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { resolveKnownUnavailableNugModel } from "@server/lib/nug-model-availability";
import { isModelProviderDisabled, parseOrchestrationModelValue } from "@server/lib/settings";
import type { Locale } from "@shared/i18n-locales";
import { parseModelFailureModel } from "@shared/orchestration-worker-type";
import { type OrchestrationTier, parseOrchestrationType, REVIEWER_TYPE_PREFIX } from "./types";

/** worker 在该编排里扮演的角色。复核者与执行者用同一套恢复流程。 */
export type OrchestrationWorkerKind = "executor" | "reviewer";

export interface OrchestrationWorkerScope {
	kind: OrchestrationWorkerKind;
	profileId: string;
	tier: OrchestrationTier;
}

/** 复核者类型的解析结果（`orch-review--<profileId>--<tier>`）。 */
function parseReviewerType(subagentType: string): { profileId: string; tier: string } | null {
	if (!subagentType.startsWith(REVIEWER_TYPE_PREFIX)) return null;
	const rest = subagentType.slice(REVIEWER_TYPE_PREFIX.length);
	const parts = rest.split("--");
	if (parts.length !== 2) return null;
	const [profileId, tier] = parts;
	if (!profileId || !tier) return null;
	return { profileId, tier };
}

/**
 * 解析子代理类型编码，并确认它属于给定编排方案。
 *
 * 两级都查：类型必须能解析出 (profileId, tier)，且 profileId 必须等于**这个**
 * 编排会话的方案 id。只查前缀的话，另一个方案的 worker 也能被本会话"救活"，
 * 而它的档位池、容量记账都属于另一个编排。
 *
 * 复核者与执行者共用这个入口但保留 `kind`：复核者的工具集是只读的、档位取自
 * `profile.review.reviewTier`，因此它的池是**复核档位**的池，不是执行档位的池。
 */
export function resolveOrchestrationWorkerScope(
	subagentType: string | null | undefined,
	expectedProfileId: string,
): OrchestrationWorkerScope | null {
	if (typeof subagentType !== "string" || subagentType.length === 0) return null;
	const reviewer = parseReviewerType(subagentType);
	if (reviewer) {
		if (reviewer.profileId !== expectedProfileId) return null;
		const parsed = parseOrchestrationType(`orch--${reviewer.profileId}--${reviewer.tier}`);
		if (!parsed.ok) return null;
		return { kind: "reviewer", profileId: parsed.profileId, tier: parsed.tier };
	}
	const parsed = parseOrchestrationType(subagentType);
	if (!parsed.ok) return null;
	if (parsed.profileId !== expectedProfileId) return null;
	return { kind: "executor", profileId: parsed.profileId, tier: parsed.tier };
}

/** 该子代理类型是否属于任何编排队列（判定只看类型编码，不看 narratorId 或形状）。 */
export function isOrchestrationWorkerType(subagentType: string | null | undefined): boolean {
	if (typeof subagentType !== "string" || subagentType.length === 0) return false;
	if (parseOrchestrationType(subagentType).ok) return true;
	const reviewer = parseReviewerType(subagentType);
	if (!reviewer) return false;
	return parseOrchestrationType(`orch--${reviewer.profileId}--${reviewer.tier}`).ok;
}

/** 档位池里按顺序排列的模型引用（跳过坏条目）。 */
export function tierPoolModels(
	profile: { tiers?: Record<string, { pool?: unknown } | undefined> } | null | undefined,
	tier: OrchestrationTier,
): string[] {
	const pool = profile?.tiers?.[tier]?.pool;
	if (!Array.isArray(pool)) return [];
	const models: string[] = [];
	for (const entry of pool as unknown[]) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const model = (entry as { model?: unknown }).model;
		if (typeof model === "string" && model.trim().length > 0) models.push(model.trim());
	}
	return models;
}

/** 目标模型是否在该档位池内。比较前统一 trim，避免只差空白被误判为池外。 */
export function isModelInTierPool(
	profile: { tiers?: Record<string, { pool?: unknown } | undefined> } | null | undefined,
	tier: OrchestrationTier,
	model: string,
): boolean {
	const target = model.trim();
	return tierPoolModels(profile, tier).includes(target);
}

/**
 * 判定一个模型**是否确定不可用**的证据来源。
 *
 * 每一项都是"确定的否定"，缺失即视为可用——这是刻意的保守方向：把可用的模型
 * 误判成不可用会让选择器放开池外（一次注定被拒的操作），把不可用的模型误判成
 * 可用只会维持现状（用户还能去设置页改池子）。
 */
export interface ModelUnavailabilityEvidence {
	/** 提供者被停用（provider 自身 disabled 或全局 disabledProviders）。 */
	isProviderDisabled?: (model: string) => boolean;
	/** 模型目录明确记着它当前不可用（NUG 网关凭据池整体停用）。 */
	isCatalogUnavailable?: (model: string) => boolean;
	/** 本次失败归因的模型（`errorMessage` 信封），第一手证据。 */
	failedModel?: string | null;
}

/**
 * 组合出一个「该模型是否确定不可用」的判定函数。
 *
 * 抽成纯函数是因为"什么算不可用"正是这个功能最容易悄悄做错的地方：多算一类信号
 * 就等于放弃池内调度，少算一类就等于功能不生效，而两种偏差在界面上都只是"按钮
 * 有/没有"。因此这里只做证据的**并集**，不读任何全局状态。
 */
export function createModelUnavailabilityProbe(
	evidence: ModelUnavailabilityEvidence,
): (model: string) => boolean {
	const failedModel = evidence.failedModel?.trim() || null;
	/**
	 * 查询不可用证据。
	 *
	 * 任何异常都按"没有证据"处理：一次坏配置（手编过的 settings.json）不该把
	 * 「池外目标被拒」这条可读的校验错误变成 500，也不该顺势放开池外。两个方向里
	 * 只有"当作可用"是安全的。
	 */
	const hasEvidence = (
		probe: ((model: string) => boolean) | undefined,
		target: string,
	): boolean => {
		if (!probe) return false;
		try {
			return probe(target) === true;
		} catch (err) {
			logger.warn("Model unavailability probe failed; treating the model as available", {
				model: target,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	};
	return (model: string) => {
		const target = model.trim();
		if (!target) return false;
		// 哨兵与聚合这类元引用不是具体模型，它们的可用性取决于解析结果（解析要读
		// 设置、还可能推进聚合的轮询游标），不在这一层的判定范围内 → 一律不判定。
		if (target.startsWith("__")) return false;
		if (failedModel !== null && failedModel === target) return true;
		if (hasEvidence(evidence.isCatalogUnavailable, target)) return true;
		return hasEvidence(evidence.isProviderDisabled, target);
	};
}

/**
 * 该档位池是否**已经没有一个可用模型**。
 *
 * 空池**不算**：那是另一种配置错误（档位没配模型），既有的报错路径要保留，否则
 * 一个"忘了配"的方案会变成"静默放开全部模型"，把配置错误藏起来。
 */
export function isPoolFullyUnavailable(
	pool: readonly string[],
	isUnavailable: (model: string) => boolean,
): boolean {
	if (pool.length === 0) return false;
	return pool.every((model) => isUnavailable(model));
}

/** 模型值里的提供者前缀（首个冒号之前）；没有前缀时返回空串。 */
function modelProviderPrefix(model: string): string {
	const colon = model.indexOf(":");
	return colon > 0 ? model.slice(0, colon) : "";
}

/**
 * 服务端的「池全不可用」判定：把 {@link createModelUnavailabilityProbe} 接到真实
 * 的可用性来源上。
 *
 * 服务端**没有**单一的"模型是否可用"查询入口：NUG 走目录缓存，其它提供者只有
 * "被停用"这一个确定信号，配额 / 余额不足更是只以一次被拒的请求体现。因此这里
 * 刻意只用两类确定的否定证据：
 *
 *  1. 提供者被停用（`settings` 的停用集合，与设置页看到的是同一份）；
 *  2. NUG 目录明确记着该模型 `available: false`（凭据池整体停用）；
 *  3. 该模型就是这次失败归因的模型（`errorMessage` 信封里的 `model`）——这是第一
 *     手证据，也是唯一能覆盖非 NUG 提供者配额墙的信号。
 *
 * 不用"模型不在任何目录里"：目录可能只是还没拉取（测试 / 首次启动时全部为空），
 * 那样会把每一个池都判成"满"，等于永远放开。
 */
export function isTierPoolFullyUnavailable(
	pool: readonly string[],
	errorMessage?: string | null,
): boolean {
	const probe = createModelUnavailabilityProbe({
		isProviderDisabled: (model) => isModelProviderDisabled(model),
		isCatalogUnavailable: (model) => {
			const prefix = modelProviderPrefix(model);
			if (!prefix) return false;
			return resolveKnownUnavailableNugModel(model, prefix) !== null;
		},
		failedModel: parseModelFailureModel(errorMessage),
	});
	return isPoolFullyUnavailable(pool, probe);
}

/** worker 当前的恢复方式。 */
export type OrchestrationRecoverMode =
	/** 归档：先解除归档再续跑新的一轮。 */
	| "unarchive"
	/** 空闲（含本轮出错后停在 idle 的情况）：续跑新的一轮。 */
	| "resume"
	/** 停在模型不可用的等待态：只写模型，活着的那个 turn 会自己接着跑。 */
	| "parked";

export type OrchestrationRecoverState =
	| { ok: true; mode: OrchestrationRecoverMode }
	| { ok: false; reason: string };

/** 模型不可用等待态在 `substatus` 里的两个标记（见 orchestrator 的等待分支）。 */
const MODEL_WAIT_SUBSTATUSES = new Set(["model_unavailable", "quota_exhausted"]);

/**
 * 等待态的 `errorMessage` 是一个 JSON 信封，`type` 是权威的等待类型。
 * `substatus` 缺失（被别处覆盖过）时的兜底判定。
 */
function readModelWaitType(errorMessage: string | null | undefined): boolean {
	if (typeof errorMessage !== "string" || !errorMessage.startsWith("{")) return false;
	try {
		const parsed = JSON.parse(errorMessage) as { type?: unknown };
		return parsed.type === "model_unavailable" || parsed.type === "quota_exhausted";
	} catch {
		return false;
	}
}

/** 把 `substatus` 的两种形态统一成数组（数组、JSON 字符串、空）。 */
function normalizeSubstatus(raw: string[] | string | null | undefined): string[] {
	if (Array.isArray(raw)) return raw.map((item) => String(item));
	if (typeof raw !== "string") return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
	} catch {
		return [];
	}
}

/**
 * 判断 worker 行是否处于可以换模型的状态。
 *
 * 判定刻意分成三种而不是"不是 working 就放行"：
 *
 * - `waiting` 只认**模型不可用**这一种等待。权限等待、计划模式暂停同样写
 *   `waiting`，但换模型对它们毫无帮助，放行只会给出一次看着成功、实际没动的操作。
 * - `working` 一律拒绝。正在生成的请求已经冻结了模型，此时换模型的界面会显示成功，
 *   而这一轮用的还是旧模型——用户会以为救活了。
 * - 其余状态（含 `idle` 上的出错态）走续跑，那才是"接着干"的正常入口。
 */
export function resolveOrchestrationRecoverState(input: {
	status: string;
	/**
	 * 既接受解析好的数组，也接受数据库里的 JSON 字符串——`narratorService.getById`
	 * 返回的是原始行（`narrators.substatus` 是 text），调用方少解析一次就少一条
	 * "看起来是空的所以放行了"的路径。
	 */
	substatus?: string[] | string | null;
	errorMessage?: string | null;
}): OrchestrationRecoverState {
	const status = (input.status ?? "").trim();
	if (status === "archived") return { ok: true, mode: "unarchive" };
	if (status === "idle") return { ok: true, mode: "resume" };
	if (status === "working") {
		return { ok: false, reason: "该 worker 仍在运行中，等它停下来再换模型" };
	}
	if (status === "waiting") {
		const marks = normalizeSubstatus(input.substatus);
		const inModelWait = marks.some((mark) => MODEL_WAIT_SUBSTATUSES.has(mark));
		if (inModelWait || readModelWaitType(input.errorMessage)) return { ok: true, mode: "parked" };
		return { ok: false, reason: "该 worker 正在等待其它条件（权限或输入），换模型对它没有帮助" };
	}
	return { ok: false, reason: `该 worker 当前状态（${status || "未知"}）不支持换模型继续` };
}

/** 换模型继续的结果，供路由原样返回给前端。 */
export interface OrchestrationRecoverOutcome {
	ok: true;
	workerNarratorId: string;
	model: string;
	tier: OrchestrationTier;
	kind: OrchestrationWorkerKind;
	/** `restarted` 起了新的一轮；`in_place` 是等待中的 turn 自己换了模型接着跑。 */
	continuation: "restarted" | "in_place";
	/**
	 * true = 这次选中的模型在档位池外，是**池内已无可用模型**时被刻意放开的。
	 *
	 * 它会一路传到前端，用来解释"为什么这次可以不按池选"，并提醒这次选择不计入
	 * 该档位的容量统计（容量均摊只认池内模型）。
	 */
	outOfPool: boolean;
	/** 该 worker 档位的池内容，供前端在"池已满"时说明原本的候选。 */
	tierPool: string[];
}

export interface RecoverOrchestrationWorkerInput {
	primaryNarratorId: string;
	workerNarratorId: string;
	model: string;
	/** `continue`（默认）从停下的地方接着做；`retry` 重来上一轮。 */
	action: "continue" | "retry";
	locale: Locale;
	createdBy?: string | null;
}

/**
 * 让一个撞上配额 / 余额 / 模型不可用的编排 worker 换模型接着干。
 *
 * 所有拒绝理由都是给用户看的，因此都用中文且指明具体对象。
 * 可预期的问题一律走 `ValidationError`，由全局错误处理器序列化。
 */
export async function recoverOrchestrationWorker(
	input: RecoverOrchestrationWorkerInput,
): Promise<OrchestrationRecoverOutcome> {
	// 服务层一律动态加载：`narrator-service` / `narrator-session` 反向依赖
	// agent 运行时，静态 import 会闭合出一条 require 环（与 review.ts 同理）。
	const [{ narratorService }, { updateNarratorModel }, { findEnabledProfile }] = await Promise.all([
		import("@server/services/narrator-service"),
		import("@server/services/narrator-session"),
		import("./runtime"),
	]);

	const workerNarratorId = input.workerNarratorId.trim();
	const model = input.model.trim();
	if (!workerNarratorId) throw new ValidationError("workerNarratorId 不能为空");
	if (!model) throw new ValidationError("model 不能为空");

	const primary = await narratorService.getById(input.primaryNarratorId);
	const orchestration = parseOrchestrationModelValue(primary.model);
	if (!orchestration) {
		throw new ValidationError("该会话不在编排模式下，没有可换模型的 worker");
	}
	const profile = findEnabledProfile(orchestration.profileId);
	if (!profile) {
		throw new ValidationError(`编排方案 "${orchestration.profileId}" 不存在或未启用`);
	}

	const worker = await narratorService.getById(workerNarratorId);
	// 只认直接子代：编排的 worker 一定由这个编制者派生，深层后代属于别的编排上下文，
	// 拿它的档位池去记账会让容量归属失真。
	if (worker.parentNarratorId !== input.primaryNarratorId) {
		throw new ValidationError("该子代理不是此编排会话的直接子代，无法换模型继续");
	}
	const scope = resolveOrchestrationWorkerScope(worker.subagentType, orchestration.profileId);
	if (!scope) {
		throw new ValidationError("该子代理不是本编排的执行者或复核者");
	}

	const pool = tierPoolModels(profile, scope.tier);
	let outOfPool = false;
	if (!isModelInTierPool(profile, scope.tier, model)) {
		if (pool.length === 0) {
			// 空池是配置错误，不是"池满"：不放开，保持既有报错。
			throw new ValidationError(
				`该 worker 的 ${scope.tier} 档位没有配置任何模型，请先在编排方案里补上`,
			);
		}
		// 池内一个可用的都没有时，继续按池限制等于把用户锁死——恰恰是在他最需要
		// 换模型的那一刻（池整体不可用正是触发这个入口的典型场景）。此时放开池外，
		// 并在返回值里标明，让前端把"这次不在池内、容量统计不含它"讲清楚。
		if (!isTierPoolFullyUnavailable(pool, worker.errorMessage)) {
			// 池内仍有可用模型：编排的语义是"池内调度"，允许任意模型会让容量记账与
			// 容量均摊失真，而且这个 worker 下次被复用时又会漂回池内模型，用户看到的
			// 是"换了又变回去"。
			throw new ValidationError(
				`模型 "${model}" 不在该 worker 的 ${scope.tier} 档位池内，池内仍有可用模型，请从池中选择：${pool.join("、")}`,
			);
		}
		outOfPool = true;
		logger.warn("Orchestration worker recovered onto a model outside an exhausted tier pool", {
			workerNarratorId,
			primaryNarratorId: input.primaryNarratorId,
			model,
			tier: scope.tier,
			tierPool: pool,
		});
	}

	const state = resolveOrchestrationRecoverState({
		status: worker.status,
		substatus: worker.substatus ?? null,
		errorMessage: worker.errorMessage ?? null,
	});
	if (!state.ok) throw new ValidationError(state.reason);

	// 顺序是契约的一部分：先落库（updateModel → 必要时解除归档 → updateNarratorModel），
	// 再续跑。`resumeSubagent` 从 DB 行解析模型，先写库才保证它拿到的是新模型。
	await narratorService.updateModel(workerNarratorId, model);
	if (state.mode === "unarchive") {
		// `resumeSubagent` 明确拒绝 archived；停放池里的 worker 正是归档态，
		// 复用前必须先回到 idle（与 `runSelfReview`、`POST /:id/retry` 同一个动作）。
		await narratorService.updateStatus(workerNarratorId, "idle");
	}
	updateNarratorModel(workerNarratorId, model);

	if (state.mode === "parked") {
		// 等待中的 turn 活着，模型写入已经取消了那次等待，它会用新模型重发同一个请求。
		logger.info("Orchestration worker model switched while parked on model recovery", {
			workerNarratorId,
			primaryNarratorId: input.primaryNarratorId,
			model,
		});
		return {
			ok: true,
			workerNarratorId,
			model,
			tier: scope.tier,
			kind: scope.kind,
			continuation: "in_place",
			outOfPool,
			tierPool: pool,
		};
	}

	const { resumeSubagent } = await import("@server/services/subagent-resume");
	const resumed = await resumeSubagent({
		subagentId: workerNarratorId,
		// `continue_tool_results` 是唯一"从停下的那一步接着做"的 intent：还有未消费的
		// 工具结果时它直接把结果喂回去（不重跑已完成的工具），否则回落成一条
		// "继续"的用户消息——正是本功能要的语义。`retry` 走 `retry_last_input`，
		// 与 `POST /:id/retry` 对子代理的既有行为一致（会回滚该轮的文件改动）。
		intent: input.action === "retry" ? "retry_last_input" : "continue_tool_results",
		// 由用户点击发起，与所有用户发起的续跑一致。`actor: "user"` 同时保持这个
		// worker 与它首次派发相同的上报语义（不额外获得向父级 Send 的通道，
		// 那是 `parent_agent` 的含义，只用于编制者自己发起的续跑）。
		actor: "user",
		createdBy: input.createdBy ?? null,
		locale: input.locale,
	});
	if (!resumed.started) {
		throw new ValidationError("worker 没能开始续跑，请稍后重试");
	}
	logger.info("Orchestration worker recovered onto another model", {
		workerNarratorId,
		primaryNarratorId: input.primaryNarratorId,
		model,
		tier: scope.tier,
		kind: scope.kind,
		action: input.action,
		outOfPool,
	});
	return {
		ok: true,
		workerNarratorId,
		model,
		tier: scope.tier,
		kind: scope.kind,
		continuation: "restarted",
		outOfPool,
		tierPool: pool,
	};
}
