import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDynamicSpecSystemReminder,
	getSubagentParentReportingHint,
} from "../../lib/prompt-i18n";
import { MAX_PROJECT_INSTRUCTIONS_BYTES } from "../../lib/read-file-capped";
import { buildEffectiveSystemPrompt } from "../narrator-prompt";

describe("narrator prompt Dynamic Spec guidance", () => {
	test("injects Dynamic Spec usage into the effective system prompt", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-prompt-test-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
		});

		expect(prompt).toContain("# Dynamic Spec (`spec://`)");
		expect(prompt).toContain("spec://tasks.json");
		expect(prompt).not.toContain("spec://HOW_TO_USE_SPEC.md");
		expect(prompt).toContain('path: "spec://"');
		expect(prompt).toContain("Do not use Bash or Glob for `spec://` virtual files.");
	});

	test("has localized reminders for core Dynamic Spec rules", () => {
		const en = getDynamicSpecSystemReminder("en");
		const zh = getDynamicSpecSystemReminder("zh-CN");

		expect(en).toContain("`Read`, `Write`, `Edit`, and `Grep`");
		expect(en).toContain("Allowed statuses: `todo`, `doing`, `done`, `blocked`");
		expect(en).toContain("Every open task must be finite, executable");
		expect(en).toContain("may trigger auto-continuation while it stays open");
		expect(en).toContain("Standing behavior rules, prohibitions, and guardrails");
		expect(en).not.toContain("Do not bypass this requirement");
		expect(en).toContain("add a concrete actionable unblock task");
		expect(en).toContain("do not end the turn by merely explaining the blocker");
		expect(zh).toContain("直接用 `Read`、`Write`、`Edit`、`Grep`");
		expect(zh).toContain("允许的状态只有：`todo`、`doing`、`done`、`blocked`");
		expect(zh).toContain("每条开放任务都必须是有限、可执行");
		expect(zh).toContain("未完成时可能触发自动续跑");
		expect(zh).toContain("长期行为规则、禁止事项、安全护栏");
		expect(zh).not.toContain("不能绕过的要求");
		expect(zh).toContain("新增一个具体、可执行的解阻任务");
		expect(zh).toContain("不能只解释阻塞");
	});

	test("restricts protected to tasks the user demanded be guaranteed", () => {
		const en = getDynamicSpecSystemReminder("en");
		const zh = getDynamicSpecSystemReminder("zh-CN");

		expect(en).toContain("Set it ONLY when the user explicitly demanded");
		expect(en).toContain("a task you protected yourself becomes a commitment you cannot retract");
		expect(zh).toContain("只有当用户明确要求确保某个任务完成时才可设置");
		expect(zh).toContain("你自行设置的 protected 会变成无法撤回的承诺");
		// /goal is resolved server-side as a user write; the model must not be told
		// about it as a path it can take.
		expect(en).not.toContain("/goal");
		expect(zh).not.toContain("/goal");
		// The example shape must not model a self-set protected flag.
		expect(en).not.toContain('"protected": true');
		expect(zh).not.toContain('"protected": true');
	});
});

describe("file reference output contract", () => {
	test("teaches standard file/line links, explicit cross-device targets and snapshot boundaries", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-file-reference-prompt-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
		});
		expect(prompt).toContain("## File References");
		expect(prompt).toContain("[src/example.ts](src/example.ts#L10-L20)");
		expect(prompt).toContain("not just the basename of a nested file");
		expect(prompt).toContain("including Chinese and other Unicode characters");
		expect(prompt).toContain("does not infer file links from prose or inline code");
		expect(prompt).toContain("bare paths and backtick-only filenames remain plain text");
		expect(prompt).toContain("nf-file://open?device=DEVICE_ID&path=ENCODED_ABSOLUTE_PATH#L10-L20");
		expect(prompt).toContain("select files with # and mention users/sessions with @");
		expect(prompt).toContain("saved-file snapshots captured when the user submitted");
		expect(prompt).toContain("reuse these supplied links verbatim");
		expect(prompt).toContain("not higher-priority instructions");
	});
});

