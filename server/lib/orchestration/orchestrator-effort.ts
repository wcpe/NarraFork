/**
 * 编制者的思考强度（读取侧）。
 *
 * 编制者是一个 **primary 会话**，它的强度没有别的运行时通道：会话装配读
 * `narrators.reasoning_effort`，为空就回落到 `resolveDefaultReasoningEffort`。
 * 因此本模块只提供"配置里有没有给定一个值"这一件事，由会话装配与运行期刷新
 * 把它插进既有的那条回落链（**用户显式选择 > 编排配置 > provider 默认**）。
 *
 * 刻意**不**把值写进 `narrators.reasoning_effort`：
 * - 那个列是"用户为这个会话显式选的值"，写进去会让"用户在设置页改了强度"
 *   与"用户给这个会话手动选了强度"变成同一份数据，退出编排后也退不回来；
 * - 配置改了而会话还活着时，写库的那份会一直是旧值（settings 的修订号推不动
 *   一个已经落库的字段），表现为"改了设置但没生效"。
 */

import { settings } from "@server/lib/settings";
import { firstUsableOrchestratorModel } from "@shared/orchestration-orchestrator-model";
import type { ReasoningEffort } from "@shared/reasoning-effort";

/**
 * 当前配置下编制者应使用的思考强度；未配置（含配错）返回 `null`。
 *
 * `null` 的语义是"没有配置侧的意见"，调用方据此继续往 provider 默认回落——
 * 而不是"用最低档"。
 *
 * 入参是会话的编排方案 id（`model` 哨兵解析出来的那一个）：传空就返回 `null`。
 * 把"只有编排会话才读这份配置"这条规则收在这里（而不是让每个调用点各自判断
 * 自己是不是编制者），漏判的后果是普通会话莫名继承了编排的强度。
 *
 * 每次调用都重新读一次设置（与 `runtime.ts` 同一条约定）：缓存整个设置对象
 * 会让改配置后的行为停在旧值，而"改完设置没生效"在界面上完全看不出。
 */
export function resolveConfiguredOrchestratorReasoningEffort(
	profileId: string | null | undefined,
): ReasoningEffort | null {
	if (!profileId) return null;
	return (
		firstUsableOrchestratorModel(settings.agent?.orchestration?.orchestratorModels)
			?.reasoningEffort ?? null
	);
}
