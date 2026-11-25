/**
 * loom-analytics 前端埋点
 *
 * 设计目标：**不丢数据**优先于实时性。
 *
 * 三层保障：
 *   1. 发送失败 → 存 localStorage 队列 → 下次页面加载/上线时补发
 *   2. 队列有上限（防 localStorage 撑爆），超限丢最旧并计数
 *   3. 用 event_id（UUID）做幂等 → 重复补发不会产生重复记录
 *
 * 刻意不做的：
 *   - 不做实时（不需要）
 *   - 不追踪滚动深度/鼠标轨迹（隐私 + 数据量）
 *   - 不参与 SPA 路由（本站是静态多页，每次跳转都是新文档）
 *
 * 用法：
 *   <script defer src="/analytics.js" data-site-id="loom"></script>
 */

(() => {
	const script = document.currentScript;
	if (!script) return;

	const ENDPOINT = script.dataset.endpoint || "";
	const SITE_ID = script.dataset.siteId || "loom";

	// 尊重 Do Not Track：用户明确说了别跟踪，就不跟踪
	if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;

	// 本地预览不采集（避免开发时污染统计数据）
	const host = location.hostname;
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host.startsWith("192.168.")
	) {
		return;
	}

	const QUEUE_KEY = "loom_aq"; // analytics queue
	const VISITOR_KEY = "loom_vid"; // visitor id（持久）
	const SESSION_KEY = "loom_sid"; // session id（会话级）
	const MAX_QUEUE = 50; // 队列上限：50 条，约 50KB，安全

	// ── 存储（失败降级为内存，不崩页面）────────────────────
	const store = (() => {
		try {
			const t = "__loom_test__";
			localStorage.setItem(t, "1");
			localStorage.removeItem(t);
			return localStorage;
		} catch {
			// 隐私模式 / 存储被禁 → 用内存 Map 兜底（本次会话有效）
			const mem = new Map();
			return {
				getItem: (k) => (mem.has(k) ? mem.get(k) : null),
				setItem: (k, v) => mem.set(k, v),
				removeItem: (k) => mem.delete(k),
			};
		}
	})();

	// ── 标识 ──────────────────────────────────────────────
	function uuid() {
		if (crypto.randomUUID) return crypto.randomUUID();
		// 老浏览器兜底
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
		});
	}

	function getVisitorId() {
		let v = store.getItem(VISITOR_KEY);
		if (!v) {
			v = uuid();
			store.setItem(VISITOR_KEY, v);
		}
		return v;
	}

	/**
	 * 会话：sessionStorage 优先；30 分钟无活动换新。
	 * 用 sessionStorage 而非 localStorage —— 关掉标签页即结束会话，
	 * 符合「一次访问」的语义。
	 */
	function getSessionId() {
		let raw;
		try {
			raw = sessionStorage.getItem(SESSION_KEY);
		} catch {
			raw = null;
		}
		const now = Date.now();
		const TIMEOUT = 30 * 60 * 1000;

		if (raw) {
			try {
				const s = JSON.parse(raw);
				if (now - s.t < TIMEOUT) {
					s.t = now; // 续期
					sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
					return s.id;
				}
			} catch {
				/* 坏数据 → 重建 */
			}
		}
		const fresh = { id: uuid(), t: now };
		try {
			sessionStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
		} catch {
			/* 忽略 */
		}
		return fresh.id;
	}

	// ── 队列 ──────────────────────────────────────────────
	function readQueue() {
		try {
			const raw = store.getItem(QUEUE_KEY);
			return raw ? JSON.parse(raw) : [];
		} catch {
			return [];
		}
	}

	function writeQueue(q) {
		try {
			store.setItem(QUEUE_KEY, JSON.stringify(q));
		} catch {
			// 写入失败（配额满）→ 砍一半再试，避免彻底存不进去
			try {
				store.setItem(QUEUE_KEY, JSON.stringify(q.slice(-Math.floor(MAX_QUEUE / 2))));
			} catch {
				/* 放弃 */
			}
		}
	}

	function enqueue(ev) {
		const q = readQueue();
		q.push(ev);
		// 超限丢最旧的：宁可丢老数据，也要保住新数据
		while (q.length > MAX_QUEUE) q.shift();
		writeQueue(q);
	}

	// ── 发送 ──────────────────────────────────────────────
	/**
	 * 发送一批事件。
	 * 成功 → 从队列移除
	 * 失败 → 保留在队列（下次再试），不抛异常
	 */
	async function flush() {
		const q = readQueue();
		if (q.length === 0) return;

		// 单次最多 20 条（Worker 侧限制）
		const batch = q.slice(0, 20);

		try {
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ site_id: SITE_ID, events: batch }),
				// keepalive: 页面关闭/跳转时请求仍会发出（关键！）
				keepalive: true,
			});

			if (res.ok || res.status === 204) {
				// 成功 → 从队列里删掉这批（按 event_id 精确删除，
				// 防止并发 flush 时误删新入队的数据）
				const sent = new Set(batch.map((e) => e.event_id));
				const rest = readQueue().filter((e) => !sent.has(e.event_id));
				writeQueue(rest);
			}
			// 4xx（坏数据）不保留 —— 重试也没用，留在队列只会堵住后面的
			else if (res.status >= 400 && res.status < 500) {
				const sent = new Set(batch.map((e) => e.event_id));
				writeQueue(readQueue().filter((e) => !sent.has(e.event_id)));
			}
			// 5xx → 保留，下次重试
		} catch {
			// 网络失败 → 保留在队列，静默等待下次
		}
	}

	// ── 构造事件 ──────────────────────────────────────────
	function baseEvent(type) {
		return {
			event_id: uuid(),
			event_type: type,
			path: location.pathname,
			query: location.search || null,
			title: document.title || null,
			visitor_id: getVisitorId(),
			session_id: getSessionId(),
			screen: `${screen.width}x${screen.height}`,
			language: navigator.language || null,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
			client_ts: Date.now(),
		};
	}

	/**
	 * 来源：只有「从别的站跳来」才算 referrer。
	 * 站内跳转（同一 host）不记 —— 否则内部导航会把真实来源淹掉。
	 */
	function referrer() {
		const r = document.referrer;
		if (!r) return null;
		try {
			const u = new URL(r);
			if (u.hostname === location.hostname) return null;
			return r;
		} catch {
			return null;
		}
	}

	// ── 页面浏览 ──────────────────────────────────────────
	const pageviewId = uuid();
	const pv = {
		...baseEvent("pageview"),
		event_id: pageviewId, // 固定 id，供 leave 事件引用
		referrer: referrer(),
	};
	enqueue(pv);

	// ── 停留时长（离开时发 leave 事件）────────────────────
	let sentLeave = false;

	function sendLeave() {
		if (sentLeave) return;
		sentLeave = true;

		const duration = Math.round(performance.now());
		// 太短的忽略（<1s 多为误触/跳转瞬间）
		if (duration < 1000) return;

		enqueue({
			...baseEvent("leave"),
			// 用「主事件 id + -leave」保证幂等：重复触发不会产生多条
			event_id: `${pageviewId}-leave`,
			event_data: JSON.stringify({ pageview_id: pageviewId, duration_ms: duration }),
		});

		// 页面隐藏时立即尝试发送（keepalive 保证能发出去）
		flush();
	}

	// pagehide 比 beforeunload 更可靠（含移动端切后台）
	window.addEventListener("pagehide", sendLeave);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") sendLeave();
	});

	// ── 启动 ──────────────────────────────────────────────
	// 先补发历史队列（可能是上次断网的遗留）
	flush();

	// 暴露 API 供自定义事件使用：window.loom.track("comment_click", {id: 1})
	window.loom = {
		track(name, data) {
			enqueue({
				...baseEvent("event"),
				event_name: String(name).slice(0, 80),
				event_data: data ? JSON.stringify(data).slice(0, 2000) : null,
			});
			flush();
		},
	};

	// 定时重试（每 30s 一次，仅当队列非空）
	setInterval(() => {
		if (readQueue().length > 0) flush();
	}, 30000);

	// 网络恢复时立即补发
	window.addEventListener("online", flush);
})();