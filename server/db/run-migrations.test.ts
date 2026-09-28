import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPendingMigrationsByHash,
	backfillFastModeOverride,
	backfillNarratorVisibility,
	repairMissingSpecTables,
	runMigrations,
	SpecSchemaDriftError,
} from "./run-migrations";

let sqlite: Database | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

/**
 * A database that already advanced past migration 0058 (so Drizzle will not re-run it)
 * but is missing the Living Work Spec tables. Includes the parent tables the Spec
 * foreign keys reference so structurally-complete Spec tables can be created.
 */
function createPostMigrationLegacyDatabase(): Database {
	const database = new Database(":memory:");
	database.run("PRAGMA foreign_keys = ON");
	database.run("CREATE TABLE narrators (id text PRIMARY KEY NOT NULL)");
	database.run("CREATE TABLE narrator_messages (id text PRIMARY KEY NOT NULL)");
	database.run(`
		CREATE TABLE __drizzle_migrations (
			id integer PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`);
	// This timestamp is newer than migration 0058, reproducing an installation
	// where Drizzle skips that historical migration even though its Spec tables are absent.
	database.run(
		"INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('legacy', 1783303131388)",
	);
	return database;
}

/**
 * Structurally-complete `spec_namespaces` matching migration 0058 exactly (columns,
 * primary key, and both foreign keys with their ON DELETE actions). Used to model a
 * database whose Spec schema was only partially created — this table is valid but the
 * other three tables are still missing.
 */
function createCompleteSpecNamespaces(database: Database): void {
	database.run(`
		CREATE TABLE spec_namespaces (
			id text PRIMARY KEY NOT NULL,
			narrator_id text NOT NULL,
			forked_from_namespace_id text,
			created_at text NOT NULL,
			updated_at text NOT NULL,
			FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
			FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
		)
	`);
	database.run("CREATE UNIQUE INDEX idx_spec_namespaces_narrator ON spec_namespaces (narrator_id)");
	database.run(
		"CREATE INDEX idx_spec_namespaces_forked_from ON spec_namespaces (forked_from_namespace_id)",
	);
}

function indexExists(database: Database, name: string): boolean {
	return (
		database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !==
		null
	);
}

