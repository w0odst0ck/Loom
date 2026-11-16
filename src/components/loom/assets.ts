/**
 * 资源注册表 —— 加新数据集/图集只改 loom/assets/*.json。
 *
 * 定位：资源 = 「本地有权重的存货」。站点只放预览与元数据，
 * 原档永远在本地，需要的人通过评论区留言索取。
 *
 * 与「看板」的区别：
 *   看板 = 数据长什么样（图表、趋势）
 *   资源 = 数据能拿来干什么（本体 + 元数据 + 索取入口）
 *
 * 边界校验：构建期 fail-fast，坏数据不让上线（避免渲染空卡片）。
 */
import assetsData from "../../../assets/manifest.json";

/** 资源形态 —— 决定详情页用什么展示器 */
export type AssetKind = "gallery" | "dataset" | "document";

/** 资源状态 */
export type AssetStatus = "available" | "collecting" | "planned";

export interface AssetPreview {
	/** 缩略图相对路径（放在 public/assets/<id>/ 下） */
	src: string;
	/** 无障碍描述，必填（图集尤其需要） */
	alt: string;
	/** 可选标题 */
	caption?: string;
}

export interface Asset {
	id: string;
	title: string;
	/** 一句话说明这是什么 */
	summary: string;
	/** 详细说明（详情页展示） */
	description?: string;
	kind: AssetKind;
	status: AssetStatus;
	/** 标签，用于筛选与看板分组统计 */
	tags: string[];
	/** 内容规模，如 "128 张" / "18,400 条" */
	scale: string;
	/** 原始体积，如 "2.4 GB" */
	size?: string;
	/** 采集/整理时间 YYYY-MM-DD */
	created_at: string;
	/** 最后更新 YYYY-MM-DD */
	updated_at?: string;
	/** 数据来源说明（合规透明） */
	source?: string;
	/** 格式，如 "JSONL" / "PNG" */
	format?: string;
	/** 预览样本（图集用，建议 6-12 张） */
	previews?: AssetPreview[];
	/** 字段/内容说明（数据集用） */
	schema?: Array<{ field: string; desc: string }>;
}

const VALID_KIND: AssetKind[] = ["gallery", "dataset", "document"];
const VALID_STATUS: AssetStatus[] = ["available", "collecting", "planned"];

const KIND_LABEL: Record<AssetKind, string> = {
	gallery: "图集",
	dataset: "数据集",
	document: "文档",
};

const STATUS_LABEL: Record<AssetStatus, string> = {
	available: "可索取",
	collecting: "采集中",
	planned: "筹备中",
};

export { KIND_LABEL, STATUS_LABEL };

function validate(raw: unknown, idx: number): Asset {
	if (!raw || typeof raw !== "object") {
		throw new Error(`[assets] manifest[${idx}]: 不是对象`);
	}
	const a = raw as Record<string, unknown>;

	for (const key of [
		"id",
		"title",
		"summary",
		"kind",
		"status",
		"scale",
		"created_at",
	]) {
		if (typeof a[key] !== "string" || !(a[key] as string).trim()) {
			throw new Error(`[assets] manifest[${idx}]: 缺少或为空字段 "${key}"`);
		}
	}

	if (!VALID_KIND.includes(a.kind as AssetKind)) {
		throw new Error(
			`[assets] "${a.id}": kind="${a.kind}" 非法（应为 ${VALID_KIND.join(" / ")}）`,
		);
	}
	if (!VALID_STATUS.includes(a.status as AssetStatus)) {
		throw new Error(
			`[assets] "${a.id}": status="${a.status}" 非法（应为 ${VALID_STATUS.join(" / ")}）`,
		);
	}
	if (!Array.isArray(a.tags)) {
		throw new Error(`[assets] "${a.id}": tags 必须是数组`);
	}

	const dateRe = /^\d{4}-\d{2}-\d{2}$/;
	if (!dateRe.test(a.created_at as string)) {
		throw new Error(
			`[assets] "${a.id}": created_at="${a.created_at}" 不是 YYYY-MM-DD`,
		);
	}
	if (a.updated_at && !dateRe.test(a.updated_at as string)) {
		throw new Error(
			`[assets] "${a.id}": updated_at="${a.updated_at}" 不是 YYYY-MM-DD`,
		);
	}

	// 预览必须是数组，且每项 src/alt 齐全（alt 缺失会让图集对读屏用户完全不可用）
	const previews = a.previews as AssetPreview[] | undefined;
	if (previews !== undefined) {
		if (!Array.isArray(previews)) {
			throw new Error(`[assets] "${a.id}": previews 必须是数组`);
		}
		previews.forEach((p, i) => {
			if (!p || typeof p !== "object") {
				throw new Error(`[assets] "${a.id}".previews[${i}]: 不是对象`);
			}
			if (!p.src || !p.alt) {
				throw new Error(
					`[assets] "${a.id}".previews[${i}]: src 与 alt 都是必填`,
				);
			}
		});
	}

	return {
		id: a.id as string,
		title: a.title as string,
		summary: a.summary as string,
		description: a.description as string | undefined,
		kind: a.kind as AssetKind,
		status: a.status as AssetStatus,
		tags: a.tags as string[],
		scale: a.scale as string,
		size: a.size as string | undefined,
		created_at: a.created_at as string,
		updated_at: a.updated_at as string | undefined,
		source: a.source as string | undefined,
		format: a.format as string | undefined,
		previews,
		schema: a.schema as Asset["schema"],
	};
}

const raw = assetsData as { assets?: unknown[] };
if (!raw || !Array.isArray(raw.assets)) {
	throw new Error('[assets] manifest.json: 顶层必须是 { "assets": [...] }');
}

const validated = raw.assets.map(validate);

// id 必须唯一：详情页路由 /resources/<id>/ 由 id 派生，重复会互相覆盖
const seen = new Set<string>();
for (const a of validated) {
	if (seen.has(a.id)) {
		throw new Error(`[assets] id 重复："${a.id}"（会覆盖详情页路由）`);
	}
	seen.add(a.id);
}

export const assets: Asset[] = validated.sort((x, y) =>
	(y.updated_at ?? y.created_at).localeCompare(x.updated_at ?? x.created_at),
);

export const assetCount = assets.length;

/** 按形态计数（看板用） */
export function countByKind(): Record<AssetKind, number> {
	const out = { gallery: 0, dataset: 0, document: 0 } as Record<
		AssetKind,
		number
	>;
	for (const a of assets) out[a.kind] += 1;
	return out;
}

/** 标签频次，降序（看板「门类分布」用） */
export function tagCounts(): Array<{ tag: string; count: number }> {
	const map = new Map<string, number>();
	for (const a of assets) {
		for (const t of a.tags) map.set(t, (map.get(t) ?? 0) + 1);
	}
	return [...map.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag));
}

/** 全部标签去重（资源页筛选器用） */
export const allTags: string[] = [
	...new Set(assets.flatMap((a) => a.tags)),
].sort();

export function getAsset(id: string): Asset | undefined {
	return assets.find((a) => a.id === id);
}

/** 资源最晚更新日（首页概览用） */
export const assetsLatest =
	assets
		.map((a) => a.updated_at ?? a.created_at)
		.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
		.sort()
		.at(-1) ?? "";
