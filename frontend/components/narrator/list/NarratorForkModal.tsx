/**
 * NarratorForkModal.tsx — 叙述者列表内「分叉」操作的确认/命名弹窗内容。
 *
 * 列表卡片没有具体消息上下文，分叉语义是"克隆当前会话的整段可见历史"
 * （standalone 叙述者直接 fork），因此弹窗只需收集一个可选的标题，
 * 其余交给后端按 inheritMode 处理。标题留空则由后端沿用父叙述者标题。
 *
 * 本组件只产出弹窗正文（hint + 标题输入 + 按钮），由宿主页面的 <Modal>
 * 负责开合与标题栏，避免内部再套一层动画状态。
 */
import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export interface NarratorForkModalProps {
	narratorId: string | null;
	narratorTitle?: string | null;
	loading?: boolean;
	onClose: () => void;
	onConfirm: (narratorId: string, title: string | undefined) => void;
}

export function NarratorForkModal({
	narratorId,
	narratorTitle,
	loading = false,
	onClose,
	onConfirm,
}: NarratorForkModalProps) {
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const [title, setTitle] = useState("");
	const [titleError, setTitleError] = useState<string | null>(null);

	// 每次针对一个新叙述者打开时清空标题，避免上一个叙述者的输入残留。
	useEffect(() => {
		if (narratorId) {
			setTitle("");
			setTitleError(null);
		}
	}, [narratorId]);

	const handleConfirm = () => {
		if (loading) return;
		const trimmed = title.trim();
		if (!narratorId) return;
		if (trimmed.length > 200) {
			setTitleError(t("forkTitleTooLong"));
			return;
		}
		setTitleError(null);
		onConfirm(narratorId, trimmed || undefined);
	};

	return (
		<Stack gap="xs">
			<Text size="sm">{t("forkFromListHint")}</Text>
			<TextInput
				data-autofocus
				label={t("forkTitleLabel")}
				placeholder={narratorTitle ?? t("forkTitlePlaceholder")}
				value={title}
				error={titleError}
				onChange={(e) => {
					setTitle(e.currentTarget.value);
					if (titleError) setTitleError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing) handleConfirm();
				}}
			/>
			<Group justify="flex-end" mt="xs">
				<Button variant="default" onClick={onClose} disabled={loading}>
					{tc("cancel")}
				</Button>
				<Button onClick={handleConfirm} loading={loading} disabled={!narratorId}>
					{t("fork")}
				</Button>
			</Group>
		</Stack>
	);
}
