// 直尺（参考 Apple Notes）：几何纯函数。
//
// 交互（Apple Notes 语义，用户真机多轮截图校准）：
//   · 可拖动 + 可旋转（拖尺身移动、拖右端手柄旋转、拖两端调长短）；
//   · 尺子朝向可选（设置 rulerSide）：默认尺子躺在笔画**下方**（工作边=上缘），
//     也可选尺子在笔画**上方**（工作边=下缘）。划线经过尺子即沿工作边变直。
//   · 投影沿外法线外移「最大半笔宽 + 极小缝」：笔迹随压感最宽到 1.2×width，
//     半宽 0.6×width —— 外移够多才能让整条墨完全落在尺子外、不被半透明尺身透出，
//     同时只留 RULER_STROKE_GAP_PX 的小缝让用户看清贴着尺沿的线。
//
// 坐标系约定：直尺状态存放在 pdf.js viewer 根元素（.pdfViewer）的 CSS 像素
// 坐标系里 —— 尺 DOM 挂在根元素上随内容滚动；页面 surface 的 CSS 坐标与
// 根坐标之间只差两个包围盒原点的平移（无缩放差，同一 CSS px 尺度），
// 感应带阈值因此与用户手感一致、不随缩放变。
//
// 纯函数无 DOM 依赖，可无头测试（scripts/test-ink-ruler.mjs）。

/** 贴尺感应带：工作边外侧宽度（CSS px）。 */
export const RULER_SNAP_BAND_PX = 24;

/** 吸附后笔迹与工作边之间留的小缝（CSS px）—— 4px 才能跟尺沿的 accent 细线拉开，
 * 细钢笔也看得清「线是线、尺是尺」；再大就失去「贴着尺」的语义了。 */
export const RULER_STROKE_GAP_PX = 4;

/** 尺子相对笔画的朝向：'below'=尺在笔画下方（工作边上缘）；'above'=尺在上方（工作边下缘）。 */
export type RulerSide = 'above' | 'below';

/** 笔迹随压感的最大半宽系数：raw = width·(0.4+0.8·p)，p=1 → 1.2·width，半宽 0.6·width。 */
export const RULER_MAX_HALF_WIDTH = 0.6;

/** 直尺状态（viewer 根元素 CSS 坐标系）。x/y 为尺中心。 */
export interface RulerState {
	x: number;
	y: number;
	/** 弧度。0 = 水平，尺长方向沿 (cos, sin)。 */
	angle: number;
	length: number;
	width: number;
}

/**
 * 尺沿（工作边）所在直线：过点 (ex, ey)、单位方向 (dx, dy)、单位外法线 (nx, ny)。
 * 外法线指向「书写侧」（尺子外侧），感应带与投影偏移都沿它计算。
 */
export interface EdgeLine {
	ex: number;
	ey: number;
	dx: number;
	dy: number;
	nx: number;
	ny: number;
}

/** 1 厘米 = 28.3465 PDF pt（72pt/in ÷ 2.54cm/in）。 */
export const PT_PER_CM = 28.3464567;
/** 默认尺长：10 厘米（引擎按当前缩放换算成 CSS px，尺面恰好铺满 0–10 刻度）。 */
export const RULER_DEFAULT_CM = 10;
/** 尺身厚度（CSS px），固定。 */
export const RULER_DEFAULT_WIDTH = 46;

/**
 * 尺沿直线。工作边随 side 取尺身的一侧：
 *   'below'（尺在笔画下方）→ 上缘，外法线 n=(dy,−dx)（angle=0 时朝上）；
 *   'above'（尺在笔画上方）→ 下缘，外法线 n=(−dy,dx)（angle=0 时朝下）。
 * 外法线永远指向书写侧（远离尺身），感应带与投影偏移都沿它算。
 */
export function rulerEdgeLine(r: RulerState, side: RulerSide = 'below'): EdgeLine {
	const dx = Math.cos(r.angle);
	const dy = Math.sin(r.angle);
	const nx = side === 'below' ? dy : -dy;
	const ny = side === 'below' ? -dx : dx;
	return {
		ex: r.x + nx * (r.width / 2),
		ey: r.y + ny * (r.width / 2),
		dx,
		dy,
		nx,
		ny,
	};
}

/** 点到尺沿直线的距离（CSS px，无符号）。 */
export function distanceToEdge(line: EdgeLine, px: number, py: number): number {
	// |(P − E) × d|：叉积的绝对值就是点到直线的垂距（d 是单位向量）。
	return Math.abs((px - line.ex) * line.dy - (py - line.ey) * line.dx);
}

