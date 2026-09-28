/**
 * `SessionFact` —— 编排会话里跨档位共享**已核实的代码事实**。
 *
 * 工具本身很薄：判定"我是不是本编排会话的执行者/复核者"、把请求交给
 * `lib/orchestration/shared-facts.ts`、把结果（含它算出来的锚点）说清楚。
 * 存储、失效判定与渲染都在那边，因为它们是纯逻辑，可以不带工具环境直接测。
 *
 * ## 为什么必须是工具，而不是"让编制者转述"
 *
 * 跨档位共享的原始形态是"quick 查到的结论，medium 实现时直接用"。这条信息此前只能
 * 靠编制者读回执再写进下一次派发的 prompt——而编制者自己读不了代码，它转述的是
 * **二手结论**，并且每次都要重抄一遍。让产出结论的那只 worker 自己锚定着写下来，
 * 信息在传递过程中不再经过一个看不见代码的中介。
 *
 * ## 为什么锚定是硬要求
 *
 * 没有锚点的"结论"无法在文件变化后被判定为过期，只能永远当作有效——那还不如不共享。
 * 因此锚点文件必须**此刻真实存在且可读**，读取入口在写入之前就把关（见 `addSharedFact`）。
 * 这道闸门挡不住一段编出来的取证，但它挡住了"根本没打开过任何文件"的结论：连该点
 * 哪个文件都写不出来的推理，走不到这里。这条能力的边界写在补充文案里，不假装它更强。
 *
 * ## 可见性
 *
 * 它的名字加进了 `READ_TOOLS`（因而 `GENERAL_TOOLS` 也有），所以四个编排档位都能用；
 * 注册在 `OPTIONAL_TOOLS` 里，于是普通主叙述者的工具列表不受影响（子代理会绕过
 * 可选工具那道装载闸门，编排 worker 因此不需要任何额外的激活步骤）。
 *
 * 名字进的是**只读集**：它不碰工作区里的任何文件，写的是一个进程内、随会话消失的
 * 内存结构。档位的"只读 vs 可写"边界说的是能不能动项目代码，这里没有动。
 */

import type { Locale, LocalizedValue } from "@shared/i18n-locales";
import { pickLocalizedValue } from "@shared/i18n-locales";
import { z } from "zod/v4";
import {
	addSharedFact,
	inspectSharedFacts,
	MAX_FACT_ANCHORS,
	MAX_SHARED_FACTS_PER_SESSION,
	renderSharedFactsBlock,
	resolveSharedFactParticipant,
	type SharedFactRejection,
} from "../../orchestration/shared-facts";
// 名字声明在无依赖的叶子模块里（工具集与运行时策略都要用它），这里只转出。
import { SESSION_FACT_TOOL_NAME } from "../tool-name";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

export { SESSION_FACT_TOOL_NAME };

export const SESSION_FACT_DESCRIPTION =
	"Record a CODE FACT you verified yourself into this orchestrated session's shared pool, so executors on OTHER tiers can use it without re-deriving it. " +
	"Use it only for conclusions you reached by reading code or running a command — never for a guess, a plan, or something you were told. " +
	"Every fact must name the file paths it came from; those files are hashed now, and if any of them changes later the fact is automatically withheld from everyone rather than served stale. " +
	'A fact you cannot anchor to a file you actually opened does not belong here — leave it to the coordinator. action "add" writes one; action "list" shows the pool as it stands right now.';

