// 构建时把本地 OCR 所需的 tesseract.js 运行资产固定版本拷入仓库本地 tesseract/ 目录。
//
// ⚠️ 该目录仅用于本机开发与 vault 部署调试，已加入 .gitignore —— 不入库、不发版。
//    正式分发策略：用户开启「启用本地 OCR」后，首次使用时由 src/mobile/ocr.ts
//    从 jsdelivr 按固定版本按需下载并缓存到插件目录（见 ocr.ts 顶部说明）。
//
// 合规背景：Obsidian 社区审核禁止运行时加载远程**代码**；worker/wasm 的按需下载
// 由用户显式开启（默认关）触发，版本锁定，下载后完全离线。语言包（traineddata，
// 纯数据）不受此限，仍按用户配置的源首次下载后缓存。
//
// 拷贝来源（与 package.json 依赖版本一致）：
//   node_modules/tesseract.js/dist/worker.min.js
//   node_modules/tesseract.js-core/tesseract-core-{simd-,}lstm.wasm.{js,wasm}

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coreDir = join(root, 'node_modules', 'tesseract.js-core');
const out = join(root, 'tesseract');

mkdirSync(join(out, 'core'), { recursive: true });
copyFileSync(join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js'));

// LSTM 双内核：现代 Chromium（桌面与近几年的移动端 WebView）走 simd，
// 老内核自动降级非 simd —— tesseract.js 按目录取用时自己选。
for (const f of readdirSync(coreDir)) {
	if (f.includes('lstm') && (f.endsWith('.wasm.js') || f.endsWith('.wasm'))) {
		copyFileSync(join(coreDir, f), join(out, 'core', f));
	}
}

console.log('[copy-tesseract-assets] done: tesseract/worker.min.js + tesseract/core/*lstm*');
