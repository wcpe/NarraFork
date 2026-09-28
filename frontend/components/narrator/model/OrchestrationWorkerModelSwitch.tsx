/**
 * 编排 worker 的「换模型继续」选择器（阶段 6）。
 *
 * 两个入口共用它：错误卡片上的按钮（6.2，作用于 worker 自己的会话面板）与子代理
 * 卡片上的模型 badge（6.3，作用于父会话里那张卡片）。两处都只是"打开它"，模型池、
 * 提交、反馈全部在这一个组件里，因此不存在两份实现各自漂移。
 *
 * 默认只列**该 worker 档位池内**的模型：编排的语义是池内调度，服务端也只接受池内
 * 模型（池外会让容量记账与容量均摊失真）。因此这里没有搜索框、没有全量模型列表—
 * 一个可以乱选的选择器只会让用户先选再被拒。
 *
 * **唯一例外**：池内一个可用模型都没有时（恰恰是用户最想换模型的时刻，按池限制会
 * 把人锁死），列表改为"池内在前 + 全部可用的池外模型"，池外项带显式标识与说明，
 * 说明它本次不计入该档位的容量统计。判定与候选顺序都在
 * `./worker-model-switch` 的纯函数里，这里只负责渲染与提交。
 *
 * 列表数据来自 `useAllModels().orchestrationOptions`（阶段 3 补建立的编排菜单数据源），
 * 与模型菜单里看到的是同一份 `tierPools`；`available` 标记与 `visibleModels` 来自
 * 同一份 hook 的模型清单。
 */

import {
	Alert,
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconArrowsExchange, IconCheck } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../../hooks/useModels";
import { api } from "../../../lib/api";
import {
	isWorkerModelSwitchPoolExhausted,
	labelForPoolModel,
	resolveWorkerModelSwitchScope,
	type WorkerModelCandidate,
	type WorkerModelSwitchScope,
	workerModelSwitchCandidates,
	workerModelSwitchSuccessMessageKey,
	workerTierPoolModels,
} from "./worker-model-switch";

/** 打开选择器时需要的上下文：谁是编排会话、要救哪个 worker。 */
export interface WorkerModelSwitchTarget {
	/** 编排会话（编制者）的 narrator id。 */
	primaryNarratorId: string;
	/** 要救活的 worker（执行者或复核者）。 */
	workerNarratorId: string;
	/** worker 的子代理类型编码（`orch--…` / `orch-review--…`）。 */
	subagentType: string | null | undefined;
	/** worker 现在的模型，命中池内模型时给一行提示，避免"我以为还是旧的"。 */
	currentModel?: string | null;
	/**
	 * 本次失败归因的模型（narrator 行 `errorMessage` 信封）。
	 *
	 * 它是"池是否已经全不可用"的一条证据：非 NUG 提供者的配额墙不会出现在任何
	 * `available` 标记上，只有这一次被拒的请求能证明池里那个模型此刻不能用。
	 */
	failedModel?: string | null;
}

export interface WorkerModelSwitchModalProps {
	opened: boolean;
	target: WorkerModelSwitchTarget | null;
	onClose: () => void;
	/** 换成功（或等待中的 turn 已切到新模型）后的回调。 */
	onSwitched?: (info: { model: string; continuation: "restarted" | "in_place" }) => void;
}

