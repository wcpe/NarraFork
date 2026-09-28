/**
 * 编排会话的**共享代码事实**（跨档位信息共享）。
 *
 * 存在的理由是停放池覆盖不到的那一块：停放池解决的是"同一档位重复用同一只 worker"
 * （保留上下文与前缀缓存），而 `quick` 探查出来的结论要交给 `medium` 用——按设计跨档位
 * 不复用 worker，所以这条信息此前只能靠编制者转述。本模块补的就是这一条。
 *
 * 它**不是**通用知识库，也不该长成那样：
 * - 绑在一个编排会话上（编制者 narrator id），进程内的内存结构，随会话消失；
 * - 只收"读过代码/跑过命令得出"的结论，且**每条都必须锚定**；
 * - 与 `knowledge_*` 那套（给人用、有 ACL、永久持久）没有交集：往那里写一次错的东西
 *   代价是永久的，而这里关掉会话就没了。
 *
 * ## 为什么锚点是"文件内容 sha256"而不是 tree hash
 *
 * 本仓库已有 `worktree_tree_snapshots`（整棵树的 tree hash）与 `file_attributions`
 * （谁在什么时候改了哪个文件），但两者都回答不了"这条结论现在还成立吗"：
 * - tree hash 覆盖整个工作区，为一条事实捕获一次要跑 `git add -A`——那正是 CLAUDE.md
 *   禁止放到热路径上的开销，而且它说的是"整棵树变了没有"，不是"这份文件变了没有"；
 *   "工作区变过"会让所有事实一起失效，等于没有判断力。
 * - `file_attributions` 记的是归属（谁改的），不是内容指纹；它由工具钩子与工作区
 *   监视器写入，而监视器是**最终一致**的——一条事实可能在监视器发现之前就被注入给
 *   下游 worker，那正是"静默注入过期结论"。
 *
 * 所以锚点取被引用文件本身的内容哈希：可精确判定、只读被点名的几个文件（有字节上限）、
 * 二进制与编码无关、不需要子进程。代价是写入时要读一次文件（见 {@link MAX_ANCHOR_FILE_BYTES}）。
 *
 * ## 失效即处理（绝不静默注入过期结论）
 *
 * 每次读取都**重新对着工作区算一遍**，不缓存判定结果。三种结局：
 * - `fresh`：全部锚点逐字节相同 → 可以注入；
 * - `stale`：有锚点内容变了（或文件已被删除）→ **剔除，且不重复它的结论文本**，
 *   只在注入块里报清"有几条被剔除、涉及哪些文件"；
 * - `unverifiable`：读不出来（权限、超过字节上限）→ 同样**不注入**。
 *
 * 剔除而不是"标注后照常注入"是刻意的：把一句可能已经错的话放进上下文，再附一句
 * "这可能是旧的"，模型照样会按它做——一句带免责声明的错话仍然是错话。
 *
 * 副作用是好的：判定不缓存，所以就算某个会话的条目因故留了下来（见
 * {@link MAX_SHARED_FACT_SESSIONS} 的淘汰策略），它也**永远不可能**注入一条过期结论，
 * 只是白占一点内存而已。
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Locale, type LocalizedValue, pickLocalizedValue } from "@shared/i18n-locales";
import { type OrchestrationTier, parseOrchestrationType, parseReviewerType } from "./types";

/** 一条事实锚定的某个文件：路径 + 记录时刻的内容指纹。 */
export interface SharedFactAnchor {
	/** 相对工作区根的正斜杠路径（与 git 的口径一致）。 */
	path: string;
	/** 记录时刻该文件内容的 sha256（小写 hex）。 */
	sha256: string;
}

/** 写入者是执行者还是独立复核者——两者都产"核实过的结论"，但可信来源不同。 */
export type SharedFactAuthorKind = "executor" | "reviewer";

