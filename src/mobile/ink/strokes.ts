// 手写笔迹的数据模型（覆盖层自绘架构，0.6.0 起）。
//
// ⚠️ **坐标系的唯一选择：PDF 用户空间**（与 pdf.js viewport 的 convertToPdfPoint /
// convertToViewportPoint 互逆）。选它而不是屏幕坐标或归一化坐标的原因：
//   · 旋转无关 —— pdf.js viewport 自带旋转矩阵，存 PDF 空间则任何旋转下都画得对；
//   · 缩放无关 —— 渲染时乘 viewport.scale 即可，数据永不迁移；
//   · 与 0.4.x 写回 PDF 的 /InkList 同空间 —— 老数据接管是零变换直读。
//
// 压力随点存储（可选，缺省 0.5）。宽度在**渲染时**按确定性公式从压力推导
// （见 overlay-engine 的 strokePointWidths），不落盘 —— 同一份数据在任何
// 设备上重绘结果逐字节一致，也省掉逐点宽度带来的体积膨胀。

/** 笔迹 id 前缀。与 pdf.js 自身的数字 id 永不撞车。 */
export const STROKE_ID_PREFIX = 'fleur-ink-';

let strokeSeq = 0;

/** 会话内唯一的笔迹 id。 */
export function mintStrokeId(): string {
	strokeSeq += 1;
	return `${STROKE_ID_PREFIX}s${Date.now().toString(36)}-${strokeSeq}`;
}

/** 笔的种类。marker（荧光笔）走整条路径单次描边 + 半透明；pen 走逐段圆头增量。 */
export type InkStrokeKind = 'pen' | 'marker';

/**
 * 一条笔迹。
 *
 * `pts` 是扁平数组 `[x, y, p, x, y, p, ...]`（PDF 用户空间，p = 压力 0~1）。
 * 扁平数组比对象数组省一半以上的 JSON 体积，几百笔的大文件差别明显。
 */
export interface InkStroke {
	id: string;
	/** 1 基页码（与 pdf.js / DOM 的 data-page-number 一致）。 */
	page: number;
	color: string;
	/** 线宽基准值，PDF 用户空间单位。 */
	width: number;
	/** 不透明度 0~1。pen 恒 1；marker 半透明（0.45 等）。 */
	opacity: number;
	kind: InkStrokeKind;
	pts: number[];
}

/** 落盘前把坐标压到 2 位小数（PDF 单位下 0.01 ≈ 0.03px @scale3，精度远超需要）。 */
export function compactStroke(s: InkStroke): InkStroke {
	const out: number[] = [];
	for (let i = 0; i < s.pts.length; i++) {
		// 压力（每第 3 个）保留 2 位即可；坐标同精度
		out.push(Math.round(s.pts[i] * 100) / 100);
	}
	return { ...s, pts: out };
}

/* ---------------------------------------------------------------------------
 * 0.4.x / 0.5.x 旧数据迁移
 * ------------------------------------------------------------------------- */

/**
 * v1（0.5.x sidecar）里一条笔迹的形状：pdf.js `InkEditor.serialize(true)` 的产出。
 */
export interface V1InkEntry {
	page: number; // 0 基
	data: {
		color?: unknown;
		thickness?: unknown;
		opacity?: unknown;
		rotation?: unknown;
		paths?: { points?: unknown; lines?: unknown };
	};
	sourceId?: string;
}

