// 便签的页面覆盖层：把 notes 渲染成贴在每一页 .page 上的可交互 div。
//
// 生命周期完全照搬 ink/overlay-engine.ts 验证过的模式：
//   · pdf.js 会虚拟化页面（销毁/重建 .page DOM），缩放时还会**原地清空 .page 子节点**
//     —— 所以每次 reconcile 必须校验 layer.isConnected，不能只查 Map；
//   · MutationObserver(root, childList+subtree) + 80ms 去抖驱动 reconcile；
//   · 每页一个 ResizeObserver，缩放/重排后按 viewport.scale 重新换算便签几何。
//
// 与 ink 层的差异只有两点：
//   · 载体是 DOM div 而非 canvas（便签要原生文本编辑）；
//   · 层常驻（不分手写/编辑模式）。手写模式按**指针类型**分流（不再整片
//     pointer-events:none，否则桌面端鼠标对便签全失能）：pen/touch 落便签由
//     overlay-engine.surfaceOfEvent 放行给书写/滚动，本文件的交互一律让位；
//     鼠标落便签则正常操作（输入/拖拽/缩放/折叠）。
//
// 数据不随 DOM 走：notes 数组是唯一真相源，页面重建只是重画。

import { Notice, setIcon } from 'obsidian';
import type FleurPDFPlugin from '../main';
import {
  mintNoteId,
  NOTE_DEFAULT_H,
  NOTE_DEFAULT_W,
  NOTE_MIN_H,
  NOTE_MIN_W,
  NoteStore,
  type PDFNote,
} from './note-store';

/** 一页的覆盖层记录。 */
interface PageSurface {
  /** .page 元素本体。 */
  el: HTMLElement;
  /** 我们挂进去的绝对定位容器（pointer-events: none，便签各自 auto）。 */
  layer: HTMLElement;
  /** 便签 id → 便签元素。 */
  notes: Map<string, HTMLElement>;
  resizeObs: ResizeObserver;
}

/** 折叠态便签的横条高度（CSS px，不随缩放 —— 它是操作把手不是内容）。 */
const NOTE_FOLD_H = 22;

export class NoteLayer {
  private store: NoteStore;
  private notes: PDFNote[] = [];
  private exportPath = '';
  private pdfPath: string | null = null;
  /** pdf.js 真 viewer 的渲染根（.pdfViewer 容器）。 */
  private root: HTMLElement | null = null;
  private viewer: any = null;
  private surfaces = new Map<number, PageSurface>();
  private domObs: MutationObserver | null = null;
  private reconcileTimer: number | null = null;
  private syncTimer: number | null = null;

  constructor(private plugin: FleurPDFPlugin) {
    this.store = new NoteStore(plugin.app, plugin.manifest.id);
    const ws = plugin.app.workspace;
    const on = () => {
      if (this.enabled) this.scheduleSync();
    };
    plugin.registerEvent(ws.on('file-open', on));
    plugin.registerEvent(ws.on('active-leaf-change', on));
    plugin.registerEvent(ws.on('layout-change', on));
  }

  private get enabled(): boolean {
    return this.plugin.settings.notesEnabled === true;
  }

  /* ------------------------------ 对外状态 ------------------------------ */

  get currentNotes(): PDFNote[] {
    return this.notes;
  }

  get currentPdfPath(): string | null {
    return this.pdfPath;
  }

  get currentExportPath(): string {
    return this.exportPath;
  }

  /** 导出成功后回写路径（记进 sidecar，二次导出按它识别覆盖）。 */
  setExportPath(path: string): void {
    this.exportPath = path;
    void this.persist();
  }

  /* ------------------------------ 同步 / 生命周期 ------------------------------ */

