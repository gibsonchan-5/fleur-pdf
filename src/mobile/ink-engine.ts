// pdf.js 视图接入层（0.6.0 起只负责「找到并读取」，不再碰编辑器）。
//
// ⚠️ **0.6.0 架构切换说明，改动前务必读完。**
//
// 0.4.x ~ 0.5.x 的笔迹走 pdf.js 的 AnnotationEditor（InkEditor）：本文件曾经
// 承载了 setMode / applyPen / serialize / 播种 UIManager 等一整套编辑器操作，
// 以及五个实测踩出来的深坑（UIManager 拿不到、serialize 对固有编辑器恒返回
// null、hasElementChanged 不比笔画……详见 git 历史与 0.5.x 版本）。
//
// 真机六轮修复仍无法根治的四个症状（掉笔迹 / 擦不掉 / 断触 / 不顺滑），根因
// 全部落在「笔迹活在编辑器表里」这一层：pdf.js 在移动端虚拟化页面，page DOM
// 销毁重建时编辑器随之消失；输入采样与平滑由 pdf.js 内部决定，我们插不了手。
//
// 0.6.0 起笔迹由覆盖层自绘引擎接管（见 ink/overlay-engine.ts），本文件收缩为
// 两件事：
//   ① 找到 pdf.js 的 PDFViewer / PDFDocumentProxy（三层懒加载包装的解析仍在此处，
//      版本耦合收口在 resolve() 一个函数里）；
//   ② 直读 PDF 里既有的固有 /Ink 注释（0.4.x 写回的老笔迹），走
//      page.getAnnotations() —— 与注释层是否渲染无关，任何时机都能全量拿到。

import { App, TFile, loadPdfJs } from 'obsidian';
import { inkAnnotationToStrokes, type InkStroke } from './ink/strokes';

/* ---------------------------------------------------------------------------
 * 类型
 * ------------------------------------------------------------------------- */

/** 引擎所需的全部引用。任一环缺失都视为引擎不可用（调用方应静默降级）。 */
export interface InkHandle {
	/** 真 pdf.js PDFViewer（不是 Obsidian 的包装对象）。 */
	viewer: any;
	/** pdf.js 的 PDFDocumentProxy。 */
	pdfDocument: any;
	/** Obsidian 的 PDFView（仅用于取文件路径）。 */
	view: any;
	/** 当前打开 PDF 的 vault 路径（可能为空）。 */
	filePath: string;
}

/** 笔的种类。钢笔 / 荧光笔 / 橡皮 / 套索（橡皮与套索无笔参数）。 */
export type PenKind = 'pen' | 'marker' | 'eraser' | 'lasso';

export interface PenSpec {
	kind: PenKind;
	/** 十六进制颜色，如 '#d32f2f'。橡皮忽略此字段。 */
	color: string;
	/** 线宽（PDF 用户空间单位）。 */
	thickness: number;
	/** 不透明度 0~1。 */
	opacity: number;
}

/* ---------------------------------------------------------------------------
 * 引用解析
 * ------------------------------------------------------------------------- */

/**
 * 从 Obsidian 的 PDF 视图上解析出真 pdf.js PDFViewer。
 *
 * 现行 Obsidian（2026-03 app.js 实挖，ground truth）是**三层懒加载包装**：
 *   view.viewer              懒加载壳（只有 .child / .then()）
 *   view.viewer.child        控制器，加载完成后才存在
 *   view.viewer.child.pdfViewer          createObsidianPDFViewer 的 App 对象
 *   view.viewer.child.pdfViewer.pdfViewer  真 pdf.js PDFViewer ← 要拿的
 *
 * 旧版结构（.viewer.pdfViewer 两层）保留为次级候选 —— Obsidian 内部结构随版本
 * 演进过多次，单点取值会在某个版本上静默失败。
 */
function pickPdfViewer(view: any): any {
	return (
		view?.viewer?.child?.pdfViewer?.pdfViewer ??
		view?.viewer?.pdfViewer?.pdfViewer ??
		view?.viewer?.pdfViewer ??
		view?.pdfViewer ??
		view?._pdfViewer ??
		null
	);
}

