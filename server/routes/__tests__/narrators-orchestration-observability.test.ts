import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE_SOURCE = readFileSync(join(import.meta.dir, "..", "narrators.ts"), "utf8");

describe("编排观测路由契约", () => {
	test("暴露有界的 status 与 usage 查询入口", () => {
		expect(ROUTE_SOURCE).toContain('narratorRoutes.get("/:id/orchestration/status"');
		expect(ROUTE_SOURCE).toContain('narratorRoutes.get("/:id/orchestration/usage"');
		expect(ROUTE_SOURCE).toContain("readOrchestrationStatus(id, { runLimit })");
		expect(ROUTE_SOURCE).toContain("readOrchestrationUsage(id)");
	});

	test("观测路由不读取 request dump 大字段", () => {
		const routeBlock = ROUTE_SOURCE.slice(
			ROUTE_SOURCE.indexOf('narratorRoutes.get("/:id/orchestration/status"'),
			ROUTE_SOURCE.indexOf("// Update permission mode"),
		);
		expect(routeBlock).not.toContain("rawDumpJson");
		expect(routeBlock).not.toContain("contentJson");
	});
});
