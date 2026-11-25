/**
 * 把 functions/_worker.js 复制到 dist/_worker.js。
 *
 * 为什么需要：
 *   Pages 的 Functions 目录约定（项目根 functions/）只在 wrangler 直接部署时生效。
 *   本项目通过 GitHub Actions 跑 `wrangler pages deploy dist`，只上传 dist 目录，
 *   根目录的 functions/ 不会被带上。
 *   → 所以在构建末尾把 _worker.js 放进 dist，让它随静态产物一起部署。
 *
 * 用 _worker.js 而非 functions/ 子目录：单文件高级模式，无需 _routes.json。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "functions", "_worker.js");
const destDir = join(root, "dist");
const dest = join(destDir, "_worker.js");

if (!existsSync(src)) {
	console.error(`[copy-worker] 缺少源文件: ${src}`);
	process.exit(1);
}
if (!existsSync(destDir)) {
	console.error(`[copy-worker] dist 不存在，先跑 astro build`);
	process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const size = statSync(dest).size;
console.log(`[copy-worker] ✅ dist/_worker.js (${size} bytes)`);
