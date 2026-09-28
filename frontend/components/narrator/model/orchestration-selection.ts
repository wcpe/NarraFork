import { type ModelOption, parseOrchestrationModelValue } from "../../../lib/constants";

/**
 * 一次模型菜单选择该走哪条写入路径。
 *
 * 选编排方案必须走专用入口 `PATCH /:id/orchestration`：服务端拒绝把哨兵交给
 * `PATCH /:id/model`，那条路径会绕过「方案存在且启用、配了编制者模型、会话是
 * 主叙述者」这几道校验，写进去的坏值要到下次会话装配才炸。
 *
 * 反向（处于编排模式时点一个具体模型）刻意走普通 model PATCH，而不是先调一次
 * 「退出编排」再写模型：
 * - 普通写入本身就把 `model` 从哨兵换成所选模型，服务端 `updateNarratorModel`
 *   会同步清掉 `active._orchestrationProfileId`，不存在「model 里留着 `__orch__:`
 *   却已经不在编排模式」的悬挂状态；
 * - 「先退出再写」是两次请求，中间那一瞬会话停在默认模型上，既多一次可见的
 *   状态跳变，也多一条中途失败的路径。
 * 真正需要「退回默认模型语义」的显式退出，由菜单里的退出项调用
 * `updateNarratorOrchestration(id, null)`。
 */
export type ModelMenuIntent =
	| { kind: "orchestration"; profileId: string }
	| { kind: "model"; model: string };

/** 把菜单选择值分派成编排入口或普通模型入口。 */
export function resolveModelMenuIntent(value: string): ModelMenuIntent {
	const orchestration = parseOrchestrationModelValue(value);
	if (orchestration) return { kind: "orchestration", profileId: orchestration.profileId };
	return { kind: "model", model: value };
}

/**
 * 当前编排模式的方案显示名；不在编排模式时返回 null。
 *
 * 方案已从设置里删掉时退回 profileId：用户至少能看到会话「在哪个方案上」，
 * 而不是一个空白或一个伪造的模型名。
 */
export function orchestrationSelectionName(
	model: string | null | undefined,
	allModels: ModelOption[],
): string | null {
	const parsed = parseOrchestrationModelValue(model);
	if (!parsed) return null;
	const raw = (model ?? "").trim();
	return allModels.find((option) => option.value === raw)?.label ?? parsed.profileId;
}
