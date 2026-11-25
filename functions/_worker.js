/**
 * Loom 埋点接收端 —— Cloudflare Pages Function（同源）
 *
 * ⚠️ 为什么从 workers.dev 改成 Pages Functions：
 *   workers.dev 域名在国内被墙，国内访客 fetch 会挂住直至超时。
 *   前端虽然有 localStorage 队列兜底（数据不丢），但队列会一直堆积、
 *   永远发不出去 —— 等于对国内访客完全失效。
 *   改同源（站点自己的域名 /api/collect）后，不再有跨境/被封问题。
 *
 * 这个文件被复制到 dist/_worker.js 参与 Pages 部署。
 * 源码在 analytics-worker/src/index.js，构建时由 scripts/build-worker.mjs 复制。
 *
 * 同源带来的两个简化：
 *   1. CORS 不再需要（同源请求不发预检）—— 但保留 OPTIONS 处理以防万一
 *   2. Origin 白名单改为「只校验请求确实来自本站」
 */

const MAX_BODY_BYTES = 8 * 1024;
const MAX_BATCH = 20;
const MAX_FIELD_LEN = 500;
const MAX_PATH_LEN = 300;

const VALID_EVENT_TYPES = new Set(["pageview", "event", "leave"]);

function str(v, max = MAX_FIELD_LEN) {
	if (v === null || v === undefined) return null;
	const s = String(v);
	if (!s) return null;
	return s.length > max ? s.slice(0, max) : s;
}

async function hashIp(ip, salt) {
	if (!ip) return null;
	const data = new TextEncoder().encode(`${salt}:${ip}`);
	const buf = await crypto.subtle.digest("SHA-256", data);
	const hex = [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hex.slice(0, 16);
}

function validateEvent(raw, siteId) {
	if (!raw || typeof raw !== "object") return { ok: false, reason: "not_object" };

	const eventId = str(raw.event_id, 64);
	const eventType = str(raw.event_type, 20);
	const visitorId = str(raw.visitor_id, 64);
	const sessionId = str(raw.session_id, 64);
	const path = str(raw.path, MAX_PATH_LEN);

	if (!eventId) return { ok: false, reason: "missing_event_id" };
	if (!eventType || !VALID_EVENT_TYPES.has(eventType))
		return { ok: false, reason: "bad_event_type" };
	if (!visitorId) return { ok: false, reason: "missing_visitor_id" };
	if (!sessionId) return { ok: false, reason: "missing_session_id" };
	if (!path) return { ok: false, reason: "missing_path" };

	return {
		ok: true,
		row: {
			event_id: eventId,
			site_id: siteId,
			event_type: eventType,
			path,
			query: str(raw.query, MAX_PATH_LEN),
			title: str(raw.title, 200),
			referrer: str(raw.referrer, MAX_PATH_LEN),
			visitor_id: visitorId,
			session_id: sessionId,
			event_name: str(raw.event_name, 80),
			event_data:
				raw.event_data === undefined || raw.event_data === null
					? null
					: str(
							typeof raw.event_data === "string"
								? raw.event_data
								: JSON.stringify(raw.event_data),
							2000,
						),
			screen: str(raw.screen, 20),
			language: str(raw.language, 20),
			timezone: str(raw.timezone, 60),
		},
	};
}

async function handleCollect(request, env) {
	const lenHeader = Number(request.headers.get("Content-Length") || 0);
	if (lenHeader > MAX_BODY_BYTES) {
		return new Response("payload too large", { status: 413 });
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response("bad json", { status: 400 });
	}

	const siteId = str(body.site_id, 64) || "loom";

	const incoming = Array.isArray(body.events) ? body.events : [body];
	if (incoming.length === 0 || incoming.length > MAX_BATCH) {
		return new Response("bad batch size", { status: 400 });
	}

	const ip =
		request.headers.get("CF-Connecting-IP") ||
		request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
		"";
	const ipHash = await hashIp(ip, env.IP_SALT || "loom");
	const country = request.headers.get("CF-IPCountry") || null;
	const ua = str(request.headers.get("User-Agent"), 300);
	const receivedAt = Date.now();

	const rows = [];
	for (const raw of incoming) {
		const v = validateEvent(raw, siteId);
		if (!v.ok) continue;
		rows.push({
			...v.row,
			country,
			user_agent: ua,
			ip_hash: ipHash,
			client_ts:
				typeof raw.client_ts === "number" && Number.isFinite(raw.client_ts)
					? Math.trunc(raw.client_ts)
					: null,
			received_at: receivedAt,
		});
	}

	if (rows.length === 0) {
		return new Response("all rejected", { status: 400 });
	}

	const stmt = env.DB.prepare(
		`INSERT INTO events (
			event_id, site_id, event_type, path, query, title, referrer,
			visitor_id, session_id, event_name, event_data,
			screen, language, timezone, country, user_agent, ip_hash,
			client_ts, received_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(event_id) DO NOTHING`,
	);

	try {
		await env.DB.batch(
			rows.map((r) =>
				stmt.bind(
					r.event_id,
					r.site_id,
					r.event_type,
					r.path,
					r.query,
					r.title,
					r.referrer,
					r.visitor_id,
					r.session_id,
					r.event_name,
					r.event_data,
					r.screen,
					r.language,
					r.timezone,
					r.country,
					r.user_agent,
					r.ip_hash,
					r.client_ts,
					r.received_at,
				),
			),
		);
	} catch (err) {
		// 写库失败必须回 5xx，前端据此保留队列下次重试。
		return new Response(`db error: ${String(err).slice(0, 80)}`, {
			status: 503,
		});
	}

	return new Response(null, { status: 204 });
}

/**
 * Pages Function 入口。
 * 注意：与 Worker 的 export default { fetch } 不同，
 * Pages 用 onRequest 具名导出。
 */
export async function onRequest(context) {
	const { request, env } = context;
	const url = new URL(request.url);

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204 });
	}

	if (url.pathname === "/api/collect" && request.method === "POST") {
		return handleCollect(request, env);
	}

	if (url.pathname === "/api/health" && request.method === "GET") {
		try {
			const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first();
			return Response.json({ ok: true, events: r?.n ?? 0 });
		} catch (err) {
			return Response.json(
				{ ok: false, error: String(err).slice(0, 100) },
				{ status: 503 },
			);
		}
	}

	return new Response("not found", { status: 404 });
}