/** pdf.js 的 color 是 [r,g,b] 0~255 数组；转 hex。坏值返回 null（调用方跳过）。 */
export function pdfColorToHex(c: unknown): string | null {
	if (!Array.isArray(c) || c.length < 3) return null;
	const to = (v: unknown) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
	return `#${[c[0], c[1], c[2]].map(to).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * v1 归一化坐标 → PDF 用户空间。
 *
 * 依据 Obsidian 内置 pdf.js 的 InkDrawOutline.deserialize（.qa/obs-pdfjs/pdf.min.mjs
 * 逐字解码）反推。deserialize 用 `_rescale(p, h, u, _, k)`：
 *   X = h + x·_ ，Y = u + y·k
 * rotation 0 时 h=-pageX/W、u=pageY/H+1、_=1/W、k=-1/H，即**存储值就是
 * scale-1 视口坐标除以页宽高**。反解四种旋转：
 */
export function v1PointToPdf(
	x: number,
	y: number,
	rot: number,
	box: { x: number; y: number; w: number; h: number },
): [number, number] {
	switch (((rot % 360) + 360) % 360) {
		case 90:
			// X=(y_in-pageY)/H ，Y=(x_in-pageX)/W
			return [box.x + y * box.w, box.y + x * box.h];
		case 180:
			return [box.x + (1 - x) * box.w, box.y + y * box.h];
		case 270:
			return [box.x + (1 - y) * box.w, box.y + (1 - x) * box.h];
		case 0:
		default:
			return [box.x + x * box.w, box.y + (1 - y) * box.h];
	}
}

/**
 * 把一条 v1 entry 转成新笔迹。失败（几何缺失 / 颜色坏）返回 null。
 *
 * v1 数据没有压力 —— 全部取 0.5，渲染宽度与旧版观感接近（0.4+0.8×0.5 = 0.8×基准宽）。
 * kind 按 opacity 推断：<1 即荧光笔。
 */
export function v1EntryToStroke(
	entry: V1InkEntry,
	viewBox: number[] | null,
): InkStroke | null {
	const rawPts = entry.data?.paths?.points;
	if (!Array.isArray(rawPts) || !viewBox || viewBox.length < 4) return null;
	const color = pdfColorToHex(entry.data.color);
	if (!color) return null;
	const rot = Number(entry.data.rotation ?? 0) || 0;
	const box = { x: viewBox[0], y: viewBox[1], w: viewBox[2] - viewBox[0], h: viewBox[3] - viewBox[1] };
	if (!(box.w > 0) || !(box.h > 0)) return null;

	const pts: number[] = [];
	for (const seg of rawPts) {
		if (!Array.isArray(seg) || seg.length < 2) continue;
		for (let i = 0; i + 1 < seg.length; i += 2) {
			const x = Number(seg[i]);
			const y = Number(seg[i + 1]);
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			// v1 归一化坐标可能带 0.01 量化误差，略越界不裁剪（裁剪会切平笔锋）
			const [px, py] = v1PointToPdf(x, y, rot, box);
			pts.push(px, py, 0.5);
		}
	}
	if (pts.length < 6) return null;

	const opacity = Number(entry.data.opacity ?? 1);
	return {
		id: mintStrokeId(),
		page: entry.page + 1,
		color,
		width: Number(entry.data.thickness ?? 3) || 3,
		opacity: Number.isFinite(opacity) ? Math.max(0.05, Math.min(1, opacity)) : 1,
		kind: opacity < 0.99 ? 'marker' : 'pen',
		pts,
	};
}

/**
 * pdf.js 注释层的 /Ink 注释（0.4.x 写回的老笔迹）→ 新笔迹。
 *
 * `annotation.inkLists` 就是 PDF 用户空间的点列（/InkList 原值），**零变换直读** ——
 * 这是不经过 pdf.js 编辑器、不依赖注释层渲染时机的关键。
 */
export function inkAnnotationToStrokes(annotation: any, pageNumber: number): InkStroke[] {
	const lists = annotation?.inkLists;
	if (!Array.isArray(lists) || !lists.length) return [];
	const color = pdfColorToHex(annotation.color) ?? '#1f1f1f';
	const thickness = Number(annotation.borderStyle?.rawWidth ?? annotation.thickness ?? 3) || 3;
	const opacity = Number(annotation.opacity ?? 1);
	const opacity1 = Number.isFinite(opacity) ? Math.max(0.05, Math.min(1, opacity)) : 1;
	const out: InkStroke[] = [];
	for (const list of lists) {
		if (!Array.isArray(list) || list.length < 4) continue;
		const pts: number[] = [];
		for (let i = 0; i + 1 < list.length; i += 2) {
			const x = Number(list[i]);
			const y = Number(list[i + 1]);
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			pts.push(x, y, 0.5);
		}
		if (pts.length < 6) continue;
		out.push({
			id: mintStrokeId(),
			page: pageNumber,
			color,
			width: thickness,
			opacity: opacity1,
			kind: opacity1 < 0.99 ? 'marker' : 'pen',
			pts,
		});
	}
	return out;
}
