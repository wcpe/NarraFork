/**
 * 编排 worker 类型编码的共享解析（阶段 6）。
 *
 * 服务端的权威定义在 `server/lib/orchestration/types.ts`（`ORCHESTRATION_TYPE_PREFIX`
 * / `REVIEWER_TYPE_PREFIX` / `parseOrchestrationType`），但前端与布局适配器都不能从
 * 服务端目录 import。这里按同一份编码规则再实现一次，**改动时必须两边一起改**：
 * 前缀或分隔符漂移的后果是前端认不出编排 worker——换模型入口整体消失，
 * 而且不会报任何错（`parseOrchestrationType` 对不合法输入一律返回 { ok: false }）。
 *
 * 之所以按"前缀 + 恰好两段"的严格形状匹配而不是 `startsWith("orch--")`：后者会把
 * `orch--foo` 这种历史脏数据认成 worker，把一个不存在的档位交给模型池查询。
 */

/** 干活档位。四档，与服务端 `OrchestrationTier` 逐字一致。 */
export type OrchestrationWorkerTier = "chore" | "quick" | "medium" | "heavy";

/** 执行者类型前缀（形如 `orch--<profileId>--<tier>`）。 */
export const ORCHESTRATION_EXECUTOR_TYPE_PREFIX = "orch--";

/** 复核者类型前缀（形如 `orch-review--<profileId>--<tier>`）。 */
export const ORCHESTRATION_REVIEWER_TYPE_PREFIX = "orch-review--";

/** 四档的固定顺序（与服务端 `ORCHESTRATION_TIERS` 逐字一致），供遍历与校验共用。 */
export const ORCHESTRATION_WORKER_TIERS: readonly OrchestrationWorkerTier[] = [
	"chore",
	"quick",
	"medium",
	"heavy",
];

const TIERS: readonly string[] = ORCHESTRATION_WORKER_TIERS;
/** profileId 只含小写字母与数字（服务端用同一模式校验）。 */
const PROFILE_ID_PATTERN = /^[a-z0-9]+$/;

/**
 * 子代理当前正停在的"模型不可用"等待（凭据池不可用 / 配额窗口未重置）。
 *
 * 这是**运行期事实**，只由 WS 帧携带：服务端把子代理停在这个状态时发
 * `subagent_model_unavailable_waiting`，恢复时发 `..._recovered`，而消息快照里没有
 * 它（等待一结束它就不存在了）。因此消费方（活动卡片、模型 badge）读的是事件，
 * 不是持久化字段——这与 `takenOver` 需要两个来源正好相反。
 */
export interface SubagentModelWait {
	/** `credentials` 是整池凭据不可用；`quota` 是配额窗口用尽（带 `resumeAt`）。 */
	waitKind?: "credentials" | "quota";
	/** 停在哪个模型上。文案要指明模型，否则用户不知道等的是谁。 */
	model: string;
	/** 额度重置的绝对时间戳（毫秒）。只有 `quota` 有。 */
	resumeAt?: number;
}

export interface OrchestrationWorkerType {
	/** 执行者还是复核者。 */
	kind: "executor" | "reviewer";
	profileId: string;
	tier: OrchestrationWorkerTier;
}

/**
 * `errorMessage` 里「模型级失败」的信封类型。
 *
 * 三种都由 agent loop / 编排运行时写出，且都带 `model` 字段：
 *  - `model_unavailable` / `quota_exhausted`：`suspendUntilModelRecovered` 把等待
 *    类型与整个 `modelUnavailable` 载荷一起序列化（见 orchestrator 的等待分支）；
 *  - `kimi_quota_exhausted`：配额墙超出等待预算时改为上报，同样带 `model`。
 *
 * `payment_required` 刻意不在其中：那个载荷只有 provider / 余额字段，没有 `model`，
 * 拿不到"是哪一次请求被拒"的证据，因此宁可少一个信号也不猜。
 */
const MODEL_FAILURE_ENVELOPE_TYPES = new Set([
	"model_unavailable",
	"quota_exhausted",
	"kimi_quota_exhausted",
]);

/**
 * 除了模型级失败之外，还必须活到下一次读取的失败信封。
 *
 * `payment_required` 的载荷只有 provider / 余额字段，没有 `model`，所以它不是
 * 「这次失败归因于哪个模型」的证据（见上）。但它和那三种一样**只有 `errorMessage`
 * 这一个载体**：`errorCode` / `diagnostics` 都不落库，被覆盖成一句纯文本之后，
 * 前端就读不出"这是余额不足，去充值"而只剩一句通用报错。
 */
