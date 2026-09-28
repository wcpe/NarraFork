/**
 * FTS5 的恢复语义：一次 Drizzle「内容表重建」会重新编号目标表的 rowid，`DROP TABLE` 顺带带走该表上的
 * 同步触发器，而外内容索引（narrators_fts）仍旧指向旧 rowid。`ensureFts` 必须靠「触发器缺失」这一持久
 * 信号探测到它并重建索引，且失效前不得重新装回触发器（否则重试信号消失）。
 *
 * 本文件原先在**模块顶层**`readFileSync` 读取 `drizzle/0170_green_joshua_kane.sql` 来制造这个前置状态。
 * 基线挤压后 `drizzle/` 只剩 `0000_baseline.sql`，该文件已不存在，于是整个文件在加载期抛 ENOENT、
 * 一条测试都不运行（保险丝被无声拔掉）。现在改为两个**真实入口**：
 *   - fixture 用 `ensureFts` 建库（FTS5 虚拟表与触发器本来就不在 `drizzle/` 里，是运行期建立的）；
 *   - 重建用 `applyPendingMigrationsByHash` 执行本地构造的**重建形状**迁移，即生产路径上的同一个迁移
 *     执行器（`sqlite-rebuild-copy.test.ts` 用同样方式驱动同一宿主）。
 * 断言集合未做任何放宽。
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeCleanShutdownState, ensureFts, markCleanShutdown } from "./fts";
import { applyPendingMigrationsByHash } from "./run-migrations";

const breakpoint = "\n--> statement-breakpoint\n";
const tempFolders: string[] = [];

afterEach(() => {
	for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/**
 * Drizzle 生成的内容表重建形状：建 `__new_narrators` → 按列复制 → `DROP TABLE narrators` → `RENAME`。
 * 复制列只列源表真实存在的列，所以 0170 之前才有的 prune_* 遗留列在重建后被丢弃——与新表 rowid 从 1
 * 重新编号一起，构成下面所有断言依赖的前置状态。列表必须与源表列名完全对应，否则迁移执行器会把它当作
 * 不可识别的映射改写而拒绝执行。
 */
const REBUILD_NARRATORS_SQL = [
	`CREATE TABLE __new_narrators (
		id text PRIMARY KEY NOT NULL,
		title text,
		created_at text,
		updated_at text,
		chapter_id text,
		status text
	);`,
	'INSERT INTO __new_narrators("id", "title", "created_at", "updated_at", "chapter_id", "status") SELECT "id", "title", "created_at", "updated_at", "chapter_id", "status" FROM narrators;',
	"DROP TABLE narrators;",
	"ALTER TABLE __new_narrators RENAME TO narrators;",
].join(breakpoint);

/** 走迁移执行器（真实宿主）跑一遍上面的重建，而不是用 sqlite.exec 直接执行裸 SQL。 */
function rebuildNarrators(sqlite: Database): void {
	const folder = mkdtempSync(join(tmpdir(), "narrafork-fts-rebuild-"));
	tempFolders.push(folder);
	mkdirSync(join(folder, "meta"));
	writeFileSync(
		join(folder, "meta", "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "sqlite",
			entries: [
				{
					idx: 0,
					version: "6",
					when: 1_700_000_000_000,
					tag: "0170_rebuild_narrators",
					breakpoints: true,
				},
			],
		}),
	);
	writeFileSync(join(folder, "0170_rebuild_narrators.sql"), REBUILD_NARRATORS_SQL);
	applyPendingMigrationsByHash(sqlite, folder);
}

/** 用真实入口建 FTS，再用重建前才有的遗留列把表还原成「重建之前」的形状。 */
function fixture(): Database {
	const sqlite = new Database(":memory:");
	// 目标表 DDL 直接取自重建迁移本身，保证 fixture 与被重建的表结构始终一致。
	const createStart = REBUILD_NARRATORS_SQL.indexOf("CREATE TABLE");
	const createEnd = REBUILD_NARRATORS_SQL.indexOf(breakpoint, createStart);
	sqlite.exec(
		REBUILD_NARRATORS_SQL.slice(createStart, createEnd).replaceAll("__new_narrators", "narrators"),
	);
	sqlite.exec(`
		PRAGMA foreign_keys=OFF;
		ALTER TABLE narrators ADD COLUMN prune_enabled INTEGER;
		ALTER TABLE narrators ADD COLUMN prune_boundary_message_id TEXT;
		ALTER TABLE narrators ADD COLUMN pruned_percent INTEGER;
		CREATE TABLE narrator_message_refs(id TEXT, pruned_percent INTEGER);
		CREATE TABLE chapters(id TEXT PRIMARY KEY, title TEXT, description TEXT);
		CREATE TABLE narrator_messages(id TEXT PRIMARY KEY, content_text TEXT);
		CREATE TABLE users(id TEXT PRIMARY KEY);
		CREATE TABLE projects(id TEXT PRIMARY KEY);
		CREATE TABLE oauth_grants(id TEXT PRIMARY KEY);
	`);
	ensureFts(sqlite, { wasClean: true });
	sqlite
		.query("INSERT INTO narrators(rowid,id,title,created_at,updated_at) VALUES(?,?,?,?,?)")
		.run(20, "first", "uniqueneedle", "now", "now");
	sqlite
		.query("INSERT INTO narrators(rowid,id,title,created_at,updated_at) VALUES(?,?,?,?,?)")
		.run(40, "second", "anotherneedle", "now", "now");
	return sqlite;
}

