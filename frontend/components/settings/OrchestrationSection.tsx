import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Card,
	Divider,
	Drawer,
	Group,
	Modal,
	MultiSelect,
	NumberInput,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import {
	listOrchestratorModels,
	MAX_ORCHESTRATOR_MODEL_ENTRIES,
	type OrchestratorModelConfig,
	type OrchestratorModelEntry,
} from "@shared/orchestration-orchestrator-model";
import {
	isReasoningEffort,
	REASONING_EFFORT_VALUES,
	type ReasoningEffort,
} from "@shared/reasoning-effort";
import {
	IconArrowDown,
	IconArrowUp,
	IconCopy,
	IconPencil,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelOption } from "../../lib/constants";

const MODEL_SELECT_OPTION_LIMIT = 100;

// ---------------------------------------------------------------------------
// 本地类型 —— 与服务端 settings.agent.orchestration 的形状保持一致。
// 刻意不从 @server/lib/orchestration/types 导入：那份定义由并行的服务端改动
// 引入，依赖它会让前端在它落地之前无法通过类型检查。
// ---------------------------------------------------------------------------

export type OrchestrationTier = "chore" | "quick" | "medium" | "heavy";

/** 四个档位，顺序即界面顺序（从最轻到最重）。 */
export const ORCHESTRATION_TIERS: readonly OrchestrationTier[] = [
	"chore",
	"quick",
	"medium",
	"heavy",
];

export interface OrchestrationPoolEntry {
	/** "provider:modelId" */
	model: string;
	/** 数字越小越优先；省略视同 1。 */
	priority?: number;
	/** 并发上限；省略或 0 视同不限。 */
	maxConcurrent?: number;
	/**
	 * 该条目被选中时的思考强度；**省略表示跟随模型/provider 的既有默认**。
	 *
	 * 刻意不在读取时补默认值：补了之后「用户没配」与「用户配成中等」就是同一份
	 * 数据，界面上的"跟随默认"选项会在保存一次之后变成一个明确的等级。
	 */
	reasoningEffort?: ReasoningEffort;
}

export interface OrchestrationReviewConfig {
	selfReview: boolean;
	independentReview: boolean;
	reviewTier: OrchestrationTier;
	maxReworkAttempts: number;
}

export interface OrchestrationProfile {
	/** [a-z0-9]{4,32}，新建时由前端生成。 */
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	review: OrchestrationReviewConfig;
	tiers: Record<OrchestrationTier, { pool: OrchestrationPoolEntry[] }>;
}

export interface OrchestrationSettings {
	/**
	 * 编制者候选模型（有序，取第一个可用者）。
	 *
	 * 条目允许写成历史形式的纯字符串，或带思考强度的对象；两种写法可以混在同一个
	 * 数组里。读取一律经过 `listOrchestratorModels`，因此本文件的其余逻辑只需要
	 * 面对对象形态这一种情况。
	 */
	orchestratorModels: OrchestratorModelEntry[];
	profiles: OrchestrationProfile[];
}

/**
 * 方案 id 的合法形状与各字段上限。
 * 数值必须与服务端 settings PATCH 的校验（server/lib/validators/orchestration.ts）
 * 一致：界面放过一个越界值，用户只会在保存时拿到一个看不懂的服务端报错。
 */
export const PROFILE_ID_PATTERN = /^[a-z0-9]{4,32}$/;
export const PROFILE_NAME_MAX = 64;
export const PROFILE_DESCRIPTION_MAX = 256;
export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 100;
export const MAX_CONCURRENT_MIN = 1;
export const MAX_CONCURRENT_MAX = 64;
export const MAX_REWORK_ATTEMPTS_MIN = 0;
export const MAX_REWORK_ATTEMPTS_MAX = 5;
/** 每档模型池的条目上限。 */
export const TIER_POOL_MAX = 50;
/** 编制者候选模型数量上限（与共享契约同源，界面与服务端不能各记一个数）。 */
export const ORCHESTRATOR_MODELS_MAX = MAX_ORCHESTRATOR_MODEL_ENTRIES;
/** 方案数量上限。 */
export const PROFILE_COUNT_MAX = 20;

/** 档位标签与能力说明的翻译键。 */
const TIER_LABEL_KEYS: Record<OrchestrationTier, string> = {
	chore: "orchTierChore",
	quick: "orchTierQuick",
	medium: "orchTierMedium",
	heavy: "orchTierHeavy",
};

const TIER_DESC_KEYS: Record<OrchestrationTier, string> = {
	chore: "orchTierChoreDesc",
	quick: "orchTierQuickDesc",
	medium: "orchTierMediumDesc",
	heavy: "orchTierHeavyDesc",
};

// ---------------------------------------------------------------------------
// 纯函数：默认值、反序列化、规范化、校验
// ---------------------------------------------------------------------------

export function createEmptyReviewConfig(): OrchestrationReviewConfig {
	return {
		selfReview: true,
		independentReview: true,
		reviewTier: "quick",
		maxReworkAttempts: 2,
	};
}

export function createEmptyTiers(): Record<OrchestrationTier, { pool: OrchestrationPoolEntry[] }> {
	return {
		chore: { pool: [] },
		quick: { pool: [] },
		medium: { pool: [] },
		heavy: { pool: [] },
	};
}

export function createEmptyOrchestrationSettings(): OrchestrationSettings {
	return { orchestratorModels: [], profiles: [] };
}

function isTier(value: unknown): value is OrchestrationTier {
	return typeof value === "string" && (ORCHESTRATION_TIERS as readonly string[]).includes(value);
}

