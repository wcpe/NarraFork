/**
 * narratorCommunicationMenuItems.ts — context-menu entries that hand another
 * agent a way to address this narrator.
 *
 * Send can already deliver a message to a peer, but a peer can only name a
 * narrator it already knows an id for. These two entries are how a human
 * supplies one: the bare id for pasting into a prompt, and the session link for
 * opening the narrator directly. Nothing here sends anything — both are pure
 * clipboard writes.
 *
 * Copied through the shared `copyTextToClipboard` rather than
 * `navigator.clipboard`, because the Clipboard API is unavailable on a plain
 * HTTP origin (a non-secure context) and fails there without any error
 * surfacing to the reader.
 */

import { IconCopy, IconLink } from "@tabler/icons-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "../../../lib/clipboard";
import type { CustomMessageMenuItem } from "../message/MessageContextMenuCtx";

/** Session path for one narrator. Kept beside the menu so link and id cannot drift. */
export function narratorSessionPath(narratorId: string): string {
	return `/narrators/${narratorId}`;
}

/**
 * Absolute link to a narrator's session, for pasting outside this app.
 * Returns the bare path when there is no window (SSR / test), which still
 * opens correctly once pasted into the app's own origin.
 */
export function narratorSessionUrl(narratorId: string): string {
	const origin = typeof globalThis === "undefined" ? undefined : globalThis.location?.origin;
	return origin ? `${origin}${narratorSessionPath(narratorId)}` : narratorSessionPath(narratorId);
}

export interface NarratorCommunicationMenuOptions {
	narratorId: string;
	/**
	 * Whether the surface may address the narrator at all. The narrator's own
	 * page is the one place where "message yourself" would be meaningless, and
	 * the share/embed surfaces have their own addressing rules.
	 */
	enabled?: boolean;
}

/**
 * Builds the menu items.
 *
 * The array is memoized on `[narratorId, enabled, copyId, copyLink, t]`: the
 * vlist row layer keys its per-row payloads off handler identity, so a fresh
 * array on every render would rebuild `vlistRowHandlers` and re-render every
 * message row in the transcript on each panel paint.
 */
export function useNarratorCommunicationMenuItems(
	opts: NarratorCommunicationMenuOptions,
): CustomMessageMenuItem[] {
	const { t } = useTranslation("narrator");
	const { narratorId, enabled = true } = opts;

	const copyId = useCallback(() => {
		void copyTextToClipboard(narratorId);
	}, [narratorId]);
	const copyLink = useCallback(() => {
		void copyTextToClipboard(narratorSessionUrl(narratorId));
	}, [narratorId]);

	return useMemo(() => {
		if (!enabled || !narratorId) return [];
		return [
			{
				key: "copy-narrator-id",
				label: t("contextMenu_copyNarratorId"),
				icon: <IconCopy size={14} />,
				onClick: copyId,
			},
			{
				key: "copy-narrator-link",
				label: t("contextMenu_copyNarratorLink"),
				icon: <IconLink size={14} />,
				onClick: copyLink,
			},
		];
	}, [enabled, narratorId, t, copyId, copyLink]);
}
