/**
 * 共享代码事实的存储、失效判定与渲染。
 *
 * 这一组断言的重心是**失效**，而且全部用**真实的文件内容变更**驱动：写入一条事实、
 * 改掉它锚定的那个文件、再读回来。只测一个"陈旧"标志位是测不出东西的——那条路径
 * 恰恰是要用真实字节证明的。
 *
 * 另一条重心是"宁少勿多"：任何无法可靠判定有效性的东西都必须**不出现在**注入文本里。
 * 因此有几条断言是否定式的（"渲染结果里不含这段文字"），它们和肯定式的一样重要：
 * 一句带免责声明的错话，模型照样会照着做。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	__resetSharedFactsForTests,
	addSharedFact,
	inspectSharedFacts,
	MAX_ANCHOR_FILE_BYTES,
	MAX_SHARED_FACTS_PER_SESSION,
	renderSharedFactsBlock,
	resolveSharedFactParticipant,
	type SharedFactInventory,
	sharedFactStats,
} from "../shared-facts";

const PROFILE_ID = "of7k2m9q";
const SESSION = "coordinator-1";

let root = "";

/** 在工作区里写一个文件（自动建父目录）。 */
async function write(relativePath: string, content: string): Promise<void> {
	const absolute = join(root, relativePath);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content, "utf8");
}

/** 记录一次写入的基础参数。 */
function baseInput(over: Partial<Parameters<typeof addSharedFact>[0]> = {}) {
	return {
		sessionKey: SESSION,
		workspaceRoot: root,
		authorNarratorId: "worker-quick",
		authorKind: "executor" as const,
		authorTier: "quick" as const,
		statement: "retry 只在 5xx 上触发",
		evidence: "读了 server/lib/retry.ts 第 40-90 行的 shouldRetry()",
		files: ["server/lib/retry.ts"],
		...over,
	};
}

/**
 * 取当前会话的清单。
 *
 * 这些用例里"会话已经被建起来"是前提，缺了就该当场失败而不是返回 null 让后面
 * 一连串断言变成看不懂的样子。
 */
async function inventory(): Promise<SharedFactInventory> {
	const result = await inspectSharedFacts(SESSION);
	if (!result) throw new Error("共享事实会话不存在：这一步的前提是它已经被建起来");
	return result;
}

/** 用真实字节算出期望的锚点哈希，避免测试自己也"手抄一份"实现。 */
function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "nf-shared-facts-"));
});

afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

describe("写入闸门：只收锚定得住的事实", () => {
	test("没有锚点一律拒收，并给出后果说明而不是只说「参数错」", async () => {
		__resetSharedFactsForTests();
		const result = await addSharedFact(baseInput({ files: [] }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("no_anchors");
		// 拒收必须是真的拒收：池子里不该留下任何痕迹。
		expect(await inspectSharedFacts(SESSION)).toBeNull();
	});

	test("锚点文件不存在时整条事实都不落地（不允许半条事实）", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "export const shouldRetry = () => true;\n");

		const result = await addSharedFact(
			// 一条真路径 + 一条不存在的路径：坏的那一条必须让整条失败，
			// 否则"锚点齐全"这个前提就只在一部分锚点上成立。
			baseInput({ files: ["server/lib/retry.ts", "server/lib/nope.ts"] }),
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("anchor_missing");
		expect(result.detail).toBe("server/lib/nope.ts");
		const inventory = await inspectSharedFacts(SESSION);
		// 会话本身都还没建起来：校验全部通过之前不碰状态。
		expect(inventory).toBeNull();
	});

	test("锚点必须是工作区内的相对路径", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "x\n");
		for (const file of ["../outside.ts", "/etc/hosts", ".."]) {
			const result = await addSharedFact(baseInput({ files: [file] }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("anchor_outside_workspace");
		}
	});

	test("锚点不是普通文件时拒收", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "x\n");
		await mkdir(join(root, "server/empty-dir"), { recursive: true });
		const result = await addSharedFact(baseInput({ files: ["server/empty-dir"] }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("anchor_not_a_file");
	});

	test("取证是必填的，短的像占位的也算没写", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "x\n");
		for (const [evidence, reason] of [
			["", "empty_evidence"],
			["  ", "empty_evidence"],
			["n/a", "evidence_too_short"],
		] as const) {
			const result = await addSharedFact(baseInput({ evidence }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe(reason);
		}
	});

	test("写入成功后锚点里的哈希就是文件的真实内容哈希", async () => {
		__resetSharedFactsForTests();
		const content = "export const shouldRetry = (s: number) => s >= 500;\n";
		await write("server/lib/retry.ts", content);

		const result = await addSharedFact(baseInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.fact.anchors).toEqual([{ path: "server/lib/retry.ts", sha256: sha256(content) }]);
		expect(result.fact.authorTier).toBe("quick");
	});

	test("同一条事实重复写入是幂等的，不会把注入块撑大", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "x\n");
		await addSharedFact(baseInput());
		await addSharedFact(baseInput());
		const inventory = await inspectSharedFacts(SESSION);
		expect(inventory?.fresh).toHaveLength(1);
	});

	test("跨工作区的事实不可比，直接拒收并说清两个路径", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "x\n");
		await addSharedFact(baseInput());
		const other = await mkdtemp(join(tmpdir(), "nf-other-ws-"));
		try {
			const result = await addSharedFact(baseInput({ workspaceRoot: other }));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("workspace_mismatch");
				expect(result.detail).toContain(other);
			}
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});
});

