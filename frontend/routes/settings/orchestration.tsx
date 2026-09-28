import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	canonicalizeOrchestrationSettings,
	createEmptyOrchestrationSettings,
	finalizeOrchestrationSettings,
	normalizeOrchestrationSettings,
	OrchestrationSection,
	type OrchestrationSettings,
	validateOrchestrationSettings,
} from "../../components/settings/OrchestrationSection";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";
import { useAllModels } from "../../hooks/useModels";
import { api } from "../../lib/api";

export const Route = createFileRoute("/settings/orchestration")({
	component: SettingsOrchestrationPage,
});

function SettingsOrchestrationPage() {
	const { t } = useTranslation("settings");
	const is = useInstanceSettingsContext();
	const qc = useQueryClient();
	const { visibleModels, providerLabels } = useAllModels();

	// 服务端设置加载完成前不初始化草稿，否则会把空配置当成用户输入。
	const ready = !is.isLoading && is.settings !== undefined;
	const serverValue = useMemo(
		() =>
			canonicalizeOrchestrationSettings(
				normalizeOrchestrationSettings(is.settings?.agent?.orchestration),
			),
		[is.settings],
	);

	const [draft, setDraft] = useState<OrchestrationSettings>(createEmptyOrchestrationSettings);
	// 已保存的基线：保存成功后更新，用于判断脏值；不直接用 serverValue 比较，
	// 是因为服务端回包未必逐字回显，用基线才能让保存后立即回到“干净”状态。
	const [baseline, setBaseline] = useState<OrchestrationSettings>(createEmptyOrchestrationSettings);
	const [initialized, setInitialized] = useState(false);

	useEffect(() => {
		if (initialized || !ready) return;
		setDraft(serverValue);
		setBaseline(serverValue);
		setInitialized(true);
	}, [initialized, ready, serverValue]);

	const isDirty = useMemo(() => {
		if (!initialized) return false;
		return JSON.stringify(canonicalizeOrchestrationSettings(draft)) !== JSON.stringify(baseline);
	}, [initialized, draft, baseline]);

	const issues = useMemo(() => validateOrchestrationSettings(draft), [draft]);
	const blockingIssues = issues.filter((issue) => issue.severity === "error");

	const updateSettings = useMutation({ mutationFn: api.updateSettings });

	const save = () => {
		// 保存前收尾：裁剪名称/描述空白，空描述折叠为省略。
		const payload = finalizeOrchestrationSettings(draft);
		updateSettings.mutate(
			{ agent: { orchestration: payload } },
			{
				onSuccess: (data) => {
					const saved = canonicalizeOrchestrationSettings(payload);
					setDraft(saved);
					setBaseline(saved);
					qc.setQueryData(["settings"], data);
					notifications.show({ message: t("orchSaved"), color: "green" });
				},
				onError: (error) => {
					notifications.show({
						title: t("orchSaveFailed"),
						message: error instanceof Error ? error.message : String(error),
						color: "red",
					});
				},
			},
		);
	};

	const reload = () => {
		setDraft(serverValue);
		setBaseline(serverValue);
	};

	// 未保存就离开时拦一次：shouldBlockFn 管应用内跳转，
	// enableBeforeUnload 管刷新/关闭标签页；两者都只在有未保存改动时生效。
	const shouldBlock = useCallback(() => isDirty, [isDirty]);
	const shouldBlockUnload = useCallback(() => isDirty, [isDirty]);
	const blocker = useBlocker({
		shouldBlockFn: shouldBlock,
		enableBeforeUnload: shouldBlockUnload,
		withResolver: true,
	});

	const saveDisabled = !isDirty || blockingIssues.length > 0 || updateSettings.isPending;

	return (
		<Stack>
			<Title order={3}>{t("orchestrationSection")}</Title>
			<Text size="sm" c="dimmed">
				{t("orchestrationSectionDesc")}
			</Text>

			{!initialized ? (
				<Group justify="center" py="xl">
					<Loader size="sm" />
					<Text size="sm" c="dimmed">
						{t("orchLoading")}
					</Text>
				</Group>
			) : (
				<>
					<OrchestrationSection
						value={draft}
						onChange={setDraft}
						models={visibleModels}
						providerLabels={providerLabels}
						issues={issues}
					/>

					<Group justify="space-between" align="center" mt="md">
						<Group gap="xs">
							{isDirty && (
								<Badge color="orange" variant="light">
									{t("orchDirtyBadge")}
								</Badge>
							)}
						</Group>
						<Group gap="xs">
							<Button variant="default" onClick={reload} disabled={!isDirty}>
								{t("orchReload")}
							</Button>
							<Button onClick={save} loading={updateSettings.isPending} disabled={saveDisabled}>
								{t("orchSave")}
							</Button>
						</Group>
					</Group>

					{isDirty && blockingIssues.length > 0 && (
						<Alert color="red" variant="light">
							{t("orchSaveBlocked")}
						</Alert>
					)}
				</>
			)}

			{/* 打算离开但存在未保存改动时的确认框。 */}
			<Modal
				opened={blocker.status === "blocked"}
				onClose={() => blocker.reset?.()}
				title={t("orchUnsavedTitle")}
				size="sm"
				closeOnClickOutside={false}
			>
				<Stack gap="md">
					<Text size="sm">{t("orchUnsavedMessage")}</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => blocker.reset?.()}>
							{t("orchUnsavedStay")}
						</Button>
						<Button color="red" onClick={() => blocker.proceed?.()}>
							{t("orchUnsavedLeave")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
