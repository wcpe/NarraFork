/**
 * 「成本状态」列组（cost_status / cost_missing_fields / partial_request_count）引入时，必须满足两条语义：
 * 已有行不能被清空或改写（历史金额存活），新列在历史行上按自身声明取默认值（可空列 = NULL，即「未知覆盖」；
 * 非空计数列 = 0）。
 *
 * 本文件原先把这两条语义押在 `drizzle/0182_reference_cost_status.sql` 的**文本**上，并在模块顶层
 * `readFileSync` 它。基线挤压后 `drizzle/` 只剩 `0000_baseline.sql`，该文件已不存在，于是整个文件在加载期
 * 抛 ENOENT、连下面的 PostgreSQL 用例也一并停跑。
 *
 * 现在断言改指真实运行时宿主：`ensureColumns`（server/db/ensure-columns.ts）——升级路径上给已有数据库
 * 补齐缺失列的实现，由 `server/db/backend/sqlite-lifecycle.ts` 在迁移之后、FTS 初始化之前调用
 * （Drizzle 对「历史已全部标记为已应用」的库不会再跑 CREATE TABLE，所以补列只能由它来做）。
 * 新鲜安装路径（整份 journal 建库）由下面的「journal」用例覆盖，读的是现存基线而不是已消失的文件。
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SQL } from "bun";
import { ensureColumns } from "../ensure-columns";
import { applyPendingMigrationsByHash } from "../run-migrations";

const root = resolve(import.meta.dir, "../../..");

interface ColumnInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
}

function columnShape(db: Database, table: string, column: string): ColumnInfo {
	const found = (db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).find(
		(row) => row.name === column,
	);
	if (!found) throw new Error(`列不存在: ${table}.${column}`);
	return found;
}

test("SQLite cost upgrade preserves historical amounts and unknown coverage", () => {
	const db = new Database(":memory:");
	try {
		// 0182 之前的表形状：只有历史金额与历史覆盖计数，没有任何成本状态列。
		db.exec(
			"CREATE TABLE api_requests(id text primary key, cost_usd real); CREATE TABLE narrator_messages(id text primary key, cost_usd real); CREATE TABLE narrator_tool_calls(id text primary key, total_cost real); CREATE TABLE credential_usage_totals(id text primary key, cost_usd real, unpriced_request_count integer); CREATE TABLE user_usage_totals(user_id text primary key, cost_usd real, unpriced_request_count integer)",
		);
		db.exec(
			"INSERT INTO api_requests VALUES ('old', 12.5); INSERT INTO narrator_messages VALUES ('old', 3.25); INSERT INTO narrator_tool_calls VALUES ('old', 4.5); INSERT INTO credential_usage_totals VALUES ('old', 20, 2); INSERT INTO user_usage_totals VALUES ('old', 30, 3)",
		);

		ensureColumns(db);

		// 逐列精确相等（toEqual 而非 toMatchObject）：历史金额必须原样存活，未知覆盖列必须是 NULL。
		// 只投影参与断言的四列，因为 ensureColumns 是 schema 级补列，其余列不属于本用例的语义。
		expect(
			db.query("SELECT id, cost_usd, cost_status, cost_missing_fields FROM api_requests").get(),
		).toEqual({ id: "old", cost_usd: 12.5, cost_status: null, cost_missing_fields: null });
		expect(db.query("SELECT id, cost_usd, cost_status FROM narrator_messages").get()).toEqual({
			id: "old",
			cost_usd: 3.25,
			cost_status: null,
		});
		expect(db.query("SELECT id, total_cost, cost_status FROM narrator_tool_calls").get()).toEqual({
			id: "old",
			total_cost: 4.5,
			cost_status: null,
		});
		expect(
			db
				.query(
					"SELECT id, cost_usd, unpriced_request_count, partial_request_count FROM credential_usage_totals",
				)
				.get(),
		).toEqual({ id: "old", cost_usd: 20, unpriced_request_count: 2, partial_request_count: 0 });
		expect(
			db
				.query(
					"SELECT user_id, cost_usd, unpriced_request_count, partial_request_count FROM user_usage_totals",
				)
				.get(),
		).toEqual({
			user_id: "old",
			cost_usd: 30,
			unpriced_request_count: 3,
			partial_request_count: 0,
		});

		// 新列的声明形状必须正确：补列最典型的失误是非空列丢掉 DEFAULT，那样历史行会变成 NULL 或整个 ALTER 失败。
		expect(columnShape(db, "api_requests", "cost_status")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "api_requests", "cost_missing_fields")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "narrator_messages", "cost_status")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "narrator_tool_calls", "cost_status")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "credential_usage_totals", "partial_request_count")).toMatchObject({
			type: "INTEGER",
			notnull: 1,
			dflt_value: "0",
		});
		expect(columnShape(db, "user_usage_totals", "partial_request_count")).toMatchObject({
			type: "INTEGER",
			notnull: 1,
			dflt_value: "0",
		});

		// 启动路径每次都会调用它，因此必须幂等：第二次调用不得再改动任何一列。
		const before = db.query("PRAGMA table_info(user_usage_totals)").all();
		ensureColumns(db);
		expect(db.query("PRAGMA table_info(user_usage_totals)").all()).toEqual(before);
	} finally {
		db.close();
	}
});

test("SQLite journal applies the baseline idempotently to a fresh database", () => {
	const db = new Database(":memory:");
	try {
		// 「成本状态」列组已并入基线（`0000_baseline.sql`），所以新鲜安装路径覆盖的是「这些列确实被
		// 建出来、声明形状正确」这一半；已有库补列那一半由上面的 ensureColumns 用例覆盖。
		applyPendingMigrationsByHash(db, resolve(root, "drizzle"));
		applyPendingMigrationsByHash(db, resolve(root, "drizzle"));
		expect(
			db
				.query<{ name: string }, []>("PRAGMA table_info(api_requests)")
				.all()
				.some((row) => row.name === "cost_status"),
		).toBe(true);
		expect(columnShape(db, "api_requests", "cost_status")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "api_requests", "cost_missing_fields")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "narrator_messages", "cost_status")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "narrator_tool_calls", "cost_status")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		expect(columnShape(db, "credential_usage_totals", "partial_request_count")).toMatchObject({
			type: "INTEGER",
			notnull: 1,
			dflt_value: "0",
		});
		expect(columnShape(db, "user_usage_totals", "partial_request_count")).toMatchObject({
			type: "INTEGER",
			notnull: 1,
			dflt_value: "0",
		});
	} finally {
		db.close();
	}
});

// Explicit opt-in, using only newly created databases with our own prefix.
const postgresUrl = process.env.NF_REFERENCE_COST_PG_URL;
test.skipIf(!postgresUrl)(
	"PostgreSQL fresh install and populated 0002 upgrade preserve historical costs",
	async () => {
		if (!postgresUrl) throw new Error("Explicit PostgreSQL test URL required");
		const admin = new SQL(postgresUrl);
		const journal = JSON.parse(
			readFileSync(resolve(root, "drizzle-postgres/meta/_journal.json"), "utf8"),
		) as { entries: { tag: string }[] };
		const migrations = journal.entries.map((entry) =>
			readFileSync(resolve(root, `drizzle-postgres/${entry.tag}.sql`), "utf8"),
		);
		const target = journal.entries.findIndex((entry) => entry.tag === "0003_reference_cost_status");
		expect(target).toBeGreaterThan(0);
		const names = [`reference_cost_fresh_${process.pid}`, `reference_cost_upgrade_${process.pid}`];
		try {
			for (const [index, name] of names.entries()) {
				await admin.unsafe(`CREATE DATABASE "${name}"`);
				const url = new URL(postgresUrl);
				url.pathname = `/${name}`;
				const db = new SQL(url.toString());
				try {
					for (const migration of migrations.slice(0, target)) {
						for (const statement of migration
							.split("--> statement-breakpoint")
							.filter((value) => value.trim()))
							await db.unsafe(statement);
					}
					if (index === 1) {
						await db`INSERT INTO api_requests (id, cost_usd, created_at) VALUES ('history', 12.5, '2026-01-01')`;
						await db`INSERT INTO credential_usage_totals (id, provider, credential_id, model, cost_usd, unpriced_request_count, first_seen_at, last_seen_at) VALUES ('history', 'openai', 'fixture', 'old', 20, 2, '2026-01-01', '2026-01-01')`;
					}
					for (const migration of migrations.slice(target)) {
						for (const statement of migration
							.split("--> statement-breakpoint")
							.filter((value) => value.trim()))
							await db.unsafe(statement);
					}
					const [columns] =
						await db`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND column_name='cost_status'`;
					expect(columns.n).toBe(3);
					if (index === 1) {
						const [row] =
							await db`SELECT cost_usd, cost_status, cost_missing_fields FROM api_requests WHERE id='history'`;
						expect(row).toEqual({ cost_usd: 12.5, cost_status: null, cost_missing_fields: null });
						const [total] =
							await db`SELECT cost_usd, unpriced_request_count, partial_request_count FROM credential_usage_totals WHERE id='history'`;
						expect(total).toEqual({
							cost_usd: 20,
							unpriced_request_count: 2,
							partial_request_count: 0,
						});
					}
					await db`INSERT INTO user_usage_totals(user_id, cost_usd, partial_request_count, first_used_at, last_used_at) VALUES ('fixture', 1, 1, '2026-01-01', '2026-01-01')`;
					const [newTotal] =
						await db`SELECT partial_request_count FROM user_usage_totals WHERE user_id='fixture'`;
					expect(newTotal.partial_request_count).toBe(1);
				} finally {
					await db.close();
				}
			}
		} finally {
			for (const name of names) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
			await admin.close();
		}
	},
	120_000,
);
