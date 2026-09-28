/**
 * vlist-error-actions.tsx — live handlers for the exact vlist's error notice card.
 *
 * The render layer (`render/RenderSystemText.tsx`) repaints the error card from
 * its measured geometry and must stay free of app coupling (no REST client, no
 * i18n, no modal), so it only declares an `ErrorNoticeActions` slot. Without an
 * injected slot the two right-side controls paint correctly but do nothing —
 * exactly the regression this module closes: in Virtual-list mode "Mark as
 * retryable" and the dismiss button were inert, while the chunked path
 * (MessageBubble's ErrorNotice) has always driven the real flows.
 *
 * Behaviour parity with the chunked card:
 *   - fix    → (conditional) turn off the provider's native image_generation tool
 *              and retry, for the one failure where that is the actual cause
 *   - probe  → (conditional, admin only) open ModelTestDialog against the model the
 *              failed turn dispatched to. Restored here after the chunked card was
 *              deleted took its only entry point with it
 *   - retry  → open the shared RetryRuleModal prefilled with this error's text
 *              (POST /settings/retry-rules + settings query invalidation live
 *              inside that component)
 *   - close  → DELETE the error message, drop it from the messages cache; the
 *              server broadcasts `messages_deleted`, which the shell already
 *              turns into a structural document reload
 *
 * The modal is hosted ONCE for the whole list (rows are zero-DOM copies and
 * cannot own a modal), keyed by the clicked row's error text.
 *
 * Kept as its own module (like vlist-spec-carryover-actions) so the wiring is
 * unit-testable without pulling the whole shell into the test graph.
 */

import { api } from "@frontend/lib/api";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../../hooks/useModels";
import { useNarrator } from "../../../hooks/useNarrator";
import { ModelTestDialog } from "../../providers/ModelTestDialog";
import { removeMessagesFromCache } from "../message/messages-query-cache";
import { useOrchestrationWorkerModelSwitch } from "../model/OrchestrationWorkerModelSwitch";
import { useCodexImageGenerationFix } from "../model/useCodexImageGenerationFix";
import { useNarratorModelTest } from "../model/useNarratorModelTest";
import {
	canOfferWorkerModelSwitch,
	workerFailedModelFromErrorMessage,
} from "../model/worker-model-switch";
import { RetryRuleModal } from "../permission/RetryRuleModal";
import type { ErrorNoticeActions } from "./render/RenderSystemText";
import type { VListItem } from "./vlist-pipeline";

/** Resolve the per-row action slot; undefined when the row is not an error card. */
export type ErrorNoticeActionsResolver = (
	messageId: string | undefined,
	errorText: string,
) => ErrorNoticeActions | undefined;

/**
 * True when this row is the system error notice. The card kind lives in the
 * layout spec's data (the same value `resolveRenderExtra` forwards as
 * `extra.kind`), so no measure-layer import is needed.
 */
export function isErrorNoticeItem(item: VListItem): boolean {
	if (item.spec.kind !== "system-text") return false;
	return (item.spec.data as { kind?: unknown } | null)?.kind === "error";
}

/** The measured body text of an error row (prefills the retry-rule keyword). */
export function errorNoticeText(item: VListItem): string {
	const text = (item.spec.data as { text?: unknown } | null)?.text;
	return typeof text === "string" ? text : "";
}

/**
 * Resolve a row's error-notice actions, or undefined when the row is not an error
 * card / has no owning message id. Pure helper so the shell's render loop stays
 * flat, mirroring `resolveSpecCarryoverActions`.
 *
 * System cards carry no `-b{n}` block suffix and therefore no RowInteraction, so
 * the owning message comes from the manifest source ids.
 */
export function resolveErrorNoticeActions(
	item: VListItem,
	sourceIds: readonly string[],
	resolve: ErrorNoticeActionsResolver,
): ErrorNoticeActions | undefined {
	if (!isErrorNoticeItem(item)) return undefined;
	return resolve(sourceIds[0], errorNoticeText(item));
}