/**
 * 把服务端值读成正整数；0、负数与非有限数一律按“未设置”处理，
 * 与服务端“省略或 0 视同不限”的语义保持一致。
 */
function normalizeOptionalPositiveInt(value: unknown): number | undefined {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return undefined;
	const int = Math.trunc(num);
	return int > 0 ? int : undefined;
}

function normalizePool(raw: unknown): OrchestrationPoolEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: OrchestrationPoolEntry[] = [];
	const seen = new Set<string>();
	for (const item of raw as unknown[]) {
		const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
		const model = typeof record?.model === "string" ? record.model.trim() : "";
		if (!model || seen.has(model)) continue;
		seen.add(model);
		entries.push(
			buildPoolEntry(model, record?.priority, record?.maxConcurrent, record?.reasoningEffort),
		);
	}
	return entries;
}

/**
 * 以固定键顺序构造池条目，便于用 JSON 比较脏值。
 *
 * 强度只在校验通过时才带上：非法值按"没配"处理（与服务端容错解析同一条口径），
 * 而不是把脏值原样写回去——那会让设置页变成一个把坏数据永久保存下来的地方。
 */
function buildPoolEntry(
	model: string,
	priority: unknown,
	maxConcurrent: unknown,
	reasoningEffort: unknown,
): OrchestrationPoolEntry {
	const normalizedPriority = normalizeOptionalPositiveInt(priority);
	const normalizedConcurrent = normalizeOptionalPositiveInt(maxConcurrent);
	return {
		model,
		...(normalizedPriority !== undefined ? { priority: normalizedPriority } : {}),
		...(normalizedConcurrent !== undefined ? { maxConcurrent: normalizedConcurrent } : {}),
		...(isReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
	};
}

function normalizeReview(raw: unknown): OrchestrationReviewConfig {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const attempts = Number(record.maxReworkAttempts);
	const defaults = createEmptyReviewConfig();
	return {
		selfReview: typeof record.selfReview === "boolean" ? record.selfReview : defaults.selfReview,
		independentReview:
			typeof record.independentReview === "boolean"
				? record.independentReview
				: defaults.independentReview,
		reviewTier: isTier(record.reviewTier) ? record.reviewTier : defaults.reviewTier,
		maxReworkAttempts: Number.isFinite(attempts)
			? Math.trunc(attempts)
			: defaults.maxReworkAttempts,
	};
}

function normalizeProfile(raw: unknown): OrchestrationProfile | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	if (!PROFILE_ID_PATTERN.test(id)) return null;
	const name = typeof record.name === "string" ? record.name : "";
	const description = typeof record.description === "string" ? record.description : undefined;
	const rawTiers = record.tiers && typeof record.tiers === "object" ? record.tiers : {};
	const tiers = createEmptyTiers();
	for (const tier of ORCHESTRATION_TIERS) {
		const tierValue = (rawTiers as Record<string, unknown>)[tier];
		const record2 =
			tierValue && typeof tierValue === "object" ? (tierValue as Record<string, unknown>) : {};
		tiers[tier] = { pool: normalizePool(record2.pool) };
	}
	return {
		id,
		name,
		...(description !== undefined ? { description } : {}),
		enabled: typeof record.enabled === "boolean" ? record.enabled : false,
		review: normalizeReview(record.review),
		tiers,
	};
}

/** 把不受信任的服务端值读成结构完整的编排设置。 */
export function normalizeOrchestrationSettings(raw: unknown): OrchestrationSettings {
	if (!raw || typeof raw !== "object") return createEmptyOrchestrationSettings();
	const record = raw as Record<string, unknown>;
	// 去重、容错与"字符串/对象两种写法"的处理全部交给共享解析：设置页里再写一遍
	// 必然与服务端（选模、展示、校验三处都要读它）漂移。
	const orchestratorModels = listOrchestratorModels(record.orchestratorModels);
	const profiles: OrchestrationProfile[] = [];
	const profileIds = new Set<string>();
	for (const item of Array.isArray(record.profiles) ? record.profiles : []) {
		const profile = normalizeProfile(item);
		if (!profile) continue;
		// 服务端校验不查 id 唯一性，历史/手改数据里可能撞号。撞号时改写后一个的 id
		// 而不是丢掉整个方案——静默丢配置会在下一次保存时把用户的东西抹掉。
		// 改写必须是确定性的（不能用随机 id），否则同一份服务端数据每次读取都会
		// 得到不同的结果，脏值比较会不停地抖动。
		profile.id = resolveProfileIdCollision(profile.id, profileIds);
		profileIds.add(profile.id);
		profiles.push(profile);
	}
	return { orchestratorModels, profiles };
}