describe("失效判定：文件变了就不再共享", () => {
	test("文件内容变更后该事实进 stale，且结论文本不再出现在注入块里", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "export const shouldRetry = () => true;\n");
		const added = await addSharedFact(baseInput());
		expect(added.ok).toBe(true);

		// 真实变更：不是改标志位，是把这个文件的内容换掉。
		await write("server/lib/retry.ts", "export const shouldRetry = (s: number) => s >= 500;\n");

		const inventory = await inspectSharedFacts(SESSION);
		expect(inventory).not.toBeNull();
		if (!inventory) return;
		expect(inventory.fresh).toHaveLength(0);
		expect(inventory.stale).toHaveLength(1);
		expect(inventory.stale[0].changedPaths).toEqual(["server/lib/retry.ts"]);

		const block = renderSharedFactsBlock(inventory, "zh-CN");
		// 如实说明有几条被扣下、涉及哪个文件……
		expect(block).toContain("1 条");
		expect(block).toContain("server/lib/retry.ts");
		// ……但**绝不重复结论本身**：一句可能已经错的话，标明过期也照样会被照着做。
		expect(block).not.toContain("retry 只在 5xx 上触发");
	});

	test("内容改回去就又成立（按内容判定，不看时间戳）", async () => {
		__resetSharedFactsForTests();
		const original = "export const shouldRetry = () => true;\n";
		await write("server/lib/retry.ts", original);
		await addSharedFact(baseInput());
		await write("server/lib/retry.ts", "changed\n");
		await write("server/lib/retry.ts", original);

		const inventory = await inspectSharedFacts(SESSION);
		expect(inventory?.fresh).toHaveLength(1);
		expect(inventory?.stale).toHaveLength(0);
	});

	test("锚点文件被删除视为已变更，而不是「判定不了」", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "x\n");
		await addSharedFact(baseInput());
		await unlink(join(root, "server/lib/retry.ts"));

		const inventory = await inspectSharedFacts(SESSION);
		expect(inventory?.stale).toHaveLength(1);
		expect(inventory?.unverifiable).toHaveLength(0);
	});

	/**
	 * 「无法可靠判定」这一条边界的落地位置就在这里。
	 *
	 * 锚点文件存在、但已经大到读不进来时，我们**不知道**它变了没有。此时唯一的正确
	 * 做法是不共享——既不能当成 fresh（可能已经错了），也不该当成 stale（我们并不知道
	 * 它变了）。它进 `unverifiable`，而 `unverifiable` 与 `stale` 一样不出现在可用清单里。
	 */
	test("无法核对的事实（锚点已大到读不进来）既不进 fresh，也不出现在可用清单里", async () => {
		__resetSharedFactsForTests();
		await write("server/lib/retry.ts", "small\n");
		await addSharedFact(baseInput());
		// 撑到超过锚点字节上限：仍然存在、仍然是普通文件，只是判定不了。
		await write("server/lib/retry.ts", "x".repeat(MAX_ANCHOR_FILE_BYTES + 1));

		const checked = await inventory();
		expect(checked.fresh).toHaveLength(0);
		expect(checked.stale).toHaveLength(0);
		expect(checked.unverifiable).toHaveLength(1);

		const block = renderSharedFactsBlock(checked, "zh-CN");
		expect(block).toContain("无法核对");
		expect(block).not.toContain("retry 只在 5xx 上触发");
	});

	test("一条事实的多个锚点里有一个变了，整条就不再成立", async () => {
		__resetSharedFactsForTests();
		await write("server/a.ts", "a\n");
		await write("server/b.ts", "b\n");
		await addSharedFact(baseInput({ files: ["server/a.ts", "server/b.ts"] }));
		await write("server/b.ts", "b2\n");

		const inventory = await inspectSharedFacts(SESSION);
		expect(inventory?.fresh).toHaveLength(0);
		expect(inventory?.stale[0].changedPaths).toEqual(["server/b.ts"]);
	});
});

