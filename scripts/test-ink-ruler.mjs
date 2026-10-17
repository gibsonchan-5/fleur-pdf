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

// ── 1. 水平尺（angle=0）：工作边是下缘 y = cy + width/2 ──
{
	const r = { x: 400, y: 300, angle: 0, length: 340, width: R.RULER_DEFAULT_WIDTH };
	const line = R.rulerEdgeLine(r);
	assert.ok(Math.abs(line.dx - 1) < 1e-12 && Math.abs(line.dy) < 1e-12, '方向沿 x 轴');
	assert.ok(Math.abs(line.ey - (r.y + r.width / 2)) < 1e-9, `尺沿在下缘：${line.ey} vs ${r.y + r.width / 2}`);
	// 沿线上的点距离为 0
	assert.ok(R.distanceToEdge(line, r.x + 100, line.ey) < 1e-9);
	// 投影保持沿线坐标、归到沿上（尺身内的点也归到下沿）
	const q = R.projectToEdge(line, r.x + 100, line.ey - 10);
	assert.ok(Math.abs(q.x - (r.x + 100)) < 1e-9 && Math.abs(q.y - line.ey) < 1e-9);
}

// ── 2. 感应带：下沿外侧 ≤24 或尺身内（内侧 ≤ 尺宽）都吸附；尺子上方不吸附 ──
// ⚠️ 断言反转记录（Apple Notes 下沿语义）：工作边从上缘改到下缘，
// 「外侧=上方」全部翻为「外侧=下方」，且尺身内（原「压着尺身不吸附」）现改为吸附。
{
	const r = { x: 400, y: 300, angle: 0, length: 340, width: 46 };
	const line = R.rulerEdgeLine(r);
	const inBand = (y) => R.nearEdge(line, 400, y, R.RULER_SNAP_BAND_PX, r.width);
	assert.equal(inBand(line.ey + R.RULER_SNAP_BAND_PX), true, '外侧带内（下方=书写侧）');
	assert.equal(inBand(line.ey), true, '骑下沿（侧距 0）含入');
	assert.equal(inBand(line.ey - 1), true, '尺身内 1px 吸附（划线经过尺子）');
	assert.equal(inBand(line.ey - r.width), true, '尺身上缘（内侧带深 = 尺宽）含入');
	assert.equal(inBand(line.ey - r.width - 1), false, '尺子上方（越过上缘）不吸附');
	assert.equal(inBand(line.ey + R.RULER_SNAP_BAND_PX + 0.01), false, '外侧带外');
}

// ── 2b. edgeSide 符号 + shiftEdgeOutward 外移（任意角度一致性，外法线 n=(−dy, dx)）──
{
	const r = { x: 100, y: 200, angle: -0.7, length: 300, width: 40 };
	const line = R.rulerEdgeLine(r);
	// 外法线 n=(−dy, dx)：沿 n 走 10px 的点侧距 = +10；反向 = −10
	const nx = -line.dy;
	const ny = line.dx;
	assert.ok(Math.abs(R.edgeSide(line, line.ex + nx * 10, line.ey + ny * 10) - 10) < 1e-9, '外侧为正');
	assert.ok(Math.abs(R.edgeSide(line, line.ex - nx * 10, line.ey - ny * 10) + 10) < 1e-9, '内侧为负');
	// 外移 dist 后：原线上点相对新线侧距 = −dist；新线上点 = 0
	const shifted = R.shiftEdgeOutward(line, 5);
	assert.ok(Math.abs(R.edgeSide(shifted, line.ex, line.ey) + 5) < 1e-9, '外移后原线在内侧');
	assert.ok(Math.abs(R.edgeSide(shifted, line.ex + nx * 5, line.ey + ny * 5)) < 1e-9, '新线即外移 5 的线');
	// 方向向量不因平移改变（投影共线一致性保持）
	assert.ok(shifted.dx === line.dx && shifted.dy === line.dy);
}