/** 撞号时按固定规则派生一个新 id，仍满足 [a-z0-9]{4,32}。 */
function resolveProfileIdCollision(id: string, taken: ReadonlySet<string>): string {
	if (!taken.has(id)) return id;
	for (let n = 2; n < 100; n++) {
		const suffix = String(n);
		const candidate = `${id.slice(0, 32 - suffix.length)}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	// 99 个同号方案已超出任何真实场景，保留原值交给保存时的服务端校验拒绝。
	return id;
}

/**
 * 规范化为固定键顺序。语义不变（不裁剪空白、不补默认值），
 * 只保证同一份配置的 JSON 序列化结果稳定，供脏值比较使用。
 */
export function canonicalizeOrchestrationSettings(
	value: OrchestrationSettings,
): OrchestrationSettings {
	return {
		// 先过一遍共享解析再固化键顺序：传进来的可能是历史字符串写法，
		// 也可能带着非法强度，两者都在这里被收敛成对象形态。
		orchestratorModels: listOrchestratorModels(value.orchestratorModels).map(
			canonicalizeOrchestratorModelEntry,
		),
		profiles: value.profiles.map((profile) => ({
			id: profile.id,
			name: profile.name,
			// 空描述折叠为省略："" 与“没有描述”对下游是同一件事。
			...(profile.description ? { description: profile.description } : {}),
			enabled: profile.enabled,
			review: {
				selfReview: profile.review.selfReview,
				independentReview: profile.review.independentReview,
				reviewTier: profile.review.reviewTier,
				maxReworkAttempts: profile.review.maxReworkAttempts,
			},
			tiers: {
				chore: { pool: profile.tiers.chore.pool.map(canonicalizePoolEntry) },
				quick: { pool: profile.tiers.quick.pool.map(canonicalizePoolEntry) },
				medium: { pool: profile.tiers.medium.pool.map(canonicalizePoolEntry) },
				heavy: { pool: profile.tiers.heavy.pool.map(canonicalizePoolEntry) },
			},
		})),
	};
}

function canonicalizePoolEntry(entry: OrchestrationPoolEntry): OrchestrationPoolEntry {
	return buildPoolEntry(entry.model, entry.priority, entry.maxConcurrent, entry.reasoningEffort);
}

/** 编制者条目的固定键顺序；省略强度时**不带这个键**（"没配"必须可区分）。 */
function canonicalizeOrchestratorModelEntry(
	entry: OrchestratorModelConfig,
): OrchestratorModelConfig {
	return {
		model: entry.model,
		...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
	};
}

/** 保存前收尾：裁剪首尾空白，去掉空描述。 */
export function finalizeOrchestrationSettings(value: OrchestrationSettings): OrchestrationSettings {
	return canonicalizeOrchestrationSettings({
		orchestratorModels: value.orchestratorModels,
		profiles: value.profiles.map((profile) => ({
			...profile,
			name: profile.name.trim(),
			description: (profile.description ?? "").trim(),
		})),
	});
}

/** 生成一个尚未被占用的方案 id（[a-z0-9]{4,32}）。 */
export function generateProfileId(existing: Iterable<string> = []): string {
	const taken = new Set(existing);
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	for (let attempt = 0; attempt < 64; attempt++) {
		let id = "";
		for (let i = 0; i < 8; i++) {
			id += alphabet[Math.floor(Math.random() * alphabet.length)];
		}
		if (!taken.has(id)) return id;
	}
	// 极端冲突下退化为时间戳，仍然满足 id 的合法形状。
	return `p${Date.now().toString(36)}`.slice(0, 32);
}

export type OrchestrationIssueSeverity = "error" | "warning";

/**
 * 校验问题。用结构化的 kind（而不是拼好的文案）表达，
 * 由界面负责翻译，避免校验函数依赖 t()。
 */
export type OrchestrationIssue =
	| { profileId: string; severity: OrchestrationIssueSeverity; kind: "nameRequired" }
	| { profileId: string; severity: OrchestrationIssueSeverity; kind: "nameTooLong"; max: number }
	| {
			profileId: string;
			severity: OrchestrationIssueSeverity;
			kind: "descriptionTooLong";
			max: number;
	  }
	| { profileId: string; severity: OrchestrationIssueSeverity; kind: "duplicateName" }
	| {
			profileId: string;
			severity: OrchestrationIssueSeverity;
			kind: "tierMissing";
			profileName: string;
			tier: OrchestrationTier;
	  }
	| {
			profileId: string;
			severity: OrchestrationIssueSeverity;
			kind: "maxReworkAttemptsRange";
			min: number;
			max: number;
	  };

/**
 * 校验编排设置。
 * - error 会阻止保存：名称缺失/超长、描述超长、重派次数越界、启用中的方案缺档位。
 * - warning 只提示不阻止保存：同名方案（服务端并不禁止，只是编排时难以区分）。
 */
export function validateOrchestrationSettings(value: OrchestrationSettings): OrchestrationIssue[] {
	const issues: OrchestrationIssue[] = [];
	const nameCounts = new Map<string, number>();
	for (const profile of value.profiles) {
		const name = profile.name.trim();
		if (!name) continue;
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}
	for (const profile of value.profiles) {
		const name = profile.name.trim();
		if (!name) {
			issues.push({ profileId: profile.id, severity: "error", kind: "nameRequired" });
		} else {
			if (name.length > PROFILE_NAME_MAX) {
				issues.push({
					profileId: profile.id,
					severity: "error",
					kind: "nameTooLong",
					max: PROFILE_NAME_MAX,
				});
			}
			if ((nameCounts.get(name) ?? 0) > 1) {
				issues.push({ profileId: profile.id, severity: "warning", kind: "duplicateName" });
			}
		}
		if ((profile.description ?? "").trim().length > PROFILE_DESCRIPTION_MAX) {
			issues.push({
				profileId: profile.id,
				severity: "error",
				kind: "descriptionTooLong",
				max: PROFILE_DESCRIPTION_MAX,
			});
		}
		const attempts = profile.review.maxReworkAttempts;
		if (
			!Number.isInteger(attempts) ||
			attempts < MAX_REWORK_ATTEMPTS_MIN ||
			attempts > MAX_REWORK_ATTEMPTS_MAX
		) {
			issues.push({
				profileId: profile.id,
				severity: "error",
				kind: "maxReworkAttemptsRange",
				min: MAX_REWORK_ATTEMPTS_MIN,
				max: MAX_REWORK_ATTEMPTS_MAX,
			});
		}
		// 停用中的方案允许暂时缺档位（草稿状态），启用后必须四档齐全。
		if (!profile.enabled) continue;
		for (const tier of ORCHESTRATION_TIERS) {
			if ((profile.tiers[tier]?.pool ?? []).length === 0) {
				issues.push({
					profileId: profile.id,
					severity: "error",
					kind: "tierMissing",
					profileName: name,
					tier,
				});
			}
		}
	}
	return issues;
}

/** 校验问题在列表里的稳定键：同一方案内除缺档位外都不会重复。 */
function orchestrationIssueKey(issue: OrchestrationIssue): string {
	return issue.kind === "tierMissing"
		? `${issue.profileId}:tierMissing:${issue.tier}`
		: `${issue.profileId}:${issue.kind}`;
}

/** 把一条校验问题翻译成面向用户的文案。 */
export function describeOrchestrationIssue(issue: OrchestrationIssue, t: TFunction): string {
	switch (issue.kind) {
		case "nameRequired":
			return t("orchErrorNameRequired");
		case "nameTooLong":
			return t("orchErrorNameTooLong", { max: issue.max });
		case "descriptionTooLong":
			return t("orchErrorDescriptionTooLong", { max: issue.max });
		case "duplicateName":
			return t("orchWarningDuplicateName");
		case "tierMissing":
			return t("orchErrorTierMissing", {
				name: issue.profileName,
				tier: t(TIER_LABEL_KEYS[issue.tier]),
			});
		case "maxReworkAttemptsRange":
			return t("orchErrorMaxReworkAttempts", { min: issue.min, max: issue.max });
	}
}

// ---------------------------------------------------------------------------
// 池编辑的纯函数
// ---------------------------------------------------------------------------

/** 按选择顺序重建池：保留已有条目的优先级/并发，丢弃取消选择的条目。 */
export function selectPoolModels(
	pool: OrchestrationPoolEntry[],
	models: string[],
): OrchestrationPoolEntry[] {
	const byModel = new Map(pool.map((entry) => [entry.model, entry]));
	return models.map((model) => byModel.get(model) ?? { model });
}

/**
 * 更新单个池条目的优先级/并发上限。
 * 用 `in` 判断而不是 `??`：显式传入 undefined 表示“清空该项”，
 * 若用 `??` 就会退化成“保持原值”，用户将无法取消已填的数字。
 */
export function updatePoolEntry(
	pool: OrchestrationPoolEntry[],
	model: string,
	patch: { priority?: number; maxConcurrent?: number; reasoningEffort?: ReasoningEffort },
): OrchestrationPoolEntry[] {
	return pool.map((entry) =>
		entry.model === model
			? buildPoolEntry(
					entry.model,
					"priority" in patch ? patch.priority : entry.priority,
					"maxConcurrent" in patch ? patch.maxConcurrent : entry.maxConcurrent,
					"reasoningEffort" in patch ? patch.reasoningEffort : entry.reasoningEffort,
				)
			: entry,
	);
}

/** 移动数组元素（不可变）。 */
function reorder<T>(list: T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
	const next = [...list];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** 把 NumberInput 的原始值读成数字；空串与非数字返回 undefined。 */
function numberOrUndefined(value: string | number): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

// ---------------------------------------------------------------------------
// 模型选项
// ---------------------------------------------------------------------------

interface ModelSelectGroup {
	group: string;
	items: Array<{ value: string; label: string }>;
}

/**
 * 把模型列表整理成 MultiSelect 的分组数据。
 * 已配置但不在目录中的模型单独成组，否则用户会看不到自己配置过的条目。
 */
function buildModelSelectData(
	models: ModelOption[],
	providerLabels: Record<string, string>,
	referenced: ReadonlySet<string>,
	unlistedLabel: string,
): ModelSelectGroup[] {
	const groups = new Map<string, Array<{ value: string; label: string }>>();
	const known = new Set<string>();
	for (const model of models) {
		if (known.has(model.value)) continue;
		const prefix = model.provider ?? "__custom__";
		const groupName = providerLabels[prefix] ?? prefix;
		const items = groups.get(groupName) ?? [];
		items.push({ value: model.value, label: `${groupName}:${model.label}` });
		groups.set(groupName, items);
		known.add(model.value);
	}
	const unlisted = [...referenced].filter((model) => !known.has(model)).sort();
	if (unlisted.length > 0) {
		groups.set(
			unlistedLabel,
			unlisted.map((model) => ({ value: model, label: model })),
		);
	}
	return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

function flattenLabels(data: ModelSelectGroup[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const group of data) {
		for (const item of group.items) map.set(item.value, item.label);
	}
	return map;
}

// ---------------------------------------------------------------------------
// 编制者模型（有序多选）
// ---------------------------------------------------------------------------

function OrchestratorModelPicker({
	selected,
	data,
	labelMap,
	onChange,
}: {
	selected: OrchestratorModelEntry[];
	data: ModelSelectGroup[];
	labelMap: Map<string, string>;
	onChange: (models: OrchestratorModelEntry[]) => void;
}) {
	const { t } = useTranslation("settings");
	// 多选控件只认模型引用字符串，而配置里可能还带着每个条目的强度，因此这里显式
	// 做一次转换，而不是把 union 直接喂给 MultiSelect（那会让已有强度在多选一次后消失）。
	const entries = useMemo(() => listOrchestratorModels(selected), [selected]);
	const selectedRefs = useMemo(() => entries.map((entry) => entry.model), [entries]);

	return (
		<Stack gap="xs">
			<MultiSelect
				data={data}
				value={selectedRefs}
				// 新增的条目一律以字符串形态加入（= 强度跟随默认），已有条目原样保留，
				// 因此"只调整顺序或增删模型"这一步不会顺手抹掉任何人配好的强度。
				onChange={(refs) => {
					const byModel = new Map(entries.map((entry) => [entry.model, entry]));
					onChange(refs.map((ref) => byModel.get(ref) ?? ref));
				}}
				searchable
				clearable
				limit={MODEL_SELECT_OPTION_LIMIT}
				maxValues={ORCHESTRATOR_MODELS_MAX}
				placeholder={t("orchOrchestratorPlaceholder")}
			/>
			{entries.length === 0 ? (
				<Text size="xs" c="orange">
					{t("orchOrchestratorEmpty")}
				</Text>
			) : (
				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						{t("orchOrderHint")}
					</Text>
					{entries.map((entry, index) => (
						<Group
							key={entry.model}
							gap="xs"
							wrap="nowrap"
							px={4}
							py={2}
							bg="var(--mantine-color-default)"
							style={{ borderRadius: 4 }}
						>
							<Text size="xs" c="dimmed" w={18} ta="right" style={{ flexShrink: 0 }}>
								{index + 1}
							</Text>
							<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
								{labelMap.get(entry.model) ?? entry.model}
							</Text>
							<ReasoningEffortSelect
								value={entry.reasoningEffort}
								onChange={(effort) =>
									onChange(
										entries.map((item) =>
											item.model === entry.model
												? {
														model: item.model,
														...(effort ? { reasoningEffort: effort } : {}),
													}
												: item,
										),
									)
								}
							/>
							<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
								<ActionIcon
									variant="subtle"
									size="xs"
									disabled={index === 0}
									onClick={() => onChange(reorder(entries, index, index - 1))}
									title={t("orchMoveUp")}
								>
									<IconArrowUp size={12} />
								</ActionIcon>
								<ActionIcon
									variant="subtle"
									size="xs"
									disabled={index === entries.length - 1}
									onClick={() => onChange(reorder(entries, index, index + 1))}
									title={t("orchMoveDown")}
								>
									<IconArrowDown size={12} />
								</ActionIcon>
							</Group>
						</Group>
					))}
				</Stack>
			)}
		</Stack>
	);
}

/** 思考等级的可选项：空值 = 跟随默认，其余取自共享的那张表。 */
const REASONING_EFFORT_CHOICES: readonly ReasoningEffort[] = REASONING_EFFORT_VALUES;

/**
 * 单个模型的思考等级选择。
 *
 * 空选项（`null`）是**一等公民**而不是"没选"：它表示"跟随该模型/provider 的既有
 * 默认"，是绝大多数条目的期望状态。没有它，用户只能在六个等级里硬挑一个，
 * 而"我什么也没配"这个事实会被一次误点永久抹掉。
 */
function ReasoningEffortSelect({
	value,
	onChange,
	label,
}: {
	value: ReasoningEffort | undefined;
	onChange: (effort: ReasoningEffort | undefined) => void;
	label?: string;
}) {
	const { t } = useTranslation("settings");
	return (
		<Select
			label={label}
			size="xs"
			w={120}
			allowDeselect
			clearable
			comboboxProps={{ withinPortal: true }}
			data={[
				{ value: "", label: t("orchReasoningFollowDefault") },
				...REASONING_EFFORT_CHOICES.map((effort) => ({
					value: effort,
					label: t(`orchReasoning_${effort}`),
				})),
			]}
			value={value ?? ""}
			onChange={(next) => onChange(isReasoningEffort(next) ? next : undefined)}
			placeholder={t("orchReasoningFollowDefault")}
		/>
	);
}

// ---------------------------------------------------------------------------
// 单档模型池编辑器
// ---------------------------------------------------------------------------

function TierPoolEditor({
	tier,
	pool,
	data,
	labelMap,
	error,
	onChange,
}: {
	tier: OrchestrationTier;
	pool: OrchestrationPoolEntry[];
	data: ModelSelectGroup[];
	labelMap: Map<string, string>;
	error?: string;
	onChange: (pool: OrchestrationPoolEntry[]) => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<Card withBorder padding="sm">
			<Stack gap={6}>
				<Group justify="space-between" align="center">
					<Text size="sm" fw={600}>
						{t(TIER_LABEL_KEYS[tier])}
					</Text>
					<Badge size="xs" variant="light" color={pool.length > 0 ? "indigo" : "orange"}>
						{t("orchProfileModelCount", { count: pool.length })}
					</Badge>
				</Group>
				<Text size="xs" c="dimmed">
					{t(TIER_DESC_KEYS[tier])}
				</Text>
				<MultiSelect
					label={t("orchTierModels")}
					data={data}
					value={pool.map((entry) => entry.model)}
					onChange={(models) => onChange(selectPoolModels(pool, models))}
					searchable
					clearable
					limit={MODEL_SELECT_OPTION_LIMIT}
					maxValues={TIER_POOL_MAX}
					placeholder={t("orchTierModelsPlaceholder")}
					error={error}
					maxDropdownHeight={240}
				/>
				{pool.length > 0 && (
					<Stack gap={4}>
						<Text size="xs" c="dimmed">
							{t("orchTierNumberHints")}
						</Text>
						{pool.map((entry) => (
							<Group key={entry.model} gap="xs" wrap="nowrap" align="flex-end">
								<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
									{labelMap.get(entry.model) ?? entry.model}
								</Text>
								<NumberInput
									label={t("orchTierPriority")}
									size="xs"
									w={96}
									min={PRIORITY_MIN}
									max={PRIORITY_MAX}
									step={1}
									allowDecimal={false}
									clampBehavior="strict"
									placeholder="1"
									value={entry.priority ?? ""}
									onChange={(value) =>
										onChange(
											updatePoolEntry(pool, entry.model, { priority: numberOrUndefined(value) }),
										)
									}
								/>
								<NumberInput
									label={t("orchTierMaxConcurrent")}
									size="xs"
									w={116}
									min={MAX_CONCURRENT_MIN}
									max={MAX_CONCURRENT_MAX}
									step={1}
									allowDecimal={false}
									clampBehavior="strict"
									placeholder={t("orchUnlimited")}
									value={entry.maxConcurrent ?? ""}
									onChange={(value) =>
										onChange(
											updatePoolEntry(pool, entry.model, {
												maxConcurrent: numberOrUndefined(value),
											}),
										)
									}
								/>
								{/* 每个池条目各自的思考等级：同一个档位里不同模型的能力不同，
								    因此它属于条目而不是档位。留空 = 跟随该模型/provider 的默认。 */}
								<ReasoningEffortSelect
									label={t("orchTierReasoningEffort")}
									value={entry.reasoningEffort}
									onChange={(effort) =>
										onChange(updatePoolEntry(pool, entry.model, { reasoningEffort: effort }))
									}
								/>
							</Group>
						))}
					</Stack>
				)}
			</Stack>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// 单方案编辑器（抽屉）
// ---------------------------------------------------------------------------

function ProfileEditorDrawer({
	profile,
	data,
	labelMap,
	issues,
	onChange,
	onClose,
}: {
	profile: OrchestrationProfile | null;
	data: ModelSelectGroup[];
	labelMap: Map<string, string>;
	issues: OrchestrationIssue[];
	onChange: (patch: Partial<OrchestrationProfile>) => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");

	const profileIssues = useMemo(
		() => issues.filter((issue) => issue.profileId === profile?.id),
		[issues, profile?.id],
	);

	/** 取该方案第一条指定 kind 的问题文案。 */
	const errorFor = (kind: OrchestrationIssue["kind"]): string | undefined => {
		const issue = profileIssues.find((item) => item.kind === kind);
		return issue ? describeOrchestrationIssue(issue, t) : undefined;
	};

	// 字段下方只显示会阻止保存的问题；同名属于提示，放在下方告警区展示，
	// 避免红框让用户误以为必须改掉才能保存。
	const nameError = errorFor("nameRequired") ?? errorFor("nameTooLong");

	return (
		<Drawer
			opened={profile !== null}
			onClose={onClose}
			position="right"
			size="min(100%, 720px)"
			title={t("orchEditProfile")}
			overlayProps={{ backgroundOpacity: 0.45, blur: 2 }}
		>
			{profile && (
				<Stack gap="md">
					<TextInput
						label={t("orchProfileName")}
						placeholder={t("orchProfileNamePlaceholder")}
						value={profile.name}
						onChange={(event) => onChange({ name: event.currentTarget.value })}
						error={nameError}
						maxLength={PROFILE_NAME_MAX}
						withAsterisk
					/>
					<Textarea
						label={t("orchProfileDescription")}
						placeholder={t("orchProfileDescriptionPlaceholder")}
						value={profile.description ?? ""}
						onChange={(event) => onChange({ description: event.currentTarget.value })}
						error={errorFor("descriptionTooLong")}
						maxLength={PROFILE_DESCRIPTION_MAX}
						autosize
						minRows={2}
						maxRows={4}
					/>
					<Switch
						label={t("orchProfileEnabled")}
						description={t("orchProfileEnabledDesc")}
						checked={profile.enabled}
						onChange={(event) => onChange({ enabled: event.currentTarget.checked })}
					/>

					<Divider label={t("orchTiersTitle")} labelPosition="left" />
					{ORCHESTRATION_TIERS.map((tier) => (
						<TierPoolEditor
							key={tier}
							tier={tier}
							pool={profile.tiers[tier].pool}
							data={data}
							labelMap={labelMap}
							error={
								profileIssues.some((issue) => issue.kind === "tierMissing" && issue.tier === tier)
									? t("orchTierEmpty")
									: undefined
							}
							onChange={(pool) => onChange({ tiers: { ...profile.tiers, [tier]: { pool } } })}
						/>
					))}

					<Divider label={t("orchReviewTitle")} labelPosition="left" />
					<Text size="xs" c="dimmed">
						{t("orchReviewDesc")}
					</Text>
					<Switch
						label={t("orchReviewSelfReview")}
						description={t("orchReviewSelfReviewDesc")}
						checked={profile.review.selfReview}
						onChange={(event) =>
							onChange({
								review: { ...profile.review, selfReview: event.currentTarget.checked },
							})
						}
					/>
					<Switch
						label={t("orchReviewIndependent")}
						description={t("orchReviewIndependentDesc")}
						checked={profile.review.independentReview}
						onChange={(event) =>
							onChange({
								review: { ...profile.review, independentReview: event.currentTarget.checked },
							})
						}
					/>
					<Select
						label={t("orchReviewTier")}
						description={t("orchReviewTierDesc")}
						data={ORCHESTRATION_TIERS.map((tier) => ({
							value: tier,
							label: t(TIER_LABEL_KEYS[tier]),
						}))}
						value={profile.review.reviewTier}
						onChange={(value) => {
							if (!isTier(value)) return;
							onChange({ review: { ...profile.review, reviewTier: value } });
						}}
					/>
					<NumberInput
						label={t("orchReviewMaxReworkAttempts")}
						description={t("orchReviewMaxReworkAttemptsDesc")}
						value={profile.review.maxReworkAttempts}
						onChange={(value) =>
							onChange({
								review: {
									...profile.review,
									maxReworkAttempts: numberOrUndefined(value) ?? MAX_REWORK_ATTEMPTS_MIN,
								},
							})
						}
						error={errorFor("maxReworkAttemptsRange")}
						min={MAX_REWORK_ATTEMPTS_MIN}
						max={MAX_REWORK_ATTEMPTS_MAX}
						step={1}
						allowDecimal={false}
						clampBehavior="strict"
					/>

					<Group justify="flex-end">
						<Button variant="default" onClick={onClose}>
							{tc("close")}
						</Button>
					</Group>
				</Stack>
			)}
		</Drawer>
	);
}

// ---------------------------------------------------------------------------
// 方案卡片
// ---------------------------------------------------------------------------

function ProfileCard({
	profile,
	issues,
	onToggle,
	onEdit,
	onCopy,
	onDelete,
}: {
	profile: OrchestrationProfile;
	issues: OrchestrationIssue[];
	onToggle: (enabled: boolean) => void;
	onEdit: () => void;
	onCopy: () => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation("settings");
	const hasError = issues.some(
		(issue) => issue.profileId === profile.id && issue.severity === "error",
	);
	const hasWarning = issues.some(
		(issue) => issue.profileId === profile.id && issue.severity === "warning",
	);
	const displayName = profile.name.trim() || t("orchUnnamedProfile");

	return (
		<Card withBorder padding="sm">
			<Group justify="space-between" wrap="nowrap" align="flex-start">
				<Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
					<Group gap="xs" wrap="nowrap">
						<Text size="sm" fw={600} truncate>
							{displayName}
						</Text>
						{!profile.enabled && (
							<Badge size="xs" variant="light" color="gray">
								{t("orchProfileDisabledBadge")}
							</Badge>
						)}
						{hasError && (
							<Badge size="xs" variant="light" color="red">
								{t("orchIssueErrorBadge")}
							</Badge>
						)}
						{!hasError && hasWarning && (
							<Badge size="xs" variant="light" color="yellow">
								{t("orchIssueWarningBadge")}
							</Badge>
						)}
					</Group>
					{profile.description && (
						<Text size="xs" c="dimmed" lineClamp={2}>
							{profile.description}
						</Text>
					)}
					<Group gap={4}>
						{ORCHESTRATION_TIERS.map((tier) => {
							const count = profile.tiers[tier].pool.length;
							return (
								<Badge key={tier} size="xs" variant="light" color={count > 0 ? "indigo" : "gray"}>
									{t(TIER_LABEL_KEYS[tier])} · {count}
								</Badge>
							);
						})}
					</Group>
				</Stack>
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					<Switch
						size="sm"
						checked={profile.enabled}
						onChange={(event) => onToggle(event.currentTarget.checked)}
						aria-label={t("orchProfileEnabled")}
					/>
					<ActionIcon variant="subtle" size="sm" onClick={onEdit} title={t("orchEditProfile")}>
						<IconPencil size={14} />
					</ActionIcon>
					<ActionIcon variant="subtle" size="sm" onClick={onCopy} title={t("orchCopyProfile")}>
						<IconCopy size={14} />
					</ActionIcon>
					<ActionIcon
						variant="subtle"
						color="red"
						size="sm"
						onClick={onDelete}
						title={t("orchDeleteProfile")}
					>
						<IconTrash size={14} />
					</ActionIcon>
				</Group>
			</Group>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// 主区块
// ---------------------------------------------------------------------------

export interface OrchestrationSectionProps {
	value: OrchestrationSettings;
	onChange: (next: OrchestrationSettings) => void;
	/** 可选模型（值形如 "provider:modelId"）。 */
	models: ModelOption[];
	/** provider 前缀 → 显示名。 */
	providerLabels?: Record<string, string>;
	/** 由页面统一校验后传入，避免两处校验结果不一致。 */
	issues?: OrchestrationIssue[];
}

export function OrchestrationSection({
	value,
	onChange,
	models,
	providerLabels = {},
	issues = [],
}: OrchestrationSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

	const referenced = useMemo(() => {
		const set = new Set<string>(
			listOrchestratorModels(value.orchestratorModels).map((entry) => entry.model),
		);
		for (const profile of value.profiles) {
			for (const tier of ORCHESTRATION_TIERS) {
				for (const entry of profile.tiers[tier].pool) set.add(entry.model);
			}
		}
		return set;
	}, [value]);

	const modelData = useMemo(
		() => buildModelSelectData(models, providerLabels, referenced, t("orchModelsUnlisted")),
		[models, providerLabels, referenced, t],
	);
	const labelMap = useMemo(() => flattenLabels(modelData), [modelData]);

	const editingProfile = value.profiles.find((profile) => profile.id === editingId) ?? null;
	const deleteTarget = value.profiles.find((profile) => profile.id === pendingDeleteId) ?? null;

	// 抽屉里被编辑的方案被删掉后不能继续挂着编辑态。
	useEffect(() => {
		if (editingId && !value.profiles.some((profile) => profile.id === editingId)) {
			setEditingId(null);
		}
	}, [editingId, value.profiles]);

	const updateProfile = (id: string, patch: Partial<OrchestrationProfile>) => {
		onChange({
			...value,
			profiles: value.profiles.map((profile) =>
				profile.id === id ? { ...profile, ...patch } : profile,
			),
		});
	};

	const addProfile = () => {
		const id = generateProfileId(value.profiles.map((profile) => profile.id));
		const profile: OrchestrationProfile = {
			id,
			name: "",
			enabled: false,
			review: createEmptyReviewConfig(),
			tiers: createEmptyTiers(),
		};
		onChange({ ...value, profiles: [...value.profiles, profile] });
		setEditingId(id);
	};

	const copyProfile = (source: OrchestrationProfile) => {
		const id = generateProfileId(value.profiles.map((profile) => profile.id));
		const index = value.profiles.findIndex((profile) => profile.id === source.id);
		const copy: OrchestrationProfile = {
			...source,
			id,
			name: `${source.name.trim() || t("orchUnnamedProfile")}${t("orchProfileCopySuffix")}`.slice(
				0,
				PROFILE_NAME_MAX,
			),
			enabled: false,
			review: { ...source.review },
			tiers: {
				chore: { pool: source.tiers.chore.pool.map((entry) => ({ ...entry })) },
				quick: { pool: source.tiers.quick.pool.map((entry) => ({ ...entry })) },
				medium: { pool: source.tiers.medium.pool.map((entry) => ({ ...entry })) },
				heavy: { pool: source.tiers.heavy.pool.map((entry) => ({ ...entry })) },
			},
		};
		const profiles = [...value.profiles];
		profiles.splice(index + 1, 0, copy);
		onChange({ ...value, profiles });
	};

	const confirmDelete = () => {
		if (!pendingDeleteId) return;
		onChange({
			...value,
			profiles: value.profiles.filter((profile) => profile.id !== pendingDeleteId),
		});
		setPendingDeleteId(null);
	};

	const errors = issues.filter((issue) => issue.severity === "error");
	const warnings = issues.filter((issue) => issue.severity === "warning");
	const deleteCancelLabel = tc("cancel");
	const deleteConfirmLabel = tc("delete");
	// 方案数量同样受服务端上限约束，到顶时直接禁用新建，而不是等保存才报错。
	const profilesFull = value.profiles.length >= PROFILE_COUNT_MAX;

	return (
		<Stack gap="lg">
			<Stack gap={4}>
				<Text size="sm" fw={600}>
					{t("orchOrchestratorTitle")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("orchOrchestratorDesc")}
				</Text>
				<OrchestratorModelPicker
					selected={value.orchestratorModels}
					data={modelData}
					labelMap={labelMap}
					onChange={(orchestratorModels) => onChange({ ...value, orchestratorModels })}
				/>
			</Stack>

			<Divider />

			<Stack gap="xs">
				<Group justify="space-between" align="center">
					<div>
						<Text size="sm" fw={600}>
							{t("orchProfilesTitle")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("orchProfilesDesc")}
						</Text>
					</div>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						onClick={addProfile}
						disabled={profilesFull}
					>
						{t("orchAddProfile")}
					</Button>
				</Group>

				{profilesFull && (
					<Text size="xs" c="dimmed">
						{t("orchProfilesMaxReached", { max: PROFILE_COUNT_MAX })}
					</Text>
				)}

				{value.profiles.length === 0 && (
					<Text size="xs" c="dimmed" fs="italic">
						{t("orchProfilesEmpty")}
					</Text>
				)}

				{value.profiles.map((profile) => (
					<ProfileCard
						key={profile.id}
						profile={profile}
						issues={issues}
						onToggle={(enabled) => updateProfile(profile.id, { enabled })}
						onEdit={() => setEditingId(profile.id)}
						onCopy={() => copyProfile(profile)}
						onDelete={() => setPendingDeleteId(profile.id)}
					/>
				))}
			</Stack>

			{errors.length > 0 && (
				<Alert color="red" variant="light" title={t("orchIssuesTitle")}>
					<Stack gap={2}>
						{errors.map((issue) => (
							<Text size="xs" key={orchestrationIssueKey(issue)}>
								· {describeOrchestrationIssue(issue, t)}
							</Text>
						))}
					</Stack>
				</Alert>
			)}

			{warnings.length > 0 && (
				<Alert color="yellow" variant="light" title={t("orchWarningsTitle")}>
					<Stack gap={2}>
						{warnings.map((issue) => (
							<Text size="xs" key={orchestrationIssueKey(issue)}>
								· {describeOrchestrationIssue(issue, t)}
							</Text>
						))}
					</Stack>
				</Alert>
			)}

			<ProfileEditorDrawer
				profile={editingProfile}
				data={modelData}
				labelMap={labelMap}
				issues={issues}
				onChange={(patch) => {
					if (editingId) updateProfile(editingId, patch);
				}}
				onClose={() => setEditingId(null)}
			/>

			{/* 删除不可逆，先弹出确认框并回显方案名。 */}
			<Modal
				opened={deleteTarget !== null}
				onClose={() => setPendingDeleteId(null)}
				title={t("orchDeleteProfile")}
				size="sm"
			>
				<Stack gap="md">
					<Text size="sm">
						{t("orchDeleteProfileConfirm", {
							name: deleteTarget?.name.trim() || t("orchUnnamedProfile"),
						})}
					</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setPendingDeleteId(null)}>
							{deleteCancelLabel}
						</Button>
						<Button color="red" onClick={confirmDelete}>
							{deleteConfirmLabel}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