describe("Living Work Spec migration repair", () => {
	test("creates the missing Spec table group after migration history already advanced", () => {
		sqlite = createPostMigrationLegacyDatabase();

		expect(repairMissingSpecTables(sqlite)).toBe(true);

		const tables = sqlite
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'spec_%'
				 ORDER BY name`,
			)
			.all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name)).toEqual([
			"spec_file_revisions",
			"spec_namespace_files",
			"spec_namespaces",
			"spec_protected_tasks",
		]);

		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);
		sqlite.run(
			`INSERT INTO spec_file_revisions
			 (id, namespace_id, path, content, content_hash, created_at)
			 VALUES ('revision-1', 'namespace-1', 'tasks.json', '{}', 'hash', 'now')`,
		);
		sqlite.run(
			`INSERT INTO spec_namespace_files
			 (id, namespace_id, path, revision_id, updated_at)
			 VALUES ('file-1', 'namespace-1', 'tasks.json', 'revision-1', 'now')`,
		);

		expect(repairMissingSpecTables(sqlite)).toBe(false);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_namespace_files").get() as {
					count: number;
				}
			).count,
		).toBe(1);
	});

	test("completes a partially-created Spec schema without deleting existing rows", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_namespaces").get() as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(
			sqlite
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_protected_tasks'",
				)
				.get(),
		).toBeTruthy();
	});

	test("re-creates missing indexes even when all four Spec table names exist", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);

		// Simulate a database whose tables exist but lost an index (e.g. created by an
		// older repair that only built tables). The repair must NOT short-circuit just
		// because the four table names are present.
		sqlite.run("DROP INDEX idx_spec_file_revisions_parent");
		sqlite.run("DROP INDEX idx_spec_protected_tasks_namespace_status");
		expect(indexExists(sqlite, "idx_spec_file_revisions_parent")).toBe(false);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(indexExists(sqlite, "idx_spec_file_revisions_parent")).toBe(true);
		expect(indexExists(sqlite, "idx_spec_protected_tasks_namespace_status")).toBe(true);

		// Fully complete again — nothing left to repair.
		expect(repairMissingSpecTables(sqlite)).toBe(false);
	});

	test("refuses to silently accept an extra unique index that changes write semantics", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);

		// All four expected indexes are present and correct, but an extra unique index
		// was added out of band. This must not be treated as "fully repaired" (false):
		// it silently narrows valid writes (e.g. rejecting distinct namespaces reusing a path).
		sqlite.run("CREATE UNIQUE INDEX legacy_unique_path ON spec_namespace_files (path)");

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(/unexpected indexes/);
		expect(indexExists(sqlite, "legacy_unique_path")).toBe(true);
	});

	test("refuses to drop a same-named index owned by an unrelated table", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);
		sqlite.run("DROP INDEX idx_spec_file_revisions_parent");
		sqlite.run("CREATE TABLE unrelated_records (parent_revision_id text)");
		sqlite.run(
			"CREATE INDEX idx_spec_file_revisions_parent ON unrelated_records (parent_revision_id)",
		);

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(/unrelated table/);
		const owner = sqlite
			.prepare(
				"SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_spec_file_revisions_parent'",
			)
			.get() as { tbl_name: string };
		expect(owner.tbl_name).toBe("unrelated_records");
	});

	test("returns false and is a no-op when the whole Spec schema is already valid", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(repairMissingSpecTables(sqlite)).toBe(false);
		expect(repairMissingSpecTables(sqlite)).toBe(false);
	});
});

describe("Living Work Spec schema drift repair", () => {
	test("rebuilds an empty table with the expected column types", () => {
		sqlite = createPostMigrationLegacyDatabase();
		// narrator_id declared as integer instead of text.
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id integer NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const columns = sqlite.prepare("PRAGMA table_info(spec_namespaces)").all() as Array<{
			name: string;
			type: string;
		}>;
		expect(columns.find((column) => column.name === "narrator_id")?.type.toLowerCase()).toBe(
			"text",
		);
		expect(repairMissingSpecTables(sqlite)).toBe(false);
	});

	test("adds a missing required column when the drifted table is empty", () => {
		sqlite = createPostMigrationLegacyDatabase();
		// content_hash column omitted.
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id text NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				content text NOT NULL,
				parent_revision_id text,
				source_tool_use_id text,
				source_message_id text,
				created_by text DEFAULT 'assistant' NOT NULL,
				created_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (parent_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (source_message_id) REFERENCES narrator_messages(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const columns = sqlite.prepare("PRAGMA table_info(spec_file_revisions)").all() as Array<{
			name: string;
		}>;
		expect(columns.some((column) => column.name === "content_hash")).toBe(true);
	});

	test("restores a drifted foreign-key action", () => {
		sqlite = createPostMigrationLegacyDatabase();
		// narrator_id foreign key without ON DELETE cascade (defaults to NO ACTION).
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id text NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id),
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(spec_namespaces)").all() as Array<{
			from: string;
			on_delete: string;
		}>;
		expect(foreignKeys.find((foreignKey) => foreignKey.from === "narrator_id")?.on_delete).toBe(
			"CASCADE",
		);
	});

	test("rebuilds an index whose uniqueness drifted", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		// Replace the unique narrator index with a non-unique one.
		sqlite.run("DROP INDEX idx_spec_namespaces_narrator");
		sqlite.run("CREATE INDEX idx_spec_namespaces_narrator ON spec_namespaces (narrator_id)");

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const indexes = sqlite.prepare("PRAGMA index_list(spec_namespaces)").all() as Array<{
			name: string;
			unique: number;
		}>;
		expect(indexes.find((index) => index.name === "idx_spec_namespaces_narrator")?.unique).toBe(1);
	});

	test("repairs a drifted column default", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				content text NOT NULL,
				content_hash text NOT NULL,
				parent_revision_id text,
				source_tool_use_id text,
				source_message_id text,
				created_by text DEFAULT 'system' NOT NULL,
				created_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (parent_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (source_message_id) REFERENCES narrator_messages(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const createdBy = (
			sqlite.prepare("PRAGMA table_info(spec_file_revisions)").all() as Array<{
				name: string;
				dflt_value: string | null;
			}>
		).find((column) => column.name === "created_by");
		expect(createdBy?.dflt_value).toBe("'assistant'");
	});

	test("repairs an extra foreign key instead of accepting a partial match", () => {
		sqlite = createPostMigrationLegacyDatabase();
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id text NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null,
				FOREIGN KEY (created_at) REFERENCES narrators(id)
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(spec_namespaces)").all();
		expect(foreignKeys).toHaveLength(2);
	});

	test("rebuilds a partial index into the required full-table unique index", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);
		sqlite.run("DROP INDEX idx_spec_namespace_files_namespace_path");
		sqlite.run(`
			CREATE UNIQUE INDEX idx_spec_namespace_files_namespace_path
			ON spec_namespace_files(namespace_id, path)
			WHERE deleted = 0
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const index = (
			sqlite.prepare("PRAGMA index_list(spec_namespace_files)").all() as Array<{
				name: string;
				partial: number;
			}>
		).find((row) => row.name === "idx_spec_namespace_files_namespace_path");
		expect(index?.partial).toBe(0);
	});

	test("refuses to discard populated unknown columns during a rebuild", () => {
		sqlite = createPostMigrationLegacyDatabase();
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id integer NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				legacy_payload text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces
			 (id, narrator_id, created_at, updated_at, legacy_payload)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now', 'keep-me')`,
		);

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(/populated unknown columns/);
		const row = sqlite
			.prepare("SELECT legacy_payload FROM spec_namespaces WHERE id = 'namespace-1'")
			.get() as { legacy_payload: string };
		expect(row.legacy_payload).toBe("keep-me");
	});

	test("repairs a drifted empty table without mutating valid table data", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id integer PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				created_at text NOT NULL
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_namespaces").get() as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(
			sqlite
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_protected_tasks'",
				)
				.get(),
		).toBeTruthy();
	});

	test("rolls back when populated rows lack a required column with no safe fallback", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				content text NOT NULL,
				parent_revision_id text,
				source_tool_use_id text,
				source_message_id text,
				created_by text DEFAULT 'assistant' NOT NULL,
				created_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (parent_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (source_message_id) REFERENCES narrator_messages(id) ON DELETE set null
			)
		`);
		sqlite.run(
			`INSERT INTO spec_file_revisions (id, namespace_id, path, content, created_at)
			 VALUES ('revision-1', 'namespace-1', 'tasks.json', '{}', 'now')`,
		);

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(SpecSchemaDriftError);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_file_revisions").get() as {
					count: number;
				}
			).count,
		).toBe(1);
		const columns = sqlite.prepare("PRAGMA table_info(spec_file_revisions)").all() as Array<{
			name: string;
		}>;
		expect(columns.some((column) => column.name === "content_hash")).toBe(false);
	});
});

describe("terminal_view_state cascade deletes (real migration replay)", () => {
	/**
	 * Replays every committed Drizzle migration against a throwaway in-memory database
	 * and seeds one parent row per referenced table plus one terminal_view_state row for
	 * each foreign key. Exercises the real 0091 migration, not a hand-written schema.
	 */
	async function migratedDatabaseWithViewStateRows(): Promise<Database> {
		const database = new Database(":memory:");
		await runMigrations(database);
		database.run("PRAGMA foreign_keys = ON");

		database.run(
			"INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
			["user-1", "alice", "hash", "now"],
		);
		database.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"project-1",
			"Project",
			"now",
			"now",
		]);
		database.run(
			`INSERT INTO chapters (id, project_id, title, branch, base_branch, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["chapter-1", "project-1", "Chapter", "branch-1", "main", "now", "now"],
		);
		database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			"narrator-1",
			"now",
			"now",
		]);

		database.run(
			"INSERT INTO terminal_view_state (id, user_id, chapter_id, updated_at) VALUES (?, ?, ?, ?)",
			["view-chapter", "user-1", "chapter-1", "now"],
		);
		database.run(
			"INSERT INTO terminal_view_state (id, user_id, narrator_id, updated_at) VALUES (?, ?, ?, ?)",
			["view-narrator", "user-1", "narrator-1", "now"],
		);
		database.run("INSERT INTO terminal_view_state (id, user_id, updated_at) VALUES (?, ?, ?)", [
			"view-user",
			"user-1",
			"now",
		]);
		return database;
	}

	function viewStateExists(database: Database, id: string): boolean {
		return database.prepare("SELECT 1 FROM terminal_view_state WHERE id = ?").get(id) !== null;
	}

	test("the migrated foreign keys all declare ON DELETE cascade", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		const foreignKeys = sqlite
			.prepare("PRAGMA foreign_key_list(terminal_view_state)")
			.all() as Array<{ table: string; from: string; on_delete: string }>;

		const byColumn = new Map(foreignKeys.map((fk) => [fk.from, fk]));
		expect(byColumn.get("user_id")?.on_delete).toBe("CASCADE");
		expect(byColumn.get("chapter_id")?.on_delete).toBe("CASCADE");
		expect(byColumn.get("narrator_id")?.on_delete).toBe("CASCADE");
	});

	test("the migrated view-state indexes are preserved after the table rebuild", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		const indexes = (
			sqlite
				.prepare(
					`SELECT name FROM sqlite_master
					 WHERE type = 'index' AND tbl_name = 'terminal_view_state'
					   AND name NOT LIKE 'sqlite_%'
					 ORDER BY name`,
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		// User-leading unique indexes cannot cover FK enforcement or cleanup keyed only on
		// chapter/narrator/resource. Preserve the legacy four and the two added in 0189.
		expect(indexes).toEqual([
			"idx_view_state_chapter",
			"idx_view_state_narrator",
			"idx_view_state_resource",
			"idx_view_state_user_chapter",
			"idx_view_state_user_narrator",
			"idx_view_state_user_resource",
		]);
		const definitions = sqlite.prepare("PRAGMA index_list(terminal_view_state)").all() as Array<{
			name: string;
			unique: number;
		}>;
		const byName = new Map(definitions.map((definition) => [definition.name, definition]));
		for (const [name, columns, unique] of [
			["idx_view_state_chapter", ["chapter_id"], 0],
			["idx_view_state_narrator", ["narrator_id"], 0],
			["idx_view_state_resource", ["worktree_resource_id"], 0],
			["idx_view_state_user_chapter", ["user_id", "chapter_id"], 1],
			["idx_view_state_user_narrator", ["user_id", "narrator_id"], 1],
			["idx_view_state_user_resource", ["user_id", "worktree_resource_id"], 1],
		] as const) {
			const fields = sqlite.prepare(`PRAGMA index_info(${name})`).all() as Array<{
				seqno: number;
				name: string;
			}>;
			expect(
				fields.sort((left, right) => left.seqno - right.seqno).map((field) => field.name),
			).toEqual([...columns]);
			expect(byName.get(name)?.unique).toBe(unique);
		}
	});

	test("deleting a chapter cascades to its terminal_view_state rows", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		sqlite.run("DELETE FROM chapters WHERE id = ?", ["chapter-1"]);
		expect(viewStateExists(sqlite, "view-chapter")).toBe(false);
		expect(viewStateExists(sqlite, "view-narrator")).toBe(true);
		expect(viewStateExists(sqlite, "view-user")).toBe(true);
	});

	test("deleting a narrator cascades to its terminal_view_state rows", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		sqlite.run("DELETE FROM narrators WHERE id = ?", ["narrator-1"]);
		expect(viewStateExists(sqlite, "view-narrator")).toBe(false);
		expect(viewStateExists(sqlite, "view-chapter")).toBe(true);
		expect(viewStateExists(sqlite, "view-user")).toBe(true);
	});

	test("deleting a user cascades to all of that user's terminal_view_state rows", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		sqlite.run("DELETE FROM users WHERE id = ?", ["user-1"]);
		expect(viewStateExists(sqlite, "view-user")).toBe(false);
		expect(viewStateExists(sqlite, "view-chapter")).toBe(false);
		expect(viewStateExists(sqlite, "view-narrator")).toBe(false);
	});
});