export interface VListErrorNoticeActions {
	/** Per-row resolver handed to `resolveErrorNoticeActions`. */
	resolve: ErrorNoticeActionsResolver;
	/**
	 * The dialogs the whole list shares, mounted once by the shell: the retry-rule
	 * editor and the model probe. Rows are zero-DOM copies and cannot own a modal.
	 */
	ruleModal: ReactNode;
	/**
	 * Whether an error card with this text may offer the provider fix. Handed to
	 * the document build as `canOfferProviderFix`: the fix is a labelled button on
	 * its own row, so its presence changes the card's measured height and must be
	 * known during adaptation, not at paint time.
	 */
	canOfferProviderFix: (errorText: string) => boolean;
	/**
	 * Whether an error card with this text may offer the model probe. Same measured-
	 * row contract as `canOfferProviderFix` — it shares that button row.
	 */
	canOfferModelTest: (errorText: string) => boolean;
	/**
	 * 编排 worker 的「换模型继续」是否可用。同一条测量行约定 —— 它与上面两个按钮
	 * 共用那条条件按钮行，所以必须在适配期就知道答案。
	 *
	 * 判定与错误文本无关（同一个会话里的错误卡片要么都属于这个编排 worker，要么
	 * 都不属于），但接口保持一致，免得调用方为这一条单独接线。
	 */
	canOfferOrchestrationModelSwitch: (errorText: string) => boolean;
}

/**
 * Build the error-notice action resolver for one narrator, plus the one rule
 * dialog its rows share.
 *
 * The resolver caches one object per message id and keeps that identity stable
 * until the in-flight dismissal changes, so unchanged rows keep referential props
 * and the ExactRow memo can keep skipping them during scroll.
 */
