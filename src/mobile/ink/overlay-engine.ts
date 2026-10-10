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
import {
	addStrokeGap,
	hasGapBefore,
	mintStrokeId,
	subpathStartAt,
	type InkStroke,
	type InkStrokeKind,
} from './strokes';
import {
	angleBetweenDeg,
	classifyGraceMerge,
	DEFAULT_GRACE_TUNING,
	normalizeTuning,
	pathLengthPx,
	terminalMotion,
	type GraceMergeAction,
	type GraceMergeTuning,
} from './grace-merge';

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */

/**
 * 断触宽限期：pointercancel 后保留笔画多久，期间笔重新落下就续写。
 * 1200ms：安卓掌压抑制（小米/三星平板实测）从 cancel 到笔事件恢复的黑窗
 * 经常超过 400ms——旧值下笔迹被强制提交、用户还在写就断成两截（断触主诉）。
 * 宽限期内不提交数据，对用户不可见；配合 REBIND_NEAR_PX 近端判定防误并笔。
 */
const CANCEL_GRACE_MS = 1200;

/**
 * 断触续写的「近端」判定（CSS px）：cancel 后笔重新落下时，新落点距笔画
 * 最后一个原始采样点不超过 max(此值, 笔宽×4) 才接回原笔续写；远端就把旧笔
 * 提交、新落点开新笔。不设判定的话，宽限内在别处落笔会把两笔连成一条横线。
 * ⚠️ 距离必须对原始采样点算、不能对 EMA 平滑点算——EMA 滞后会虚增几像素，
 * 把真续写误判成远端（探针实测 10px 间隙被算成 14.4px 贴着阈值漏过）。
 */
const REBIND_NEAR_PX = 16;

/**
 * 「直行穿隙」判据（grace-merge ④）回看多久来估这一笔的方向（ms）。
 *
 * 不能用 ① 那个 60ms 窗口：真机实测一笔的接触时长中位数 ~350ms、弦长只有 6~44px，
 * 60ms 内的位移常常不到 3px，方向完全被采样抖动支配（同一批数据里 60ms 与 120ms
 * 窗口能差出 90°）。140ms 是「够长到压住抖动」与「够短到不跨进上一笔」的折中，
 * 也是 recentRaw 缓冲（24 点 ≈ 真机 8ms 采样节奏下的 190ms）能稳定支撑的长度。
 */
const COLLINEAR_DIR_SPAN_MS = 140;

/**
 * 幽灵抬笔归并窗口（ms）与近端距离（CSS px）的**默认值**见
 * grace-merge.ts 的 DEFAULT_GRACE_TUNING（150ms / 96px），可被设置项覆盖。
 *
 * 这两个数值的来源（公开仓库不留测试机的具体型号；安卓平板 + Android 16，
 * 真机诊断共 10,769 条事件）：
 * 连续书写中笔固件会瞬时上报 up + 悬停 move + down，up→down 实测 24-71ms，
 * 人类不可能在这个时间里完成提笔-落笔；用户有意的笔画间提笔全部 ≥384ms，
 * 分布双峰干净分离，所以阈值本身不需要动。
 *
 * ⚠️ 1.7.6 的「连笔」顽疾不在阈值上，在**归并后画什么**：旧实现把悬停轨迹整段
 * 丢弃，再用一根 lineTo 把最后一个墨点和最远 96px 外的新落点直连 —— 笔速越快、
 * 固件抖在两笔交界处，这根全宽圆头的直线就越像用户写了个牵丝。现在归并只负责
 * 「算同一条笔画」的语义，那段墨由证据决定该不该画（bridge 画真实轨迹 / gap
 * 只分组不落墨 / commit 拆两条），判定规则与探针见 grace-merge.ts。
 */

/**
 * 掌先落、笔后到的判定窗口：滚动被笔接管时，若手势存活短于此值，
 * 回滚滚动位移（掌压拖走的位移不作数）。存活的滚动更可能是正常指滑。
 */
const SCROLL_REVERT_MS = 300;

/** 笔离开感应范围后，拒掌窗口收缩到的时长（ms）。 */
const PEN_OUT_WINDOW_MS = 250;

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

/**
 * 笔迹层渲染倍率（设置项 `inkRenderScale`）→ DPR 上限。
 *
 * 栅格化与合成的代价随 DPR 平方增长：2.75 DPR 的平板上一页 777×1164 的页，
 * committed + draft 两层位图合计约 55MB；把上限压到 2 就少一半像素。真机诊断
 * （frame-jank 记录）显示卡顿出在绘制侧时，这一档是最直接、也最可逆的旋钮：
 * 只改 canvas 物理分辨率，笔迹数据/坐标/命中测试全在 PDF 用户空间，永不受影响，
 * 任何时候改回 auto 即恢复原生锐度。
 */
export type InkRenderScale = 'auto' | 'balanced' | 'fast';
const RENDER_SCALE_DPR: Record<InkRenderScale, number> = { auto: MAX_DPR, balanced: 2, fast: 1.5 };

/* ---------------------------------------------------------------------------
 * 类型
 * ------------------------------------------------------------------------- */

/** 局部截图的矩形（PDF 用户空间）。 */
export interface SnapRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** 工具状态。pen/marker 二合一（kind 区分），橡皮带半径（PDF 用户空间单位）。 */
export type InkTool =
	| { mode: 'pen'; color: string; width: number; opacity: number; kind: InkStrokeKind }
	| { mode: 'eraser'; radius: number }
	| { mode: 'lasso' }
	// 局部截图：拖矩形 → 抬手回调 onSnap（不产生任何笔迹数据）
	| { mode: 'snap' }
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
	/**
	 * 接触期最后若干个采样点（CSS px + 时刻）。归并判定要的「抬笔前末端速度」和
	 * 「末端方向」只能从**接触中**的点算 —— 悬停点算进去会把伪抬笔误判成连续。
	 */
	recentRaw?: Array<{ x: number; y: number; at: number }>;
	/** 归并窗口：抬笔时刻（performance.now()，判定时算 dtMs 用）。 */
	upAt?: number;
	/** 归并窗口：窗口内收到的悬停轨迹（CSS px 作证据 + PDF 坐标备桥接落墨）。 */
	graceHover?: Array<{ x: number; y: number; at: number; px: number; py: number }>;
	/** 归并窗口：窗口内是否收到过 pointerout（笔确实抬出了感应区）。 */
	leftProximity?: boolean;
	/** 这条笔画已吸收的归并次数（封顶用，防级联成一条串起一整行）。 */
	mergeCount?: number;
	// erase
	eraseChanged?: boolean;
	// lasso
	lassoStart?: { x: number; y: number };
	// snap（局部截图拖框）
	snapStart?: { x: number; y: number };
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
	/** rAF 合帧：尚未应用的累积位移（CSS px）。 */
	scrollDx?: number;
	scrollDy?: number;
	/** rAF 合帧应用位移的句柄（null = 没有排中的应用帧）。 */
	scrollRaf?: number | null;
	/** 手势开始时的滚动位置与时刻（「掌先落、笔后到」回滚位移用）。 */
	scrollStartTop?: number;
	scrollStartLeft?: number;
	scrollStartAt?: number;
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
 * ⚠️ 断点（gaps）之后是新子路径，起笔 taper 与宽度 EMA 都从新子路径的头算起 ——
 * 否则一段桥接墨会以「中段宽度」突然接管，接头上看得到一节粗细跳变。
 * 无断点时 subpathStartAt 恒为 0，逐字节等于旧实现。
 */
