import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	embeddedMigrationJournalJson,
	embeddedMigrationSqlFiles,
} from "../generated/embedded-migrations-data";
import { runMigrations } from "./run-migrations";

let sqlite: Database | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

function openDatabase(): Database {
	sqlite = new Database(":memory:");
	return sqlite;
}

function tableColumns(
	database: Database,
	table: string,
): Array<{ name: string; type: string; notnull: number; dflt_value: string | null }> {
	return database
		.query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
			`PRAGMA table_info(${table})`,
		)
		.all();
}

function indexExists(database: Database, name: string): boolean {
	return (
		database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !==
		null
	);
}

describe("编排运行级观测 schema", () => {
	test("嵌入迁移与 drizzle journal 同步包含最新迁移", () => {
		const journal = JSON.parse(embeddedMigrationJournalJson) as {
			entries: Array<{ tag: string }>;
		};
		const journalNames = journal.entries.map((entry) => `${entry.tag}.sql`);
		expect(embeddedMigrationSqlFiles.map((entry) => entry.name)).toEqual(journalNames);
		expect(journalNames).toContain("0002_eager_lifeguard.sql");
		expect(
			embeddedMigrationSqlFiles.some((entry) => entry.name === "0002_eager_lifeguard.sql"),
		).toBe(true);
	});

	test("新增列保持可空或 unknown 默认，并生成对应索引", async () => {
		const database = openDatabase();
		await runMigrations(database);

		const apiColumns = tableColumns(database, "api_requests");
		expect(apiColumns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "orchestration_run_id", type: "TEXT", notnull: 0 }),
				expect.objectContaining({ name: "role", type: "TEXT", notnull: 0 }),
				expect.objectContaining({ name: "usage_source", type: "TEXT", notnull: 0 }),
				expect.objectContaining({ name: "context_source", type: "TEXT", notnull: 0 }),
				expect.objectContaining({ name: "input_token_semantics", type: "TEXT", notnull: 0 }),
				expect.objectContaining({ name: "prompt_tokens", type: "INTEGER", notnull: 0 }),
				expect.objectContaining({ name: "context_window", type: "INTEGER", notnull: 0 }),
			]),
		);

		const runColumns = tableColumns(database, "orchestration_runs");
		expect(runColumns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "current_phase",
					type: "TEXT",
					notnull: 1,
					dflt_value: "'unknown'",
				}),
				expect.objectContaining({ name: "last_progress_seq", type: "INTEGER", notnull: 0 }),
				expect.objectContaining({ name: "last_progress_at", type: "TEXT", notnull: 0 }),
			]),
		);

		const backgroundColumns = tableColumns(database, "background_tasks");
		expect(backgroundColumns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "orchestration_run_id", type: "TEXT", notnull: 0 }),
			]),
		);

		expect(indexExists(database, "idx_api_requests_orchestration_run_created")).toBe(true);
		expect(indexExists(database, "idx_orchestration_runs_progress")).toBe(true);
		expect(indexExists(database, "idx_bg_tasks_orchestration_run")).toBe(true);
	});

	test("旧行可以读取为 unknown，background task 不复用 logicalRunId", async () => {
		const database = openDatabase();
		await runMigrations(database);
		const now = "2026-09-26T00:00:00.000Z";

		database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			"n-observe",
			now,
			now,
		]);
		database.run(
			"INSERT INTO api_requests (id, kind, input_tokens, created_at) VALUES (?, ?, ?, ?)",
			["request-legacy", "narrator", 0, now],
		);
		database.run(
			`INSERT INTO orchestration_runs
			 (id, coordinator_narrator_id, profile_id, tier, phase, started_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			["run-legacy", "n-observe", "profile", "quick", "dispatched", now],
		);
		database.run(
			`INSERT INTO background_tasks
			 (id, parent_narrator_id, type, logical_run_id, status, started_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			["task-1", "n-observe", "agent", "publication-run", "running", now, now, now],
		);

		const request = database
			.query<
				{ role: string | null; usage_source: string | null; context_source: string | null },
				[string]
			>("SELECT role, usage_source, context_source FROM api_requests WHERE id = ?")
			.get("request-legacy");
		expect(request).toEqual({ role: null, usage_source: null, context_source: null });

		const run = database
			.query<
				{
					current_phase: string;
					last_progress_seq: number | null;
					last_progress_at: string | null;
				},
				[string]
			>(
				"SELECT current_phase, last_progress_seq, last_progress_at FROM orchestration_runs WHERE id = ?",
			)
			.get("run-legacy");
		expect(run).toEqual({
			current_phase: "unknown",
			last_progress_seq: null,
			last_progress_at: null,
		});

		const task = database
			.query<{ logical_run_id: string | null; orchestration_run_id: string | null }, [string]>(
				"SELECT logical_run_id, orchestration_run_id FROM background_tasks WHERE id = ?",
			)
			.get("task-1");
		expect(task).toEqual({ logical_run_id: "publication-run", orchestration_run_id: null });
	});
});