/** 取 PDFDocumentProxy（多候选回退）。 */
function pickPdfDocument(view: any, viewer: any): any {
	return (
		view?.viewer?.child?.pdfViewer?.pdfDocument ??
		viewer?.pdfDocument ??
		view?.viewer?.pdfViewer?.pdfDocument ??
		view?.viewer?.pdfDocument ??
		view?.pdfViewer?.pdfDocument ??
		view?._pdfViewer?.pdfDocument ??
		view?._pdf ??
		viewer?._pdfDocument ??
		null
	);
}

/* ---------------------------------------------------------------------------
 * 引擎
 * ------------------------------------------------------------------------- */

export class InkEngine {
	private handle: InkHandle | null = null;
	private readonly disposers: Array<() => void> = [];
	/** 上一次 resolve() 失败的原因码（成功后清空）。 */
	private lastResolveError: string | null = null;
	/** 上一次 resolve() 的结构探测结果（诊断用）。 */
	private lastResolveDebug: Record<string, unknown> = {};

	constructor(private app: App) {}

	/** 上一次 resolve() 失败的原因码；null 表示上次解析成功（或尚未解析）。 */
	get resolveError(): string | null {
		return this.lastResolveError;
	}

	/** 上一次 resolve() 的结构探测结果（视图类型 / 各引用是否找到等）。 */
	get resolveDebug(): Record<string, unknown> {
		return this.lastResolveDebug;
	}

	/* ------------------------------ 生命周期 ------------------------------ */

	/**
	 * 解析引擎引用。每次打开/切换 PDF 后都要调用（可反复调用，内部幂等）。
	 *
	 * 返回 null 表示当前环境不支持 —— 调用方应静默降级，不要弹错。
	 * 这是 R5（Obsidian 升级改内部结构）的缓解措施：把版本耦合收在这一个函数里。
	 */
	async resolve(): Promise<InkHandle | null> {
		const dbg: Record<string, unknown> = {};
		this.lastResolveDebug = dbg;
		this.lastResolveError = null;

		// 活动视图只有在「真的能解析出完整 PDF 引用」时才直接采用。
		// 不能用 getActiveViewOfType(Object) 的返回值兜底判定：它对任何类型的视图都返回
		// （所有视图都 instanceof Object），焦点在批注侧边栏 / 大纲等非 PDF 面板上时，
		// 会拿一个解析不出 pdfViewer 的视图然后在这里失败 —— 而此时 PDF 明明开着。
		const active: any = this.app.workspace.getActiveViewOfType?.(Object as any) ?? null;
		const activeViewer = active ? pickPdfViewer(active) : null;
		const activeDoc = activeViewer ? pickPdfDocument(active, activeViewer) : null;
		const view: any = activeViewer && activeDoc ? active : this.findPdfView();
		dbg.activeViewType = active?.getViewType?.() ?? active?.constructor?.name ?? null;
		dbg.usedActiveView = !!activeViewer && !!activeDoc;
		dbg.viewType = view?.getViewType?.() ?? view?.constructor?.name ?? null;
		if (!view) {
			this.lastResolveError = 'no-pdf-view';
			return null;
		}

		const viewer = pickPdfViewer(view);
		dbg.viewerFound = !!viewer;
		if (!viewer || typeof viewer !== 'object') {
			this.lastResolveError = 'pdfviewer-not-found';
			return null;
		}

		const pdfDocument = pickPdfDocument(view, viewer);
		dbg.docFound = !!pdfDocument;
		if (!pdfDocument || typeof pdfDocument.getPage !== 'function') {
			this.lastResolveError = 'pdfdocument-not-found';
			return null;
		}

		const filePath = String(view?.file?.path ?? '');
		dbg.filePath = filePath;

		this.detachHandle();
		this.handle = { viewer, pdfDocument, view, filePath };
		return this.handle;
	}

	/** 在当前工作区里找 PDF 视图（活动文件匹配优先，其次主工作区里可见的叶子）。 */
	private findPdfView(): any {
		const leaves = this.app.workspace.getLeavesOfType('pdf');
		if (!leaves.length) return null;
		const active = this.app.workspace.getActiveFile();
		// 排序键：活动文件匹配（0）> 在主工作区可见（rootSplit，0）> 其余。
		// 焦点常落在侧边栏（批注列表 / 搜索），此时 getActiveFile() 为空，
		// 「主工作区优先」能避免选中折叠在后台的另一个 PDF。
		const rank = (leaf: any): number => {
			const fileMatch = leaf?.view?.file?.path === active?.path ? 0 : 1;
			let inMain = 1;
			try {
				inMain = leaf?.getRoot?.() === 'rootSplit' ? 0 : 1;
			} catch {
				/* 老版本 API 缺 getRoot 时按原样处理 */
			}
			return fileMatch * 2 + inMain;
		};
		const sorted = [...leaves].sort((a: any, b: any) => rank(a) - rank(b));
		return sorted[0]?.view ?? null;
	}

