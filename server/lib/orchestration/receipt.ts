/**
 * 编排回执的解析与渲染（阶段 5）。
 *
 * 执行者被要求以一段 fenced JSON 结尾（契约见 `tier-prompts.ts` 的 RECEIPT_CONTRACT），
 * 编排者据此行动。解析的全部难点在于：**模型不总是守约**，而丢结果的代价远大于拿到
 * 一份降级的回执。因此这里的规则是"宽松优先"：
 *
 * - 找不到回执 → `unparsed`，并把原文带出去（绝不返回 null 让调用方无从渲染）；
 * - 单个字段不合法 → 只修那个字段（`verdict` 归 `partial`、`confidence` 归 `low`、
 *   数组里的非字符串项丢掉），**绝不因此丢掉整份回执**；
 * - 任何内部错误（畸形 JSON、未闭合花括号、超长文本）都归为 `unparsed`，本模块**不抛异常**。
 *
 * 与 `types.ts` 一样，这里刻意不 import 任何服务层模块：它是纯函数，可被直接单测。
 */

import { type Locale, type LocalizedValue, pickLocalizedValue } from "@shared/i18n-locales";

/** 结构化回执的形状，与 RECEIPT_CONTRACT 一一对应。 */
export interface OrchestrationReceipt {
	verdict: "pass" | "fail" | "partial";
	changedFiles: string[];
	testsRun: string[];
	notDone: string[];
	confidence: "high" | "medium" | "low";
	blockers: string[];
}

/** 解析结果。`unparsed` 也带出原文，渲染层必须如实说明"未按契约回执"。 */
export type ReceiptParseResult =
	| { kind: "parsed"; receipt: OrchestrationReceipt; raw: string }
	| { kind: "unparsed"; raw: string };

const VERDICTS: readonly string[] = ["pass", "fail", "partial"];
const CONFIDENCES: readonly string[] = ["high", "medium", "low"];

/** 裸 JSON 扫描时最多回溯多少个平衡花括号片段。回执总在结尾，前面的多是无用内容。 */
const MAX_BARE_CANDIDATES = 8;

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 只保留合法的字符串项。
 *
 * 非数组、含非字符串元素、空串都按"这一项不算数"处理，而不是让整个字段变成非法：
 * 一份 `changedFiles: ["a.ts", 42, null]` 的回执里，`a.ts` 仍然是可用的信息。
 */
function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		if (!entry.trim()) continue;
		result.push(entry);
	}
	return result;
}

/** 字段级容错后的回执。任何输入都能得到一个合法形状。 */
function normalizeReceipt(value: Record<string, unknown>): OrchestrationReceipt {
	return {
		// 非法或缺省的 verdict 归为 "partial"：它既不是"失败"也不是"已通过"，
		// 正好对应"不知道为什么"时最保守、也最不会误导编排者的取值。
		verdict: VERDICTS.includes(value.verdict as string)
			? (value.verdict as OrchestrationReceipt["verdict"])
			: "partial",
		changedFiles: toStringArray(value.changedFiles),
		testsRun: toStringArray(value.testsRun),
		notDone: toStringArray(value.notDone),
		confidence: CONFIDENCES.includes(value.confidence as string)
			? (value.confidence as OrchestrationReceipt["confidence"])
			: "low",
		blockers: toStringArray(value.blockers),
	};
}

/** 扫描一段文本，收集所有**平衡**的 `{...}` 片段（考虑字符串与转义）。 */
function collectBareObjectCandidates(text: string): string[] {
	const candidates: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let quote = "";
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) inString = false;
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			quote = char;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth++;
			continue;
		}
		if (char === "}") {
			if (depth === 0) continue;
			depth--;
			if (depth === 0 && start >= 0) {
				candidates.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}
	return candidates;
}

/** 提取出所有 fenced code block 的内容（有语言标注与否都算）。 */
function extractFencedBlocks(text: string): string[] {
	const blocks: string[] = [];
	const fence = /```[^\n]*\n([\s\S]*?)```/g;
	for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
		blocks.push(match[1]);
	}
	return blocks;
}

