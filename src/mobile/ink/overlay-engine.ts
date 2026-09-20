// 手写批注的覆盖层自绘引擎（0.6.0 架构）。
//
// ⚠️ **本文件是「掉笔迹 / 擦不掉 / 断触 / 不顺滑」四个顽疾的最终解法，改动前务必读完。**
//
// 架构：笔迹**完全不经过 pdf.js 的编辑器**。每页挂一对覆盖层 canvas
// （committed 已提交层 + draft 草稿层），输入我们自己接、笔画我们自己画、
// 数据存插件自己的 JSON（ink-store）。pdf.js 只负责渲染页面内容。
//
// 这是三个成熟插件（mobile-ink-annotation / jot / handwriting-natively）的
// 共同做法，各自验证过的关键机制照搬如下：
//
//   ① **页面虚拟化免疫**（jot）：MutationObserver 盯住 .pdfViewer，pdf.js 销毁
//      重建 page DOM 后自动重挂 canvas 并从数据重绘 —— 笔迹跟 DOM 生命周期脱钩，
//      重开文件、翻页、缩放都不丢。
//   ② **断触容错**（mobile-ink-annotation）：pointercancel 不丢笔 —— 进 400ms
//      宽限期，笔重新落下就续写同一笔；宽限期到才提交。Android 的 S Pen 抬笔
//      瞬间、掌压边缘都会触发 cancel，直接丢笔就是「断触」的主诉。
//   ③ **高频采样**（三家）：pointermove 里用 getCoalescedEvents 取合并的
//      中间采样点，一笔的点密度翻数倍 —— 顺滑的第一来源。
//   ④ **顺滑**（mobile-ink + handwriting-natively）：因果 EMA（位置 + 宽度，
//      只依赖已画点）+ 逐段圆头直线增量渲染。增量 = 每 move 只画新增线段，
//      长笔画不重算；因果 = 已画部分永不移动，提交时零 snap。
//   ⑤ **掌压拒止**（handwriting-natively）：touch 永不落墨；笔活动期间
//      document 级拦截 touchmove 防滚动；接触面 ≥42px 且高压判为掌压。
//   ⑥ **擦除**（mobile-ink）：笔画级命中测试（点到线段距离），擦完从数据
//      重绘 —— 数据在，就永远擦得掉、画得回。
//   ⑦ **坐标**：PDF 用户空间（viewport.convertToPdfPoint / convertToViewportPoint
//      互逆）—— 旋转、缩放全部由 pdf.js 的矩阵消化，数据永不迁移。
//
// 输入性能红线（handwriting-natively 的实测教训）：pointermove 路径上禁止
// DOM 查询与布局读取之外的任何重活；getBoundingClientRect 每 move 一次是
// mobile-ink 的生产做法，照用。

import type { App } from 'obsidian';
import { mintStrokeId, type InkStroke, type InkStrokeKind } from './strokes';

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */

/** 断触宽限期：pointercancel 后保留笔画多久，期间笔重新落下就续写。 */
const CANCEL_GRACE_MS = 400;

/** 笔活动后多久内拒绝一切 touch（防掌压把页面滚走）。 */
const PEN_TOUCH_REJECTION_MS = 1200;

/**
 * 掌腹接触面判定阈值（CSS px）：touch 指针上报的接触面（width/height）
 * 任一边超过此值视为掌腹（大鱼际 / 掌缘），即使不在笔活动窗口内也不启动
 * 指滚 —— 掌腹先落、笔后到时悬停信号可能来不及先到，这是第二道网。
 * 参照 mobile-ink-annotation 的 hasFineContact（其细接触上限 18px），
 * 此处放宽到 24：只拦掌腹，尽量不误伤大指尖的滚动。
 */
const PALM_CONTACT_MAX_PX = 24;

/** 位置 EMA 系数（0.7 = 轻度平滑：压掉数字笔的高频抖动，几乎无迟滞）。 */
const POSITION_ALPHA = 0.7;

/** 压力 EMA 系数。 */
const PRESSURE_ALPHA = 0.5;

/** 掌压判定：接触面任一边 ≥ 此值（CSS px）且高压 → 掌（当前架构 touch 不落墨，此值仅用于诊断）。 */
const PALM_SIZE_THRESHOLD = 42;

/** canvas 物理分辨率上限（DPR 封顶 + 总像素封顶，移动端 WebView 的内存红线）。 */
const MAX_DPR = 3;
const MAX_CANVAS_PIXELS = 72_000_000;

/* ---------------------------------------------------------------------------
 * 类型
 * ------------------------------------------------------------------------- */

/** 工具状态。pen/marker 二合一（kind 区分），橡皮带半径（PDF 用户空间单位）。 */
export type InkTool =
	| { mode: 'pen'; color: string; width: number; opacity: number; kind: InkStrokeKind }
	| { mode: 'eraser'; radius: number }
	| { mode: 'lasso' }
	// 手指滚动：canvas touch-action:none 之后浏览器不再代管平移，滚动由我们驱动。
	// 用户的工具选择永远不会落到 scroll 上 —— 它只由 touch pointerdown 触发。
	| { mode: 'scroll' };

/** 一个页面的覆盖层。committed 常驻显示；draft 只放「进行中」的东西（荧光笔预览 / 橡皮光标 / 套索框）。 */
interface Surface {
	page: number;
	el: HTMLElement;
	committed: HTMLCanvasElement;
	draft: HTMLCanvasElement;
	cctx: CanvasRenderingContext2D;
	dctx: CanvasRenderingContext2D;
	dpr: number;
	resizeObs: ResizeObserver;
	cssW: number;
	cssH: number;
}

/** 正在进行的绘制/擦除/套索手势。 */
interface ActiveGesture {
	pointerId: number;
	pointerType: string;
	surface: Surface;
	tool: InkTool;
	moved: boolean;
	/** 手势开始前的数据快照（有改动才入 undo 栈）。 */
	snapshot: Map<number, InkStroke[]>;
	// draw
	stroke?: InkStroke;
	strokeWidths?: number[]; // PDF 单位，与 pts 并行
	renderedCount?: number; // 已增量画进 committed 的点数
	lastRaw?: { x: number; y: number }; // EMA 前的原始点（PDF 空间）
	// erase
	eraseChanged?: boolean;
	// lasso
	lassoStart?: { x: number; y: number };
	// move（拖动已选中的笔迹）
	moveMode?: boolean;
	moveOrig?: Map<string, number[]>;
	moveRectOrig?: { x0: number; y0: number; x1: number; y1: number };
	moveStart?: { x: number; y: number };
	// scroll（手指滚动）
	scrollLast?: { x: number; y: number };
	scrollEl?: HTMLElement | null;
	/** 松手惯性用的速度（CSS px/ms，EMA 平滑；向下/向右为正）。 */
	scrollVel?: { x: number; y: number };
	/** 上一个 scroll move 事件的时间戳（算瞬时速度用）。 */
	scrollTime?: number;
}

