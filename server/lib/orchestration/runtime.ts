/**
 * 编排运行时的进程级内存状态。
 *
 * 只保存「在飞计数」这一份易失状态；所有配置都每次从 settings 单例惰性读取，
 * 因此设置改动无需重启即可生效（缓存整个设置对象会让改配置后的行为停留在旧值）。
 */

import { settings } from "@server/lib/settings";

import { selectModelFromPool } from "./pool";
import {
	findEnabledProfileFrom,
	listEnabledProfilesFrom,
	type OrchestrationPoolEntry,
	type OrchestrationProfile,
	type OrchestrationTier,
} from "./types";

/** model → 当前在飞派发数。缺失即 0，不保留 0 值条目。 */
const inFlight = new Map<string, number>();

/** 读取当前启用的编排方案列表（过滤规则见 types.ts 的 listEnabledProfilesFrom）。 */
export function listEnabledProfiles(): OrchestrationProfile[] {
	// 每次调用都重新取一次，避免把设置快照缓存到模块作用域
	return listEnabledProfilesFrom(settings.agent?.orchestration?.profiles);
}

/** 按 id 取方案；不存在或未启用返回 undefined。 */
export function findEnabledProfile(
	profileId: string | null | undefined,
): OrchestrationProfile | undefined {
	return findEnabledProfileFrom(settings.agent?.orchestration?.profiles, profileId);
}

/** 由当前在飞计数构造一份快照；返回副本，调用方改不动内部状态。 */
export function inFlightSnapshot(): ReadonlyMap<string, number> {
	return new Map(inFlight);
}

/** 当前该模型的在飞数。 */
export function getInFlight(model: string): number {
	return inFlight.get(model) ?? 0;
}

/**
 * 记一次派发：对应模型计数 +1。
 *
 * 返回的释放函数必须放进 `finally`，且做了幂等守卫——`finally` 因异常路径重复
 * 执行时若减两次，计数会漂移成负数，容量判断随之失真。
 */
export function acquireModelSlot(model: string): () => void {
	inFlight.set(model, getInFlight(model) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const next = getInFlight(model) - 1;
		if (next > 0) inFlight.set(model, next);
		else inFlight.delete(model);
	};
}

/**
 * 从池里选一条完整的条目；池耗尽时返回 null（调用方决定排队或报错）。
 *
 * 为什么要返回**条目**而不只是模型名：池条目除了模型还携带思考强度
 * （`reasoningEffort`），而派发时那个值必须跟着模型一起流到子代理上。
 * 只返回模型名会让强度在选模这一步被永久丢掉——配置能存、界面能改、
 * 但任何一次派发都用不到它，这正是"配了不生效"最隐蔽的一种形态。
 */
export function selectPoolEntryForTier(
	profileId: string,
	tier: OrchestrationTier,
): OrchestrationPoolEntry | null {
	const profile = findEnabledProfile(profileId);
	if (!profile) return null;
	const pool = profile.tiers?.[tier]?.pool;
	if (!Array.isArray(pool)) return null;
	const selection = selectModelFromPool({ pool, inFlight: inFlightSnapshot() });
	return selection.kind === "selected" ? selection.entry : null;
}

/** 从池里选一个模型；池耗尽时返回 null。等价于 `selectPoolEntryForTier(...)?.model`。 */
export function selectModelForTier(profileId: string, tier: OrchestrationTier): string | null {
	return selectPoolEntryForTier(profileId, tier)?.model ?? null;
}

/** 仅供测试：清空在飞计数。 */
export function __resetInFlightForTests(): void {
	inFlight.clear();
}
