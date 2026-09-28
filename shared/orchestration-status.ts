/**
 * 编排状态查询的线上形状（阶段 7）。
 *
 * 服务端的权威实现在 `server/lib/orchestration/status.ts`，但前端不能从服务端目录
 * import，因此契约放在 shared：**改动时必须两边一起改**（与
 * `shared/orchestration-worker-type.ts` 同一条约定）。
 *
 * 这是一个**只读**观测契约：它描述"现在是什么"，不含任何可写字段，也没有逐 worker
 * 明细（那会随会话长度增长）。
 */

import type {
	OrchestrationRequestRole,
	OrchestrationRunProgressSnapshot,
} from "./orchestration-observability";
import type { OrchestrationWorkerTier } from "./orchestration-worker-type";

export type {
	OrchestrationContextSource,
	OrchestrationInputTokenSemantics,
	OrchestrationRequestRole,
	OrchestrationRunCurrentPhase,
	OrchestrationRunProgressSnapshot,
	OrchestrationUsageSource,
} from "./orchestration-observability";

/** 池内一个条目的容量占用。 */
export interface OrchestrationPoolStatus {
	/** 完整模型引用，形如 "provider:modelId"。 */
	model: string;
	/** 该模型此刻的在飞派发数（进程级计数）。 */
	inFlight: number;
	/**
	 * 并发上限；`null` 表示**不限**。
	 *
	 * 服务端把"配置里省略"和"配成 0/负数"都归一成 `null`：两者在池选取里是同一个
	 * 语义（不限），分成两个值只会让每个消费方各写一遍判断。
	 */
	maxConcurrent: number | null;
}

/**
 * 一只执行者 worker 的当下状态。
 *
 * 这是清单里的一行，因此**只放标量**：会话越长 worker 越多，任何"顺手把它的
 * 最后一条消息也带回来"的想法都会让这个接口随会话长度线性变重。
 *
 * `null` 与 `0`/`false` 在这里是刻意分开的两件事，见各字段说明。
 */
export type OrchestrationWorkerRole = "worker" | "reviewer";

export interface OrchestrationWorkerStatus {
	/**
	 * 这只 worker 自己的叙述者 id。
	 *
	 * 它同时是**打开这只 worker 的会话/历史时唯一可用的目标**（服务端总是用
	 * `narrators.id` 填它，没有派生、也没有第二份来源），界面据此决定这一行能不能点。
	 * 复用的 worker（从停放池唤醒的那种）与新建的 worker 在这一列上没有任何区别：
	 * 停放只是 `narrators.status` 变成 `archived`，行本身还在。
	 */
	narratorId: string;
	/** 清单行角色；复核者与执行者可由前端分组而不依赖类型前缀。 */
	role: OrchestrationWorkerRole;
	tier: OrchestrationWorkerTier;
	/** 该 worker 当前的模型引用；读不到时 `null`。 */
	model: string | null;
	/**
	 * `narrators.status`：`idle`（空闲）/ `working`（运行中）/ `waiting`（等待中）/
	 * `archived`（已停放，即归档在停放池里、可被复用）。
	 *
	 * 刻意只有这一个字段表达状态，不再另加一个 `parked` 布尔：停放就是归档，
	 * 两个字段表达同一件事迟早会在某一侧漂移（一个说停放、一个说 idle）。
	 */
	status: string;
	/**
	 * 这只 worker 最近一次派发是否由**复用停放池**而来。
	 *
	 * `null` = 无法判定（它不在读到的那个有界派发窗口里），**不是** `false`：
	 * 把"不知道"渲染成"新建的"会让人在调停放池参数时得到反向结论。
	 */
	reused: boolean | null;
	/** 最近一次活动时间（ISO）；没有记录时 `null`。 */
	lastActivityAt: string | null;
	/**
	 * 上下文占用百分比（0–100）。
	 *
	 * `null` = **未知**，绝不是 0：0% 会被读成"这个 worker 的上下文还很空"，
	 * 而真相是这个 worker 还没有过一条能报出占用率的请求。
	 */
	contextPercent: number | null;
}

/** 一个档位的计数。 */
export interface OrchestrationTierStatus {
	/** 该档位已停放（归档、可复用）的 worker 数。 */
	parked: number;
	/** 该档位**在场**（未归档）的 worker 数：正在跑或刚跑完还没停放。 */
	running: number;
}

