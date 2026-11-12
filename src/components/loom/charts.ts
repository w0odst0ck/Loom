/**
 * Loom 图表工具 —— 构建时生成内联 SVG，运行时零 JS 依赖。
 *
 * 为什么自己写不用 ECharts：
 *   1. 静态站点要"秒开"，不想加载 1MB 图表库
 *   2. 视觉要可控（数据杂志风格，不是通用 BI）
 *   3. SVG 内联 → 可被 CSS 动画、可被搜索引擎读、可打印
 *
 * ⚠️ 安全：所有插值进 SVG/HTML 的数据（标签、名称）都必须过 esc()。
 *    数据来自外部采集器，属于不可信输入。
 */

export interface Point {
	[label: string]: string | number;
}

export interface LineOpts {
	width?: number;
	height?: number;
	stroke?: string;
	showAxis?: boolean;
	showArea?: boolean;
	/** 用于生成唯一 gradient id，避免同页多图 id 冲突 */
	idSuffix?: string;
}

/** 统一调色板（图例与环形图共用，避免两处漂移） */
export const PALETTE = [
	"#e8b44a",
	"#5fb3a1",
	"#7a8fd6",
	"#d4735e",
	"#b9895a",
	"#8a8f98",
	"#c4a3d4",
];

/** HTML/SVG 文本转义 —— 防标记注入 */
export function esc(v: unknown): string {
	return String(v ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const fmt = (n: number, digits = 0): string =>
	n.toLocaleString("zh-CN", { maximumFractionDigits: digits });

/** 仅接受 http(s) 的 URL；其余返回空串（防 javascript:/data: 注入） */
export function safeUrl(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) return "";
	try {
		const u = new URL(raw.trim());
		return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
	} catch {
		return "";
	}
}

/** id 安全化：只留字母数字下划线连字符（SVG url(#...) 引用必须合法） */
function idSafe(v: unknown): string {
	return String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 日期 → 天序号（解析失败返回 null） */
function dayIndex(s: unknown): number | null {
	const t = Date.parse(String(s ?? ""));
	return Number.isNaN(t) ? null : Math.floor(t / 86400000);
}

/** 最大/最小（reduce，避免 spread 大数组触发 RangeError） */
function minMax(nums: number[]): [number, number] {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const n of nums) {
		if (n < lo) lo = n;
		if (n > hi) hi = n;
	}
	return [lo, hi];
}

/** 简易确定性哈希（base36）——用于保证 id 唯一 */
function hash36(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (h * 33 + s.charCodeAt(i)) >>> 0;
	}
	return h.toString(36);
}

/** 从任意行数组里安全取数值（非对象行不崩；非有限值归 0） */
function rowValue(d: unknown): number {
	if (!d || typeof d !== "object") return 0;
	const n = Number((d as { value?: unknown }).value);
	return Number.isFinite(n) ? n : 0;
}

