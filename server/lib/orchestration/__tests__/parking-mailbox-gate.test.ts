/**
 * 停放的前置检查：与唤醒判定**同源**。
 *
 * 归档（= 停放）会让这个 worker 彻底收不到消息：`wakeInboxIfEligible` 见到
 * `status = archived` 直接返回 false，Send 也会被拒（"Target subagent is archived"）。
 * 因此停放判定问的必须与唤醒判定是同一个问题——否则两侧判断的缝隙就是一条
 * **永久搁浅**的消息，而发送方被告知的是"已排队"。
 *
 * 本文件要证明的正是"问的是同一个问题"，所以：
 * - 共用谓词用一层**计数**替身包住真实实现（判定本身照旧由真实实现给出），
 *   从停放侧与唤醒侧各调一次，断言两边命中的是同一个函数——各写一套查询的话，
 *   计数会是 0，这条断言立刻变红；
 * - kind 清单不靠文本比对，而是拿 `WAKEABLE_INBOX_KINDS` 逐个种类验证谓词的判定，
 *   把"常量"与"行为"钉在一起。
 *
 * 替身只有两处，都与本题无关：
 * - `@server/services/subagent-resume`：本文件考察的是"要不要醒来"这个判定，
 *   真跑一轮 agent loop 需要模型与网络；这里让它如实抛错（真实情况下没有 origin
 *   关联的 worker 也是被它直接拒掉的）；
 * - `@server/services/agent-runtime/publication`：测试库缺
 *   `runtime_publication_outbox`（该表只在 `server/db/schema.ts` 里，`drizzle/`
 *   没有对应迁移；既存缺陷），而唤醒入口第一步就要过这个投递屏障。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { narratorBufferedMessages, narrators } from "../../../db/schema";

const { db, sqlite } = getTestDb();
mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

// 替身 1：唤醒入口的第一步是投递屏障（见文件头注释）。只把 facade 的「有没有东西要
// 投递」换成 0，其余（含 `setWake` 这类模块加载时的接线）保持真实。
const realPublication = { ...(await import("@server/services/agent-runtime/publication")) };
mock.module("@server/services/agent-runtime/publication", () => ({
	...realPublication,
	flushRuntimePublications: () => 0,
}));

// 替身 2：本文件绝不真跑一轮续跑。
mock.module("@server/services/subagent-resume", () => ({
	resumeSubagent: async () => {
		throw new Error("Mailbox-gate test must never resume a subagent");
	},
}));

// 替身 3：给共用谓词加一层计数。**判定照旧走真实实现**——本文件要证明的正是
// "停放与唤醒调用同一个函数"，用桩把判定换掉就等于把要测的东西测没了。
const realInbox = { ...(await import("@server/services/agent-runtime/inbox")) };
const wakeWorkCalls: string[] = [];
mock.module("@server/services/agent-runtime/inbox", () => ({
	...realInbox,
	hasWakeableInboxWork: async (narratorId: string) => {
		wakeWorkCalls.push(narratorId);
		return await realInbox.hasWakeableInboxWork(narratorId);
	},
}));

const parking = await import("../parking");
const inbox = await import("@server/services/agent-runtime/inbox");

const PROFILE_ID = "of7k2m9q";
const PARENT_ID = "parent-orch-mailbox";
const WORKER_ID = "orch-mailbox-worker";
const QUICK_TYPE = `orch--${PROFILE_ID}--quick`;
const STAMP = "2026-01-01T00:00:00.000Z";

/** `narrators.parent_narrator_id` 有外键，插入子行前先有父行。 */
async function insertParent(): Promise<void> {
	await db
		.insert(narrators)
		.values({
			id: PARENT_ID,
			type: "primary",
			variant: "primary",
			status: "idle",
			createdAt: STAMP,
			updatedAt: STAMP,
		})
		.onConflictDoNothing();
}

/** 一个已跑完、空闲的编排 worker（状态是停放判定的其余条件都满足的那一刻）。 */
async function insertIdleWorker(): Promise<void> {
	await insertParent();
	await db.insert(narrators).values({
		id: WORKER_ID,
		type: "subagent",
		variant: `subagent:${QUICK_TYPE}`,
		subagentType: QUICK_TYPE,
		parentNarratorId: PARENT_ID,
		status: "idle",
		isBackground: false,
		model: "provA:worker",
		createdAt: STAMP,
		updatedAt: STAMP,
	});
}

let mailboxSeq = 0;
/** 往 worker 的 mailbox 里塞一条 `queued` 消息，kind 可选三种之一。 */
async function queueMessage(input: {
	kind: "user_input" | "agent_message" | "task_notice";
	eventKind?: string;
}): Promise<void> {
	mailboxSeq += 1;
	await db.insert(narratorBufferedMessages).values({
		id: `mailbox-${mailboxSeq}`,
		narratorId: WORKER_ID,
		text: "queued",
		seq: mailboxSeq,
		arrivalSeq: mailboxSeq,
		bufferedAt: STAMP,
		kind: input.kind,
		state: "queued",
		metadataJson: input.eventKind ? JSON.stringify({ eventKind: input.eventKind }) : null,
		sourceNarratorId: "sender-narrator",
	});
}

