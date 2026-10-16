// 直尺（参考 Apple Notes）：几何纯函数。
//
// 交互（已与用户确认）：
//   · 可拖动 + 可旋转（拖尺身移动、拖右端手柄旋转）；
//   · 贴尺沿的才变直：落点/采样点落在尺沿 ~24px 感应带内的那一笔，后续点
//     实时投影到尺沿直线（所见即所得），不在带内的笔迹完全不受影响。
//
// 坐标系约定：直尺状态存放在 pdf.js viewer 根元素（.pdfViewer）的 CSS 像素
// 坐标系里 —— 尺 DOM 挂在根元素上随内容滚动；页面 surface 的 CSS 坐标与
// 根坐标之间只差两个包围盒原点的平移（无缩放差，同一 CSS px 尺度），
// 感应带阈值因此与用户手感一致、不随缩放变。
//
// 纯函数无 DOM 依赖，可无头测试（scripts/test-ink-ruler.mjs）。

/** 贴尺感应带宽度（CSS px）：点距尺沿不超过此值即判「贴尺」。 */
export const RULER_SNAP_BAND_PX = 24;

/** 直尺状态（viewer 根元素 CSS 坐标系）。x/y 为尺中心。 */
export interface RulerState {
	x: number;
	y: number;
	/** 弧度。0 = 水平，尺长方向沿 (cos, sin)。 */
	angle: number;
	length: number;
	width: number;
}

/** 尺沿（工作边）所在直线：过点 (ex, ey)、单位方向向量 (dx, dy)。 */
export interface EdgeLine {
	ex: number;
	ey: number;
	dx: number;
	dy: number;
}

/** 移动端默认尺身尺寸（CSS px）：单手可拖动的长度上限内尽量长。 */
export const RULER_DEFAULT_LENGTH = 340;
export const RULER_DEFAULT_WIDTH = 46;

/**
 * 尺沿直线。工作边取尺身「上缘」：中心沿法线 (dy, -dx) 偏移 width/2 ——
 * angle=0（水平）时法线是 (0,-1) 即屏幕上方，与视觉上的上边缘一致。
 * 旋转后跟随尺身，永远是同一条被高亮的边。
 */
export function rulerEdgeLine(r: RulerState): EdgeLine {
	const dx = Math.cos(r.angle);
	const dy = Math.sin(r.angle);
	return {
		ex: r.x + (dy * r.width) / 2,
		ey: r.y + (-dx * r.width) / 2,
		dx,
		dy,
	};
}

/** 点到尺沿直线的距离（CSS px，无符号 —— 感应带在边两侧都算贴尺）。 */
export function distanceToEdge(line: EdgeLine, px: number, py: number): number {
	// |(P − E) × d|：叉积的绝对值就是点到直线的垂距（d 是单位向量）。
	return Math.abs((px - line.ex) * line.dy - (py - line.ey) * line.dx);
}

/** 点在尺沿上的垂足投影。 */
export function projectToEdge(line: EdgeLine, px: number, py: number): { x: number; y: number } {
	const t = (px - line.ex) * line.dx + (py - line.ey) * line.dy;
	return { x: line.ex + t * line.dx, y: line.ey + t * line.dy };
}

/** 贴尺判定：点落在尺沿感应带内。 */
export function nearEdge(line: EdgeLine, px: number, py: number, bandPx = RULER_SNAP_BAND_PX): boolean {
	return distanceToEdge(line, px, py) <= bandPx;
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
