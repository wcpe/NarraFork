import { afterEach, describe, expect, mock, test } from "bun:test";
import { ORCHESTRATOR_TOOLS } from "@server/lib/orchestration/tier-definition";
import type { RuntimePolicy } from "@server/services/agent-runtime/policy";
import { resolveRuntimePolicy } from "@server/services/agent-runtime/policy";
import { isSpecUri, normalizeSpecPath } from "../../../spec-uri";
import type { ToolContext } from "../../types";

/**
 * 编排编制者的读写路径守卫：`Read` / `Write` / `Edit` 只允许 `spec://`，本地路径一律拒绝。
 *
 * 这是"编制者能维护任务清单"与"编制者既不读也不动项目代码"能同时成立的唯一方式：
 * 前者要求它有工具（否则每一轮 blocked/doing 续跑都在要求它做一件它做不到的事），
 * 后者要求这些工具只能落在 Dynamic Spec 上。约束放在工具自己的 execute 入口，
 * 因为可见性层（工具面）挡不住模型硬发一次调用。
 *
 * `Read` 是后加的那一半：它当初放行的理由只是"看自己的任务清单"，却是一把通用读锁，
 * 实测被拿去翻源码。因此这里对三个方向分别断言，并且**都要断言"没有走到本地后端"**——
 * 只看 isError 会把"守卫拦下了"和"后端自己读失败了"混为一谈，而后者恰恰是缺陷本体
 * （编制者越界读成功了，但结果恰好是个错误）。
 *
 * 全部依赖都做替身：本测试只关心"路径判定 + 是否落到本地读写路径"，
 * 真实 VFS 落盘与本地写事务由 spec-vfs-tools / file-change 各自的测试负责。
 */
const databaseAccess = mock(() => {
	throw new Error("Unexpected database access");
});
mock.module("../../../../db", () => ({ db: new Proxy({}, { get: databaseAccess }) }));

const localChange = mock(async (options: { filePath: string }) => ({
	output: `Wrote ${options.filePath}`,
	title: options.filePath,
}));
mock.module("../../../../services/file-change-runtime", () => ({
	executeLocalFileChange: localChange,
}));
mock.module("../../../../services/file-snapshot-service", () => ({
	ensureFileSnapshot: mock(async () => {}),
}));
mock.module("../../../../services/spec-broadcast", () => ({
	broadcastSpecChanged: mock(() => {}),
}));
mock.module("../task-reflection", () => ({
	consumeTaskReflectionGrant: mock(() => true),
}));
mock.module("../track-file-change", () => ({ trackFileChange: mock(async () => {}) }));

const docs = new Map<string, string>();
const virtualFile = (uri: string) => ({
	uri,
	path: normalizeSpecPath(uri),
	content: docs.get(uri) ?? "old text",
	readonly: false,
	builtin: false,
});
const readSpec = mock(async (_id: string, uri: string) => virtualFile(uri));
const writeSpec = mock(async (_id: string, uri: string, content: string) => {
	docs.set(uri, content);
	return virtualFile(uri);
});
mock.module("../../../../services/spec-vfs-service", () => ({
	specVfsService: {
		isSpecUri,
		normalizeSpecPath,
		readSpecFile: readSpec,
		writeSpecFile: writeSpec,
	},
}));

/**
 * 本地读后端替身。
 *
 * 读路径的断言必须能区分"守卫拦下了"与"真的走到了后端"：测试机上那个路径并不存在，
 * 两种情况都会得到一个 isError 结果，只断言 isError 会把缺陷整个放过去
 * （编制者越界读**成功**了，只是内容恰好读不到）。因此用调用次数分辨。
 */
const LOCAL_FILE_BODY = "local file body\n";
const statFile = mock(async (_path: string) => ({
	size: LOCAL_FILE_BODY.length,
	isDirectory: false,
}));
const readFileBytes = mock(async (_path: string, _options: unknown) => ({
	bytes: new TextEncoder().encode(LOCAL_FILE_BODY),
	truncated: false,
	totalSize: LOCAL_FILE_BODY.length,
}));