/**
 * Hash-based migration execution that repairs a database whose `__drizzle_migrations`
 * high-water mark was polluted by a branch/version carrying larger migration timestamps.
 * Reproduces the real production incident: a fully-migrated database that "loses" a table
 * because Drizzle's built-in migrate() would skip re-applying the migration that creates it.
 *
 * 历史迁移序列现在只剩一条 `0000_baseline`，于是把两件事分开验证：
 *   - “水位被污染后重建缺失表”仍可在真实 journal 上端到端复现——基线的 hash 就是唯一
 *     的水位来源；
 *   - “目标表已存在的破坏性迁移不得重跑”在单条基线下不可能自然发生（基线全是
 *     `CREATE ... IF NOT EXISTS`，没有任何破坏性迁移），因此改为把真实执行器
 *     `applyPendingMigrationsByHash` 打在一个专门构造的迁移文件夹上。
 */
describe("hash-based migration self-heal", () => {
	function tableExists(database: Database, name: string): boolean {
		return (
			database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !=
			null
		);
	}

	function hashCount(database: Database): number {
		return (
			database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as {
				count: number;
			}
		).count;
	}

	function migrationHashByWhen(database: Database, folderMillis: number): string | undefined {
		return (
			database
				.prepare("SELECT hash FROM __drizzle_migrations WHERE created_at = ?")
				.get(folderMillis) as { hash: string } | undefined
		)?.hash;
	}

	// folderMillis of the single surviving journal entry.
	const BASELINE_WHEN = 1784925778846; // 0000_baseline

	const tempFolders: string[] = [];

	afterEach(() => {
		for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	const DESTRUCTIVE_WHEN = 1_700_000_000_000;
	const LATER_WHEN = 1_700_000_000_001;

	/**
	 * 一个两条 journal 条目的迁移文件夹：第一条是破坏性重建（DROP + 建空表），第二条
	 * 是它之后的正常迁移。
	 *
	 * 单条基线里全是 `CREATE ... IF NOT EXISTS`，没有任何破坏性迁移，因此“已生效但
	 * 未盖章的破坏性迁移不得重跑”这条机制只能靠构造出来的迁移文件夹触发。重建之所以
	 * 危险，正是因为它是“DROP 后建空表”，重跑会丢掉首次重建之后写入的活数据——这同时
	 * 也让“是否真的重跑过”变成可观测的。
	 */
	function migrationsFolderWithDestructiveRebuild(): string {
		const root = mkdtempSync(join(tmpdir(), "narrafork-self-heal-"));
		tempFolders.push(root);
		const folder = join(root, "drizzle");
		mkdirSync(join(folder, "meta"), { recursive: true });
		writeFileSync(
			join(folder, "meta", "_journal.json"),
			JSON.stringify({
				version: "7",
				dialect: "sqlite",
				entries: [
					{
						idx: 0,
						version: "6",
						when: DESTRUCTIVE_WHEN,
						tag: "0000_destructive_rebuild",
						breakpoints: true,
					},
					{
						idx: 1,
						version: "6",
						when: LATER_WHEN,
						tag: "0001_afterward",
						breakpoints: true,
					},
				],
			}),
		);
		writeFileSync(
			join(folder, "0000_destructive_rebuild.sql"),
			[
				"DROP TABLE `benchmark_runs`;",
				"CREATE TABLE `benchmark_runs` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);",
			].join("\n--> statement-breakpoint\n"),
		);
		writeFileSync(
			join(folder, "0001_afterward.sql"),
			"CREATE TABLE `afterward` (`id` text PRIMARY KEY NOT NULL);",
		);
		return folder;
	}

	test("recreates a missing table after the watermark was polluted (the real incident)", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		expect(tableExists(sqlite, "narrator_tool_continuations")).toBe(true);

		// Simulate the dirty database: the table and its migration hash are gone, and a
		// poisoned row lifts the MAX(created_at) watermark far past the journal entry —
		// exactly what makes Drizzle's migrate() skip the gap and leave the table missing.
		const removedHash = migrationHashByWhen(sqlite, BASELINE_WHEN);
		expect(removedHash).toBeDefined();
		sqlite.run("DROP TABLE narrator_tool_continuations");
		sqlite.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [BASELINE_WHEN]);
		sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
			"forked-branch-marker",
			9999999999999,
		]);
		expect(tableExists(sqlite, "narrator_tool_continuations")).toBe(false);

		// Re-running migrations must rebuild the missing table and re-stamp its hash.
		await runMigrations(sqlite);
		expect(tableExists(sqlite, "narrator_tool_continuations")).toBe(true);
		expect(migrationHashByWhen(sqlite, BASELINE_WHEN)).toBe(removedHash);

		// Column / index / foreign-key shape matches the committed migration.
		const columns = (
			sqlite.prepare("PRAGMA table_info(narrator_tool_continuations)").all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(columns).toContain("tool_call_id");
		expect(columns).toContain("update_epoch");
		const indexes = (
			sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='narrator_tool_continuations' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		expect(indexes).toEqual([
			"idx_tool_continuations_epoch_state",
			"idx_tool_continuations_narrator_state",
			"idx_tool_continuations_tool_call",
		]);
	});

	test("is idempotent — a second run applies nothing", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		const before = hashCount(sqlite);
		await runMigrations(sqlite);
		expect(hashCount(sqlite)).toBe(before);
	});

	test("does NOT re-run a destructive migration whose target table already exists (dirty hole)", () => {
		sqlite = new Database(":memory:");
		sqlite.run(
			"CREATE TABLE `benchmark_runs` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL)",
		);
		const folder = migrationsFolderWithDestructiveRebuild();

		// 第一次：两条都应用并盖章，得到“重建早已生效”的库，随后再写入迁移之后才产生的
		// 活数据——这正是重跑会毁掉的东西。
		applyPendingMigrationsByHash(sqlite, folder);
		sqlite.run("INSERT INTO benchmark_runs (id, name) VALUES ('live', 'after-migration')");

		// Make the destructive migration's hash a "hole": remove it while the later journal
		// position stays applied, so the migration sits below the high-water mark.
		sqlite.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [DESTRUCTIVE_WHEN]);
		const before = hashCount(sqlite);

		// Re-running must NOT drop/rebuild benchmark_runs (that would delete the live row). It
		// only re-stamps the hash because the table already holds the migration's final shape.
		applyPendingMigrationsByHash(sqlite, folder);

		expect(sqlite.prepare("SELECT name FROM benchmark_runs WHERE id = 'live'").get()).toEqual({
			name: "after-migration",
		});
		expect(hashCount(sqlite)).toBe(before + 1);
	});

	test("DOES run a destructive migration on a fresh database (target created earlier in the same run)", async () => {
		// A fresh database applies the entire journal in one run. The destructive rebuild
		// migrations must execute normally so the final foreign-key/index shape is correct;
		// they must NOT be mistaken for "already effective" just because an earlier migration
		// in the same run created the target table. Covered end-to-end by the cascade tests
		// above (which assert ON DELETE cascade only the 0091 rebuild produces); here we assert
		// the executor stamped every journal entry with zero skipped rebuilds.
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		// All destructive rebuild targets exist with their post-rebuild shape.
		expect(tableExists(sqlite, "benchmark_runs")).toBe(true);
		expect(tableExists(sqlite, "terminal_view_state")).toBe(true);
		const cascade = (
			sqlite.prepare("PRAGMA foreign_key_list(terminal_view_state)").all() as Array<{
				from: string;
				on_delete: string;
			}>
		).find((fk) => fk.from === "user_id");
		expect(cascade?.on_delete).toBe("CASCADE");
	});
});

