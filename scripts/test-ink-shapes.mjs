// 形状工具的数据模型无头测试（node:assert，不依赖 DOM）。
// 跑法：node scripts/test-ink-shapes.mjs
//
// 覆盖：InkStroke 的 shape/fill 字段、sanitizeStrokes 白名单（新字段不显式带上
// 会被静默抹掉 —— gaps 当年的坑）、形状轮廓命中距离、圈选采样点、序列化一跳幂等。
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const repo = new URL('..', import.meta.url).pathname;
const outDir = mkdtempSync(join(tmpdir(), 'fleur-shape-test-'));

// ink-store 运行时 import 了 obsidian 的 normalizePath —— 打个最小 mock
writeFileSync(join(outDir, 'obsidian-mock.mjs'), 'export function normalizePath(p) { return p; }\n');
await build({
	entryPoints: [join(repo, 'src/mobile/ink-store.ts')],
	outfile: join(outDir, 'store.mjs'),
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	alias: { obsidian: join(outDir, 'obsidian-mock.mjs') },
});
const { sanitizeStrokes } = await import(pathToFileURL(join(outDir, 'store.mjs')).href);

await build({
	entryPoints: [join(repo, 'src/mobile/ink/strokes.ts')],
	outfile: join(outDir, 'strokes.mjs'),
	bundle: true,
	format: 'esm',
	platform: 'neutral',
});
const S = await import(pathToFileURL(join(outDir, 'strokes.mjs')).href);

/* ── 1. sanitize 白名单：shape / fill 必须能穿过落盘读盘 ── */
{
	const stroke = {
		id: 'fleur-ink-s1', page: 1, color: '#1f1f1f', width: 3, opacity: 1, kind: 'pen',
		shape: 'rect', fill: '#ffe94a',
		pts: [10, 20, 0.5, 110, 120, 0.5], t: 1700000000000,
	};
	const [out] = sanitizeStrokes([JSON.parse(JSON.stringify(stroke))]);
	assert.equal(out.shape, 'rect', 'shape 穿过 sanitize');
	assert.equal(out.fill, '#ffe94a', 'fill 穿过 sanitize');

	// 无填充 = null，也要保真（不能变成 undefined 再被丢）
	const [none] = sanitizeStrokes([{ ...stroke, fill: null }]);
	assert.equal(none.fill, null, 'fill=null 保真');
	assert.equal(none.shape, 'rect');

	// 非法 shape 值 → 丢弃 shape（按普通笔迹降级），笔迹本体保留
	const [bad] = sanitizeStrokes([{ ...stroke, shape: 'triangle' }]);
	assert.equal(bad.shape, undefined, '非法 shape 丢弃');
	assert.equal(bad.pts.length, 6, '本体保留');

	// 非法 fill（非 #hex 字符串）→ 当无填充
	const [badFill] = sanitizeStrokes([{ ...stroke, fill: 'javascript:alert(1)' }]);
	assert.equal(badFill.fill, null, '非法 fill 归为无填充');
}

/* ── 2. shape 笔迹点数必须是 2 点（6 个数）── */
{
	const good = {
		id: 's', page: 1, color: '#000', width: 3, opacity: 1, kind: 'pen',
		shape: 'ellipse', pts: [0, 0, 0.5, 50, 50, 0.5],
	};
	assert.equal(sanitizeStrokes([{ ...good }])[0].shape, 'ellipse');
	// 1 点（3 个数）连普通笔迹的底线（≥2 点）都不够 → 整条拒收（既有行为）
	assert.equal(sanitizeStrokes([{ ...good, pts: [1, 2, 0.5] }]).length, 0);
	// 3 点的 shape → 降级为普通笔迹（shape 丢弃、笔迹本体保留）
	assert.equal(
		sanitizeStrokes([{ ...good, pts: [1, 2, 0.5, 3, 4, 0.5, 5, 6, 0.5] }])[0].shape,
		undefined,
		'3 点 shape 降级为普通笔迹',
	);
}

/* ── 3. 普通笔迹完全不受影响（回归保障）── */
{
	const plain = {
		id: 'p', page: 2, color: '#123456', width: 2.5, opacity: 1, kind: 'pen',
		pts: [0, 0, 0.5, 10, 0, 0.7, 20, 5, 0.9], gaps: [2], t: 1700000000001,
	};
	const [out] = sanitizeStrokes([JSON.parse(JSON.stringify(plain))]);
	assert.equal(out.shape, undefined);
	assert.equal(out.fill, undefined);
	assert.deepEqual(out.gaps, [2]);
}

/* ── 4. 序列化一跳幂等：sanitize → JSON → parse → sanitize 逐字节一致 ── */
{
	const strokes = [
		{ id: 'a', page: 1, color: '#1f1f1f', width: 3, opacity: 1, kind: 'pen', shape: 'rect', fill: '#ffe94a', pts: [1, 2, 0.5, 3, 4, 0.5] },
		{ id: 'b', page: 1, color: '#1f1f1f', width: 3, opacity: 1, kind: 'pen', shape: 'line', fill: null, pts: [0, 0, 0.5, 99, 88, 0.5] },
		{ id: 'c', page: 1, color: '#f2c200', width: 14, opacity: 0.45, kind: 'marker', pts: [5, 5, 0.5, 6, 6, 0.6, 7, 7, 0.7] },
	];
	const once = JSON.stringify(sanitizeStrokes(strokes));
	const twice = JSON.stringify(sanitizeStrokes(JSON.parse(once)));
	assert.equal(twice, once, 'sanitize 幂等');
}