export interface SharedFact {
	id: string;
	/** 会话键 = 编排编制者的 narrator id。 */
	sessionKey: string;
	/** 写入者的 narrator id。 */
	authorNarratorId: string;
	authorKind: SharedFactAuthorKind;
	/** 写入者所在档位。 */
	authorTier: OrchestrationTier;
	/** 结论本身。 */
	statement: string;
	/** 取证方式的自述（"读了 x.ts 第 40-90 行" / "跑了 bun test …"）。 */
	evidence: string;
	anchors: readonly SharedFactAnchor[];
	createdAt: number;
}

// ---------------------------------------------------------------------------
// 上限：全部是"有界"的具体取值，避免任何一条路径可以无限制增长
// ---------------------------------------------------------------------------

/** 单条结论的字数上限。 */
export const MAX_FACT_STATEMENT_CHARS = 1200;
/** 取证自述的字数上限。 */
export const MAX_FACT_EVIDENCE_CHARS = 400;
/**
 * 取证自述的字数下限。
 *
 * 这是一道**很弱**的闸门，只能挡住空串、"n/a" 这类明显没写东西的输入；它挡不住
 * 一段编出来的取证。真正的闸门是"锚点文件必须真实存在且可读"——一个纯推理的结论
 * 通常连该点哪个文件都写不出来，而写出来的那个文件如果不存在，这里就会拒收。
 * 把弱闸门说成强闸门会让下一个人以为它验证了什么，所以这里如实标注。
 */
export const MIN_FACT_EVIDENCE_CHARS = 8;
/** 一条事实最多锚定多少个文件。 */
export const MAX_FACT_ANCHORS = 16;
/** 单个锚点文件允许的最大字节数（读进内存做哈希，必须有界）。 */
export const MAX_ANCHOR_FILE_BYTES = 2 * 1024 * 1024;
/** 单个会话最多保留多少条事实。 */
export const MAX_SHARED_FACTS_PER_SESSION = 40;
/** 同时保留多少个会话（超出按最近写入淘汰）。 */
export const MAX_SHARED_FACT_SESSIONS = 64;
/** 一次注入最多带出多少条事实。 */
export const MAX_INJECTED_FACTS = 12;
/** 一次注入的字符上限。 */
export const MAX_INJECTED_CHARS = 3500;

// ---------------------------------------------------------------------------
// 谁是本会话的参与者
// ---------------------------------------------------------------------------

/** 参与者判定所需的最小行形状（只读 narrators 的几列，便于纯函数单测）。 */
export interface SharedFactParticipantRow {
	id: string;
	parentNarratorId: string | null;
	subagentType: string | null;
}

/**
 * 判断某个子代理是不是本编排会话的共享事实参与者，并给出会话键。
 *
 * 只认两类：编排执行者（`orch--<pid>--<tier>`）与独立复核者（`orch-review--<pid>--<tier>`），
 * 且两者都必须是**编制者的直接子代理**——会话键就取 `parentNarratorId`。
 *
 * 直接子代理这个前提是结构性的，不是约定：编排 worker 与复核者的工具集里都没有
 * Agent 工具（`READ_TOOLS` / `GENERAL_TOOLS` 都没有它），所以它们派生不出更深的
 * 编排子代理，编制者的直接子代理恰好覆盖整个编排群体。若某天这条前提变了，
 * 深一层的那只子代理会被判成"不在编排里"而写不进来——**宁可少共享，不要共享错**。
 */