/**
 * Statement-level scoping of the "no such table" tolerance. A destructive migration used to
 * have that error forgiven for every one of its statements, so a failed
 * `INSERT INTO __new_x SELECT ... FROM <missing>` was skipped while the following
 * `DROP TABLE x` + RENAME still ran — the migration reported success and the rows were gone.
 */
describe("destructive migration statement-level error tolerance", () => {
	const tempFolders: string[] = [];

	afterEach(() => {
		for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	/** A throwaway migrations folder holding one migration, in the layout Drizzle expects. */
	function migrationsFolderWith(tag: string, sql: string): string {
		const root = mkdtempSync(join(tmpdir(), "narrafork-migration-scope-"));
		tempFolders.push(root);
		const folder = join(root, "drizzle");
		mkdirSync(join(folder, "meta"), { recursive: true });
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

	function rowCount(database: Database, table: string): number {
		return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
			.count;
	}

	function stampedHashes(database: Database): number {
		return rowCount(database, "__drizzle_migrations");
	}

	test("aborts a table rebuild when a non-DROP statement hits a missing table", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE x (id text PRIMARY KEY NOT NULL, payload text)");
		sqlite.run("INSERT INTO x (id, payload) VALUES ('row-1', 'keep-me')");

		// Drizzle's rebuild shape, but the INSERT reads from a view/table that does not exist
		// on this database. Everything after it must not run.
		const folder = migrationsFolderWith(
			"0000_broken_rebuild",
			[
				"CREATE TABLE `__new_x` (`id` text PRIMARY KEY NOT NULL, `payload` text);",
				"INSERT INTO `__new_x`(`id`, `payload`) SELECT `id`, `payload` FROM `missing_view`;",
				"DROP TABLE `x`;",
				"ALTER TABLE `__new_x` RENAME TO `x`;",
			].join("\n--> statement-breakpoint\n"),
		);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
			/no such table/i,
		);

		// The original table and its row survive, and the migration is not stamped as applied.
		expect(rowCount(sqlite, "x")).toBe(1);
		expect(
			(sqlite.prepare("SELECT payload FROM x WHERE id = 'row-1'").get() as { payload: string })
				.payload,
		).toBe("keep-me");
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("still tolerates dropping a table this database never created", () => {
		sqlite = new Database(":memory:");
		const folder = migrationsFolderWith(
			"0000_drop_absent_table",
			["DROP TABLE `never_created`;", "CREATE TABLE `kept` (`id` text PRIMARY KEY NOT NULL);"].join(
				"\n--> statement-breakpoint\n",
			),
		);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(
			sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kept'").get(),
		).toBeTruthy();
		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("recognizes a schema-qualified drop target as the reported missing table", () => {
		sqlite = new Database(":memory:");
		const folder = migrationsFolderWith(
			"0000_drop_qualified",
			[
				'DROP TABLE main."never_created";',
				"CREATE TABLE `kept` (`id` text PRIMARY KEY NOT NULL);",
			].join("\n--> statement-breakpoint\n"),
		);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("does not forgive a missing table for a DROP of a different table", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE x (id text PRIMARY KEY NOT NULL)");
		// An index creation against an absent table must not be swallowed just because this
		// migration also drops `x`: the migration's assumptions about the schema are wrong.
		const folder = migrationsFolderWith(
			"0000_unrelated_missing",
			["CREATE INDEX `idx_absent` ON `absent_table` (`id`);", "DROP TABLE `x`;"].join(
				"\n--> statement-breakpoint\n",
			),
		);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow();
		expect(
			sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='x'").get(),
		).toBeTruthy();
		expect(stampedHashes(sqlite)).toBe(0);
	});
});

/**
 * `narrators.fast_mode_override` 的回填有两条互相独立的保护，测试分别钉住它们：
 *   1. 函数本身——把 legacy 镜像为 ON 的行钉成 `on`，使新默认值（inherit）不会
 *      静默关掉用户已经在用的快速模式；OFF 的行留在 inherit 去跟随用户默认；
 *   2. 调用门控——只在列于本次迁移中刚刚出现时执行，否则每次启动都会推翻用户
 *      后来显式选择的 `inherit`。
 *
 * 历史迁移序列已被挤压成单条 `0000_baseline`，无法再“回退到 0104 之前再重放”，
 * 因此第 1 组直接调用真实回填函数，门控那一组仍走 `runMigrations` 端到端断言。
 */
describe("fast_mode_override backfill", () => {
	function overrideOf(database: Database, narratorId: string): string {
		return (
			database
				.prepare("SELECT fast_mode_override AS v FROM narrators WHERE id = ?")
				.get(narratorId) as {
				v: string;
			}
		).v;
	}

	/**
	 * 真实 schema，加上升级前只带 legacy 布尔值的行：`fast_mode_override` 仍是
	 * 列默认值 `inherit`，因此 legacy 镜像就是那段行为的唯一痕迹。
	 */
	async function migratedDatabaseWithLegacyFastModeRows(): Promise<Database> {
		const database = new Database(":memory:");
		await runMigrations(database);
		for (const [id, fastMode, override] of [
			["narrator-fast", 1, "inherit"],
			["narrator-slow", 0, "inherit"],
			["narrator-pinned", 1, "on"],
		] as const) {
			database.run(
				"INSERT INTO narrators (id, fast_mode, fast_mode_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				[id, fastMode, override, "now", "now"],
			);
		}
		return database;
	}

	test("pins narrators that had fast mode ON so the new default cannot silently disable them", async () => {
		sqlite = await migratedDatabaseWithLegacyFastModeRows();

		backfillFastModeOverride(sqlite);

		expect(overrideOf(sqlite, "narrator-fast")).toBe("on");
	});

	test("leaves narrators that had fast mode OFF on inherit so they follow the user default", async () => {
		sqlite = await migratedDatabaseWithLegacyFastModeRows();

		backfillFastModeOverride(sqlite);

		expect(overrideOf(sqlite, "narrator-slow")).toBe("inherit");
	});

	test("does not rewrite a narrator that is already pinned, so a rerun is harmless", async () => {
		sqlite = await migratedDatabaseWithLegacyFastModeRows();

		backfillFastModeOverride(sqlite);
		backfillFastModeOverride(sqlite);

		expect(overrideOf(sqlite, "narrator-pinned")).toBe("on");
		// 未命中的行也不能被顺手改动。
		expect(overrideOf(sqlite, "narrator-slow")).toBe("inherit");
	});

	test("does not re-pin a narrator that later chose inherit while its legacy mirror stayed on", async () => {
		// 列早已存在 => 门控必须跳过回填，否则每次启动都会把用户显式选择的
		// “跟随默认”重新钉回 on。
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		sqlite.run(
			"INSERT INTO narrators (id, fast_mode, fast_mode_override, created_at, updated_at) VALUES (?, 1, 'inherit', ?, ?)",
			["narrator-fast", "now", "now"],
		);

		await runMigrations(sqlite);

		expect(overrideOf(sqlite, "narrator-fast")).toBe("inherit");

		// 反证：这一行确实落在回填的命中集合里，所以上面那条断言失败的唯一原因
		// 只能是门控被移除，而不是这一行本身不匹配条件。
		backfillFastModeOverride(sqlite);
		expect(overrideOf(sqlite, "narrator-fast")).toBe("on");
	});
});

/**
 * 升级绝不能隐藏团队原本就能看到的工作：pre-ACL 的无主叙述者必须被发布成
 * `public`，但发布必须恰好发生一次——否则管理员后来说的“改回私有”会在每次启动
 * 被推翻。两组测试分别钉住这两件事：直接调用真实回填函数断言它的行为，以及走
 * `runMigrations` 断言“列缺失”门控本身。
 *
 * 历史迁移序列已被挤压成单条 `0000_baseline`，无法再重放 0125 之前的 journal
 * 前缀，因此这里不再回放历史，而是对着真实 schema 检验同一批语义。
 */
describe("narrator visibility backfill", () => {
	function visibilityOf(database: Database, narratorId: string): string {
		return (
			database.prepare("SELECT visibility AS v FROM narrators WHERE id = ?").get(narratorId) as {
				v: string;
			}
		).v;
	}

	/**
	 * 升级前形态的一行：没有 owner（这正是回填的命中集合），`visibility` 只带列
	 * 默认值——没有任何人做过可见性决定。
	 */
	function insertPreAclNarrator(database: Database, id: string): void {
		database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			id,
			"now",
			"now",
		]);
	}

	test("publishes pre-ACL narrators so an upgrade never hides existing work", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		insertPreAclNarrator(sqlite, "narrator-legacy");
		// 列默认值就是 private——这正是升级会把既有工作藏起来的原因。
		expect(visibilityOf(sqlite, "narrator-legacy")).toBe("private");

		backfillNarratorVisibility(sqlite);

		expect(visibilityOf(sqlite, "narrator-legacy")).toBe("public");
		// 日后重新归属 owner 时不能留下悬挂引用：外键必须是 SET NULL。
		expect(
			(
				sqlite.query("PRAGMA foreign_key_list(narrators)").all() as Array<{
					from: string;
					table: string;
					on_delete: string;
				}>
			).some(
				(fk) => fk.from === "owner_user_id" && fk.table === "users" && fk.on_delete === "SET NULL",
			),
		).toBe(true);
	});

	test("leaves the owner null so only admins can re-home a legacy narrator", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		insertPreAclNarrator(sqlite, "narrator-legacy");

		backfillNarratorVisibility(sqlite);

		const row = sqlite
			.prepare("SELECT owner_user_id AS owner FROM narrators WHERE id = ?")
			.get("narrator-legacy") as { owner: string | null };
		expect(row.owner).toBeNull();
	});

	test("does not re-publish a legacy narrator an admin later made private", async () => {
		// 门控存在的全部理由：启发式重跑（例如 `owner IS NULL`）会一直撤销管理员
		// 刻意做的“重新设为私有”。
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		insertPreAclNarrator(sqlite, "narrator-legacy");
		backfillNarratorVisibility(sqlite);
		expect(visibilityOf(sqlite, "narrator-legacy")).toBe("public");
		sqlite.run("UPDATE narrators SET visibility = 'private' WHERE id = ?", ["narrator-legacy"]);

		await runMigrations(sqlite);

		expect(visibilityOf(sqlite, "narrator-legacy")).toBe("private");

		// 反证：这一行仍是回填的命中集合（owner 为 null），所以保住 private 的是
		// 门控本身，而不是这一行不再匹配条件。
		backfillNarratorVisibility(sqlite);
		expect(visibilityOf(sqlite, "narrator-legacy")).toBe("public");
	});

	test("leaves narrators created after the upgrade private by default", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		sqlite.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			"narrator-new",
			"later",
			"later",
		]);

		await runMigrations(sqlite);

		// 升级之后创建的叙述者默认私有，迁移也绝不能把它们扫进 public。
		expect(visibilityOf(sqlite, "narrator-new")).toBe("private");
	});
});

