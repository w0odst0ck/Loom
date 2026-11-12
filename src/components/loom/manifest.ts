/**
 * 模块注册表 —— 加新模块只改这一处。
 *
 * 步骤：
 *   1. 在 scripts/export/ 写一个导出脚本，产出 site/src/data/<id>.json
 *   2. 在下面 modules 数组加一行
 *   3. 完成 —— 首页自动渲染，不需要改任何页面代码
 *
 * 边界校验：JSON 在构建时校验必需字段，坏数据 fail-fast（而不是渲染空卡片）。
 */
import intelJson from "../../data/intel.json";
import marketJson from "../../data/market.json";
import opsJson from "../../data/ops.json";

export interface LoomModule {
	id: string;
	title: string;
	subtitle: string;
	status: "active" | "planning" | "placeholder";
	kind: string;
	updated_at: string;
	sections: Array<{
		id: string;
		title: string;
		kind: string;
		data: unknown;
		note?: string;
	}>;
	meta?: Record<string, unknown>;
}

const VALID_STATUS = ["active", "planning", "placeholder"];
/** 区块类型唯一真相源（ModuleCard 也从这里导入，避免两处漂移） */
export const SECTION_KINDS = [
	"kpi",
	"series",
	"distribution",
	"table",
	"text",
] as const;

/** 构建时校验：缺字段 / 状态非法 → 直接报错，不静默渲染空卡片 */
function validate(raw: unknown, file: string): LoomModule {
	if (!raw || typeof raw !== "object") {
		throw new Error(`[loom] ${file}: 顶层不是对象`);
	}
	const m = raw as Record<string, unknown>;
	for (const key of ["id", "title", "status"]) {
		if (typeof m[key] !== "string" || !(m[key] as string).trim()) {
			throw new Error(`[loom] ${file}: 缺少或为空字段 "${key}"`);
		}
	}
	if (!VALID_STATUS.includes(m.status as string)) {
		throw new Error(
			`[loom] ${file}: status="${m.status}" 非法（应为 ${VALID_STATUS.join(" / ")}）`,
		);
	}
	if (!Array.isArray(m.sections)) {
		throw new Error(`[loom] ${file}: sections 必须是数组`);
	}
	// updated_at 允许为空，非空时必须为 YYYY-MM-DD（否则 latestUpdate 会静默丢掉它）
	const updatedAt = typeof m.updated_at === "string" ? m.updated_at.trim() : "";
	if (updatedAt && !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) {
		throw new Error(
			`[loom] ${file}: updated_at="${updatedAt}" 不是 YYYY-MM-DD`,
		);
	}
	// 逐 section 校验必需字段（fail-fast，不让坏区块到渲染期才暴露）
	const sections = (m.sections as unknown[]).map((raw, i) => {
		if (!raw || typeof raw !== "object") {
			throw new Error(`[loom] ${file}: sections[${i}] 不是对象`);
		}
		const s = raw as Record<string, unknown>;
		for (const key of ["id", "title", "kind"]) {
			if (typeof s[key] !== "string" || !(s[key] as string).trim()) {
				throw new Error(`[loom] ${file}: sections[${i}] 缺少 "${key}"`);
			}
		}
		if (!SECTION_KINDS.includes(s.kind as (typeof SECTION_KINDS)[number])) {
			throw new Error(
				`[loom] ${file}: sections[${i}].kind="${s.kind}" 未知（应为 ${SECTION_KINDS.join(" / ")}）`,
			);
		}
		if (!("data" in s)) {
			throw new Error(`[loom] ${file}: sections[${i}] 缺少 "data"`);
		}
		return {
			id: s.id as string,
			title: s.title as string,
			kind: s.kind as string,
			data: s.data,
			note: typeof s.note === "string" ? s.note : undefined,
		};
	});

	return {
		id: m.id as string,
		title: m.title as string,
		subtitle: typeof m.subtitle === "string" ? m.subtitle : "",
		status: m.status as LoomModule["status"],
		kind: typeof m.kind === "string" ? m.kind : "mixed",
		updated_at: typeof m.updated_at === "string" ? m.updated_at : "",
		sections,
		meta:
			m.meta && typeof m.meta === "object" && !Array.isArray(m.meta)
				? (m.meta as Record<string, unknown>)
				: {},
	};
}

const validated = [
	validate(intelJson, "intel.json"),
	validate(marketJson, "market.json"),
	validate(opsJson, "ops.json"),
];

// 模块 id 必须全局唯一：图表 gradient id 由 `${m.id}-${s.id}-${si}` 派生，
// 重复会导致 url(#...) 指错图表。坏数据一律构建期 fail-fast。
const seenIds = new Set<string>();
for (const m of validated) {
	if (seenIds.has(m.id)) {
		throw new Error(`[loom] 模块 id 重复："${m.id}"（模块 id 必须全局唯一）`);
	}
	seenIds.add(m.id);
}

export const modules: LoomModule[] = validated;

export const activeCount = modules.filter((m) => m.status === "active").length;

/** 按状态计数（页面从这里取，避免在模板里重复推导导致漂移） */
export function countByStatus(status: LoomModule["status"]): number {
	return modules.filter((m) => m.status === status).length;
}

/** 数据最新日期（YYYY-MM-DD 零填充，字典序即时间序） */
export const latestUpdate =
	modules
		.map((m) => m.updated_at)
		.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
		.sort()
		.at(-1) ?? "";