  /** 去抖同步（事件风暴里只解析一次视图）。 */
  scheduleSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.sync();
    }, 150);
  }

  /**
   * 对齐「当前活动 PDF」与便签层。可反复调用（幂等）；
   * 解析不出 PDF 视图时清层（数据不丢，回到 PDF 时 reconcile 自动重画）。
   */
  async sync(): Promise<void> {
    if (!this.enabled) {
      this.detachAll();
      return;
    }
    // 借用 InkEngine 的三层包装解析（版本耦合已收口在它一个函数里）
    const handle = await this.plugin.inkEngine.resolve();
    const root: HTMLElement | undefined = handle?.viewer?.viewer;
    if (!handle || !root) {
      this.detachAll();
      return;
    }
    if (this.pdfPath !== handle.filePath) {
      const data = await this.store.load(handle.filePath);
      this.pdfPath = handle.filePath;
      this.notes = data.notes;
      this.exportPath = data.exportPath;
    }
    if (this.root !== root) {
      this.detachSurfaces();
      this.root = root;
      this.viewer = handle.viewer;
      this.domObs?.disconnect();
      this.domObs = new MutationObserver(() => this.scheduleReconcile());
      this.domObs.observe(root, { childList: true, subtree: true });
    }
    this.reconcile();
  }

  /** 关开关 / 解析失败：只拆 DOM 与观察者，数据留在内存与 sidecar。 */
  detachAll(): void {
    if (this.reconcileTimer !== null) {
      window.clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.domObs?.disconnect();
    this.domObs = null;
    this.root = null;
    this.viewer = null;
    this.detachSurfaces();
  }

  destroy(): void {
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.detachAll();
  }

  private detachSurfaces(): void {
    for (const n of Array.from(this.surfaces.keys())) this.unmountSurface(n);
  }

  /* ------------------------------ reconcile ------------------------------ */

  private scheduleReconcile(): void {
    if (this.reconcileTimer !== null) return;
    this.reconcileTimer = window.setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcile();
    }, 80);
  }

  private reconcile(): void {
    if (!this.root) return;
    const seen = new Set<number>();
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('.page[data-page-number]'))) {
      const n = Number(el.dataset.pageNumber);
      if (!Number.isFinite(n) || n < 1) continue;
      seen.add(n);
      const sf = this.surfaces.get(n);
      // ⚠️ 缩放时 pdf.js 原地清空 .page 子节点：.page 还连着 DOM，但我们的层已被摘走。
      // 必须校验 layer.isConnected，否则便签缩放后消失且再也回不来。
      if (sf && (!sf.layer.isConnected || !sf.el.isConnected)) this.unmountSurface(n);
      // 只给已渲染出内容的页挂层（canvasWrapper 存在 = 内容已渲染）
      if (!this.surfaces.has(n) && el.querySelector('.canvasWrapper')) this.mountSurface(n, el);
    }
    for (const n of Array.from(this.surfaces.keys())) {
      const sf = this.surfaces.get(n)!;
      if (!seen.has(n) || !sf.el.isConnected || !sf.layer.isConnected) this.unmountSurface(n);
    }
  }

  private mountSurface(page: number, el: HTMLElement): void {
    const layer = el.createDiv('fleur-pdf-note-layer');
    const sf: PageSurface = {
      el,
      layer,
      notes: new Map(),
      resizeObs: new ResizeObserver(() => this.positionPageNotes(sf)),
    };
    sf.resizeObs.observe(el);
    this.surfaces.set(page, sf);
    this.renderPage(page);
  }

  private unmountSurface(page: number): void {
    const sf = this.surfaces.get(page);
    if (!sf) return;
    sf.resizeObs.disconnect();
    sf.layer.remove();
    this.surfaces.delete(page);
  }

  /* ------------------------------ 几何换算 ------------------------------ */

  /** 当前页的缩放比（viewport.scale 优先，CSS 变量兜底）。 */
  private scaleFor(page: number): number {
    try {
      const s = this.viewer?.getPageView?.(page - 1)?.viewport?.scale;
      if (typeof s === 'number' && s > 0) return s;
    } catch {
      /* 页未渲染时 getPageView 可能抛，走 CSS 变量 */
    }
    const f = this.plugin.inkEngine.getScaleFactor();
    return f > 0 ? f : 1;
  }

  /** 该页在 scale=1 下的可用宽高（CSS px）。 */
  private pageSize(sf: PageSurface, scale: number): { w: number; h: number } {
    return { w: sf.el.clientWidth / scale, h: sf.el.clientHeight / scale };
  }

  private applyGeometry(note: PDFNote, el: HTMLElement, scale: number): void {
    // 审核规则 obsidianmd/no-static-styles-assignment：不直接写 el.style，统一走 setCssStyles；
    // 折叠态的 width:auto / height:22px 交给 .is-collapsed 的 CSS 规则（这里清空展开态
    // 留下的行内尺寸，规则才能生效），展开尺寸在数据里原样记忆，展开即恢复。
    if (note.collapsed === true) {
      el.setCssStyles({
        left: `${note.x * scale}px`,
        top: `${note.y * scale}px`,
        width: '',
        height: '',
      });
    } else {
      el.setCssStyles({
        left: `${note.x * scale}px`,
        top: `${note.y * scale}px`,
        width: `${note.w * scale}px`,
        height: `${note.h * scale}px`,
      });
    }
  }

  /** 缩放后重定位该页全部便签（只改样式，不动数据）。 */
  private positionPageNotes(sf: PageSurface): void {
    const pageEl = sf.el;
    const n = Number(pageEl.dataset.pageNumber);
    if (!Number.isFinite(n)) return;
    const scale = this.scaleFor(n);
    for (const note of this.notes) {
      if (note.page !== n) continue;
      const el = sf.notes.get(note.id);
      if (el) this.applyGeometry(note, el, scale);
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  /** 重建某一页的全部便签（数据变化 / 页面重挂时调用）。 */
  private renderPage(page: number): void {
    const sf = this.surfaces.get(page);
    if (!sf) return;
    sf.layer.empty();
    sf.notes.clear();
    const scale = this.scaleFor(page);
    for (const note of this.notes) {
      if (note.page !== page) continue;
      const el = this.buildNoteEl(note, sf);
      this.applyGeometry(note, el, scale);
      sf.layer.appendChild(el);
      sf.notes.set(note.id, el);
    }
  }

  private buildNoteEl(note: PDFNote, sf: PageSurface): HTMLElement {
    const el = sf.layer.createDiv('fleur-pdf-note');
    el.dataset.noteId = note.id;
    if (note.collapsed === true) el.addClass('is-collapsed');

    const bar = el.createDiv('fleur-pdf-note-bar');
    // 折叠摘要（仅折叠态可见）：定宽 + 首行截断省略（CSS 负责），加载即刷文案
    const preview = bar.createDiv('fleur-pdf-note-preview');
    if (note.collapsed === true) {
      const line = note.text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
      preview.setText(line || '（空白便签）');
    }
    const fold = bar.createDiv('fleur-pdf-note-fold');
    setIcon(fold, note.collapsed === true ? 'chevron-right' : 'chevron-down');
    fold.setAttribute('aria-label', '折叠 / 展开便签');
    fold.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.yieldsToInk((e as PointerEvent).pointerType)) return;
      this.toggleFold(note, el);
    });
    const del = bar.createDiv('fleur-pdf-note-del fleur-pdf-ink-switch-btn');
    setIcon(del, 'x');
    del.setAttribute('aria-label', '删除便签');
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.yieldsToInk((e as PointerEvent).pointerType)) return;
      this.removeNote(note.id);
    });

    const ta = el.createEl('textarea', { cls: 'fleur-pdf-note-text' });
    ta.placeholder = '写点什么…';
    ta.value = note.text;
    ta.addEventListener('input', () => {
      note.text = ta.value;
    });
    ta.addEventListener('blur', () => void this.persist());
    // 文本编辑区的指针事件不外溢（pdf.js / patcher 都不该看到它）；
    // 手写模式下 pen/手指要外溢给引擎落墨，只有鼠标（或编辑模式）才吞掉
    ta.addEventListener('pointerdown', (e) => {
      if (!this.yieldsToInk(e.pointerType)) e.stopPropagation();
    });

    const grip = el.createDiv('fleur-pdf-note-resize');

    this.attachDrag(bar, note, el);
    this.attachResize(grip, note, el, sf);
    return el;
  }

  /** 折叠 / 展开：换类 + 换箭头 + 刷摘要 + 重算几何 + 落盘。 */
  private toggleFold(note: PDFNote, el: HTMLElement): void {
    note.collapsed = note.collapsed !== true;
    const folded = note.collapsed === true;
    el.toggleClass('is-collapsed', folded);
    const fold = el.querySelector<HTMLElement>('.fleur-pdf-note-fold');
    if (fold) setIcon(fold, folded ? 'chevron-right' : 'chevron-down');
    if (folded) this.updatePreview(note, el);
    this.applyGeometry(note, el, this.scaleFor(note.page));
    void this.persist();
  }

  /** 摘要 = 第一段非空行；空便签给占位语。 */
  private updatePreview(note: PDFNote, el: HTMLElement): void {
    const pv = el.querySelector<HTMLElement>('.fleur-pdf-note-preview');
    if (!pv) return;
    const line = note.text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    pv.setText(line || '（空白便签）');
  }

  /* ------------------------------ 交互 ------------------------------ */

  /**
   * 手写模式下便签对非鼠标指针让位（overlay-engine.surfaceOfEvent 会把
   * pen/touch 放行给书写/滚动）：这里同步不吞事件、不进拖拽/缩放/点击流程，
   * 保证笔迹能穿过便签落墨、便签不会被笔尖误拖误删。鼠标不受影响。
   */
  private yieldsToInk(pointerType: string | undefined): boolean {
    return (
      document.body.classList.contains('fleur-pdf-ink-active') && pointerType !== 'mouse'
    );
  }

  /** 顶栏拖拽移动。位移 <4px 一律当点击，不写盘；折叠键/删除键是独立点击目标。 */
  private attachDrag(bar: HTMLElement, note: PDFNote, el: HTMLElement): void {
    bar.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.yieldsToInk(e.pointerType)) return;
      if ((e.target as HTMLElement | null)?.closest('.fleur-pdf-note-del, .fleur-pdf-note-fold')) return;
      const sf = this.surfaces.get(note.page);
      if (!sf) return;
      e.preventDefault();
      e.stopPropagation();
      const scale = this.scaleFor(note.page);
      const { w: pageW, h: pageH } = this.pageSize(sf, scale);
      // 折叠态实际占位只有横条高 + 摘要芯片宽（不是存储的展开尺寸），
      // 钳制按实际渲染尺寸算，否则右侧/底部会留一大段"拖不过去"的死区
      const effH = note.collapsed === true ? NOTE_FOLD_H / scale : note.h;
      const effW = note.collapsed === true ? el.offsetWidth / scale : note.w;
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = note.x;
      const oy = note.y;
      let moved = false;
      try {
        bar.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不拦拖动本身 */
      }
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true;
        note.x = Math.max(0, Math.min(ox + (ev.clientX - sx) / scale, Math.max(0, pageW - effW)));
        note.y = Math.max(0, Math.min(oy + (ev.clientY - sy) / scale, Math.max(0, pageH - effH)));
        this.applyGeometry(note, el, this.scaleFor(note.page));
      };
      const onUp = () => {
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        bar.removeEventListener('pointercancel', onUp);
        if (moved) void this.persist();
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    });
  }

  /** 右下角把手自由缩放。夹在 [MIN, 页宽/高 - 位置] 之间。 */
  private attachResize(grip: HTMLElement, note: PDFNote, el: HTMLElement, sf: PageSurface): void {
    grip.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.yieldsToInk(e.pointerType)) return;
      e.preventDefault();
      e.stopPropagation();
      const scale = this.scaleFor(note.page);
      const { w: pageW, h: pageH } = this.pageSize(sf, scale);
      const sx = e.clientX;
      const sy = e.clientY;
      const ow = note.w;
      const oh = note.h;
      let moved = false;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* 同上 */
      }
      const onMove = (ev: PointerEvent) => {
        moved = true;
        note.w = Math.max(NOTE_MIN_W, Math.min(ow + (ev.clientX - sx) / scale, Math.max(NOTE_MIN_W, pageW - note.x)));
        note.h = Math.max(NOTE_MIN_H, Math.min(oh + (ev.clientY - sy) / scale, Math.max(NOTE_MIN_H, pageH - note.y)));
        this.applyGeometry(note, el, this.scaleFor(note.page));
      };
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onUp);
        if (moved) void this.persist();
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onUp);
    });
  }

  /* ------------------------------ 增删 ------------------------------ */

  /** 删除一张便签（无确认弹窗：自己的数据，一键为准）。 */
  private removeNote(id: string): void {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return;
    this.notes = this.notes.filter((n) => n.id !== id);
    this.surfaces.get(note.page)?.notes.get(id)?.remove();
    this.surfaces.get(note.page)?.notes.delete(id);
    void this.persist();
  }

  /** 当前视口里最靠中间的一页（找不到就退回第一页）。 */
  private visiblePage(): number {
    if (!this.root) return 1;
    const midY = window.innerHeight / 2;
    let best = 1;
    let bestDist = Infinity;
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('.page[data-page-number]'))) {
      const n = Number(el.dataset.pageNumber);
      if (!Number.isFinite(n) || n < 1) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const dist = Math.abs((r.top + r.bottom) / 2 - midY);
      if (dist < bestDist) {
        bestDist = dist;
        best = n;
      }
    }
    return best;
  }

  /** 在可见页中心新建便签并直接进入编辑。 */
  async addNote(): Promise<void> {
    if (!this.enabled) return;
    if (!this.pdfPath || !this.root) await this.sync();
    if (!this.pdfPath) {
      new Notice('请先打开一个 PDF 再贴便签', 3000);
      return;
    }
    const page = this.visiblePage();
    const sf = this.surfaces.get(page);
    const scale = this.scaleFor(page);
    let pageW = NOTE_DEFAULT_W + 80;
    let pageH = NOTE_DEFAULT_H + 80;
    if (sf) {
      const size = this.pageSize(sf, scale);
      pageW = size.w;
      pageH = size.h;
    }
    const note: PDFNote = {
      id: mintNoteId(),
      page,
      x: Math.max(0, (pageW - NOTE_DEFAULT_W) / 2),
      y: Math.max(0, (pageH - NOTE_DEFAULT_H) / 2),
      w: NOTE_DEFAULT_W,
      h: NOTE_DEFAULT_H,
      text: '',
      createdAt: Date.now(),
    };
    this.notes.push(note);
    this.renderPage(page);
    await this.persist();
    const dom = this.surfaces.get(page)?.notes.get(note.id);
    (dom?.querySelector('.fleur-pdf-note-text') as HTMLTextAreaElement | null)?.focus();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  private async persist(): Promise<void> {
    if (!this.pdfPath) return;
    try {
      await this.store.save(this.pdfPath, { notes: this.notes, exportPath: this.exportPath });
    } catch (err) {
      // 写盘失败不打断使用（下次改动会再试）；真机排查看控制台
      console.warn('[FleurPDF Notes] 落盘失败:', err);
    }
  }
}