export function resolveSharedFactParticipant(
	row: SharedFactParticipantRow | null | undefined,
): { sessionKey: string; authorKind: SharedFactAuthorKind; authorTier: OrchestrationTier } | null {
	if (!row?.parentNarratorId) return null;
	const executor = parseOrchestrationType(row.subagentType);
	if (executor.ok) {
		return {
			sessionKey: row.parentNarratorId,
			authorKind: "executor",
			authorTier: executor.tier,
		};
	}
	const reviewer = parseReviewerType(row.subagentType);
	if (reviewer.ok) {
		return {
			sessionKey: row.parentNarratorId,
			authorKind: "reviewer",
			authorTier: reviewer.tier,
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export type SharedFactRejection =
	| "empty_statement"
	| "statement_too_long"
	| "empty_evidence"
	| "evidence_too_short"
	| "evidence_too_long"
	| "no_anchors"
	| "too_many_anchors"
	| "anchor_outside_workspace"
	| "anchor_missing"
	| "anchor_not_a_file"
	| "anchor_too_large"
	| "anchor_unreadable"
	| "workspace_mismatch"
	| "session_full";

export type AddSharedFactResult =
	| { ok: true; fact: SharedFact }
	/** `detail` 是给人看的具体说明（哪个路径、为什么），不参与机读分支。 */
	| { ok: false; reason: SharedFactRejection; detail?: string };

interface SharedFactSession {
	sessionKey: string;
	/** 会话的工作区根。首次写入时定下来，之后必须一致（跨工作区的路径不可比）。 */
	workspaceRoot: string;
	facts: SharedFact[];
	touchedAt: number;
}

/** 会话表。键 = 编制者 narrator id。 */
const sessions = new Map<string, SharedFactSession>();

/** 测试钩子：清空全部会话状态。 */
export function __resetSharedFactsForTests(): void {
	sessions.clear();
}

/** 测试钩子：当前保留的会话数与条目数，用于断言"有界"。 */
export function sharedFactStats(): { sessions: number; facts: number } {
	let facts = 0;
	for (const session of sessions.values()) facts += session.facts.length;
	return { sessions: sessions.size, facts };
}

/** 把一条事实（含锚点）编码成稳定字符串，供去重与测试使用。 */
function factSignature(fact: SharedFact): string {
	return JSON.stringify([fact.statement, fact.anchors.map((a) => [a.path, a.sha256])]);
}

/** 把路径统一成"相对工作区根、正斜杠"的形式；不在根内返回 null。 */
function toWorkspaceRelative(workspaceRoot: string, candidate: string): string | null {
	const root = resolve(workspaceRoot);
	// 绝对路径直接拒绝：锚点的语义就是"工作区里的哪个文件"，接受绝对路径会让事实
	// 在换了工作区之后依然"看起来"有效。
	if (isAbsolute(candidate)) return null;
	const absolute = resolve(root, candidate);
	const rel = relative(root, absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	return rel.split(sep).join("/");
}

/** 读一个锚点文件并算出内容哈希。失败时返回具体原因，绝不抛。 */
async function hashAnchor(
	workspaceRoot: string,
	candidate: string,
): Promise<{ ok: true; anchor: SharedFactAnchor } | { ok: false; reason: SharedFactRejection }> {
	const path = toWorkspaceRelative(workspaceRoot, candidate);
	if (!path) return { ok: false, reason: "anchor_outside_workspace" };
	const absolute = resolve(resolve(workspaceRoot), path);
	try {
		const info = await stat(absolute);
		if (!info.isFile()) return { ok: false, reason: "anchor_not_a_file" };
		// 先看大小再读：超限的文件不该被读进内存，哪怕只是为了拒绝它。
		if (info.size > MAX_ANCHOR_FILE_BYTES) return { ok: false, reason: "anchor_too_large" };
		const bytes = await readFile(absolute);
		return {
			ok: true,
			anchor: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
		};
	} catch (err) {
		const code = (err as { code?: string } | null)?.code;
		return { ok: false, reason: code === "ENOENT" ? "anchor_missing" : "anchor_unreadable" };
	}
}

/** 淘汰最久没被写过的会话，保证会话表有界。 */
function evictOldestSessions(): void {
	while (sessions.size > MAX_SHARED_FACT_SESSIONS) {
		let oldestKey: string | undefined;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, session] of sessions) {
			if (session.touchedAt < oldestAt) {
				oldestAt = session.touchedAt;
				oldestKey = key;
			}
		}
		if (oldestKey === undefined) return;
		sessions.delete(oldestKey);
	}
}

/**
 * 写入一条共享事实。
 *
 * **先全部校验、再动状态**：任何一条锚点读不到，整条事实都不落地。半条事实
 * （"结论进来了、锚点没锚上"）比没有更糟——它会以"已核实"的样子被注入给别的档位。
 *
 * 时间戳与 id 由调用方注入（`now`/`id`）以便测试，避免这里引入对时钟与 id 生成器的依赖。
 */
export async function addSharedFact(input: {
	sessionKey: string;
	workspaceRoot: string;
	authorNarratorId: string;
	authorKind: SharedFactAuthorKind;
	authorTier: OrchestrationTier;
	statement: string;
	evidence: string;
	files: readonly string[];
	now?: number;
	id?: string;
}): Promise<AddSharedFactResult> {
	const statement = input.statement.trim();
	if (!statement) return { ok: false, reason: "empty_statement" };
	if (statement.length > MAX_FACT_STATEMENT_CHARS)
		return { ok: false, reason: "statement_too_long" };

	const evidence = input.evidence.trim();
	if (!evidence) return { ok: false, reason: "empty_evidence" };
	if (evidence.length < MIN_FACT_EVIDENCE_CHARS) return { ok: false, reason: "evidence_too_short" };
	if (evidence.length > MAX_FACT_EVIDENCE_CHARS) return { ok: false, reason: "evidence_too_long" };

	// 去重但保序：同一个文件写两遍不该占两个锚点名额。
	const requested = [...new Set(input.files.map((file) => file.trim()).filter(Boolean))];
	if (requested.length === 0) return { ok: false, reason: "no_anchors" };
	if (requested.length > MAX_FACT_ANCHORS) return { ok: false, reason: "too_many_anchors" };

	const workspaceRoot = resolve(input.workspaceRoot);
	const existing = sessions.get(input.sessionKey);
	if (existing && existing.workspaceRoot !== workspaceRoot) {
		// 换个工作区，同样的相对路径指的是另一份内容。混在一起会让"这条结论现在还成立吗"
		// 变成一个没有答案的问题，所以直接拒收并说清两者的路径。
		return {
			ok: false,
			reason: "workspace_mismatch",
			detail: `${existing.workspaceRoot} ≠ ${workspaceRoot}`,
		};
	}

	const anchors: SharedFactAnchor[] = [];
	for (const file of requested) {
		const hashed = await hashAnchor(workspaceRoot, file);
		if (!hashed.ok) return { ok: false, reason: hashed.reason, detail: file };
		anchors.push(hashed.anchor);
	}

	const session = existing ?? {
		sessionKey: input.sessionKey,
		workspaceRoot,
		facts: [],
		touchedAt: 0,
	};
	session.touchedAt = input.now ?? Date.now();

	const fact: SharedFact = {
		id: input.id ?? `${input.sessionKey}-${session.facts.length + 1}-${session.touchedAt}`,
		sessionKey: input.sessionKey,
		authorNarratorId: input.authorNarratorId,
		authorKind: input.authorKind,
		authorTier: input.authorTier,
		statement,
		evidence,
		anchors,
		createdAt: session.touchedAt,
	};

	// 重复写入同一条（同一段话 + 同一批锚点）视为幂等：worker 被唤醒后重说一遍不该
	// 把注入块撑大。判定在**加进去之前**，所以命中时调用方拿到的仍是原来那条。
	const duplicate = session.facts.find((item) => factSignature(item) === factSignature(fact));
	if (duplicate) return { ok: true, fact: duplicate };

	if (session.facts.length >= MAX_SHARED_FACTS_PER_SESSION) {
		return { ok: false, reason: "session_full", detail: String(MAX_SHARED_FACTS_PER_SESSION) };
	}

	session.facts.push(fact);
	sessions.set(input.sessionKey, session);
	evictOldestSessions();
	return { ok: true, fact };
}

// ---------------------------------------------------------------------------
// 读取与失效判定
// ---------------------------------------------------------------------------

export interface StaleSharedFact {
	fact: SharedFact;
	/** 内容已经变了的锚点路径。 */
	changedPaths: readonly string[];
}

export interface UnverifiableSharedFact {
	fact: SharedFact;
	/** 判定不了的锚点路径。 */
	paths: readonly string[];
}

export interface SharedFactInventory {
	sessionKey: string;
	workspaceRoot: string;
	fresh: readonly SharedFact[];
	stale: readonly StaleSharedFact[];
	unverifiable: readonly UnverifiableSharedFact[];
}

/**
 * 逐条重新判定有效性。没有这个会话时返回 null（与"会话存在但一条都没有"区分开）。
 *
 * 每次都重算、不缓存：缓存判定结果就等于用"上次看起来没变"代替"现在没变"，
 * 而两者之间的差别正是这条机制存在的意义。
 */
export async function inspectSharedFacts(sessionKey: string): Promise<SharedFactInventory | null> {
	const session = sessions.get(sessionKey);
	if (!session) return null;
	const fresh: SharedFact[] = [];
	const stale: StaleSharedFact[] = [];
	const unverifiable: UnverifiableSharedFact[] = [];
	for (const fact of session.facts) {
		const changedPaths: string[] = [];
		const unknownPaths: string[] = [];
		for (const anchor of fact.anchors) {
			const hashed = await hashAnchor(session.workspaceRoot, anchor.path);
			if (!hashed.ok) {
				// 文件不见了 = 一定变了；读不出来/太大 = 判定不了。两者都不许当成"没变"。
				if (hashed.reason === "anchor_missing" || hashed.reason === "anchor_not_a_file") {
					changedPaths.push(anchor.path);
				} else {
					unknownPaths.push(anchor.path);
				}
				continue;
			}
			if (hashed.anchor.sha256 !== anchor.sha256) changedPaths.push(anchor.path);
		}
		// 已确认变过的优先于"判定不了"：整条事实无论如何都不能用了，报"变了"比报"不知道"更准。
		if (changedPaths.length > 0) stale.push({ fact, changedPaths });
		else if (unknownPaths.length > 0) unverifiable.push({ fact, paths: unknownPaths });
		else fresh.push(fact);
	}
	return { sessionKey, workspaceRoot: session.workspaceRoot, fresh, stale, unverifiable };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const sharedFactLabels: LocalizedValue<{
	title: string;
	intro: string;
	dropped: string;
	unverifiable: string;
	anchor: string;
	howToAdd: string;
	truncated: string;
	reviewer: string;
}> = {
	en: {
		title: "## Verified facts shared by this session",
		intro:
			"Written by executors in this same orchestrated session, each anchored to the file contents it was derived from. Verified against the tree just now — you can build on these instead of re-deriving them.",
		dropped:
			"Also present but WITHHELD: {count} fact(s) whose anchored files changed since they were written ({paths}). Their conclusions are deliberately not shown — do not guess what they said. Re-dispatch a read-only tier if you need them re-derived.",
		unverifiable:
			"Also present but WITHHELD: {count} fact(s) that cannot be checked at all right now (anchored file unreadable or over the size limit: {paths}). Treat them as unavailable.",
		anchor: "anchored at",
		howToAdd:
			'To add one: call the `SessionFact` tool with action "add", giving the exact file paths you read to reach the conclusion.',
		truncated: "...and {count} more (older ones are listed first).",
		reviewer: "review",
	},
	"zh-CN": {
		title: "## 本会话已核实的共享事实",
		intro:
			"由同一个编排会话里的执行者写下，每条都锚定在它据以得出结论的文件内容上。刚刚已对着工作区重新核对过，可以直接拿来用，不必重新查一遍。",
		dropped:
			"另外有 {count} 条被**扣下**：它们的锚定文件在写下之后已经变更（{paths}）。它们的结论刻意不显示——不要去猜它们说了什么。需要的话，派一个只读档位重新查。",
		unverifiable:
			"另外有 {count} 条被**扣下**：现在完全无法核对（锚定文件读不出来或超过大小上限：{paths}）。请当作不存在。",
		anchor: "锚定",
		howToAdd:
			'要新增：调用 `SessionFact` 工具、action 用 "add"，并给出你据以得出结论的那些文件路径。',
		truncated: "……还有 {count} 条（先列较早的）。",
		reviewer: "复核",
	},
};

/** 把锚点列表压成一行可读文本，避免每条事实占掉半屏。 */
function renderAnchors(fact: SharedFact, label: string): string {
	return `（${label} ${fact.anchors.map((anchor) => anchor.path).join(", ")}）`;
}

/**
 * 渲染交给模型读的共享事实块。
 *
 * 返回空串表示"没有任何可共享的内容"——调用方据此不加这一段，而不是塞一个空标题。
 * 顺序固定为**写入顺序**（较早的在前）：新事实追加在末尾，于是这段文本的前缀在
 * 多次派发之间保持稳定，前缀缓存才有意义；把最新的排在最前面会让每一轮都重算整段。
 *
 * 被剔除的事实**只报数量与文件，不重复结论文本**（理由见文件头："一句带免责声明的
 * 错话仍然是错话"）。
 */
export function renderSharedFactsBlock(inventory: SharedFactInventory, locale: Locale): string {
	const text = pickLocalizedValue(sharedFactLabels, locale);
	const sections: string[] = [];
	// 被扣下的条目单独成段，附在可用结论之后：先说清有什么能用，再说清有哪些被拿掉了。
	const withheld: string[] = [];
	if (inventory.stale.length > 0) {
		const paths = [...new Set(inventory.stale.flatMap((entry) => entry.changedPaths))].join(", ");
		withheld.push(
			text.dropped.replace("{count}", String(inventory.stale.length)).replace("{paths}", paths),
		);
	}
	if (inventory.unverifiable.length > 0) {
		const paths = [...new Set(inventory.unverifiable.flatMap((entry) => entry.paths))].join(", ");
		withheld.push(
			text.unverifiable
				.replace("{count}", String(inventory.unverifiable.length))
				.replace("{paths}", paths),
		);
	}
	if (inventory.fresh.length === 0) return withheld.join("\n\n");

	const shown = inventory.fresh.slice(0, MAX_INJECTED_FACTS);
	const lines: string[] = [`${text.title}`, "", text.intro];
	const body: string[] = [];
	let chars = 0;
	for (const fact of shown) {
		const tag = fact.authorKind === "reviewer" ? text.reviewer : fact.authorTier;
		const line = `- [${tag}] ${fact.statement}${renderAnchors(fact, text.anchor)}\n  ${fact.evidence}`;
		// 有界：这段文本会随每次派发重发，不能让它无限制地长。
		if (chars + line.length > MAX_INJECTED_CHARS) {
			if (body.length === 0 && withheld.length === 0) {
				// 连一条都放不下时不能返回空串——那会让"有事实"和"没事实"变得无法区分。
				body.push(line.slice(0, MAX_INJECTED_CHARS));
				chars = MAX_INJECTED_CHARS;
			}
			break;
		}
		body.push(line);
		chars += line.length;
	}
	lines.push("", ...body);
	const omitted = inventory.fresh.length - body.length;
	if (omitted > 0) lines.push("", text.truncated.replace("{count}", String(omitted)));
	lines.push("", text.howToAdd);
	sections.push(lines.join("\n"));
	if (withheld.length > 0) sections.push(withheld.join("\n\n"));
	return sections.join("\n\n");
}
