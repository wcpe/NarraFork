/**
 * peer-peek.test.ts — the read-only peer probe's boundaries.
 *
 * Three things have to hold at once, and only the first is obvious: a subagent
 * cannot call it, a turn without a user cannot read anything through it, and a
 * peer the session cannot read is not reachable by id either. The last one is
 * the point of routing every read through `resolvePeerNarrator` — a peek that
 * resolved ids on its own would be an ACL bypass that Send itself is not.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../../../tests/setup";
import { narrators, users } from "../../../../db/schema";
import type { ToolContext } from "../../types";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../db")) };
mock.module("../../../../db", () => ({ ...realDbModule, db, sqlite }));

const OWNER = "peek-owner";
const STRANGER = "peek-stranger";
const SELF = "peek-self";
const PEER = "peek-target";
const PEER_PRIVATE = "peek-private";
const SUB = "peek-subagent";

const now = "2026-09-23T00:00:00.000Z";

/** Turns double as the history reader, so the probe's own output stays the subject. */
const turns: Array<{ role: string; contentText: string | null }> = [];

const realNarratorService = { ...(await import("@server/services/narrator-service")) };
mock.module("@server/services/narrator-service", () => ({
	...realNarratorService,
	narratorService: {
		...realNarratorService.narratorService,
		// Mirrors the real reader: newest `limit` turns, oldest first, with
		// `hasMore` when older ones exist. Honouring `limit` here is what makes
		// the probe's own pass-through assertable.
		getContextAskHistorySnapshot: async (_narratorId: string, limit = 6) => {
			const tail = turns.slice(-Math.max(1, limit));
			return {
				messages: tail,
				hasMore: turns.length > tail.length,
				sourceTruncated: false,
				toolCallsTruncated: false,
				sourceBytes: 0,
			};
		},
	},
}));

const { peerPeekTool } = await import("../peer-peek");

beforeEach(async () => {
	cleanDb(sqlite);
	turns.length = 0;
	await db.insert(users).values([
		{ id: OWNER, username: "peek-owner", passwordHash: "x", role: "user", createdAt: now },
		{ id: STRANGER, username: "peek-stranger", passwordHash: "x", role: "user", createdAt: now },
	]);
	await db.insert(narrators).values([
		{
			id: SELF,
			variant: "primary",
			type: "primary",
			title: "Myself",
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
			title: "Payments rewrite",
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
			title: "Not yours",
			ownerUserId: STRANGER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: SUB,
			variant: "subagent:explore",
			type: "subagent",
			title: "A worker",
			parentNarratorId: PEER,
			aclRootNarratorId: PEER,
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterAll(() => {
	mock.module("@server/services/narrator-service", () => realNarratorService);
	mock.module("../../../../db", () => realDbModule);
	sqlite.close();
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		narratorId: SELF,
		userId: OWNER,
		locale: "en",
		signal: new AbortController().signal,
		...overrides,
	} as ToolContext;
}

describe("PeerPeek", () => {
	test("returns the peer identity and its recent turns", async () => {
		turns.push(
			{ role: "user", contentText: "start the migration" },
			{ role: "assistant", contentText: "schema is drafted" },
		);
		const result = await peerPeekTool.execute({ id: PEER }, ctx());
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("Payments rewrite");
		expect(result.output).toContain("user: start the migration");
		expect(result.output).toContain("assistant: schema is drafted");
		expect(result.metadata?.kind).toBe("peer_peek");
	});

	test("refuses a subagent", async () => {
		// Mirrors the team-tools rule: a subagent's world is its team.
		const result = await peerPeekTool.execute({ id: PEER }, ctx({ parentNarratorId: PEER }));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("primary narrator");
	});

	test("refuses a turn with no user identity instead of reporting an empty peer", async () => {
		const result = await peerPeekTool.execute({ id: PEER }, ctx({ userId: null }));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("user session");
	});

	test("refuses a peer the caller cannot read", async () => {
		const result = await peerPeekTool.execute({ id: PEER_PRIVATE }, ctx());
		expect(result.isError).toBe(true);
	});

	test("refuses to peek at itself", async () => {
		const result = await peerPeekTool.execute({ id: SELF }, ctx());
		expect(result.isError).toBe(true);
	});

	test("reports an unreadable peer rather than an empty transcript", async () => {
		const result = await peerPeekTool.execute({ id: PEER }, ctx());
		expect(result.output).toContain("no readable turns");
	});

	test("caps how much of one turn it prints", async () => {
		turns.push({ role: "assistant", contentText: "x".repeat(5000) });
		const result = await peerPeekTool.execute({ id: PEER }, ctx());
		expect(result.output).not.toContain("x".repeat(5000));
		expect(result.output).toContain("…");
	});

	test("honours the limit by showing the newest turns", async () => {
		for (let i = 0; i < 10; i++) {
			turns.push({ role: "user", contentText: `message ${i}` });
		}
		const result = await peerPeekTool.execute({ id: PEER, limit: 2 }, ctx());
		expect(result.output).toContain("message 9");
		expect(result.output).toContain("message 8");
		expect(result.output).not.toContain("message 0");
		expect(result.metadata?.hasMore).toBe(true);
	});

	test("says so when older turns exist beyond the window", async () => {
		for (let i = 0; i < 10; i++) {
			turns.push({ role: "user", contentText: `message ${i}` });
		}
		const result = await peerPeekTool.execute({ id: PEER, limit: 2 }, ctx());
		expect(result.output).toContain("older turns exist");
	});

	test("requires an id", async () => {
		const result = await peerPeekTool.execute({}, ctx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("id is required");
	});

	test("declares itself read-only", () => {
		expect(peerPeekTool.metadata?.readOnly).toBe(true);
	});
});
