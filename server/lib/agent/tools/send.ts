import { runtimePolicyForContext } from "@server/services/agent-runtime/policy";
import { SUBAGENT_SEND_ASYNC_ONLY_ERROR } from "@server/services/subagent-communication-policy";
import { z } from "zod/v4";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

/**
 * Parameter copy, declared once and consumed by BOTH schemas below.
 *
 * `buildRawJsonSchema` hand-writes the JSON Schema while `parameters` carries
 * the Zod one, so a description edited in only one place silently reaches some
 * providers and not others. These constants are the single source; a wording
 * change now lands in both.
 */
const PARAM_COPY = {
	id: 'Target ID or alias. A primary narrator may also name another primary narrator you can read (peer) by id, @handle, or title. Subagents may use "parent" to reach their parent narrator.',
	ids: "Target IDs or aliases. Subagents may mix parent/main with sibling targets; a primary narrator may mix child-subagent and peer targets.",
	name: "Target title, alias, @handle, or unique ID prefix. For a primary narrator this may match another readable narrator's title or @handle.",
	names: "Target titles, aliases, @handles, or unique ID prefixes.",
	message: "Message to send to the target(s).",
	doInterrupt:
		"Interrupt an active foreground child subagent after queuing the message. Use only " +
		"for an urgent correction that requires stopping current work, never for status polling. " +
		"Never applies to peer narrators.",
} as const;

function buildRawJsonSchema(config?: AgentConfig): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		id: {
			description: PARAM_COPY.id,
			type: "string",
		},
		ids: {
			description: PARAM_COPY.ids,
			type: "array",
			items: { type: "string" },
		},
		name: {
			description: PARAM_COPY.name,
			type: "string",
		},
		names: {
			description: PARAM_COPY.names,
			type: "array",
			items: { type: "string" },
		},
		message: { description: PARAM_COPY.message, type: "string" },
		replyTo: {
			description:
				"Request ID from a prior allowed Send(await=true) that this asynchronous message answers; subagents may reply but must not wait.",
			type: "string",
		},
		doInterrupt: {
			description: PARAM_COPY.doInterrupt,
			type: "boolean",
		},
	};

	// The model-facing schema omits reply-wait parameters for subagents. The Zod
	// schema remains permissive for post-resolution validation and legacy inputs;
	// the service layer is the authoritative runtime guard.
	if (runtimePolicyForContext(config).capabilities.sendAwait) {
		properties.await = {
			description:
				"Primary-narrator-only option: request and wait for target(s) to call Send back. Subagents must omit this or set it false; it does not wait for task completion.",
			type: "boolean",
		};
		properties.timeout = {
			description:
				"For primary-narrator await requests only: how long to wait for Send replies. Defaults to 60000 milliseconds.",
			type: "number",
		};
	}

	return {
		type: "object",
		properties,
		required: ["message"],
		additionalProperties: false,
	};
}