/* ── 5. shapeOutlineDistance：轮廓命中距离（PDF 空间）── */
{
	const rect = { id: 'r', page: 1, color: '#000', width: 3, opacity: 1, kind: 'pen', shape: 'rect', fill: '#ffe94a', pts: [10, 10, 0.5, 110, 60, 0.5] };
	// 边上 = 0
	assert.ok(Math.abs(S.shapeOutlineDistance(rect, 60, 10)) < 1e-9, '矩形上边命中');
	assert.ok(Math.abs(S.shapeOutlineDistance(rect, 10, 35)) < 1e-9, '矩形左边命中');
	// 外部：到最近边的距离
	assert.ok(Math.abs(S.shapeOutlineDistance(rect, 60, 5) - 5) < 1e-9, '矩形外 5px');
	assert.ok(Math.abs(S.shapeOutlineDistance(rect, 130, 35) - 20) < 1e-9, '矩形右外 20px');
	// 内部：到最近边（深度）
	assert.ok(Math.abs(S.shapeOutlineDistance(rect, 60, 12) - 2) < 1e-9, '矩形内深 2px');
	// 中心：min(hw, hh) = 25
	assert.ok(Math.abs(S.shapeOutlineDistance(rect, 60, 35) - 25) < 1e-6, '矩形中心深度');

	const line = { id: 'l', page: 1, color: '#000', width: 2, opacity: 1, kind: 'pen', shape: 'line', fill: null, pts: [0, 0, 0.5, 100, 0, 0.5] };
	assert.ok(Math.abs(S.shapeOutlineDistance(line, 50, 7) - 7) < 1e-9, '直线中段垂距 7');
	assert.ok(Math.abs(S.shapeOutlineDistance(line, 120, 0) - 20) < 1e-9, '直线端点外 20');

	const ell = { id: 'e', page: 1, color: '#000', width: 2, opacity: 1, kind: 'pen', shape: 'ellipse', fill: '#7ee787', pts: [0, 0, 0.5, 100, 50, 0.5] };
	// 边界点（右顶点 / 上顶点）≈ 0
	assert.ok(Math.abs(S.shapeOutlineDistance(ell, 100, 25)) < 1.5, '椭圆右顶点命中');
	assert.ok(Math.abs(S.shapeOutlineDistance(ell, 50, 0)) < 1.5, '椭圆上顶点命中');
	// 中心深度 = min(rx, ry) = 25
	assert.ok(Math.abs(S.shapeOutlineDistance(ell, 50, 25) - 25) < 1e-6, '椭圆中心深度');
	// 远外点距离明显大
	assert.ok(S.shapeOutlineDistance(ell, 200, 200) > 50, '椭圆远外点');

	// 非形状笔迹 / 点数不对 → Infinity（永不算命中）
	const plain = { id: 'p', page: 1, color: '#000', width: 3, opacity: 1, kind: 'pen', pts: [0, 0, 0.5, 10, 10, 0.5] };
	assert.equal(S.shapeOutlineDistance(plain, 5, 5), Infinity, '普通笔迹不进形状命中');
}

/* ── 6. shapeHitPoints：圈选采样（轮廓点 + 中心），大形状不能靠顶点漏选 ── */
{
	const rect = { id: 'r', page: 1, color: '#000', width: 3, opacity: 1, kind: 'pen', shape: 'rect', fill: null, pts: [0, 0, 0.5, 100, 100, 0.5] };
	const pts = S.shapeHitPoints(rect);
	// 必须含 4 角；边中点也要有（框只套一条边也能选中）
	const has = (x, y) => pts.some((px, i) => i % 2 === 0 && px === x && pts[i + 1] === y);
	assert.ok(has(0, 0) && has(100, 100), '矩形角在采样里');
	assert.ok(has(50, 0) && has(50, 100) && has(0, 50) && has(100, 50), '矩形边中点在采样里');
	// 中心不是轮廓：不采（与橡皮「深内部不命中」同语义）
	assert.ok(!has(50, 50), '中心不在采样里');

	const line = { id: 'l', page: 1, color: '#000', width: 2, opacity: 1, kind: 'pen', shape: 'line', fill: null, pts: [0, 0, 0.5, 80, 60, 0.5] };
	const lp = S.shapeHitPoints(line);
	assert.ok(lp.length >= 4, '直线至少两端点 + 中点');
	// 线中点在采样里（框只套中段也能选中）
	const mid = lp.some((x, i) => i % 2 === 0 && Math.abs(x - 40) < 1e-9 && Math.abs(lp[i + 1] - 30) < 1e-9);
	assert.ok(mid, '直线中点在采样里');

	assert.deepEqual(S.shapeHitPoints(plain2()), []);
	function plain2() {
		return { id: 'x', page: 1, color: '#000', width: 3, opacity: 1, kind: 'pen', pts: [0, 0, 0.5, 1, 1, 0.5] };
	}
}

/* ── 7. 常量与类型守卫 ── */
assert.equal(S.INK_SHAPE_DEFAULT_FILL, '#ffe94a', '默认荧光黄');
assert.ok(S.INK_SHAPE_FILL_ALPHA > 0.3 && S.INK_SHAPE_FILL_ALPHA < 0.6, '填充半透明档位');
assert.equal(S.isInkShape('rect'), true);
assert.equal(S.isInkShape('ellipse'), true);
assert.equal(S.isInkShape('line'), true);
assert.equal(S.isInkShape('triangle'), false);
assert.equal(S.isInkShape(undefined), false);

console.log('✔ 形状数据模型测试全部通过');