/**
 * 一次派发的结局阶段。
 *
 * 权威定义是 `server/lib/orchestration/audit.ts` 的 `ORCHESTRATION_RUN_PHASES`，
 * 数据库里的取值由 `orchestration_runs.phase` 的 enum 约束；这里按
 * `shared/orchestration-worker-type.ts` 的同一条约定再声明一次，**改动时必须两边一起改**。
 */
export type OrchestrationRunPhase = "dispatched" | "self_reviewed" | "reviewed" | "failed";

/** 执行者回执的 verdict（服务端只存枚举，不存回执正文）。 */
export type OrchestrationRunVerdict = "pass" | "fail" | "partial";

/** 一个档位的派发聚合（只覆盖有界的最近若干次派发，不是全量历史）。 */
export interface OrchestrationRunTierStats {
	/** 该档位的派发次数。 */
	runs: number;
	/** 其中已收尾（`durationMs` 不为空）的次数。 */
	finished: number;
	/** 已收尾那些派发的耗时总和（毫秒）。 */
	totalDurationMs: number;
	/** 平均耗时（毫秒）；一次都没收尾时为 `null`，而不是 0。 */
	avgDurationMs: number | null;
	/** 复用停放 worker 命中的次数。 */
	reused: number;
	/** 结局为 `failed` 的次数。 */
	failed: number;
}

/** 最近若干次派发里的一条摘要。不含回执正文，只有标量。 */
export interface OrchestrationRunSummary {
	id: string;
	tier: OrchestrationWorkerTier;
	phase: OrchestrationRunPhase;
	/** 本次档位选中的模型；挑选阶段就失败时为 `null`。 */
	model: string | null;
	/** 执行者 narrator id；派发失败在确认执行者之前时为 `null`。 */
	workerNarratorId: string | null;
	reusedWorker: boolean;
	verdict: OrchestrationRunVerdict | null;
	/** 失败原因（服务端写入前已截断）。 */
	error: string | null;
	startedAt: string;
	/** 未收尾时为 `null`（例如仍在跑的后台派发）。 */
	finishedAt: string | null;
	durationMs: number | null;
	/** 后续 run 级观测填充的当前进度；旧服务未提供时保持缺省。 */
	progress?: OrchestrationRunProgressSnapshot;
}

/**
 * 编排派发的审计视图：分档聚合 + 最近若干条摘要。
 *
 * 聚合口径**有界**：只统计该编制者最近的固定条数（见服务端的扫描上限），
 * 因此它是"最近的账"而不是"全部的历史"。相对地，`recent` 的条数由调用方的
 * `limit` 决定（有上限），聚合不随它变化。
 */
export interface OrchestrationRunAudit {
	aggregate: Record<OrchestrationWorkerTier, OrchestrationRunTierStats>;
	recent: OrchestrationRunSummary[];
}

/** 编排会话的只读状态。 */
export interface OrchestrationStatus {
	profileId: string;
	/** 方案显示名；方案已从设置里删掉时退回 profileId。 */
	profileName: string;
	/** 编制者模型；没有配置或解析不出时是 `null`（不是伪造的模型名）。 */
	orchestratorModel: string | null;
	tiers: Record<OrchestrationWorkerTier, OrchestrationTierStatus>;
	pools: Record<OrchestrationWorkerTier, OrchestrationPoolStatus[]>;
	/**
 * 本编排的直接执行者与复核者清单，**最近活动优先**。
 *
 * 与上面的分档计数回答的是不同的问题：计数说"每档几只执行者"，清单说"具体是哪几只、

	 * 各自在干什么、上下文多满"。清单有上限（见 {@link workerCount}），因为它随
	 * 会话增长。
	 */
	workers: OrchestrationWorkerStatus[];
	/**
	 * 该编排名下的执行者与复核者总数（含停放在池子里的执行者）。
	 *
	 * 超过清单上限时它大于 `workers.length`——界面据此如实标注"还有 N 只没显示"，
	 * 而不是让人以为一共就这么多。
	 */
	workerCount: number;
	/** 清单被上限截断：`workers` 只是最近的一部分。 */
	workersTruncated: boolean;
	/**
	 * 派发审计（`orchestration_runs`）。
	 *
	 * 与上面的容量数字不同，它是**历史**：回答"这个档位跑了几次、平均多久、
	 * 复用命中几次、最近几次是什么结局"。读失败时服务端给一份空聚合而不是让
	 * 整个状态查询失败——观测接口读不到历史时应当"少显示一块"，与在场计数的
	 * 处理一致。
	 */
	runs: OrchestrationRunAudit;
}