/** 尝试把一段候选文本解析成回执对象。失败返回 undefined，绝不抛。 */
function tryParseObject(candidate: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(candidate.trim());
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 找出文本里代表回执的那个 JSON 对象。
 *
 * 优先级：**从后往前**的 fenced block → 从后往前的裸平衡片段。
 * fenced block 也从后往前，而不是"只看最后一个"：模型偶尔会把回执放进一个块、
 * 又在后面贴一个示例块；宁可接受前一个能解析的，也不要把整份回执判成缺失。
 */
function extractReceiptObject(text: string): Record<string, unknown> | undefined {
	const blocks = extractFencedBlocks(text);
	for (let index = blocks.length - 1; index >= 0; index--) {
		const parsed = tryParseObject(blocks[index]);
		if (parsed) return parsed;
	}
	const candidates = collectBareObjectCandidates(text);
	const from = Math.max(0, candidates.length - MAX_BARE_CANDIDATES);
	for (let index = candidates.length - 1; index >= from; index--) {
		const parsed = tryParseObject(candidates[index]);
		if (parsed) return parsed;
	}
	return undefined;
}

/**
 * 从执行者的最终文本里抽出结构化回执。
 *
 * 永不抛异常：任何内部错误都归为 `unparsed`。输入 `null`/`undefined`/空串同样是 `unparsed`。
 */
export function parseOrchestrationReceipt(text: string | null | undefined): ReceiptParseResult {
	const raw = typeof text === "string" ? text : "";
	try {
		if (!raw.trim()) return { kind: "unparsed", raw };
		const parsed = extractReceiptObject(raw);
		if (!parsed) return { kind: "unparsed", raw };
		return { kind: "parsed", receipt: normalizeReceipt(parsed), raw };
	} catch {
		// 扫描/解析的任何意外（例如极端输入下的栈或内存问题）都不能掀翻一次派发。
		return { kind: "unparsed", raw };
	}
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const receiptHeaders: LocalizedValue<{
	verdict: string;
	confidence: string;
	changedFiles: string;
	testsRun: string;
	notDone: string;
	blockers: string;
	none: string;
	unparsed: string;
	rawLabel: string;
}> = {
	en: {
		verdict: "verdict",
		confidence: "confidence",
		changedFiles: "changed files",
		testsRun: "tests run",
		notDone: "not done",
		blockers: "blockers",
		none: "(none)",
		unparsed:
			"NO CONTRACT COMPLIANT RECEIPT. There is no parseable JSON receipt block here, so the conclusions below are NOT structured and must not be treated as verified facts. Re-dispatch, or ask for a receipt before acting on any claim.",
		rawLabel: "----- raw output (bounded) -----",
	},
	"zh-CN": {
		verdict: "结论",
		confidence: "置信度",
		changedFiles: "改动文件",
		testsRun: "跑过的测试",
		notDone: "未完成",
		blockers: "阻塞",
		none: "（无）",
		unparsed:
			"**未按契约回执**。这里没有可解析的 JSON 回执块，因此下面的内容**不是**结构化的，**不能**当成已核实的事实。请重新派发，或先要一份回执再据其行动。",
		rawLabel: "----- 原始输出（已截断）-----",
	},
};

/** 未按契约回执时回显原文的字节上限：编制者需要看到原话，但不能被一段长文淹掉。 */
const RAW_ECHO_MAX_CHARS = 4000;

function echoRaw(raw: string, noneLabel: string): string {
	if (!raw.trim()) return noneLabel;
	// 截断标记由上面的标签承担（"已截断"/"bounded"），这里只做切分。
	return raw.slice(0, RAW_ECHO_MAX_CHARS);
}

/** 渲染一个数组字段：空数组写"（无）"，而不是留一个空标题让人以为漏了。 */
function renderList(items: readonly string[], none: string): string {
	if (items.length === 0) return none;
	return items.map((item) => `- ${item}`).join("\n");
}

/**
 * 把解析结果渲染成给编制者读的简洁区块。
 *
 * `unparsed` 时**明确**说明"未按契约回执"——绝不能让它看起来像一份成功的回执：
 * 编制者的全部职责就是不再自己翻代码，如果它把自由文本当成结构化结论，
 * 这一模式的正确性就没有任何兜底了。
 */
export function renderReceiptForParent(result: ReceiptParseResult, locale: Locale): string {
	const text = pickLocalizedValue(receiptHeaders, locale);
	if (result.kind === "unparsed") {
		return `${text.unparsed}\n\n${text.rawLabel}\n${echoRaw(result.raw, text.none)}`;
	}
	const { receipt } = result;
	return [
		`- ${text.verdict}: \`${receipt.verdict}\``,
		`- ${text.confidence}: \`${receipt.confidence}\``,
		`- ${text.changedFiles} (${receipt.changedFiles.length}):`,
		renderList(receipt.changedFiles, text.none),
		`- ${text.testsRun} (${receipt.testsRun.length}):`,
		renderList(receipt.testsRun, text.none),
		`- ${text.notDone} (${receipt.notDone.length}):`,
		renderList(receipt.notDone, text.none),
		`- ${text.blockers} (${receipt.blockers.length}):`,
		renderList(receipt.blockers, text.none),
	].join("\n");
}

/** 独立复核这一节的状态：执行过、被跳过、还是执行失败。 */
export interface IndependentReviewSection {
	kind: "executed" | "skipped" | "failed";
	/** 跳过或失败的原因，用于向编制者如实交代"为什么没有复核"。 */
	reason?: "disabled" | "no_model" | "aborted" | "error";
	result?: ReceiptParseResult;
}

/**
 * 自审这一节的状态。
 *
 * `reason` 必须区分"这次派发没有要求自审"与"方案层面关掉了自审"：两者都是跳过，
 * 但编制者该采取的行动完全不同——前者是它自己这次的决定（下次可以改），
 * 后者是配置决定的（再派一次也还是不会有）。把两者说成同一句话，
 * 报告里就会出现一句关于本方案配置的**假陈述**。
 */
export type SelfReviewSection = {
	kind: "executed" | "skipped" | "failed";
	reason?: "disabled" | "not_requested";
};

export interface OrchestrationDispatchReport {
	/** 执行者的原始输出（含 runner 写的 `<subagent_id>` 标签）。 */
	executorOutput: string;
	/** 拟交给编制者的回执：优先取自审轮，没有自审时取自执行者原始输出。 */
	receipt: ReceiptParseResult;
	selfReview: SelfReviewSection;
	independentReview: IndependentReviewSection;
	/**
	 * 本编排会话累积的共享代码事实（已渲染好的块）。空串/缺省表示"这段不出现"。
	 *
	 * 由调用方渲染而不是在这里现算：有效性判定要读文件（见 `shared-facts.ts`），
	 * 而本模块是纯函数，不该有 I/O。
	 */
	sharedFacts?: string;
}

const reportHeaders: LocalizedValue<{
	receipt: string;
	review: string;
	selfReviewExecuted: string;
	selfReviewSkipped: string;
	selfReviewNotRequested: string;
	selfReviewFailed: string;
	reviewDisabled: string;
	reviewNoModel: string;
	reviewAborted: string;
	reviewError: string;
	executorTruncated: string;
}> = {
	en: {
		receipt: "## Structured receipt",
		review: "## Independent review",
		selfReviewExecuted:
			"The receipt below comes from a SELF-REVIEW pass the same executor ran after finishing (same worker, same context).",
		selfReviewSkipped:
			"Self-review was NOT run: it is disabled for this profile. The receipt below is the executor's own output.",
		selfReviewNotRequested:
			"Self-review was NOT run: this dispatch did not ask for one (the `self_review` parameter defaults to false). The receipt below is the executor's own output. If you want the executor to look back at its own work before you act on it, re-dispatch with `self_review: true`.",
		selfReviewFailed:
			"The self-review pass could not run (it failed to start or errored). The receipt below is the executor's own output, NOT self-reviewed.",
		reviewDisabled:
			"Not executed: independent review is disabled for this profile. Nothing here has been verified by a second agent.",
		reviewNoModel:
			"Not executed: no model was available for the review tier (its pool is empty or at capacity). Nothing here has been verified by a second agent.",
		reviewAborted: "Not executed: the run was aborted before the review started.",
		reviewError:
			"The reviewer could not run (it failed to start or errored). Nothing here has been verified by a second agent.",
		executorTruncated:
			"(the executor's raw output is cut off here — it is echoed for context, and the structured receipt below is the authoritative record)",
	},
	"zh-CN": {
		receipt: "## 结构化回执",
		review: "## 独立复核",
		selfReviewExecuted: "下面的回执来自执行者收尾后跑的**自审轮**（同一个 worker、同一段上下文）。",
		selfReviewSkipped: "**未执行**自审：本方案关闭了自审。下面的回执就是执行者自己的输出。",
		selfReviewNotRequested:
			"**未执行**自审：这次派发没有要求自审（`self_review` 参数默认为 false）。下面的回执就是执行者自己的输出。如果你要在据它行动之前让执行者回看自己的产物，请带 `self_review: true` 重新派发。",
		selfReviewFailed:
			"自审轮没能跑起来（启动失败或中途出错）。下面的回执是执行者自己的输出，**未经自审**。",
		reviewDisabled: "**未执行**：本方案关闭了独立复核。此处的结论没有任何第二方验证。",
		reviewNoModel:
			"**未执行**：复核档位取不到可用模型（模型池为空或并发已满）。此处的结论没有任何第二方验证。",
		reviewAborted: "**未执行**：本次运行在复核开始前就被中止了。",
		reviewError: "复核者没能跑起来（启动失败或中途出错）。此处的结论没有任何第二方验证。",
		executorTruncated:
			"（执行者的原始输出在此截断——它只是供参考的原文，下面那份结构化回执才是权威记录）",
	},
};

/**
 * 回显执行者原文的字数上限。
 *
 * **为什么必须有界**：这段文本会成为编制者上下文里的一条 `tool_result`，而它此后
 * **每一轮都要被重新发一遍**。一次派发的原文动辄上万字，十次派发就是十万字级别的常驻
 * 前缀——它比任何一次派发本身都贵。而回执（正文里紧随其后的那份结构化 JSON）已经把
 * 编制者据以行动的东西都说清了，原文的职责只剩"提供上下文"。
 *
 * 取值与 `RAW_ECHO_MAX_CHARS` 一致：两种回显是同一种东西，尺寸口径就没有理由不同。
 * 截断了会**明说**（见 `executorTruncated`），不能让人以为原文本来就这么短。
 */
export const EXECUTOR_ECHO_MAX_CHARS = 4000;

/** 只保留原文的前缀，并在截断处留下一句可读的说明。 */
function boundExecutorEcho(text: string, note: string): string {
	if (text.length <= EXECUTOR_ECHO_MAX_CHARS) return text;
	return `${text.slice(0, EXECUTOR_ECHO_MAX_CHARS)}\n\n${note}`;
}

/**
 * 组装交给编制者的返回文本。
 *
 * 顺序固定为「执行者原话 → 结构化回执 → 独立复核」：编排者先看到发生了什么，
 * 再看结构化结论，最后看第二方意见。三方都在同一个 `tool_result` 里，
 * 因为它们描述的是同一次派发；拆成多条消息只会让编制者把它们当成不同的事。
 *
 * 执行者原文**有界**（见 {@link EXECUTOR_ECHO_MAX_CHARS}）：这条 `tool_result` 会成为
 * 编制者上下文里的常驻前缀，此后每一轮都重发一次，因此它的长度直接决定编排模式跑久了
 * 有多贵。有界不等于丢信息——回执那一节才是编制者据以行动的东西。
 */
export function renderOrchestrationDispatchResult(
	report: OrchestrationDispatchReport,
	locale: Locale,
): string {
	const text = pickLocalizedValue(reportHeaders, locale);
	const selfReviewNote =
		report.selfReview.kind === "executed"
			? text.selfReviewExecuted
			: report.selfReview.kind === "failed"
				? text.selfReviewFailed
				: // 跳过分两种：方案关掉了（重复派发也不会有），还是这次派发没要求（可以再要一次）。
					// 缺省取 `skipped`，因为"方案关闭"是更强的陈述，而 reason 缺席时说明它从未被设置。
					report.selfReview.reason === "not_requested"
					? text.selfReviewNotRequested
					: text.selfReviewSkipped;
	const reviewBody = (() => {
		const review = report.independentReview;
		if (review.kind === "executed" && review.result) {
			return renderReceiptForParent(review.result, locale);
		}
		if (review.kind === "failed") return text.reviewError;
		switch (review.reason) {
			case "no_model":
				return text.reviewNoModel;
			case "aborted":
				return text.reviewAborted;
			default:
				return text.reviewDisabled;
		}
	})();
	return [
		boundExecutorEcho(report.executorOutput, text.executorTruncated),
		`${text.receipt}\n\n${selfReviewNote}\n\n${renderReceiptForParent(report.receipt, locale)}`,
		`${text.review}\n\n${reviewBody}`,
		// 共享事实永远排在最后：它是这个会话跨多次派发累积下来的东西，不是这次派发
		// 本身的结论。空串时不出现，避免一个空标题让人以为"本来就没共享过"。
		...(report.sharedFacts ? [report.sharedFacts] : []),
	].join("\n\n");
}
