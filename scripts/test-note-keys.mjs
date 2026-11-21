// 便签输入时左右方向键归属的回归测试（无头）。
// 跑法：node scripts/test-note-keys.mjs
//
// 背景（Obsidian 1.13.1 app.asar / app.js 实证）：
//   PDF 视图把自己的 ArrowLeft/ArrowRight 注册进 keymap，guarded 函数只排除
//   INPUT 与 contentEditable=true；**TEXTAREA 未覆盖**。keymap 在 window 捕获阶段
//   处理，所以便签 textarea 里的左右键会先被翻页截走，光标不动。
//
// 本测试用与核心同语义的 Scope / Keymap 迷你实现固定这条缺陷，
// 再验证插件侧的 NoteArrowKeyGuard 能把左右键归还给 textarea（且不 preventDefault）。
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = new URL('..', import.meta.url).pathname;
const workDir = mkdtempSync(join(tmpdir(), 'fleur-note-keys-'));
const mockDir = join(workDir, 'mock');
mkdirSync(mockDir, { recursive: true });
const mockObsidian = join(mockDir, 'obsidian.mjs');

// 与 Obsidian Scope 同语义的最小实现（handleKey 走 keys → parent；返回 undefined 继续找，
// 命中具体 key/modifiers 后即停；见 app.js Ng.handleKey）。
writeFileSync(mockObsidian, `
export class Scope {
  constructor(parent) { this.parent = parent; this.keys = []; }
  register(modifiers, key, func) {
    const compiled = modifiers == null ? null : modifiers.slice().sort().join(',');
    const h = { scope: this, modifiers: compiled, key, func };
    this.keys.push(h);
    return h;
  }
  unregister(h) { this.keys = this.keys.filter((x) => x !== h); }
  handleKey(evt, ctx) {
    for (const h of this.keys) {
      if (h.key !== null && h.key !== ctx.key) continue;
      if (h.modifiers !== null && h.modifiers !== ctx.modifiers) continue;
      const r = h.func(evt, ctx);
      if (r !== undefined) return r;
      if (h.key !== null || h.modifiers !== null) return r;
    }
    if (this.parent) return this.parent.handleKey(evt, ctx);
  }
}
`);

const outDir = join(workDir, 'bundle');
await build({
	entryPoints: [join(repo, 'src/notes/note-keys.ts')],
	outdir: outDir,
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	alias: { obsidian: mockObsidian },
	logLevel: 'silent',
});

const { NoteArrowKeyGuard } = await import(pathToFileURL(join(outDir, 'note-keys.js')).href);
const { Scope } = await import(pathToFileURL(mockObsidian).href);

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}\n    ${e.message}`);
		process.exitCode = 1;
	}
}

/* ---------------- 模拟 Obsidian：keymap + PDF 视图 + 输入框 ---------------- */

function makeWorld(targetNode) {
	const rootScope = new Scope();
	const stack = [rootScope];
	const keymap = {
		get scope() { return stack[stack.length - 1]; },
		pushScope(s) { stack.push(s); },
		popScope(s) {
			const i = stack.lastIndexOf(s);
			if (i > 0) stack.splice(i, 1);
		},
	};

	// 证据：app.js 中 KZ 的 ArrowLeft/ArrowRight 注册 + yg() 的判定
	const yg = (n) => !!n && (n.nodeName === 'INPUT' || (n.contentEditable === 'true'));
	const pages = { prev: 0, next: 0 };
	const pdfScope = new Scope(rootScope);
	const arrow = (fn) => (evt) => {
		if (!yg(evt.target)) { evt.preventDefault(); fn(); }
	};
	pdfScope.register([], 'ArrowLeft', arrow(() => pages.prev++));
	pdfScope.register([], 'ArrowRight', arrow(() => pages.next++));
	keymap.pushScope(pdfScope);

	const app = { scope: rootScope, keymap };
	const guard = new NoteArrowKeyGuard(app);

	function press(key) {
		const evt = {
			key,
			modifiers: '',
			target: targetNode,
			defaultPrevented: false,
			preventDefault() { this.defaultPrevented = true; },
			stopPropagation() {},
		};
		keymap.scope.handleKey(evt, { key, modifiers: '', vkey: key });
		return evt;
	}
	return { pages, guard, press, keymap, pdfScope };
}

const TEXTAREA = { nodeName: 'TEXTAREA', contentEditable: 'inherit' };
const INPUT = { nodeName: 'INPUT', contentEditable: 'inherit' };

/* --------------------------------- 用例 --------------------------------- */

test('前提：未接管时，textarea 的 ArrowLeft 会被翻页截走（核心 yg 漏 TEXTAREA）', () => {
	const w = makeWorld(TEXTAREA);
	const evt = w.press('ArrowLeft');
	assert.equal(w.pages.prev, 1);
	assert.equal(evt.defaultPrevented, true);
});

test('接管后：左右键不再翻页，也不 preventDefault（原生光标移动得以执行）', () => {
	const w = makeWorld(TEXTAREA);
	w.guard.acquire();
	const left = w.press('ArrowLeft');
	const right = w.press('ArrowRight');
	assert.equal(w.pages.prev, 0);
	assert.equal(w.pages.next, 0);
	assert.equal(left.defaultPrevented, false);
	assert.equal(right.defaultPrevented, false);
});

test('接管后：其它键（ArrowUp/ArrowDown/字符）照常放行，不 preventDefault', () => {
	const w = makeWorld(TEXTAREA);
	w.guard.acquire();
	for (const key of ['ArrowUp', 'ArrowDown', 'a', 'Enter', 'Backspace']) {
		assert.equal(w.press(key).defaultPrevented, false, key);
	}
});

test('release 后恢复翻页', () => {
	const w = makeWorld(TEXTAREA);
	w.guard.acquire();
	w.press('ArrowRight');
	assert.equal(w.pages.next, 0);
	w.guard.release();
	w.press('ArrowRight');
	assert.equal(w.pages.next, 1);
});

test('acquire 幂等：重复调用只压入一层，单次 release 即完全归还', () => {
	const w = makeWorld(TEXTAREA);
	w.guard.acquire();
	w.guard.acquire();
	w.guard.release();
	w.press('ArrowLeft');
	assert.equal(w.pages.prev, 1);
});

test('release 幂等：未持有时调用无副作用', () => {
	const w = makeWorld(TEXTAREA);
	w.guard.release();
	w.press('ArrowLeft');
	assert.equal(w.pages.prev, 1);
});

test('对照：焦点在 INPUT 时核心本来就不翻页（说明缺口仅在 TEXTAREA）', () => {
	const w = makeWorld(INPUT);
	const evt = w.press('ArrowRight');
	assert.equal(w.pages.next, 0);
	assert.equal(evt.defaultPrevented, false);
});

test('聚焦状态可从 active 读出（供 blur/卸载清理判断）', () => {
	const w = makeWorld(TEXTAREA);
	assert.equal(w.guard.active, false);
	w.guard.acquire();
	assert.equal(w.guard.active, true);
	w.guard.release();
	assert.equal(w.guard.active, false);
});

console.log(`\n${passed} 个断言组通过${process.exitCode ? '（存在失败）' : ''}`);
if (process.exitCode) process.exit(1);