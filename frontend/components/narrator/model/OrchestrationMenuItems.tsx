import { ActionIcon, Badge, Box, Group, Menu, Stack, Text } from "@mantine/core";
import { IconCheck, IconDotsVertical, IconLogout } from "@tabler/icons-react";
import { Fragment, type Ref, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type ModelOption,
	ORCHESTRATION_TIER_NAMES,
	type OrchestrationTierName,
} from "../../../lib/constants";

/** 取档位的中文/英文标签键。 */
function tierLabelKey(tier: OrchestrationTierName): string {
	return `orchestrationTier_${tier}`;
}

/**
 * 会话模型菜单里的「编排模式」分组。
 *
 * 视觉与其它 provider 分组同构（`Menu.Label` + `Menu.Item` + `Menu.Divider`），
 * 但每行是一个编排方案：选中它是进入编排模式（写入 `__orch__:<id>`），而不是
 * 选一个具体模型，因此它不能混进任何模型选择器的数据里。
 *
 * 方案的编制者模型与四档池明细放在行内展开区：Mantine v7 没有 `Menu.Sub`，
 * 嵌套 Popover 在这个下拉里也不可靠（外层菜单会截走触发事件），因此沿用
 * ModelMenuItems 里「三点点展开全局角色动作」的既有做法。
 */
export function OrchestrationMenuItems({
	profiles,
	currentProfileId,
	onSelect,
	onExit,
	exitPending = false,
	opened = true,
	selectedItemRef,
	resolveModelLabel,
}: {
	/** provider 为 `__orchestration__` 的选项。 */
	profiles: ModelOption[];
	/** 当前会话所处的编排方案 id；不在编排模式时为 null。 */
	currentProfileId: string | null;
	onSelect: (value: string) => void;
	/** 退出编排模式（回到会话默认模型语义）。缺省时不显示退出项。 */
	onExit?: () => void;
	/** 退出请求进行中，用于禁用退出项。 */
	exitPending?: boolean;
	/** 跟随菜单开关，关闭时收起展开区，避免下次打开残留旧状态。 */
	opened?: boolean;
	/** 当前选中行，交给父组件做滚动居中。 */
	selectedItemRef?: Ref<HTMLButtonElement>;
	/** 把 "provider:modelId" 换成可读名；缺失时原样显示。 */
	resolveModelLabel?: (value: string) => string;
}) {
	const { t } = useTranslation("narrator");
	/** 展开明细的方案 id。 */
	const [infoProfileId, setInfoProfileId] = useState<string | null>(null);
	useEffect(() => {
		if (!opened) setInfoProfileId(null);
	}, [opened]);

	return (
		<>
			<Menu.Label>{t("modelGroupOrchestration")}</Menu.Label>
			{profiles.map((option) => {
				const profile = option.orchestration;
				if (!profile) return null;
				const selected = profile.id === currentProfileId;
				const infoOpen = infoProfileId === profile.id;
				return (
					<Fragment key={option.value}>
						<Menu.Item
							ref={selected ? selectedItemRef : undefined}
							fw={selected ? 600 : 400}
							onClick={() => onSelect(option.value)}
							rightSection={
								<Group gap={4} wrap="nowrap">
									<ActionIcon
										component="div"
										role="button"
										tabIndex={0}
										variant="subtle"
										color="gray"
										size="sm"
										aria-label={t("orchestrationDetails")}
										aria-expanded={infoOpen}
										title={t("orchestrationDetails")}
										onClick={(e) => {
											e.stopPropagation();
											e.preventDefault();
											setInfoProfileId((prev) => (prev === profile.id ? null : profile.id));
										}}
									>
										<IconDotsVertical size={14} />
									</ActionIcon>
									<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
								</Group>
							}
						>
							<Box>
								<Text size="sm" inherit>
									{option.label} · {t("orchestrationSuffix")}
								</Text>
								{profile.description && (
									<Text
										size="xs"
										c="dimmed"
										lh={1.3}
										style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}
									>
										{profile.description}
									</Text>
								)}
								<Group gap={4} mt={2} wrap="wrap">
									{ORCHESTRATION_TIER_NAMES.map((tier) => {
										const count = profile.tierPools[tier].length;
										return (
											<Badge
												key={tier}
												size="xs"
												variant={count === 0 ? "outline" : "light"}
												color={count === 0 ? "gray" : "indigo"}
											>
												{t(tierLabelKey(tier))} {count}
											</Badge>
										);
									})}
								</Group>
							</Box>
						</Menu.Item>
						{infoOpen && (
							<Box px="md" py={4} data-orch-info={profile.id} onClick={(e) => e.stopPropagation()}>
								<Stack gap={2}>
									<Text size="xs" c="dimmed">
										{t("orchestrationOrchestratorModels")}
									</Text>
									{profile.orchestratorModels.map((value) => (
										<Text
											key={value}
											size="xs"
											style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}
										>
											{resolveModelLabel?.(value) ?? value}
										</Text>
									))}
									<Text size="xs" c="dimmed" mt={4}>
										{t("orchestrationTierPools")}
									</Text>
									{ORCHESTRATION_TIER_NAMES.map((tier) => {
										const pool = profile.tierPools[tier];
										const models = pool.map((value) => resolveModelLabel?.(value) ?? value);
										return (
											<Text
												key={tier}
												size="xs"
												c={pool.length === 0 ? "dimmed" : undefined}
												style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}
											>
												{t(tierLabelKey(tier))}:{" "}
												{models.length > 0 ? models.join(", ") : t("orchestrationPoolEmpty")}
											</Text>
										);
									})}
								</Stack>
							</Box>
						)}
					</Fragment>
				);
			})}
			{onExit && currentProfileId && (
				<Menu.Item
					leftSection={<IconLogout size={14} />}
					disabled={exitPending}
					onClick={() => onExit()}
				>
					{t("orchestrationExit")}
				</Menu.Item>
			)}
		</>
	);
}