function matches(sqlite: Database, query: string): string[] {
	return (
		sqlite
			.query(`
			SELECT n.id FROM narrators n JOIN narrators_fts f ON n.rowid=f.rowid
			WHERE narrators_fts MATCH ? ORDER BY n.id
		`)
			.all(query) as Array<{ id: string }>
	).map((row) => row.id);
}

function checkExternalContent(sqlite: Database): void {
	sqlite.exec("INSERT INTO narrators_fts(narrators_fts,rank) VALUES('integrity-check',1)");
}

describe("FTS recovery after generated content-table migrations", () => {
	for (const wasClean of [true, false]) {
		test(`a content-table rebuild repairs rowid drift on ${wasClean ? "clean" : "unclean"} startup`, () => {
			const sqlite = fixture();
			try {
				if (wasClean) markCleanShutdown(sqlite);
				const state = consumeCleanShutdownState(sqlite);
				expect(state.wasClean).toBe(wasClean);
				rebuildNarrators(sqlite);
				expect(sqlite.query("SELECT rowid FROM narrators WHERE id='first'").get()).toEqual({
					rowid: 1,
				});
				expect(matches(sqlite, "uniqueneedle")).toEqual([]);
				expect(() => checkExternalContent(sqlite)).toThrow();
				const run = spyOn(sqlite, "run");
				try {
					expect(ensureFts(sqlite, state).rebuilt).toBe(true);
					const rebuilds = run.mock.calls.filter(([sql]) => String(sql).includes("('rebuild')"));
					expect(rebuilds.map(([sql]) => sql)).toEqual([
						"INSERT INTO narrators_fts(narrators_fts) VALUES ('rebuild')",
					]);
				} finally {
					run.mockRestore();
				}
				expect(matches(sqlite, "uniqueneedle")).toEqual(["first"]);
				expect(matches(sqlite, "anotherneedle")).toEqual(["second"]);
				expect(() => checkExternalContent(sqlite)).not.toThrow();
				sqlite.exec("UPDATE narrators SET title='changedneedle' WHERE id='first'");
				expect(matches(sqlite, "uniqueneedle")).toEqual([]);
				expect(matches(sqlite, "changedneedle")).toEqual(["first"]);
				sqlite.exec("DELETE FROM narrators WHERE id='second'");
				expect(matches(sqlite, "anotherneedle")).toEqual([]);
				expect(() => checkExternalContent(sqlite)).not.toThrow();
			} finally {
				sqlite.close();
			}
		});
	}

	test("a subsequent healthy clean startup neither probes nor rebuilds content", () => {
		const sqlite = fixture();
		try {
			rebuildNarrators(sqlite);
			ensureFts(sqlite, { wasClean: true });
			markCleanShutdown(sqlite);
			const state = consumeCleanShutdownState(sqlite);
			const run = spyOn(sqlite, "run");
			try {
				expect(ensureFts(sqlite, state).rebuilt).toBe(false);
				expect(run.mock.calls.some(([sql]) => /rebuild|integrity-check/.test(String(sql)))).toBe(
					false,
				);
			} finally {
				run.mockRestore();
			}
		} finally {
			sqlite.close();
		}
	});

	test("failed repair keeps missing triggers as a retry signal", () => {
		const sqlite = fixture();
		try {
			rebuildNarrators(sqlite);
			const originalRun = sqlite.run.bind(sqlite);
			const run = spyOn(sqlite, "run").mockImplementation((...args) => {
				if (String(args[0]).includes("narrators_fts) VALUES ('rebuild')")) {
					throw new Error("simulated rebuild failure");
				}
				return originalRun(...args);
			});
			try {
				expect(() => ensureFts(sqlite, { wasClean: true })).toThrow("simulated rebuild failure");
			} finally {
				run.mockRestore();
			}
			expect(
				sqlite
					.query(
						"SELECT name FROM sqlite_master WHERE type='trigger' AND name='narrators_fts_insert'",
					)
					.get(),
			).toBeNull();
			expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(true);
			expect(matches(sqlite, "uniqueneedle")).toEqual(["first"]);
			expect(() => checkExternalContent(sqlite)).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	test("unclean startup probes external content even when all triggers exist", () => {
		const sqlite = fixture();
		try {
			sqlite.exec("INSERT INTO narrators_fts(narrators_fts) VALUES('delete-all')");
			expect(matches(sqlite, "uniqueneedle")).toEqual([]);
			ensureFts(sqlite, { wasClean: false });
			expect(matches(sqlite, "uniqueneedle")).toEqual(["first"]);
			expect(() => checkExternalContent(sqlite)).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	test("repopulates knowledge draft FTS on clean rowid drift before restoring triggers", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(`
				INSERT INTO knowledge_entries VALUES ('e1', 'Entry one', '', '');
				INSERT INTO knowledge_entries VALUES ('e2', 'Entry two', '', '');
				INSERT INTO knowledge_drafts(rowid, id, entry_id, title, content)
				VALUES (10, 'd1', 'e1', 'Draft one', 'alpha needle');
				INSERT INTO knowledge_drafts(rowid, id, entry_id, title, content)
				VALUES (20, 'd2', 'e2', 'Draft two', 'beta needle');
			`);
			sqlite.exec(`
				DROP TRIGGER knowledge_drafts_fts_insert;
				DROP TRIGGER knowledge_drafts_fts_update;
				DROP TRIGGER knowledge_drafts_fts_delete;
				DROP TRIGGER knowledge_drafts_fts_entry_title;
				CREATE TABLE knowledge_drafts_new (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
				INSERT INTO knowledge_drafts_new SELECT id, entry_id, title, content FROM knowledge_drafts ORDER BY id DESC;
				DROP TABLE knowledge_drafts;
				ALTER TABLE knowledge_drafts_new RENAME TO knowledge_drafts;
			`);
			ensureFts(sqlite, { wasClean: true });
			expect(
				(
					sqlite
						.prepare(
							"SELECT d.id FROM knowledge_drafts d JOIN knowledge_drafts_fts f ON d.rowid=f.rowid WHERE knowledge_drafts_fts MATCH ? ORDER BY d.id",
						)
						.all("alpha") as Array<{ id: string }>
				).map((row) => row.id),
			).toEqual(["d1"]);
			sqlite.run("INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES (?, ?, ?, ?)", [
				"d3",
				"e1",
				"Draft three",
				"gamma needle",
			]);
			expect(
				(
					sqlite
						.prepare("SELECT rowid FROM knowledge_drafts_fts WHERE knowledge_drafts_fts MATCH ?")
						.all("gamma") as Array<{ rowid: number }>
				).length,
			).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	test("repopulates drafts when only the entry-title trigger is missing", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(
				"INSERT INTO knowledge_entries VALUES ('e1', 'Original title', '', ''); INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES ('d1', 'e1', 'Draft title', 'draft body')",
			);
			sqlite.exec(
				"DELETE FROM knowledge_drafts_fts WHERE rowid = (SELECT rowid FROM knowledge_drafts)",
			);
			sqlite.exec("DROP TRIGGER knowledge_drafts_fts_entry_title");
			ensureFts(sqlite, { wasClean: true });
			expect(sqlite.query("SELECT title FROM knowledge_drafts_fts").get()).toEqual({
				title: "Original title",
			});
			sqlite.exec("UPDATE knowledge_entries SET title='Updated title' WHERE id='e1'");
			expect(sqlite.query("SELECT title FROM knowledge_drafts_fts").get()).toEqual({
				title: "Updated title",
			});
		} finally {
			sqlite.close();
		}
	});

	test("failed draft repair keeps the old index and retries while triggers remain missing", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(
				"INSERT INTO knowledge_entries VALUES ('e1', 'Entry one', '', ''); INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES ('d1', 'e1', 'Draft one', 'old needle')",
			);
			sqlite.exec("DROP TRIGGER knowledge_drafts_fts_insert");
			const originalRun = sqlite.run.bind(sqlite);
			const run = spyOn(sqlite, "run").mockImplementation((...args) => {
				if (String(args[0]).includes("INSERT INTO knowledge_drafts_fts(rowid")) {
					throw new Error("simulated draft refill failure");
				}
				return originalRun(...args);
			});
			try {
				expect(() => ensureFts(sqlite, { wasClean: true })).toThrow(
					"simulated draft refill failure",
				);
			} finally {
				run.mockRestore();
			}
			expect(sqlite.query("SELECT content FROM knowledge_drafts_fts").get()).toEqual({
				content: "old needle",
			});
			expect(
				sqlite
					.query(
						"SELECT name FROM sqlite_master WHERE type='trigger' AND name='knowledge_drafts_fts_insert'",
					)
					.get(),
			).toBeNull();
			expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(true);
			expect(sqlite.query("SELECT content FROM knowledge_drafts_fts").get()).toEqual({
				content: "old needle",
			});
		} finally {
			sqlite.close();
		}
	});

	test("a second healthy clean draft startup does not refill the index", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(
				"INSERT INTO knowledge_entries VALUES ('e1', 'Entry one', '', ''); INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES ('d1', 'e1', 'Draft one', 'stable needle')",
			);
			const run = spyOn(sqlite, "run");
			try {
				expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(false);
				expect(
					run.mock.calls.some(([sql]) =>
						/SELECT d\.rowid, COALESCE\(e\.title|rebuild|integrity-check/.test(String(sql)),
					),
				).toBe(false);
			} finally {
				run.mockRestore();
			}
		} finally {
			sqlite.close();
		}
	});
});