const { editTool } = await import("../edit");
const { writeTool } = await import("../write");
const { readTool } = await import("../read");

afterEach(() => {
	for (const fn of [databaseAccess, localChange, readSpec, writeSpec, statFile, readFileBytes])
		fn.mockClear();
	docs.clear();
});

const PROFILE_ID = "of7k2m9q";

const orchestratorPolicy = resolveRuntimePolicy({
	variant: "primary",
	extraToolNames: ORCHESTRATOR_TOOLS,
	orchestrationProfileId: PROFILE_ID,
});
const primaryPolicy = resolveRuntimePolicy({ variant: "primary" });
const subagentPolicy = resolveRuntimePolicy({ variant: "subagent", subagentType: "general" });

const baseBackend = {
	kind: "local",
	deviceId: "local",
	paths: {
		resolve: (_base: string, input: string) => input,
		dirname: () => "/tmp/orchestrator-spec-guard",
	},
	statFile,
	readFileBytes,
} as unknown as ReturnType<NonNullable<ToolContext["resolveBackend"]>>;

function contextOf(runtimePolicy: RuntimePolicy): ToolContext {
	return {
		narratorId: "orchestrator-spec-guard-test",
		currentToolUseId: "orchestrator-spec-guard-call",
		cwd: "/tmp/orchestrator-spec-guard",
		locale: "zh-CN",
		signal: new AbortController().signal,
		runtimePolicy,
		resolveBackend: () => baseBackend,
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

const LOCAL_PATH = "/tmp/orchestrator-spec-guard/project-file.ts";

describe("编制者上下文：本地路径被拒绝", () => {
	test("Write 与 Edit 都拒绝本地路径，并指向派发", async () => {
		const writeResult = await writeTool.execute(
			{ file_path: LOCAL_PATH, content: "changed" },
			contextOf(orchestratorPolicy),
		);
		expect(writeResult.isError).toBe(true);
		// 原文案是"只能写 Dynamic Spec（spec://）与计划文件"。计划目录那个例外已被移除
		// （见下面"计划文件目录不再是例外"），因此这里断言的是收窄后的措辞。
		expect(writeResult.output).toContain("只能写 Dynamic Spec（spec://）");
		expect(writeResult.output).toContain("项目文件必须派发给执行者");

		const editResult = await editTool.execute(
			{ file_path: LOCAL_PATH, old_string: "a", new_string: "b" },
			contextOf(orchestratorPolicy),
		);
		expect(editResult.isError).toBe(true);
		expect(editResult.output).toContain("只能写 Dynamic Spec");
		expect(editResult.output).toContain("派发给执行者");
		// 拒绝发生在任何本地写路径之前，不是一个"失败但已经动过手"的路径
		expect(localChange).not.toHaveBeenCalled();
	});

	test("被拒绝的调用不读取任何 Dynamic Spec 内容", async () => {
		await writeTool.execute(
			{ file_path: LOCAL_PATH, content: "changed" },
			contextOf(orchestratorPolicy),
		);
		expect(readSpec).not.toHaveBeenCalled();
		expect(writeSpec).not.toHaveBeenCalled();
	});
});

describe("编制者上下文：spec:// 路径放行", () => {
	test("Write 写 spec://tasks.json 成功", async () => {
		const result = await writeTool.execute(
			{
				file_path: "spec://tasks.json",
				content: `${JSON.stringify({ tasks: [{ text: "维护任务清单", status: "doing" }] }, null, "\t")}\n`,
			},
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("spec://tasks.json");
		expect(writeSpec).toHaveBeenCalledTimes(1);
		expect(localChange).not.toHaveBeenCalled();
	});

	test("Edit 改 spec://index.md 成功", async () => {
		const result = await editTool.execute(
			{ file_path: "spec://index.md", old_string: "old text", new_string: "new text" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("spec://index.md");
		expect(writeSpec).toHaveBeenCalledTimes(1);
		expect(localChange).not.toHaveBeenCalled();
	});
});

/**
 * 计划文件目录**不再是例外**（本轮语义变更）。
 *
 * 这里原来断言的是"放行"：那条例外是为"编制者先出计划 → 用户批准 → 才允许派发"
 * 的流程加的（计划模式把计划写进 `.narrafork/plans/` 再调 `ExitPlanMode`）。
 * 而那道关卡正是本轮要消除的缺陷——编制者停在那里等批准，什么都不干。计划模式工具
 * 已从 `ORCHESTRATOR_TOOLS` 移除，于是没有任何一条编制者路径会读或写计划文件
 * （计划的内容直接进 `Agent` 的 `prompt`），再留着这个例外就是一个没有消费者的权限。
 * 因此断言的**方向反了过来**：同一条路径现在必须被拒绝。这不是把断言放宽，而是
 * 语义确实变了——顺着旧断言留着放行，等于保住那条已经没人走的流程。
 */
describe("编制者上下文：计划文件目录不再是例外", () => {
	test("Write 写 .narrafork/plans/ 下的计划文件同样被拒绝", async () => {
		const planPath = "/tmp/orchestrator-spec-guard/.narrafork/plans/plan-abc123.md";
		const result = await writeTool.execute(
			{ file_path: planPath, content: "# 计划\n\n1. 派发探查\n" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("只能写 Dynamic Spec（spec://）");
		// 拒绝的证据是它没有走到本地写入，而不只是"报错了"
		expect(localChange).not.toHaveBeenCalled();
	});

	test("Read 读同一个计划文件同样被拒绝，并指向派发", async () => {
		const planPath = "/tmp/orchestrator-spec-guard/.narrafork/plans/plan-abc123.md";
		const result = await readTool.execute({ file_path: planPath }, contextOf(orchestratorPolicy));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("只能读 Dynamic Spec（spec://）");
		expect(statFile).not.toHaveBeenCalled();
	});

	test("计划目录之外的 .narrafork 路径仍然被拒绝", async () => {
		const result = await writeTool.execute(
			{
				file_path: "/tmp/orchestrator-spec-guard/.narrafork/settings.json",
				content: "{}",
			},
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("只能写 Dynamic Spec（spec://）");
		expect(localChange).not.toHaveBeenCalled();
	});

	test("名字里带 plans 的项目文件不会被误放行", async () => {
		const result = await writeTool.execute(
			{ file_path: "/tmp/orchestrator-spec-guard/src/plans.ts", content: "x" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(localChange).not.toHaveBeenCalled();
	});
});

/**
 * `Read` 的编制者守卫。
 *
 * 这是本轮新增的那一半：`Read` 当初放行的唯一理由是"编制者得看自己的任务清单"，
 * 但它是通用工具，实测被拿去翻源码，"编制者不干活"那条设计随之失效。
 */
describe("编制者上下文：Read 只认 spec://", () => {
	test("读本地源码被拒绝，错误文案指向 quick/chore 派发", async () => {
		const result = await readTool.execute({ file_path: LOCAL_PATH }, contextOf(orchestratorPolicy));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("只能读 Dynamic Spec（spec://）");
		expect(result.output).toContain(LOCAL_PATH);
		// 文案必须说清这件事该派给谁：只说"拒绝"会让模型换个工具再试
		expect(result.output).toContain("quick");
		expect(result.output).toContain("chore");
		// 关键：拒绝发生在任何本地读取之前。只断言 isError 是不够的——
		// 测试机上那个路径本来就读不到，越界读取成功时也会得到一个错误结果。
		expect(statFile).not.toHaveBeenCalled();
		expect(readFileBytes).not.toHaveBeenCalled();
	});

	test("读相对路径的源码同样被拒绝（守卫不只看绝对路径）", async () => {
		const result = await readTool.execute(
			{ file_path: "server/lib/orchestration/tier-prompts.ts" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("只能读 Dynamic Spec（spec://）");
		expect(statFile).not.toHaveBeenCalled();
	});

	test("读 spec://tasks.json 成功（这是它拿到 Read 的唯一理由）", async () => {
		const result = await readTool.execute(
			{ file_path: "spec://tasks.json" },
			contextOf(orchestratorPolicy),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("old text");
		expect(readSpec).toHaveBeenCalledTimes(1);
		expect(statFile).not.toHaveBeenCalled();
	});
});

describe("执行者与普通会话不受影响", () => {
	test("执行者（子代理）上下文里 runtimePolicy.orchestration 为 undefined，本地路径正常写入", async () => {
		expect(subagentPolicy.orchestration).toBeUndefined();
		const result = await writeTool.execute(
			{ file_path: LOCAL_PATH, content: "changed" },
			contextOf(subagentPolicy),
		);
		expect(result.isError).toBeFalsy();
		expect(localChange).toHaveBeenCalledTimes(1);
	});

	test("执行者（子代理）上下文里 Edit 本地路径同样正常", async () => {
		const result = await editTool.execute(
			{ file_path: LOCAL_PATH, old_string: "a", new_string: "b" },
			contextOf(subagentPolicy),
		);
		expect(result.isError).toBeFalsy();
		expect(localChange).toHaveBeenCalledTimes(1);
	});

	/**
	 * `Read` 守卫最要紧的一条不误伤：**执行者必须还能读源码**。
	 *
	 * 它们是唯一能看代码的角色，如果这条闸门按工具面形状（而不是结构化 profileId）
	 * 判定身份，quick/chore worker 会在同一瞬间全部失去眼睛——而症状是"子代理说
	 * 什么都查不到"，看上去像模型问题。
	 */
	test("执行者（子代理）上下文里 Read 本地源码正常读到内容", async () => {
		expect(subagentPolicy.orchestration).toBeUndefined();
		const result = await readTool.execute({ file_path: LOCAL_PATH }, contextOf(subagentPolicy));
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("local file body");
		expect(readFileBytes).toHaveBeenCalledTimes(1);
	});

	test("普通 primary 会话的本地写入不受影响", async () => {
		expect(primaryPolicy.orchestration).toBeUndefined();
		const result = await writeTool.execute(
			{ file_path: LOCAL_PATH, content: "changed" },
			contextOf(primaryPolicy),
		);
		expect(result.isError).toBeFalsy();
		expect(localChange).toHaveBeenCalledTimes(1);
	});

	test("普通 primary 会话的本地读取不受影响", async () => {
		const result = await readTool.execute({ file_path: LOCAL_PATH }, contextOf(primaryPolicy));
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("local file body");
	});

	test("只被 extraToolNames 收窄但没有 profileId 的会话不算编制者（身份取自结构化字段）", async () => {
		// 这条盯住"不要从工具面形状反推身份"：工具面看起来像编制者（被收窄成同一集合），
		// 但没有 orchestration.profileId，就不该被这条守卫拦下。
		const narrowed = resolveRuntimePolicy({
			variant: "primary",
			extraToolNames: ORCHESTRATOR_TOOLS,
		});
		expect(narrowed.orchestration).toBeUndefined();
		const result = await writeTool.execute(
			{ file_path: LOCAL_PATH, content: "changed" },
			contextOf(narrowed),
		);
		expect(result.isError).toBeFalsy();
		expect(localChange).toHaveBeenCalledTimes(1);

		// Read 守卫同一条判据：工具面长得像编制者不算编制者
		const readResult = await readTool.execute({ file_path: LOCAL_PATH }, contextOf(narrowed));
		expect(readResult.isError).toBeFalsy();
		expect(readResult.output).toContain("local file body");
	});
});
