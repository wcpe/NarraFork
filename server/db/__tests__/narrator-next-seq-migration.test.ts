/**
 * narrators.next_seq: column shape + the NEW write-path contract.
 *
 * Startup no longer scans every narrator to raise next_seq. After DDL the counter
 * may stay 0 while refs hold historical seqs; the first process-lifetime claim via
 * a choke point (raise floor inside the write tx, mark healed after commit) repairs
 * that narrator only. `applySqliteDataBackfills` must leave next_seq untouched.
 *
 * 手法说明：这里**不再**回放「next_seq 迁移之前」的 journal 前缀 —— 基线重建后
 * `narrators.next_seq` 直接是建表列，journal 里已经没有 `ALTER TABLE narrators ADD next_seq`
 * 可找了（旧写法在这里拿到 -1）。地板的单调提升是**运行期**语义，断言改为指向真实宿主：
 * `services/narrator-refs/seq-store.ts` 的 `raiseSeqFloorForClaim` /
 * `initializeRefSeqFloor` / `claimNextRefSeq`，并用 `withSeqFloorRaiseScope` 按生产里
 * `seq-floor-tx.ts` 的形状把它们包进一个写事务。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	claimNextRefSeq,
	clearNarratorSeqFloorHealed,
	isNarratorSeqFloorHealed,
	raiseSeqFloorForClaim,
	withSeqFloorRaiseScope,
} from "../../services/narrator-refs/seq-store";
import { applySqliteDataBackfills } from "../data-backfills";
import * as relations from "../relations";
import { runMigrations } from "../run-migrations";
import * as schema from "../schema";

/**
 * 与 `server/db/index.ts` 的 `createMainDb` 同形，让测试自持一个内存库的 ORM 句柄。
 * `seq-store` 的写入原语只要求一个 Drizzle 事务句柄，不会去读进程级单例。
 */
const createTestOrm = (client: Database) =>
	drizzle({ client, schema: { ...schema, ...relations } });
type TestOrm = ReturnType<typeof createTestOrm>;

const databases: Database[] = [];

function openDatabase(): Database {
	const database = new Database(":memory:");
	databases.push(database);
	return database;
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

beforeEach(() => {
	// 愈合标记挂在 globalThis 上，进程级生效；测试之间必须清掉。
	clearNarratorSeqFloorHealed();
});

function nextSeqOf(database: Database, narratorId: string): number {
	const row = database
		.query<{ v: number }, [string]>("SELECT next_seq AS v FROM narrators WHERE id = ?")
		.get(narratorId);
	if (!row) throw new Error(`Missing narrator ${narratorId}`);
	return row.v;
}

function insertNarrator(database: Database, id: string): void {
	database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
		id,
		"now",
		"now",
	]);
}

function insertRef(database: Database, narratorId: string, seq: number): void {
	const id = `${narratorId}-${seq}`;
	database.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'user', '[]', 'now')",
		[id, narratorId],
	);
	database.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, ?)",
		[id, narratorId, id, seq],
	);
}

/**
 * 升级完成后的库：计数器还停在 0，而 refs 已经带着历史 seq。
 * 这正是写入路径必须在首次领取时自己抬地板的那个状态。
 */
async function databaseWithSparseRefHistory(): Promise<Database> {
	const database = openDatabase();
	await runMigrations(database);
	for (const id of ["narrator-refs", "narrator-empty", "narrator-gapped", "narrator-zero"]) {
		insertNarrator(database, id);
	}
	for (let seq = 0; seq < 5; seq++) insertRef(database, "narrator-refs", seq);
	insertRef(database, "narrator-gapped", 7);
	insertRef(database, "narrator-zero", 0);
	return database;
}

async function upgrade(database: Database): Promise<void> {
	await runMigrations(database);
	await applySqliteDataBackfills(database);
}

/**
 * 真实写入路径的 choke point：`withSeqFloorRaiseScope`（只在事务成功返回后标记愈合）
 * 包住一个写事务，事务内先 `raiseSeqFloorForClaim` 抬地板、再 `claimNextRefSeq` 做纯计数
 * 领取 —— 与 `narrator-refs/seq-floor-tx.ts` 的 `dbTransactionWithSeqFloor` 同形。返回的是
 * 本次领取到的 seq（即 `claimNextRefSeq` 的 `next_seq - 1`，也就是抬升后的地板）。
 */
function claimThroughChokePoint(orm: TestOrm, narratorId: string): number {
	let claimed = 0;
	withSeqFloorRaiseScope(() =>
		orm.transaction((tx) => {
			raiseSeqFloorForClaim(tx, narratorId);
			claimed = claimNextRefSeq(tx, narratorId);
		}),
	);
	return claimed;
}

