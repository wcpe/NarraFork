/**
 * Drizzle 的 SQLite 表重建（`CREATE __new_x` → `INSERT … SELECT` → `DROP TABLE x` →
 * `RENAME __new_x TO x`）在本仓库是由迁移执行器改写的：
 * `run-migrations.ts` 的 `applyPendingMigrationsByHash`（含 `rewriteQualifiedNewTableChecks`
 * 剥离 CHECK 里指向 `__new_x` 的表限定名、以及复制列的映射校验）。本文件就是这套改写的
 * 宿主级测试，绝大多数条目用本地构造的迁移 SQL 驱动它。
 *
 * 原本还有两条「回放真实 0153」的条目（连同 0044/0146/0147 一起），但它们读取的历史迁移
 * 文件已随基线重建消失（现在 `drizzle/` 只剩 `0000_baseline.sql`），不可能复现。它们各自
 * 独有的断言已改为本地 SQL 驱动同一宿主：重建后外键动作仍然生效 + 同一条迁移不会被重放；
 * CHECK 限定名被剥离后约束仍然拦得住违规行 + 调用方的 `legacy_alter_table` 被还原。
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingMigrationsByHash } from "./run-migrations";

const databases: Database[] = [];
const tempFolders: string[] = [];
const breakpoint = "\n--> statement-breakpoint\n";

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function database(foreignKeys = true): Database {
	const db = new Database(":memory:");
	databases.push(db);
	db.run(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
	return db;
}

function migrationsWith(sql: string, tag = "0000_rebuild_copy"): string {
	const folder = mkdtempSync(join(tmpdir(), "narrafork-rebuild-copy-"));
	tempFolders.push(folder);
	mkdirSync(join(folder, "meta"));
	writeFileSync(
		join(folder, "meta", "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "sqlite",
			entries: [{ idx: 0, version: "6", when: 1_700_000_000_000, tag, breakpoints: true }],
		}),
	);
	writeFileSync(join(folder, `${tag}.sql`), sql);
	return folder;
}

function createLegacyX(db: Database, hasRows = true): void {
	db.run("CREATE TABLE x (id text PRIMARY KEY NOT NULL, payload text)");
	if (hasRows) db.run("INSERT INTO x VALUES ('row-1', 'keep-me'), ('row-2', NULL)");
}

function rebuildX(columnSql: string, copySql: string): string {
	return [
		// Prove that failure rolls back statements before the copy as well as the scratch table.
		"CREATE TABLE migration_side_effect (id text);",
		`CREATE TABLE __new_x (id text PRIMARY KEY NOT NULL, payload text${columnSql});`,
		copySql,
		"DROP TABLE x;",
		"ALTER TABLE __new_x RENAME TO x;",
	].join(breakpoint);
}

function expectRollback(db: Database, folder: string, error: RegExp): void {
	const rows = db.query("SELECT * FROM x ORDER BY id").all();
	const schema = db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get();
	const fkState = db.query("PRAGMA foreign_keys").get();
	expect(() => applyPendingMigrationsByHash(db, folder)).toThrow(error);
	expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual(rows);
	expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get()).toEqual(schema);
	expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toEqual([]);
	expect(
		db
			.query("SELECT name FROM sqlite_master WHERE name IN ('__new_x', 'migration_side_effect')")
			.all(),
	).toEqual([]);
	expect(db.query("PRAGMA foreign_keys").get()).toEqual(fkState);
}

describe("canonical Drizzle rebuild-copy compatibility", () => {
	test("a rebuilt table keeps its ON DELETE SET NULL action, NULLs new columns and is never replayed twice", () => {
		const db = database();
		db.run("CREATE TABLE users (id text PRIMARY KEY NOT NULL)");
		db.run(`CREATE TABLE attributions (
			id text PRIMARY KEY NOT NULL,
			user_id text,
			payload text,
			FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE set null
		)`);
		db.run("INSERT INTO users VALUES ('user-1'), ('user-2')");
		db.run(
			"INSERT INTO attributions VALUES ('attr-1', 'user-1', 'keep-me'), ('attr-2', 'user-2', NULL)",
		);
		// Fresh statements across DDL: Bun's query() cache can retain SELECT * result column names.
		const oldRows = db.prepare("SELECT * FROM attributions ORDER BY id").all() as Array<
			Record<string, string | number | null>
		>;
		const sql = [
			`CREATE TABLE __new_attributions (
				id text PRIMARY KEY NOT NULL,
				user_id text,
				payload text,
				lines_added integer,
				FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE set null
			);`,
			'INSERT INTO __new_attributions("id", "user_id", "payload") SELECT "id", "user_id", "payload" FROM attributions;',
			"DROP TABLE attributions;",
			"ALTER TABLE __new_attributions RENAME TO attributions;",
		].join(breakpoint);
		const folder = migrationsWith(sql, "0153_synthetic_attribution_rebuild");
		applyPendingMigrationsByHash(db, folder);

		expect(db.query("PRAGMA table_info(attributions)").all()).toHaveLength(4);
		expect(db.prepare("SELECT * FROM attributions ORDER BY id").all()).toEqual(
			oldRows.map((row) => ({ ...row, lines_added: null })),
		);
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(db.query("PRAGMA foreign_key_check(attributions)").all()).toEqual([]);
		expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toEqual([
			{ hash: createHash("sha256").update(sql).digest("hex") },
		]);
		// 第二次应用：hash 已记录 → 必须整体跳过。重建型迁移被重放会 DROP 掉真实数据。
		applyPendingMigrationsByHash(db, folder);
		expect(db.prepare("SELECT * FROM attributions ORDER BY id").all()).toEqual(
			oldRows.map((row) => ({ ...row, lines_added: null })),
		);
		// 重建最容易打断的就是这条外键动作：删用户必须把归属置空，不能删行也不能报错。
		db.run("DELETE FROM users WHERE id = 'user-1'");
		expect(db.query("SELECT id, user_id FROM attributions ORDER BY id").all()).toEqual([
			{ id: "attr-1", user_id: null },
			{ id: "attr-2", user_id: "user-2" },
		]);
		db.run("DELETE FROM users WHERE id = 'user-2'");
		expect(db.prepare("SELECT * FROM attributions ORDER BY id").all()).toEqual(
			oldRows.map((row) => ({ ...row, lines_added: null, user_id: null })),
		);
	});

	test("a rebuilt table's CHECK survives the rename, still enforces, and legacy_alter_table is restored", () => {
		const db = database();
		db.run("PRAGMA legacy_alter_table = ON");
		createLegacyX(db);
		const sql = [
			`CREATE TABLE __new_x (
				id text PRIMARY KEY NOT NULL,
				payload text,
				added integer,
				CONSTRAINT ck_own CHECK("__new_x"."added" IS NULL OR "__new_x"."added" >= 0)
			);`,
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", "added" FROM x;',
			"DROP TABLE x;",
			"ALTER TABLE __new_x RENAME TO x;",
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));

		const created = db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get() as {
			sql: string;
		};
		expect(created.sql).not.toMatch(/"__new_x"\s*\.\s*"added"/);
		expect(created.sql).toContain("ck_own");
		// 约束不能只是文本残留：重命名之后它必须仍然拦得住违规行。
		expect(() => db.run("INSERT INTO x (id, payload, added) VALUES ('row-bad', 'p', -1)")).toThrow(
			/ck_own|CHECK constraint/i,
		);
		expect(db.query("SELECT id, added FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", added: null },
			{ id: "row-2", added: null },
		]);
		// 引擎必须把调用方的 pragma 还原，否则后续迁移的 ALTER TABLE 语义会被悄悄改掉。
		expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 1 });
	});

	test("strips this __new_ table's CHECK qualifier without rewriting the same text inside a string", () => {
		const db = database();
		db.run("PRAGMA legacy_alter_table = ON");
		createLegacyX(db);
		const sql = [
			`CREATE TABLE __new_x (
				id text PRIMARY KEY NOT NULL,
				payload text,
				added text,
				CONSTRAINT ck_own CHECK("__new_x"."added" IS NULL OR "__new_x"."added" <> 'no'),
				CONSTRAINT ck_literal CHECK(payload IS NULL OR payload <> '__new_x.payload / other_table.payload')
			);`,
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", "added" FROM x;',
			"DROP TABLE x;",
			"ALTER TABLE __new_x RENAME TO x;",
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		const created = db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get() as {
			sql: string;
		};
		expect(created.sql).not.toMatch(/"__new_x"\s*\.\s*"added"/);
		expect(created.sql).toContain("__new_x.payload / other_table.payload");
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", added: null },
			{ id: "row-2", payload: null, added: null },
		]);
	});

	test("rewrites IF NOT EXISTS rebuild CHECKs the same way", () => {
		const db = database();
		db.run("PRAGMA legacy_alter_table = ON");
		createLegacyX(db);
		const sql = [
			`CREATE TABLE IF NOT EXISTS __new_x (
				id text PRIMARY KEY NOT NULL,
				payload text,
				added text,
				CONSTRAINT ck_own CHECK("__new_x"."added" IS NULL OR "__new_x"."added" <> 'no')
			);`,
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", "added" FROM x;',
			"DROP TABLE x;",
			"ALTER TABLE __new_x RENAME TO x;",
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		const created = db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get() as {
			sql: string;
		};
		expect(created.sql).not.toMatch(/"__new_x"\s*\.\s*"added"/);
		expect(created.sql).toContain("ck_own");
		expect(db.query("SELECT id FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1" },
			{ id: "row-2" },
		]);
	});

	test("omits new columns so text, numeric and expression defaults apply to every copied row", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", label text NOT NULL DEFAULT 'ready', amount integer NOT NULL DEFAULT 7, computed text DEFAULT (upper('ok'))",
			'INSERT INTO __new_x("id", "payload", "label", "amount", "computed") SELECT "id", "payload", "label", "amount", "computed" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", label: "ready", amount: 7, computed: "OK" },
			{ id: "row-2", payload: null, label: "ready", amount: 7, computed: "OK" },
		]);
	});

	test("permits a new required column without a default when the source is empty", () => {
		const db = database();
		createLegacyX(db, false);
		const sql = rebuildX(
			", required text NOT NULL",
			'INSERT INTO __new_x("id", "payload", "required") SELECT "id", "payload", "required" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x").all()).toEqual([]);
		expect(db.query("PRAGMA table_info(x)").all()).toContainEqual(
			expect.objectContaining({ name: "required", notnull: 1, dflt_value: null }),
		);
	});

	for (const foreignKeys of [true, false]) {
		test(`refuses missing required data and restores foreign_keys=${foreignKeys}`, () => {
			const db = database(foreignKeys);
			createLegacyX(db);
			const sql = rebuildX(
				", required text NOT NULL",
				'INSERT INTO __new_x("id", "payload", "required") SELECT "id", "payload", "required" FROM x;',
			);
			expectRollback(db, migrationsWith(sql), /required.*default/i);
		});
	}

	test("keeps existing source values and explicit renames while omitting only the new column", () => {
		const db = database();
		createLegacyX(db);
		db.run("ALTER TABLE x ADD label text");
		db.run("UPDATE x SET label = 'already-stored' WHERE id = 'row-1'");
		const sql = [
			"CREATE TABLE __new_x (id text PRIMARY KEY NOT NULL, renamed text, label text DEFAULT 'wrong', added text);",
			'INSERT INTO __new_x("id", "renamed", "label", "added") SELECT "id", "payload", "label", "added" FROM x;',
			"DROP TABLE x;",
			"ALTER TABLE __new_x RENAME TO x;",
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", renamed: "keep-me", label: "already-stored", added: null },
			{ id: "row-2", renamed: null, label: null, added: null },
		]);
	});

	test("refuses a missing source column with a different target mapping instead of copying a DQS literal", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "missing_payload", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("never suppresses a mapping error whose column name contains an already-exists phrase", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "already exists", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("refuses a copy from a different existing table rather than replacing the original rows", () => {
		const db = database();
		createLegacyX(db);
		db.run("CREATE TABLE another_source (id text, payload text)");
		db.run("INSERT INTO another_source VALUES ('wrong-id', 'wrong-payload')");
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", "added" FROM another_source;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("lets SQLite reject an unusable explicit NULL default without dropping original data", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", required text NOT NULL DEFAULT NULL",
			'INSERT INTO __new_x("id", "payload", "required") SELECT "id", "payload", "required" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /NOT NULL constraint/i);
	});

	test("never tolerates a repaired-copy constraint error as an already-existing object", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			', "already exists" text NOT NULL DEFAULT NULL',
			'INSERT INTO __new_x("id", "payload", "already exists") SELECT "id", "payload", "already exists" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /NOT NULL constraint/i);
	});

	test("allows an empty copy with no remaining source-backed columns", () => {
		const db = database();
		createLegacyX(db, false);
		const sql = rebuildX(
			", added text NOT NULL",
			'INSERT INTO __new_x("added") SELECT "added" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x").all()).toEqual([]);
		expect(db.query("PRAGMA table_info(x)").all()).toContainEqual(
			expect.objectContaining({ name: "added", notnull: 1 }),
		);
	});

	test("refuses to invent rows when no source-backed column remains", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(", added text", 'INSERT INTO __new_x("added") SELECT "added" FROM x;');
		expectRollback(db, migrationsWith(sql), /no source-backed column mapping/i);
	});

	test("refuses an unknown destination column rather than suppressing SQLite column errors", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			"",
			'INSERT INTO __new_x("id", "payload", "missing") SELECT "id", "payload", "missing" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /column|mapping/i);
	});

	test("rolls back a missing source table without running later DROP statements", () => {
		const db = database();
		createLegacyX(db);
		const sql = [
			"CREATE TABLE __new_missing_source (id text, added text);",
			'INSERT INTO __new_missing_source("id", "added") SELECT "id", "added" FROM missing_source;',
			"DROP TABLE x;",
		].join(breakpoint);
		expectRollback(db, migrationsWith(sql), /no such table|missing source table/i);
		expect(
			db.query("SELECT name FROM sqlite_master WHERE name = '__new_missing_source'").get(),
		).toBeNull();
	});

	test("rejects mismatched list lengths instead of inventing column mappings", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping|values.*columns/i);
	});

	test("rejects duplicate destination mappings even when SQLite would silently ignore one", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "payload", "added") SELECT "id", "payload", "payload", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("does not rewrite complex expressions, aliases or clauses", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			`INSERT INTO __new_x("id", "payload", "added") SELECT "id", upper("payload"), 'explicit' AS added FROM x WHERE id = 'row-1';`,
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x").all()).toEqual([
			{ id: "row-1", payload: "KEEP-ME", added: "explicit" },
		]);
	});

	test("does not guess a missing identifier inside a complex expression", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", upper(`added`) FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /no such column/i);
	});

	test("does not treat unquoted SQL constants as missing source identifiers", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text DEFAULT 'wrong', flag integer DEFAULT 0",
			'INSERT INTO __new_x("id", "payload", "added", "flag") SELECT "id", "payload", NULL, TRUE FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", added: null, flag: 1 },
			{ id: "row-2", payload: null, added: null, flag: 1 },
		]);
	});

	test("does not mistake a different Unicode case for an existing SQLite identifier", () => {
		const db = database();
		createLegacyX(db);
		db.run('ALTER TABLE x ADD "Ä" text');
		db.run(`UPDATE x SET "Ä" = 'keep-unicode'`);
		const sql = rebuildX(
			', "Ä" text, "ä" text',
			'INSERT INTO __new_x("id", "payload", "Ä", "ä") SELECT "id", "payload", "Ä", "ä" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", Ä: "keep-unicode", ä: null },
			{ id: "row-2", payload: null, Ä: "keep-unicode", ä: null },
		]);
	});

	test("preserves non-rebuild INSERT SELECT statements verbatim", () => {
		const db = database();
		createLegacyX(db);
		const sql = [
			"CREATE TABLE archive (id text, label text);",
			'INSERT INTO archive("id", "label") SELECT "id", "literal_label" FROM x;',
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM archive ORDER BY id").all()).toEqual([
			{ id: "row-1", label: "literal_label" },
			{ id: "row-2", label: "literal_label" },
		]);
	});

	test("handles quoted commas and escaped quotes as identifiers, not list separators", () => {
		const db = database();
		db.run('CREATE TABLE "Odd,table" ("ID" text, "pay""load" text)');
		db.run(`INSERT INTO "Odd,table" VALUES ('row-1', 'keep-me')`);
		const sql = [
			'CREATE TABLE "__new_Odd,table" ("ID" text, "pay""load" text, "new,col" text);',
			'INSERT INTO "__new_Odd,table"("id", "pay""load", "new,col") SELECT "id", "pay""load", "new,col" FROM "Odd,table";',
			'DROP TABLE "Odd,table";',
			'ALTER TABLE "__new_Odd,table" RENAME TO "Odd,table";',
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query('SELECT * FROM "Odd,table"').all()).toEqual([
			{ ID: "row-1", 'pay"load': "keep-me", "new,col": null },
		]);
	});

	for (const quote of [
		(name: string) => name,
		(name: string) => `[${name}]`,
		(name: string) => `\`${name}\``,
	]) {
		test(`accepts canonical identifiers quoted as ${quote("column")}`, () => {
			const db = database();
			createLegacyX(db);
			const columns = ["id", "payload", "added"].map(quote).join(", ");
			const sql = rebuildX(
				", added text",
				`INSERT INTO ${quote("__new_x")}(${columns}) SELECT ${columns} FROM ${quote("x")};`,
			);
			applyPendingMigrationsByHash(db, migrationsWith(sql));
			expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
				{ id: "row-1", payload: "keep-me", added: null },
				{ id: "row-2", payload: null, added: null },
			]);
		});
	}
});
