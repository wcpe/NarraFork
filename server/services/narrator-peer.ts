/**
 * narrator-peer.ts — cross-team addressing for narrator-to-narrator messaging.
 *
 * The Send tool's team scope (`agent-communication.ts`) only ever resolves a
 * caller's own subtree, so a primary narrator has no way to name another
 * primary. This module is the single place that answers "which other
 * narrators may this session talk to, and which one did the caller mean?".
 *
 * Two invariants hold every exported function together, and callers must not
 * re-implement either:
 *
 *  1. **ACL is part of the query, not a filter applied after it.** Every read
 *     pushes `narratorReadableWhere(principal)` into SQL so this surface and
 *     the HTTP list endpoint (`routes/narrators.ts`) ask the database the same
 *     question. `narratorService.getById` is deliberately NOT used here: it
 *     skips the access check entirely when called without an `acl` argument,
 *     which for a cross-team lookup would be a straight read of another user's
 *     conversation.
 *  2. **Peers are primary, non-archived, and not the caller.** A subagent has
 *     its own team semantics and is reachable through `Send` already; an
 *     archived narrator cannot act on what it receives.
 *
 * Title matching uses LIKE rather than the `narrators_fts` MATCH operator.
 * That table is trigram-tokenized (`db/fts.ts`), where MATCH treats quotes and
 * operator characters as syntax and throws on model-authored text; the peer
 * candidate set is small enough that a scan is not the cost that matters, and
 * LIKE has no quoting rules to get wrong.
 */

