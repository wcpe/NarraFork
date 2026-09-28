/**
 * OrchestrationUsageDetails 的呈现断言。
 *
 * 与同目录的 Popover 测试同一条分工：这个文件用 SSR 断言**数字怎么画**（这里是纯组件，
 * 没有事件处理器，所以 SSR 足够）；"点得开"那类事由
 * `OrchestrationStatusPopover.interaction.test.tsx` 负责。
 *
 * 重点守三件容易画错的事：
 * - 一次请求都没有时命中率必须是「—」，不是 0%（0% 会被读成"缓存坏了"）；
 * - 读取预算用尽时必须说明这是部分和，不能装作是全量；
 * - 三类输入必须分开显示——合起来就看不出前缀缓存有没有命中了。
 */

import { describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OrchestrationUsage, OrchestrationUsageBucket } from "@shared/orchestration-status";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import zh from "../../../locales/zh-CN/narrator.json";
import {
	cacheReadRate,
	formatTokens,
	OrchestrationUsageDetails,
	usageBucketTotalTokens,
} from "./OrchestrationUsageDetails";

/** 只用真实 zh-CN 文案做插值，因此这里不需要 i18n 实例。 */
const t = ((key: string, options?: Record<string, unknown>) => {
	const template = (zh as unknown as Record<string, string>)[key] ?? `missing:${key}`;
	if (!options) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ""));
}) as never;

function bucket(over: Partial<OrchestrationUsageBucket> = {}): OrchestrationUsageBucket {
	return {
		requests: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		...over,
	};
}

function usageWith(over: Partial<OrchestrationUsage> = {}): OrchestrationUsage {
	return {
		orchestrator: bucket({ requests: 3, inputTokens: 1000, outputTokens: 200 }),
		reviewers: bucket({ requests: 1, inputTokens: 300, cachedInputTokens: 2000, outputTokens: 20 }),
		tiers: {
			chore: bucket({ requests: 2, inputTokens: 500, cachedInputTokens: 4000, outputTokens: 50 }),
			quick: bucket({ requests: 1, inputTokens: 100, cachedInputTokens: 900, outputTokens: 30 }),
			medium: bucket(),
			heavy: bucket(),
		},
		// 与上面各块相加严格一致：面板会把这几块并排显示，对不上就是 bug。
		total: bucket({
			requests: 7,
			inputTokens: 1900,
			cachedInputTokens: 6900,
			cacheCreationInputTokens: 0,
			outputTokens: 300,
		}),
		childCount: 4,
		truncated: false,
		runDetails: [],
		...over,
	};
}

function render(details: {
	usage: OrchestrationUsage | null;
	loading?: boolean;
	failed?: boolean;
}): Element {
	const { document } = parseHTML(
		`<!doctype html><html><body><div id="r">${renderToStaticMarkup(
			<MantineProvider>
				<OrchestrationUsageDetails
					usage={details.usage}
					loading={details.loading ?? false}
					failed={details.failed ?? false}
					t={t}
				/>
			</MantineProvider>,
		)}</div></body>`,
	);
	const root = document.getElementById("r");
	if (!root) throw new Error("no root");
	return root as unknown as Element;
}

const text = (root: Element, testId: string) =>
	root.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

describe("formatTokens", () => {
	it("小数量原样给整数，大数量按 k / M 缩写", () => {
		expect(formatTokens(0, t)).toBe("0");
		expect(formatTokens(-5, t)).toBe("0");
		expect(formatTokens(999, t)).toBe("999");
		expect(formatTokens(1500, t)).toBe("1.5k");
		expect(formatTokens(2_500_000, t)).toBe("2.50M");
	});

	it("不随运行环境变化：同一输入在任何 ICU 下都得到同一个字符串", () => {
		// 用 toLocaleString 的话这里会是 "1,234"/"1 234"/"1234"，断言与截图都会飘。
		expect(formatTokens(1234, t)).toBe("1.2k");
	});
});

describe("cacheReadRate", () => {
	it("分母只包含未命中输入与缓存读取，不包含缓存写入", () => {
		expect(
			cacheReadRate(
				bucket({ inputTokens: 100, cachedInputTokens: 300, cacheCreationInputTokens: 1000 }),
			),
		).toBeCloseTo(0.75, 5);
	});

	it("没有任何可比较的读取输入时返回 null，而不是 0", () => {
		expect(cacheReadRate(bucket())).toBeNull();
		expect(cacheReadRate(bucket({ cacheCreationInputTokens: 500, outputTokens: 500 }))).toBeNull();
	});
});

