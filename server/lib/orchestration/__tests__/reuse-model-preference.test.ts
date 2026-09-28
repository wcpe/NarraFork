/**
 * 复用候选的模型偏好（上下文与缓存优化的一项）。
 *
 * 复用唯一真正省下的东西是提示词前缀缓存，而**前缀缓存是按模型分开的**：把一个用 A 模型
 * 跑热的 worker 唤醒到 B 模型上，它整段历史必须被重新读一遍，前缀比新建一只还长。
 *
 * 所以这里钉住两件事，两件都会静默出错：
 * - 同模型的候选优先（否则多模型池会稳定地把缓存红利丢掉，而界面上"复用命中率"
 *   照样显示正常——复用确实命中了，只是那次复用什么都没省）；
 * - 池子里只有别的模型时**仍然复用**（这是偏好不是过滤，否则把一个还能用的 worker
 *   白白闲置，等于把这条优化变成功能回退）。
 */

import { describe, expect, test } from "bun:test";
import { type ParkedWorker, selectReusableWorker } from "../parking";

function worker(over: Partial<ParkedWorker> = {}): ParkedWorker {
	return {
		narratorId: "w1",
		parentNarratorId: "orch-1",
		profileId: "prof1",
		tier: "quick",
		model: "provA:cheap",
		lastUsedAt: 1,
		...over,
	};
}

const request = {
	parentNarratorId: "orch-1",
	profileId: "prof1",
	tier: "quick" as const,
	model: "provA:cheap",
};

describe("selectReusableWorker 的模型偏好", () => {
	test("同模型的候选胜过更晚使用过的异模型候选", () => {
		const fresh = worker({ narratorId: "other-model", model: "provB:cheap", lastUsedAt: 100 });
		const warm = worker({ narratorId: "same-model", model: "provA:cheap", lastUsedAt: 1 });
		// 按原来的"最近使用优先"会挑 other-model，但那一次复用必然全量重读历史。
		expect(selectReusableWorker([fresh, warm], request)?.narratorId).toBe("same-model");
	});

	test("两个候选同模型时退回原来的规则：最近使用优先", () => {
		const older = worker({ narratorId: "a", lastUsedAt: 5 });
		const newer = worker({ narratorId: "b", lastUsedAt: 9 });
		expect(selectReusableWorker([older, newer], request)?.narratorId).toBe("b");
		expect(selectReusableWorker([newer, older], request)?.narratorId).toBe("b");
	});

	test("两个候选都是异模型时仍然按最近使用优先（偏好只在两者不同时才起作用）", () => {
		const older = worker({ narratorId: "a", model: "provB:x", lastUsedAt: 5 });
		const newer = worker({ narratorId: "b", model: "provC:y", lastUsedAt: 9 });
		expect(selectReusableWorker([older, newer], request)?.narratorId).toBe("b");
	});

	test("池子里只有别的模型时照样复用：这是偏好，不是过滤", () => {
		const only = worker({ narratorId: "only-other", model: "provB:cheap" });
		expect(selectReusableWorker([only], request)?.narratorId).toBe("only-other");
		// 不传 model 时行为与从前完全一致（调用方可以显式关掉这条偏好）。
		const withoutModel = selectReusableWorker(
			[
				worker({ narratorId: "old", lastUsedAt: 1 }),
				worker({ narratorId: "recent", model: "provB:cheap", lastUsedAt: 7 }),
			],
			{ parentNarratorId: "orch-1", profileId: "prof1", tier: "quick" },
		);
		expect(withoutModel?.narratorId).toBe("recent");
	});

	test("lastUsedAt 完全相同时仍取 narratorId 字典序最小者（确定性不变）", () => {
		const a = worker({ narratorId: "aaa", model: "provB:x", lastUsedAt: 3 });
		const b = worker({ narratorId: "bbb", model: "provC:y", lastUsedAt: 3 });
		expect(selectReusableWorker([b, a], request)?.narratorId).toBe("aaa");
	});

	test("模型偏好不会放松那三条硬条件", () => {
		const crossParent = worker({ narratorId: "p2", parentNarratorId: "orch-2" });
		const crossProfile = worker({ narratorId: "pf2", profileId: "prof2" });
		const crossTier = worker({ narratorId: "t2", tier: "medium" });
		expect(selectReusableWorker([crossParent, crossProfile, crossTier], request)).toBeUndefined();
		// 同模型的候选混在里面也不能把不满足硬条件的候选带进来
		const good = worker({ narratorId: "good" });
		expect(selectReusableWorker([crossParent, good], request)?.narratorId).toBe("good");
	});

	test("不修改传入的数组与其中的项", () => {
		const candidates = [
			worker({ narratorId: "other", model: "provB:x", lastUsedAt: 100 }),
			worker({ narratorId: "same", lastUsedAt: 1 }),
		];
		const snapshot = JSON.parse(JSON.stringify(candidates));
		selectReusableWorker(candidates, request);
		expect(candidates).toEqual(snapshot);
	});
});
