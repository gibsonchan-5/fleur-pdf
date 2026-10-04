// 从 PDF 文本层提取选区内的文字（数字 PDF 的「复制文本」通道）。
//
// 关键事实：正规出版的数字 PDF（论文 / 经济学人 / 官方文件）几乎都带文本层，
// 精确、离线、瞬时、零成本 —— 本地 OCR 与视觉模型只该在文本层缺位时上场。
//
// 实现：getTextContent() 给出每个 text item 的 PDF 空间 transform（e,f 为基线
// 原点）与 width/height；统一转到视口空间后与选区做相交测试（同一 viewport
// 变换下比较，天然兼容旋转页）。行重组按「视口 y 聚类 + 行内 x 排序」。

import type { SnapRegion } from './snap-renderer';

interface ItemBox {
	str: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** 行聚类容差系数（行高中位数的占比；同一行 item 的 y 波动远小于此）。 */
const LINE_TOLERANCE = 0.6;

export async function extractTextInRect(viewer: any, region: SnapRegion): Promise<string> {
	try {
		const pageView = viewer?.getPageView?.(region.page - 1);
		const pdfPage = pageView?.pdfPage;
		const viewport = pageView?.viewport;
		if (!pdfPage || !viewport) return '';

		const content = await pdfPage.getTextContent();
		if (!content?.items?.length) return '';

		// 选区 → 视口空间矩形
		const [rx0v, ry0v] = viewport.convertToViewportPoint(region.x0, region.y0);
		const [rx1v, ry1v] = viewport.convertToViewportPoint(region.x1, region.y1);
		const rx0 = Math.min(rx0v, rx1v);
		const rx1 = Math.max(rx0v, rx1v);
		const ry0 = Math.min(ry0v, ry1v);
		const ry1 = Math.max(ry0v, ry1v);

		const boxes: ItemBox[] = [];
		for (const item of content.items as any[]) {
			const str: string = item?.str ?? '';
			if (!str.trim()) continue;
			const t = item.transform as number[];
			if (!Array.isArray(t) || t.length < 6) continue;
			// PDF 空间：基线原点 (e,f)，文字位于基线上方的 height 区间
			const px = t[4];
			const py = t[5];
			const w = Number(item.width) || 0;
			const h = Number(item.height) || 0;
			const [ax, ay] = viewport.convertToViewportPoint(px, py - h);
			const [bx, by] = viewport.convertToViewportPoint(px + w, py);
			const x0 = Math.min(ax, bx);
			const x1 = Math.max(ax, bx);
			const y0 = Math.min(ay, by);
			const y1 = Math.max(ay, by);
			// 相交测试（中心点命中 + 矩形相交皆收，容忍基线定位偏差）
			const cx = (x0 + x1) / 2;
			const cy = (y0 + y1) / 2;
			const intersects =
				(cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1) ||
				(x0 < rx1 && x1 > rx0 && y0 < ry1 && y1 > ry0);
			if (intersects) boxes.push({ str, x0, y0, x1, y1 });
		}

		if (!boxes.length) return '';

		// ── 行重组：按 y（行高中位数容差）聚类，行内按 x 排序 ──
		const heights = boxes.map((b) => b.y1 - b.y0).filter((h) => h > 0).sort((a, b) => a - b);
		const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
		const tol = Math.max(medianH * LINE_TOLERANCE, 2);

		boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
		const lines: string[] = [];
		let line: ItemBox[] = [];
		let lineY = Number.NaN;

		const flush = () => {
			if (!line.length) return;
			line.sort((a, b) => a.x0 - b.x0);
			lines.push(line.map((b) => b.str).join('').replace(/\s+/g, ' ').trim());
			line = [];
		};

		for (const b of boxes) {
			if (!Number.isNaN(lineY) && Math.abs(b.y0 - lineY) > tol) flush();
			if (!line.length) lineY = b.y0;
			line.push(b);
		}
		flush();

		return lines.filter(Boolean).join('\n');
	} catch (err) {
		console.warn('[FleurPDF Snap] 文本层提取失败:', err);
		return '';
	}
}
