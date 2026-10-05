/**
 * peer-peek.ts — read-only look at another primary narrator.
 *
 * Send can already deliver a message to another narrator, but it cannot answer
 * "who is this and what have they been doing". Without that, a model either
 * messages blind or burns its own context guessing from the title. This tool
 * closes the gap with the smallest possible surface: a bounded, read-only
 * summary of one peer's identity and recent turns.
 *
 * Everything here goes through `narrator-peer`, so the visibility predicate
 * that decides whether this session may read the peer is the same one the Send
 * path enforces — a tool that can peek cannot see anything Send could not
 * deliver to.
 */

import { logger } from "@server/lib/logger";
import { runtimePolicyForContext } from "@server/services/agent-runtime/policy";
import type { PeerNarrator } from "@server/services/narrator-peer";
import { z } from "zod/v4";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

/** Most recent turns a single peek may return. */
const PEEK_DEFAULT_LIMIT = 6;
const PEEK_MAX_LIMIT = 20;

/** Per-message cap, so one pasted document cannot crowd out the whole window. */
const PEEK_MAX_CHARS_PER_MESSAGE = 600;

/** Total output cap across all turns. */
const PEEK_MAX_TOTAL_CHARS = 6_000;

const TRUNCATION_MARKER = "…";

function clampLimit(value: number | undefined): number {
	if (value == null || !Number.isFinite(value)) return PEEK_DEFAULT_LIMIT;
	return Math.min(PEEK_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

/** One line per turn, attributed so the model can tell who said what. */
function formatTurn(role: string, text: string): string {
	const who = role === "user" ? "user" : role === "assistant" ? "assistant" : role;
	const body = text
		.trim()
		.replace(/\s*\n+\s*/g, " ")
		.trim();
	const clipped =
		body.length > PEEK_MAX_CHARS_PER_MESSAGE
			? `${body.slice(0, PEEK_MAX_CHARS_PER_MESSAGE)}${TRUNCATION_MARKER}`
			: body;
	return `- ${who}: ${clipped || "(empty)"}`;
}

function peekError(message: string): ToolResult {
	return { output: `PeerPeek error: ${message}`, isError: true };
}

/**
 * Peer discovery and reading are primary-only.
 *
 * The test mirrors `runtimePolicyForContext`'s own definition of the two
 * roles rather than adding a capability flag: a subagent has no business
 * surveying its peers, and the team-scoped tools already cover its needs.
 */
function isSubagentContext(ctx: ToolContext): boolean {
	return runtimePolicyForContext(ctx).capabilities.spawnAgent !== true;
}

export const peerPeekTool: ToolDefinition = {
	name: "PeerPeek",
	description:
		"Read a bounded summary of another narrator you can access: its title, status, model, " +
		"and its most recent turns. Use this before messaging a narrator you have not worked " +
		"with, so the message answers what they are actually doing instead of guessing from " +
		"the title. Target it by id, @handle, or a distinctive part of the title. " +
		'Run TeamStatus({ action: "list_peers" }) first to discover who is available. ' +
		"This is read-only: it sends nothing, wakes nothing, and does not change the target's " +
		"state — use Send to actually message someone. Peers you cannot read are not visible " +
		"here either, and the excerpt is a recent tail, not the full history.",
	parameters: z.object({
		id: z
			.string()
			.trim()
			.min(1)
			.max(256)
			.describe("Target narrator id, @handle, or a distinctive fragment of its title."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(PEEK_MAX_LIMIT)
			.optional()
			.describe(
				`How many recent turns to include (1-${PEEK_MAX_LIMIT}, default ${PEEK_DEFAULT_LIMIT}).`,
			),
	}),
	metadata: { readOnly: true },
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as { id?: string; limit?: number };
		const selector = raw.id?.trim();
		if (!selector) return peekError("id is required.");
		if (isSubagentContext(ctx)) {
			return peekError("only a primary narrator can inspect peers.");
		}

		const limit = clampLimit(raw.limit);
		// Addressing errors (not found, ambiguous, unreadable) come from our own
		// resolver and are the model's to fix. Anything else — a database or
		// transport failure — is ours, and must not be dressed up as "you lack
		// access", or the model gives up on a peer it was allowed to read.
		let peer: PeerNarrator | undefined;
		try {
			const { resolvePeerNarrator, resolvePeerPrincipal } = await import(
				"@server/services/narrator-peer"
			);
			// A turn without a user identity cannot read anything, and pretending
			// otherwise would turn "no principal" into a silent empty result.
			const principal = await resolvePeerPrincipal(ctx.userId);
			if (!principal) {
				return peekError("no user session is attached to this turn; cannot read peers.");
			}
			peer = await resolvePeerNarrator({
				selector,
				principal,
				excludeNarratorId: ctx.narratorId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Resolver failures are the model's to correct; anything else is an
			// operational fault and retrying is the only sensible response.
			if (!/no readable narrator|ambiguous|is required/i.test(message)) {
				logger.warn("PeerPeek failed outside target resolution", { error: message });
				return peekError(
					`Could not read the peer right now (${message}). This is a system fault, ` +
						"not a permission problem — retry, or send a message instead.",
				);
			}
			return peekError(message);
		}

		try {
			const { narratorService } = await import("@server/services/narrator-service");
			const snapshot = await narratorService.getContextAskHistorySnapshot(peer.id, limit);
			// Whitelist, not blacklist: the persisted roles include `sys`, whose
			// contentText carries native model-context injections (Dynamic Spec
			// continuations, blocked-continuation instructions, knowledge hints,
			// merge summaries). A `role.startsWith("system")` filter misses `sys`
			// entirely and would hand the peer's internal instructions to another
			// narrator. Only the two conversational roles are the point of a peek.
			const turns = snapshot.messages
				.filter((message) => message.role === "user" || message.role === "assistant")
				.map((message) => formatTurn(message.role, message.contentText ?? ""))
				.filter((line) => !line.endsWith("(empty)"));

			const header =
				`${peer.title ?? "(untitled)"}${peer.handle ? ` (@${peer.handle})` : ""} — ` +
				`status: ${peer.status}, id: ${peer.id}` +
				(peer.chapterId ? "" : ", standalone");
			const more = snapshot.hasMore ? "\n(older turns exist and are not shown)" : "";
			const body =
				turns.length > 0 ? `\n\nrecent turns:\n${turns.join("\n")}` : "\n\n(no readable turns yet)";

			let output = `${header}${body}${more}`;
			let truncated = false;
			if (output.length > PEEK_MAX_TOTAL_CHARS) {
				output = `${output.slice(0, PEEK_MAX_TOTAL_CHARS)}${TRUNCATION_MARKER}`;
				truncated = true;
			}

			return {
				output,
				metadata: {
					kind: "peer_peek",
					target: { id: peer.id, title: peer.title, status: peer.status },
					turnsShown: turns.length,
					hasMore: snapshot.hasMore,
					truncated,
				},
			};
		} catch (error) {
			// Past this point the target is resolved, so any failure is operational
			// rather than something the model can correct.
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("PeerPeek history read failed", { narratorId: peer.id, error: message });
			return peekError(
				`Found the peer but could not read its history (${message}). This is a system ` +
					"fault, not a permission problem — retry, or send a message instead.",
			);
		}
	},
};