export function OrchestrationWorkerModelSwitchModal({
	opened,
	target,
	onClose,
	onSwitched,
}: WorkerModelSwitchModalProps) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const { orchestrationOptions, menuModels, allModels, visibleModels, disabledProviders } =
		useAllModels();
	const [submitting, setSubmitting] = useState<string | null>(null);

	const scope: WorkerModelSwitchScope | null = useMemo(
		() => resolveWorkerModelSwitchScope(target?.subagentType),
		[target?.subagentType],
	);
	const pool = useMemo(
		() => (scope ? workerTierPoolModels(scope, orchestrationOptions) : []),
		[scope, orchestrationOptions],
	);
	const candidates = useMemo<WorkerModelCandidate[]>(
		() =>
			scope
				? workerModelSwitchCandidates(scope, orchestrationOptions, {
						allModels,
						visibleModels,
						disabledProviders,
						failedModel: target?.failedModel ?? null,
					})
				: [],
		[allModels, disabledProviders, orchestrationOptions, scope, target?.failedModel, visibleModels],
	);
	// 顶部说明按池的真实状态给（池非空且一个可用的都没有），而不是"候选里恰好有
	// 池外项"：池外一个可用的都没有时，同样要把"池已满"这件事说出来。
	const poolExhausted = useMemo(
		() =>
			scope
				? isWorkerModelSwitchPoolExhausted(scope, orchestrationOptions, {
						allModels,
						visibleModels,
						disabledProviders,
						failedModel: target?.failedModel ?? null,
					})
				: false,
		[allModels, disabledProviders, orchestrationOptions, scope, target?.failedModel, visibleModels],
	);

	const submit = useCallback(
		async (model: string) => {
			if (!target || !scope || submitting) return;
			setSubmitting(model);
			try {
				const result = await api.recoverOrchestrationWorker(target.primaryNarratorId, {
					workerNarratorId: target.workerNarratorId,
					model,
					action: "continue",
				});
				// 换模型会让这个 worker 原来的"等待恢复"通知失效（与 useUpdateModel 同理），
				// 那条常驻通知必须收起，否则它一直说"还在等"。
				notifications.hide(`model-unavailable-${target.workerNarratorId}`);
				qc.invalidateQueries({ queryKey: ["narrators", target.workerNarratorId] });
				qc.invalidateQueries({ queryKey: ["narrators"] });
				notifications.show({
					title: t("workerModelSwitchSuccessTitle"),
					// 池外换模型必须显式说出来（容量统计不含它），因此文案由
					// `outOfPool` 优先决定，而不是给两条既有文案缀一句。
					message: t(
						workerModelSwitchSuccessMessageKey({
							continuation: result.continuation,
							outOfPool: result.outOfPool,
						}),
						{ model: labelForPoolModel(model, menuModels) },
					),
					color: "green",
					autoClose: 5000,
				});
				onSwitched?.({ model, continuation: result.continuation });
				onClose();
			} catch (error) {
				notifications.show({
					title: t("workerModelSwitchFailed"),
					// 服务端的拒绝理由就是给用户看的（池外模型会连可选列表一起列出来），
					// 因此原样透传，不再包一层"操作失败"。
					message:
						error instanceof Error && error.message
							? error.message
							: t("workerModelSwitchFailedDesc"),
					color: "red",
					autoClose: 8000,
				});
			} finally {
				setSubmitting(null);
			}
		},
		[menuModels, onClose, onSwitched, qc, scope, submitting, t, target],
	);

	return (
		<Modal
			opened={opened && target !== null}
			onClose={onClose}
			title={t("workerModelSwitchTitle")}
			size="md"
			centered
		>
			<Stack gap="sm">
				<Text size="xs" c="dimmed">
					{t("workerModelSwitchDesc")}
				</Text>
				{target?.currentModel ? (
					<Group gap={6}>
						<Text size="xs" c="dimmed">
							{t("workerModelSwitchCurrent")}
						</Text>
						<Badge size="xs" variant="light" color="violet">
							{labelForPoolModel(target.currentModel, menuModels)}
						</Badge>
					</Group>
				) : null}
				{scope && pool.length === 0 ? (
					<Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
						<Text size="xs">{t("workerModelSwitchEmptyPool", { tier: scope.tier })}</Text>
					</Alert>
				) : null}
				{poolExhausted ? (
					<Alert
						color="orange"
						icon={<IconAlertTriangle size={16} />}
						data-testid="worker-model-switch-pool-exhausted"
					>
						<Text size="xs" fw={600}>
							{t("workerModelSwitchPoolExhaustedTitle")}
						</Text>
						<Text size="xs">{t("workerModelSwitchPoolExhaustedDesc")}</Text>
					</Alert>
				) : null}
				{candidates.map((candidate, index) => {
					const label = labelForPoolModel(candidate.model, menuModels);
					const isCurrent = target?.currentModel === candidate.model;
					// 池外分区开始处插一条分隔与标题：逐行标"池外"仍能看，但列表一长
					// 就会分不清哪一段还在池内。
					const startsOutOfPoolSection =
						candidate.outOfPool && candidates[index - 1]?.outOfPool !== true;
					return (
						<Stack key={candidate.model} gap={6}>
							{startsOutOfPoolSection ? (
								<Divider
									label={t("workerModelSwitchOutOfPoolSection")}
									labelPosition="left"
									data-testid="worker-model-switch-out-of-pool-divider"
								/>
							) : null}
							<UnstyledButton
								data-testid="worker-model-switch-option"
								data-model={candidate.model}
								data-out-of-pool={candidate.outOfPool ? "true" : "false"}
								disabled={submitting !== null}
								onClick={() => void submit(candidate.model)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									width: "100%",
									padding: "8px 10px",
									borderRadius: "var(--mantine-radius-sm)",
									background: "var(--mantine-color-default-hover)",
								}}
							>
								<IconArrowsExchange size={14} />
								<Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
									{label}
								</Text>
								{candidate.outOfPool ? (
									<Badge
										size="xs"
										variant="light"
										color="orange"
										data-testid="worker-model-switch-out-of-pool-badge"
									>
										{t("workerModelSwitchOutOfPoolBadge")}
									</Badge>
								) : null}
								{candidate.model !== label ? (
									<Text size="xs" c="dimmed" truncate>
										{candidate.model}
									</Text>
								) : null}
								{isCurrent ? (
									<Badge size="xs" variant="light" color="gray">
										<IconCheck size={10} />
									</Badge>
								) : null}
								{submitting === candidate.model ? <Loader size={14} /> : null}
							</UnstyledButton>
							{candidate.outOfPool ? (
								// 逐行说明「本次不在池内，容量统计不含它」：选择器没有独立的
								// 确认步骤（点击即提交），提示只能挂在它旁边，否则用户点完就
								// 只剩滚动条上方那条总说明。
								<Text
									size="xs"
									c="dimmed"
									pl={24}
									data-testid="worker-model-switch-out-of-pool-note"
								>
									{t("workerModelSwitchOutOfPoolNote")}
								</Text>
							) : null}
						</Stack>
					);
				})}
				<Group justify="flex-end">
					<Button variant="subtle" size="xs" onClick={onClose} disabled={submitting !== null}>
						{t("workerModelSwitchCancel")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

export interface OrchestrationWorkerModelSwitchHandle {
	/** 打开选择器；target 为 null 时什么都不做。 */
	open: (target: WorkerModelSwitchTarget) => void;
	close: () => void;
	/** 宿主（列表壳）渲染一次即可。 */
	modal: React.ReactNode;
}

/**
 * 列表壳只挂一次这个 hook：行是零 DOM 副本，自己不能拥有模态框（与错误卡片的
 * 重试规则弹窗同一个理由）。行只负责"告诉我是谁"，选择器与提交都在这里。
 */
export function useOrchestrationWorkerModelSwitch(): OrchestrationWorkerModelSwitchHandle {
	const [target, setTarget] = useState<WorkerModelSwitchTarget | null>(null);
	const open = useCallback((next: WorkerModelSwitchTarget) => setTarget(next), []);
	const close = useCallback(() => setTarget(null), []);
	const modal = (
		<OrchestrationWorkerModelSwitchModal opened={target !== null} target={target} onClose={close} />
	);
	return { open, close, modal };
}
