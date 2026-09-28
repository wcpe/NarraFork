import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { logger } from "../lib/logger";
import { resolveEffectiveModel, resolveProvider, settings } from "../lib/settings";
import { resolveSubagentModelForRun } from "./subagent-model";

/**
 * 压缩用模型的分层选择。
 *
 * 顺序即优先级：显式 override → 会话自己的模型 → `settings.agent.summaryModel`。
 * `summaryModel` 的角色因此变成「回落目标」：默认不再由它做压缩，但会话模型
 * 压缩失败时仍然由它兜底（以及标题生成等辅助任务，那条链不经过这里）。
 */
export type CompactModelSource = "explicit" | "session" | "summary";

export interface CompactModelLayers {
	/** 第一层（优先使用）的模型，已解析为真实 `provider:model`。 */
	primary: { model: string; source: CompactModelSource };
	/**
	 * 第二层（仅第一层失败时使用）。恒为 `settings.agent.summaryModel`；当它与
	 * 第一层是同一个模型时**不提供**，避免对同一个模型做一次毫无意义的重复调用。
	 */
	fallback?: { model: string };
}

/**
 * 把会话自己的 `model` 解析成能直接发请求的真实模型。
 *
 * 会话里存的可能是哨兵值（`__default__` / `__parent__` / `__agg__:*` /
 * `__orch__:*`），它们不能原样送进 provider —— 那会表现为"未知模型"，而真正的
 * 原因在设置或父链里。编排模式下会解析成**编制者的实际模型**，这正是用户要的
 * "当前会话自己的模型"。
 *
 * `__parent__` 只对子代理有意义且必须沿父链解析，因此走子代理那套既有解析
 * （`resolveSubagentModelForRun`），与 `narrator-session` 装配会话时用的入口一致。
 *
 * 解析失败（方案被删、父链断裂、配置错位等）**不抛错**，只记 WARN 并返回 null：
 * 那条会话本身已经坏了，此时让压缩整体失败只会把「模型没配好」升级成「上下文
 * 永远压不掉」，退化成改动前的行为（直接用 summaryModel）严格更好。
 */
async function resolveSessionModel(narratorId: string): Promise<string | null> {
	try {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { model: true, parentNarratorId: true, subagentType: true, ownerUserId: true },
		});
		if (!narrator) return null;
		if (narrator.model === FOLLOW_PARENT_MODEL) {
			return (await resolveSubagentModelForRun(narrator, narrator.ownerUserId)).model;
		}
		return resolveEffectiveModel(narrator.model, resolveProvider(narrator.model ?? undefined));
	} catch (err) {
		logger.warn("Failed to resolve the session model for compact; using the summary model", {
			narratorId,
			error: String(err),
		});
		return null;
	}
}

export async function resolveCompactModelLayers(
	narratorId: string,
	explicitModel?: string,
): Promise<CompactModelLayers> {
	const summaryModel = settings.agent.summaryModel;
	const override = explicitModel?.trim();
	const sessionModel = override ? null : await resolveSessionModel(narratorId);
	const primaryModel = override || sessionModel || summaryModel;
	const primarySource: CompactModelSource = override
		? "explicit"
		: sessionModel
			? "session"
			: "summary";
	return {
		primary: { model: primaryModel, source: primarySource },
		// 两层同一个模型时不做二次尝试：那既不是回落，也只会把同一个错误重复一遍。
		...(primaryModel === summaryModel ? {} : { fallback: { model: summaryModel } }),
	};
}
