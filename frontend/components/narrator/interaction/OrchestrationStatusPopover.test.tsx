/**
 * OrchestrationStatusPopover.test.tsx — 编排状态详情面板的呈现。
 *
 * 面板的价值在于"数字不能被渲染成看起来像数字的东西"：不限（`maxConcurrent: null`）
 * 如果被画成 `0`，用户会以为池子锁死了；空池如果被画成空白，用户会以为还没加载。
 * 这两条是这里断言的重点，其余是 i18n 接线。
 */

import { describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OrchestrationStatus } from "@shared/orchestration-status";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import zh from "../../../locales/zh-CN/narrator.json";
import { OrchestrationStatusDetails } from "./OrchestrationStatusPopover";

function render(details: {
	status: OrchestrationStatus | null;
	loading?: boolean;
	failed?: boolean;
}): Element {
	const { document } = parseHTML(
		`<!doctype html><html><body><div id="r">${renderToStaticMarkup(
			<MantineProvider>
				<OrchestrationStatusDetails
					status={details.status}
					loading={details.loading ?? false}
					failed={details.failed ?? false}
					// 只用真实的 zh-CN 文案做插值，因此这里不需要 i18n 实例。
					t={
						((key: string, options?: Record<string, unknown>) => {
							// 语言包里有嵌套对象，因此先按 unknown 收窄再取值。
							const template = (zh as unknown as Record<string, string>)[key] ?? `missing:${key}`;
							if (!options) return template;
							return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ""));
						}) as never
					}
				/>
			</MantineProvider>,
		)}</div></body>`,
	);
	const root = document.getElementById("r");
	if (!root) throw new Error("no root");
	return root as unknown as Element;
}

function statusWith(over: Partial<OrchestrationStatus> = {}): OrchestrationStatus {
	const emptyTier = () => ({
		runs: 0,
		finished: 0,
		totalDurationMs: 0,
		avgDurationMs: null,
		reused: 0,
		failed: 0,
	});
	return {
		profileId: "of7k2m9q",
		profileName: "省成本",
		orchestratorModel: "provA:orchestrator",
		tiers: {
			chore: { parked: 0, running: 0 },
			quick: { parked: 2, running: 1 },
			medium: { parked: 0, running: 1 },
			heavy: { parked: 0, running: 0 },
		},
		pools: {
			chore: [],
			quick: [
				{ model: "provA:cheap", inFlight: 1, maxConcurrent: 3 },
				{ model: "provA:any", inFlight: 0, maxConcurrent: null },
			],
			medium: [],
			heavy: [],
		},
		// Popover 是速览，刻意**不**展示逐 worker 明细（那是 dock 面板的职责），
		// 因此这里用一份空清单就足以表达"它有这个字段但速览不画它"。
		workers: [],
		workerCount: 0,
		workersTruncated: false,
		runs: {
			aggregate: {
				chore: { ...emptyTier(), runs: 2, finished: 2, totalDurationMs: 3000, avgDurationMs: 1500 },
				quick: {
					...emptyTier(),
					runs: 1,
					finished: 1,
					totalDurationMs: 12_000,
					avgDurationMs: 12_000,
					reused: 1,
				},
				medium: emptyTier(),
				heavy: { ...emptyTier(), runs: 1, failed: 1 },
			},
			recent: [
				{
					id: "run-1",
					tier: "quick",
					phase: "reviewed",
					model: "provA:cheap",
					workerNarratorId: "w1",
					reusedWorker: true,
					verdict: "pass",
					error: null,
					startedAt: "2026-01-01T00:00:00.000Z",
					finishedAt: "2026-01-01T00:00:12.000Z",
					durationMs: 12_000,
				},
				{
					id: "run-2",
					tier: "heavy",
					phase: "failed",
					model: "provA:strong",
					workerNarratorId: null,
					reusedWorker: false,
					verdict: null,
					error: "boom",
					startedAt: "2026-01-01T00:01:00.000Z",
					// 未收尾：耗时必须是「—」而不是 0ms。
					finishedAt: null,
					durationMs: null,
				},
			],
		},
		...over,
	};
}

const text = (root: Element, testId: string) =>
	root.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

describe("OrchestrationStatusDetails", () => {
	it("给出方案名与本轮编制者模型", () => {
		const root = render({ status: statusWith() });
		expect(root.textContent).toContain("省成本");
		expect(root.textContent).toContain("provA:orchestrator");
	});

	it("按档位给出「停放 / 在场」两个数", () => {
		const root = render({ status: statusWith() });
		expect(text(root, "orchestration-status-tier-quick-counts")).toBe("2 / 1");
		expect(text(root, "orchestration-status-tier-chore-counts")).toBe("0 / 0");
	});

	it("上限为空表示「不限」，不是 0", () => {
		const root = render({ status: statusWith() });
		expect(root.textContent).toContain(`${zh.orchestrationStatusUnlimited}`);
		// 有上限的条目照常给出「已用 / 上限」。
		expect(root.textContent).toContain("1 / 3");
	});

	it("空池给出明确的「空」而不是留白", () => {
		const root = render({ status: statusWith() });
		expect(text(root, "orchestration-status-pool-chore")).toContain(zh.orchestrationPoolEmpty);
	});

	it("未配置编制者模型时如实说明，不编模型名", () => {
		const root = render({ status: statusWith({ orchestratorModel: null }) });
		expect(root.textContent).toContain(zh.orchestrationStatusUnknownModel);
	});

	it("加载中 / 读取失败 / 非编排会话分别是三句不同的话", () => {
		expect(text(render({ status: null, loading: true }), "orchestration-status-loading")).toBe(
			zh.orchestrationStatusLoading,
		);
		expect(text(render({ status: null, failed: true }), "orchestration-status-failed")).toBe(
			zh.orchestrationStatusFailed,
		);
		// 服务端说"不在编排模式"时不能编造数字：这三条路径互斥且都有明确文案。
		expect(text(render({ status: null }), "orchestration-status-unavailable")).toBe(
			zh.orchestrationStatusUnavailable,
		);
	});

	it("派发审计按档位给出「次数 / 平均 / 复用」", () => {
		const root = render({ status: statusWith() });
		// 平均耗时只在有已收尾的派发时给出；1500ms 显示为 1.5s。
		expect(text(root, "orchestration-status-runs-chore")).toContain("2 次");
		expect(text(root, "orchestration-status-runs-chore")).toContain("1.5s");
		expect(text(root, "orchestration-status-runs-quick")).toContain("复用 1");
		// 一次都没收尾的档位：平均显示为「—」，不是 0s。
		expect(text(root, "orchestration-status-runs-heavy")).toContain(
			zh.orchestrationStatusDurationUnknown,
		);
	});

	it("最近派发给出阶段与耗时，未收尾的那条不画成 0ms", () => {
		const root = render({ status: statusWith() });
		const recent = text(root, "orchestration-status-recent");
		expect(recent).toContain(zh.orchestrationRunPhase_reviewed);
		expect(recent).toContain(zh.orchestrationStatusRunReused);
		expect(recent).toContain("12.0s");
		expect(recent).toContain(zh.orchestrationRunPhase_failed);
		expect(recent).not.toContain("0ms");
	});
});
