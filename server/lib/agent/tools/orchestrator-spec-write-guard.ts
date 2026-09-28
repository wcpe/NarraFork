import { specVfsService } from "../../../services/spec-vfs-service";
import type { ToolContext, ToolResult } from "../types";

/**
 * 编排编制者的**读写路径守卫**：`Read` / `Write` / `Edit` 只认 `spec://`，本地路径一律拒绝。
 *
 * 存在的理由：编制者（`ORCHESTRATOR_TOOLS`）保留了这三个工具，因为 Dynamic Spec 的
 * 任务队列（`spec://tasks.json`）必须由它自己维护——系统级提醒每一轮都在要求这件事，
 * 一个工具都不给就只能空转。但"编制者不动项目代码"这条约束**不能只写在工具面上**：
 * 工具面只影响发给模型的工具数组，模型硬发一个未列出的调用时，只有执行期闸门拦得住
 * （同一道理见 `tool-executor.ts` 里 `config.allowedTools` 的注释）。因此把"只认
 * spec://"放在工具自己的 execute 入口，而不是靠"它看不到别的工具"。
 *
 * **为什么读也要拦**：`Read` 当初放行的唯一理由是"写任务清单得先看看清单"，
 * 而它是**通用**工具——实测中编制者拿它去翻源码，"编制者不干活"那条设计随之失效。
 * 只想读 `spec://` 却拿到一把万能读锁，这条边界就不可能靠提示词守住，所以它和写工具
 * 用同一套判定（`orchestratorSpecOnlyReadRejection`）。
 *
 * **为什么本地路径全部拒绝、连 `.narrafork/plans/` 也不例外**：这条例外是上一轮为
 * "编制者先出计划 → 用户批准 → 才允许派发"那条流程加的（计划模式把计划写进
 * `.narrafork/plans/` 再调 `ExitPlanMode`），而那条流程本身就是本轮要消除的缺陷：
 * 它让编制者停在等批准上什么都不干。计划模式工具已从 `ORCHESTRATOR_TOOLS` 移除，
 * 于是没有任何一条编制者路径会读或写计划文件——计划的内容直接进 `Agent` 的 `prompt`，
 * 即"派单本身就是计划"。此时再留一个计划目录例外，就是一个没有消费者的权限
 * （`ExitPlanMode` 的 `mode: "file"` 是它唯一的读方，而那把工具已经不在编制者手里）。
 * 用户仍可手动把某个叙述者切进计划模式，那条路径的出口是同一个 UI 开关
 * （`POST /api/narrators/:id/plan-mode/exit`），不依赖编制者的工具面。
 *
 * 判定身份用的是**结构化字段** `runtimePolicy.orchestration?.profileId`：
 * 子代理（执行者）的该字段为 undefined，所以既不会误伤它们，
 * 也不会因为"编制者的工具面又加了一个工具"而失效——从工具面形状反推身份
 * 正是本次修复要消灭的那类脆弱判断。
 *
 * 返回 null 表示放行；返回 `ToolResult` 表示拒绝，调用方应直接把它作为结果返回。
 */

/** 当前工具上下文是不是编排编制者。读写两个守卫必须用同一个判定。 */
function isOrchestratorContext(ctx: ToolContext): boolean {
	return !!ctx.runtimePolicy?.orchestration?.profileId;
}

/** `Write` / `Edit` 的编制者守卫：只放行 `spec://`。 */
export function orchestratorSpecOnlyRejection(
	ctx: ToolContext,
	filePath: string,
	toolName: string,
): ToolResult | null {
	if (!isOrchestratorContext(ctx)) return null;
	if (specVfsService.isSpecUri(filePath)) return null;
	return {
		output:
			`编排编制者只能写 Dynamic Spec（spec://），不能用 ${toolName} 修改这个路径：${filePath}。` +
			"项目文件必须派发给执行者（Agent 工具）去改，编制者自己不动项目代码。",
		isError: true,
	};
}

/**
 * `Read` 的编制者守卫：只放行 `spec://`。
 *
 * 文案刻意点名"派 quick / chore"而不是只说"不许读"：编制者读代码的动机是**想知道事**，
 * 一条只写着"拒绝"的错误只会让它换个工具再试；告诉它这件事该派给谁，才是把动机导到
 * 正确的路径上。而这两个档位正是它本来就该用的（见 `tier-prompts.ts` 的并行探查一节）。
 */
export function orchestratorSpecOnlyReadRejection(
	ctx: ToolContext,
	filePath: string,
): ToolResult | null {
	if (!isOrchestratorContext(ctx)) return null;
	if (specVfsService.isSpecUri(filePath)) return null;
	return {
		output:
			`编排编制者只能读 Dynamic Spec（spec://），不能用 Read 读取这个路径：${filePath}。` +
			'要了解代码，请派发 quick 子代理（tier: "quick"）去探查、chore 子代理' +
			'（tier: "chore"）去跑命令取证；编制者自己既不读也不改项目代码。',
		isError: true,
	};
}
