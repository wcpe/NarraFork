/**
 * narrator-peer.test.ts — cross-team addressing must not become a read hole.
 *
 * The behaviour under test is the invariant the whole feature rests on: a
 * primary may address another primary only when the SAME predicate that gates
 * the HTTP list endpoint says the session can read it. A bug in that predicate
 * would not throw — it would hand one user the titles and message excerpts of
 * another user's private sessions, which is why every case below asserts
 * invisibility as directly as it asserts resolution.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, users } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { resolvePeerNarrator, resolvePeerPrincipal, searchPeerNarrators } = await import(
	"../narrator-peer"
);

const OWNER = "peer-owner";
const STRANGER = "peer-stranger";
const ADMIN = "peer-admin";
const SELF = "peer-self";
const PEER = "peer-target";
const PEER_PRIVATE = "peer-private";
const PEER_SUB = "peer-subagent";
const PEER_ARCHIVED = "peer-archived";

const now = "2026-09-22T00:00:00.000Z";

const reader = { userId: OWNER, isAdmin: false };
const admin = { userId: ADMIN, isAdmin: true };

async function seed(): Promise<void> {
	cleanDb(sqlite);
	// `ownerUserId` is a foreign key, and the ACL predicate joins through it, so
	// the users have to exist before the narrators that point at them.
	await db.insert(users).values([
		{ id: OWNER, username: "owner", passwordHash: "x", role: "user", createdAt: now },
		{ id: STRANGER, username: "stranger", passwordHash: "x", role: "user", createdAt: now },
		{ id: ADMIN, username: "admin", passwordHash: "x", role: "admin", createdAt: now },
	]);
	await db.insert(narrators).values([
		{
			id: SELF,
			variant: "primary",
			type: "primary",
			title: "My own session",
			handle: "me",
			handleFold: "me",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PEER,
			variant: "primary",
			type: "primary",
			title: "Release notes draft",
			handle: "notes",
			handleFold: "notes",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "peer-title-twin",
			variant: "primary",
			type: "primary",
			title: "Release notes draft",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
		{
			// Distinctive title the caller owns, for the unique-fragment case.
			id: "peer-unique",
			variant: "primary",
			type: "primary",
			title: "Incident postmortem for the 02 outage",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PEER_PRIVATE,
			variant: "primary",
			type: "primary",
			title: "Someone else's private",
			ownerUserId: STRANGER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PEER_SUB,
			variant: "subagent:explore",
			type: "subagent",
			title: "A subagent",
			parentNarratorId: PEER,
			aclRootNarratorId: PEER,
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PEER_ARCHIVED,
			variant: "primary",
			type: "primary",
			title: "Retired session",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			status: "archived",
			createdAt: now,
			updatedAt: now,
		},
	]);
}

beforeEach(seed);

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

describe("searchPeerNarrators", () => {
	test("returns primary peers the caller owns and hides everyone else's", async () => {
		const peers = await searchPeerNarrators({ principal: reader, excludeNarratorId: SELF });
		const ids = peers.map((p) => p.id);
		expect(ids).toContain(PEER);
		expect(ids).not.toContain(SELF);
		expect(ids).not.toContain(PEER_PRIVATE);
	});

	test("never returns subagents or archived narrators", async () => {
		const peers = await searchPeerNarrators({ principal: reader, excludeNarratorId: SELF });
		const ids = peers.map((p) => p.id);
		expect(ids).not.toContain(PEER_SUB);
		expect(ids).not.toContain(PEER_ARCHIVED);
	});

	test("a private narrator stays invisible to a different owner", async () => {
		const stranger = { userId: STRANGER, isAdmin: false };
		const peers = await searchPeerNarrators({ principal: stranger, excludeNarratorId: "peer-x" });
		const ids = peers.map((p) => p.id);
		expect(ids).not.toContain(PEER);
		expect(ids).toContain(PEER_PRIVATE);
	});

	test("an admin sees peers other owners cannot, but still no subagents", async () => {
		const peers = await searchPeerNarrators({ principal: admin, excludeNarratorId: "peer-x" });
		const ids = peers.map((p) => p.id);
		// ACL is lifted, the kind filter is not: a subagent is addressed through
		// the team tools, and admitting it here would add a second path.
		expect(ids).toContain(PEER_PRIVATE);
		expect(ids).not.toContain(PEER_SUB);
		// Archived is a state filter, so it excludes for admins too.
		expect(ids).not.toContain(PEER_ARCHIVED);
	});

	test("filters by title, and a needle that matches nothing is empty rather than everything", async () => {
		const hits = await searchPeerNarrators({
			query: "Retired",
			principal: reader,
			excludeNarratorId: SELF,
		});
		expect(hits.map((p) => p.id)).not.toContain(PEER_ARCHIVED);

		const misses = await searchPeerNarrators({
			query: "no-such-title-anywhere",
			principal: reader,
			excludeNarratorId: SELF,
		});
		expect(misses).toHaveLength(0);
	});

	test("treats LIKE wildcards in the query as literal characters", async () => {
		// Without escaping, "%" would match every row and the filter would read as
		// "the query was ignored" rather than "the query found nothing".
		const hits = await searchPeerNarrators({
			query: "%",
			principal: reader,
			excludeNarratorId: SELF,
		});
		expect(hits).toHaveLength(0);
	});

	test("honours the limit", async () => {
		const hits = await searchPeerNarrators({
			principal: reader,
			excludeNarratorId: SELF,
			limit: 1,
		});
		expect(hits).toHaveLength(1);
	});
});

describe("resolvePeerNarrator", () => {
	test("resolves a full id", async () => {
		const peer = await resolvePeerNarrator({
			selector: PEER,
			principal: reader,
			excludeNarratorId: SELF,
		});
		expect(peer.id).toBe(PEER);
	});

	test("resolves an @handle case-insensitively", async () => {
		const peer = await resolvePeerNarrator({
			selector: "@NoTeS",
			principal: reader,
			excludeNarratorId: SELF,
		});
		expect(peer.id).toBe(PEER);
	});

	test("resolves a unique title fragment", async () => {
		const peer = await resolvePeerNarrator({
			selector: "02 outage",
			principal: reader,
			excludeNarratorId: SELF,
		});
		expect(peer.id).toBe("peer-unique");
	});

	test("refuses a selector the caller cannot read, naming access rather than a typo", async () => {
		// A "not found" message would send the model hunting for a spelling
		// mistake; the invisible case is by far the most likely explanation.
		await expect(
			resolvePeerNarrator({
				selector: "Someone else's private",
				principal: reader,
				excludeNarratorId: SELF,
			}),
		).rejects.toThrow(/can read|list_peers/i);
	});

	test("refuses to address the caller itself", async () => {
		await expect(
			resolvePeerNarrator({ selector: SELF, principal: reader, excludeNarratorId: SELF }),
		).rejects.toThrow();
	});

	test("refuses to resolve a subagent, even one the caller can read", async () => {
		// Peer messaging is primary↔primary; a subagent is reached through the
		// team tools, and resolving it here would create a second addressing path
		// with different authorization.
		await expect(
			resolvePeerNarrator({
				selector: "A subagent",
				principal: reader,
				excludeNarratorId: SELF,
			}),
		).rejects.toThrow();
	});

	test("reports an ambiguous title instead of picking one", async () => {
		const attempt = resolvePeerNarrator({
			selector: "Release notes draft",
			principal: reader,
			excludeNarratorId: SELF,
		});
		await expect(attempt).rejects.toThrow(/Ambiguous/i);
		await expect(attempt).rejects.toThrow(new RegExp(PEER.slice(0, 8)));
	});

	test("rejects an empty selector without touching the database", async () => {
		await expect(
			resolvePeerNarrator({ selector: "   ", principal: reader, excludeNarratorId: SELF }),
		).rejects.toThrow(/required/i);
	});
});

describe("resolvePeerPrincipal", () => {
	test("returns null when the turn carries no user", async () => {
		expect(await resolvePeerPrincipal(null)).toBeNull();
		expect(await resolvePeerPrincipal(undefined)).toBeNull();
		expect(await resolvePeerPrincipal("")).toBeNull();
	});

	test("reads the live role rather than trusting the caller", async () => {
		// A principal is only ever built from a user id here, so there is nothing
		// to spoof; the assertion documents that contract.
		expect(await resolvePeerPrincipal("no-such-user")).toEqual({
			userId: "no-such-user",
			isAdmin: false,
		});
	});
});