const PERSISTED_FAILURE_ENVELOPE_TYPES = new Set([
	...MODEL_FAILURE_ENVELOPE_TYPES,
	"payment_required",
]);

/**
 * 解析信封本体；不是"以 `{` 开头的 JSON 对象"时返回 null。
 *
 * 先看首字符再 `JSON.parse`：`errorMessage` 绝大多数是一句人写的英文或中文，
 * 对它们做一次必然失败的解析既慢又会在日志里留下无意义的异常路径。
 */
function parseEnvelope(errorMessage: string | null | undefined): Record<string, unknown> | null {
	if (typeof errorMessage !== "string" || !errorMessage.startsWith("{")) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(errorMessage);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}

/**
 * 这段 `errorMessage` 是不是一个**必须留到下一次读取**的结构化失败信封。
 *
 * 存在的理由是有一个写入方会无条件覆盖它：子代理跑到终态时 `finalizeSubagent`
 * 会把 `errorMessage` 写成一句人类可读的纯文本（这是错误卡片的正文来源，不能取消）。
 * 而模型级的失败信封正是**先**由 orchestrator 写进去的——于是覆盖发生的那一刻，
 * "是哪一次请求被哪个模型拒了"这条第一手证据就永久消失了，而
 * {@link parseModelFailureModel} 恰恰只认信封：`isTierPoolFullyUnavailable` 因此退化
 * 成只剩"提供者停用 / NUG 目录不可用"，"池里全是同一个用尽的计划"这种最该放开
 * 池外的场景反而永远不放开。
 *
 * 因此终态写入必须先问一句"这里已经有一个信封了吗"，再决定要不要写纯文本。
 * 共用同一个类型清单是刻意的：谁改这里的种类，谁就得同时想想
 * `finalizeSubagent` 那一侧的覆盖行为。
 */
export function isPersistedFailureEnvelope(errorMessage: string | null | undefined): boolean {
	const type = parseEnvelope(errorMessage)?.type;
	return typeof type === "string" && PERSISTED_FAILURE_ENVELOPE_TYPES.has(type);
}

/**
 * 从 worker 的 `errorMessage` 里取出「这次失败归因于哪个模型」。
 *
 * 这是**第一手证据**：它来自一次真实被拒的请求，而不是"看起来不可用"的推测。
 * 因此它能让非 NUG 提供者的配额墙（Kimicode 计划用尽等）也成为「池内不可用」的
 * 依据——那些失败不会体现在任何目录的 `available` 标记上。
 *
 * 只认 JSON 信封；纯文本错误（含 402 / 网络错误）返回 null，调用方据此判定为
 * "没有证据"（保守方向：不放开池）。`model` 缺失或不是非空字符串同样返回 null。
 */
export function parseModelFailureModel(errorMessage: string | null | undefined): string | null {
	const envelope = parseEnvelope(errorMessage);
	if (!envelope) return null;
	const { type, model } = envelope;
	if (typeof type !== "string" || !MODEL_FAILURE_ENVELOPE_TYPES.has(type)) return null;
	if (typeof model !== "string") return null;
	const trimmed = model.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isTier(value: string): value is OrchestrationWorkerTier {
	return TIERS.includes(value);
}

/**
 * 解析预览用的类型编码。执行者与复核者都走同一个入口——两者都能被换模型救活，
 * 区别只是档位来源（复核者用复核档位），而那由调用方拿 profileId + tier 去查。
 */
export function parseOrchestrationWorkerType(
	subagentType: string | null | undefined,
): OrchestrationWorkerType | null {
	if (typeof subagentType !== "string") return null;
	const reviewer = subagentType.startsWith(ORCHESTRATION_REVIEWER_TYPE_PREFIX);
	const prefix = reviewer ? ORCHESTRATION_REVIEWER_TYPE_PREFIX : ORCHESTRATION_EXECUTOR_TYPE_PREFIX;
	if (!subagentType.startsWith(prefix)) return null;
	const parts = subagentType.slice(prefix.length).split("--");
	if (parts.length !== 2) return null;
	const [profileId, tier] = parts;
	if (!profileId || !PROFILE_ID_PATTERN.test(profileId)) return null;
	if (!tier || !isTier(tier)) return null;
	return { kind: reviewer ? "reviewer" : "executor", profileId, tier };
}

/** 该子代理类型是否属于某个编排（判定只认类型编码，不看 narratorId 或形状）。 */
export function isOrchestrationWorkerType(subagentType: string | null | undefined): boolean {
	return parseOrchestrationWorkerType(subagentType) !== null;
}
