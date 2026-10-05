// 手写批注的 UI 层：悬浮切换器 + 笔盒 + 落盘调度。
//
// ⚠️ **0.6.0 架构切换说明。** 输入接管 / 橡皮 / 套索 / 手势盾 / 触摸路由全部
// 移入覆盖层引擎（ink/overlay-engine.ts）—— 那一层的复杂度曾在这里堆了上千行，
// 且全部建立在「笔迹活在 pdf.js 编辑器表里」这个前提上，正是真机四个顽疾的根源。
// 现在本文件只做三件事：
//   ① 悬浮切换器与笔盒（视觉与交互，沿袭 0.5 的三态胶囊 + 显隐设置）；
//   ② 进入 / 退出手写模式时把覆盖层引擎挂上 / 摘下，并恢复历史笔迹；
//   ③ 落盘调度（空闲防抖 + 退出落盘 + 切文件兜底 + 切后台抢存）。
//
// 拿不到 UIManager 就「笔色/橡皮/撤销全废」的旧限制随编辑器架构一起消失 ——
// 现在不依赖 pdf.js 的任何编辑器接口。

import { Notice, setIcon } from 'obsidian';
import type FleurPDFPlugin from '../main';
import type { InkEngine, PenSpec } from './ink-engine';
import { InkOverlayEngine, type InkTool } from './ink/overlay-engine';
import { v1EntryToStroke, type InkStroke } from './ink/strokes';
import { InkStore } from './ink-store';
import { openSnapResult } from './snap-result';

/**
 * 首版四笔。钢笔与荧光笔同走墨迹通道；荧光笔的半透明感来自 opacity 0.45
 * （0.3.0 从 0.4 上调：真机反馈颜色太淡）。
 */
export const DEFAULT_PENS: PenSpec[] = [
	{ kind: 'pen', color: '#1f1f1f', thickness: 3, opacity: 1 },
	{ kind: 'marker', color: '#f2c200', thickness: 14, opacity: 0.45 },
	{ kind: 'eraser', color: '', thickness: 16, opacity: 1 },
	{ kind: 'lasso', color: '', thickness: 12, opacity: 1 },
];

/** 钢笔可选色（沿用 fleur-pdf 已有的标注配色基调：深金 / 深蓝 / 深红）。 */
const PEN_COLORS = ['#1f1f1f', '#D4A017', '#2979C4', '#D32F2F', '#2E7D32'];
/** 荧光笔可选色（0.3.0 起整体加深一档，浅色正文上立得住）。 */
const MARKER_COLORS = ['#f2c200', '#5fc93f', '#2f9fe0', '#ee5f86', '#a06edb'];

/**
 * 笔触大小滑块的取值范围 [min, max, step]（PDF 用户空间单位）。
 * 0.3.0 起由固定档位改为连续滑块；滑块步长对钢笔取 0.5，其余取 1。
 */
const SIZE_RANGE: Record<PenSpec['kind'], [number, number, number]> = {
	pen: [1, 12, 0.5],
	marker: [6, 40, 1],
	eraser: [6, 48, 1],
	lasso: [1, 1, 1],
};

/**
 * 停笔后多久静默落盘一次。
 * 落盘对象是插件自己的 JSON（不触碰 PDF），写盘很轻 —— 1.5s 内用户几乎不可能
 * 完成「落笔 → 关闭文件」。
 */
const AUTO_SAVE_IDLE_MS = 1500;

/** 擦除模式的展示名（pixel 沿袭旧设置值，行为等同笔画擦除）。 */
const ERASE_MODE_LABEL: Record<EraseMode, string> = {
	pixel: '笔画擦除',
	stroke: '笔画擦除',
	select: '选区擦除',
};

/** 橡皮弹层里实际展示的模式（pixel 已并入笔画擦除，不再单独展示）。 */
const ERASE_MODES: EraseMode[] = ['stroke', 'select'];

/** 笔的种类 → 图标 / 无障碍名（lucide 图标名，Obsidian setIcon 消费）。 */
const PEN_ICON: Record<PenSpec['kind'], string> = {
	pen: 'pen-tool',
	marker: 'highlighter',
	eraser: 'eraser',
	lasso: 'lasso-select',
};
const PEN_LABEL: Record<PenSpec['kind'], string> = {
	pen: '钢笔',
	marker: '荧光笔',
	eraser: '橡皮',
	lasso: '套索',
};

type EraseMode = 'pixel' | 'stroke' | 'select';

export class InkUI {
	private toggleBtn: HTMLElement | null = null;
	/** 双态切换器的两段：编辑 / 手写。 */
	private editSeg: HTMLElement | null = null;
	private inkSeg: HTMLElement | null = null;
	/** 第三段：批注列表（打开文本批注侧边栏）。 */
	private sideSeg: HTMLElement | null = null;
	private penBar: HTMLElement | null = null;

	/** 是否处于手写模式。 */
	private active = false;
	/** 当前选中的笔序号（对应 DEFAULT_PENS）。 */
	private penIndex = 0;
	/** 每支笔的当前参数（颜色/粗细按笔独立记忆，持久化到插件设置）。 */
	private readonly pens: PenSpec[];
	/** 当前擦除模式（仅橡皮笔生效，持久化）。 */
	private eraserMode: EraseMode;
	/** 覆盖层自绘引擎 —— 笔迹的唯一处理者（输入 / 渲染 / 擦除 / 套索 / 撤销）。 */
	private readonly overlay: InkOverlayEngine;
	/** 笔迹的 sidecar 存储 —— 真相源（见 ink-store.ts 的架构说明）。 */
	private readonly inkStore: InkStore;
	/** 上次落盘的内容指纹（JSON 字符串），用于判断「是否真有新内容要存」。 */
	private lastSavedJson = '';
	/** 内存快照归属（视图销毁后 salvageSnapshot 用）。 */
	private lastFile: import('obsidian').TFile | null = null;
	private lastStrokes: InkStroke[] | null = null;
	/**
	 * 已接管过的固有注释 id 全集（只增不减），随每次落盘写回 sidecar。
	 * ⚠️ 每次 save 都必须带上：落盘是整份覆盖，漏传等于清空认领名单，
	 * 用户擦掉的笔迹会在下次进入时从 PDF 原件里复活。
	 */
	private claimedIds = new Set<string>();

	/** 局部截图模式（相机按钮）：开启后引擎工具切到 snap，完成后自动退出。 */
	private snapMode = false;
	/**
	 * 本端删除墓碑（笔迹 id → 删除时刻 ms），随每次落盘写回 sidecar。
	 * 跨设备同步开启时用于「删过就别复活」；撤销恢复 / 重加同 id 笔迹时撤销墓碑。
	 */
	private deleted: Record<string, number> = {};
	/** 空闲自动落盘的防抖计时器（见 autoSave）。 */
	private autoSaveTimer: number | null = null;
	/** 落盘互斥：避免自动落盘与显式保存叠加。 */
	private saving = false;
	/** 本会话是否已提示过保存失败（自动保存的失败多为视图切换途中的一次性错误，避免刷屏）。 */
	private saveErrorNotified = false;

