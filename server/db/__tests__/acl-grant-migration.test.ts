/**
 * Folding `knowledge_grants` + `narrator_grants` into `acl_grants`.
 *
 * This is the only step of the ACL unification that rewrites live authorization
 * data, so the properties pinned here are the ones whose violation would be either
 * an escalation or a silent lockout:
 *
 *  1. **A knowledge credential must not become a read capability.** Someone holding
 *     only a low clearance must NOT come out of the migration able to read
 *     everything. This is the single most dangerous way to get the mapping wrong.
 *  2. **`canWrite` does become a real write capability**, since it always was one.
 *  3. **Narrator grants map straight across**, read and write preserved.
 *  4. **Idempotent**: running the migration pass again changes nothing, and
 *     duplicates collapse rather than erroring.
 *  5. **Legacy tables survive**, so a bad migration is a code rollback.
 *  6. Projects come out `public` with no invented owner.
 *
 * 手法说明：这里**不再**把库回退到 0127（统一 ACL）之前再回放历史迁移序列 —— 基线重建后
 * 那条迁移已不存在，`ALTER TABLE projects DROP COLUMN owner_user_id` 也会被外键定义拒绝
 * （`error in table projects after drop column`）。断言改为直接指向真实运行时宿主：
 * `run-migrations.ts` 的 `migrateGrantsToUnifiedAcl` / `backfillProjectVisibility` /
 * `backfillCollectionProjectGate`（三者按原样导出，生产调用链一字未改）。需要「重启不得
 * 重放」语义的条目则跑真实的 `runMigrations`，因为那道闸门本就住在它里面。
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	backfillCollectionProjectGate,
	backfillProjectVisibility,
	migrateGrantsToUnifiedAcl,
	runMigrations,
} from "../run-migrations";

let sqlite: Database | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

interface AclRow {
	scope_type: string;
	scope_id: string | null;
	principal_type: string;
	principal_id: string;
	capability: string;
	domain_kind: string | null;
	domain_value: string | null;
}

function aclRows(db: Database, principalId: string): AclRow[] {
	return db
		.prepare(
			`SELECT scope_type, scope_id, principal_type, principal_id, capability,
			        domain_kind, domain_value
			   FROM acl_grants WHERE principal_id = ? ORDER BY capability, domain_value`,
		)
		.all(principalId) as AclRow[];
}

/** Whole table in a stable order, for "the pass changes nothing" comparisons. */
function allAclRows(db: Database): AclRow[] {
	return db
		.prepare(
			`SELECT scope_type, scope_id, principal_type, principal_id, capability,
			        domain_kind, domain_value
			   FROM acl_grants ORDER BY scope_type, scope_id, principal_id, capability, domain_value`,
		)
		.all() as AclRow[];
}

