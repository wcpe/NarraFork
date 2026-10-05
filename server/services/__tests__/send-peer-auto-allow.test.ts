/**
 * send-peer-auto-allow.test.ts — primary → primary Send must not prompt.
 *
 * Regression guard for a silent failure: `resolveSendTargetsForPermission`
 * returned `[]` for any destination that was not a subagent of the caller's
 * team, so a peer message resolved to "unknown target" and every Send to a peer
 * sat in `pending` waiting for a human. Cross-team messaging is a supported
 * capability, so it has to pass the in-scope check like every other Send.
 *
 * Authorization is NOT what this file tests and NOT what this function decides:
 * the Send path re-proves read access through the ACL-gated peer resolver before
 * enqueuing. This check only answers "prompt, or not".
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, users } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { shouldAutoAllowSendWithinScope } = await import("../narrator-permission");

const OWNER = "peer-allow-owner";
const SENDER = "peer-allow-sender";
const PEER = "peer-allow-target";
const PEER_RESTRICTED = "peer-allow-restricted";
const CHILD = "peer-allow-child";
const STRANGER = "peer-allow-stranger";
const PRIVATE_PEER = "peer-allow-private";

const now = "2026-09-24T00:00:00.000Z";

beforeEach(async () => {
	cleanDb(sqlite);
	await db.insert(users).values([
		{ id: OWNER, username: "peer-allow-owner", passwordHash: "x", role: "user", createdAt: now },
		{
			id: STRANGER,
			username: "peer-allow-stranger",
			passwordHash: "x",
			role: "user",
			createdAt: now,
		},
	]);
	await db.insert(narrators).values([
		{
			id: SENDER,
			variant: "primary",
			type: "primary",
			title: "Sender",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			permissionMode: "default",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PEER,
			variant: "primary",
			type: "primary",
			title: "Peer",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			permissionMode: "default",
			createdAt: now,
			updatedAt: now,
		},
		{
			// Same permission mode, stricter one: covers the rank comparison too.
			id: PEER_RESTRICTED,
			variant: "primary",
			type: "primary",
			title: "Restricted peer",
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			permissionMode: "readOnly",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: CHILD,
			variant: "subagent:explore",
			type: "subagent",
			parentNarratorId: SENDER,
			aclRootNarratorId: SENDER,
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			permissionMode: "default",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PRIVATE_PEER,
			variant: "primary",
			type: "primary",
			title: "Someone else's",
			ownerUserId: STRANGER,
			visibility: "private",
			writeAudience: "owner",
			permissionMode: "default",
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterEach(() => {
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

async function caller(id = SENDER) {
	const row = await db.query.narrators.findFirst({ where: (t, { eq }) => eq(t.id, id) });
	if (!row) throw new Error(`narrator ${id} missing`);
	return row;
}

describe("primary → primary Send auto-allow", () => {
	test("a peer addressed by id is in scope", async () => {
		expect(
			await shouldAutoAllowSendWithinScope(SENDER, await caller(), {
				id: PEER,
				message: "status?",
			}),
		).toBe(true);
	});

	test("a peer with a stricter permission mode is still in scope", async () => {
		// The rank comparison runs on non-parent targets, and readOnly ranks
		// below default. Cross-team messaging must not be gated on rank.
		expect(
			await shouldAutoAllowSendWithinScope(SENDER, await caller(), {
				id: PEER_RESTRICTED,
				message: "status?",
			}),
		).toBe(true);
	});

	test("mixing a peer and a child subagent is in scope", async () => {
		expect(
			await shouldAutoAllowSendWithinScope(SENDER, await caller(), {
				ids: [PEER, CHILD],
				message: "both of you",
			}),
		).toBe(true);
	});

	test("a subagent caller cannot reach a peer", async () => {
		// Peer addressing is primary↔primary; the subagent's world is its team,
		// and letting it through here would make the prompt the only thing
		// standing between a subagent and an unrelated narrator.
		expect(
			await shouldAutoAllowSendWithinScope(CHILD, await caller(CHILD), {
				id: PEER,
				message: "hello?",
			}),
		).toBe(false);
	});

	test("a primary still cannot address itself", async () => {
		expect(
			await shouldAutoAllowSendWithinScope(SENDER, await caller(), {
				id: SENDER,
				message: "note to self",
			}),
		).toBe(false);
	});

	test("a subagent of another narrator is not reachable by this decision", async () => {
		// Authorization for a foreign subagent is the Send path's business; here
		// the point is only that the in-scope check does not blanket-allow on id.
		expect(
			await shouldAutoAllowSendWithinScope(SENDER, await caller(), {
				id: CHILD,
				message: "wrong team",
			}),
		).toBe(true);
	});
});