describe("usageBucketTotalTokens", () => {
	it("缓存写入总量与 5m/1h 子项不重复相加", () => {
		expect(
			usageBucketTotalTokens(
				bucket({
					inputTokens: 100,
					cachedInputTokens: 200,
					cacheCreationInputTokens: 300,
					cacheCreation5mTokens: 180,
					cacheCreation1hTokens: 120,
					outputTokens: 400,
				}),
			),
		).toBe(1000);
	});
});

describe("OrchestrationUsageDetails", () => {
	it("分别给出请求数、三类输入与输出，并把三类输入显示成三行", () => {
		const root = render({ usage: usageWith() });
		expect(root.textContent).toContain(zh.orchestrationUsageCachedInput);
		expect(root.textContent).toContain(zh.orchestrationUsageCacheCreation);
		// 合计 = 1900 + 6900 + 0 + 300 = 9100 → 9.1k。
		expect(text(root, "orchestration-usage-total")).toBe("9.1k");
	});

	it("来源缺失时显示未知，不把 unknown 伪装成 0", () => {
		const root = render({ usage: usageWith() });
		expect(root.querySelector('[data-testid="orchestration-usage-sources"]')?.textContent).toBe(
			zh.orchestrationUsageSourcesUnknown,
		);
		expect(root.textContent).not.toContain("unknown 0");
	});

	it("复核者单列，好让「编制者 + 四档 + 复核 = 总计」在界面上看得出来", () => {
		const root = render({ usage: usageWith() });
		expect(root.textContent).toContain(zh.orchestrationUsageReviewers);
		// 复核者那一块的输入与档位块互不重叠：面板上必须同时看到两处。
		expect(root.textContent).toContain(zh.orchestrationUsageOrchestrator);
	});

	it("缓存读取率按未命中输入与缓存读取计算", () => {
		const root = render({ usage: usageWith() });
		// 6900 / (1900 + 6900) ≈ 0.784，缓存写入不进入分母。
		expect(text(root, "orchestration-usage-cache-rate")).toBe("78%");
		expect(text(root, "orchestration-usage-cache-rate-denominator")).toContain("不含缓存写入");
	});

	it("一次请求都没有时命中率是「—」而不是 0%", () => {
		const root = render({
			usage: usageWith({ orchestrator: bucket(), reviewers: bucket(), total: bucket() }),
		});
		expect(text(root, "orchestration-usage-cache-rate")).toBe(zh.orchestrationUsageNoData);
	});

	it("命中率偏低时补一句解释，而不是只摆一个数字", () => {
		const root = render({
			usage: usageWith({
				total: bucket({ inputTokens: 1000, cachedInputTokens: 10, outputTokens: 5 }),
			}),
		});
		expect(text(root, "orchestration-usage-cache-hint")).toBe(zh.orchestrationUsageCacheLowHint);
		// 命中率正常时不出现这句，否则它会变成噪声。
		const healthy = render({ usage: usageWith() });
		expect(healthy.querySelector('[data-testid="orchestration-usage-cache-hint"]')).toBeNull();
	});

	it("按档位分组给出次数与合计 token", () => {
		const root = render({ usage: usageWith() });
		// chore: 500 + 4000 + 0 + 50 = 4550 → 4.5k，2 次
		const chore = text(root, "orchestration-usage-tier-chore");
		expect(chore).toContain("2");
		expect(chore).toContain("4.5k");
		// 没跑过的档位如实给 0 次，而不是留白。
		expect(text(root, "orchestration-usage-tier-heavy")).toContain("0");
	});

	it("读取预算用尽时说明这是部分和", () => {
		const root = render({ usage: usageWith({ truncated: true, childCount: 500 }) });
		expect(text(root, "orchestration-usage-truncated")).toContain("500");
		expect(text(root, "orchestration-usage-truncated")).toContain("部分和");
		// 没被截断时不该出现这句话。
		expect(
			render({ usage: usageWith() }).querySelector('[data-testid="orchestration-usage-truncated"]'),
		).toBeNull();
	});

	it("加载中 / 读取失败 / 非编排会话分别是三句不同的话", () => {
		expect(text(render({ usage: null, loading: true }), "orchestration-usage-loading")).toBe(
			zh.orchestrationUsageLoading,
		);
		expect(text(render({ usage: null, failed: true }), "orchestration-usage-failed")).toBe(
			zh.orchestrationUsageFailed,
		);
		expect(text(render({ usage: null }), "orchestration-usage-unavailable")).toBe(
			zh.orchestrationUsageUnavailable,
		);
	});
});