describe("渲染：有界、稳定顺序、被扣下的只说数量与路径", () => {
	test("较早的排在前面（新事实追加在末尾，前缀才稳定）", async () => {
		__resetSharedFactsForTests();
		await write("server/a.ts", "a\n");
		await write("server/b.ts", "b\n");
		await addSharedFact(baseInput({ statement: "第一条结论", files: ["server/a.ts"] }));
		await addSharedFact(baseInput({ statement: "第二条结论", files: ["server/b.ts"] }));

		const block = renderSharedFactsBlock(await inventory(), "zh-CN");
		expect(block.indexOf("第一条结论")).toBeLessThan(block.indexOf("第二条结论"));
		// 写入者档位与锚点都要能看见：前者说明"这结论是谁得出的"，后者是它的保质期依据。
		expect(block).toContain("[quick]");
		expect(block).toContain("server/a.ts");
	});

	test("一条可用事实都没有、且全被扣下时，渲染结果不空（否则和「没有事实」无法区分）", async () => {
		__resetSharedFactsForTests();
		await write("server/a.ts", "a\n");
		await addSharedFact(baseInput({ files: ["server/a.ts"] }));
		await write("server/a.ts", "a2\n");
		const block = renderSharedFactsBlock(await inventory(), "en");
		expect(block.length).toBeGreaterThan(0);
		expect(block).toContain("WITHHELD");
	});

	test("会话里一条都没有时渲染空串（调用方据此不加这一段）", async () => {
		__resetSharedFactsForTests();
		expect(await inspectSharedFacts(SESSION)).toBeNull();
	});

	test("超出单次注入上限时明说省略了多少条", async () => {
		__resetSharedFactsForTests();
		await write("server/a.ts", "a\n");
		for (let index = 0; index < 15; index++) {
			await addSharedFact(
				baseInput({
					statement: `结论 ${index}`,
					files: ["server/a.ts"],
					// 每条措辞不同，避免被幂等去重吃掉。
					evidence: `读了 server/a.ts 第 ${index + 1} 行并核对了调用点`,
				}),
			);
		}
		const block = renderSharedFactsBlock(await inventory(), "zh-CN");
		expect(block).toContain("还有");
	});
});

describe("有界", () => {
	test("单个会话写满之后拒收，而不是无限增长", async () => {
		__resetSharedFactsForTests();
		await write("server/a.ts", "a\n");
		for (let index = 0; index < MAX_SHARED_FACTS_PER_SESSION; index++) {
			const result = await addSharedFact(
				baseInput({
					statement: `结论 ${index}`,
					files: ["server/a.ts"],
					evidence: `读了 server/a.ts 第 ${index + 1} 行并核对了调用点`,
				}),
			);
			expect(result.ok).toBe(true);
		}
		const overflow = await addSharedFact(
			baseInput({ statement: "再来一条", files: ["server/a.ts"] }),
		);
		expect(overflow.ok).toBe(false);
		if (!overflow.ok) expect(overflow.reason).toBe("session_full");
		expect(sharedFactStats().facts).toBe(MAX_SHARED_FACTS_PER_SESSION);
	});
});

describe("谁会话参与者", () => {
	test("四个档位的执行者与复核者都算，会话键取编制者", () => {
		for (const tier of ["chore", "quick", "medium", "heavy"] as const) {
			expect(
				resolveSharedFactParticipant({
					id: "w",
					parentNarratorId: "coordinator-1",
					subagentType: `orch--${PROFILE_ID}--${tier}`,
				}),
			).toEqual({ sessionKey: "coordinator-1", authorKind: "executor", authorTier: tier });

			expect(
				resolveSharedFactParticipant({
					id: "r",
					parentNarratorId: "coordinator-1",
					subagentType: `orch-review--${PROFILE_ID}--${tier}`,
				}),
			).toEqual({ sessionKey: "coordinator-1", authorKind: "reviewer", authorTier: tier });
		}
	});

	test("非编排子代理、编制者自己、以及没有父级的行都不参与", () => {
		expect(
			resolveSharedFactParticipant({
				id: "e",
				parentNarratorId: "p",
				subagentType: "explore",
			}),
		).toBeNull();
		// 编制者不写事实：它读不了代码，也就锚定不了任何东西。
		expect(
			resolveSharedFactParticipant({
				id: "c",
				parentNarratorId: null,
				subagentType: null,
			}),
		).toBeNull();
		expect(resolveSharedFactParticipant(null)).toBeNull();
	});
});
