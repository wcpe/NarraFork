import { describe, expect, test } from "bun:test";
import { normalizeUsageSemantics } from "./usage-semantics";

describe("usage semantics", () => {
	test("normalizes provider fixtures without changing raw field meanings", () => {
		const fixture = {
			inputTokens: 1_000,
			cachedInputTokens: 250,
			cacheCreationInputTokens: 100,
			cacheCreation5mInputTokens: 60,
			cacheCreation1hInputTokens: 40,
		};
		expect(normalizeUsageSemantics(fixture, "anthropic")).toEqual({
			semantics: "cache-exclusive",
			unknown: false,
			uncachedInput: 1_000,
			cachedInput: 250,
			cacheWrite5m: 60,
			cacheWrite1h: 40,
			totalInput: 1_350,
			cacheReadRate: 0.2,
		});

		for (const provider of ["openai", "codex", "nug", "gemini"]) {
			expect(normalizeUsageSemantics(fixture, provider)).toMatchObject({
				semantics: "cache-inclusive",
				unknown: false,
				uncachedInput: 750,
				cachedInput: 250,
				totalInput: 1_100,
				cacheReadRate: 0.25,
			});
		}
	});

	test("marks unknown providers instead of guessing cache inclusion", () => {
		expect(
			normalizeUsageSemantics({ inputTokens: 100, cachedInputTokens: 25 }, "future-provider"),
		).toEqual({
			semantics: "unknown",
			unknown: true,
			uncachedInput: 100,
			cachedInput: 25,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
			totalInput: 125,
			cacheReadRate: 0.2,
		});
	});

	test("clamps negative and missing values and prevents negative uncached input", () => {
		expect(
			normalizeUsageSemantics(
				{
					inputTokens: -10,
					cachedInputTokens: 200,
					cacheCreationInputTokens: -1,
				},
				"openai",
			),
		).toMatchObject({
			uncachedInput: 0,
			cachedInput: 200,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
			totalInput: 200,
			cacheReadRate: 1,
		});
		expect(normalizeUsageSemantics({}, "anthropic")).toMatchObject({
			uncachedInput: 0,
			cachedInput: 0,
			totalInput: 0,
			cacheReadRate: 0,
		});
	});
});
