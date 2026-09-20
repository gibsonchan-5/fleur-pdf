// 一次性迁移脚本：把 ink 编辑器样式并入 styles.css（Obsidian 审核要求禁 <style> 注入）。
// 1. 解析 src/mobile/ink-css.flat.ts 的 INK_EDITOR_CSS_FLAT（JSON 双引号字符串）
// 2. 内联图标：url(images/x.svg) -> url("data:…")（复用 ink-icons.ts 的映射表）
// 3. 以标记块形式替换 styles.css 尾部的生成区
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'src/mobile/ink-css.flat.ts';
const ICONS = 'src/mobile/ink-icons.ts';
const CSS = 'styles.css';
const BEGIN = '/* ===== Fleur ink editor styles（生成区，勿手改；源：src/mobile/ink-css.ts） ===== */';
const END = '/* ===== end Fleur ink editor styles ===== */';

const flat = readFileSync(SRC, 'utf8');
const a = flat.indexOf('"');
const b = flat.lastIndexOf('"');
const css = JSON.parse(flat.slice(a, b + 1));

const iconsSrc = readFileSync(ICONS, 'utf8');
const map = new Map();
for (const m of iconsSrc.matchAll(/"([A-Za-z0-9_.-]+\.svg)":\s*\n?\s*"([^"]+)"/g)) {
  map.set(m[1], m[2]);
}
let miss = 0;
const final = css.replace(/url\(\s*images\/([A-Za-z0-9_.-]+)\s*\)/g, (whole, name) => {
  const uri = map.get(name);
  if (!uri) { miss++; return whole; }
  return `url("${uri}")`;
});
if (miss) { console.error('MISSING ICONS:', miss); process.exit(1); }

let styles = readFileSync(CSS, 'utf8');
const beginIdx = styles.indexOf(BEGIN);
const endIdx = styles.indexOf(END);
const block = `${BEGIN}\n${final}\n${END}`;
if (beginIdx !== -1 && endIdx !== -1) {
  styles = styles.slice(0, beginIdx) + block + styles.slice(endIdx + END.length);
} else {
  if (!styles.endsWith('\n')) styles += '\n';
  styles += '\n' + block + '\n';
}
writeFileSync(CSS, styles);
console.log('OK icons:', map.size, 'css bytes:', final.length, 'styles.css bytes:', styles.length);
