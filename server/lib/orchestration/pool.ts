/**
 * 模型池选取：纯函数，无 IO、无全局状态、无 `Date.now`。
 *
 * 容量均摊的核心在这里——同一优先级下优先挑在飞数最少的模型，避免把负载
 * 全压到池子里的第一个条目上。
 */

import type { OrchestrationPoolEntry } from "./types";

export interface PoolSelectionInput {
	pool: readonly OrchestrationPoolEntry[];
	/** 当前在飞计数快照：model → 正在运行数。缺失视同 0。 */
	inFlight: ReadonlyMap<string, number>;
}

export type PoolSelection =
	| {
			kind: "selected";
			model: string;
			entry: OrchestrationPoolEntry;
			effectivePriority: number;
			inFlight: number;
	  }
	| {
			kind: "waiting";
			blockedBy: Array<{ model: string; inFlight: number; maxConcurrent: number }>;
	  }
	| { kind: "empty" };

/** 优先级缺省值：省略视同 1。 */
function effectivePriorityOf(entry: OrchestrationPoolEntry): number {
	return entry.priority ?? 1;
}

/**
 * 归一化并发上限。
 *
 * `0` 与负数都表示不限——负数按不限处理是容错，避免手写设置把池子锁死。
 */
function limitOf(entry: OrchestrationPoolEntry): number {
	return entry.maxConcurrent ?? 0;
}

/**
 * 按 model 去重，保留首次出现的条目。
 *
 * 同一池子里重复写同一个模型（手动编辑设置时很常见）不应被当成两个候选，
 * 否则并发计数会被重复累加、容量判断随条目数膨胀。
 */
function dedupeByModel(pool: readonly OrchestrationPoolEntry[]): OrchestrationPoolEntry[] {
	const seen = new Set<string>();
	const result: OrchestrationPoolEntry[] = [];
	for (const entry of pool) {
		if (!entry || typeof entry.model !== "string") continue;
		if (seen.has(entry.model)) continue;
		seen.add(entry.model);
		result.push(entry);
	}
	return result;
}

/** 模型名字典序比较（用码元序而非 locale 比较，保证跨环境确定性）。 */
function compareModel(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/**
 * 从池里选一个可用模型。
 *
 * 选取规则依次为：优先级最小 → 在飞数最小 → 模型名字典序最小。
 * 最后一级是为了让结果完全确定，测试与复现才有依据。
 */
export function selectModelFromPool(input: PoolSelectionInput): PoolSelection {
	const entries = dedupeByModel(input.pool);
	if (entries.length === 0) return { kind: "empty" };

	const readInFlight = (model: string): number => input.inFlight.get(model) ?? 0;

	let best: OrchestrationPoolEntry | undefined;
	let bestPriority = 0;
	let bestInFlight = 0;

	for (const entry of entries) {
		const limit = limitOf(entry);
		const current = readInFlight(entry.model);
		// 不限（limit <= 0）永远可用；否则受并发上限约束
		if (limit > 0 && current >= limit) continue;

		const priority = effectivePriorityOf(entry);
		if (
			best === undefined ||
			priority < bestPriority ||
			(priority === bestPriority &&
				(current < bestInFlight ||
					(current === bestInFlight && compareModel(entry.model, best.model) < 0)))
		) {
			best = entry;
			bestPriority = priority;
			bestInFlight = current;
		}
	}

	if (best === undefined) {
		// 全部不可用：把受限条目按模型名升序报告给调用方，便于排队或提示。
		const blockedBy = entries
			.map((entry) => ({
				model: entry.model,
				inFlight: readInFlight(entry.model),
				maxConcurrent: limitOf(entry),
			}))
			.filter((item) => item.maxConcurrent > 0)
			.sort((a, b) => compareModel(a.model, b.model));
		return { kind: "waiting", blockedBy };
	}

	return {
		kind: "selected",
		model: best.model,
		entry: best,
		effectivePriority: bestPriority,
		inFlight: bestInFlight,
	};
}
