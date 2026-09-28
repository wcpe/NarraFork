import type { OrchestrationUsage } from "@shared/orchestration-status";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** 某个编排会话的开销查询键；与状态查询键分开，两者互不覆盖对方的缓存。 */
export const orchestrationUsageQueryKey = (narratorId: string) =>
	["orchestration-usage", narratorId] as const;

/**
 * 编排会话的 token 开销（只读观测）。
 *
 * 与 `useOrchestrationStatus` 同一条取舍：**挂载不拉，打开才拉**。区别在于刷新频率
 * 刻意更低（默认 30 秒而不是 10 秒）——开销是累计值，它只在一次派发结束时跳一下，
 * 而它背后的查询是一次分组聚合，比容量快照贵。面板常开着时，10 秒一次纯观测的聚合
 * 查询是拿主线程的 SQLite 时间去换一个几乎不变的数字。
 *
 * 不做窗口焦点重取：开销没有推送通道，焦点回来时数值通常没变。
 */
export function useOrchestrationUsage(
	narratorId: string,
	options: { enabled: boolean; refetchIntervalMs?: number },
) {
	return useQuery<OrchestrationUsage | null>({
		queryKey: orchestrationUsageQueryKey(narratorId),
		queryFn: async () => (await api.getOrchestrationUsage(narratorId)).usage,
		enabled: options.enabled,
		refetchOnWindowFocus: false,
		staleTime: 0,
		refetchInterval: options.enabled ? (options.refetchIntervalMs ?? 30_000) : false,
	});
}
