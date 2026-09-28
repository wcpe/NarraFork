import { useEffect, useState } from "react";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import {
	applyOrchestrationWorkerUpdate,
	EMPTY_ORCHESTRATION_WORKER_OVERLAY,
	type OrchestrationWorkerLiveOverlay,
	readOrchestrationWorkerUpdate,
} from "../lib/orchestration-worker-live";

/**
 * 编排 worker 的实时覆盖层。
 *
 * 两条自我约束写在最前面，因为它们决定了这个 hook 不该长成什么样：
 * - **不为每只 worker 单独订阅**。worker 是随会话增长的，一 worker 一订阅等于
 *   一 worker 一条订阅帧，且每只消失的 worker 都要有人记得退订。这里只订阅
 *   **父叙述者**这一个 id，用 `subagentNarratorId` 分派到具体 worker；
 * - **不开新的连接**。全部帧都走 `narratorWSManager` 那条共享连接（父级面板、
 *   背景任务列表、终端也都在用它），因此不存在"面板一开就多一条 socket"。
 *
 * `lastEventAtMs` 由调用方拿去决定轮询间隔：事件在流动时轮询降级为低频兜底，
 * 长时间没事件才回到基线间隔。这样"实时"来自事件，而不是来自更快的轮询。
 */
export function useOrchestrationWorkerLive(
	narratorId: string,
	enabled: boolean,
): {
	overlay: OrchestrationWorkerLiveOverlay;
	lastEventAtMs: number | null;
	disconnected: boolean;
} {
	const [overlay, setOverlay] = useState<OrchestrationWorkerLiveOverlay>(
		EMPTY_ORCHESTRATION_WORKER_OVERLAY,
	);
	const [lastEventAtMs, setLastEventAtMs] = useState<number | null>(null);
	const [disconnected, setDisconnected] = useState(narratorWSManager.disconnected);

	useEffect(() => {
		// 关闭或切换会话时清空：上一个会话的覆盖值挂在新会话的清单上会显示错数据。
		setOverlay(EMPTY_ORCHESTRATION_WORKER_OVERLAY);
		setLastEventAtMs(null);
		if (!enabled || !narratorId) return;
		setDisconnected(narratorWSManager.disconnected);
		const removeConnectionListener = narratorWSManager.onConnectionChange((connected) => {
			setDisconnected(!connected || narratorWSManager.disconnected);
		});

		const subscription = narratorWSManager.subscribe([narratorId], { kind: "panel" });
		const listener = narratorWSManager.addListener(
			{
				narratorIds: [narratorId],
				types: ["orchestration_observation", "subagent_status_changed", "context_usage"],
			},
			(frame) => {
				const receivedAtMs = Date.now();
				// 不认识/不属于本父级的帧在这里被丢掉：读不出归属时**宁可什么都不做**，
				// 也不能把它算到别的 worker 或父级头上。
				const update = readOrchestrationWorkerUpdate(frame, narratorId, receivedAtMs);
				if (!update) return;
				setOverlay((current) => applyOrchestrationWorkerUpdate(current, update));
				setLastEventAtMs(receivedAtMs);
			},
		);

		return () => {
			narratorWSManager.removeListener(listener);
			narratorWSManager.unsubscribe(subscription);
			removeConnectionListener();
		};
	}, [enabled, narratorId]);

	return { overlay, lastEventAtMs, disconnected };
}