const messages: LocalizedValue<{
	notParticipant: string;
	added: string;
	listed: string;
	emptyPool: string;
	rejected: Record<SharedFactRejection, string>;
}> = {
	en: {
		notParticipant:
			"SessionFact only works inside an orchestration dispatch: the caller must be an orchestration executor or its independent reviewer. This session is neither, so there is no shared pool to read or write. Continue without it.",
		added:
			"Recorded. Anchored at {anchors} (content sha256 {hash}…). Executors on other tiers will see it on their next dispatch, and it will be withheld automatically if any of those files changes.",
		listed: "Current shared pool for this session:\n\n{block}",
		emptyPool: "The shared pool for this session is empty.",
		rejected: {
			empty_statement: "Nothing to record: `statement` is empty.",
			statement_too_long:
				"`statement` is too long (limit {limit} characters). Write the conclusion, not the narrative.",
			empty_evidence:
				"`evidence` is required: say how you established this (which file you read, which command you ran).",
			evidence_too_short: "`evidence` is too short to be evidence (minimum {limit} characters).",
			evidence_too_long: "`evidence` is too long (limit {limit} characters).",
			no_anchors:
				"`files` is required: name at least one file you actually read to reach this conclusion. A fact with no anchor can never be checked for staleness, so it would be shared forever — that is worse than not sharing it.",
			too_many_anchors:
				"Too many anchors in one fact (limit {limit}). Split it, or anchor it to the file that actually carries the conclusion.",
			anchor_outside_workspace:
				"`{path}` is not inside this session's workspace. Anchors must be workspace-relative paths of files in the tree you are working on.",
			anchor_missing:
				"`{path}` does not exist. Name the file as it exists now, as a workspace-relative path.",
			anchor_not_a_file: "`{path}` is not a regular file, so it cannot be hashed as an anchor.",
			anchor_too_large:
				"`{path}` is larger than the {limit} byte anchor limit, so it cannot be anchored.",
			anchor_unreadable: "`{path}` exists but could not be read, so it cannot be anchored.",
			workspace_mismatch:
				"This session's facts are anchored in a different workspace ({path}). A path means something different there, so this fact was not recorded.",
			session_full:
				"This session's shared pool is full ({limit} facts). Do not drop an existing fact to make room — tell the coordinator instead.",
		},
	},
	"zh-CN": {
		notParticipant:
			"SessionFact 只在编排派发里可用：调用方必须是编排执行者或它的独立复核者。本会话两者都不是，因此没有可读写的共享池。请按原样继续。",
		added:
			"已记录。锚定 {anchors}（内容 sha256 {hash}…）。其他档位的执行者在它们下次派发时会看到这条；上述文件一旦变更，它会自动被扣下而不是被当成有效。",
		listed: "本会话当前的共享池：\n\n{block}",
		emptyPool: "本会话的共享池还是空的。",
		rejected: {
			empty_statement: "没东西可记：`statement` 是空的。",
			statement_too_long: "`statement` 太长（上限 {limit} 字符）。写结论，不要写叙述。",
			empty_evidence:
				"`evidence` 是必填的：说清你是怎么得出这条结论的（读了哪个文件、跑了什么命令）。",
			evidence_too_short: "`evidence` 太短，不足以构成取证（至少 {limit} 个字符）。",
			evidence_too_long: "`evidence` 太长（上限 {limit} 字符）。",
			no_anchors:
				"`files` 是必填的：至少写出一个你**真的读过**、并据以得出结论的文件。没有锚点的事实永远无法判定是否过期，于是会被永久当作有效——那比不共享更糟。",
			too_many_anchors:
				"一条事实的锚点太多了（上限 {limit}）。请拆开，或者只锚定真正承载这条结论的那个文件。",
			anchor_outside_workspace:
				"`{path}` 不在本会话的工作区里。锚点必须是你在改的那棵代码树里、相对工作区的路径。",
			anchor_missing: "`{path}` 不存在。请按它现在的样子写成一个相对工作区的路径。",
			anchor_not_a_file: "`{path}` 不是普通文件，无法作为锚点计算哈希。",
			anchor_too_large: "`{path}` 超过锚点的 {limit} 字节上限，无法锚定。",
			anchor_unreadable: "`{path}` 存在但读不出来，无法锚定。",
			workspace_mismatch:
				"本会话的事实锚定在另一个工作区（{path}）。同一个相对路径在那里指的是别的内容，因此这条没有被记录。",
			session_full:
				"本会话的共享池已满（{limit} 条）。不要为了腾位置而丢掉已有的事实——把这件事告诉编制者。",
		},
	},
};

/** 给拒绝原因填空：`{path}` / `{limit}`。缺省值留空，不抛。 */
function fillTemplate(template: string, values: Partial<Record<"path" | "limit", string>>): string {
	return template
		.replace("{path}", values.path ?? "")
		.replace("{limit}", values.limit ?? "")
		.trim();
}

/** 拒绝原因 → 该原因对应的那个上限值（消息里的 `{limit}`）。 */
function limitForReason(reason: SharedFactRejection): string | undefined {
	switch (reason) {
		case "too_many_anchors":
			return String(MAX_FACT_ANCHORS);
		case "session_full":
			return String(MAX_SHARED_FACTS_PER_SESSION);
		default:
			return undefined;
	}
}

/**
 * 读出调用者的行并判定它是不是本会话的参与者。
 *
 * 一次主键查询（`narrators.id`），只取三列；这是本工具唯一的 I/O，且不涉及大字段。
 */
async function loadParticipant(ctx: ToolContext) {
	try {
		const { db } = await import("@server/db");
		const row = await db.query.narrators.findFirst({
			where: (table, { eq }) => eq(table.id, ctx.narratorId),
			columns: { id: true, parentNarratorId: true, subagentType: true },
		});
		return resolveSharedFactParticipant(row ?? null);
	} catch {
		// 读不到行 = 判定不了参与身份。这里必须 fail closed：共享池是跨档位共享的，
		// 一个身份不明的写入者宁可写不进来。
		return null;
	}
}