	constructor(
		private plugin: FleurPDFPlugin,
		private engine: InkEngine,
	) {
		this.inkStore = new InkStore(plugin.app);
		this.overlay = new InkOverlayEngine(plugin.app);
		this.pens = InkUI.loadPens(plugin);
		this.eraserMode = plugin.settings.inkEraserMode ?? 'stroke';
	}

	/**
	 * 供真机诊断（InkDebugRecorder.setProbe）：掉帧那一刻「覆盖层里有多少东西要画」。
	 * 判定卡顿属于「输入没来」还是「画不过来」全靠这份瞬时状态：surface 张数与位图
	 * 像素总量决定栅格化/合成代价，笔画数决定一次重绘的路径长度，savePending 说明
	 * 当时是否正压在落盘/合并上。纯读取，不产生任何副作用。
	 */
	get debugInfo(): Record<string, unknown> {
		if (!this.active) return { active: false };
		try {
			return { active: true, pen: this.penIndex, snapMode: this.snapMode, savePending: this.autoSaveTimer !== null, ...this.overlay.debugInfo };
		} catch {
			return { active: true, probeError: true };
		}
	}

	/* ============================ 设置持久化 ============================ */

	/** 从插件设置恢复笔参数。结构变化时回落默认值，保证旧数据不会让笔盒坏掉。 */
	private static loadPens(plugin: FleurPDFPlugin): PenSpec[] {
		const saved = plugin.settings.inkPens;
		if (
			Array.isArray(saved) &&
			saved.length === DEFAULT_PENS.length &&
			saved.every((p, i) => p && p.kind === DEFAULT_PENS[i].kind)
		) {
			return saved.map((p, i) => ({
				kind: p.kind,
				color: String(p.color ?? ''),
				thickness: Number(p.thickness) || DEFAULT_PENS[i].thickness,
				opacity: Number.isFinite(Number(p.opacity)) ? Number(p.opacity) : 1,
			}));
		}
		return DEFAULT_PENS.map((p) => ({ ...p }));
	}

	/** 把笔参数与橡皮配置写回插件设置（每次改动后调用，静默失败不影响使用）。 */
	private persist(): void {
		this.plugin.settings.inkPens = this.pens.map((p) => ({ ...p }));
		this.plugin.settings.inkEraserMode = this.eraserMode;
		void this.plugin.saveSettings().catch(() => {
			/* 写盘失败仅影响下次会话的记忆，不打断当前使用 */
		});
	}

	/* ============================ 挂载 / 卸载 ============================ */

	/** 挂载指引每次插件会话只提示一次（InkUI 可能因开关切换被多次 mount/unmount）。 */
	private static mountHintShown = false;