	/** 释放对上一个 PDF 视图的持有（不改变其状态）。 */
	private detachHandle(): void {
		while (this.disposers.length) {
			const fn = this.disposers.pop();
			try {
				fn?.();
			} catch {
				/* 忽略 */
			}
		}
		this.handle = null;
	}

	dispose(): void {
		this.detachHandle();
	}

	/* ------------------------------ 查询 ------------------------------ */

	get isReady(): boolean {
		return !!this.handle;
	}

	get pdfFilePath(): string {
		return this.handle?.filePath ?? '';
	}

	/** 页面 DOM 元素（坐标换算用）。 */
	getPageElement(pageNumber: number): HTMLElement | null {
		const root: HTMLElement | undefined = this.handle?.viewer?.viewer;
		if (!root) return null;
		return root.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
	}

	/** 当前缩放比（从 .pdfViewer 的 --scale-factor 读，与 pdf.js 内部一致）。 */
	getScaleFactor(): number {
		const root: HTMLElement | undefined = this.handle?.viewer?.viewer;
		if (!root) return 1;
		const raw = getComputedStyle(root).getPropertyValue('--scale-factor');
		const n = Number.parseFloat(raw);
		return Number.isFinite(n) && n > 0 ? n : 1;
	}

	/** 该 PDF 对应的 vault 文件。 */
	getFile(): TFile | null {
		const p = this.handle?.filePath;
		if (!p) return null;
		const f = this.app.vault.getAbstractFileByPath(p);
		return f instanceof TFile ? f : null;
	}

	/** pdf.js 的 PDFDocumentProxy（迁移 / 注释直读用）。 */
	get pdfDocument(): any {
		return this.handle?.pdfDocument ?? null;
	}

	/**
	 * 直读该 PDF 全部固有 /Ink 注释（0.4.x 写回的老笔迹），转成自有笔迹模型。
	 *
	 * ⚠️ 刻意走 `page.getAnnotations()` 而不是注释层 DOM / getEditableAnnotations：
	 * 注释层按视口懒渲染，时机不可控（0.4.x 六轮修复反复栽在这里）；
	 * getAnnotations 是纯数据接口，任何时机对任何页都能全量拿到。
	 *
	 * @param skip 已接管过的注释 id（claimedIds），跳过防「擦掉又复活」。
	 * @param onProgress 进度回调（page, total），大文档逐页取数有耗时。
	 */
	async readInherentInk(
		skip: Set<string>,
		onProgress?: (page: number, total: number) => void,
	): Promise<{ strokes: InkStroke[]; ids: string[] }> {
		const doc = this.pdfDocument;
		const out: InkStroke[] = [];
		const ids: string[] = [];
		if (!doc || typeof doc.getPage !== 'function' || typeof doc.numPages !== 'number') {
			return { strokes: out, ids };
		}
		for (let n = 1; n <= doc.numPages; n++) {
			onProgress?.(n, doc.numPages);
			try {
				const page = await doc.getPage(n);
				const annotations = await page.getAnnotations({ intent: 'display' });
				for (const a of annotations ?? []) {
					if (a?.subtype !== 'Ink' || !a?.id || skip.has(String(a.id))) continue;
					const converted = inkAnnotationToStrokes(a, n);
					if (converted.length) {
						out.push(...converted);
						ids.push(String(a.id));
					}
				}
			} catch {
				// 单页失败跳过：注释层下次进入会重试（claimedIds 不记它）
			}
		}
		return { strokes: out, ids };
	}

	/** 某页的页面视口框（PDF 用户空间 [x0, y0, x1, y1]，v1 迁移用）。 */
	async getPageViewBox(pageNumber: number): Promise<number[] | null> {
		const doc = this.pdfDocument;
		if (!doc?.getPage) return null;
		try {
			const page = await doc.getPage(pageNumber);
			const view = page?.view;
			return Array.isArray(view) && view.length === 4 ? view.map(Number) : null;
		} catch {
			return null;
		}
	}
}