import { foldHandle } from "@shared/narrator-handle";
import { and, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { escapeLikeNeedle } from "../lib/sql-like";
import { type NarratorPrincipal, narratorReadableWhere } from "./narrator-acl";

/**
 * Reading principal for a user id, or null when the turn has no user identity.
 *
 * The role is read live rather than carried on the turn input: an admin flag
 * copied at turn start would outlive a demotion, and this lookup sits on the
 * Send path where a stale `true` would widen what the session may read.
 *
 * Null is a real answer, not a fallback — several entry points (Await
 * resolution, TeamStatus membership, ContextAsk) run without a user and must
 * stay unable to address peers at all.
 */
export async function resolvePeerPrincipal(
	userId: string | null | undefined,
): Promise<NarratorPrincipal | null> {
	if (!userId) return null;
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	return { userId, isAdmin: user?.role === "admin" };
}

/** Rows a discovery call may return before the caller is told to narrow down. */
const PEER_SEARCH_LIMIT_MAX = 50;
const PEER_SEARCH_LIMIT_DEFAULT = 20;

/**
 * Shortest selector accepted as an id prefix. A shorter prefix would match
 * most of the table and turn a mistyped selector into an arbitrary peer.
 */
const MIN_ID_PREFIX_LENGTH = 6;

/** What a discovery caller needs to pick a peer — never the whole row. */
export interface PeerSummary {
	id: string;
	title: string | null;
	handle: string | null;
	status: string;
	variant: string;
}

/** A resolved peer, carrying the fields the Send path re-checks before delivery. */
export interface PeerNarrator extends PeerSummary {
	chapterId: string | null;
	parentNarratorId: string | null;
	visibility: string | null;
	ownerUserId: string | null;
}

const PEER_COLUMNS = {
	id: narrators.id,
	title: narrators.title,
	handle: narrators.handle,
	status: narrators.status,
	variant: narrators.variant,
	chapterId: narrators.chapterId,
	parentNarratorId: narrators.parentNarratorId,
	visibility: narrators.visibility,
	ownerUserId: narrators.ownerUserId,
} as const;

/**
 * Conditions every peer read shares. `narratorReadableWhere` returns undefined
 * for admins, which `and(...)` treats as no restriction.
 */
function peerConditions(principal: NarratorPrincipal, excludeNarratorId: string) {
	return and(
		// Subagents are excluded by variant rather than by a `NOT LIKE`: a
		// primary's `parentNarratorId` is set when it was forked, so the column
		// says nothing about what this row is.
		eq(narrators.variant, "primary"),
		ne(narrators.status, "archived"),
		ne(narrators.id, excludeNarratorId),
		narratorReadableWhere(principal),
	);
}

function toSummary(row: PeerNarrator): PeerSummary {
	return {
		id: row.id,
		title: row.title ?? null,
		handle: row.handle ?? null,
		status: row.status,
		variant: row.variant,
	};
}

/** Render one candidate for an ambiguity error, mirroring the subagent format. */
function formatCandidate(row: PeerSummary): string {
	const name = row.handle ? `@${row.handle}` : row.title || "(untitled)";
	return `- ${name} | ${row.title ?? "(untitled)"} (id: ${row.id.slice(0, 8)})`;
}

/**
 * One ID prefix is enough; the selector grammar below decides when an id-shaped
 * token is even tried. Callers get the same "@handle" affordance the composer
 * offers, so the prefix is stripped before folding — `foldHandle` only folds
 * case and normalizes, it does not know about the sigil.
 */
function handleFoldOf(selector: string): string {
	return foldHandle(selector.trim().replace(/^@+/, ""));
}

/**
 * Find narrators this session may address, best match first.
 *
 * An empty query lists the most recently active peers, which is what
 * `TeamStatus({action: "list_peers"})` wants; a non-empty one narrows by
 * title, handle, or id prefix.
 */
export async function searchPeerNarrators(opts: {
	query?: string | null;
	principal: NarratorPrincipal;
	excludeNarratorId: string;
	limit?: number;
}): Promise<PeerSummary[]> {
	const requested = opts.limit ?? PEER_SEARCH_LIMIT_DEFAULT;
	const limit = Math.min(
		PEER_SEARCH_LIMIT_MAX,
		Math.max(1, Math.trunc(Number.isFinite(requested) ? requested : PEER_SEARCH_LIMIT_DEFAULT)),
	);
	const needle = escapeLikeNeedle(opts.query);
	const where = needle
		? and(
				peerConditions(opts.principal, opts.excludeNarratorId),
				or(
					sql`${narrators.title} LIKE ${`%${needle}%`} ESCAPE '\\'`,
					// Handles are stored folded (NFC + lowercase, see
					// `shared/narrator-handle.ts`), so folding the needle here lets a
					// model type "@MyBot" for a handle stored as "mybot".
					sql`${narrators.handleFold} = ${handleFoldOf(opts.query ?? "")}`,
					sql`${narrators.id} LIKE ${`${needle}%`} ESCAPE '\\'`,
				),
			)
		: peerConditions(opts.principal, opts.excludeNarratorId);

	const rows = await db
		.select(PEER_COLUMNS)
		.from(narrators)
		.where(where)
		// Busy narrators first: a peer that is already running can answer, an idle
		// one has to be woken, and that difference decides who to write to.
		.orderBy(
			desc(sql`CASE WHEN ${narrators.status} IN ('working','waiting') THEN 0 ELSE 1 END`),
			desc(sql`COALESCE(${narrators.lastMessageAt}, ${narrators.createdAt})`),
		)
		.limit(limit);
	return rows.map(toSummary);
}

/**
 * Resolve one selector to exactly one peer, or explain why it could not.
 *
 * Resolution order runs from most to least specific so a full id never loses
 * to a title match, and an ambiguous result names its candidates instead of
 * picking one — the same contract `resolveOneTarget` uses for subagents, so a
 * model that learned to disambiguate there applies it here too.
 */
export async function resolvePeerNarrator(opts: {
	selector: string;
	principal: NarratorPrincipal;
	excludeNarratorId: string;
}): Promise<PeerNarrator> {
	const selector = opts.selector.trim();
	if (!selector) throw new Error("Peer selector is required");

	const base = peerConditions(opts.principal, opts.excludeNarratorId);

	// 1. Exact id.
	const byId = await db
		.select(PEER_COLUMNS)
		.from(narrators)
		.where(and(base, eq(narrators.id, selector)))
		.limit(1);
	if (byId[0]) return byId[0];

	// 2. Handle (exact, case-folded).
	const folded = handleFoldOf(selector);
	if (folded) {
		const byHandle = await db
			.select(PEER_COLUMNS)
			.from(narrators)
			.where(and(base, isNotNull(narrators.handle), eq(narrators.handleFold, folded)))
			.limit(1);
		if (byHandle[0]) return byHandle[0];
	}

	// 3. Id prefix — only once long enough to be discriminating.
	const prefixNeedle = escapeLikeNeedle(selector);
	const prefix = selector.length >= MIN_ID_PREFIX_LENGTH ? prefixNeedle : undefined;
	// 4. Title substring.
	const titleLike = prefixNeedle ? `%${prefixNeedle}%` : null;

	if (prefix || titleLike) {
		const matches = await db
			.select(PEER_COLUMNS)
			.from(narrators)
			.where(
				and(
					base,
					or(
						...(prefix ? [sql`${narrators.id} LIKE ${`${prefix}%`} ESCAPE '\\'`] : []),
						...(titleLike ? [sql`${narrators.title} LIKE ${titleLike} ESCAPE '\\'`] : []),
					),
				),
			)
			.limit(PEER_SEARCH_LIMIT_MAX + 1);

		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new Error(
				`Ambiguous peer target "${selector}". Candidates:\n${matches.map(formatCandidate).join("\n")}`,
			);
		}
	}

	// Three different mistakes land here and the model needs to tell them
	// apart, because the right next move differs for each: an unreadable peer
	// needs a different target, a wrong id needs the id re-read, a wrong title
	// needs spelling fixed. Asserting "it was almost certainly an ACL problem"
	// sends the model hunting for a permission issue that does not exist, so the
	// three are named together instead.
	throw new Error(
		`No readable narrator matches "${selector}". It may not exist, may be spelled ` +
			"differently, or may be one you cannot read. Verify the id, try the @handle or a " +
			'distinctive part of the title, or run TeamStatus({ action: "list_peers" }) to see ' +
			"who is available.",
	);
}

/**
 * Whether a resolved row may receive a message from this session.
 *
 * Delivery re-checks this after re-reading the row: the first check happens
 * during resolution, and between then and the enqueue the narrator may have
 * been archived or have lost access.
 */
export function assertPeerDeliverable(row: { id: string; variant: string; status: string }): void {
	if (row.variant !== "primary") {
		throw new Error("Peer messaging is only supported between primary narrators");
	}
	if (row.status === "archived") {
		throw new Error("Target narrator is archived");
	}
}