/**
 * 状态查询的响应外壳。
 *
 * 非编排会话给 `{ orchestration: null }` 而不是 404：这个接口会被界面按需拉取，
 * "不在编排模式"是正常答案，用错误码表达会让调用方把正常状态当异常处理。
 */
export interface OrchestrationStatusResponse {
	orchestration: OrchestrationStatus | null;
}

// ---------------------------------------------------------------------------
// 编排开销（token）—— 与状态分开的第二个契约
// ---------------------------------------------------------------------------

/**
 * 一组请求的 token 用量。
 *
 * 四个字段是**可加的组成部分**，不是互相包含的关系：`inputTokens` 只含未命中缓存的
 * 那部分输入，命中缓存与写入缓存各自单列（这是上游 API 的口径）。
 * 因此"总输入"= `inputTokens + cachedInputTokens + cacheCreationInputTokens`；
 * 界面必须把三者分开显示，把它们相加后只报一个数会看不出缓存到底有没有命中。
 */
export interface OrchestrationUsageBucket {
	/** 归集到的请求数。 */
	requests: number;
	/** 未命中缓存的输入 token。 */
	inputTokens: number;
	/** 命中前缀缓存的输入 token（按更低价格计费）。 */
	cachedInputTokens: number;
	/** 写入前缀缓存的输入 token（兼容总写入字段）。 */
	cacheCreationInputTokens: number;
	/** 写入 5 分钟缓存的输入 token。 */
	cacheCreation5mTokens?: number;
	/** 写入 1 小时缓存的输入 token。 */
	cacheCreation1hTokens?: number;
	/** 输出 token。 */
	outputTokens: number;
	/** 来源计数，旧数据按 unknown 归一。 */
	sources?: {
		measured: number;
		estimated: number;
		unknown: number;
	};
}

export interface OrchestrationUsageRunDetail {
	runId: string | null;
	roles: Record<OrchestrationRequestRole, OrchestrationUsageBucket>;
	total: OrchestrationUsageBucket;
}

/**
 * 一个编排会话的开销视图。
 *
 * 口径是**会话级累计**，不是"最近几次"：编制者会话只会越跑越长，而"这次编排总共花了
 * 多少"正是用户要看的那个数。代价是它随会话增长，因此服务端对枚举的 worker 数设了
 * 读取预算并如实给出 `truncated`（少算时不能装作是全量）。
 */
export interface OrchestrationUsage {
	/** 编制者自身的开销：调度、与用户对话、写 Dynamic Spec，不含任何 worker 的活。 */
	orchestrator: OrchestrationUsageBucket;
	/**
	 * 独立复核者的开销。
	 *
	 * 单列而不是并进某一档：复核不属于四档中的任何一档（那四档是执行者的编制，用的是
	 * 执行者池），但它的钱是真花了。并进某一档会让那一档的数字名不副实；丢掉又会让人
	 * 在面板上把"编制者 + 四档"加起来对不上总量。
	 */
	reviewers: OrchestrationUsageBucket;
	/** 按档位归集的执行者开销。 */
	tiers: Record<OrchestrationWorkerTier, OrchestrationUsageBucket>;
	/**
	 * 编制者 + 全部执行者 + 复核者的合计。
	 *
	 * 单独给一份而不是让界面自己加：四档加上编制者与复核者是六份数据，
	 * 每个消费方各写一次相加就多一个把它们加错的机会。恒等于
	 * `orchestrator + reviewers + Σ tiers`。
	 */
	total: OrchestrationUsageBucket;
	/** 计入统计的子会话数（worker + 复核者）。 */
	childCount: number;
	/** 读取预算被用尽：还有子会话没被计入，上面的数字是**部分和**。 */
	truncated: boolean;
	/** 按独立运行与 request 角色分桶的有界明细。 */
	runDetails: OrchestrationUsageRunDetail[];
}

/**
 * 开销查询的响应外壳。与状态同一条约定：非编排会话给 `null` 而不是 404。
 */
export interface OrchestrationUsageResponse {
	usage: OrchestrationUsage | null;
}