/**
 * Splitting sharing into a read axis and a write axis must not WIDEN who can drive an
 * existing session. Upgrading is not consent.
 *
 * These are regression tests against a backfill that was written, shipped into a review,
 * and reverted: it set `write_audience` to the widest value each row's `visibility`
 * permitted, on the premise that read access had already implied write. It had not —
 * `canWriteNarrator` has only ever consulted ownership, admin and explicit write grants.
 * So the "restoration" would have handed every signed-in user the ability to approve tool
 * calls in the pre-ACL sessions `backfillNarratorVisibility` publishes with a null owner,
 * which on an older instance is usually all of them.
 *
 * The assertions are phrased against `visibility`, because that is the column the
 * reverted logic keyed on: if anything ever derives write from read again, the `public`
 * and `project` cases below are what fail. The publishing step is the real
 * `backfillNarratorVisibility`, so the dangerous read/write combination is genuinely
 * exercised instead of being described.
 */
describe("narrator write audience is never widened by migrating", () => {
	function writeAudienceOf(database: Database, narratorId: string): string {
		return (
			database
				.prepare("SELECT write_audience AS w FROM narrators WHERE id = ?")
				.get(narratorId) as { w: string }
		).w;
	}

	function visibilityOf(database: Database, narratorId: string): string {
		return (
			database.prepare("SELECT visibility AS v FROM narrators WHERE id = ?").get(narratorId) as {
				v: string;
			}
		).v;
	}

	/**
	 * 真实 schema + 一行 pre-ACL 叙述者（无 owner，因此落在发布回填的命中集合里）。
	 * 历史迁移序列已被挤压成单条基线，无法再重放“0138 即将添加 write_audience”的
	 * 中间状态，所以改为在已经带上该列的真实库上断言“迁移从不写这一列”。
	 */
	async function migratedDatabaseWithLegacyNarrator(id: string): Promise<Database> {
		const database = new Database(":memory:");
		await runMigrations(database);
		database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			id,
			"now",
			"now",
		]);
		return database;
	}

	test("a publicly READABLE session does not become publicly drivable", async () => {
		sqlite = await migratedDatabaseWithLegacyNarrator("narrator-public");

		// 真实的 pre-ACL 发布：读面确实被放宽到最宽。
		backfillNarratorVisibility(sqlite);
		expect(visibilityOf(sqlite, "narrator-public")).toBe("public");
		await runMigrations(sqlite);

		// The escalation the reverted backfill produced. `public` write combined with
		// `resolveProjectGate(null)`'s "no gate here" means every signed-in user could
		// drive these sessions — and pre-ACL rows are exactly the `public` ones.
		expect(writeAudienceOf(sqlite, "narrator-public")).toBe("owner");
	});

	test("a project-visible session does not become project-drivable", async () => {
		sqlite = await migratedDatabaseWithLegacyNarrator("narrator-project");
		sqlite.run("UPDATE narrators SET visibility = 'project' WHERE id = ?", ["narrator-project"]);

		await runMigrations(sqlite);

		expect(visibilityOf(sqlite, "narrator-project")).toBe("project");
		// Narrower than the `public` case but still a widening nobody asked for: project
		// members who could only watch would gain the ability to run commands.
		expect(writeAudienceOf(sqlite, "narrator-project")).toBe("owner");
	});

	test("a private session stays owner-only", async () => {
		sqlite = await migratedDatabaseWithLegacyNarrator("narrator-private");
		sqlite.run("UPDATE narrators SET visibility = 'private' WHERE id = ?", ["narrator-private"]);

		await runMigrations(sqlite);

		expect(visibilityOf(sqlite, "narrator-private")).toBe("private");
		expect(writeAudienceOf(sqlite, "narrator-private")).toBe("owner");
	});

	test("an explicitly widened session is left alone by later migrations", async () => {
		// The other direction: once an owner deliberately opens a session up, replaying
		// migrations must not pull it back. Nothing should be writing this column during a
		// migration at all, and this is what would catch a "corrective" one.
		sqlite = await migratedDatabaseWithLegacyNarrator("narrator-widened");
		await runMigrations(sqlite);
		sqlite.run("UPDATE narrators SET write_audience = 'public' WHERE id = ?", ["narrator-widened"]);

		// 连真实的发布回填一起跑：它只被允许动读轴。
		backfillNarratorVisibility(sqlite);
		await runMigrations(sqlite);

		expect(writeAudienceOf(sqlite, "narrator-widened")).toBe("public");
	});

	test("narrators created after the upgrade default to owner-only", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		sqlite.run(
			"INSERT INTO narrators (id, visibility, created_at, updated_at) VALUES (?, ?, ?, ?)",
			["narrator-after", "public", "later", "later"],
		);

		await runMigrations(sqlite);

		// A new public session is a choice about who may WATCH. The service layer decides
		// its write audience at creation; migrations never revisit it.
		expect(writeAudienceOf(sqlite, "narrator-after")).toBe("owner");
	});
});