export const sessionFactTool: ToolDefinition = {
	name: SESSION_FACT_TOOL_NAME,
	description: SESSION_FACT_DESCRIPTION,
	parameters: z.object({
		action: z.enum(["add", "list"]).optional(),
		statement: z.string().optional(),
		evidence: z.string().optional(),
		files: z.array(z.string()).optional(),
	}),
	rawJsonSchema: {
		type: "object",
		properties: {
			action: {
				description:
					'"add" records a fact (default); "list" prints the pool as it stands right now, after re-checking every anchor against the tree.',
				type: "string",
				enum: ["add", "list"],
			},
			statement: {
				description:
					'The conclusion itself, one or two sentences, phrased so someone who has not read the file can act on it. Required for "add".',
				type: "string",
			},
			evidence: {
				description:
					'How you established it — which file and lines you read, or which command you ran and what it printed. Required for "add".',
				type: "string",
			},
			files: {
				description:
					'Workspace-relative paths of the files this conclusion rests on. Required for "add"; each one is hashed as it exists right now.',
				type: "array",
				items: { type: "string" },
			},
		},
		required: [],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		// `ctx.locale` 的类型是 string（工具运行时对 locale 不做枚举约束），失败时回落到 en。
		const locale = (ctx.locale === "zh-CN" ? "zh-CN" : "en") as Locale;
		const text = pickLocalizedValue(messages, locale);

		const participant = await loadParticipant(ctx);
		if (!participant) {
			return { output: text.notParticipant, isError: true };
		}

		const action = args.action === "list" ? "list" : "add";

		if (action === "list") {
			const inventory = await inspectSharedFacts(participant.sessionKey);
			if (!inventory) return { output: text.emptyPool };
			const block = renderSharedFactsBlock(inventory, locale);
			if (!block) {
				// 池子非空但一条都不能用（全被判成过期/无法核实）时，`renderSharedFactsBlock`
				// 会返回空串。这里必须把"有东西但都被扣下了"说出来，否则和"池子是空的"
				// 长得一模一样——而这两件事该做的决定完全不同。
				return {
					output: `${text.emptyPool}\n\n${inspectSummary(inventory, locale)}`,
				};
			}
			return { output: text.listed.replace("{block}", block) };
		}

		const result = await addSharedFact({
			sessionKey: participant.sessionKey,
			workspaceRoot: ctx.cwd,
			authorNarratorId: ctx.narratorId,
			authorKind: participant.authorKind,
			authorTier: participant.authorTier,
			statement: typeof args.statement === "string" ? args.statement : "",
			evidence: typeof args.evidence === "string" ? args.evidence : "",
			files: Array.isArray(args.files)
				? args.files.filter((file): file is string => typeof file === "string")
				: [],
		});

		if (!result.ok) {
			return {
				output: fillTemplate(text.rejected[result.reason], {
					path: result.detail,
					limit: limitForReason(result.reason),
				}),
				isError: true,
			};
		}

		return {
			output: text.added
				.replace("{anchors}", result.fact.anchors.map((anchor) => anchor.path).join(", "))
				.replace("{hash}", result.fact.anchors[0]?.sha256.slice(0, 8) ?? ""),
		};
	},
};

/**
 * 池子里的条目全被扣下时的一行说明。
 *
 * 只报数量与受影响文件，**绝不重复结论文本**：一句可能已经错的话，就算标明"可能过期"，
 * 模型照样会照着做（同样的理由见 `shared-facts.ts` 的剔除策略）。
 */
function inspectSummary(
	inventory: NonNullable<Awaited<ReturnType<typeof inspectSharedFacts>>>,
	locale: Locale,
): string {
	const parts: string[] = [];
	const stalePaths = [...new Set(inventory.stale.flatMap((entry) => entry.changedPaths))];
	const unknownPaths = [...new Set(inventory.unverifiable.flatMap((entry) => entry.paths))];
	if (stalePaths.length > 0) {
		parts.push(
			locale === "zh-CN"
				? `其中 ${inventory.stale.length} 条因锚定文件已变更被扣下（${stalePaths.join(", ")}）。`
				: `${inventory.stale.length} of them are withheld because their anchored files changed (${stalePaths.join(", ")}).`,
		);
	}
	if (unknownPaths.length > 0) {
		parts.push(
			locale === "zh-CN"
				? `${inventory.unverifiable.length} 条无法核对（${unknownPaths.join(", ")}）。`
				: `${inventory.unverifiable.length} cannot be checked right now (${unknownPaths.join(", ")}).`,
		);
	}
	return parts.join(" ");
}