function countOf(db: Database, table: string): number {
	return (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/**
 * 一棵承载「升级前」授权数据的库：schema 用当前基线全量迁移建好，再把生产实例在升级前
 * 会持有的那些历史行写进遗留表（`knowledge_grants` / `narrator_grants` 至今仍随基线发布，
 * 正是为了让这一步可以被真实执行）。
 *
 * 这里刻意不写 `acl_grants` 的任何行：它就是 `migrateGrantsToUnifiedAcl` 开工前的状态。
 */
async function legacyAclDatabase(): Promise<Database> {
	const db = new Database(":memory:");
	await runMigrations(db);

	const now = "2026-07-19T00:00:00.000Z";
	db.run("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)", [
		"u-analyst",
		"analyst",
		"x",
		"user",
		now,
	]);
	db.run("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)", [
		"u-editor",
		"editor",
		"x",
		"user",
		now,
	]);
	db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)", [
		"p-1",
		"legacy project",
		now,
		now,
	]);
	db.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?,?,?)", ["n-1", now, now]);
	db.run(
		`INSERT INTO knowledge_collections (id, name, slug, default_level, created_at, updated_at)
		 VALUES (?,?,?,?,?,?)`,
		["c-1", "collection", "collection", "public", now, now],
	);

	// A clearance-only holder: the escalation case. No canWrite, no tags.
	db.run(
		`INSERT INTO knowledge_grants
		   (id, collection_id, principal_type, principal_id, grant_type, clearance_level, can_write, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		["kg-clearance", null, "user", "u-analyst", "clearance", "internal", 0, now],
	);
	// A tag grant that ALSO carries canWrite — one row, two meanings.
	db.run(
		`INSERT INTO knowledge_grants
		   (id, collection_id, principal_type, principal_id, grant_type, tag_id, can_write, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		["kg-tag-write", "c-1", "user", "u-editor", "tag", "tag-alpha", 1, now],
	);
	// A second canWrite row for the same principal and scope: must collapse.
	db.run(
		`INSERT INTO knowledge_grants
		   (id, collection_id, principal_type, principal_id, grant_type, tag_id, can_write, created_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		["kg-tag-write-2", "c-1", "user", "u-editor", "tag", "tag-beta", 1, now],
	);
	// Narrator grants: already plain capabilities.
	db.run(
		`INSERT INTO narrator_grants
		   (id, narrator_id, principal_type, principal_id, access, created_at)
		 VALUES (?,?,?,?,?,?)`,
		["ng-read", "n-1", "user", "u-analyst", "read", now],
	);
	db.run(
		`INSERT INTO narrator_grants
		   (id, narrator_id, principal_type, principal_id, access, created_at)
		 VALUES (?,?,?,?,?,?)`,
		["ng-write", "n-1", "user", "u-editor", "write", now],
	);
	return db;
}

describe("knowledge grants → acl_grants", () => {
	test("a clearance holder does NOT gain a read capability", async () => {
		sqlite = await legacyAclDatabase();

		migrateGrantsToUnifiedAcl(sqlite);

		const rows = aclRows(sqlite, "u-analyst");
		const knowledgeRows = rows.filter((r) => r.scope_type !== "narrator");
		// Exactly one row, and it is a credential — not an authorization.
		expect(knowledgeRows).toHaveLength(1);
		expect(knowledgeRows[0].domain_kind).toBe("clearance");
		expect(knowledgeRows[0].domain_value).toBe("internal");
		// No plain capability row (domain_kind IS NULL) was emitted for knowledge.
		expect(knowledgeRows.some((r) => r.domain_kind === null)).toBe(false);
	});

	test("a collection-less grant becomes a global-scoped credential", async () => {
		sqlite = await legacyAclDatabase();

		migrateGrantsToUnifiedAcl(sqlite);

		const row = aclRows(sqlite, "u-analyst").find((r) => r.domain_kind === "clearance");
		expect(row?.scope_type).toBe("global");
		expect(row?.scope_id).toBeNull();
	});

	test("tag credentials keep their collection scope", async () => {
		sqlite = await legacyAclDatabase();

		migrateGrantsToUnifiedAcl(sqlite);

		const tags = aclRows(sqlite, "u-editor").filter((r) => r.domain_kind === "tag");
		expect(tags.map((r) => r.domain_value).sort()).toEqual(["tag-alpha", "tag-beta"]);
		for (const tag of tags) {
			expect(tag.scope_type).toBe("knowledge_collection");
			expect(tag.scope_id).toBe("c-1");
		}
	});

	test("canWrite becomes one write capability, deduplicated across source rows", async () => {
		sqlite = await legacyAclDatabase();

		migrateGrantsToUnifiedAcl(sqlite);

		const writes = aclRows(sqlite, "u-editor").filter(
			(r) => r.capability === "write" && r.domain_kind === null && r.scope_id === "c-1",
		);
		// Two source rows carried can_write=1 for the same principal+scope → one row.
		expect(writes).toHaveLength(1);
	});
});

describe("narrator grants → acl_grants", () => {
	test("read and write map straight across", async () => {
		sqlite = await legacyAclDatabase();

		migrateGrantsToUnifiedAcl(sqlite);

		const analystNarrator = aclRows(sqlite, "u-analyst").filter((r) => r.scope_type === "narrator");
		expect(analystNarrator).toHaveLength(1);
		expect(analystNarrator[0]).toMatchObject({
			scope_id: "n-1",
			capability: "read",
			domain_kind: null,
		});

		const editorNarrator = aclRows(sqlite, "u-editor").filter((r) => r.scope_type === "narrator");
		expect(editorNarrator).toHaveLength(1);
		expect(editorNarrator[0].capability).toBe("write");
	});
});

describe("migration safety", () => {
	test("running the pass again changes nothing", async () => {
		sqlite = await legacyAclDatabase();
		migrateGrantsToUnifiedAcl(sqlite);
		const before = allAclRows(sqlite);
		expect(before.length).toBeGreaterThan(0);

		migrateGrantsToUnifiedAcl(sqlite);

		// 逐行相等，而不是只比总数：重复行/被冲掉的行都能被发现。
		expect(allAclRows(sqlite)).toEqual(before);
	});

	test("a grant revoked after migration is not resurrected on restart", async () => {
		// The gate is "acl_grants did not exist before this pass" (see `runMigrations`),
		// so a later restart must not re-import from the legacy tables — otherwise
		// revoking access would be undone by the next reboot.
		sqlite = await legacyAclDatabase();
		migrateGrantsToUnifiedAcl(sqlite);
		sqlite.run("DELETE FROM acl_grants WHERE scope_type = 'narrator' AND principal_id = ?", [
			"u-analyst",
		]);

		await runMigrations(sqlite);

		const rows = aclRows(sqlite, "u-analyst").filter((r) => r.scope_type === "narrator");
		expect(rows).toHaveLength(0);
		// 源表仍在（可回滚），所以「没被复活」只可能来自那道闸门，不可能来自源数据消失。
		expect(countOf(sqlite, "narrator_grants")).toBe(2);
	});

	test("the legacy tables are left intact for rollback", async () => {
		sqlite = await legacyAclDatabase();

		migrateGrantsToUnifiedAcl(sqlite);

		expect(countOf(sqlite, "knowledge_grants")).toBe(3);
		expect(countOf(sqlite, "narrator_grants")).toBe(2);
	});
});

describe("project visibility backfill", () => {
	test("existing projects become public with no invented owner", async () => {
		sqlite = await legacyAclDatabase();
		// 新行的默认值是 private，所以下面那条 UPDATE 必须真的生效才算数。
		expect(sqlite.prepare("SELECT visibility FROM projects WHERE id = ?").get("p-1")).toEqual({
			visibility: "private",
		});

		backfillProjectVisibility(sqlite);

		const row = sqlite
			.prepare("SELECT visibility, owner_user_id FROM projects WHERE id = ?")
			.get("p-1") as { visibility: string; owner_user_id: string | null };
		expect(row.visibility).toBe("public");
		expect(row.owner_user_id).toBeNull();
	});

	test("a project made private afterwards stays private across restarts", async () => {
		sqlite = await legacyAclDatabase();
		backfillProjectVisibility(sqlite);
		// 前提：无主（否则下面的回填根本不会碰这一行，测试就会因错误的原因变绿）。
		expect(sqlite.prepare("SELECT owner_user_id FROM projects WHERE id = ?").get("p-1")).toEqual({
			owner_user_id: null,
		});
		sqlite.run("UPDATE projects SET visibility = 'private' WHERE id = ?", ["p-1"]);

		await runMigrations(sqlite);

		const row = sqlite.prepare("SELECT visibility FROM projects WHERE id = ?").get("p-1") as {
			visibility: string;
		};
		expect(row.visibility).toBe("private");
	});

	test("collections created before project ACLs do not inherit the project gate", async () => {
		// The column defaults to true for new rows, but existing collections must come
		// out false or a migration would silently hide readable content.
		sqlite = await legacyAclDatabase();
		expect(
			sqlite
				.prepare("SELECT inherit_project_gate AS g FROM knowledge_collections WHERE id = ?")
				.get("c-1"),
		).toEqual({ g: 1 });

		backfillCollectionProjectGate(sqlite);

		const row = sqlite
			.prepare("SELECT inherit_project_gate AS g FROM knowledge_collections WHERE id = ?")
			.get("c-1") as { g: number };
		expect(row.g).toBe(0);
	});
});