export function useVListErrorNoticeActions(narratorId: string): VListErrorNoticeActions {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	// The error text the rule dialog is currently open for (null → closed).
	const [ruleTarget, setRuleTarget] = useState<string | null>(null);
	const [dismissingId, setDismissingId] = useState<string | null>(null);
	// The provider-settings fix is per-narrator (it disables the tool for the
	// provider this narrator resolved to and retries its last turn), but whether a
	// given ROW may offer it depends on that row's error text, hence `canFix`.
	const imageGenFix = useCodexImageGenerationFix(narratorId);
	// The model probe, restored from the deleted chunked card. Same per-narrator /
	// per-row-text split as the fix above: eligibility depends on the user's role and
	// the narrator's resolved model, the error text decides which rows offer it.
	const modelTest = useNarratorModelTest(narratorId);
	// 编排 worker 的「换模型继续」。资格是**这个会话**的属性（它是不是编排 worker、
	// 它的编排会话还在不在同一个方案上），与具体是哪条错误无关；因此这里读一次
	// narrator 行，而不是在每个错误文本上做正则。
	//
	// 读的是 `["narrators", id]` 这份缓存：`useNarratorPanelWS` 的 subagent 事件
	// 就在往同一个 key 上打补丁，所以父级一换方案、或 worker 被换掉，这里会跟着变。
	const { data: workerNarrator } = useNarrator(narratorId);
	const workerSubagentType =
		typeof workerNarrator?.subagentType === "string" ? workerNarrator.subagentType : null;
	const primaryNarratorId =
		typeof workerNarrator?.parentNarratorId === "string" ? workerNarrator.parentNarratorId : "";
	const { data: primaryNarrator } = useNarrator(primaryNarratorId);
	const primaryModel = typeof primaryNarrator?.model === "string" ? primaryNarrator.model : null;
	const { orchestrationOptions } = useAllModels();
	const workerModelSwitch = useOrchestrationWorkerModelSwitch();
	// Read at click time so a second click is rejected without making the handler
	// depend on the in-flight state.
	const dismissingRef = useRef(dismissingId);
	dismissingRef.current = dismissingId;

	const dismiss = useCallback(
		async (messageId: string) => {
			if (!narratorId || dismissingRef.current) return;
			setDismissingId(messageId);
			try {
				const result = await api.dismissErrorMessage(narratorId, messageId);
				// Drop the row locally too: the server also broadcasts
				// `messages_deleted` (which the shell turns into a structural reload),
				// but pruning the cache keeps the paged messages query consistent —
				// exactly what the chunked ErrorNotice does.
				removeMessagesFromCache(qc, narratorId, result.deletedMessageIds ?? [messageId]);
			} catch {
				notifications.show({
					title: t("deleteMessageFailed"),
					message: t("deleteMessageFailedDesc"),
					color: "red",
					autoClose: 5000,
				});
			} finally {
				setDismissingId(null);
			}
		},
		[narratorId, qc, t],
	);

	const markRetryableLabel = t("markRetryable");

	/**
	 * 这个会话的错误卡片该不该给「换模型继续」。
	 *
	 * 判定不看 `errorText`：一个会话的所有错误卡片要么都属于同一个编排 worker，
	 * 要么都不属于。参数留着是为了与另外两条 `canOffer*` 保持同一个接口
	 * （适配器对三者一视同仁地调用）。
	 */
	const canOfferOrchestrationModelSwitch = useCallback(
		(_errorText: string) =>
			canOfferWorkerModelSwitch({
				subagentType: workerSubagentType,
				primaryModel,
				orchestrationOptions,
			}),
		[orchestrationOptions, primaryModel, workerSubagentType],
	);

	// 整个会话只有"救这个 worker"一件事，所以打开选择器不需要更多参数。
	const openWorkerModelSwitch = useCallback(() => {
		workerModelSwitch.open({
			primaryNarratorId,
			workerNarratorId: narratorId,
			subagentType: workerSubagentType,
			// 当前模型取 narrator 行的实时值：它已经被 model_changed 事件打过补丁，
			// 比编排派发时写进工具输入的那份快照新。
			currentModel: typeof workerNarrator?.model === "string" ? workerNarrator.model : null,
			// 失败归因的模型来自 `errorMessage` 信封（服务端把它当唯一能跨刷新存活的
			// 失败载体）。选择器用它判断"池里那个模型此刻确实不能用"，因此不能改用
			// `model`：模型可能刚被换过，那一列会指向一个还没失败过的新模型。
			failedModel: workerFailedModelFromErrorMessage(
				typeof workerNarrator?.errorMessage === "string" ? workerNarrator.errorMessage : null,
			),
		});
	}, [
		narratorId,
		primaryNarratorId,
		workerModelSwitch,
		workerNarrator?.errorMessage,
		workerNarrator?.model,
		workerSubagentType,
	]);

	const resolve = useMemo<ErrorNoticeActionsResolver>(() => {
		const cache = new Map<string, ErrorNoticeActions>();
		return (messageId: string | undefined, errorText: string) => {
			if (!messageId) return undefined;
			const cached = cache.get(messageId);
			if (cached) return cached;
			// Whether the fix BUTTON exists was already decided during adaptation (it
			// occupies a measured row), so this only makes the painted button live for
			// the rows that carry it.
			const offerImageGenFix = imageGenFix.canFix(errorText);
			const offerModelTest = modelTest.canTest(errorText);
			const offerModelSwitch = canOfferOrchestrationModelSwitch(errorText);
			const actions: ErrorNoticeActions = {
				onMarkRetryable: () => setRuleTarget(errorText),
				onDismiss: () => void dismiss(messageId),
				dismissing: dismissingId === messageId,
				markRetryableLabel,
				...(offerImageGenFix
					? { onDisableImageGen: imageGenFix.run, disablingImageGen: imageGenFix.busy }
					: {}),
				// The dialog opens for THIS row's text, so the probe reports against the
				// error the reader clicked rather than whichever card rendered last.
				...(offerModelTest ? { onTestModel: () => modelTest.open(errorText) } : {}),
				// 换模型救的是整个会话（不是某一条错误），所以这里不带行信息。
				...(offerModelSwitch ? { onSwitchModel: openWorkerModelSwitch } : {}),
			};
			cache.set(messageId, actions);
			return actions;
		};
		// The whole resolver is rebuilt (dropping its cache) whenever the fix's
		// applicability or busy state changes, so a row cannot keep serving a stale
		// loading flag — same reason `dismissingId` is a dependency.
	}, [
		dismiss,
		dismissingId,
		markRetryableLabel,
		imageGenFix.canFix,
		imageGenFix.run,
		imageGenFix.busy,
		modelTest.canTest,
		modelTest.open,
		canOfferOrchestrationModelSwitch,
		openWorkerModelSwitch,
	]);

	const closeRuleModal = useCallback(() => setRuleTarget(null), []);

	const ruleModal = (
		<>
			{ruleTarget === null ? null : (
				<RetryRuleModal opened onClose={closeRuleModal} errorMessage={ruleTarget} />
			)}
			{modelTest.target === null ? null : (
				<ModelTestDialog
					opened
					onClose={modelTest.close}
					modelValue={modelTest.modelValue}
					selectedModelValue={modelTest.selectedModelValue}
					sourceError={modelTest.target}
				/>
			)}
		</>
	);

	return {
		resolve,
		// 选择器由壳渲染一次（行是零 DOM 副本，不能自己拥有模态框）。
		ruleModal: (
			<>
				{ruleModal}
				{workerModelSwitch.modal}
			</>
		),
		canOfferProviderFix: imageGenFix.canFix,
		canOfferModelTest: modelTest.canTest,
		canOfferOrchestrationModelSwitch,
	};
}