export const sendTool: ToolDefinition = {
	name: "Send",
	description:
		"Send a message to one or more accessible narrators. " +
		"Primary narrators may send to their child subagents and to other primary narrators they " +
		"can read (peers); subagents may send to sibling subagents. " +
		'Subagents may also report progress to the narrator that launched them via "parent" (or "main"). Ordinary asynchronous messages may mix parent and sibling targets in one call; aliases for the same recipient are deduplicated. ' +
		"Foreground reports are durably queued until the parent's safe input boundary; they do not start a second parent loop or guarantee immediate reading. " +
		"A peer message wakes an idle peer exactly as a user message would, so name a peer only when it should act. Discover peers with " +
		'TeamStatus({ action: "list_peers" }) and read one with PeerPeek before writing to someone you have not worked with. ' +
		"Each target is accepted independently after whole-call authorization and reply validation; partial failures preserve successful deliveries. Explicit replyTo requires a single recipient, and replies cannot mix with ordinary messages. " +
		"Messages have a 256 KiB UTF-8 body limit; larger content must use a file reference or summary. " +
		"Send may wake the recipient's session and trigger an unnecessary extra agent turn, so send messages only when genuinely necessary. " +
		"Do not send courtesy acknowledgements, redundant progress updates, or messages merely to check status. " +
		"Use Send for new information, changed requirements, or concrete corrections—not for routine " +
		"status checks after an Await timeout. Repeated messages can distract a working subagent. " +
		"Set doInterrupt=true only when the current work must stop immediately; never use it merely " +
		"because a short wait timed out or you are impatient. " +
		"Primary narrators may set await=true to request a direct Send reply. Subagents must always " +
		"use asynchronous Send and their await=true requests are rejected; use a later Send message " +
		"to report back instead. Await is for task completion where allowed.",
	parameters: z.object({
		id: z.string().optional().describe(PARAM_COPY.id),
		ids: z.array(z.string()).optional().describe(PARAM_COPY.ids),
		name: z.string().optional().describe(PARAM_COPY.name),
		names: z.array(z.string()).optional().describe(PARAM_COPY.names),
		message: z.string().describe(PARAM_COPY.message),
		replyTo: z
			.string()
			.optional()
			.describe(
				"Request ID from a prior allowed Send(await=true) that this asynchronous message explicitly answers. Subagents may use replyTo to reply, but must not wait.",
			),
		doInterrupt: z.boolean().optional().describe(PARAM_COPY.doInterrupt),
		await: z
			.boolean()
			.optional()
			.describe(
				"Primary-narrator-only option: request and wait for target(s) to call Send back. Subagents must omit this or set it false; it does not wait for task completion.",
			),
		timeout: looseNumber(
			"For primary-narrator await requests only: how long to wait for Send replies. Defaults to 60000 milliseconds.",
		),
	}),
	get rawJsonSchema() {
		return buildRawJsonSchema();
	},
	getRawJsonSchema(config?: AgentConfig) {
		return buildRawJsonSchema(config);
	},
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as {
			id?: string;
			ids?: string[];
			name?: string;
			names?: string[];
			message?: string;
			replyTo?: string;
			doInterrupt?: boolean;
			await?: boolean;
			timeout?: number;
		};
		if (raw.await === true && !runtimePolicyForContext(ctx).capabilities.sendAwait) {
			return { output: `Send error: ${SUBAGENT_SEND_ASYNC_ONLY_ERROR}`, isError: true };
		}
		if (!raw.message?.trim()) {
			return { output: "Error: message is required.", isError: true };
		}
		if (!ctx.currentToolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}

		const toolUseId = ctx.currentToolUseId;
		let targetCount: number | undefined;
		try {
			const { sendSubagentMessageDetailed } = await import("@server/services/agent-communication");
			const result = await sendSubagentMessageDetailed({
				callerNarratorId: ctx.narratorId,
				id: raw.id,
				ids: raw.ids,
				name: raw.name,
				names: raw.names,
				message: raw.message,
				replyTo: raw.replyTo,
				doInterrupt: raw.doInterrupt,
				shouldAwait: raw.await,
				timeoutMs: normalizeNumber(raw.timeout, { min: 1 }),
				toolUseId: ctx.currentToolUseId,
				toolCallBinding: ctx.toolCallBinding,
				signal: ctx.signal,
				locale: ctx.locale,
				userId: ctx.userId ?? null,
				onTargetsResolved: (count) => {
					targetCount = count;
					void import("@server/services/send-delivery-resolution")
						.then(({ broadcastSendDeliveryResolved }) =>
							broadcastSendDeliveryResolved(
								ctx.narratorId,
								toolUseId,
								[],
								ctx.toolCallBinding,
								count,
							),
						)
						.catch(() => {});
				},
				onDeliveryResolved: (target) => {
					// The frontend merges by receipt; avoid O(targets²) cumulative broadcasts.
					const snapshot = [{ ...target }];
					void import("@server/services/send-delivery-resolution")
						.then(({ broadcastSendDeliveryResolved }) =>
							broadcastSendDeliveryResolved(
								ctx.narratorId,
								toolUseId,
								snapshot,
								ctx.toolCallBinding,
								targetCount,
							),
						)
						.catch(() => {});
				},
				onTargetResolved: (targetId) => {
					// Only primaries can wait. Reuse Await's navigation-only event; never
					// manufacture a result while Send is still awaiting a reply.
					if (raw.await !== true) return;
					void import("@server/services/await-agent-resolution")
						.then(async ({ singleSendSelector }) => {
							if (!singleSendSelector(raw)) return;
							const { broadcastAwaitAgentResolved } = await import("./await");
							await broadcastAwaitAgentResolved(ctx.narratorId, toolUseId, targetId);
						})
						.catch(() => {});
				},
			});
			return {
				output: result.output,
				metadata: {
					kind: "send",
					// Each entry carries both the real id (for the card's session link)
					// and a readable label (for what the reader actually sees).
					targets: result.targets,
					targetCount: targetCount ?? result.targets.length,
					doInterrupt: raw.doInterrupt ?? false,
					await: raw.await ?? false,
				},
			};
		} catch (err) {
			return {
				output: `Send error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