export function strokePointWidths(s: InkStroke): number[] {
	const n = s.pts.length / 3;
	const out: number[] = [];
	let prev = 0;
	for (let i = 0; i < n; i++) {
		const start = subpathStartAt(s, i);
		const rel = i - start;
		const p = clamp01(s.pts[i * 3 + 2] ?? 0.5);
		let raw = s.width * (0.4 + 0.8 * p);
		// 起笔 taper：每个子路径头三个点渐入，避免「一顿墨点」
		if (rel < 3 && n - start > 3) raw *= 0.6 + 0.4 * (rel / 2);
		const w = rel === 0 ? raw : 0.55 * raw + 0.45 * prev;
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

/**
 * 橡皮圆是否碰到这条笔画（逐线段 + 半笔宽余量）。
 *
 * ⚠️ 断点（gap）那一段**没有墨**，不能算命中 —— 否则擦掉一条看不见的路径，
 * 整条笔画还会莫名其妙消失。gap 两侧的子路径各自照旧可擦。
 * 无断点时判定路径与旧实现等价（可见段一个不少、一个不多）。
 */
function strokeHitsCircle(s: InkStroke, cx: number, cy: number, r: number): boolean {
	const rr = (r + s.width / 2) * (r + s.width / 2);
	const n = s.pts.length / 3;
	if (n === 1) {
		const dx = s.pts[0] - cx;
		const dy = s.pts[1] - cy;
		return dx * dx + dy * dy <= rr;
	}
	// 孤立墨点测试（子路径只有一个点时它没有任何相邻可见段）
	const dotHit = (i: number): boolean => {
		const dx = s.pts[i * 3] - cx;
		const dy = s.pts[i * 3 + 1] - cy;
		return dx * dx + dy * dy <= rr;
	};
	if (hasGapBefore(s, 1) && dotHit(0)) return true;
	for (let i = 1; i < n; i++) {
		if (!hasGapBefore(s, i)) {
			if (
				distPointToSegmentSq(
					cx, cy,
					s.pts[(i - 1) * 3], s.pts[(i - 1) * 3 + 1],
					s.pts[i * 3], s.pts[i * 3 + 1],
				) <= rr
			) return true;
			continue;
		}
		// 段 (i-1)→i 无墨：点 i 只有在右侧也没有可见段时才需要单独测一次
		const rightVisible = i + 1 < n && !hasGapBefore(s, i + 1);
		if (!rightVisible && dotHit(i)) return true;
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
	/** 宽限来源：true=幽灵抬笔（up 后的归并窗口，近端阈值更宽），false=pointercancel。 */
	private graceFromUp = false;
	/**
	 * 归并判定调参（默认值来自 grace-merge.ts，设置页可覆盖）。
	 * 只作用于 pointerup（幽灵抬笔）通道；pointercancel 通道维持 1.7.6 的
	 * 「近端连线续写」不动 —— 那条通道是误触修复的一部分，不碰。
	 */
	private grace: GraceMergeTuning = { ...DEFAULT_GRACE_TUNING };
	/** 笔迹层 DPR 上限（设置项 inkRenderScale 映射而来，见 setRenderScale）。 */
	private dprCap = MAX_DPR;
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
	/**
	 * 书写进行中对齐请求的「欠账」标记：手势中不拆/挂覆盖层（见 scheduleReconcile），
	 * 手势一结束就补跑一次，保证笔迹与 DOM 最终一致。
	 */
	private reconcileDeferred = false;

	/** 荧光笔预览的合帧状态（见 scheduleMarkerPreview）。 */
	private markerPreview: { sf: Surface; stroke: InkStroke } | null = null;
	private markerPreviewRaf: number | null = null;

	/** 数据变化回调（InkUI 用它排自动落盘）。 */
	private changeListeners = new Set<() => void>();

	/** 截图回调（InkUI 用它打开结果面板；参数为 PDF 用户空间矩形 + 页码）。 */
	private snapListeners = new Set<(page: number, rect: SnapRect) => void>();

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
		document.addEventListener('pointerout', this.onPointerOut, { capture: true });

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
		this.cancelMarkerPreview();
		// 指滑手势进行中强撤：不提交也不回滚（用户已滚到的位置保持原样），
		// 但要解除 will-change 提示、取消排中的应用帧，避免残留
		if (this.active?.tool.mode === 'scroll') {
			const g = this.active;
			if (g.scrollRaf) {
				window.cancelAnimationFrame(g.scrollRaf);
				g.scrollRaf = null;
			}
			if (g.scrollEl) {
				try {
					g.scrollEl.setCssStyles?.({ willChange: 'auto' });
				} catch {
					/* 忽略 */
				}
			}
		}
		// 手势进行中强撤：不提交（正常路径 InkUI 会先 flushActiveStroke）
		this.active = null;
		document.removeEventListener('pointerdown', this.onPointerDown, { capture: true } as any);
		document.removeEventListener('pointermove', this.onPointerMove, { capture: true } as any);
		document.removeEventListener('pointerup', this.onPointerUp, { capture: true } as any);
		document.removeEventListener('pointercancel', this.onPointerCancel, { capture: true } as any);
		document.removeEventListener('touchmove', this.onTouchMoveGuard, { capture: true } as any);
		document.removeEventListener('pointerout', this.onPointerOut, { capture: true } as any);
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

	/** 订阅截图事件（PDF 用户空间矩形）。返回解绑函数。 */
	onSnap(cb: (page: number, rect: SnapRect) => void): () => void {
		this.snapListeners.add(cb);
		return () => this.snapListeners.delete(cb);
	}

	private emitSnap(page: number, rect: SnapRect): void {
		for (const cb of this.snapListeners) {
			try {
				cb(page, rect);
			} catch {
				/* 单个监听者坏掉不影响其余 */
			}
		}
	}

	/** pdf.js PDFViewer 引用（截图渲染 / 文本层提取需要）。 */
	getPdfViewer(): any {
		return this.viewer;
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

	/**
	 * 会话中途收编对端新增的笔迹（跨设备同步合并用）。
	 * 与 loadStrokes 的差别：不清撤销栈、按 id 去重、只增不改 —— 本会话的
	 * 撤销历史保持有效。
	 */
	addStrokes(strokes: InkStroke[]): void {
		const touched = new Set<number>();
		for (const s of strokes) {
			if (!s || typeof s.page !== 'number' || s.page < 1) continue;
			let list = this.pages.get(s.page);
			if (!list) {
				list = [];
				this.pages.set(s.page, list);
			}
			if (list.some((x) => x.id === s.id)) continue;
			list.push(s);
			touched.add(s.page);
		}
		// 只重绘真正变过的页：requestPaintAll 会把每个已挂载 surface 的整页笔画
		// 重画一遍，同步回来的往往只有一两页，代价却按页数×笔画数算
		for (const page of touched) this.requestPaint(page);
	}

	/** 会话中途移除若干笔迹（对端删除经墓碑传过来的情形；按 id 匹配）。 */
	removeStrokes(ids: ReadonlySet<string>): void {
		if (!ids.size) return;
		for (const [page, list] of this.pages) {
			const kept = list.filter((s) => !ids.has(s.id));
			if (kept.length === list.length) continue;
			this.pages.set(page, kept);
			// 同样只重绘被改到的那一页
			this.requestPaint(page);
		}
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
		// ⚠️ 工具切换**不改任何已提交的墨迹**（颜色/宽度/断点都是每条笔画自带的），
		// 需要清掉的只是 draft 层上的选区框 / 荧光预览 / 橡皮圈。整页重绘（clearRect
		// 全页 + 逐段重画所有笔画）在高 DPR 平板上是一次明显的掉帧，而它画的还是
		// 已经在屏上的东西 —— 真机「点笔盒就卡一下」的来源。改成只清 draft。
		for (const sf of this.surfaces.values()) {
			this.clearDraft(sf);
			if (this.selection?.page === sf.page) this.drawSelection(sf);
		}
	}

	/**
	 * 覆盖归并判定参数（设置页 → InkUI 在进入手写模式时注入）。
	 * 传 null/undefined 的字段保持原值；数值一律经 normalizeTuning 夹到安全区间，
	 * data.json 被手改坏也不会把容错关掉或变成连线机器。
	 */
	setGraceTuning(patch: Partial<GraceMergeTuning> | null | undefined): void {
		this.grace = normalizeTuning(this.grace, patch);
	}

	get graceTuning(): GraceMergeTuning {
		return { ...this.grace };
	}

	/**
	 * 设置笔迹层渲染倍率（见 RENDER_SCALE_DPR）。改动后立刻把已挂的层重设分辨率并重绘，
	 * 所以「设置页改一下就能看到效果」，不需要退出重进手写模式。
	 */
	setRenderScale(scale: InkRenderScale | undefined): void {
		const cap = RENDER_SCALE_DPR[scale ?? 'auto'] ?? MAX_DPR;
		if (cap === this.dprCap) return;
		this.dprCap = cap;
		for (const sf of this.surfaces.values()) this.resizeSurface(sf);
	}

	/* ------------------------------ 撤销 / 重做 ------------------------------ */

	private snapshot(): Map<number, InkStroke[]> {
		const m = new Map<number, InkStroke[]>();
		for (const [page, list] of this.pages) {
			m.set(
				page,
				list.map((s) => {
					const c = { ...s, pts: s.pts.slice() };
					// 断点数组也必须断开引用：撤销后重做的是「同一份数据的不同断点集合」
					if (s.gaps) c.gaps = s.gaps.slice();
					return c;
				}),
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
		// ⚠️ 一次整树查询 + Set 命中，取代「每个被接管的 id 各扫一遍整棵树」。
		// 旧写法在 reconcile 里跑（DOM 一变就 80ms 一次），接管过的固有注释一多，
		// 光查 DOM 就把主线程吃满 —— 表现就是书写时周期性一卡，且笔迹越多越卡。
		try {
			root
				.querySelectorAll<HTMLElement>('[data-annotation-id]')
				.forEach((el) => {
					const id = el.dataset.annotationId;
					if (id && this.hiddenInkIds.has(id)) el.setCssStyles({ display: 'none' });
				});
		} catch {
			/* 查询失败只是少涂一次隐藏，不影响笔迹数据 */
		}
	}

	/* ============================ 页面覆盖层 ============================ */

	private scheduleReconcile(): void {
		if (this.reconcileTimer !== null) return;
		// ⚠️ 落笔进行中不对齐覆盖层。reconcile 命中新页时会 mountSurface：新建两张
		// 整页 canvas（高 DPR 下一张就几十 MB）并整页重绘已有笔画 —— 那正是帧预算
		// 最紧的一刻，真机上表现为「写着写着突然一卡」。手势期间 pdf.js 的 DOM 变动
		// （文本层分段注入 / 页面重建）本来就频繁，改成笔画结束立刻补跑一次：
		// 数据始终在 this.pages 里，覆盖层最迟在一笔之内就跟回来，不丢笔。
		// 只挡**笔迹手势**：指滑滚动期间照常挂层，否则滚到新页要等松手才见到笔迹。
		if (this.active?.stroke) {
			this.reconcileDeferred = true;
			return;
		}
		this.reconcileTimer = window.setTimeout(() => {
			this.reconcileTimer = null;
			this.reconcile();
		}, 80);
	}

	/** 手势收尾后补跑被推迟的对齐（如果有）。 */
	private runDeferredReconcile(): void {
		if (!this.reconcileDeferred) return;
		this.reconcileDeferred = false;
		this.scheduleReconcile();
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
			// ⚠️ 缩放/重渲染时 pdf.js 是对 .page **原地清空子节点**再重画：.page 本体
			// 不动，我们的覆盖层 canvas 被摘走，但 surface 记录还在、el.isConnected
			// 仍为 true —— 只判「surface 是否存在」会漏判，表现为缩放后笔迹消失、
			// 无法落笔（输入目标没了）。必须校验 canvas 还挂在 DOM，不在就拆掉重挂。
			const sf = this.surfaces.get(n);
			if (sf && (!sf.committed.isConnected || !sf.draft.isConnected)) {
				this.unmountSurface(n);
			}
			// 只给已渲染出内容的页挂层（canvasWrapper 存在 = 内容已渲染）
			if (!this.surfaces.has(n) && el.querySelector('.canvasWrapper')) this.mountSurface(n, el);
		}
		for (const n of Array.from(this.surfaces.keys())) {
			const sf = this.surfaces.get(n)!;
			if (!seen.has(n) || !sf.el.isConnected || !sf.committed.isConnected) this.unmountSurface(n);
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
		let dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
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

	/** client 坐标 → 该页 surface 的 CSS 坐标。rect 可传入已取好的包围盒。 */
	private clientToCss(
		sf: Surface,
		clientX: number,
		clientY: number,
		rect?: DOMRect,
	): { x: number; y: number } {
		// ⚠️ rect 必须由调用方保证在本次事件批次内有效：getBoundingClientRect 会强制
		// 同步布局，pdf.js 的文本层动辄上万节点，笔又以 125Hz 上报 —— 逐**合并点**
		// 量一次布局，主线程预算就在指缝里漏光了。同一次 pointermove 的 coalesced
		// 子点共享同一份布局，量一次即可。
		const r = rect ?? sf.el.getBoundingClientRect();
		return { x: clientX - r.left, y: clientY - r.top };
	}

	/** surface CSS 坐标 → PDF 用户空间。vp 可传入已取好的 viewport。 */
	private cssToPdf(
		sf: Surface,
		x: number,
		y: number,
		vp?: any,
	): { x: number; y: number } | null {
		const v = vp ?? this.viewportFor(sf.page);
		if (!v?.convertToPdfPoint) return null;
		const [px, py] = v.convertToPdfPoint(x, y);
		return { x: px, y: py };
	}

	/** PDF 用户空间 → surface CSS 坐标。vp 可传入已取好的 viewport。 */
	private pdfToCss(sf: Surface, x: number, y: number, vp?: any): { x: number; y: number } | null {
		const v = vp ?? this.viewportFor(sf.page);
		if (!v?.convertToViewportPoint) return null;
		const [cx, cy] = v.convertToViewportPoint(x, y);
		return { x: cx, y: cy };
	}

	/* ============================ 输入 ============================ */

	/**
	 * 事件落在哪一页的覆盖层上（只认我们的 canvas，掌压蹭到文本层不认）。
	 *
	 * 便签例外放行：手写模式下便签不再整片 pointer-events:none（那会让桌面端
	 * 鼠标对便签完全失能 —— 输入/拖拽/折叠全不可用），改由这里按指针类型分流：
	 * pen / touch 落到便签上 → 认作其所在页，照常书写 / 滚动（与旧穿透行为一致）；
	 * mouse 明确不放行 → 便签归鼠标操作。真机上没有鼠标落页的场景，行为不变。
	 */
	private surfaceOfEvent(e: Event): Surface | null {
		const t = e.target as Element | null;
		if (!t) return null;
		const onCanvas =
			t instanceof HTMLCanvasElement && t.hasClass('fleur-ink-canvas') && !t.hasClass('is-draft');
		if (!onCanvas) {
			if ((e as PointerEvent).pointerType === 'mouse') return null;
			if (!t.closest?.('.fleur-pdf-note-layer')) return null;
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

		// 已有手势进行中 = 抬笔宽限期内重新落下。**两条通道语义不同，分开处理**：
		//   · pointercancel 通道（掌压黑窗）：维持 1.7.6 的近端连线续写不动。
		//     那条通道是误触修复的一部分，动它就是把「之前发现的误触问题」请回来。
		//   · 幽灵抬笔通道（pointerup）：按物理证据判 bridge / gap / commit，
		//     归并语义与「那段画不画」解耦（见 grace-merge.ts 文件头）。
		if (this.active && this.cancelTimer !== null && this.active.stroke) {
			const g = this.active;
			const stroke = g.stroke!;
			const css = this.clientToCss(g.surface, e.clientX, e.clientY);
			const pdf = this.cssToPdf(g.surface, css.x, css.y);
			const vp = this.viewportFor(g.surface.page);
			// 距离一律对最后一个【原始接触点】算、且用 CSS px（阈值要与用户手感
			// 同尺度，不能随缩放变）—— EMA 点滞后，用它算会虚增几像素把真续判成远端。
			const ref = g.lastRaw ?? { x: stroke.pts[(stroke.pts.length / 3 - 1) * 3], y: stroke.pts[(stroke.pts.length / 3 - 1) * 3 + 1] };
			const scale = vp?.scale ?? 0;
			const jumpPx =
				pdf && scale > 0 ? Math.hypot((pdf.x - ref.x) * scale, (pdf.y - ref.y) * scale) : Infinity;
			// 笔宽下限：宽笔（marker）在 96px 内连线与不连都在墨里，按连续处理
			const nearLimit = Math.max(
				this.graceFromUp ? this.grace.nearPx : REBIND_NEAR_PX,
				stroke.width * scale * 4,
			);
			const jumpX = css.x - (g.recentRaw?.[g.recentRaw.length - 1]?.x ?? css.x);
			const jumpY = css.y - (g.recentRaw?.[g.recentRaw.length - 1]?.y ?? css.y);
			const hover = g.graceHover ?? [];
			const motion = terminalMotion(g.recentRaw ?? []);
			// ④ 的方向证据：同样的点、更长的窗口（见 COLLINEAR_DIR_SPAN_MS 注释）。
			// 缓冲里不足 2 个点或跨度不够时 terminalMotion 返回 -1，判据自然不成立。
			const motionSlow = terminalMotion(g.recentRaw ?? [], COLLINEAR_DIR_SPAN_MS);
			window.clearTimeout(this.cancelTimer);
			this.cancelTimer = null;

			const action: GraceMergeAction = !this.graceFromUp
				? jumpPx <= nearLimit
					? 'bridge'
					: 'commit'
				: classifyGraceMerge(
						{
							dtMs: g.upAt !== undefined ? performance.now() - g.upAt : Infinity,
							jumpPx,
							hoverPathPx: pathLengthPx(hover),
							endSpeed: motion.endSpeed,
							turnDeg: angleBetweenDeg(motion.dirX, motion.dirY, jumpX, jumpY),
							collinearTurnDeg: angleBetweenDeg(motionSlow.dirX, motionSlow.dirY, jumpX, jumpY),
							leftProximity: !!g.leftProximity,
							mergeCount: g.mergeCount ?? 0,
						},
						{ ...this.grace, nearPx: nearLimit },
					);

			if (action === 'commit') {
				// 有意的新笔画：旧笔就地提交，落到下面的 beginGesture 开新笔
				this.finishGesture(true);
			} else {
				// 归并：换绑同一个手势，续写同一条笔画
				g.pointerId = e.pointerId;
				this.penActivityUntil = performance.now() + PEN_TOUCH_REJECTION_MS;
				e.preventDefault();
				e.stopPropagation();
				if (this.graceFromUp) g.mergeCount = (g.mergeCount ?? 0) + 1;
				if (action === 'bridge') {
					if (this.grace.enabled && this.graceFromUp) {
						// 桥接：把窗口内采到的悬停轨迹按真实路径落墨（不是把两端连直的弦），
						// 再把新落点接上。轨迹点是悬停采样，压力取中性值 0.5，宽度与笔画
						// 中段一致，不会拖出零压细线伪影。
						// ⚠️ 只对**幽灵抬笔（pointerup）通道**生效。pointercancel 那条是掌压
						// 黑窗，宽限长达 1200ms，期间悬停轨迹可能绕着纸面划一大圈，而那条
						// 通道的近端阈值只有 16px（连线本来就落在笔宽里）—— 画轨迹是平白
						// 新增风险，所以它维持 1.7.6：丢轨迹，只续一个新落点。
						for (const p of hover) {
							if (!p.px && !p.py) continue;
							this.appendPdfPoint(g, { x: p.px, y: p.py }, { x: p.x, y: p.y }, 0.5, 'pen');
						}
					}
					// 关掉总开关时的桥接 = 1.7.6 原样：悬停轨迹整段丢掉，新落点直接续在上一
					// 个墨点后（那根全宽圆头的弦就是「连笔」本体）。必须保持一致，否则
					// `enabled:false` 不是「退回旧行为」而是「第三种行为」，真机出问题时
					// 这个开关就失去了意义。
					// 两条路都清空速度证据：刚注入的悬停点不是**接触中**的运动，留在
					// recentRaw 里会把下一次判定的末端速度虚高。
					g.recentRaw = [];
				} else {
					// gap：认定很可能是有意提笔，但证据不足以拆成两条 —— 继续同一条笔画，
					// 这一段不落墨。最坏表现等同于「笔断了」，绝不会画一根用户没写过的线。
					addStrokeGap(stroke, stroke.pts.length / 3);
					// 断点之后的第一段是新子路径，宽度 taper 与速度证据都要从头算
					g.recentRaw = [];
				}
				g.graceHover = [];
				g.leftProximity = false;
				g.upAt = undefined;
				this.appendDrawEvent(e);
				return;
			}
		}

		if (!this.active) {
			const sf = this.surfaceOfEvent(e);
			if (!sf) return;
			this.penActivityUntil = performance.now() + PEN_TOUCH_REJECTION_MS;
			this.beginGesture(e, sf);
			return;
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
		// 归并窗口（cancel / 幽灵 up 宽限）内，旧指针的悬停 move **不上墨、只采样**。
		// 1.7.6 在这里直接 return 把轨迹整段丢掉，然后在 onPointerDown 用一根
		// lineTo 把最后一个墨点连到新落点 —— 那根全宽圆头的直线就是「连笔」。
		// 现在留下轨迹：判定拿它算直度证据，判 bridge 时按真实轨迹落墨（笔在飞
		// 的时候本来就该留下这条线），判 gap 时不落墨。
		// 仍然不做 preventDefault / 不改写窗口，误触与滚动的语义保持原样。
		if (this.cancelTimer !== null) {
			this.sampleGraceHover(g, e);
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.penActivityUntil = performance.now() + PEN_TOUCH_REJECTION_MS;

		if (g.tool.mode === 'pen') {
			this.appendDrawEvent(e);
			return;
		}
		if (g.tool.mode === 'scroll') {
			// 手指滚动：位移先累积、rAF 每帧统一应用一次 —— 120Hz 屏上 pointermove
			// 密于 vsync，逐事件写 scrollTop 是主线程逐事件重排，顺滑度明显差于
			// 原生滚动（文本模式的主诉）。合帧后每帧一次写、位移用 coalesced
			// 全量中间采样，跟手不丢点；必须放在坐标转换之前 —— 手指经常滚出
			// 页面边界，cssToPdf 对界外返回 null。
			const events =
				typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : ([] as PointerEvent[]);
			const list = events.length ? events : [e];
			for (const ev of list) {
				g.scrollDx = (g.scrollDx ?? 0) + ev.clientX - (g.scrollLast?.x ?? ev.clientX);
				g.scrollDy = (g.scrollDy ?? 0) + ev.clientY - (g.scrollLast?.y ?? ev.clientY);
				g.scrollLast = { x: ev.clientX, y: ev.clientY };
			}
			g.moved = true;
			this.scheduleScrollApply(g);
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
		} else if (g.tool.mode === 'snap') {
			if (g.snapStart) {
				this.drawSnapRect(sf, g.snapStart, pdf);
				g.moved = true;
				g.lastRaw = pdf;
			}
		}
	};

	/**
	 * 归并窗口内采样悬停轨迹。一次采样 = 一次 getBoundingClientRect + 一次矩阵
	 * 变换（输入性能红线允许的量），不做 DOM 写入、不 preventDefault。
	 *
	 * 同时存 CSS 坐标（判定的距离尺度，与用户手感一致、不随缩放变）和 PDF 坐标
	 * （判 bridge 时按**真实路径**落墨，而不是把两端连成一根弦 —— 那根弦就是连笔）。
	 * 上限 32 点（滚动丢弃最早的）：够覆盖最长的穿隙窗 collinearWindowMs=220ms
	 * （真机悬停采样间隔 p50≈8ms），再多对直度判定没有增量信息。
	 */
	private sampleGraceHover(g: ActiveGesture, e: PointerEvent): void {
		if (!g.stroke) return;
		const css = this.clientToCss(g.surface, e.clientX, e.clientY);
		const arr = g.graceHover ?? (g.graceHover = []);
		const prev = arr[arr.length - 1];
		// 几乎重合的重复样本不记（省内存；直度判定靠离散点，不靠密度）
		if (prev && arr.length > 1 && Math.hypot(css.x - prev.x, css.y - prev.y) < 0.5) return;
		const at = performance.now();
		const pdf = this.cssToPdf(g.surface, css.x, css.y);
		arr.push({ x: css.x, y: css.y, at, px: pdf?.x ?? 0, py: pdf?.y ?? 0 });
		// 32 个采样：窗口最长是 collinearWindowMs（默认 220ms），真机悬停采样间隔 p50=8ms，
		// 24 个只够 190ms —— 会把最长那次穿隙的轨迹截掉，桥接出来的线就短一截。
		if (arr.length > 32) arr.shift();
	}

	private onPointerUp = (e: PointerEvent): void => {
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		// 幽灵抬笔容错（见文件头 DEFAULT_GRACE_TUNING 注释）：up 后不立即提交，进短归并
		// 窗口——期间重新落下由 onPointerDown 按证据判 bridge / gap / commit；
		// 超时才真正提交。擦除/套索/截图/滚动无此问题，照旧即时结束。
		if (g.stroke) {
			this.graceFromUp = true;
			g.upAt = performance.now();
			g.graceHover = [];
			g.leftProximity = false;
			if (this.cancelTimer !== null) window.clearTimeout(this.cancelTimer);
			// 宽限拉到 max(归并窗, 直行穿隙窗)：穿隙判据（grace-merge ④）允许比 windowMs
			// 更长的抬笔间隔，但它 outside windowMs 是判定函数里唯一的例外分支 ——
			// 出归并窗后除「共线短跳」外一律 commit，行为与拉窗之前一致。
			this.cancelTimer = window.setTimeout(() => {
				this.cancelTimer = null;
				this.finishGesture(true);
			}, Math.max(this.grace.windowMs, this.grace.collinearWindowMs));
			return;
		}
		this.finishGesture(true);
	};

	private onPointerCancel = (e: PointerEvent): void => {
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		// ⚠️ 断触容错：不立刻丢笔。S Pen 抬笔瞬间 / 掌压边缘都会发 cancel。
		// 保留笔画进宽限期：期间笔重新落下（onPointerDown）或带压 move 出现
		// 就续写；宽限到点才提交。体验上等于「笔没断」。
		if (g.stroke) {
			this.graceFromUp = false;
			// 宽限状态归零复用（本通道仍走 1.7.6 的近端连线判定，不看这些证据）
			g.upAt = performance.now();
			g.graceHover = [];
			g.leftProximity = false;
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
		const scrollEl = this.findScrollable(sf.el);
		// 合成滚动提示：声明滚动位置即将变化，让 compositor 缓存滚动内容、
		// 程序化 scrollTop 走合成路径 —— 程序化滚动逼近原生顺滑度的关键一步。
		try {
			scrollEl?.setCssStyles?.({ willChange: 'scroll-position' });
		} catch {
			/* 忽略 */
		}
		this.active = {
			pointerId: e.pointerId,
			pointerType: e.pointerType,
			surface: sf,
			tool: { mode: 'scroll' },
			moved: false,
			snapshot: new Map(),
			scrollLast: { x: e.clientX, y: e.clientY },
			scrollEl,
			scrollVel: { x: 0, y: 0 },
			scrollDx: 0,
			scrollDy: 0,
			scrollRaf: null,
			scrollStartTop: scrollEl?.scrollTop ?? 0,
			scrollStartLeft: scrollEl?.scrollLeft ?? 0,
			scrollStartAt: performance.now(),
		};
	}

	/** 排一帧应用累积的滚动位移（每帧最多一次，vsync 对齐）。 */
	private scheduleScrollApply(g: ActiveGesture): void {
		if (g.scrollRaf) return;
		g.scrollRaf = window.requestAnimationFrame(() => {
			g.scrollRaf = null;
			this.applyScrollDelta(g);
		});
	}

	/** 应用累积位移 + 更新帧级速度 EMA（px/ms，供松手惯性用）。 */
	private applyScrollDelta(g: ActiveGesture): void {
		const dx = g.scrollDx ?? 0;
		const dy = g.scrollDy ?? 0;
		if (!dx && !dy) return;
		g.scrollDx = 0;
		g.scrollDy = 0;
		if (g.scrollEl) {
			g.scrollEl.scrollTop -= dy;
			g.scrollEl.scrollLeft -= dx;
		}
		// 帧级速度：整帧位移 / 整帧时间，比逐事件瞬时速度稳。
		// dt 过大（手指停顿 / 被卡顿拉长）的采样不可信，跳过。
		const now = performance.now();
		const dt = g.scrollTime !== undefined ? now - g.scrollTime : 0;
		g.scrollTime = now;
		if (g.scrollVel && dt > 0 && dt < 120) {
			g.scrollVel.x += (-dx / dt - g.scrollVel.x) * 0.35;
			g.scrollVel.y += (-dy / dt - g.scrollVel.y) * 0.35;
		}
	}

	/**
	 * 笔离开感应范围（pointerout）：把拒掌窗口从 1200ms 收缩到 250ms。
	 * 「写完抬笔 → 手指滚动」的场景里，不收缩会有一段滚不动的死区 ——
	 * 这是指滚被误拒的主诉。正常书写时悬停 move 会不断续窗，不受影响；
	 * 设备不发 pointerout 时行为退化为原状（1200ms），安全兜底。
	 */
	private onPointerOut = (e: PointerEvent): void => {
		if (e.pointerType !== 'pen') return;
		// 归并窗口内的 pointerout 是「笔确实抬出了感应区」的证据（有意提笔的典型特征）。
		// ⚠️ 只记录，不改 penActivityUntil —— 下面那句 early return 及拒掌窗口的
		// 收缩规则一字未动，误触修复的语义保持原样。
		if (this.active && this.cancelTimer !== null && this.graceFromUp) {
			this.active.leftProximity = true;
		}
		// 笔势进行中不收缩（断触宽限期依赖窗口语义，别搅局）
		if (this.active && this.active.tool.mode !== 'scroll') return;
		const until = performance.now() + PEN_OUT_WINDOW_MS;
		if (until < this.penActivityUntil) this.penActivityUntil = until;
	};

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
		// 速度证据的起点（terminalMotion 要 ≥2 个采样才算得出末端速度）
		g.recentRaw = [{ x: css.x, y: css.y, at: performance.now() }];
		g.mergeCount = 0;

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
				t: Date.now(),
			};
			g.strokeWidths = strokePointWidths(g.stroke);
			g.renderedCount = 1;
			// 单点也先画出来（点住不动的墨点）
			this.renderLiveIncrement(g);
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
		} else if (tool.mode === 'snap') {
			g.snapStart = pdf;
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
		this.finishGestureInner(commit);
		// 收尾：待画的荧光笔预览作废（draft 已被清或被合成进 committed），
		// 并把书写期间推迟的覆盖层对齐补跑掉。
		this.cancelMarkerPreview();
		this.runDeferredReconcile();
	}

	private finishGestureInner(commit: boolean): void {
		const g = this.active;
		if (!g) return;
		this.active = null;
		const sf = g.surface;

		if (g.tool.mode === 'scroll') {
			// rAF 合帧里可能还有没应用的位移：收尾前 flush 干净，跟手零丢失
			if (g.scrollRaf) {
				window.cancelAnimationFrame(g.scrollRaf);
				g.scrollRaf = null;
			}
			this.applyScrollDelta(g);
			// 解除合成滚动提示（will-change 还原为初始值 auto）
			if (g.scrollEl) {
				try {
					g.scrollEl.setCssStyles?.({ willChange: 'auto' });
				} catch {
					/* 忽略 */
				}
			}
			if (!commit && g.scrollEl && g.scrollStartAt !== undefined) {
				// 「掌先落、笔后到」的典型误触：滚动刚起（<300ms）就被笔接管
				//（笔落下 / 笔悬停让位 / 系统取消都走 commit=false）→ 把掌压拖走
				// 的位移回滚，落笔时页面不跳。存活更久的滚动视为正常指滑，保持现状。
				const age = performance.now() - g.scrollStartAt;
				if (age < SCROLL_REVERT_MS) {
					g.scrollEl.scrollTop = g.scrollStartTop ?? g.scrollEl.scrollTop;
					g.scrollEl.scrollLeft = g.scrollStartLeft ?? g.scrollEl.scrollLeft;
				}
			}
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

		if (g.tool.mode === 'snap') {
			this.clearDraft(sf);
			// 截图不产生笔迹数据：不快照、不入 undo、不发 change
			if (commit && g.moved && g.snapStart && g.lastRaw) {
				const rect: SnapRect = {
					x0: Math.min(g.snapStart.x, g.lastRaw.x),
					y0: Math.min(g.snapStart.y, g.lastRaw.y),
					x1: Math.max(g.snapStart.x, g.lastRaw.x),
					y1: Math.max(g.snapStart.y, g.lastRaw.y),
				};
				// 过小的拖动（误触）不触发
				const vp = this.viewportFor(sf.page);
				const minPdf = vp ? 6 / vp.scale : 4;
				if (rect.x1 - rect.x0 >= minPdf && rect.y1 - rect.y0 >= minPdf) {
					this.emitSnap(sf.page, rect);
				}
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
		// 一次事件 = 一次包围盒 + 一次 viewport：合帧里的每个子点都各量一次的话，
		// 强制同步布局会按采样率（实测 125Hz）放大成主要开销
		const rect = sf.el.getBoundingClientRect();
		const vp = this.viewportFor(sf.page);
		for (const ev of list) {
			this.appendDrawPoint(g, ev.clientX, ev.clientY, ev.pressure, ev.pointerType, rect, vp);
		}
	}

	private appendDrawPoint(
		g: ActiveGesture,
		clientX: number,
		clientY: number,
		rawPressure: number,
		pointerType: string,
		rect?: DOMRect,
		vp?: any,
	): void {
		const css = this.clientToCss(g.surface, clientX, clientY, rect);
		const pdf = this.cssToPdf(g.surface, css.x, css.y, vp);
		if (!pdf) return;
		this.appendPdfPoint(g, pdf, css, rawPressure, pointerType, vp);
	}

	/**
	 * 落墨入口（PDF 坐标版）。桥接悬停轨迹走这里 —— 悬停采样本来就把 PDF 坐标
	 * 存着了，不必再经 client 反算一次（窗口内页面若有任何位移，反算会把轨迹画歪）。
	 */
	private appendPdfPoint(
		g: ActiveGesture,
		pdf: { x: number; y: number },
		css: { x: number; y: number },
		rawPressure: number,
		pointerType: string,
		vpIn?: any,
	): void {
		const stroke = g.stroke!;
		const sf = g.surface;
		g.lastRaw = pdf; // 断触续写的近端判定基准（原始点，非 EMA 点）

		// 速度证据：每一个**到达**的点都记时间戳，包含下面被去重丢掉的 ——
		// 「抬笔前是否已停住」这件事只能从位移上判，停住的笔必须在采样流里
		// 留下「没动」的痕迹，terminalMotion 才读得出低末端速度。
		const raw = g.recentRaw ?? (g.recentRaw = []);
		raw.push({ x: css.x, y: css.y, at: performance.now() });
		// 24 点：既要喂 60ms 的速度证据（①），也要喂 COLLINEAR_DIR_SPAN_MS 的方向证据（④）。
		// 真机 move 间隔 p50=8ms 时 24 点 ≈ 190ms，两条都够；旧值 16 点只到 128ms。
		if (raw.length > 24) raw.shift();

		const n = stroke.pts.length / 3;
		// 防重复点：与上一点几乎重合就丢弃（数字笔偶尔会连发同位置事件）
		const lastX = stroke.pts[(n - 1) * 3];
		const lastY = stroke.pts[(n - 1) * 3 + 1];
		const vp = vpIn ?? this.viewportFor(sf.page);
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
			this.scheduleMarkerPreview(sf, stroke);
		} else {
			// 钢笔：只画新增线段（增量），长笔画不重算
			this.renderLiveIncrement(g, vp);
		}
	}

	/** 画一个墨点（子路径只有一个点、或断点端头的补点）。 */
	private paintDot(
		ctx: CanvasRenderingContext2D,
		sf: Surface,
		s: InkStroke,
		widths: number[],
		i: number,
		scale: number,
		vp?: any,
	): void {
		const p = this.pdfToCss(sf, s.pts[i * 3], s.pts[i * 3 + 1], vp);
		if (!p) return;
		ctx.fillStyle = s.color;
		ctx.beginPath();
		ctx.arc(p.x, p.y, Math.max(0.5, ((widths[i] ?? s.width) * scale) / 2), 0, Math.PI * 2);
		ctx.fill();
	}

	/**
	 * 断点处的补墨：gap 段不画线，但断点两侧都是真实落笔、笔尖在那里停过，
	 * 必须留下墨 —— 否则「点一下就什么都不显示」。
	 *
	 * 规则只与 gaps 和下标有关、与当前点数无关，实时增量与全量重绘才画得出
	 * 同一个结果。补的墨正好落在可见段端头的圆头里（起笔 taper 让头一点比
	 * 相邻段更细），不会凸出笔形。
	 */
	private paintGapDots(
		ctx: CanvasRenderingContext2D,
		sf: Surface,
		s: InkStroke,
		widths: number[],
		i: number,
		scale: number,
		vp?: any,
	): void {
		if (!hasGapBefore(s, i)) return;
		this.paintDot(ctx, sf, s, widths, i, scale, vp);
		if (i === 1) this.paintDot(ctx, sf, s, widths, 0, scale, vp);
	}

	/** 把笔画从 renderedCount 起的新增线段画进 committed 层。 */
	private renderLiveIncrement(g: ActiveGesture, vpIn?: any): void {
		const stroke = g.stroke!;
		const sf = g.surface;
		const widths = g.strokeWidths!;
		const n = stroke.pts.length / 3;
		const from = g.renderedCount ?? 1;
		if (n === from) return;
		const ctx = sf.cctx;
		const vp = vpIn ?? this.viewportFor(sf.page);
		if (!vp) return;
		const scale = vp.scale;
		ctx.save();
		ctx.strokeStyle = stroke.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		for (let i = Math.max(1, from); i < n; i++) {
			// 断点段不落墨（gap = 归并但不连线），与 paintStroke 用同一条规则
			if (hasGapBefore(stroke, i)) {
				this.paintGapDots(ctx, sf, stroke, widths, i, scale, vp);
				continue;
			}
			const a = this.pdfToCss(sf, stroke.pts[(i - 1) * 3], stroke.pts[(i - 1) * 3 + 1], vp);
			const b = this.pdfToCss(sf, stroke.pts[i * 3], stroke.pts[i * 3 + 1], vp);
			if (!a || !b) continue;
			ctx.lineWidth = Math.max(0.5, ((widths[i - 1] + widths[i]) / 2) * scale);
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}
		if (from === 1 && n === 1) {
			// 只有一个点：画墨点
			const p0 = this.pdfToCss(sf, stroke.pts[0], stroke.pts[1], vp);
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

	/**
	 * 荧光笔预览合帧。
	 *
	 * ⚠️ 预览是「清空 draft 整层 + 重画**整条**路径」，代价按 已有点数 × 每帧 增长：
	 * 笔的采样率（实测 125Hz）远高于屏幕刷新率，逐点重画等于把同一条路径在一帧里
	 * 画三五遍，还把 draft 层（高 DPR 下整页几十 MB）每点清一次 —— 主线程只是发
	 * 指令所以指针流看不出来，但栅格化排队会让墨明显拖在笔尖后面（真机「写长横线
	 * 越写越卡」）。合帧后每帧最多一次，画的仍是同一个函数产出的同一条路径，
	 * 落墨内容与提交结果逐字节不变。
	 */
	private scheduleMarkerPreview(sf: Surface, stroke: InkStroke): void {
		this.markerPreview = { sf, stroke };
		if (this.markerPreviewRaf !== null) return;
		this.markerPreviewRaf = window.requestAnimationFrame(() => {
			this.markerPreviewRaf = null;
			const pending = this.markerPreview;
			this.markerPreview = null;
			// 手势已换/已结束（stroke 不再是当前笔）就别再画：否则会往已提交的 draft
			// 层上补一层预览残影。
			if (pending && this.active?.stroke === pending.stroke) {
				this.previewMarker(pending.sf, pending.stroke);
			}
		});
	}

	private cancelMarkerPreview(): void {
		this.markerPreview = null;
		if (this.markerPreviewRaf !== null) {
			window.cancelAnimationFrame(this.markerPreviewRaf);
			this.markerPreviewRaf = null;
		}
	}

	/** 荧光笔预览：draft 层清空重画整条路径。 */
	private previewMarker(sf: Surface, stroke: InkStroke): void {
		const ctx = sf.dctx;
		ctx.clearRect(0, 0, sf.cssW, sf.cssH);
		this.paintMarkerPath(ctx, sf, stroke);
	}

	/**
	 * 荧光笔的单 path 描边（draft 预览与提交共用，保证零 snap）。
	 *
	 * ⚠️ 断点（gap）把一条笔画切成若干**子路径**，每个子路径各自 beginPath→stroke：
	 * 段间不落墨，才不会在归并处拖出一条荧光带。无断点时只跑一个子路径，
	 * 与旧实现逐点一致。
	 */
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
		ctx.fillStyle = stroke.color;
		// 逐个可见子路径：起点 = 上一个断点，终点 = 下一个断点前一点
		for (let start = 0; start < n; start++) {
			if (start > 0 && !hasGapBefore(stroke, start)) continue;
			let end = start;
			while (end + 1 < n && !hasGapBefore(stroke, end + 1)) end += 1;
			const p0 = this.pdfToCss(sf, stroke.pts[start * 3], stroke.pts[start * 3 + 1]);
			if (!p0) continue;
			if (end === start) {
				// 孤子路径只有一个点：画墨点
				ctx.beginPath();
				ctx.arc(p0.x, p0.y, ctx.lineWidth / 2, 0, Math.PI * 2);
				ctx.fill();
				continue;
			}
			ctx.beginPath();
			ctx.moveTo(p0.x, p0.y);
			// 中点二次贝塞尔：过每个采样点的中点，控制点取原采样点
			for (let i = start + 1; i < end; i++) {
				const c = this.pdfToCss(sf, stroke.pts[i * 3], stroke.pts[i * 3 + 1])!;
				const nx = this.pdfToCss(sf, stroke.pts[(i + 1) * 3], stroke.pts[(i + 1) * 3 + 1])!;
				ctx.quadraticCurveTo(c.x, c.y, (c.x + nx.x) / 2, (c.y + nx.y) / 2);
			}
			const last = this.pdfToCss(sf, stroke.pts[end * 3], stroke.pts[end * 3 + 1])!;
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

	/** 截图拖框预览（比套索框多一层浅色蒙层，示意「框内即所得」）。 */
	private drawSnapRect(sf: Surface, a: { x: number; y: number }, b: { x: number; y: number }): void {
		const pa = this.pdfToCss(sf, a.x, a.y);
		const pb = this.pdfToCss(sf, b.x, b.y);
		if (!pa || !pb) return;
		const ctx = sf.dctx;
		ctx.clearRect(0, 0, sf.cssW, sf.cssH);
		const x = Math.min(pa.x, pb.x);
		const y = Math.min(pa.y, pb.y);
		const w = Math.abs(pb.x - pa.x);
		const h = Math.abs(pb.y - pa.y);
		ctx.save();
		// 框外蒙层（四条边带）
		ctx.fillStyle = 'rgba(0,0,0,0.18)';
		ctx.fillRect(0, 0, sf.cssW, y);
		ctx.fillRect(0, y + h, sf.cssW, sf.cssH - y - h);
		ctx.fillRect(0, y, x, h);
		ctx.fillRect(x + w, y, sf.cssW - x - w, h);
		// 框线
		ctx.strokeStyle = 'rgba(80,140,255,0.95)';
		ctx.lineWidth = 1.5;
		ctx.setLineDash([]);
		ctx.strokeRect(x, y, w, h);
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
		const now = Date.now();
		for (const s of list) {
			const orig = g.moveOrig.get(s.id);
			if (!orig) continue;
			for (let i = 0; i < orig.length; i += 3) {
				s.pts[i] = orig[i] + dx;
				s.pts[i + 1] = orig[i + 1] + dy;
			}
			// 移动视为一次修改：刷新笔迹时刻，同步合并时以此对抗更早的删除墓碑
			s.t = now;
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
		for (const s of list) this.paintStroke(ctx, sf, s, vp);
		// 选区框画在 draft 层，而 paintPage 每次都清 draft —— 套索拖动中每次
		// requestPaint 重绘都会把框抹掉。这里补画一次，拖动全程框不消失。
		if (this.selection?.page === sf.page) this.drawSelection(sf);
	}

	private paintStroke(
		ctx: CanvasRenderingContext2D,
		sf: Surface,
		s: InkStroke,
		vpIn?: any,
	): void {
		if (s.kind === 'marker') {
			this.paintMarkerPath(ctx, sf, s);
			return;
		}
		const vp = vpIn ?? this.viewportFor(sf.page);
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
			const p = this.pdfToCss(sf, s.pts[0], s.pts[1], vp);
			if (p) {
				ctx.beginPath();
				ctx.arc(p.x, p.y, Math.max(0.5, (widths[0] * scale) / 2), 0, Math.PI * 2);
				ctx.fill();
			}
		} else {
			for (let i = 1; i < n; i++) {
				// 与 renderLiveIncrement 同规则：断点段不落墨，重绘与实时增量结果一致
				if (hasGapBefore(s, i)) {
					this.paintGapDots(ctx, sf, s, widths, i, scale, vp);
					continue;
				}
				const a = this.pdfToCss(sf, s.pts[(i - 1) * 3], s.pts[(i - 1) * 3 + 1], vp);
				const b = this.pdfToCss(sf, s.pts[i * 3], s.pts[i * 3 + 1], vp);
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
		// canvasMpx = 所有覆盖层（committed+draft 两层）合计的位图像素数（百万）。
		// 这是栅格化/合成代价的直接刻度：一页 @2.75 DPR 约 6.5M px ≈ 26MB，
		// 挂十几页就把 GPU 纹理预算吃光，表现正是「笔照常来、画面跟不上」。
		let mpx = 0;
		const surfacePages: number[] = [];
		for (const sf of this.surfaces.values()) {
			mpx += sf.cssW * sf.cssH * sf.dpr * sf.dpr * 2;
			surfacePages.push(sf.page);
		}
		surfacePages.sort((a, b) => a - b);
		if (surfacePages.length > 24) surfacePages.length = 24;
		const pen = this.tool.mode === 'pen' ? this.tool : null;
		return {
			surfaces: this.surfaces.size,
			canvasMpx: Math.round(mpx / 1e5) / 10,
			surfacePages,
			strokes: Array.from(this.pages.values()).reduce((a, l) => a + l.length, 0),
			tool: this.tool.mode,
			penKind: pen?.kind,
			penWidth: pen?.width,
			opacity: pen?.opacity,
			selection: !!this.selection,
			palmThreshold: PALM_SIZE_THRESHOLD,
		};
	}
}