// ── 3. 旋转 90°：d=(0,1)，外法线 (−dy,dx)=(−1,0) → 工作边在中心左侧 x − w/2，外侧朝左 ──
{
	const r = { x: 400, y: 300, angle: Math.PI / 2, length: 340, width: 46 };
	const line = R.rulerEdgeLine(r);
	assert.ok(Math.abs(line.dx) < 1e-12 && Math.abs(line.dy - 1) < 1e-12);
	assert.ok(Math.abs(line.ex - (r.x - r.width / 2)) < 1e-9, `工作边在左侧：${line.ex}`);
	assert.ok(R.distanceToEdge(line, line.ex, r.y + 50) < 1e-9);
	assert.equal(R.nearEdge(line, line.ex - 20, r.y + 50, R.RULER_SNAP_BAND_PX, r.width), true, '外侧（左）吸附');
	assert.equal(R.nearEdge(line, line.ex + 20, r.y + 50, R.RULER_SNAP_BAND_PX, r.width), true, '尺身内（右）吸附');
	const q = R.projectToEdge(line, line.ex - 20, r.y + 50);
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


// ── 7. resizeRuler：拖一端、锚另一端 ──
{
	const base = { x: 300, y: 150, angle: 0, length: 340, width: 46 };
	// 拖右端 +100：左端 (130,150) 锚定，长 440，中心 (350,150)
	let r = R.resizeRuler(base, 'resize-r', 570, 150);
	assert.ok(Math.abs(r.length - 440) < 1e-9 && Math.abs(r.x - 350) < 1e-9 && Math.abs(r.y - 150) < 1e-9, `右拖：${JSON.stringify(r)}`);
	// 拖左端 −100：右端 (470,150) 锚定，长 440，中心 (250,150)
	r = R.resizeRuler(base, 'resize-l', 30, 150);
	assert.ok(Math.abs(r.length - 440) < 1e-9 && Math.abs(r.x - 250) < 1e-9, `左拖：${JSON.stringify(r)}`);
	// 夹取：上界 900 / 下界 120，锚定端不变
	r = R.resizeRuler(base, 'resize-r', 5000, 150);
	assert.ok(Math.abs(r.length - R.RULER_MAX_LENGTH) < 1e-9 && Math.abs(r.x - (130 + 450)) < 1e-9, '上界夹取');
	r = R.resizeRuler(base, 'resize-r', 200, 150);
	assert.ok(Math.abs(r.length - R.RULER_MIN_LENGTH) < 1e-9 && Math.abs(r.x - (130 + 60)) < 1e-9, '下界夹取');
	// 旋转 90° 后沿 y 轴拖：d=(0,1)，左端 (300,-20) 锚定
	r = R.resizeRuler({ ...base, angle: Math.PI / 2 }, 'resize-r', 300, 420);
	assert.ok(Math.abs(r.length - 440) < 1e-9 && Math.abs(r.x - 300) < 1e-9 && Math.abs(r.y - 200) < 1e-9, `竖尺右拖：${JSON.stringify(r)}`);
	// 指针垂直分量被忽略：横着偏 200px 结果不变
	const off = R.resizeRuler({ ...base, angle: Math.PI / 2 }, 'resize-r', 500, 420);
	assert.ok(Math.abs(off.length - r.length) < 1e-9 && Math.abs(off.x - r.x) < 1e-9 && Math.abs(off.y - r.y) < 1e-9, '垂直分量忽略');
	// 锚定端逐帧不漂移：连拖三步，左端始终 (130,150)
	let cur = base;
	for (const px of [400, 500, 450]) {
		cur = R.resizeRuler(cur, 'resize-r', px, 150);
		const lx = cur.x - Math.cos(cur.angle) * cur.length / 2;
		const ly = cur.y - Math.sin(cur.angle) * cur.length / 2;
		assert.ok(Math.abs(lx - 130) < 1e-9 && Math.abs(ly - 150) < 1e-9, `连拖锚定：${lx},${ly}`);
	}
}

console.log('✔ 直尺几何纯函数测试全部通过');
