// 局部截图的高清渲染：不用屏幕像素，而是用 pdf.js 按选区重新渲染。
//
// 为什么不直接截 canvas：屏幕上页面的物理分辨率受当前缩放与 DPR 限制，
// 缩小窗口后截出来的图糊，OCR 与 AI 视觉都遭罪。pdf.js 重渲染则与
// 屏幕状态完全解耦 —— 3x（≈216dpi）起步，小区域也能出高清图。

/** 截图区域（PDF 用户空间，来自引擎的 onSnap 回调）。 */
export interface SnapRegion {
	page: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export interface SnapImage {
	/** PNG dataURL（带 mime 前缀，可直接喂 <img> / AI vision / OCR）。 */
	dataUrl: string;
	width: number;
	height: number;
}

/** 整页渲染的像素上限（移动端 WebView 内存红线；A4 @4x ≈ 9.9M px，留余量）。 */
const MAX_PAGE_PIXELS = 16_000_000;
/** 目标渲染密度（px / PDF 单位）。3 ≈ 216dpi，文字 OCR 的实用下限。 */
const TARGET_SCALE = 3;

/**
 * 把 PDF 用户空间矩形渲染成 PNG。
 * 任何一步失败都返回 null（调用方给 Notice，不打断手写会话）。
 */
export async function renderSnapRegion(
	viewer: any,
	region: SnapRegion
): Promise<SnapImage | null> {
	try {
		const pageView = viewer?.getPageView?.(region.page - 1);
		const pdfPage = pageView?.pdfPage;
		if (!pdfPage) return null;

		const pw: number = pdfPage.view[2] - pdfPage.view[0];
		const ph: number = pdfPage.view[3] - pdfPage.view[1];
		if (!(pw > 0 && ph > 0)) return null;

		// 密度：目标 3x 起步，随屏幕缩放略升（放大时用户显然在意细节），
		// 但整页像素封顶 —— 超了就压 scale。
		const screenScale: number = pageView.viewport?.scale ?? 1;
		let scale = Math.max(TARGET_SCALE, Math.min(screenScale * 2, 6));
		const cap = Math.sqrt(MAX_PAGE_PIXELS / (pw * ph));
		if (scale > cap) scale = cap;

		const viewport = pdfPage.getViewport({ scale });
		const canvas = document.createElement('canvas');
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		// 白底：PDF 内容可能透明背景，PNG 无白底在深色主题下会变「透明图」
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await pdfPage.render({ canvasContext: ctx, viewport }).promise;

		// 选区（PDF 空间）→ 渲染像素空间。convertToViewportPoint 自带旋转矩阵，
		// 旋转页两角顺序会颠倒，用 min/max 归一。
		const [ax, ay] = viewport.convertToViewportPoint(region.x0, region.y0);
		const [bx, by] = viewport.convertToViewportPoint(region.x1, region.y1);
		const sx = Math.max(0, Math.floor(Math.min(ax, bx)));
		const sy = Math.max(0, Math.floor(Math.min(ay, by)));
		const sw = Math.min(canvas.width, Math.ceil(Math.max(ax, bx))) - sx;
		const sh = Math.min(canvas.height, Math.ceil(Math.max(ay, by))) - sy;
		if (sw < 4 || sh < 4) return null;

		const out = document.createElement('canvas');
		out.width = sw;
		out.height = sh;
		const octx = out.getContext('2d');
		if (!octx) return null;
		octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
		return { dataUrl: out.toDataURL('image/png'), width: sw, height: sh };
	} catch (err) {
		console.warn('[FleurPDF Snap] 区域渲染失败:', err);
		return null;
	}
}