/** 折线 / 面积图。x 若能解析为日期，按真实时间间隔布点（避免周末被压平）。 */
export function lineChart(
	points: Point[],
	xKey: string,
	yKey: string,
	opts: LineOpts = {},
): string {
	const {
		width = 800,
		height = 200,
		stroke = PALETTE[0],
		showAxis = true,
		showArea = true,
	} = opts;

	// 失败时返回空串：模板用 `!chartHtml` 回退到提示文案，不要把 <p> 塞进图表容器
	if (!Array.isArray(points) || points.length < 2) {
		return "";
	}

	// 逐点安全取值：非对象行不崩；键名写错/缺失时为 NaN（而不是静默当成 0）
	const rawValues = points.map((p) =>
		p && typeof p === "object" ? Number((p as Point)[yKey]) : Number.NaN,
	);
	const finiteValues = rawValues.filter((v) => Number.isFinite(v));
	// 全部取值无效 = y 键配错或数据损坏 → 不画假平线，明确提示
	if (finiteValues.length === 0) {
		return "";
	}
	// 有效点过少（< 总点数一半）= 数据质量有问题
	if (finiteValues.length * 2 < points.length) {
		return "";
	}
	// 不用 0 冒充无效点：直接剔除，并在断点处分段（避免画出假的坠谷）
	const validFlags = rawValues.map((v) => Number.isFinite(v));

	const padL = showAxis ? 44 : 4;
	const padR = 8;
	const padT = 10;
	const padB = showAxis ? 24 : 4;
	const w = width - padL - padR;
	const h = height - padT - padB;

	let [min, max] = minMax(finiteValues);
	// 平坦序列（min===max）时上下各留白，否则线会贴底
	if (min === max) {
		min -= 0.5;
		max += 0.5;
	}
	const span = max - min || 1;

	// x 定位：优先按日期真实间隔，退化到等距
	const days = points.map((p) =>
		p && typeof p === "object" ? dayIndex(p[xKey]) : null,
	);
	const chronological = days.every((d) => d !== null);
	const dayNums = days.filter((d): d is number => d !== null);
	const [xMin, xMax] = chronological ? minMax(dayNums) : [0, points.length - 1];
	const xSpan = chronological ? xMax - xMin || 1 : points.length - 1 || 1;

	const px = (i: number): number => {
		const rel = chronological
			? ((days[i] as number) - xMin) / xSpan
			: i / xSpan;
		return padL + rel * w;
	};
	const py = (v: number): number => padT + h - ((v - min) / span) * h;

	// 按连续有效段切分：无效点处断开，而不是连到 0
	const segments: Array<Array<{ x: number; y: number }>> = [];
	let cur: Array<{ x: number; y: number }> = [];
	for (let i = 0; i < points.length; i++) {
		if (validFlags[i]) {
			cur.push({ x: px(i), y: py(rawValues[i]) });
		} else if (cur.length) {
			segments.push(cur);
			cur = [];
		}
	}
	if (cur.length) segments.push(cur);

	const linePaths = segments
		.map((seg) =>
			seg
				.map(
					({ x, y }, i) =>
						`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
				)
				.join(" "),
		)
		.join(" ");

	const baseY = padT + h;
	const areaPaths = segments
		.map((seg) => {
			if (seg.length < 2) return "";
			const body = seg
				.map(
					({ x, y }, i) =>
						`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
				)
				.join(" ");
			return `${body} L${seg[seg.length - 1].x.toFixed(1)},${baseY.toFixed(1)} L${seg[0].x.toFixed(1)},${baseY.toFixed(1)} Z`;
		})
		.join(" ");

	const ticks = [0, 0.5, 1]
		.map((t) => {
			const v = min + span * t;
			const y = py(v);
			return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}"
			stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="2 4"/>
			<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end"
			class="loom-chart-label">${esc(fmt(v))}</text>`;
		})
		.join("");

	// 非对象行不能直接下标（外部数据），与取值路径一致做守卫
	const firstPt = points[0];
	const lastPt = points[points.length - 1];
	const first =
		firstPt && typeof firstPt === "object" ? firstPt[xKey] : undefined;
	const last = lastPt && typeof lastPt === "object" ? lastPt[xKey] : undefined;
	const xLabels = showAxis
		? `<text x="${padL}" y="${height - 6}" class="loom-chart-label">${esc(first)}</text>
		   <text x="${width - padR}" y="${height - 6}" text-anchor="end" class="loom-chart-label">${esc(last)}</text>`
		: "";

	// 唯一 id：调用方后缀 + 内容哈希，避免 idSafe 折叠后冲突（a-b 与 a_b）
	const rawSuffix = opts.idSuffix ?? `${xKey}-${yKey}`;
	const gid = `lg-${idSafe(rawSuffix)}-${hash36(String(rawSuffix))}`;

	return `<svg viewBox="0 0 ${width} ${height}" class="loom-chart">
		<defs>
			<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color="${esc(stroke)}" stop-opacity="0.28"/>
				<stop offset="100%" stop-color="${esc(stroke)}" stop-opacity="0"/>
			</linearGradient>
		</defs>
		${ticks}
		${showArea ? `<path d="${areaPaths}" fill="url(#${gid})"/>` : ""}
		<path d="${linePaths}" fill="none" stroke="${esc(stroke)}" stroke-width="1.8"
			stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
		${xLabels}
	</svg>`;
}

/** 环形图（占比） */
export function donutChart(
	data: { name: string; value: number }[],
	opts: { size?: number } = {},
): string {
	const { size = 180 } = opts;
	const list = Array.isArray(data) ? data : [];
	const total = list.reduce((s, d) => s + rowValue(d), 0) || 1;
	const r = size / 2 - 14;
	const cx = size / 2;
	const cy = size / 2;
	const circ = 2 * Math.PI * r;

	let offset = 0;
	const arcs = list
		.map((d, i) => {
			// 负值/非有限值一律归 0，避免 stroke-dasharray 出现负长度（渲染成断弧）
			const frac = Math.min(Math.max(rowValue(d) / total, 0), 1);
			const dash = Math.min(Math.max(frac * circ, 0), circ);
			const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
			stroke="${PALETTE[i % PALETTE.length]}" stroke-width="18"
			stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
			stroke-dashoffset="${(-offset).toFixed(2)}"
			transform="rotate(-90 ${cx} ${cy})" opacity="0.92"/>`;
			offset += dash;
			return seg;
		})
		.join("");

	return `<svg viewBox="0 0 ${size} ${size}" class="loom-donut">${arcs}</svg>`;
}

/** 横向条形（排行） */
export function barChart(data: { name: string; value: number }[]): string {
	const list = Array.isArray(data) ? data : [];
	// 用绝对值取最大，兼容全负值排行（否则全部归 0、图表静默消失）
	const [, hi] = minMax(list.map((d) => Math.abs(rowValue(d))));
	const max = Math.max(Number.isFinite(hi) ? hi : 0, 1);
	return `<div class="loom-bars">${list
		.map((d) => {
			const v = rowValue(d);
			// 负值限定为 0：避免 width:-12% 这种非法 CSS 导致条形静默消失
			const pct = Math.max((v / max) * 100, 0);
			return `<div class="loom-bar-row">
			<span class="loom-bar-name">${esc((d as { name?: unknown })?.name)}</span>
			<span class="loom-bar-track"><span class="loom-bar-fill"
				style="width:${pct.toFixed(1)}%;background:${PALETTE[0]}"></span></span>
			<span class="loom-bar-val">${esc(fmt(v))}</span>
		</div>`;
		})
		.join("")}</div>`;
}

export { fmt };