/**
 * The subagent-root backfill must survive a failed attempt.
 *
 * It is the one backfill that is NOT gated on the column having just been added, and this
 * is why. Migrations commit inside a transaction and are stamped; the backfills run after
 * it and only warn on failure. Under a column-absence gate, one failure — a lock, a
 * timeout on a large `narrators` table — would be permanent, and every affected subagent
 * would stay invisible to the people its parent is shared with, with nothing left to retry
 * it. So the gate is "does any subagent still lack a root", which makes the work
 * self-healing on the next startup and costs one indexed COUNT once it is done.
 *
 * Re-running is safe here precisely because this column records a structural fact nobody
 * can edit (which narrator a subagent belongs to), unlike the `visibility` backfills where
 * a re-run would undo a human decision.
 */
describe("subagent acl root backfill is retried until it succeeds", () => {
	function rootOf(database: Database, id: string): string | null {
		const row = database
			.prepare("SELECT acl_root_narrator_id AS r FROM narrators WHERE id = ?")
			.get(id) as { r: string | null } | undefined;
		return row?.r ?? null;
	}

	function insertNarrator(
		database: Database,
		id: string,
		type: string,
		parent: string | null,
	): void {
		database.run(
			"INSERT INTO narrators (id, type, parent_narrator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			[id, type, parent, "now", "now"],
		);
	}

	test("a subagent left unfilled by an earlier run is repaired on a later one", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		// The state a crashed or lock-failed backfill leaves behind: the column exists and
		// is stamped, but this row never got its pointer. Under the old column-absence gate
		// nothing would ever look at it again.
		insertNarrator(sqlite, "parent-1", "primary", null);
		insertNarrator(sqlite, "sub-1", "subagent", "parent-1");
		expect(rootOf(sqlite, "sub-1")).toBeNull();

		await runMigrations(sqlite);

		expect(rootOf(sqlite, "sub-1")).toBe("parent-1");
	});

	test("a genuinely unresolvable chain stays null instead of being guessed", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		// No parent at all: there is no root to delegate to, and inventing one would be a
		// silent access decision. Null means "undeterminable", which the ACL layer denies.
		insertNarrator(sqlite, "orphan", "subagent", null);

		await runMigrations(sqlite);

		expect(rootOf(sqlite, "orphan")).toBeNull();
	});

	test("a primary narrator is never given a pointer, however often this runs", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		insertNarrator(sqlite, "primary-1", "primary", null);
		// A fork has a parent but is an independent session; pointing it at its origin
		// would put its sharing permanently under someone else's control.
		insertNarrator(sqlite, "fork-1", "primary", "primary-1");

		await runMigrations(sqlite);
		await runMigrations(sqlite);

		expect(rootOf(sqlite, "primary-1")).toBeNull();
		expect(rootOf(sqlite, "fork-1")).toBeNull();
	});

	test("an already-filled pointer is not rewritten by a later run", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		insertNarrator(sqlite, "parent-2", "primary", null);
		insertNarrator(sqlite, "sub-2", "subagent", "parent-2");
		await runMigrations(sqlite);
		expect(rootOf(sqlite, "sub-2")).toBe("parent-2");

		await runMigrations(sqlite);

		expect(rootOf(sqlite, "sub-2")).toBe("parent-2");
	});
});

