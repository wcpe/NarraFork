import type { OrchestrationStatus } from "@shared/orchestration-status";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** 某个编排会话的状态查询键；同一个会话只保留一份缓存。 */
export const orchestrationStatusQueryKey = (narratorId: string) =>
	["orchestration-status", narratorId] as const;

/**
 * 编排状态（只读观测）。
 *
 * 刻意**不**在挂载时就拉：状态是"用户想看时才需要"的观测数据，没有对应的 WS 变更
 * 事件，也没有任何东西依赖它做渲染决策。因此拉取由调用方按需开启（`enabled`），
 * 打开详情时才发生一次请求，此后按 `refetchIntervalMs` 低频刷新到关闭为止。
 *
 * 刷新频率刻意保守（秒级而不是请求级）：服务端每条池条目的在飞数是真实容量信号，
 * 但它变化得没那么快，而每个打开的会话面板都会轮询——多台客户端同时开着几个面板
 * 时，10 次/秒的纯观测请求足以把主线程的 SQLite 读排满。
 */
export function useOrchestrationStatus(
	narratorId: string,
	options: { enabled: boolean; refetchIntervalMs?: number },
) {
	return useQuery<OrchestrationStatus | null>({
		queryKey: orchestrationStatusQueryKey(narratorId),
		queryFn: async () => (await api.getOrchestrationStatus(narratorId)).orchestration,
		enabled: options.enabled,
		// 观测数据没有推送通道，靠 `refetchInterval` 保鲜；窗口焦点重取只会
		// 在切回来时多打一次请求，价值不大。
		refetchOnWindowFocus: false,
		staleTime: 0,
		refetchInterval: options.enabled ? (options.refetchIntervalMs ?? 10_000) : false,
	});
}