	mount(): void {
		if (this.toggleBtn) return;

		// 显式三态切换器（常驻胶囊，右下角）：编辑 / 手写 / 批注列表。
		const sw = document.body.createDiv('fleur-pdf-ink-toggle');

		const editBtn = sw.createDiv('fleur-pdf-ink-switch-btn');
		setIcon(editBtn, 'type');
		editBtn.setAttribute('aria-label', '编辑模式');
		editBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.active) void this.exitInk();
		});

		const inkBtn = sw.createDiv('fleur-pdf-ink-switch-btn');
		setIcon(inkBtn, 'pen-tool');
		inkBtn.setAttribute('aria-label', '手写批注');
		inkBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			// 再点一次即退出：即便用户在设置里关掉了「编辑」段，也仍有路走出写模式。
			if (this.active) void this.exitInk();
			else void this.enterInk();
		});

		const sideBtn = sw.createDiv('fleur-pdf-ink-switch-btn');
		setIcon(sideBtn, 'list');
		sideBtn.setAttribute('aria-label', '批注列表');
		sideBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.activateSidebar();
		});

		this.editSeg = editBtn;
		this.inkSeg = inkBtn;
		this.sideSeg = sideBtn;
		this.toggleBtn = sw;
		this.syncSwitcher();
		this.syncSwitcherVisibility();

		// 位置恢复（上次拖到哪就回到哪）+ 拖动换位 + 长按收起
		this.applySwitcherPos();
		sw.toggleClass('is-collapsed', this.plugin.settings.inkSwitcherCollapsed === true);
		this.attachSwitcherDrag(sw);
		// 文本模式下的自动贴边（见 setAutoDocked 注释）：点别处即让路，选字时快速让路
		document.addEventListener('pointerdown', this.onDockPointerDown, true);
		document.addEventListener('selectionchange', this.onDockSelectionChange);
		this.syncAutoDock();

		document.body.addEventListener('click', this.onBodyClick, true);

		// ── 离开当前 PDF 前的兜底落盘（见 autoSave）──
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', (file) => {
				void this.flushBeforeLeave(file?.path ?? null);
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('layout-change', () => {
				const path = this.plugin.app.workspace.getActiveFile()?.path ?? null;
				void this.flushBeforeLeave(path);
			}),
		);

		// ── 切后台 / 页面卸载前的兜底落盘 ──
		// 「写完直接杀掉 App」在移动端是高频操作，visibilitychange → hidden 是
		// 最后一班可靠的车；pagehide 再兜一层（部分 WebView 只派发它）。
		this.onHiddenFlush = () => {
			if (this.active) void this.autoSave(true);
		};
		document.addEventListener('visibilitychange', this.onHiddenFlush);
		window.addEventListener('pagehide', this.onHiddenFlush);

		// ── 按当前视图同步悬浮胶囊的显隐 ──
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => this.syncSwitcherVisibility()),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', () => this.syncSwitcherVisibility()),
		);
	}

	unmount(): void {
		document.body.removeEventListener('click', this.onBodyClick, true);
		document.removeEventListener('pointerdown', this.onDockPointerDown, true);
		document.removeEventListener('selectionchange', this.onDockSelectionChange);
		if (this.autoDockTimer !== null) window.clearTimeout(this.autoDockTimer);
		this.autoDockTimer = null;
		this.autoDocked = false;
		document.removeEventListener('visibilitychange', this.onHiddenFlush);
		window.removeEventListener('pagehide', this.onHiddenFlush);
		// 卸载前尽力落盘（异步发起，不阻塞卸载流程）
		if (this.active) void this.exitInk();
		else this.overlay.detach();
		this.cancelAutoSave();
		this.toggleBtn?.remove();
		this.toggleBtn = null;
		this.editSeg = null;
		this.inkSeg = null;
		this.sideSeg = null;
	}

	/** 点空白处收起「颜色/粗细」展开面板（笔盒本身不收起）。 */
	private readonly onBodyClick = (e: MouseEvent): void => {
		const t = e.target as HTMLElement | null;
		if (!t) return;
		if (t.closest('.fleur-pdf-ink-bar')) return;
		this.penBar?.findAll('.fleur-pdf-ink-pop').forEach((el) => el.removeClass('is-open'));
	};

	/** 切后台 / 页面卸载前的兜底落盘（见 mount 里的 visibilitychange 注册）。 */
	private onHiddenFlush: () => void = () => undefined;

	/* ============================ 模式切换 ============================ */

	/**
	 * 把设置里的书写相关参数推给覆盖层引擎（抬笔归并 + 笔迹层渲染倍率）。
	 * 进入手写模式时推一次，设置页每次改动再推一次（改完立刻生效，不用退出重进）。
	 * 数值合法性由引擎侧 normalizeTuning / RENDER_SCALE_DPR 统一兜底，这里只管原样传。
	 */
	applyInkTuning(): void {
		const s = this.plugin.settings;
		this.overlay.setGraceTuning({
			enabled: s.inkGraceMerge !== false,
			windowMs: s.inkGhostWindowMs,
			nearPx: s.inkGhostNearPx,
		});
		this.overlay.setRenderScale(s.inkRenderScale);
	}

	async enterInk(): Promise<void> {
		// 手写模式下选不出文本，文本批注面板留着只会挡住落笔区域
		this.plugin.patcher?.closeFloatingMenu();

		// 每次进入都重新解析：视图可能刚被重建（切换文件、重新打开）
		const handle = await this.engine.resolve();
		if (!handle) {
			const why = this.engine.resolveError ?? 'unknown';
			new Notice(`手写模式不可用（${why}），详情见控制台`);
			console.warn('[FleurPDF Ink] resolve() 失败:', why, this.engine.resolveDebug);
			return;
		}

		// 覆盖层引擎挂上 —— 输入 / 渲染 / 橡皮 / 套索全归它管。
		// 不再需要 pdf.js 的编辑模式与 UIManager：这两层正是旧架构一切顽疾的来源。
		this.overlay.attach(handle.viewer);
		this.applyInkTuning();
		this.overlay.setTool(this.currentTool());
		this.overlay.onChange(() => {
			// 每次数据变化（一笔提交 / 擦除 / 移动 / 撤销）都排一次空闲落盘
			this.scheduleAutoSave();
		});
		this.overlay.onSnap((page, rect) => void this.handleSnap(page, rect));

		this.active = true;
		document.body.addClass('fleur-pdf-ink-active');
		this.syncSwitcher();
		this.buildPenBar();

		// 恢复历史笔迹（含 0.5.x 数据迁移与 0.4.x 固有注释接管），不等它完成也可以写
		void this.loadInkFromStore();
	}

	/**
	 * 恢复历史笔迹 —— 覆盖层架构的读端。
	 *
	 * 三段职责，顺序不能换：
	 *   ① 读 sidecar：v2 直接用；v1（0.5.x 的编辑器快照）现场迁移成自有模型；
	 *   ② 增量接管：把 PDF 里既有的固有 /Ink 注释（0.4.x 写回的老数据）转成
	 *      自有数据。走 page.getAnnotations() 纯数据接口 —— 与注释层渲染时机
	 *      完全无关，这是 0.4.x 六轮修复反复栽跟头的地方，如今彻底绕开。
	 *   ③ 隐藏原件：被接管过的注释仍在 PDF 里（我们不写回、不删它），不藏
	 *      就会与覆盖层叠成双影。页面重建后由引擎的 reconcile 自动补涂。
	 */
	private async loadInkFromStore(): Promise<void> {
		const file = this.engine.getFile();
		if (!file) return;
		// 换文件后基线必须作废：否则新文件的第一笔会拿旧文件的指纹比对，被误判成「没变化」
		this.lastSavedJson = '';
		this.lastFile = file;
		this.lastStrokes = null;

		let strokes: InkStroke[] = [];
		let claimed = new Set<string>();
		let deleted: Record<string, number> = {};

		try {
			const loaded = await this.inkStore.load(file);
			if (loaded?.kind === 'v2') {
				strokes = loaded.strokes;
				for (const id of loaded.claimedIds) claimed.add(id);
				deleted = loaded.deleted;
			} else if (loaded?.kind === 'v1') {
				// v1 迁移：按「页 + 页内序号」的归一化坐标 × 页框 = PDF 用户空间
				for (const id of loaded.legacy.claimedIds ?? []) claimed.add(id);
				for (const e of loaded.legacy.entries) {
					if (e.sourceId) claimed.add(e.sourceId);
				}
				const boxCache = new Map<number, number[] | null>();
				let migrated = 0;
				for (const entry of loaded.legacy.entries) {
					const page = entry.page + 1;
					if (!boxCache.has(page)) boxCache.set(page, await this.engine.getPageViewBox(page));
					const s = v1EntryToStroke(entry, boxCache.get(page) ?? null);
					if (s) {
						strokes.push(s);
						migrated++;
					}
				}
				console.log(`[FleurPDF Ink] 已迁移 0.5.x 笔迹 ${migrated}/${loaded.legacy.entries.length} 条`);
			}
		} catch (err) {
			console.warn('[FleurPDF Ink] 读取手写数据失败（不影响新书写）:', err);
		}

		// ── 增量接管 0.4.x 固有注释（每次进入都补扫，claimedIds 防复活）──
		try {
			const res = await this.engine.readInherentInk(claimed);
			if (res.strokes.length) {
				strokes = strokes.concat(res.strokes);
				for (const id of res.ids) claimed.add(id);
				console.log(`[FleurPDF Ink] 已接管 PDF 固有手写笔迹 ${res.strokes.length} 条`);
			}
		} catch (err) {
			console.warn('[FleurPDF Ink] 接管固有笔迹失败（下一轮重试）:', err);
		}

		// ── 跨设备同步（inkCrossDeviceSync 开启时）：进入手写模式即 pull-merge ──
		// 移动端写的笔迹经 vault 内 FleurPDF/data/ink/ 非隐藏副本到达本端；
		// 对端的删除经墓碑生效（比笔迹时刻晚才删）。合并结果即本会话起点。
		if (this.plugin.settings.inkCrossDeviceSync && this.plugin.inkSync) {
			try {
				const merged = await this.plugin.inkSync.merge(file, {
					strokes,
					claimedIds: claimed,
					deleted,
				});
				strokes = merged.strokes;
				claimed = new Set(merged.claimedIds);
				deleted = merged.deleted;
			} catch (err) {
				console.warn('[FleurPDF Ink] 跨设备同步合并失败（不影响本地笔迹）:', err);
			}
		}

		this.claimedIds = claimed;
		this.deleted = deleted;
		this.overlay.hideInherentInk(claimed);
		this.overlay.loadStrokes(strokes);
		this.lastSavedJson = JSON.stringify(strokes);
		this.lastStrokes = strokes;
	}

	async exitInk(): Promise<void> {
		// 退出即落盘：点「完成」的用户语义是「我写完了」。
		this.cancelAutoSave();
		this.overlay.flushActiveStroke();
		await this.autoSave(false);

		this.overlay.detach();

		this.active = false;
		document.body.removeClass('fleur-pdf-ink-active');
		this.syncSwitcher();
		this.penBar?.remove();
		this.penBar = null;
		// 退出时把当前笔参数落盘（下次进入原样恢复）
		this.persist();
	}

	/** 笔盒上的保存钮：显式落盘（不退出手写模式，可以接着写）。 */
	private async save(): Promise<void> {
		this.cancelAutoSave();
		await this.autoSave(false);
	}

	/** 供设置页调用：开启跨设备同步后立即合并一次（未在手写模式时静默跳过，下次进入自然同步）。 */
	async syncNow(): Promise<void> {
		if (!this.plugin.settings.inkCrossDeviceSync) return;
		if (this.active && this.engine.isReady) await this.autoSave(true);
	}

	/* ============================ 自动落盘 ============================ */

	/**
	 * 把手写批注落盘（插件自己的 JSON，不触碰 PDF ⇒ 视图永不因落盘而重载）。
	 *
	 * 四层保障：
	 *   ① 每次数据变化后空闲 AUTO_SAVE_IDLE_MS 静默落盘；
	 *   ② 退出手写模式（点 ✓）时立刻落盘；
	 *   ③ 切换文件 / 工作区布局变化时兜底落盘（flushBeforeLeave）；
	 *   ④ 视图被销毁后用内存快照抢存（salvageSnapshot）。
	 */
	private async autoSave(silent: boolean): Promise<boolean> {
		if (this.saving) {
			if (!silent) new Notice('正在保存手写批注，请稍候');
			return false;
		}
		this.saving = true;
		try {
			if (!this.engine.isReady) {
				const salvaged = await this.salvageSnapshot();
				this.resetInkStateIfDead();
				return salvaged;
			}

			const file = this.engine.getFile();
			if (!file) {
				if (!silent) new Notice('找不到对应的 PDF 文件，无法保存手写批注');
				return false;
			}
			this.lastFile = file;

			// getStrokes 会先把进行中的手势提交掉 —— 最后一笔不丢
			const strokes = this.overlay.getStrokes();

			// ── 删除墓碑增量（相对上次快照的 id 集合 diff）──
			const curIds = new Set(strokes.map((s) => s.id));
			// 消失的 id → 立墓碑（同步开启时阻止对端复活；本地也留档）
			if (this.lastStrokes) {
				const now = Date.now();
				for (const s of this.lastStrokes) {
					if (!curIds.has(s.id) && !this.deleted[s.id]) this.deleted[s.id] = now;
				}
			}
			// 重新出现的 id（撤销恢复 / 重画同 id）→ 撤墓碑
			for (const id of curIds) delete this.deleted[id];

			// ── 跨设备同步：read-merge-write（对端新增收编进画布，对端删除生效）──
			let finalStrokes = strokes;
			if (this.plugin.settings.inkCrossDeviceSync && this.plugin.inkSync) {
				const merged = await this.plugin.inkSync.merge(file, {
					strokes,
					claimedIds: this.claimedIds,
					deleted: this.deleted,
				});
				this.deleted = merged.deleted;
				this.claimedIds = new Set(merged.claimedIds);
				if (merged.changed) {
					finalStrokes = merged.strokes;
					// 会话中途应用对端增量：不清撤销栈，只增删差异部分
					const localIds = new Set(strokes.map((s) => s.id));
					const mergedIds = new Set(finalStrokes.map((s) => s.id));
					this.overlay.addStrokes(finalStrokes.filter((s) => !localIds.has(s.id)));
					this.overlay.removeStrokes(new Set([...localIds].filter((id) => !mergedIds.has(id))));
				}
			}

			const json = JSON.stringify(finalStrokes);
			if (json === this.lastSavedJson) {
				this.lastStrokes = finalStrokes;
				// 无变化 → 静默返回。此路径在每次切换模式 / 点侧边栏（exitInk）都会
				// 走到，弹提示纯属打扰；真正落盘时下方已有「已保存（N 条）」反馈。
				return false;
			}

			await this.inkStore.save(file, finalStrokes, Array.from(this.claimedIds), this.deleted);
			this.lastSavedJson = json;
			this.lastStrokes = finalStrokes;
			if (!silent) new Notice(`已保存手写批注（${finalStrokes.length} 条）`);
			return true;
		} catch (err) {
			if (!silent || !this.saveErrorNotified) {
				this.saveErrorNotified = true;
				new Notice(`手写批注保存失败：${err instanceof Error ? err.message : String(err)}`);
			}
			return false;
		} finally {
			this.saving = false;
		}
	}

	/**
	 * PDF 视图已被销毁时的状态复位。
	 *
	 * 关闭文件不会走 exitInk（用户没点「完成」），active 会一直留在 true。
	 * 覆盖层架构下视图销毁的后果极轻：笔迹数据在我们手上（lastStrokes），
	 * 重新进入手写时 loadInkFromStore() 原样恢复，不存在「笔迹丢了」。
	 */
	private resetInkStateIfDead(): void {
		if (!this.active) return;
		this.cancelAutoSave();
		this.overlay.detach();
		this.lastSavedJson = '';
		this.active = false;
		document.body.removeClass('fleur-pdf-ink-active');
		this.syncSwitcher();
		this.penBar?.remove();
		this.penBar = null;
	}

	/** 安排一次空闲落盘（每次改动后调用，重复调用只保留最后一次）。 */
	private scheduleAutoSave(): void {
		// 先同步刷新内存快照，再排防抖。顺序不能反：快照的意义就是
		// 「视图还活着的时候把状态接住」，放到定时器里就晚了。
		this.captureSnapshot();
		if (this.autoSaveTimer !== null) window.clearTimeout(this.autoSaveTimer);
		this.autoSaveTimer = window.setTimeout(() => {
			this.autoSaveTimer = null;
			void this.autoSave(true);
		}, AUTO_SAVE_IDLE_MS);
	}

	private cancelAutoSave(): void {
		if (this.autoSaveTimer !== null) {
			window.clearTimeout(this.autoSaveTimer);
			this.autoSaveTimer = null;
		}
	}

	/**
	 * 同步把「此刻引擎里有什么」抄进内存（不落盘）。
	 * 刻意不加节流：调用点是「一笔画完 / 一次擦除完成」，不是 pointermove。
	 */
	private captureSnapshot(): void {
		try {
			if (!this.active || !this.engine.isReady) return;
			const file = this.engine.getFile();
			if (!file) return;
			this.lastFile = file;
			const strokes = this.overlay.getStrokes();

			// ── 墓碑增量必须在这里（数据变化的那一刻）diff，不能等 autoSave ──
			// captureSnapshot 会把 lastStrokes 刷新成本次状态；若 diff 留到防抖的
			// autoSave 里做，基准已被抢先更新，「消失的 id」永远 diff 不出来，
			// 墓碑立不起来 → 跨设备合并时被同步文件里的旧笔迹复活（实测踩坑）。
			const curIds = new Set(strokes.map((s) => s.id));
			if (this.lastStrokes) {
				const now = Date.now();
				for (const s of this.lastStrokes) {
					if (!curIds.has(s.id) && !this.deleted[s.id]) this.deleted[s.id] = now;
				}
			}
			// 重新出现的 id（撤销恢复 / 重画同 id）→ 撤墓碑
			for (const id of curIds) delete this.deleted[id];

			this.lastStrokes = strokes;
		} catch {
			/* 快照失败只是少一层保险，不打断书写 */
		}
	}

	/**
	 * 视图已销毁时的抢存：用最后一次内存快照（captureSnapshot）写进 sidecar。
	 * 空闲落盘覆盖「写完停手再关」，抢存覆盖「写完立刻关」。
	 */
	private async salvageSnapshot(): Promise<boolean> {
		const file = this.lastFile;
		const strokes = this.lastStrokes;
		if (!file || !strokes) return false;
		const json = JSON.stringify(strokes);
		if (json === this.lastSavedJson) return false;
		try {
			await this.inkStore.save(file, strokes, Array.from(this.claimedIds), this.deleted);
			this.lastSavedJson = json;
			console.log(`[FleurPDF Ink] 视图已销毁，已用内存快照补存 ${strokes.length} 条笔迹`);
			return true;
		} catch (err) {
			console.warn('[FleurPDF Ink] 快照补存失败:', err);
			return false;
		}
	}

	/**
	 * 要离开当前 PDF 了（切文件 / 布局变化）→ 兜底落盘。
	 * 只在「手写模式开着」且「当前 PDF 确实换了」时才动手。
	 */
	private async flushBeforeLeave(nextPath: string | null): Promise<void> {
		if (!this.active) return;
		const cur = this.engine.pdfFilePath;
		if (!cur) return;
		if (nextPath && nextPath === cur) return;
		this.cancelAutoSave();
		await this.autoSave(true);
	}

	/* ============================ 工具切换 ============================ */

	/** 把当前选中的笔翻译成引擎工具。 */
	private currentTool(): InkTool {
		const pen = this.pens[this.penIndex];
		if (pen.kind === 'eraser') {
			return { mode: 'eraser', radius: Math.max(2, pen.thickness) };
		}
		if (pen.kind === 'lasso') {
			return { mode: 'lasso' };
		}
		return {
			mode: 'pen',
			color: pen.color,
			width: pen.thickness,
			opacity: pen.opacity,
			kind: pen.kind === 'marker' ? 'marker' : 'pen',
		};
	}

	/** 当前笔（含擦除模式的选区映射）下发给引擎。 */
	private applyTool(): void {
		if (!this.active) return;
		// 截图模式优先：相机是临时工具，不占用 pens 槽位
		this.overlay.setTool(this.snapMode ? { mode: 'snap' } : this.currentTool());
	}

	/** 截图完成：渲染 + 打开结果面板，随后自动退出截图模式。 */
	private async handleSnap(page: number, rect: { x0: number; y0: number; x1: number; y1: number }): Promise<void> {
		// 先退出截图模式（回到之前的笔），再开面板 —— 面板打开时手已释放
		this.snapMode = false;
		this.applyTool();
		this.refreshPenBar();
		const viewer = this.overlay.getPdfViewer();
		if (!viewer) {
			new Notice('截图失败：无法访问 PDF 视图');
			return;
		}
		await openSnapResult(this.plugin, viewer, page, rect);
	}

	private async selectPen(i: number): Promise<void> {
		// 记录「点的就是当前已选中的那支」——橡皮要靠它判断是否展开设置弹层
		const wasSame = this.penIndex === i;
		this.snapMode = false; // 选笔即退出截图模式
		this.penIndex = i;
		this.applyTool();
		this.persist();
		this.refreshPenBar();
		// 再次点击橡皮图标 → 展开橡皮设置（擦除模式 + 大小）
		if (this.pens[i].kind === 'eraser' && wasSame) this.openEraserPop();
	}

	/** 展开橡皮设置弹层（擦除模式 + 大小）。 */
	private openEraserPop(): void {
		const pop = this.penBar?.querySelector<HTMLElement>('.fleur-pdf-ink-eraser-pop');
		if (!pop) return;
		const willOpen = !pop.hasClass('is-open');
		this.closePops(pop);
		pop.toggleClass('is-open', willOpen);
	}

	private setColor(color: string): void {
		this.pens[this.penIndex].color = color;
		this.applyTool();
		this.persist();
		this.refreshPenBar();
	}

	/**
	 * 切换擦除模式（仅橡皮生效；随切换写回设置）。
	 * 「选区擦除」= 套索圈选 + 删除按钮（引擎的 lasso 工具）。
	 */
	private setEraseMode(mode: EraseMode): void {
		this.eraserMode = mode;
		this.applyTool();
		this.persist();
		this.penBar
			?.findAll('.fleur-pdf-ink-eraser-pop .fleur-pdf-ink-mode')
			.forEach((el) => {
				const label = el.textContent ?? '';
				el.toggleClass('is-active', label === ERASE_MODE_LABEL[mode]);
			});
	}

	/** 重绘笔盒（选中态、颜色方块、粗细圆点都要跟着变）。 */
	private refreshPenBar(): void {
		const wasActive = this.active;
		this.buildPenBar();
		if (!wasActive) this.penBar?.remove();
	}

	/* ============================ 笔盒 ============================ */

	private buildPenBar(): void {
		this.penBar?.remove();
		const bar = document.body.createDiv('fleur-pdf-ink-bar');
		this.penBar = bar;

		// ── 拖把手（笔盒整体拖动的唯一入口：只认把手，按钮区不受影响）──
		const grip = bar.createDiv('fleur-pdf-ink-grip');
		setIcon(grip, 'grip-vertical');
		grip.setAttribute('aria-label', '拖动笔盒');
		this.attachBarDrag(bar, grip);

		// ── 笔 ──
		const penGroup = bar.createDiv('fleur-pdf-ink-group');
		this.pens.forEach((pen, i) => {
			const btn = penGroup.createDiv('fleur-pdf-ink-btn');
			setIcon(btn, PEN_ICON[pen.kind]);
			btn.setAttribute('aria-label', PEN_LABEL[pen.kind]);
			if (i === this.penIndex && !this.snapMode) btn.addClass('is-active');
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.selectPen(i);
			});
		});

		// ── 局部截图（相机）：临时工具，框选后自动回到当前笔 ──
		const snapBtn = penGroup.createDiv('fleur-pdf-ink-btn');
		setIcon(snapBtn, 'camera');
		snapBtn.setAttribute('aria-label', '局部截图（框选区域，可 OCR / 问 AI）');
		if (this.snapMode) snapBtn.addClass('is-active');
		snapBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.snapMode = !this.snapMode;
			this.applyTool();
			this.refreshPenBar();
		});

		// ── 颜色 ──
		const colorBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(colorBtn, 'palette');
		colorBtn.setAttribute('aria-label', '颜色');
		const curKind = this.pens[this.penIndex].kind;
		colorBtn.createDiv('fleur-pdf-ink-swatch').setCssStyles({
			background: curKind === 'eraser' || curKind === 'lasso' ? 'transparent' : this.pens[this.penIndex].color,
		});
		const colorPop = this.buildColorPop();
		bar.appendChild(colorPop);
		colorBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.closePops(colorPop);
			colorPop.toggleClass('is-open', !colorPop.hasClass('is-open'));
		});

		// ── 大小（钢笔 / 荧光笔）或橡皮设置 ──
		const pen = this.pens[this.penIndex];
		if (pen.kind !== 'eraser') {
			const sizeBtn = bar.createDiv('fleur-pdf-ink-btn');
			setIcon(sizeBtn, 'circle-dot');
			sizeBtn.setAttribute('aria-label', '粗细');
			const sizePop = this.buildSizePop();
			bar.appendChild(sizePop);
			sizeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.closePops(sizePop);
				sizePop.toggleClass('is-open', !sizePop.hasClass('is-open'));
			});
		} else {
			// 橡皮设置弹层（擦除模式 + 大小）常驻笔盒，由「再次点击橡皮图标」展开
			bar.appendChild(this.buildEraserPop());
		}

		bar.createDiv('fleur-pdf-ink-sep');

		// ── 撤销 / 重做 ──
		const undoBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(undoBtn, 'undo-2');
		undoBtn.setAttribute('aria-label', '撤销');
		undoBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!this.overlay.undo()) new Notice('没有可撤销的操作');
		});

		const redoBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(redoBtn, 'redo-2');
		redoBtn.setAttribute('aria-label', '重做');
		redoBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!this.overlay.redo()) new Notice('没有可重做的操作');
		});

		// ── 删除选中（仅套索激活时出现：删除的是选区里的笔迹）──
		if (pen.kind === 'lasso') {
			const delBtn = bar.createDiv('fleur-pdf-ink-btn');
			setIcon(delBtn, 'trash-2');
			delBtn.setAttribute('aria-label', '删除选中');
			delBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (!this.overlay.deleteSelection()) new Notice('先用套索圈选要删除的笔迹');
			});
		}

		bar.createDiv('fleur-pdf-ink-sep');

		// ── 保存 / 完成 ──
		const saveBtn = bar.createDiv('fleur-pdf-ink-btn is-primary');
		setIcon(saveBtn, 'save');
		saveBtn.setAttribute('aria-label', '保存批注');
		saveBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.save();
		});

		const doneBtn = bar.createDiv('fleur-pdf-ink-btn');
		setIcon(doneBtn, 'check');
		doneBtn.setAttribute('aria-label', '退出手写模式');
		doneBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.exitInk();
		});

		// 笔盒每次都被整体重建（选笔 / 换色等都会走 refreshPenBar）——
		// 重建后必须把用户拖过的位置贴回去，否则一换笔就跳回底部居中。
		this.applyBarPos();
	}

	/* ==================== 笔盒：拖动与位置恢复 ==================== */

	/**
	 * 把笔盒放回用户上次拖到的位置（视口比例 → 像素，钳在屏幕内）。
	 * 没拖过（无 inkBarPos）→ 什么都不做，走 CSS 默认（底部居中）。
	 */
	private applyBarPos(): void {
		const bar = this.penBar;
		if (!bar) return;
		const pos = this.plugin.settings.inkBarPos;
		if (!pos) return;
		const w = bar.offsetWidth;
		const h = bar.offsetHeight;
		if (!w || !h) return; // 尚未布局完成，等下一次重建再贴
		const left = Math.min(window.innerWidth - w - 8, Math.max(8, pos.x * window.innerWidth - w / 2));
		const top = Math.min(window.innerHeight - h - 8, Math.max(8, pos.y * window.innerHeight - h / 2));
		bar.setCssStyles({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
			right: 'auto',
			bottom: 'auto',
			transform: 'none',
		});
	}

	/**
	 * 笔盒拖动：只认把手（grip），阈值 6px 以内当误触。
	 * 位移改 left/top（transform 归零），松手把中心点折成视口比例存进设置。
	 */
	private attachBarDrag(bar: HTMLElement, grip: HTMLElement): void {
		let dragging = false;
		let moved = false;
		let startX = 0;
		let startY = 0;
		let originLeft = 0;
		let originTop = 0;

		grip.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			dragging = true;
			moved = false;
			startX = e.clientX;
			startY = e.clientY;
			const r = bar.getBoundingClientRect();
			originLeft = r.left;
			originTop = r.top;
			bar.setCssStyles({
				left: `${originLeft}px`,
				right: 'auto',
				bottom: 'auto',
				top: `${originTop}px`,
				transform: 'none',
			});
			try {
				grip.setPointerCapture(e.pointerId);
			} catch {
				/* 某些 WebView 对已释放指针抛错，忽略 */
			}
			e.preventDefault();
			e.stopPropagation();
		}, true);

		grip.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			e.preventDefault();
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (!moved) {
				if (Math.hypot(dx, dy) < 6) return;
				moved = true;
				bar.addClass('is-dragging');
			}
			bar.setCssStyles({ left: `${originLeft + dx}px`, top: `${originTop + dy}px` });
		});

		const finish = (e: PointerEvent) => {
			if (!dragging) return;
			dragging = false;
			try {
				grip.releasePointerCapture?.(e.pointerId);
			} catch {
				/* 忽略 */
			}
			if (!moved) {
				bar.removeClass('is-dragging');
				this.applyBarPos();
				return;
			}
			bar.removeClass('is-dragging');
			// 吞掉拖动收尾产生的 click，防止误触
			grip.addEventListener('click', (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
			}, { capture: true, once: true });
			const r = bar.getBoundingClientRect();
			this.plugin.settings.inkBarPos = {
				x: Math.min(1, Math.max(0, (r.left + r.width / 2) / window.innerWidth)),
				y: Math.min(1, Math.max(0, (r.top + r.height / 2) / window.innerHeight)),
			};
			void this.plugin.saveSettings().catch(() => undefined);
			this.applyBarPos();
		};
		grip.addEventListener('pointerup', finish);
		grip.addEventListener('pointercancel', finish);
	}

	private closePops(except: HTMLElement): void {
		this.penBar?.findAll('.fleur-pdf-ink-pop').forEach((el) => {
			if (el !== except) el.removeClass('is-open');
		});
	}

	private buildColorPop(): HTMLElement {
		const pop = createDiv('fleur-pdf-ink-pop fleur-pdf-ink-colors');
		const isMarker = this.pens[this.penIndex].kind === 'marker';
		const colors = isMarker ? MARKER_COLORS : PEN_COLORS;
		for (const c of colors) {
			const dot = pop.createDiv('fleur-pdf-ink-color');
			dot.setCssStyles({ background: c });
			if (c === this.pens[this.penIndex].color) dot.addClass('is-active');
			dot.addEventListener('click', (e) => {
				e.stopPropagation();
				this.setColor(c);
			});
		}
		return pop;
	}

	/**
	 * 大小滑块（钢笔 / 荧光笔 / 橡皮共用）。
	 * 拖动过程只改内存值 + 实时下发，不重建笔盒（重建会让滑块在手指下消失）；
	 * 松手（change）时才落盘。
	 */
	private buildSizeSlider(): HTMLElement {
		const pen = this.pens[this.penIndex];
		const [min, max, step] = SIZE_RANGE[pen.kind];
		const row = createDiv('fleur-pdf-ink-slider-row');

		const input = row.createEl('input', { cls: 'fleur-pdf-ink-slider' });
		input.type = 'range';
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(pen.thickness);

		const value = row.createDiv('fleur-pdf-ink-slider-val');
		value.setText(String(pen.thickness));

		// 滑块自己吃掉指针事件，避免冒泡到 body 的「点空白收起面板」逻辑
		for (const ev of ['pointerdown', 'touchstart', 'click']) {
			input.addEventListener(ev, (e) => e.stopPropagation());
		}

		input.addEventListener('input', () => {
			const v = Number(input.value);
			this.pens[this.penIndex].thickness = v;
			value.setText(String(v));
			this.applyTool();
		});
		input.addEventListener('change', () => this.persist());

		return row;
	}

	/** 粗细弹层（单根滑块）。 */
	private buildSizePop(): HTMLElement {
		const pop = createDiv('fleur-pdf-ink-pop fleur-pdf-ink-sizes');
		pop.appendChild(this.buildSizeSlider());
		return pop;
	}

	/** 橡皮设置弹层：擦除模式（笔画 / 选区）+ 大小滑块。 */
	private buildEraserPop(): HTMLElement {
		const pop = createDiv('fleur-pdf-ink-pop fleur-pdf-ink-eraser-pop');
		for (const m of ERASE_MODES) {
			const item = pop.createDiv('fleur-pdf-ink-modes');
			// 复用容器结构：每个模式一个选项行
			const opt = item.createDiv('fleur-pdf-ink-mode');
			opt.setText(ERASE_MODE_LABEL[m]);
			if (m === this.eraserMode || (m === 'stroke' && this.eraserMode === 'pixel')) {
				opt.addClass('is-active');
			}
			opt.addEventListener('click', (e) => {
				e.stopPropagation();
				this.setEraseMode(m);
			});
		}
		pop.appendChild(this.buildSizeSlider());
		return pop;
	}

	/* ==================== 悬浮切换器：显隐 ==================== */

	/** 同步切换器的高亮（编辑段 / 手写段互斥）。 */
	private syncSwitcher(): void {
		this.editSeg?.toggleClass('is-active', !this.active);
		this.inkSeg?.toggleClass('is-active', this.active);
		// 每次 active 状态变化都会经过这里（mount / enterInk / exitInk / 异常回退），
		// 自动贴边的起停就搭这趟车，不必在四处各插一句。
		this.syncAutoDock();
	}

	/* ==================== 悬浮切换器：文本模式自动贴边 ==================== */

	/**
	 * 临时贴边态。与用户长按收起的持久态 `is-collapsed` 完全正交：
	 * 视觉同一根把手（CSS 里两条选择器并列），但这里**不写设置**，
	 * 进手写模式 / 用户点一下把手就无条件恢复，不会把「临时」变成「永久」。
	 *
	 * 为什么需要它：三段胶囊常驻在正文右侧，文本批注模式下它就是块挡路的浮层 ——
	 * 真机反馈「菜单在还没选中文本的时候就已经弹出来，挡住了用户继续选中文本」。
	 * 手写模式里它是工具条（笔 / 橡皮 / 套索 / 列表），一分钟都不能少，所以
	 * `this.active` 为真时整套机制直接不生效。
	 */
	private autoDocked = false;
	private autoDockTimer: number | null = null;
	/** 文本模式下闲置多久自动贴边（够久，不至于打断「点一下列表按钮」这种连续操作）。 */
	private static readonly DOCK_IDLE_MS = 2600;
	/** 选区一有动静就贴边：拖原生选择手柄时 WebView 不给页面发 pointer 事件，只能靠 selectionchange。 */
	private static readonly DOCK_SELECTING_MS = 500;

	/** 点正文（含开始选字）即贴边；点胶囊自身则重新计时 / 展开。 */
	private readonly onDockPointerDown = (e: Event): void => {
		if (this.active) return;
		const sw = this.toggleBtn;
		if (!sw) return;
		const t = e.target as HTMLElement | null;
		if (t?.closest?.('.fleur-pdf-ink-toggle')) {
			// 摸到胶囊 = 要用它：先展开（若正贴边），再给足闲置时间
			this.setAutoDocked(false);
			this.armAutoDock(InkUI.DOCK_IDLE_MS);
			return;
		}
		// 点在别处：文本模式下这个入口此刻用不上，立刻贴边让路
		this.setAutoDocked(true);
	};

	/** 选区变化（正在选字 / 拖手柄）→ 快速贴边。 */
	private readonly onDockSelectionChange = (): void => {
		if (this.active || this.autoDocked) return;
		this.armAutoDock(InkUI.DOCK_SELECTING_MS);
	};

	/** 按当前状态起停贴边计时器：手写模式与不可见时一律不生效。 */
	private syncAutoDock(): void {
		if (this.active) {
			this.setAutoDocked(false);
			return;
		}
		this.armAutoDock(InkUI.DOCK_IDLE_MS);
	}

	private armAutoDock(ms: number): void {
		if (this.autoDockTimer !== null) window.clearTimeout(this.autoDockTimer);
		this.autoDockTimer = null;
		const sw = this.toggleBtn;
		if (!sw || this.active || sw.hasClass('is-hidden')) return;
		// 用户已经长按收起：持久态已经把入口缩成把手了，不必再排一次
		if (this.plugin.settings.inkSwitcherCollapsed === true) return;
		this.autoDockTimer = window.setTimeout(() => {
			this.autoDockTimer = null;
			this.setAutoDocked(true);
		}, Math.max(120, ms));
	}

	private setAutoDocked(on: boolean): void {
		if (this.autoDocked === on) return;
		// 拖动途中不收：把手的 14×46 命中区比胶囊小得多，正拖着突然变窄会立刻脱手
		if (on && (this.toggleBtn?.hasClass('is-dragging') || this.active)) return;
		this.autoDocked = on;
		this.toggleBtn?.toggleClass('is-auto-collapsed', on);
	}

	/**
	 * 当前视图是不是在 PDF 上。
	 * 只认活动文件的扩展名，比去猜 leaf 的 view 类型稳。
	 */
	private isPdfContext(): boolean {
		try {
			return this.plugin.app.workspace.getActiveFile()?.extension === 'pdf';
		} catch {
			return false;
		}
	}

	/**
	 * 同步悬浮胶囊（含三段）的显隐。设置里改开关、切换文件、切换标签页都会走到这里。
	 */
	syncSwitcherVisibility(): void {
		const sw = this.toggleBtn;
		if (!sw) return;
		const s = this.plugin.settings;

		const showEdit = s.inkShowEditSeg !== false;
		const showInk = s.inkShowInkSeg !== false;
		const showSide = s.inkShowSideSeg !== false;
		const anySeg = showEdit || showInk || showSide;

		const hidden = s.inkSwitcherHidden === true || !this.isPdfContext() || !anySeg;
		sw.toggleClass('is-hidden', hidden);

		this.editSeg?.toggleClass('is-hidden', !showEdit);
		this.inkSeg?.toggleClass('is-hidden', !showInk);
		this.sideSeg?.toggleClass('is-hidden', !showSide);

		// 指引只在按钮真的出现时给一次
		if (!hidden && !InkUI.mountHintShown) {
			InkUI.mountHintShown = true;
			new Notice(
				`FleurPDF 手写批注已就绪 v${this.plugin.manifest.version}：点击右下角的“手写”按钮开始批注`,
			);
		}
	}

	/** 供外部（设置页改开关后）刷新显隐。 */
	refreshVisibility(): void {
		this.syncSwitcherVisibility();
		this.applySwitcherPos();
		// 设置页刚动过 → 用户正在找那个开关，此刻别把入口缩成一根把手
		this.setAutoDocked(false);
		this.armAutoDock(InkUI.DOCK_IDLE_MS);
	}

	/* ==================== 悬浮切换器：拖动 / 收起 ==================== */

	/**
	 * 把胶囊放到设置里记住的位置。
	 * y 存的是视口比例而不是像素：换设备、转屏后像素值会落到屏幕外，比例不会。
	 */
	private applySwitcherPos(): void {
		const sw = this.toggleBtn;
		if (!sw) return;
		const side = this.plugin.settings.inkSwitcherSide ?? 'right';
		const y = Math.min(1, Math.max(0, this.plugin.settings.inkSwitcherY ?? 0.78));
		sw.setCssStyles({
			left: side === 'left' ? '12px' : 'auto',
			right: side === 'right' ? '12px' : 'auto',
			top: `${Math.round(y * 100)}%`,
			bottom: 'auto',
			transform: 'translateY(-50%)',
		});
	}

	/**
	 * 拖动换位 + 长按收起。
	 * 位移小于 6px 一律当点击，超过才进入拖动；拖动结束后用一次捕获态 click 吞掉误点。
	 */
	private attachSwitcherDrag(sw: HTMLElement): void {
		let dragging = false;
		let moved = false;
		let startX = 0;
		let startY = 0;
		let originLeft = 0;
		let originTop = 0;
		let longPress: number | null = null;

		const clearLongPress = () => {
			if (longPress !== null) {
				window.clearTimeout(longPress);
				longPress = null;
			}
		};

		sw.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			dragging = true;
			moved = false;
			startX = e.clientX;
			startY = e.clientY;
			const r = sw.getBoundingClientRect();
			originLeft = r.left;
			originTop = r.top;
			sw.setCssStyles({
				left: `${originLeft}px`,
				right: 'auto',
				top: `${originTop}px`,
				bottom: 'auto',
				transform: 'none',
			});
			try {
				// ⚠️ 只有触摸在 pointerdown 立即捕获。鼠标绝不能在这里捕获：
				// Chromium 会把后续 click 重定向到 pointerdown/pointerup 目标的公共祖先
				// （即容器 sw），胶囊三段的 click 永远不触发 —— 桌面端表现就是
				// 「点手写无反应」（真机触摸的 click 仍落在原始命中元素，不受影响，
				// 已用 Playwright 双端对照实验实锤）。鼠标改为拖动真正开始时再捕获。
				if (e.pointerType !== 'mouse') (sw as HTMLElement).setPointerCapture(e.pointerId);
			} catch {
				/* 某些 WebView 对已释放指针抛错，忽略 */
			}
			clearLongPress();
			longPress = window.setTimeout(() => {
				longPress = null;
				if (moved) return;
				dragging = false;
				this.setSwitcherCollapsed(true);
			}, 650);
		}, true);

		sw.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			if (e.pointerType !== 'mouse') e.preventDefault();
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (!moved) {
				if (Math.hypot(dx, dy) < 6) return;
				moved = true;
				clearLongPress();
				sw.addClass('is-dragging');
				// 鼠标的捕获推迟到此刻：拖动意图确立后才接管后续指针事件。
				// 触摸靠隐式捕获不丢 move，无需此处补捕获。
				if (e.pointerType === 'mouse') {
					try {
						(sw as HTMLElement).setPointerCapture(e.pointerId);
					} catch {
						/* 忽略 */
					}
				}
			}
			sw.setCssStyles({ left: `${originLeft + dx}px`, top: `${originTop + dy}px` });
		});

		const finish = (e: PointerEvent) => {
			if (!dragging) return;
			dragging = false;
			try {
				(sw as HTMLElement).releasePointerCapture?.(e.pointerId);
			} catch {
				/* 忽略 */
			}
			clearLongPress();
			if (!moved) {
				sw.removeClass('is-dragging');
				this.applySwitcherPos();
				return;
			}
			sw.removeClass('is-dragging');
			sw.addEventListener('click', (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
			}, { capture: true, once: true });

			const r = sw.getBoundingClientRect();
			const side: 'left' | 'right' = r.left + r.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
			const half = r.height / 2;
			const centerY = Math.min(window.innerHeight - half - 8, Math.max(half + 8, r.top + r.height / 2));
			this.plugin.settings.inkSwitcherSide = side;
			this.plugin.settings.inkSwitcherY = centerY / window.innerHeight;
			void this.plugin.saveSettings().catch(() => undefined);
			this.applySwitcherPos();
		};
		sw.addEventListener('pointerup', (e) => finish(e as PointerEvent));
		sw.addEventListener('pointercancel', (e) => finish(e as PointerEvent));

		// 收起态下点一下把手即恢复
		sw.addEventListener('click', (e) => {
			if (this.plugin.settings.inkSwitcherCollapsed !== true) return;
			e.preventDefault();
			e.stopPropagation();
			this.setSwitcherCollapsed(false);
		}, true);
	}

	/** 收起 / 展开悬浮胶囊，状态持久化。 */
	private setSwitcherCollapsed(collapsed: boolean): void {
		this.plugin.settings.inkSwitcherCollapsed = collapsed;
		void this.plugin.saveSettings().catch(() => undefined);
		this.toggleBtn?.toggleClass('is-collapsed', collapsed);
		// 持久化状态是用户明确表达的意图，临时贴边态就此让位：
		// 两者叠着会让「点把手恢复」看起来没反应（is-collapsed 还在）。
		this.setAutoDocked(false);
		if (!collapsed) this.armAutoDock(InkUI.DOCK_IDLE_MS);
		if (collapsed) {
			new Notice('悬浮按钮已收起：点侧边的小把手即可恢复，也可用命令面板的「显示 / 隐藏手写批注悬浮按钮」');
		}
	}

	/** 供命令面板调用：显示 / 收起悬浮胶囊（用户彻底找不到入口时的兜底）。 */
	toggleSwitcher(): void {
		const s = this.plugin.settings;

		if (s.inkSwitcherHidden === true) {
			s.inkSwitcherHidden = false;
			s.inkSwitcherCollapsed = false;
			void this.plugin.saveSettings().catch(() => undefined);
			this.toggleBtn?.removeClass('is-collapsed');
			// 命令面板喊「显示按钮」，结果只出来一根贴边把手 = 用户以为没生效
			this.setAutoDocked(false);
			this.syncSwitcherVisibility();
			this.armAutoDock(InkUI.DOCK_IDLE_MS);
			new Notice('已显示手写批注悬浮按钮');
			return;
		}
		if (s.inkSwitcherCollapsed === true) {
			this.setSwitcherCollapsed(false);
			return;
		}
		// 手写模式中不留无按钮的死角：先退出手写，用户就不必自己找出口
		if (this.active) {
			new Notice('请先退出手写模式，再隐藏悬浮按钮');
			return;
		}
		s.inkSwitcherHidden = true;
		void this.plugin.saveSettings().catch(() => undefined);
		this.syncSwitcherVisibility();
		new Notice('已隐藏悬浮按钮：可用命令面板或设置里的「显示悬浮按钮」重新打开');
	}
}