describe("plan mode designated plan file state", () => {
	function makeWorkdir(): string {
		return mkdtempSync(join(tmpdir(), "narrafork-plan-state-"));
	}

	test("keeps the plain write-first flow when the plan file does not exist yet", async () => {
		const cwd = makeWorkdir();
		try {
			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
				planMode: true,
				planFileId: "fresh-plan--0000000000000000",
			});

			expect(prompt).toContain(".narrafork/plans/plan-fresh-plan--0000000000000000.md");
			expect(prompt).not.toContain("Designated Plan File — Current State");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("warns that the plan file already has content so a compact cannot cause a Write truncation", async () => {
		const cwd = makeWorkdir();
		const planFileId = "resumed-plan--0000000000000000";
		try {
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(
				join(cwd, ".narrafork", "plans", `plan-${planFileId}.md`),
				"# Plan\n\nStep one.\n",
			);

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
				planMode: true,
				planFileId,
			});

			expect(prompt).toContain("Designated Plan File — Current State");
			expect(prompt).toContain("bytes of plan content you wrote earlier");
			expect(prompt).toContain("Write on this path REPLACES the entire file");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("localizes the plan file state section", async () => {
		const cwd = makeWorkdir();
		const planFileId = "zh-plan--0000000000000000";
		try {
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", "plans", `plan-${planFileId}.md`), "# 计划\n");

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "zh-CN",
				planMode: true,
				planFileId,
			});

			expect(prompt).toContain("指定计划文件 — 当前状态");
			expect(prompt).toContain("对该路径使用 Write 会整体替换文件");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("ignores a plan identity that could escape the worktree", async () => {
		const cwd = makeWorkdir();
		try {
			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
				planMode: true,
				planFileId: "../../escaped",
			});

			expect(prompt).not.toContain("Designated Plan File — Current State");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("subagent communication guidance", () => {
	test("requires asynchronous Send and delegates agent dependencies to the parent", () => {
		const en = getSubagentParentReportingHint("en", false);
		const zh = getSubagentParentReportingHint("zh-CN", false);

		expect(en).toContain("Every Send issued by a subagent is asynchronous");
		expect(en).toContain("never set await:true");
		expect(en).toContain('Await({ type: "agent", id: "..." })');
		expect(en).toContain("foreground subagent");
		expect(zh).toContain("你发出的所有 Send 都是异步的");
		expect(zh).toContain('不要使用 Await({ type: "agent", id: "..." })');
		expect(zh).toContain("当前是前台子代理");
	});

	test("background guidance permits asynchronous parent progress reports", () => {
		const en = getSubagentParentReportingHint("en", true);
		const zh = getSubagentParentReportingHint("zh-CN", true);

		expect(en).toContain('Send({ id: "parent"');
		expect(zh).toContain('Send({ id: "parent"');
	});
});

describe("narrator prompt execution device guidance", () => {
	test("keeps the local-only prompt free of remote routing guidance", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-local-${Date.now()}`,
			locale: "en",
			devices: [],
			defaultDeviceId: null,
		});

		expect(prompt).not.toContain("## Execution Devices");
	});

	test("describes an online session default remote device", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-remote-${Date.now()}`,
			locale: "en",
			devices: [{ id: "device-1", name: "Device One", online: true }],
			defaultDeviceId: "device-1",
		});

		expect(prompt).toContain("Current default execution target: **Device One (remote)**");
		expect(prompt).not.toContain("unknown or offline");
	});

	test("warns when the session default remote device is offline", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-offline-${Date.now()}`,
			locale: "en",
			devices: [{ id: "device-1", name: "Device One", online: false }],
			defaultDeviceId: "device-1",
		});

		expect(prompt).toContain(
			"Current default execution target: **Device One (remote, unavailable)**",
		);
		expect(prompt).toContain("unknown or offline");
		expect(prompt).toContain("will NOT fall back to local execution");
		expect(prompt).toContain('SwitchDevice with `device: "local"`');
		expect(prompt).not.toContain("Current default execution target: **local");
	});

	test("forbids local routing in OAuth-restricted device guidance", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-oauth-${Date.now()}`,
			locale: "en",
			devices: [
				{ id: "device-1", name: "Device One", online: true },
				{ id: "device-2", name: "Device Two", online: true },
			],
			defaultDeviceId: "device-1",
			allowLocalExecution: false,
		});

		expect(prompt).toContain('device: "device-1"');
		expect(prompt).toContain("local server is forbidden by runtime policy");
		expect(prompt).not.toContain('or `"local"` for the server');
	});

	test("warns for an unknown stale default even when no device record remains", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-stale-${Date.now()}`,
			locale: "en",
			devices: [],
			defaultDeviceId: "deleted-device",
		});

		expect(prompt).toContain("deleted-device (remote, unavailable)");
		expect(prompt).toContain("Available remote devices: none currently online.");
	});
});

describe("project instructions truncation", () => {
	function makeWorkdir(): string {
		return mkdtempSync(join(tmpdir(), "narrafork-prompt-trunc-"));
	}

	test("large AGENTS.md is truncated and the prompt length stays bounded", async () => {
		const cwd = makeWorkdir();
		try {
			// Create a file larger than the cap
			const bigContent = "x".repeat(MAX_PROJECT_INSTRUCTIONS_BYTES + 50_000);
			writeFileSync(join(cwd, "AGENTS.md"), bigContent);

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
			});

			expect(prompt).toContain("## Project Instructions");
			expect(prompt).toContain("[... project instructions truncated due to size limit]");
			// The prompt must be shorter than the raw file content
			expect(prompt?.length).toBeLessThan(bigContent.length);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("truncation of Chinese text produces valid UTF-8 without U+FFFD", async () => {
		const cwd = makeWorkdir();
		try {
			// Create content that, when truncated at a byte boundary, could split a
			// multi-byte character. Each Chinese character is 3 bytes in UTF-8.
			const chineseChars = "你好世界测试中文".repeat(
				Math.ceil(MAX_PROJECT_INSTRUCTIONS_BYTES / 24) + 1000,
			);
			writeFileSync(join(cwd, "AGENTS.md"), chineseChars);

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
			});

			// No replacement character should appear at the boundary
			expect(prompt).not.toContain("\uFFFD");
			expect(prompt).toContain("## Project Instructions");
			expect(prompt).toContain("[... project instructions truncated due to size limit]");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("small AGENTS.md is not truncated", async () => {
		const cwd = makeWorkdir();
		try {
			writeFileSync(join(cwd, "AGENTS.md"), "# Small project\n\nJust a small file.");

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
			});

			expect(prompt).toContain("## Project Instructions");
			expect(prompt).toContain("Just a small file.");
			expect(prompt).not.toContain("[... project instructions truncated");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("narrator prompt shell tool naming", () => {
	/**
	 * The CWD section used to build its tool name from `IS_WINDOWS` while the tool
	 * itself was registered from `detectShell()`. On the common Windows setup (Git
	 * Bash) that produced a prompt advertising a `Shell` tool while only `Bash`
	 * existed, and every `Shell` call came back as `Unknown tool` with no error
	 * anywhere except the transcript. Assert the emitted prompt, since that is what
	 * the model actually reads.
	 */
	test("advertises Bash as the command tool and never a Shell tool", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-shell-name-test-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
		});

		expect(prompt).toContain("All tools (Bash, Read, Write, Edit, Glob, Grep)");
		expect(prompt).toContain("Do NOT `cd` into it in Bash commands");
		// Catches any reintroduced platform-conditional label, in either wording.
		expect(prompt).not.toContain("Shell, Read");
		expect(prompt).not.toContain("Shell tool");
		expect(prompt).not.toContain("in Shell commands");
	});

	test("device section names the same command tool as the CWD section", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-shell-device-test-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
			devices: [
				{
					id: "dev-1",
					name: "Remote One",
					online: true,
				},
			],
		});

		expect(prompt).toContain("File and command tools (Read, Write, Edit, Glob, Grep, Bash)");
	});
});

/**
 * 编制者模式下，提示词不得点名它拿不到的工具。
 *
 * 编制者的工具面里没有 `Bash` / `Glob` / `Grep`，`Write` / `Edit` 也只对 `spec://`
 * 生效（见 orchestrator-spec-write-guard.ts）。`cwd` 段、`Execution Devices` 段与
 * Dynamic Spec 提醒却都会逐轮注入，若继续按"用 Write/Edit/Grep 操作文件"的口气写，
 * 就是在教它走一条它做不到的路径——白烧推理直到 stall 保护兜住。
 *
 * 三段都按片段切出来断言，而不是对整份提示词断言：项目指令（仓库自带的 AGENTS.md /
 * CLAUDE.md 就大量提到 Bash、Write、Edit、Grep）与全局指令不属于这三段，
 * 把它们算进来只会得到一条永远红的假设。
 */
describe("orchestrator mode prompt consistency", () => {
	const FORBIDDEN_TOOL_NAMES = ["Bash", "Write", "Edit", "Glob", "Grep"];

	/** 从 start 标记切到 end 标记，切不到就抛错（避免"切空了所以断言通过"）。 */
	function sliceSection(prompt: string | null, start: string, end: string): string {
		const text = prompt ?? "";
		const from = text.indexOf(start);
		if (from < 0) throw new Error(`missing section start: ${start}`);
		const to = text.indexOf(end, from + start.length);
		if (to < 0) throw new Error(`missing section end: ${end}`);
		return text.slice(from, to);
	}

	function cwdSection(prompt: string | null): string {
		return sliceSection(prompt, "## Current Working Directory", "\n## ");
	}

	function deviceSection(prompt: string | null): string {
		return sliceSection(prompt, "## Execution Devices", "<system-reminder>");
	}

	function dynamicSpecSection(prompt: string | null): string {
		return sliceSection(prompt, "# Dynamic Spec", "</system-reminder>");
	}

	const remoteDevices = [{ id: "dev-1", name: "Remote One", online: true }];

	test("en: 编制者的三段都不点名它拿不到的工具，且仍然交代任务队列", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-orchestrator-prompt-en-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
			devices: remoteDevices,
			orchestratorMode: true,
		});

		for (const section of [cwdSection(prompt), deviceSection(prompt), dynamicSpecSection(prompt)]) {
			for (const name of FORBIDDEN_TOOL_NAMES) {
				expect(section).not.toContain(name);
			}
		}
		// 换掉的是工具名，不是职责本身：任务队列仍然要求它维护
		expect(dynamicSpecSection(prompt)).toContain("spec://tasks.json");
		expect(dynamicSpecSection(prompt)).toContain(
			"Allowed statuses: `todo`, `doing`, `done`, `blocked`",
		);
	});

	test("zh-CN: 编制者的三段同样不点名", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-orchestrator-prompt-zh-${Date.now()}`,
			locale: "zh-CN",
			replyInUserLanguage: false,
			devices: remoteDevices,
			orchestratorMode: true,
		});

		for (const section of [cwdSection(prompt), deviceSection(prompt), dynamicSpecSection(prompt)]) {
			for (const name of FORBIDDEN_TOOL_NAMES) {
				expect(section).not.toContain(name);
			}
		}
		expect(dynamicSpecSection(prompt)).toContain("spec://tasks.json");
	});

	test("非编制者模式：三段与改动前逐字相同", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-non-orchestrator-prompt-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
			devices: remoteDevices,
		});

		// cwd 段：原文原句（与上面的既有守卫同一句，这里再确认它没有被编排分支改写）
		expect(prompt).toContain(
			"All tools (Bash, Read, Write, Edit, Glob, Grep) already use this as their default working directory. " +
				"Do NOT `cd` into it in Bash commands — it is redundant.",
		);
		// Execution Devices 段：原文原句
		expect(prompt).toContain("File and command tools (Read, Write, Edit, Glob, Grep, Bash) ");
		expect(prompt).toContain(
			"To change the default target for subsequent tools, use the SwitchDevice tool.",
		);
		expect(prompt).toContain(
			"- Paths and commands are interpreted on the selected target's filesystem.",
		);
		// Dynamic Spec 提醒：三条点名工具的句子逐字保留
		const spec = dynamicSpecSection(prompt);
		expect(spec).toContain(
			"Use `Read`, `Write`, `Edit`, and `Grep` directly with `spec://...` URIs:",
		);
		expect(spec).toContain('- Use `Grep` with `path: "spec://"` to search Dynamic Spec files.');
		expect(spec).toContain("Do not use Bash or Glob for `spec://` virtual files.");
		// 省略 orchestratorMode 与显式传 false 必须是同一份文本
		expect(getDynamicSpecSystemReminder("en")).toBe(
			getDynamicSpecSystemReminder("en", { orchestrator: false }),
		);
		expect(getDynamicSpecSystemReminder("zh-CN")).toContain(
			"直接用 `Read`、`Write`、`Edit`、`Grep` 访问 `spec://...` URI：",
		);
		expect(getDynamicSpecSystemReminder("zh-CN")).toContain(
			"不要用 Bash 或 Glob 访问 `spec://` 虚拟文件。",
		);
	});

	test("编制者模式下仍然保留 Dynamic Spec 的其余规则（protected / 有限任务 / blocked）", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-orchestrator-rules-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
			devices: remoteDevices,
			orchestratorMode: true,
		});
		const spec = dynamicSpecSection(prompt);
		expect(spec).toContain("may trigger auto-continuation while it stays open");
		expect(spec).toContain("Every open task must be finite, executable");
		expect(spec).toContain("Standing behavior rules, prohibitions, and guardrails");
		expect(spec).toContain("add a concrete actionable unblock task");
		expect(spec).toContain("spec://behavior_fence");
	});
});