async function statusOf(id: string): Promise<string | undefined> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { status: true },
	});
	return row?.status;
}

function inspect() {
	return parking.parkCompletedOrchestrationWorker({
		narratorId: WORKER_ID,
		parentNarratorId: PARENT_ID,
	});
}

beforeEach(() => {
	parking.__resetParkingRegistryForTests();
	wakeWorkCalls.length = 0;
	mailboxSeq = 0;
});

afterEach(() => {
	parking.__resetParkingRegistryForTests();
	cleanDb(sqlite);
});

afterAll(() => {
	// 替身不用还原：`--isolate` 下每个测试文件一份模块注册表，它们不会外溢。
	mock.restore();
});

describe("停放前置检查与唤醒判定同源（B3）", () => {
	test("mailbox 里只有 Send 进来的 agent_message 时不停放（那条消息不会被搁浅）", async () => {
		await insertIdleWorker();
		await queueMessage({ kind: "agent_message" });

		// 唤醒侧认它——所以停放侧也必须认，否则归档之后它再也送不进来。
		expect(await inbox.hasWakeableInboxWork(WORKER_ID)).toBe(true);
		expect(await inspect()).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("mailbox 里只有 user_input 时不停放", async () => {
		await insertIdleWorker();
		await queueMessage({ kind: "user_input" });

		expect(await inbox.hasWakeableInboxWork(WORKER_ID)).toBe(true);
		expect(await inspect()).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("两种都没有（mailbox 空）时才停放", async () => {
		await insertIdleWorker();

		expect(await inbox.hasWakeableInboxWork(WORKER_ID)).toBe(false);
		expect(await inspect()).toBe(true);
		expect(await statusOf(WORKER_ID)).toBe("archived");
	});

	test("可行动的任务通知也算排队（两侧同样口径），纯播报的不算", async () => {
		await insertIdleWorker();
		// `started` / `cancelled` 是播报，没有可执行内容，为它们唤醒一轮只会白烧一次调用。
		await queueMessage({ kind: "task_notice", eventKind: "started" });
		expect(await inbox.hasWakeableInboxWork(WORKER_ID)).toBe(false);
		expect(await inspect()).toBe(true);

		// 换一条可行动的：归档会把它一起吞掉，所以必须不放行。
		cleanDb(sqlite);
		wakeWorkCalls.length = 0;
		await insertIdleWorker();
		await queueMessage({ kind: "task_notice", eventKind: "completed" });
		expect(await inbox.hasWakeableInboxWork(WORKER_ID)).toBe(true);
		expect(await inspect()).toBe(false);
		expect(await statusOf(WORKER_ID)).toBe("idle");
	});

	test("停放判定与唤醒判定调用的是**同一个共用谓词**，不是各写一套 kind 清单", async () => {
		await insertIdleWorker();
		await queueMessage({ kind: "agent_message" });
		wakeWorkCalls.length = 0;

		// 停放侧：走的是 `parkCompletedOrchestrationWorker` 的真实判定路径。
		expect(await inspect()).toBe(false);
		expect(wakeWorkCalls).toEqual([WORKER_ID]);

		// 唤醒侧：同一个 worker、同一个队列。
		await inbox.wakeInboxIfEligible(WORKER_ID);
		expect(wakeWorkCalls).toEqual([WORKER_ID, WORKER_ID]);
	});

	test("kind 清单由 WAKEABLE_INBOX_KINDS 决定：清单里的每一种都算排队", async () => {
		// 逐个种类验证，把常量与行为钉在一起（不比对源码文本）。
		expect([...inbox.WAKEABLE_INBOX_KINDS]).toEqual(["user_input", "agent_message"]);
		for (const kind of inbox.WAKEABLE_INBOX_KINDS) {
			cleanDb(sqlite);
			wakeWorkCalls.length = 0;
			await insertIdleWorker();
			await queueMessage({ kind });
			expect(await inbox.hasWakeableInboxWork(WORKER_ID)).toBe(true);
			expect(await inspect()).toBe(false);
		}
	});

	test("已读走的消息不算排队：队列里没有 queued 行时照旧停放", async () => {
		await insertIdleWorker();
		mailboxSeq += 1;
		await db.insert(narratorBufferedMessages).values({
			id: "mailbox-claimed",
			narratorId: WORKER_ID,
			text: "already taken",
			seq: mailboxSeq,
			arrivalSeq: mailboxSeq,
			bufferedAt: STAMP,
			kind: "agent_message",
			state: "materialized",
			sourceNarratorId: "sender-narrator",
		});

		expect(await inbox.hasWakeableInboxWork(WORKER_ID)).toBe(false);
		expect(await inspect()).toBe(true);
	});
});