/**
 * A machine that developed NarraFork from source and then upgraded to a release binary carries
 * a database whose schema already advanced past migrations whose hashes were never recorded
 * (locally generated migrations hash differently from the released SQL files). Replaying such a
 * migration re-runs its `DROP INDEX` / `DROP COLUMN` against a target the earlier local run
 * already removed. That used to abort startup with `no such index: ...`.
 */
describe("already-satisfied drop tolerance (source-built upgrade holes)", () => {
	const tempFolders: string[] = [];

	afterEach(() => {
		for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	function migrationsFolderWith(
		tag: string,
		statements: readonly string[],
		laterStatements: readonly string[] = [],
	): string {
		const root = mkdtempSync(join(tmpdir(), "narrafork-drop-tolerance-"));
		tempFolders.push(root);
		const folder = join(root, "drizzle");
		mkdirSync(join(folder, "meta"), { recursive: true });
		writeFileSync(
			join(folder, "meta", "_journal.json"),
			JSON.stringify({
				version: "7",
				dialect: "sqlite",
				entries: [
					{ idx: 0, version: "6", when: 1_700_000_000_000, tag, breakpoints: true },
					...(laterStatements.length
						? [
								{
									idx: 1,
									version: "6",
									when: 1_700_000_000_001,
									tag: `${tag}_retirement`,
									breakpoints: true,
								},
							]
						: []),
				],
			}),
		);
		writeFileSync(join(folder, `${tag}.sql`), statements.join("\n--> statement-breakpoint\n"));
		if (laterStatements.length) {
			writeFileSync(
				join(folder, `${tag}_retirement.sql`),
				laterStatements.join("\n--> statement-breakpoint\n"),
			);
		}
		return folder;
	}

	function stampedHashes(database: Database): number {
		return (
			database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as {
				count: number;
			}
		).count;
	}

	function columnNames(database: Database, table: string): string[] {
		return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
			(row) => row.name,
		);
	}

	// folderMillis of 0103_redundant_valkyrie — the migration from the reported incident: it
	// drops idx_blacklist_cmds_narrator_pattern and replaces it with two partial indexes.
	const BLACKLIST_PARTIAL_INDEX_WHEN = 1785508212529;

	test("heals the reported incident: replaying 0103 when its dropped index is already gone", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);

		// The dev machine's state: schema fully advanced, but 0103's hash absent.
		sqlite.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [
			BLACKLIST_PARTIAL_INDEX_WHEN,
		]);

		await runMigrations(sqlite);

		// The replacement partial indexes survive; the legacy index stays gone.
		const indexes = (
			sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='narrator_blacklist_cmds' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		expect(indexes).toEqual([
			"idx_blacklist_cmds_narrator",
			"idx_blacklist_cmds_narrator_pattern_scoped",
			"idx_blacklist_cmds_narrator_pattern_unscoped",
		]);
	});

	test("replays the entire journal against an already-final schema without failing", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);

		sqlite.run(
			"INSERT INTO narrators (id,title,created_at,updated_at) VALUES ('preserved','keep-title','now','now')",
		);
		// Worst case for a source-built machine: not a single recorded hash matches the
		// released files, so every migration is replayed against its own end state.
		sqlite.run("DELETE FROM __drizzle_migrations");

		await runMigrations(sqlite);

		expect(stampedHashes(sqlite)).toBeGreaterThan(0);
		expect(sqlite.prepare("SELECT title FROM narrators WHERE id='preserved'").get()).toEqual({
			title: "keep-title",
		});
		expect(columnNames(sqlite, "narrators")).not.toContain("prune_boundary_message_id");
		expect(
			sqlite
				.prepare("SELECT name FROM sqlite_master WHERE name='idx_narrators_prune_boundary_message'")
				.get(),
		).toBeNull();
		expect(
			sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='narrators'").get(),
		).toBeTruthy();
	});

	const retiredIndexSql =
		"CREATE INDEX `idx_narrators_prune_boundary_message` ON `narrators` (`prune_boundary_message_id`);";
	const retirementSql = [
		"CREATE TABLE `__new_narrators` (`id` text PRIMARY KEY, `title` text);",
		"INSERT INTO `__new_narrators` (`id`, `title`) SELECT `id`, `title` FROM `narrators`;",
		"DROP TABLE `narrators`;",
		"ALTER TABLE `__new_narrators` RENAME TO `narrators`;",
	];

	test("heals a retired-index hash hole after its retirement rebuild without restoring the column", () => {
		// 这条原本复现“0093 的 hash 空洞出现在 0170 之后”。那两条历史迁移已被挤压成单条
		// 基线、不再存在于 journal 中，被断言的机制却原样保留：`applyPendingMigrationsByHash`
		// 会重放处于高水位之下的 hash 空洞，而 `isRetiredIndexCreateError` 依据 journal 里
		// 后续的退休重建证明该索引已作废，从而跳过它并补上 hash。
		// 因此改为构造同形状的两条迁移：先建退休索引，再由后续重建把它连同列一起退休。
		sqlite = new Database(":memory:");
		// 升级前的 narrators：还带着后来被退休的列。
		sqlite.run(
			"CREATE TABLE narrators (id text PRIMARY KEY, title text, prune_boundary_message_id text)",
		);
		sqlite.run("INSERT INTO narrators VALUES ('kept','preserved', NULL)");
		const folder = migrationsFolderWith("0000_retired_index", [retiredIndexSql], retirementSql);

		// 第一次：索引建立，随后被后续重建退休，两条 hash 都盖章。
		applyPendingMigrationsByHash(sqlite, folder);
		expect(columnNames(sqlite, "narrators")).not.toContain("prune_boundary_message_id");

		// 制造真正的 hash 空洞：退休索引所在迁移的 hash 消失，而它之后的 journal 位置仍是
		// 已应用——这正是源构建升级到发行版后会带上的残缺水位。
		sqlite.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [1_700_000_000_000]);
		const before = stampedHashes(sqlite);
		expect(before).toBe(1);

		applyPendingMigrationsByHash(sqlite, folder);

		// 空洞被补上……
		expect(stampedHashes(sqlite)).toBe(before + 1);
		// ……数据仍在……
		expect(sqlite.query("SELECT title FROM narrators WHERE id='kept'").get()).toEqual({
			title: "preserved",
		});
		// ……而且不会把已被退休的列或索引带回来。
		expect(columnNames(sqlite, "narrators")).not.toContain("prune_boundary_message_id");
		expect(
			sqlite
				.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
				.get("idx_narrators_prune_boundary_message"),
		).toBeNull();
	});

	test("skips only the retired index when the journal proves its later retirement", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE narrators (id text PRIMARY KEY, title text)");
		sqlite.run("INSERT INTO narrators VALUES ('kept','preserved')");
		const folder = migrationsFolderWith("0000_retired_index", [retiredIndexSql], retirementSql);
		applyPendingMigrationsByHash(sqlite, folder);
		expect(sqlite.prepare("SELECT * FROM narrators").all()).toEqual([
			{ id: "kept", title: "preserved" },
		]);
		expect(stampedHashes(sqlite)).toBe(2);
	});

	test("does not skip even the known retired index without a later retirement migration", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE narrators (id text PRIMARY KEY, title text)");
		const folder = migrationsFolderWith("0000_retired_without_proof", [retiredIndexSql]);
		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
			/no such column/i,
		);
		expect(stampedHashes(sqlite)).toBe(0);
	});

	for (const indexSql of [
		retiredIndexSql.replace("CREATE INDEX", "CREATE UNIQUE INDEX"),
		retiredIndexSql.replace("idx_narrators_prune_boundary_message", "idx_required"),
		retiredIndexSql.replace(
			"(`prune_boundary_message_id`)",
			"(`prune_boundary_message_id`, `title`)",
		),
		retiredIndexSql.replace("ON `narrators`", "ON `unrelated`"),
	]) {
		test(`does not forgive different index semantics: ${indexSql}`, () => {
			sqlite = new Database(":memory:");
			sqlite.run("CREATE TABLE narrators (id text PRIMARY KEY, title text)");
			sqlite.run("CREATE TABLE unrelated (id text PRIMARY KEY, title text)");
			const folder = migrationsFolderWith("0000_required_index", [indexSql], retirementSql);
			expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
				/no such column/i,
			);
			expect(stampedHashes(sqlite)).toBe(0);
		});
	}

	test("skips a DROP INDEX whose index is already absent and keeps going", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, payload text)");
		const folder = migrationsFolderWith("0000_drop_absent_index", [
			"DROP INDEX `idx_already_gone`;",
			"CREATE INDEX `idx_t_payload` ON `t` (`payload`);",
		]);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(
			sqlite
				.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
				.get("idx_t_payload"),
		).toBeTruthy();
		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("skips a DROP COLUMN whose column is already absent, preserving rows", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, keep text)");
		sqlite.run("INSERT INTO t (id, keep) VALUES ('row-1', 'keep-me')");
		const folder = migrationsFolderWith("0000_drop_absent_column", [
			"ALTER TABLE `t` DROP COLUMN `already_gone`;",
			"ALTER TABLE `t` ADD `added` text;",
		]);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(columnNames(sqlite, "t")).toEqual(["id", "keep", "added"]);
		expect(
			(sqlite.prepare("SELECT keep FROM t WHERE id = 'row-1'").get() as { keep: string }).keep,
		).toBe("keep-me");
		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("does not forgive a missing column for a statement that is not a column drop", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL)");
		// `CREATE INDEX` on an absent column also reports "no such column"; tolerating it
		// would leave the database silently missing an index the migration promised.
		const folder = migrationsFolderWith("0000_index_on_absent_column", [
			"CREATE INDEX `idx_absent_col` ON `t` (`gone`);",
		]);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
			/no such column/i,
		);
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("does not forgive a DROP COLUMN whose table is missing entirely", () => {
		sqlite = new Database(":memory:");
		const folder = migrationsFolderWith("0000_drop_column_absent_table", [
			"ALTER TABLE `never_created` DROP COLUMN `whatever`;",
		]);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow();
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("does not forgive a DROP COLUMN when the reported column is a different one", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, present text)");
		// SQLite refuses to drop the last remaining PK-bearing column etc.; more importantly a
		// mismatch between the reported name and the statement's target must stay fatal.
		const folder = migrationsFolderWith("0000_drop_column_mismatch", [
			"CREATE TRIGGER `tr` AFTER INSERT ON `t` BEGIN SELECT `absent_col` FROM `t`; END;",
			"ALTER TABLE `t` DROP COLUMN `present`;",
		]);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
			/no such column/i,
		);
		expect(columnNames(sqlite, "t")).toEqual(["id", "present"]);
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("still drops an index that really exists", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, payload text)");
		sqlite.run("CREATE INDEX `idx_t_payload` ON `t` (`payload`)");
		const folder = migrationsFolderWith("0000_drop_present_index", ["DROP INDEX `idx_t_payload`;"]);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(
			sqlite
				.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
				.get("idx_t_payload"),
		).toBeNull();
	});
});