/** 套索选区（PDF 用户空间矩形）。 */
interface Selection {
	page: number;
	ids: Set<string>;
	rect: { x0: number; y0: number; x1: number; y1: number };
}

/* ---------------------------------------------------------------------------
 * 几何工具
 * ------------------------------------------------------------------------- */

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 渲染时从压力推导每点宽度（PDF 用户空间）。
 *
 * ⚠️ 必须**只依赖 0..i 的点**（因果）且**确定性**：live 增量与全量重绘走同一个
 * 函数，已画部分才不会在提交/重绘时变样；同一份数据在任何设备上重绘一致。
 */
export function strokePointWidths(s: InkStroke): number[] {
	const n = s.pts.length / 3;
	const out: number[] = [];
	let prev = 0;
	for (let i = 0; i < n; i++) {
		const p = clamp01(s.pts[i * 3 + 2] ?? 0.5);
		let raw = s.width * (0.4 + 0.8 * p);
		// 起笔 taper：头三个点渐入，避免「一顿墨点」
		if (i < 3 && n > 3) raw *= 0.6 + 0.4 * (i / 2);
		const w = i === 0 ? raw : 0.55 * raw + 0.45 * prev;
		out.push(w);
		prev = w;
	}
	return out;
}

/** 点到线段的最短距离平方（橡皮命中测试的核）。 */
function distPointToSegmentSq(
	px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = 0;
	if (lenSq > 0) t = clamp01(((px - ax) * dx + (py - ay) * dy) / lenSq);
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** 橡皮圆是否碰到这条笔画（逐线段 + 半笔宽余量）。 */
function strokeHitsCircle(s: InkStroke, cx: number, cy: number, r: number): boolean {
	const rr = (r + s.width / 2) * (r + s.width / 2);
	const n = s.pts.length / 3;
	if (n === 1) {
		const dx = s.pts[0] - cx;
		const dy = s.pts[1] - cy;
		return dx * dx + dy * dy <= rr;
	}
	for (let i = 0; i + 1 < n; i++) {
		if (
			distPointToSegmentSq(
				cx, cy,
				s.pts[i * 3], s.pts[i * 3 + 1],
				s.pts[i * 3 + 3], s.pts[i * 3 + 4],
			) <= rr
		) return true;
	}
	return false;
}

/* ---------------------------------------------------------------------------
 * 引擎
 * ------------------------------------------------------------------------- */

export class InkOverlayEngine {
	/** pdf.js PDFViewer 引用（attach 时注入）。 */
	private viewer: any = null;
	private app: App;

	/** 页面覆盖层表（1 基页码 → surface）。 */
	private surfaces = new Map<number, Surface>();
	/** 笔迹数据（页码 → 该页笔迹）。 */
	private pages = new Map<number, InkStroke[]>();
	/** 工具状态。 */
	private tool: InkTool = { mode: 'pen', color: '#1f1f1f', width: 3, opacity: 1, kind: 'pen' };
	/** 当前手势。 */
	private active: ActiveGesture | null = null;
	/** 断触宽限计时器。 */
	private cancelTimer: number | null = null;
	/** 笔最近活动时刻（掌压拒止窗口用）。 */
	private penActivityUntil = 0;
	/** 进行中的笔所触发的「拒绝 touch」窗口。 */
	private touchGuard: ((e: TouchEvent) => void) | null = null;

	/** undo / redo 栈（数据快照）。 */
	private undoStack: Map<number, InkStroke[]>[] = [];
	private redoStack: Map<number, InkStroke[]>[] = [];

	/** 套索选区。 */
	private selection: Selection | null = null;

	/** 被「接管隐藏」的固有注释 id（0.4.x 老笔迹的原件）。 */
	private hiddenInkIds = new Set<string>();

	/** DOM 观察。 */
	private pageObserver: MutationObserver | null = null;
	private reconcileTimer: number | null = null;

	/** 数据变化回调（InkUI 用它排自动落盘）。 */
	private changeListeners = new Set<() => void>();

	/** 待重绘页集合（rAF 合并重绘）。 */
	private paintPending = new Set<number>();
	private paintScheduled = false;

	/** 松手惯性滚动的 rAF 句柄（null = 没有惯性动画在进行）。 */
	private momentumRaf: number | null = null;

	constructor(app: App) {
		this.app = app;
	}

	/* ------------------------------ 生命周期 ------------------------------ */

	/** 挂载：装观察器与输入监听，给已渲染的页挂覆盖层。 */
	attach(viewer: any): void {
		this.detach();
		this.viewer = viewer;
		this.pages.clear();
		this.undoStack = [];
		this.redoStack = [];
		this.selection = null;

		// 输入监听挂在 document capture —— canvas 会被 pdf.js 的页面重建拆掉，
		// 监听只装一次，由事件目标反查所属 surface。
		document.addEventListener('pointerdown', this.onPointerDown, { capture: true, passive: false });
		document.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: false });
		document.addEventListener('pointerup', this.onPointerUp, { capture: true, passive: false });
		document.addEventListener('pointercancel', this.onPointerCancel, { capture: true, passive: false });
		document.addEventListener('touchmove', this.onTouchMoveGuard, { capture: true, passive: false });

		const root: HTMLElement | undefined = viewer?.viewer;
		if (root) {
			this.pageObserver = new MutationObserver(() => this.scheduleReconcile());
			this.pageObserver.observe(root, { childList: true, subtree: true });
		}
		this.scheduleReconcile();
	}

	/** 卸载：一切监听与 DOM 全部拆掉（退出手写模式时调用）。 */
	detach(): void {
		if (this.cancelTimer !== null) window.clearTimeout(this.cancelTimer);
		this.cancelTimer = null;
		this.cancelMomentum();
		// 手势进行中强撤：不提交（正常路径 InkUI 会先 flushActiveStroke）
		this.active = null;
		document.removeEventListener('pointerdown', this.onPointerDown, { capture: true } as any);
		document.removeEventListener('pointermove', this.onPointerMove, { capture: true } as any);
		document.removeEventListener('pointerup', this.onPointerUp, { capture: true } as any);
		document.removeEventListener('pointercancel', this.onPointerCancel, { capture: true } as any);
		document.removeEventListener('touchmove', this.onTouchMoveGuard, { capture: true } as any);
		document.body.removeClass('fleur-pdf-ink-stroking');
		this.pageObserver?.disconnect();
		this.pageObserver = null;
		for (const n of Array.from(this.surfaces.keys())) this.unmountSurface(n);
		this.surfaces.clear();
		this.pages.clear();
		this.viewer = null;
	}

	get attached(): boolean {
		return !!this.viewer;
	}

	/* ------------------------------ 数据 ------------------------------ */

	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
	}

	private emitChange(): void {
		for (const cb of this.changeListeners) {
			try {
				cb();
			} catch {
				/* 单个监听者坏掉不影响其余 */
			}
		}
	}

	/** 用给定数据整体替换（进入手写模式恢复历史笔迹时调用）。 */
	loadStrokes(strokes: InkStroke[]): void {
		this.pages.clear();
		for (const s of strokes) {
			if (!s || typeof s.page !== 'number' || s.page < 1) continue;
			const list = this.pages.get(s.page);
			if (list) list.push(s);
			else this.pages.set(s.page, [s]);
		}
		this.undoStack = [];
		this.redoStack = [];
		this.selection = null;
		this.requestPaintAll();
	}

	/** 导出全部笔迹（落盘用）。进行中的手势先提交，保证最后一笔不丢。 */
	getStrokes(): InkStroke[] {
		this.flushActiveStroke();
		const out: InkStroke[] = [];
		for (const list of this.pages.values()) out.push(...list);
		return out;
	}

	setTool(tool: InkTool): void {
		this.tool = tool;
		// 切走时清掉旧工具的视觉残留
		if (tool.mode !== 'lasso') this.selection = null;
		this.requestPaintAll();
	}

	/* ------------------------------ 撤销 / 重做 ------------------------------ */

	private snapshot(): Map<number, InkStroke[]> {
		const m = new Map<number, InkStroke[]>();
		for (const [page, list] of this.pages) {
			m.set(
				page,
				list.map((s) => ({ ...s, pts: s.pts.slice() })),
			);
		}
		return m;
	}

	private restore(snap: Map<number, InkStroke[]>): void {
		this.pages = new Map(snap);
		this.selection = null;
		this.requestPaintAll();
	}

	private pushUndo(snap: Map<number, InkStroke[]>): void {
		this.undoStack.push(snap);
		if (this.undoStack.length > 50) this.undoStack.shift();
		this.redoStack = [];
	}

	undo(): boolean {
		const snap = this.undoStack.pop();
		if (!snap) return false;
		this.redoStack.push(this.snapshot());
		this.restore(snap);
		this.emitChange();
		return true;
	}

	redo(): boolean {
		const snap = this.redoStack.pop();
		if (!snap) return false;
		this.undoStack.push(this.snapshot());
		this.restore(snap);
		this.emitChange();
		return true;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** 清空全部笔迹（橡皮面板的「清除全部」）。 */
	clearAll(): void {
		if (!this.pages.size) return;
		this.pushUndo(this.snapshot());
		this.pages.clear();
		this.selection = null;
		this.requestPaintAll();
		this.emitChange();
	}

	/* ------------------------------ 套索选区 ------------------------------ */

	get hasSelection(): boolean {
		return !!this.selection;
	}

	deleteSelection(): boolean {
		if (!this.selection) return false;
		const sel = this.selection;
		const list = this.pages.get(sel.page);
		if (!list) return false;
		this.pushUndo(this.snapshot());
		const kept = list.filter((s) => !sel.ids.has(s.id));
		if (kept.length) this.pages.set(sel.page, kept);
		else this.pages.delete(sel.page);
		this.selection = null;
		this.requestPaint(sel.page);
		this.emitChange();
		return true;
	}

	/* ------------------------------ 固有注释隐藏 ------------------------------ */

	/**
	 * 隐藏被接管过的固有 /Ink 注释原件（防「原件 + 覆盖层」双影）。
	 * 页面重建后由 reconcile 重挂时自动补涂。
	 */
	hideInherentInk(ids: Set<string>): void {
		this.hiddenInkIds = new Set(ids);
		this.reapplyHiddenInk();
	}

	private reapplyHiddenInk(): void {
		if (!this.hiddenInkIds.size) return;
		const root: HTMLElement | undefined = this.viewer?.viewer;
		if (!root) return;
		for (const id of this.hiddenInkIds) {
			try {
				const sel = `[data-annotation-id="${CSS.escape(id)}"]`;
				root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
					el.style.display = 'none';
				});
			} catch {
				/* 单个 id 的转义/查询失败不影响其余 */
			}
		}
	}

	/* ============================ 页面覆盖层 ============================ */

	private scheduleReconcile(): void {
		if (this.reconcileTimer !== null) return;
		this.reconcileTimer = window.setTimeout(() => {
			this.reconcileTimer = null;
			this.reconcile();
		}, 80);
	}

	/**
	 * 对齐「DOM 里的页」与「覆盖层」。
	 *
	 * 这是**防丢笔迹的核心机制**：pdf.js 虚拟化会随时销毁/重建 page DOM，
	 * 这里把覆盖层重新挂回去，笔迹从 `this.pages` 重绘 —— 数据不随 DOM 走。
	 */
	private reconcile(): void {
		const root: HTMLElement | undefined = this.viewer?.viewer;
		if (!root) return;
		const seen = new Set<number>();
		const els = root.querySelectorAll<HTMLElement>('.page[data-page-number]');
		for (const el of Array.from(els)) {
			const n = Number(el.dataset.pageNumber);
			if (!Number.isFinite(n) || n < 1) continue;
			seen.add(n);
			// 只给已渲染出内容的页挂层（canvasWrapper 存在 = 内容已渲染）
			if (!this.surfaces.has(n) && el.querySelector('.canvasWrapper')) this.mountSurface(n, el);
		}
		for (const n of Array.from(this.surfaces.keys())) {
			const sf = this.surfaces.get(n)!;
			if (!seen.has(n) || !sf.el.isConnected) this.unmountSurface(n);
		}
		this.reapplyHiddenInk();
	}

	private mountSurface(page: number, el: HTMLElement): void {
		const committed = document.createElement('canvas');
		committed.addClass('fleur-ink-canvas');
		const draft = document.createElement('canvas');
		draft.addClass('fleur-ink-canvas');
		draft.addClass('is-draft');
		el.appendChild(committed);
		el.appendChild(draft);

		const sf: Surface = {
			page,
			el,
			committed,
			draft,
			cctx: committed.getContext('2d')!,
			dctx: draft.getContext('2d')!,
			dpr: 1,
			cssW: 0,
			cssH: 0,
			resizeObs: new ResizeObserver(() => this.resizeSurface(sf)),
		};
		sf.resizeObs.observe(el);
		this.surfaces.set(page, sf);
		this.resizeSurface(sf);
	}

	private unmountSurface(page: number): void {
		const sf = this.surfaces.get(page);
		if (!sf) return;
		// 页面即将消失：手势若在这页上，立刻提交（数据保住，DOM 无所谓）
		if (this.active?.surface === sf) this.flushActiveStroke();
		sf.resizeObs.disconnect();
		sf.committed.remove();
		sf.draft.remove();
		this.surfaces.delete(page);
	}

	private resizeSurface(sf: Surface): void {
		const w = sf.el.clientWidth;
		const h = sf.el.clientHeight;
		if (w <= 0 || h <= 0) return;
		let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
		// 总像素封顶：超高分辨率平板上防止 canvas 位图吃爆 WebView 内存
		while (dpr > 1 && w * h * dpr * dpr > MAX_CANVAS_PIXELS) dpr -= 0.5;
		if (w === sf.cssW && h === sf.cssH && dpr === sf.dpr) return;
		sf.cssW = w;
		sf.cssH = h;
		sf.dpr = dpr;
		for (const cv of [sf.committed, sf.draft]) {
			cv.width = Math.round(w * dpr);
			cv.height = Math.round(h * dpr);
			// CSS 尺寸必须显式钉死：canvas 的样式宽高不随属性变（inset:0 已覆盖，双保险）
			cv.setCssStyles?.({ width: `${w}px`, height: `${h}px` });
		}
		sf.cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		sf.dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.paintPage(sf);
	}

	/* ------------------------------ 坐标与视口 ------------------------------ */

	/** 当前页的 pdf.js viewport（含缩放与旋转）；页未渲染时为 null。 */
	private viewportFor(page: number): any {
		try {
			return this.viewer?.getPageView?.(page - 1)?.viewport ?? null;
		} catch {
			return null;
		}
	}

	/** client 坐标 → 该页 surface 的 CSS 坐标。 */
	private clientToCss(sf: Surface, clientX: number, clientY: number): { x: number; y: number } {
		const rect = sf.el.getBoundingClientRect();
		return { x: clientX - rect.left, y: clientY - rect.top };
	}

	/** surface CSS 坐标 → PDF 用户空间。 */
	private cssToPdf(sf: Surface, x: number, y: number): { x: number; y: number } | null {
		const vp = this.viewportFor(sf.page);
		if (!vp?.convertToPdfPoint) return null;
		const [px, py] = vp.convertToPdfPoint(x, y);
		return { x: px, y: py };
	}

	/** PDF 用户空间 → surface CSS 坐标。 */
	private pdfToCss(sf: Surface, x: number, y: number): { x: number; y: number } | null {
		const vp = this.viewportFor(sf.page);
		if (!vp?.convertToViewportPoint) return null;
		const [cx, cy] = vp.convertToViewportPoint(x, y);
		return { x: cx, y: cy };
	}

	/* ============================ 输入 ============================ */

	/** 事件落在哪一页的覆盖层上（只认我们的 canvas，掌压蹭到文本层不认）。 */
	private surfaceOfEvent(e: Event): Surface | null {
		const t = e.target as Element | null;
		if (!t || !(t instanceof HTMLCanvasElement) || !t.hasClass('fleur-ink-canvas') || t.hasClass('is-draft')) {
			return null;
		}
		const pageEl = t.closest?.('.page[data-page-number]') as HTMLElement | null;
		if (!pageEl) return null;
		const n = Number(pageEl.dataset.pageNumber);
		return this.surfaces.get(n) ?? null;
	}

	private onPointerDown = (e: PointerEvent): void => {
		if (e.pointerType === 'touch') {
			// 手指只滚动，永不落墨（画 / 擦 / 套索是笔和鼠标的活）。
			// 笔活动窗口内的 touch 一律视为掌压 → 无视，防止书写时掌缘把页面拖走。
			if (this.active || performance.now() < this.penActivityUntil) return;
			// 接触面判据：掌腹（大鱼际 / 掌缘）即使在笔活动窗口外也拒止
			//（部分设备上报 0 表示未知尺寸，此时不猜，放行走正常路径）。
			const contact = Math.max(e.width ?? 0, e.height ?? 0);
			if (contact > 0 && contact > PALM_CONTACT_MAX_PX) return;
			const sf = this.surfaceOfEvent(e);
			if (!sf) return;
			this.beginScrollGesture(e, sf);
			return;
		}

		// 笔 / 鼠标。若手指滚动正在进行（掌缘先落、笔后到），滚动立即让位 —— 书写优先。
		if (this.active?.tool.mode === 'scroll') this.finishGesture(false);
		this.cancelMomentum();

		if (!this.active) {
			const sf = this.surfaceOfEvent(e);
			if (!sf) return;
			this.penActivityUntil = performance.now() + PEN_TOUCH_REJECTION_MS;
			this.beginGesture(e, sf);
			return;
		}
		// 已有手势进行中 —— 断触宽限内的续写判定：
		// 同为笔（旧指针已 cancel）→ 换绑到新指针继续画
		if (this.cancelTimer !== null && this.active.stroke) {
			window.clearTimeout(this.cancelTimer);
			this.cancelTimer = null;
			this.active.pointerId = e.pointerId;
			e.preventDefault();
			e.stopPropagation();
			this.appendDrawEvent(e);
		}
		// 其余情况（第二根手指 / 掌压）一律无视 —— 进行中的笔不受任何干扰
	};

	private onPointerMove = (e: PointerEvent): void => {
		// 笔悬停（未接触，悬空 ~1cm 即发 pointermove）也要刷新笔活动窗口 ——
		// 这是成熟软件（Samsung Notes / OneNote）pen-first 拒掌的通用做法：
		// 大鱼际先落、笔后到的空档里，掌压 touch 一律无视。悬停一出现，
		// 进行中的指滚手势立即让位（书写意图已明确）。
		if (e.pointerType === 'pen') {
			this.penActivityUntil = performance.now() + PEN_TOUCH_REJECTION_MS;
			if (this.active?.tool.mode === 'scroll') this.finishGesture(false);
		}
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		this.penActivityUntil = performance.now() + PEN_TOUCH_REJECTION_MS;

		if (g.tool.mode === 'pen') {
			this.appendDrawEvent(e);
			return;
		}
		if (g.tool.mode === 'scroll') {
			// 手指滚动：move 的位移直接灌给滚动容器（touch-action:none 后浏览器不管平移了）。
			// 必须放在坐标转换之前 —— 手指经常滚出页面边界，cssToPdf 对界外返回 null。
			const now = e.timeStamp || performance.now();
			const dt = g.scrollTime !== undefined ? now - g.scrollTime : 0;
			g.scrollTime = now;
			const dx = e.clientX - (g.scrollLast?.x ?? e.clientX);
			const dy = e.clientY - (g.scrollLast?.y ?? e.clientY);
			g.scrollLast = { x: e.clientX, y: e.clientY };
			g.moved = true;
			if (g.scrollEl) {
				g.scrollEl.scrollTop -= dy;
				g.scrollEl.scrollLeft -= dx;
			}
			// 速度 EMA（px/ms）—— 松手惯性就靠它。跟手阶段本身 1:1 位移不受影响。
			// dt 过大（事件间隔异常，如被系统卡顿拉长）的采样不可信，跳过。
			if (g.scrollVel && dt > 0 && dt < 120) {
				const instX = -dx / dt;
				const instY = -dy / dt;
				g.scrollVel.x += (instX - g.scrollVel.x) * 0.25;
				g.scrollVel.y += (instY - g.scrollVel.y) * 0.25;
			}
			return;
		}
		const sf = g.surface;
		const css = this.clientToCss(sf, e.clientX, e.clientY);
		const pdf = this.cssToPdf(sf, css.x, css.y);
		if (!pdf) return;
		if (g.tool.mode === 'eraser') {
			g.eraseChanged = this.eraseAt(sf, pdf.x, pdf.y, g.tool.radius) || g.eraseChanged;
			this.drawEraserCursor(sf, css.x, css.y);
		} else if (g.tool.mode === 'lasso') {
			// ⚠️ move 模式的判定必须是 g.moveMode。此前写成 g.stroke 是真 bug：
			// stroke 只在钢笔工具下才有值，套索拖动永远走不进 previewMove ——
			// 真机表现正是「套索选中之后，区域内的手写不跟随移动」。
			if (g.moveMode) {
				this.previewMove(g, pdf);
			} else if (g.lassoStart) {
				this.drawLassoRect(sf, g.lassoStart, pdf);
				g.moved = true;
				g.lastRaw = pdf;
			}
		}
	};

	private onPointerUp = (e: PointerEvent): void => {
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		this.finishGesture(true);
	};

	private onPointerCancel = (e: PointerEvent): void => {
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		// ⚠️ 断触容错：不立刻丢笔。S Pen 抬笔瞬间 / 掌压边缘都会发 cancel。
		// 保留笔画进宽限期：期间笔重新落下（onPointerDown）或带压 move 出现
		// 就续写；宽限到点才提交。体验上等于「笔没断」。
		if (g.stroke) {
			if (this.cancelTimer !== null) window.clearTimeout(this.cancelTimer);
			this.cancelTimer = window.setTimeout(() => {
				this.cancelTimer = null;
				this.finishGesture(true);
			}, CANCEL_GRACE_MS);
			return;
		}
		this.finishGesture(false);
	};

	/** 手势期间（笔迹或手指滚动）的 touchmove 一律拦下：touch-action 已是 none，这里兜底防掌压滚动与下拉刷新。 */
	private onTouchMoveGuard = (e: TouchEvent): void => {
		const g = this.active;
		if (!g) return;
		if (g.tool.mode === 'scroll' || g.stroke) e.preventDefault();
	};

	/* ------------------------------ 手势 ------------------------------ */

	/**
	 * 手指滚动手势：canvas touch-action:none 之后浏览器不再代管平移，
	 * 滚动由 move 里程序化驱动（参照 mobile-ink-annotation / handwriting-natively）。
	 * 不做快照、不入 undo —— 滚动不产生数据变更。
	 */
	private beginScrollGesture(e: PointerEvent, sf: Surface): void {
		// 上一轮惯性还在滑就被新触摸接住 —— 立刻停掉，跟手优先
		this.cancelMomentum();
		this.active = {
			pointerId: e.pointerId,
			pointerType: e.pointerType,
			surface: sf,
			tool: { mode: 'scroll' },
			moved: false,
			snapshot: new Map(),
			scrollLast: { x: e.clientX, y: e.clientY },
			scrollEl: this.findScrollable(sf.el),
			scrollVel: { x: 0, y: 0 },
		};
	}

	/** 取消进行中的惯性滚动（新手势开始 / 卸载前调用）。 */
	private cancelMomentum(): void {
		if (this.momentumRaf !== null) {
			window.cancelAnimationFrame(this.momentumRaf);
			this.momentumRaf = null;
		}
	}

	/**
	 * 松手后的惯性 fling：以释放时刻的速度做指数衰减（每帧 ~6%），
	 * 速度低于阈值或撞到滚动边界即停。这是浏览器原生滚动的标配手感，
	 * touch-action:none 接管平移后必须自己补上 —— 缺了它就是
	 * 「文本批注顺滑、手写批注发涩」的主诉。
	 */
	private startMomentum(vx: number, vy: number, el: HTMLElement): void {
		this.cancelMomentum();
		const STOP_SPEED = 0.02; // px/ms，低于即视为停稳
		let last = performance.now();
		let velX = vx;
		let velY = vy;
		const step = (now: number): void => {
			this.momentumRaf = null;
			const dt = Math.min(48, now - last);
			last = now;
			const beforeY = el.scrollTop;
			const beforeX = el.scrollLeft;
			if (velY) el.scrollTop += velY * dt;
			if (velX) el.scrollLeft += velX * dt;
			// 写了位移但 scrollTop 纹丝不动 = 已撞到边界 → 该轴停
			if (velY !== 0 && el.scrollTop === beforeY) velY = 0;
			if (velX !== 0 && el.scrollLeft === beforeX) velX = 0;
			const decay = Math.pow(0.94, dt / 16.7);
			velX *= decay;
			velY *= decay;
			// 双轴都低于停速（含撞边置 0）才算完
			if (Math.abs(velX) < STOP_SPEED && Math.abs(velY) < STOP_SPEED) {
				return;
			}
			this.momentumRaf = window.requestAnimationFrame(step);
		};
		this.momentumRaf = window.requestAnimationFrame(step);
	}

	/** 从页面向上找第一个真正可滚动的祖先（Obsidian 移动端 PDF 视图的滚动容器）。 */
	private findScrollable(from: HTMLElement): HTMLElement | null {
		let el: HTMLElement | null = from;
		while (el && el !== document.body) {
			if (el.scrollHeight > el.clientHeight + 2) {
				const ov = getComputedStyle(el).overflowY;
				if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') return el;
			}
			el = el.parentElement;
		}
		return null;
	}

	private beginGesture(e: PointerEvent, sf: Surface): void {
		// 物理橡皮擦（触控笔尾端）：W3C 规定 eraser 端 button=5 / buttons bit32
		const eraserTip = e.button === 5 || (e.buttons & 32) !== 0;
		let tool = this.tool;
		if (eraserTip && tool.mode !== 'eraser') {
			tool = { mode: 'eraser', radius: 12 };
		}

		const snapshot = this.snapshot();
		const g: ActiveGesture = {
			pointerId: e.pointerId,
			pointerType: e.pointerType,
			surface: sf,
			tool,
			moved: false,
			snapshot,
		};

		const css = this.clientToCss(sf, e.clientX, e.clientY);
		const pdf = this.cssToPdf(sf, css.x, css.y);
		if (!pdf) return;
		g.lastRaw = pdf;

		if (tool.mode === 'pen') {
			// 鼠标无压感：取 0.75 使宽度因子恰为 1.0×设定值
			const pressure = e.pointerType === 'pen' ? clamp01(e.pressure || 0.5) : 0.75;
			g.stroke = {
				id: mintStrokeId(),
				page: sf.page,
				color: tool.color,
				width: tool.width,
				opacity: tool.opacity,
				kind: tool.kind,
				pts: [pdf.x, pdf.y, pressure],
			};
			g.strokeWidths = strokePointWidths(g.stroke);
			g.renderedCount = 1;
			// 单点也先画出来（点住不动的墨点）
			this.renderLiveIncrement(g);
			document.body.addClass('fleur-pdf-ink-stroking');
		} else if (tool.mode === 'eraser') {
			g.eraseChanged = this.eraseAt(sf, pdf.x, pdf.y, tool.radius);
			this.drawEraserCursor(sf, css.x, css.y);
		} else if (tool.mode === 'lasso') {
			// 点在已有选区内 → 拖动模式；否则开始新的框选
			if (this.selection && this.selection.page === sf.page && this.pointInSelection(pdf)) {
				g.moveMode = true;
				g.moveOrig = new Map();
				g.moveRectOrig = { ...this.selection.rect };
				const list = this.pages.get(sf.page) ?? [];
				for (const s of list) {
					if (this.selection.ids.has(s.id)) g.moveOrig.set(s.id, s.pts.slice());
				}
				g.moveStart = pdf;
			} else {
				g.lassoStart = pdf;
				this.selection = null;
			}
		}
		this.active = g;
		try {
			// 鼠标才需要显式捕获（笔/触摸有隐式捕获）；捕获保证指针滑出 canvas 后 move/up 仍到达
			if (e.pointerType === 'mouse') sf.committed.setPointerCapture(e.pointerId);
		} catch {
			/* 忽略 */
		}
	}

	private finishGesture(commit: boolean): void {
		const g = this.active;
		if (!g) return;
		this.active = null;
		document.body.removeClass('fleur-pdf-ink-stroking');
		const sf = g.surface;

		if (g.tool.mode === 'scroll') {
			// 正常抬手（commit）且有速度 → 起惯性 fling；cancel / 没动过不起。
			// 阈值 0.08 px/ms ≈ 80px/s：低于它视作「停住再松手」，不该滑出去。
			if (commit && g.scrollEl && g.moved && g.scrollVel) {
				const v = g.scrollVel;
				if (Math.abs(v.x) > 0.08 || Math.abs(v.y) > 0.08) {
					this.startMomentum(v.x, v.y, g.scrollEl);
				}
			}
			return; // 滚动无数据变更，无需收尾
		}

		if (g.tool.mode === 'pen' && g.stroke) {
			const stroke = g.stroke;
			if (commit && stroke.pts.length >= 3) {
				// marker 的实时预览画在 draft，提交时一次性合成进 committed（单 path 单次描边，
				// 交叉处不会叠加变深）；pen 已经增量画进 committed，无需再画。
				if (stroke.kind === 'marker') {
					this.clearDraft(sf);
					this.paintStroke(sf.cctx, sf, stroke);
				}
				this.pushUndo(g.snapshot);
				const list = this.pages.get(sf.page);
				if (list) list.push(stroke);
				else this.pages.set(sf.page, [stroke]);
				this.emitChange();
			} else if (stroke.kind === 'marker') {
				this.clearDraft(sf);
			}
			return;
		}

		if (g.tool.mode === 'eraser') {
			this.clearDraft(sf);
			if (commit && g.eraseChanged) {
				this.pushUndo(g.snapshot);
				this.emitChange();
			} else if (g.eraseChanged) {
				// 未提交的擦除（cancel）：回滚
				this.restore(g.snapshot);
			}
			return;
		}

		if (g.tool.mode === 'lasso') {
			this.clearDraft(sf);
			if (g.moveOrig) {
				// 拖动结束：位置已在 previewMove 里写进数据
				if (commit && g.moved) {
					this.pushUndo(g.snapshot);
					this.emitChange();
				} else {
					this.restore(g.snapshot);
				}
				return;
			}
			if (commit && g.lassoStart && g.lastRaw) {
				this.selectInRect(sf.page, g.lassoStart, g.lastRaw);
				this.drawSelection(sf);
			}
			return;
		}
	}

	/** 把进行中的笔强制提交（落盘 / 关闭视图前调用，保证最后一笔不丢）。 */
	flushActiveStroke(): void {
		if (this.cancelTimer !== null) {
			window.clearTimeout(this.cancelTimer);
			this.cancelTimer = null;
		}
		if (this.active) this.finishGesture(true);
	}

	/* ------------------------------ 绘制 ------------------------------ */

	/** 把一个 pointermove（含 coalesced 中间点）接进当前笔画。 */
	private appendDrawEvent(e: PointerEvent): void {
		const g = this.active;
		if (!g?.stroke || !g.strokeWidths) return;
		const sf = g.surface;
		const events =
			typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : ([] as PointerEvent[]);
		const list = events.length ? events : [e];
		for (const ev of list) {
			this.appendDrawPoint(g, ev.clientX, ev.clientY, ev.pressure, ev.pointerType);
		}
	}

	private appendDrawPoint(
		g: ActiveGesture,
		clientX: number,
		clientY: number,
		rawPressure: number,
		pointerType: string,
	): void {
		const stroke = g.stroke!;
		const sf = g.surface;
		const css = this.clientToCss(sf, clientX, clientY);
		const pdf = this.cssToPdf(sf, css.x, css.y);
		if (!pdf) return;

		const n = stroke.pts.length / 3;
		// 防重复点：与上一点几乎重合就丢弃（数字笔偶尔会连发同位置事件）
		const lastX = stroke.pts[(n - 1) * 3];
		const lastY = stroke.pts[(n - 1) * 3 + 1];
		const vp = this.viewportFor(sf.page);
		if (vp?.scale) {
			const dCss = Math.hypot((pdf.x - lastX) * vp.scale, (pdf.y - lastY) * vp.scale);
			if (dCss < 0.35) return;
		}

		// 因果 EMA：只动新点，已画部分永不移动（增量渲染不重算的前提）
		const alpha = POSITION_ALPHA;
		let pressure = pointerType === 'pen' ? clamp01(rawPressure || 0.5) : 0.75;
		const lastP = stroke.pts[(n - 1) * 3 + 2] ?? 0.5;
		pressure = lastP + (pressure - lastP) * PRESSURE_ALPHA;
		const x = lastX + (pdf.x - lastX) * alpha;
		const y = lastY + (pdf.y - lastY) * alpha;
		stroke.pts.push(x, y, pressure);

		// 宽度数组补上新点
		const widths = strokePointWidths(stroke);
		g.strokeWidths = widths;

		if (stroke.kind === 'marker') {
			// 荧光笔：整条路径单次描边（交叉处不叠加变深），每次重画在 draft 上预览
			this.previewMarker(sf, stroke);
		} else {
			// 钢笔：只画新增线段（增量），长笔画不重算
			this.renderLiveIncrement(g);
		}
	}

	/** 把笔画从 renderedCount 起的新增线段画进 committed 层。 */
	private renderLiveIncrement(g: ActiveGesture): void {
		const stroke = g.stroke!;
		const sf = g.surface;
		const widths = g.strokeWidths!;
		const n = stroke.pts.length / 3;
		const from = g.renderedCount ?? 1;
		if (n === from) return;
		const ctx = sf.cctx;
		const vp = this.viewportFor(sf.page);
		if (!vp) return;
		const scale = vp.scale;
		ctx.save();
		ctx.strokeStyle = stroke.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		for (let i = Math.max(1, from); i < n; i++) {
			const a = this.pdfToCss(sf, stroke.pts[(i - 1) * 3], stroke.pts[(i - 1) * 3 + 1]);
			const b = this.pdfToCss(sf, stroke.pts[i * 3], stroke.pts[i * 3 + 1]);
			if (!a || !b) continue;
			ctx.lineWidth = Math.max(0.5, ((widths[i - 1] + widths[i]) / 2) * scale);
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}
		if (from === 1 && n === 1) {
			// 只有一个点：画墨点
			const p0 = this.pdfToCss(sf, stroke.pts[0], stroke.pts[1]);
			if (p0) {
				ctx.fillStyle = stroke.color;
				ctx.beginPath();
				ctx.arc(p0.x, p0.y, Math.max(0.5, (widths[0] * scale) / 2), 0, Math.PI * 2);
				ctx.fill();
			}
		}
		ctx.restore();
		g.renderedCount = n;
	}

	/** 荧光笔预览：draft 层清空重画整条路径。 */
	private previewMarker(sf: Surface, stroke: InkStroke): void {
		const ctx = sf.dctx;
		ctx.clearRect(0, 0, sf.cssW, sf.cssH);
		this.paintMarkerPath(ctx, sf, stroke);
	}

	/** 荧光笔的单 path 描边（draft 预览与提交共用，保证零 snap）。 */
	private paintMarkerPath(ctx: CanvasRenderingContext2D, sf: Surface, stroke: InkStroke): void {
		const vp = this.viewportFor(sf.page);
		if (!vp) return;
		const n = stroke.pts.length / 3;
		if (n < 1) return;
		ctx.save();
		ctx.globalAlpha = stroke.opacity;
		ctx.strokeStyle = stroke.color;
		ctx.lineWidth = Math.max(1, stroke.width * vp.scale);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		const p0 = this.pdfToCss(sf, stroke.pts[0], stroke.pts[1]);
		if (!p0) return;
		if (n === 1) {
			ctx.beginPath();
			ctx.arc(p0.x, p0.y, ctx.lineWidth / 2, 0, Math.PI * 2);
			ctx.fillStyle = stroke.color;
			ctx.fill();
		} else {
			ctx.beginPath();
			ctx.moveTo(p0.x, p0.y);
			// 中点二次贝塞尔：过每个采样点的中点，控制点取原采样点
			for (let i = 1; i < n - 1; i++) {
				const c = this.pdfToCss(sf, stroke.pts[i * 3], stroke.pts[i * 3 + 1])!;
				const nx = this.pdfToCss(sf, stroke.pts[(i + 1) * 3], stroke.pts[(i + 1) * 3 + 1])!;
				ctx.quadraticCurveTo(c.x, c.y, (c.x + nx.x) / 2, (c.y + nx.y) / 2);
			}
			const last = this.pdfToCss(sf, stroke.pts[(n - 1) * 3], stroke.pts[(n - 1) * 3 + 1])!;
			ctx.lineTo(last.x, last.y);
			ctx.stroke();
		}
		ctx.restore();
	}

	/* ------------------------------ 擦除 ------------------------------ */

	private eraseAt(sf: Surface, cx: number, cy: number, radius: number): boolean {
		const list = this.pages.get(sf.page);
		if (!list?.length) return false;
		const before = list.length;
		const kept = list.filter((s) => !strokeHitsCircle(s, cx, cy, radius));
		if (kept.length === before) return false;
		if (kept.length) this.pages.set(sf.page, kept);
		else this.pages.delete(sf.page);
		this.requestPaint(sf.page);
		return true;
	}

	private drawEraserCursor(sf: Surface, cssX: number, cssY: number): void {
		const vp = this.viewportFor(sf.page);
		if (!vp) return;
		const tool = this.active?.tool;
		const r = (tool?.mode === 'eraser' ? tool.radius : 12) * vp.scale;
		const ctx = sf.dctx;
		ctx.clearRect(0, 0, sf.cssW, sf.cssH);
		ctx.save();
		ctx.strokeStyle = 'rgba(127,127,127,0.9)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(cssX, cssY, r, 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();
	}

	/* ------------------------------ 套索 ------------------------------ */

	private pointInSelection(p: { x: number; y: number }): boolean {
		const sel = this.selection!;
		const r = sel.rect;
		const pad = 6 / (this.viewportFor(sel.page)?.scale || 1);
		return (
			p.x >= r.x0 - pad && p.x <= r.x1 + pad && p.y >= r.y0 - pad && p.y <= r.y1 + pad
		);
	}

	private drawLassoRect(sf: Surface, a: { x: number; y: number }, b: { x: number; y: number }): void {
		const pa = this.pdfToCss(sf, a.x, a.y);
		const pb = this.pdfToCss(sf, b.x, b.y);
		if (!pa || !pb) return;
		const ctx = sf.dctx;
		ctx.clearRect(0, 0, sf.cssW, sf.cssH);
		ctx.save();
		ctx.strokeStyle = 'rgba(80,140,255,0.95)';
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(
			Math.min(pa.x, pb.x),
			Math.min(pa.y, pb.y),
			Math.abs(pb.x - pa.x),
			Math.abs(pb.y - pa.y),
		);
		ctx.restore();
	}

	private drawSelection(sf: Surface): void {
		const ctx = sf.dctx;
		ctx.clearRect(0, 0, sf.cssW, sf.cssH);
		if (!this.selection || this.selection.page !== sf.page) return;
		const a = this.pdfToCss(sf, this.selection.rect.x0, this.selection.rect.y0);
		const b = this.pdfToCss(sf, this.selection.rect.x1, this.selection.rect.y1);
		if (!a || !b) return;
		ctx.save();
		ctx.strokeStyle = 'rgba(80,140,255,0.95)';
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(
			Math.min(a.x, b.x),
			Math.min(a.y, b.y),
			Math.abs(b.x - a.x),
			Math.abs(b.y - a.y),
		);
		ctx.restore();
	}

	private selectInRect(page: number, a: { x: number; y: number }, b: { x: number; y: number }): void {
		const list = this.pages.get(page);
		if (!list?.length) return;
		const x0 = Math.min(a.x, b.x);
		const x1 = Math.max(a.x, b.x);
		const y0 = Math.min(a.y, b.y);
		const y1 = Math.max(a.y, b.y);
		const ids = new Set<string>();
		for (const s of list) {
			const n = s.pts.length / 3;
			for (let i = 0; i < n; i++) {
				const x = s.pts[i * 3];
				const y = s.pts[i * 3 + 1];
				if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
					ids.add(s.id);
					break;
				}
			}
		}
		if (!ids.size) return;
		this.selection = { page, ids, rect: { x0, y0, x1, y1 } };
	}

	private previewMove(g: ActiveGesture, pdf: { x: number; y: number }): void {
		if (!g.moveOrig || !g.moveStart || !this.selection || !g.moveRectOrig) return;
		const dx = pdf.x - g.moveStart.x;
		const dy = pdf.y - g.moveStart.y;
		g.moved = true;
		const list = this.pages.get(g.surface.page);
		if (!list) return;
		for (const s of list) {
			const orig = g.moveOrig.get(s.id);
			if (!orig) continue;
			for (let i = 0; i < orig.length; i += 3) {
				s.pts[i] = orig[i] + dx;
				s.pts[i + 1] = orig[i + 1] + dy;
			}
		}
		// 选区框跟随平移（从原始框 + 位移重算，拖动过程可往返不漂移）
		const r = g.moveRectOrig;
		this.selection.rect = { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
		this.requestPaint(g.surface.page);
		this.drawSelection(g.surface);
	}

	/* ============================ 渲染 ============================ */

	private requestPaint(page: number): void {
		this.paintPending.add(page);
		if (this.paintScheduled) return;
		this.paintScheduled = true;
		window.requestAnimationFrame(() => {
			this.paintScheduled = false;
			for (const n of this.paintPending) {
				const sf = this.surfaces.get(n);
				if (sf) this.paintPage(sf);
			}
			this.paintPending.clear();
		});
	}

	private requestPaintAll(): void {
		for (const n of this.surfaces.keys()) this.requestPaint(n);
	}

	private paintPage(sf: Surface): void {
		const ctx = sf.cctx;
		ctx.clearRect(0, 0, sf.cssW, sf.cssH);
		this.clearDraft(sf);
		const vp = this.viewportFor(sf.page);
		if (!vp) return; // 页未渲染：画不了，reconcile 会在渲染后补
		const list = this.pages.get(sf.page);
		if (!list) return;
		for (const s of list) this.paintStroke(ctx, sf, s);
		// 选区框画在 draft 层，而 paintPage 每次都清 draft —— 套索拖动中每次
		// requestPaint 重绘都会把框抹掉。这里补画一次，拖动全程框不消失。
		if (this.selection?.page === sf.page) this.drawSelection(sf);
	}

	private paintStroke(ctx: CanvasRenderingContext2D, sf: Surface, s: InkStroke): void {
		if (s.kind === 'marker') {
			this.paintMarkerPath(ctx, sf, s);
			return;
		}
		const vp = this.viewportFor(sf.page);
		if (!vp) return;
		const scale = vp.scale;
		const widths = strokePointWidths(s);
		const n = s.pts.length / 3;
		ctx.save();
		ctx.strokeStyle = s.color;
		ctx.fillStyle = s.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		if (n === 1) {
			const p = this.pdfToCss(sf, s.pts[0], s.pts[1]);
			if (p) {
				ctx.beginPath();
				ctx.arc(p.x, p.y, Math.max(0.5, (widths[0] * scale) / 2), 0, Math.PI * 2);
				ctx.fill();
			}
		} else {
			for (let i = 1; i < n; i++) {
				const a = this.pdfToCss(sf, s.pts[(i - 1) * 3], s.pts[(i - 1) * 3 + 1]);
				const b = this.pdfToCss(sf, s.pts[i * 3], s.pts[i * 3 + 1]);
				if (!a || !b) continue;
				ctx.lineWidth = Math.max(0.5, ((widths[i - 1] + widths[i]) / 2) * scale);
				ctx.beginPath();
				ctx.moveTo(a.x, a.y);
				ctx.lineTo(b.x, b.y);
				ctx.stroke();
			}
		}
		ctx.restore();
	}

	private clearDraft(sf: Surface): void {
		sf.dctx.clearRect(0, 0, sf.cssW, sf.cssH);
	}

	/* ------------------------------ 杂项 ------------------------------ */

	/** 供诊断：surface 数量 / 工具 / 选区状态。 */
	get debugInfo(): Record<string, unknown> {
		return {
			surfaces: this.surfaces.size,
			strokes: Array.from(this.pages.values()).reduce((a, l) => a + l.length, 0),
			tool: this.tool.mode,
			selection: !!this.selection,
			palmThreshold: PALM_SIZE_THRESHOLD,
		};
	}
}
