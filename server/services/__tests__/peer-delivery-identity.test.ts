/**
 * peer-delivery-identity.test.ts — what a cross-narrator message must NOT carry.
 *
 * Two defects, both invisible at the call site and both about who a peer
 * message makes the recipient become:
 *
 *  1. The enqueue `userId` is not audit data. `drainAndPersistPendingInjections`
 *     copies it into the recipient's `active._currentUserId`, and from there it
 *     is the identity every tool in that turn resolves ACL against. Passing the
 *     sender's id transplanted the sender's read AND send permissions into the
 *     recipient's workspace, under the recipient's credentials and audit trail —
 *     a cross-user privilege transfer reachable by any two project-visible
 *     narrators. The row keeps `createdBy` for audit; the principal must not
 *     travel with it.
 *
 *  2. The idle-recipient wake ran `resumeSubagent`, which rejects anything that
 *     is not a subagent variant. A peer is a primary, so every cross-narrator
 *     message to an idle peer threw, and the surrounding catch downgraded it to
 *     "queued forever" — the feature would have looked like it silently did
 *     nothing, with no error anywhere.
 *
 * Both are asserted at the enqueue boundary rather than at the outcome, because
 * neither produces a visible failure downstream.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, users } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

/** Every enqueue, in the shape the assertions care about. */
interface EnqueueCall {
	recipientNarratorId: string;
	senderId: string;
	createdBy: string | null | undefined;
	userId: string | null | undefined;
}
const enqueues: EnqueueCall[] = [];
const wakeCalls: string[] = [];

const realInbox = { ...(await import("../agent-runtime/inbox")) };
mock.module("../agent-runtime/inbox", () => ({
	...realInbox,
	enqueueInboxAgent: async (
		delivery: { recipientNarratorId: string; sender: { id: string } },
		_text: string,
		options: { createdBy?: string | null; userId?: string | null } = {},
	) => {
		enqueues.push({
			recipientNarratorId: delivery.recipientNarratorId,
			senderId: delivery.sender.id,
			createdBy: options.createdBy,
			userId: options.userId,
		});
		return { delivery: { state: "queued", recipientMessageId: "msg-1" } };
	},
	// A peer recipient is a primary, so its wake must not go through the subagent
	// resume path. Recording the call is enough: the real function refuses peers.
	wakeInboxIfEligible: async (narratorId: string) => {
		wakeCalls.push(narratorId);
		return true;
	},
}));

let resumeAttempts = 0;
const realSubagentResume = { ...(await import("../subagent-resume")) };
mock.module("../subagent-resume", () => ({
	...realSubagentResume,
	resumeSubagent: async () => {
		resumeAttempts++;
		throw new Error("Target narrator is not a resumable subagent");
	},
}));

const { sendSubagentMessageDetailed } = await import("../agent-communication");

const now = "2026-10-06T00:00:00.000Z";
const SENDER = "peer-delivery-sender";
const PEER = "peer-delivery-target";
const CHILD = "peer-delivery-child";
const OWNER = "peer-delivery-owner";

beforeEach(async () => {
	cleanDb(sqlite);
	enqueues.length = 0;
	wakeCalls.length = 0;
	resumeAttempts = 0;
	await db.insert(users).values({
		id: OWNER,
		username: "peer-delivery-owner",
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
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
	]);
});

afterEach(() => {
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../agent-runtime/inbox", () => realInbox);
	mock.module("../subagent-resume", () => realSubagentResume);
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

const baseSend = {
	toolUseId: "toolu_peer",
	toolCallBinding: { toolCallId: "tc-1", attempt: 1 },
	signal: new AbortController().signal,
	locale: "en",
	userId: OWNER,
};

describe("peer message delivery identity", () => {
	test("does not hand the sender's userId to the recipient session", async () => {
		await sendSubagentMessageDetailed({
			...baseSend,
			callerNarratorId: SENDER,
			id: PEER,
			message: "status?",
		});
		expect(enqueues).toHaveLength(1);
		// The principal is what becomes the recipient's `_currentUserId`.
		expect(enqueues[0].userId).toBeNull();
		// The sender stays attributable for audit.
		expect(enqueues[0].createdBy).toBe(OWNER);
		expect(enqueues[0].senderId).toBe(SENDER);
		expect(enqueues[0].recipientNarratorId).toBe(PEER);
	});

	test("still carries the sender identity for a subagent recipient", async () => {
		// The subagent relationship is same-principal by construction, so the
		// existing attribution must be untouched.
		await sendSubagentMessageDetailed({
			...baseSend,
			callerNarratorId: SENDER,
			id: CHILD,
			message: "do the thing",
		});
		expect(enqueues).toHaveLength(1);
		expect(enqueues[0].userId).toBe(OWNER);
	});

	test("wakes an idle peer without the subagent resume path", async () => {
		await sendSubagentMessageDetailed({
			...baseSend,
			callerNarratorId: SENDER,
			id: PEER,
			message: "status?",
		});
		expect(resumeAttempts).toBe(0);
		expect(wakeCalls).toContain(PEER);
	});

	test("a peer Send reports success rather than degrading to queued", async () => {
		const result = await sendSubagentMessageDetailed({
			...baseSend,
			callerNarratorId: SENDER,
			id: PEER,
			message: "status?",
		});
		expect(result.targets).toHaveLength(1);
		expect(result.targets[0].status).not.toBe("failed");
	});
});