describe("narrators.next_seq column (fresh migration replay)", () => {
	test("exists as INTEGER NOT NULL DEFAULT 0 after a full replay", async () => {
		const database = openDatabase();
		await upgrade(database);
		const columns = database
			.query<{ name: string; type: string; notnull: number; dflt_value: string }, []>(
				"PRAGMA table_info(narrators)",
			)
			.all();
		expect(columns.find((row) => row.name === "next_seq")).toMatchObject({
			type: "INTEGER",
			notnull: 1,
			dflt_value: "0",
		});
	});

	test("a narrator created after migration defaults to 0 without naming the column", async () => {
		const database = openDatabase();
		await upgrade(database);
		insertNarrator(database, "narrator-new");
		expect(nextSeqOf(database, "narrator-new")).toBe(0);
	});
});

describe("narrators.next_seq is NOT repaired at startup", () => {
	test("applySqliteDataBackfills leaves next_seq at 0 even when refs have high seqs", async () => {
		const database = await databaseWithSparseRefHistory();
		expect(nextSeqOf(database, "narrator-refs")).toBe(0);
		await applySqliteDataBackfills(database);
		// Startup must not full-scan narrators to raise counters (boot cost).
		expect(nextSeqOf(database, "narrator-refs")).toBe(0);
		expect(nextSeqOf(database, "narrator-gapped")).toBe(0);
		expect(nextSeqOf(database, "narrator-zero")).toBe(0);
	});

	test("first write repairs that narrator only: MAX(refs)+1 then claim", async () => {
		const database = await databaseWithSparseRefHistory();
		const orm = createTestOrm(database);

		expect(claimThroughChokePoint(orm, "narrator-refs")).toBe(5);
		expect(nextSeqOf(database, "narrator-refs")).toBe(6);
		// 愈合标记只落在被领取的这一条上。
		expect(isNarratorSeqFloorHealed("narrator-refs")).toBe(true);
		expect(isNarratorSeqFloorHealed("narrator-gapped")).toBe(false);

		// Untouched siblings stay at 0 — no global scan.
		expect(nextSeqOf(database, "narrator-gapped")).toBe(0);
		expect(claimThroughChokePoint(orm, "narrator-gapped")).toBe(8);
		expect(isNarratorSeqFloorHealed("narrator-gapped")).toBe(true);
		expect(nextSeqOf(database, "narrator-empty")).toBe(0);
		expect(claimThroughChokePoint(orm, "narrator-empty")).toBe(0);
		expect(claimThroughChokePoint(orm, "narrator-zero")).toBe(1);
	});

	test("already-raised counters are not lowered by a later first-write repair", async () => {
		const database = await databaseWithSparseRefHistory();
		const orm = createTestOrm(database);
		database.run("UPDATE narrators SET next_seq = 41 WHERE id = 'narrator-refs'");
		expect(claimThroughChokePoint(orm, "narrator-refs")).toBe(41);
		expect(nextSeqOf(database, "narrator-refs")).toBe(42);
	});

	test("failed first-write transaction rolls back the floor raise (no false repair)", async () => {
		const database = await databaseWithSparseRefHistory();
		const orm = createTestOrm(database);
		expect(() =>
			withSeqFloorRaiseScope(() =>
				orm.transaction((tx) => {
					raiseSeqFloorForClaim(tx, "narrator-refs");
					// 地板在提交前就已经抬到 MAX(refs)+1。
					expect(nextSeqOf(database, "narrator-refs")).toBe(5);
					throw new Error("simulated claim failure");
				}),
			),
		).toThrow("simulated claim failure");
		expect(nextSeqOf(database, "narrator-refs")).toBe(0);
		// 提交后才标记：回滚掉的事务绝不能留下「已修复」的假记录。
		expect(isNarratorSeqFloorHealed("narrator-refs")).toBe(false);
		// A later successful first-write still repairs correctly.
		expect(claimThroughChokePoint(orm, "narrator-refs")).toBe(5);
		expect(nextSeqOf(database, "narrator-refs")).toBe(6);
	});
});

describe("other startup data backfills still run", () => {
	test("legacy status values migrate without touching next_seq", async () => {
		const database = openDatabase();
		await runMigrations(database);
		insertNarrator(database, "n-status");
		database.run("UPDATE narrators SET status = 'done' WHERE id = 'n-status'");
		await applySqliteDataBackfills(database);
		const row = database
			.query<{ status: string; substatus: string }, [string]>(
				"SELECT status, substatus FROM narrators WHERE id = ?",
			)
			.get("n-status");
		expect(row?.status).toBe("idle");
		expect(JSON.parse(row?.substatus ?? "[]")).toContain("unread");
	});
});