/**
 * 点到尺沿的**有符号**侧距（CSS px）：沿外法线 n 为正（书写侧），负为尺身内。
 * −width ≤ s < 0 即点落在尺身上（划线经过尺子），s < −width 即尺子另一侧（不吸附）。
 */
export function edgeSide(line: EdgeLine, px: number, py: number): number {
	return (px - line.ex) * line.nx + (py - line.ey) * line.ny;
}

/** 把尺沿直线整体沿外法线外移 dist（投影目标线：让整条墨落在尺子外、只留极小缝）。 */
export function shiftEdgeOutward(line: EdgeLine, dist: number): EdgeLine {
	return { ex: line.ex + line.nx * dist, ey: line.ey + line.ny * dist, dx: line.dx, dy: line.dy, nx: line.nx, ny: line.ny };
}

/** 点在尺沿上的垂足投影。 */
export function projectToEdge(line: EdgeLine, px: number, py: number): { x: number; y: number } {
	const t = (px - line.ex) * line.dx + (py - line.ey) * line.dy;
	return { x: line.ex + t * line.dx, y: line.ey + t * line.dy };
}

/**
 * 贴尺判定：外侧 ≤ bandPx，或落在尺身内（内侧 ≤ innerPx —— 划线经过尺子即吸附）。
 * innerPx 由调用方传尺身厚度；默认 0 = 只认外侧。
 */
export function nearEdge(
	line: EdgeLine,
	px: number,
	py: number,
	bandPx = RULER_SNAP_BAND_PX,
	innerPx = 0,
): boolean {
	const s = edgeSide(line, px, py);
	return s >= -innerPx && s <= bandPx;
}

/** 页面 surface CSS 坐标 → viewer 根坐标（无缩放差，纯平移）。 */
export function pageCssToRoot(
	css: { x: number; y: number },
	pageRect: { left: number; top: number },
	rootRect: { left: number; top: number },
): { x: number; y: number } {
	return { x: css.x + pageRect.left - rootRect.left, y: css.y + pageRect.top - rootRect.top };
}

/** viewer 根坐标 → 页面 surface CSS 坐标。pageCssToRoot 的逆。 */
export function rootToPageCss(
	p: { x: number; y: number },
	pageRect: { left: number; top: number },
	rootRect: { left: number; top: number },
): { x: number; y: number } {
	return { x: p.x - pageRect.left + rootRect.left, y: p.y - pageRect.top + rootRect.top };
}

/** 尺长夹取范围（CSS px）：太短没法划线，太长超出常见视口宽。 */
export const RULER_MIN_LENGTH = 120;
export const RULER_MAX_LENGTH = 900;

/** 长短拖拽模式：拖哪一端，另一端锚定不动。 */
export type RulerResizeMode = 'resize-l' | 'resize-r';

/**
 * 调尺长（拖两端、锚定另一端）。px/py 为指针的 viewer 根坐标。
 * 新长 = 指针在尺方向 d 上相对锚定端的投影距离，夹在 [MIN, MAX]；
 * 中心移到「锚定端 + d × 新长/2」，保证锚定端逐帧不漂移。
 * 指针垂直于尺的分量被投影自然忽略（斜着拖也只认沿尺方向的分量）。
 */
export function resizeRuler(r: RulerState, mode: RulerResizeMode, px: number, py: number): RulerState {
	const dx = Math.cos(r.angle);
	const dy = Math.sin(r.angle);
	const half = r.length / 2;
	const lx = r.x - dx * half;
	const ly = r.y - dy * half;
	const rx = r.x + dx * half;
	const ry = r.y + dy * half;
	let len: number;
	let ax: number;
	let ay: number;
	if (mode === 'resize-r') {
		len = (px - lx) * dx + (py - ly) * dy;
		ax = lx;
		ay = ly;
	} else {
		len = (rx - px) * dx + (ry - py) * dy;
		ax = rx;
		ay = ry;
	}
	len = Math.min(Math.max(len, RULER_MIN_LENGTH), RULER_MAX_LENGTH);
	const nh = len / 2;
	return {
		...r,
		length: len,
		x: mode === 'resize-r' ? ax + dx * nh : ax - dx * nh,
		y: mode === 'resize-r' ? ay + dy * nh : ay - dy * nh,
	};
}
