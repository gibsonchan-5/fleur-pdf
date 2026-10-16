// 直尺几何纯函数的无头测试（node:assert，不依赖 DOM）。
// 跑法：node scripts/test-ink-ruler.mjs
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const repo = new URL('..', import.meta.url).pathname;
const outDir = mkdtempSync(join(tmpdir(), 'fleur-ruler-test-'));
const outFile = join(outDir, 'ruler.mjs');
await build({
	entryPoints: [join(repo, 'src/mobile/ink/ruler.ts')],
	outfile: outFile,
	bundle: true,
	format: 'esm',
	platform: 'neutral',
});
const R = await import(pathToFileURL(outFile).href);

// ── 1. 水平尺（angle=0）：尺沿是 y = cy − width/2 的水平线 ──
{
	const r = R.defaultRulerState(800, 1000);
	assert.equal(r.angle, 0);
	assert.equal(r.length, R.RULER_DEFAULT_LENGTH);
	const line = R.rulerEdgeLine(r);
	assert.ok(Math.abs(line.dx - 1) < 1e-12 && Math.abs(line.dy) < 1e-12, '方向沿 x 轴');
	assert.ok(Math.abs(line.ey - (r.y - r.width / 2)) < 1e-9, `尺沿在上缘：${line.ey} vs ${r.y - r.width / 2}`);
	// 沿线上的点距离为 0
	assert.ok(R.distanceToEdge(line, r.x + 100, line.ey) < 1e-9);
	// 投影保持沿线坐标、归到沿上
	const q = R.projectToEdge(line, r.x + 100, line.ey - 10);
	assert.ok(Math.abs(q.x - (r.x + 100)) < 1e-9 && Math.abs(q.y - line.ey) < 1e-9);
}

// ── 2. 感应带：24px 内贴尺、外不贴，边界值含 ──
{
	const r = R.defaultRulerState(800, 1000);
	const line = R.rulerEdgeLine(r);
	assert.equal(R.nearEdge(line, 400, line.ey - R.RULER_SNAP_BAND_PX), true, '带内（上方）');
	assert.equal(R.nearEdge(line, 400, line.ey + R.RULER_SNAP_BAND_PX), true, '带内（下方，无符号距离）');
	assert.equal(R.nearEdge(line, 400, line.ey - R.RULER_SNAP_BAND_PX - 0.01), false, '带外');
}

// ── 3. 旋转 90°：尺沿变成竖直线，方向沿 y 轴 ──
{
	const r = R.defaultRulerState(800, 1000);
	r.angle = Math.PI / 2; // d=(0,1)，法线 (dy,-dx)=(1,0) → 尺沿在中心右侧 x + w/2
	const line = R.rulerEdgeLine(r);
	assert.ok(Math.abs(line.dx) < 1e-12 && Math.abs(line.dy - 1) < 1e-12);
	assert.ok(Math.abs(line.ex - (r.x + r.width / 2)) < 1e-9);
	assert.ok(R.distanceToEdge(line, line.ex, r.y + 50) < 1e-9);
	assert.equal(R.nearEdge(line, line.ex + 20, r.y + 50), true);
	const q = R.projectToEdge(line, line.ex + 20, r.y + 50);
	assert.ok(Math.abs(q.y - (r.y + 50)) < 1e-9 && Math.abs(q.x - line.ex) < 1e-9);
}

// ── 4. 任意角度：垂距与投影的勾股一致性（投影点在线上、位移⊥线）──
{
	const r = { x: 100, y: 200, angle: -0.7, length: 300, width: 40 };
	const line = R.rulerEdgeLine(r);
	const p = { x: 320, y: 150 };
	const d = R.distanceToEdge(line, p.x, p.y);
	const q = R.projectToEdge(line, p.x, p.y);
	assert.ok(R.distanceToEdge(line, q.x, q.y) < 1e-9, '垂足在线上');
	const moved = Math.hypot(p.x - q.x, p.y - q.y);
	assert.ok(Math.abs(moved - d) < 1e-9, `位移长度 = 垂距：${moved} vs ${d}`);
	assert.ok(Math.abs((p.x - q.x) * line.dx + (p.y - q.y) * line.dy) < 1e-9, '位移垂直于线');
}

// ── 5. 页面坐标 ↔ 根坐标 互逆 ──
{
	const pageRect = { left: 20, top: 300 };
	const rootRect = { left: 0, top: 60 };
	const css = { x: 55, y: 77 };
	const root = R.pageCssToRoot(css, pageRect, rootRect);
	const back = R.rootToPageCss(root, pageRect, rootRect);
	assert.ok(Math.abs(back.x - css.x) < 1e-9 && Math.abs(back.y - css.y) < 1e-9);
	// 语义：client = css + pageRect；root = client − rootRect
	assert.ok(Math.abs(root.x - (css.x + pageRect.left - rootRect.left)) < 1e-9);
}

// ── 6. defaultRulerState：居中偏上、不小于尺宽 ──
{
	const r = R.defaultRulerState(600, 400);
	assert.ok(Math.abs(r.x - 300) < 1e-9);
	assert.ok(Math.abs(r.y - 120) < 1e-9, '0.3 × 400');
	const tiny = R.defaultRulerState(600, 100);
	assert.ok(tiny.y >= R.RULER_DEFAULT_WIDTH, '极矮视口不把尺顶出屏外');
}

console.log('✔ 直尺几何纯函数测试全部通过');
