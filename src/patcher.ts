// PDF 视图拦截 + 右键菜单 + 批注气泡
// ── 文本锚点架构 ──
// 核心原则：标注的"身份"是「文本 + 页码范围」，不是 DOM 节点引用。
// 初始高亮与恢复高亮走同一套文本定位管线：
//   1. 选区 → 按 Range∩页面 交集切分出"每页选中了哪些文字"
//   2. 每页内：DOM 交集遍历定位 segments；失败则降级为文本匹配
//   3. 应用时 segments 若已失效（节点被 PDF.js 重渲染），按页内文本重新匹配
//   4. 恢复时：跨页标注先按页切分文本，再逐页匹配
import { Menu, Modal, Notice, setIcon } from 'obsidian';
import type FleurPDFPlugin from './main';
import type { Annotation } from './types';
import { AIChatPanel } from './ai-chat-modal';
import { markdownToPlain } from './md-utils';
import { normalizeWhitespace } from './text-utils';
import { isMobileUI } from './platform';

type UnderlineStyle = 'solid' | 'wavy';

interface CommentBubble {
  el: HTMLElement;
}

/** 选中文本的片段信息 */
interface TextSegment {
  textNode: Text;
  start: number;
  end: number;
}

/** 单页的选区信息：该页上被选中的文字 + 对应的 DOM segments */
interface PageSelection {
  page: number;
  text: string;
  segments: TextSegment[];
}

/** 选区快照 — mouseup 时构建，右键时优先用活选区重建、其次用快照 */
interface SelectionSnapshot {
  text: string;
  pageNum: number;
  endPage?: number;
  timestamp: number;
  pages: PageSelection[];
}

/**
 * 计算选区起点在页面内的相对位置（归一化到 0-1，与缩放无关），供「按行文顺序」排序使用。
 * 定位不到时返回 undefined，此时该条标注退化为按时间排序。
 */
function computeSelectionPos(pages: PageSelection[]): { top: number; left: number } | undefined {
  for (const ps of pages) {
    for (const seg of ps.segments) {
      const node = seg.textNode;
      if (!node.isConnected || !node.parentElement) continue;
      const pageEl = node.parentElement.closest<HTMLElement>('.page');
      if (!pageEl) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      const pr = pageEl.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (pr.height === 0 || pr.width === 0) continue;
      return {
        top: (r.top - pr.top) / pr.height,
        left: (r.left - pr.left) / pr.width,
      };
    }
  }
  return undefined;
}

// ── SVG 图标辅助（替代 innerHTML，避免审核 Error）──

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgIcon(
  container: Node,
  stroke: string,
  paths: Array<{ tag: string; attrs: Record<string, string> }>
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', stroke);
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const p of paths) {
    const el = document.createElementNS(SVG_NS, p.tag);
    for (const [k, v] of Object.entries(p.attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  container.appendChild(svg);
  return svg;
}

function iconCopy(c: Node) {
  return svgIcon(c, 'currentColor', [
    { tag: 'rect', attrs: { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' } },
    { tag: 'path', attrs: { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' } },
  ]);
}
/** 是否处于移动端 UI（真机移动端，或桌面开启了「预览移动端形态」）。
 *  图标 / 面板 DOM 的移动端专属差异一律以此门控，保证桌面端与 1.5.15 逐字节同构。 */
function isMobileBody(): boolean {
  return document.body.classList.contains('fleur-pdf-mobile');
}
/** 划线图标：描边用「用户的划线颜色」。该颜色是为与画到正文上的线保持一致而设的
 *  （默认 #6B0000 深红），但在深色主题下会融进背景，看上去像「图标没显示」——
 *  加一个 class 让 CSS 补浅色衬底，保住颜色语义的同时确保任何主题下都看得见。
 *  ⚠️ 仅移动端加类：桌面端保持 1.5.15 的原始渲染。 */
function iconUnderlineSolid(c: Node, color: string) {
  const svg = svgIcon(c, color, [
    { tag: 'line', attrs: { x1: '3', y1: '18', x2: '21', y2: '18' } },
  ]);
  if (isMobileBody()) svg.classList.add('fleur-context-ul');
  return svg;
}
function iconUnderlineWavy(c: Node, color: string) {
  return svgIcon(c, color, [
    { tag: 'path', attrs: { d: 'M3 18 Q6 12, 9 18 T15 18 T21 18' } },
  ]);
}
function iconComment(c: Node) {
  return svgIcon(c, 'currentColor', [
    { tag: 'path', attrs: { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' } },
  ]);
}
function iconAI(c: Node) {
  return svgIcon(c, 'currentColor', [
    { tag: 'path', attrs: { d: 'M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22' } },
    { tag: 'path', attrs: { d: 'M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93' } },
    { tag: 'path', attrs: { d: 'M8 6h8' } },
    { tag: 'path', attrs: { d: 'M9 10h6' } },
    { tag: 'path', attrs: { d: 'M10 14h4' } },
    { tag: 'path', attrs: { d: 'M11 18h2' } },
  ]);
}
function iconEraser(c: Node) {
  return svgIcon(c, 'currentColor', [
    { tag: 'path', attrs: { d: 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21' } },
    { tag: 'path', attrs: { d: 'M22 21H7' } },
    { tag: 'path', attrs: { d: 'm5 11 9 9' } },
  ]);
}
function iconTranslate(c: Node) {
  return svgIcon(c, 'currentColor', [
    { tag: 'path', attrs: { d: 'M5 8l6 6' } },
    { tag: 'path', attrs: { d: 'M4 14l6-6 2-3' } },
    { tag: 'path', attrs: { d: 'M2 5h12' } },
    { tag: 'path', attrs: { d: 'M7 2v3' } },
    { tag: 'path', attrs: { d: 'M22 22l-5-10-5 10' } },
    { tag: 'path', attrs: { d: 'M14 18h6' } },
  ]);
}

export class PDFPatcher {
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;
  private boundMouseDown: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;
  private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
  /** 移动端：选中文字后自动唤出批注菜单（桌面端走右键，不挂这些监听）。 */
  private boundSelectionChange: (() => void) | null = null;
  private selectionMenuTimer: number | null = null;
  /** 移动端：点按已有标注（无选区）→ 弹清除菜单。 */
  private boundAnnotationTap: ((e: MouseEvent) => void) | null = null;
  /**
   * 选区静置多久才算「选完了」。
   *
   * ⚠️ 0.5 起**照搬 FleurEPUB 的 300ms**，不再自创参数。
   *
   * 0.4.4 走过一条弯路：900ms 去抖 + 「手势静默期」(touchSelecting) + 「选区一变
   * 就先收掉面板」三道叠加。真机反而更差 —— 拖动过程中面板被反复收放、闪烁，
   * 观感就是「菜单乱弹、没选完就弹」。而且「手势静默期」在 Android WebView 上
   * 根本是无效复杂度：拖原生选择手柄时页面收不到 touch 事件，那些标志位全程为假。
   *
   * FleurEPUB 那套（用户真机验证过的手感）只有两条规则，本类现在与它一字不差：
   *   ① 每次 selectionchange 都重置去抖计时器 ⇒ 只有**停手** 300ms 才判定，
   *      拖动途中绝不弹；
   *   ② 判定时：有选区 → 弹/保持；没选区且面板已显示超过 350ms → 收起
   *      （350ms 宽限期用来避开「刚弹出就收到 collapse」的收尾竞态）。
   */
  /**
   * 去抖时长。0.5 是 300ms（FleurEPUB 同构），0.6.0 真机（小米平板）反馈：
   * 菜单弹出来的时候，系统选区两端的拖拽滑杆还没就位 —— 滑杆比选区文字晚出现，
   * 而菜单先弹，观感就是「太快了」。Android 上滑杆出现没有可监听的事件，
   * 只能把去抖放宽到 600ms 给它留时间。拖动选择手柄期间 selectionchange
   * 连续派发、计时器不断重置，拖动全程依旧不会弹菜单。
   */
  private static readonly SELECTION_SETTLE_MS = 600;
  /**
   * 当前面板若是「选区自动唤起」的，记下它对应的选区指纹；否则为空串。
   *
   * 由 hideContextMenu 统一清空。保留原因：供后续判断「面板是否由选区自动唤起」
   * （例如自定义编辑器之外的地方要区分自动面板与标注编辑面板）。
   */
  private openAutoKey = '';
  /** 最近一次自动弹出的选区指纹 —— 同一选区不重复弹。 */
  private lastAutoMenuKey = '';
  /** 当前打开的浮动面板（同一时刻只允许一个，选区连续变化时会重建）。 */
  private openPanel: HTMLElement | null = null;
  /** 当前面板「点击外部关闭」的监听器，由 hideContextMenu 统一摘除。 */
  private contextMenuCloser: ((e: Event) => void) | null = null;
  /** 面板最近一次显示的时刻：选区清空后要等 350ms 才收，避免拖手柄时闪掉。 */
  private contextMenuShownAt = 0;
  /** 面板请求的代际号：让 await 期间被超越的旧请求自行作废（见 showContextMenu）。 */
  private contextMenuEpoch = 0;
  private commentBubbles: CommentBubble[] = [];
  private lastSnapshot: SelectionSnapshot | null = null;
  /** 快照有效期：活选区被清空后，右键仍可用最近一次选区 */
  private static readonly SNAPSHOT_TTL_MS = 10000;

  // ── 标注恢复相关 ──
  private currentPagePath: string | null = null;
  private restoreTimer: number | null = null;
  private pdfViewerObserver: MutationObserver | null = null;
  private pdfResizeObserver: ResizeObserver | null = null;
  /** 当前排队中的 restore 目标路径（防止外部事件打断重试链） */
  private scheduledRestorePath: string | null = null;
  /** 「渲染完成」唤醒观察器：重试链给完预算后，textLayer 真正填充文本时再触发一轮恢复 */
  private textLayerWakeObserver: MutationObserver | null = null;
  private textLayerWakeTimer: number | null = null;
  /** 恢复代际：删除标注时 +1，使所有在途恢复（拿着删除前的旧数据）在下个检查点自行中止，
   *  防止已被删除的高亮/划线被在途恢复重新画回原文 */
  private restoreEpoch = 0;

  constructor(private plugin: FleurPDFPlugin) {}

  /** 使所有在途与排队的恢复立即失效（删除标注时调用，先于任何 await） */
  invalidateRestoreState() {
    this.restoreEpoch++;
    this.cancelPendingRestore();
  }

  install() {
    console.log('[FleurPDF] patcher installed (text-anchored v2)');

    this.boundContextMenu = (e: MouseEvent) => this.onContextMenu(e);
    this.boundMouseDown = (e: MouseEvent) => this.onMouseDown(e);
    this.boundMouseUp = (e: MouseEvent) => this.onMouseUp(e);
    // Esc 清除检索定位高亮
    this.boundKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.flashSpans.length > 0) this.clearSearchFlash();
    };

    document.addEventListener('contextmenu', this.boundContextMenu, true);
    document.addEventListener('mousedown', this.boundMouseDown, true);
    document.addEventListener('mouseup', this.boundMouseUp, true);
    document.addEventListener('keydown', this.boundKeyDown, true);

    // 移动端：长按选字会被 WebView 的原生文本选择接管，`contextmenu` 不派发，
    // 于是批注菜单永远不出现（真机 0.3.0 反馈：选中了文字，但没有任何菜单）。
    // 改用 `selectionchange` 驱动 —— 选区**停手 300ms** 后自动弹出，与手势类型无关。
    // 桌面端保持右键语义，不挂这个监听。
    //
    // ⚠️ 只挂这一个监听，与 FleurEPUB 一字不差。0.4.4 曾额外挂 touchstart/move/end
    // 做「手势静默期」，但拖原生选择手柄时 WebView 根本不向页面派发这些事件，
    // 那些标志位在真机恒为假 —— 除增加复杂度外没有任何作用，已全部移除。
    if (isMobileUI(this.plugin)) {
      this.boundSelectionChange = () => this.onSelectionChange();
      document.addEventListener('selectionchange', this.boundSelectionChange);
      // 移动端「点按已有标注 → 清除菜单」：真机反馈在移动端没有右键入口，
      // 已有的高亮 / 划线 / 批注清除不出去（只能进侧边栏删）。点按是第二入口。
      this.boundAnnotationTap = (e: MouseEvent) => this.onAnnotationTap(e);
      document.addEventListener('click', this.boundAnnotationTap, true);
    }

    // 监听 file-open（文件切换时触发）
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file?.extension === 'pdf') {
          // 切换到（或重新打开）某 PDF：使在途恢复失效（含旧文件的僵尸重试链），
          // 保证本次恢复从干净的 attempt 0 开始，且旧文件的在途恢复不会画到新文件上
          this.invalidateRestoreState();
          this.currentPagePath = file.path;
          this.scheduleRestore(file.path);
          this.startPdfViewerWatcher();
        } else {
          this.currentPagePath = null;
          this.invalidateRestoreState();
          this.stopPdfViewerWatcher();
        }
      })
    );

    // 监听 active-leaf-change（切换 tab 回来时也触发）
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
        const file = (leaf?.view as any)?.file;
        if (file?.extension === 'pdf') {
          if (file.path !== this.currentPagePath) {
            this.invalidateRestoreState();
            this.currentPagePath = file.path;
            this.startPdfViewerWatcher();
          }
          this.scheduleRestore(file.path);
        }
      })
    );

    // 在 body 上监听 PDF viewer 容器出现
    const bodyWatcher = new MutationObserver(() => {
      if (this.currentPagePath && document.querySelector('.pdf-viewer, .pdf-scroll-container, .pdf-container, .pdfViewer')) {
        this.startPdfViewerWatcher();
      }
    });
    bodyWatcher.observe(document.body, { childList: true, subtree: true });
  }

  private stopPdfViewerWatcher() {
    if (this.pdfViewerObserver) {
      this.pdfViewerObserver.disconnect();
      this.pdfViewerObserver = null;
    }
    if (this.pdfResizeObserver) {
      this.pdfResizeObserver.disconnect();
      this.pdfResizeObserver = null;
    }
    this.stopTextLayerWake();
  }

  /** 用 MutationObserver 直接监听 PDF viewer 容器内的 .page 元素变化 */
  private startPdfViewerWatcher() {
    this.stopPdfViewerWatcher();

    const container = document.querySelector('.pdf-viewer, .pdf-scroll-container, .pdf-container, .pdfViewer');
    if (!container) return;

    this.pdfViewerObserver = new MutationObserver((mutations) => {
      const hasNewPages = mutations.some(m =>
        m.type === 'childList' &&
        Array.from(m.addedNodes).some(node =>
          (node as HTMLElement).classList?.contains('page') ||
          (node as HTMLElement).querySelector?.('.page')
        )
      );

      if (hasNewPages && this.currentPagePath) {
        this.scheduleRestore(this.currentPagePath);
      }
    });

    this.pdfViewerObserver.observe(container, { childList: true, subtree: true });

    // 新增：监听容器宽度变化（侧边栏收起/展开会改变 PDF 容器尺寸，触发 PDF.js 重渲染）
    this.pdfResizeObserver = new ResizeObserver(() => {
      if (this.currentPagePath) {
        this.scheduleRestore(this.currentPagePath);
      }
    });
    this.pdfResizeObserver.observe(container);
  }

  /** 等待 PDF 页面的 textLayer 真正有文本内容后再恢复 */
  private async waitForTextLayer(pageEl: HTMLElement, maxWait = 8000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const textLayer = pageEl.querySelector('.textLayer') as HTMLElement;
      if (textLayer && (textLayer.textContent || '').trim().length > 0) {
        return true;
      }
      await new Promise((r) => window.setTimeout(r, 300));
    }
    return false;
  }

  /** 延迟去抖后触发恢复（等待 PDF.js 渲染完成）。
   *  互斥规则：attempt 0 由外部事件（resize / 新页 / 切文件）发起，若已有排队中的
   *  restore（重试链进行中），同文件时忽略不打断 —— 否则重试链永远到不了
   *  MAX_ATTEMPTS 停止条件，控制台会无限刷屏。内部重试（attempt>0）始终覆盖旧任务。 */
  private scheduleRestore(filePath: string, attempt = 0) {
    if (this.restoreTimer) {
      if (attempt === 0 && this.scheduledRestorePath === filePath) {
        return; // 外部事件不打断已排队的重试链
      }
      window.clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.scheduledRestorePath = filePath;
    // 指数退避：500ms → 1s → 2s → 3s → 5s
    const delays = [500, 1000, 2000, 3000, 5000];
    const delay = delays[Math.min(attempt, delays.length - 1)];
    this.restoreTimer = window.setTimeout(() => {
      this.restoreTimer = null;
      this.scheduledRestorePath = null;
      void this.restoreAnnotationsForFile(filePath, attempt);
    }, delay);
  }

  /** 清掉排队中的 restore（关闭/切换文件时调用，避免旧文件的僵尸重试链
   *  吞掉重新打开时的恢复请求——互斥规则会忽略同路径的 attempt 0） */
  private cancelPendingRestore() {
    if (this.restoreTimer) {
      window.clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.scheduledRestorePath = null;
    this.stopTextLayerWake();
  }

  /**
   * 重试链给完预算仍失败时，挂一个"渲染完成"唤醒器：
   * pdf.js 的 textLayer 是页面元素先建、文本异步填充的；若页面已存在但文本
   * 迟迟未就绪（字体加载 / 离屏渲染慢），页面新增事件不会再触发，恢复会永久躺平。
   * 观察 textLayer 内容变更，一旦文本真正填充 → 断开并重新触发一轮恢复。
   * 每次渲染脉冲只触发一轮有界重试链，不会回到 v1.5.6 的无限刷屏。
   */
  private stopTextLayerWake() {
    if (this.textLayerWakeTimer) {
      window.clearTimeout(this.textLayerWakeTimer);
      this.textLayerWakeTimer = null;
    }
    if (this.textLayerWakeObserver) {
      this.textLayerWakeObserver.disconnect();
      this.textLayerWakeObserver = null;
    }
  }

  private armTextLayerWake(filePath: string) {
    this.stopTextLayerWake();
    const container = document.querySelector('.pdf-viewer, .pdf-scroll-container, .pdf-container, .pdfViewer');
    if (!container) return;
    const fire = () => {
      this.stopTextLayerWake();
      this.scheduleRestore(filePath, 0);
    };
    this.textLayerWakeObserver = new MutationObserver((mutations) => {
      const textFilled = mutations.some((m) => {
        const el = m.target as HTMLElement;
        if (!el || el.nodeType !== Node.TEXT_NODE && !(el as HTMLElement).closest) return false;
        const tl = (el.closest ? (el.closest('.textLayer') as HTMLElement | null) : (el.parentElement?.closest?.('.textLayer') as HTMLElement | null));
        if (!tl) return false;
        // 只在文本层真的有了内容（且比触发前多）时才认为渲染完成
        const cur = (tl.textContent || '').trim().length;
        return cur > 0 && cur > (this._wakeBaseline?.get(tl) ?? 0);
      });
      if (textFilled) {
        // 去抖：渲染过程中文本层会连续更新，等稳定一拍再触发
        if (this.textLayerWakeTimer) window.clearTimeout(this.textLayerWakeTimer);
        this.textLayerWakeTimer = window.setTimeout(fire, 400);
      }
    });
    this._wakeBaseline = new Map();
    container.querySelectorAll('.textLayer').forEach((tl) => {
      this._wakeBaseline!.set(tl, (tl.textContent || '').trim().length);
      this.textLayerWakeObserver!.observe(tl, { childList: true, characterData: true, subtree: true });
    });
  }
  /** textLayer 唤醒器的内容基线（避免对已有内容误触发） */
  private _wakeBaseline: Map<Element, number> | null = null;

  /** 手动触发：命令「重新渲染当前 PDF 的标注」 */
  restoreNow(): void {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file || file.extension !== 'pdf') {
      new Notice('当前活动文件不是 PDF');
      return;
    }
    this.currentPagePath = file.path;
    this.startPdfViewerWatcher();
    // 用户显式操作优先：清掉排队中的重试链，避免被 scheduleRestore 的互斥规则吞掉
    this.cancelPendingRestore();
    this.scheduleRestore(file.path, 0);
    new Notice('正在重新渲染标注…');
  }

  /** 诊断当前 PDF 的 DOM 结构（不依赖控制台，直接弹 Notice） */
  diagnose(): void {
    const file = this.plugin.app.workspace.getActiveFile();
    const viewer = document.querySelector('.pdf-viewer, .pdf-scroll-container, .pdf-container, .pdfViewer');
    const pages = Array.from(document.querySelectorAll('.page')) as HTMLElement[];
    const withText = pages.filter(p => {
      const tl = p.querySelector('.textLayer');
      return tl && (tl.textContent || '').trim().length > 0;
    });
    const nums = pages.map(p => p.getAttribute('data-page-number')).filter(Boolean);

    const lines: string[] = [];
    lines.push(`文件：${file?.path ?? '（无活动文件）'}`);
    lines.push(`PDF 容器：${viewer ? '已找到' : '未找到'}`);
    lines.push(`.page 元素：${pages.length} 个（含文本 ${withText.length} 个）`);
    lines.push(`页码属性：${nums.length ? nums.slice(0, 20).join('，') : '⚠️ 无 data-page-number'}`);

    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const pr = this.getPageRangeFromRange(range);
      lines.push(`当前选区：${sel.toString().trim().length} 字符`);
      lines.push(`选区页码范围：${pr ? `${pr.start} → ${pr.end}` : '⚠️ 无法确定（选区可能不在页面内）'}`);
      if (pr) {
        const pageSel = this.getSelectionPages(range, pr.start, pr.end);
        lines.push(`按页切分：${pageSel.map(ps => `第${ps.page}页 ${ps.text.trim().length}字/${ps.segments.length}段`).join('；') || '⚠️ 空'}`);
      }
    } else {
      lines.push('当前选区：无（请先选中文字再运行诊断）');
    }

    const msg = lines.join('\n');
    console.log('[FleurPDF] 诊断报告\n' + msg);
    new Notice(msg, 12000);
  }

  /** 为当前 PDF 文件恢复所有已保存的标注 */
  async restoreAnnotationsForFile(filePath: string, attempt = 0): Promise<void> {
    const epoch = this.restoreEpoch;
    const data = await this.plugin.store.load(filePath);
    // 数据加载期间发生了删除（或文件切换）：本次持有的 data 已过期，立即中止
    if (epoch !== this.restoreEpoch) return;
    if (!data.annotations || data.annotations.length === 0) return;

    const MAX_ATTEMPTS = 6;
    let restored = 0;
    let needsRetry = false;

    for (const ann of data.annotations) {
      const startPage = ann.page;
      const endPage = ann.endPage || ann.page;

      // ── 跨页标注：先把标注文本按页切分，再逐页匹配 ──
      let pagePortions: Array<{ page: number; text: string }>;
      if (endPage > startPage) {
        const split = this.splitAnnotationTextByPage(ann.text, startPage, endPage);
        pagePortions = Array.from(split.entries()).map(([page, text]) => ({ page, text }));
        if (pagePortions.length === 0) {
          needsRetry = true;
          continue;
        }
      } else {
        pagePortions = [{ page: startPage, text: ann.text }];
      }

      const allSegments: TextSegment[] = [];
      let firstPageEl: HTMLElement | null = null;
      let anyPageProcessed = false;

      for (const { page, text } of pagePortions) {
        const pageEl = this.findPageByNumber(page);
        if (!pageEl) {
          needsRetry = true;
          continue;
        }

        // 等待 textLayer 渲染完成（每次 attempt 都等：首轮 5s，重试轮 1.5s——
        // 若只首轮等待，页面晚渲染时后续 attempt 直接读到空文本，永久 0/7）
        const ready = await this.waitForTextLayer(pageEl, attempt === 0 ? 5000 : 1500);
        // 等待期间发生了删除：data 已过期，绝不能再把这些标注画回去
        if (epoch !== this.restoreEpoch) return;
        if (!ready) {
          needsRetry = true;
          continue;
        }

        const textLayer = pageEl.querySelector('.textLayer') as HTMLElement;
        if (!textLayer) {
          needsRetry = true;
          continue;
        }
        if ((textLayer.textContent || '').trim().length === 0) {
          needsRetry = true;
          continue;
        }

        // 逐页幂等：该页已有此标注则跳过，不跳过其他页
        if (pageEl.querySelector(`[data-ann-id="${ann.id}"]`)) {
          if (!firstPageEl) firstPageEl = pageEl;
          continue;
        }

        if (!firstPageEl) {
          firstPageEl = pageEl;
        }

        allSegments.push(...this._collectByTextMatch(text, textLayer));
        anyPageProcessed = true;
      }

      if (allSegments.length === 0) {
        if (anyPageProcessed) {
          // 所有页都已恢复过，不需要重试
        } else if (firstPageEl) {
          // 所有页的高亮都已存在（逐页幂等通过），尝试恢复气泡
          const existingSpan = firstPageEl.querySelector(`[data-ann-id="${ann.id}"]`);
          if (existingSpan && ann.comment) {
            this.addCommentBubble(ann.comment, existingSpan as HTMLElement, firstPageEl, ann.id);
          }
        } else {
          // 降噪：只在首轮打印，重试轮不刷屏
          if (attempt === 0) {
            console.log('[FleurPDF] restore: no segments for', ann.id, 'attempt', attempt);
          }
          needsRetry = true;
        }
        continue;
      }

      if (ann.type === 'highlight' || ann.type === 'comment') {
        const hlColor = ann.color || '#FFC107';
        allSegments.forEach((seg) => {
          this.wrapAndStyle(seg, (el) => {
            el.setCssStyles({ background: hlColor });
            el.addClass('fleur-highlight');
            el.dataset['annId'] = ann.id;
          });
        });

        // 恢复批注气泡（只在第一页显示）
        // 兜底：只要有 comment 字段就恢复（兼容历史 AI 批注 type 仍为 'highlight' 的情况）
        if (ann.comment && firstPageEl) {
          const firstSpan = this.findAnnotationSpan(firstPageEl, ann.id);
          if (firstSpan) {
            this.addCommentBubble(ann.comment, firstSpan, firstPageEl, ann.id);
          }
        }
      } else if (ann.type === 'underline') {
        const ulColor = ann.color || '#E8590C';
        allSegments.forEach((seg) => {
          this.wrapAndStyle(seg, (el) => {
            // 按数据渲染 wavy / solid；移动端由 CSS 覆盖（body.fleur-pdf-mobile
            // 下 wavy 一律按直线绘制，规避 Android 的 wavy 退化问题）。
            el.addClass('fleur-underline');
            el.addClass(ann.underlineStyle === 'wavy' ? 'fleur-underline-wavy' : 'fleur-underline-solid');
            el.setCssProps({ '--fleur-underline-color': ulColor });
            el.dataset['annId'] = ann.id;
          });
        });

        // 恢复批注气泡（下划线也可能有 AI 批注）
        if (ann.comment && firstPageEl) {
          const firstSpan = this.findAnnotationSpan(firstPageEl, ann.id);
          if (firstSpan) {
            this.addCommentBubble(ann.comment, firstSpan, firstPageEl, ann.id);
          }
        }
      }

      restored++;
    }
    console.log('[FleurPDF] restore done:', restored, '/', data.annotations.length, 'attempt', attempt);

    if (needsRetry && attempt < MAX_ATTEMPTS) {
      this.scheduleRestore(filePath, attempt + 1);
    } else if (needsRetry) {
      // 重试预算耗尽仍失败（多为离屏/晚渲染页面 textLayer 未就绪）：
      // 挂上「渲染完成」唤醒器，textLayer 真正填充时再触发一轮恢复
      this.armTextLayerWake(filePath);
    } else {
      this.stopTextLayerWake();
    }
  }

  /** 找到某个批注 ID 对应的第一个已标注 span */
  private findAnnotationSpan(pageEl: HTMLElement, annId: string): HTMLElement | null {
    const spans = pageEl.querySelectorAll(`[data-ann-id="${annId}"]`);
    return spans.length > 0 ? (spans[0] as HTMLElement) : null;
  }

  // ════════════════════════════════════════════
  //  选区捕获 — 文本锚点制
  // ════════════════════════════════════════════

  private findPageEl(target: Node | null): HTMLElement | null {
    if (!target) return null;
    const el = target.nodeType === Node.TEXT_NODE ? target.parentElement : target as HTMLElement;
    return el?.closest?.('.page') ?? null;
  }

  /** 页面元素 → 页码（无属性返回 null） */
  private pageNumber(pageEl: HTMLElement): number | null {
    const n = parseInt(pageEl.getAttribute('data-page-number') || '0', 10);
    return n > 0 ? n : null;
  }

  private isInPDFView(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return !!el.closest?.(
      '.pdf-viewer, .pdf-scroll-container, .page, .pdf-container, ' +
      '.pdf-embed, .pdf-viewer-container, .pdfViewer, ' +
      '[class*="pdf"], .workspace-leaf-content[data-type="pdf"]'
    );
  }

  private onMouseDown(_e: MouseEvent) {
    // 不在此处捕获 — 避免竞态
  }

  private onMouseUp(e: MouseEvent) {
    if (e.button !== 0) return;
    if (!this.isInPDFView(e.target)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const snapshot = this.buildSnapshotFromSelection(selection);
    if (snapshot) {
      this.lastSnapshot = snapshot;
      console.log('[FleurPDF] snapshot:',
        `p${snapshot.pageNum}${snapshot.endPage ? '-' + snapshot.endPage : ''}`,
        snapshot.pages.map(ps => `${ps.page}:${ps.segments.length}seg`).join(' '));
    }
  }

  /**
   * 从活选区构建快照：
   * 1. 确定 选区覆盖的页码范围（端点定位失败则扫描所有页面取交集）
   * 2. 每页：Range∩textLayer 交集 → 该页选中的文本 + DOM segments
   */
  private buildSnapshotFromSelection(selection: Selection): SelectionSnapshot | null {
    const text = selection.toString().trim();
    if (!text) return null;

    const range = selection.getRangeAt(0);
    const pageRange = this.getPageRangeFromRange(range);
    if (!pageRange) return null;

    const pages = this.getSelectionPages(range, pageRange.start, pageRange.end);
    return {
      text,
      pageNum: pageRange.start,
      endPage: pageRange.end > pageRange.start ? pageRange.end : undefined,
      timestamp: Date.now(),
      pages,
    };
  }

  /**
   * 确定选区覆盖的页码范围。
   * 优先用 Range 端点定位；端点不在 .page 内（跨页拖选时常落在容器上）时，
   * 扫描所有已渲染页面，取与 Range 相交的页面的最小/最大页码。
   */
  private getPageRangeFromRange(range: Range): { start: number; end: number } | null {
    const sp = this.findPageEl(range.startContainer);
    const ep = this.findPageEl(range.endContainer);
    if (sp && ep) {
      const s = this.pageNumber(sp);
      const e = this.pageNumber(ep);
      if (s && e) return { start: Math.min(s, e), end: Math.max(s, e) };
    }
    // 端点定位失败 → 扫描页面交集
    let min = Infinity;
    let max = -Infinity;
    document.querySelectorAll('.page').forEach((p) => {
      const el = p as HTMLElement;
      try {
        if (range.intersectsNode(el)) {
          const n = this.pageNumber(el);
          if (n) {
            min = Math.min(min, n);
            max = Math.max(max, n);
          }
        }
      } catch {
        // 忽略异常节点
      }
    });
    return max >= min ? { start: min, end: max } : null;
  }

  /** 两个 Range 的交集（无交集返回 null） */
  private intersectRanges(a: Range, b: Range): Range | null {
    const r = document.createRange();
    let sc: Node, so: number, ec: Node, eo: number;
    // 较晚的起点
    if (a.compareBoundaryPoints(Range.START_TO_START, b) >= 0) {
      sc = a.startContainer; so = a.startOffset;
    } else {
      sc = b.startContainer; so = b.startOffset;
    }
    // 较早的终点
    if (a.compareBoundaryPoints(Range.END_TO_END, b) <= 0) {
      ec = a.endContainer; eo = a.endOffset;
    } else {
      ec = b.endContainer; eo = b.endOffset;
    }
    try {
      r.setStart(sc, so);
      r.setEnd(ec, eo);
    } catch {
      return null;
    }
    return r.collapsed ? null : r;
  }

  /**
   * 逐页切分选区：对每一页，取 选区Range ∩ 该页textLayerRange 的交集。
   * 返回每页被选中的文本 + DOM segments（DOM 定位失败自动降级文本匹配）。
   */
  private getSelectionPages(range: Range, startPage: number, endPage: number): PageSelection[] {
    const result: PageSelection[] = [];
    for (let p = startPage; p <= endPage; p++) {
      const pageEl = this.findPageByNumber(p);
      if (!pageEl) continue;
      const textLayer = pageEl.querySelector('.textLayer') as HTMLElement | null;
      if (!textLayer) continue;

      let inter: Range | null = null;
      try {
        const pageRange = document.createRange();
        pageRange.selectNodeContents(textLayer);
        inter = this.intersectRanges(range, pageRange);
      } catch {
        inter = null;
      }
      if (!inter) continue;

      const text = normalizeWhitespace(inter.toString());
      if (!text) continue;

      let segments = this.collectSegmentsInRange(inter, textLayer);
      if (segments.length === 0) {
        segments = this._collectByTextMatch(text, textLayer);
      }
      result.push({ page: p, text, segments });
    }
    return result;
  }

  /**
   * 在单个 textLayer 内，收集与 range 相交的所有 text segments。
   * 注意：不跳过已高亮（fleurSel）的节点 —— 选中范围与旧高亮重叠时
   * 必须仍能定位（这是旧版"本页偶发找不到选中文本"的根因之一）。
   */
  private collectSegmentsInRange(range: Range, textLayer: HTMLElement): TextSegment[] {
    const result: TextSegment[] = [];
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, null);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const content = node.textContent || '';
      if (!content) continue;
      if (!range.intersectsNode(node)) continue;

      let start = 0;
      let end = content.length;
      if (range.startContainer === node) {
        start = Math.min(Math.max(0, range.startOffset), content.length);
      }
      if (range.endContainer === node) {
        end = Math.min(Math.max(0, range.endOffset), content.length);
      }
      if (start < end) {
        result.push({ textNode: node, start, end });
      }
    }
    return result;
  }

  // ════════════════════════════════════════════
  //  右键菜单
  // ════════════════════════════════════════════

  private onContextMenu(e: MouseEvent) {
    if (!this.isInPDFView(e.target)) return;

    // 点击处命中的标注层（由内向外收集，叠加标注的嵌套子 span 各有 annId）
    const hitAnnIds = this.collectAnnotationIdsAt(e.target);

    // 优先用活选区重建快照（Chromium 右键不清空选区）
    let snapshot: SelectionSnapshot | null = null;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      snapshot = this.buildSnapshotFromSelection(selection);
    }

    // 活选区不可用 → 用 mouseup 时的快照（过滤掉已失效的 DOM 引用）
    if (!snapshot && this.lastSnapshot && Date.now() - this.lastSnapshot.timestamp < PDFPatcher.SNAPSHOT_TTL_MS) {
      snapshot = {
        ...this.lastSnapshot,
        pages: this.lastSnapshot.pages.map((ps) => ({
          ...ps,
          segments: ps.segments.filter((s) => s.textNode.isConnected && s.textNode.parentNode !== null),
        })),
      };
    }

    if (snapshot && snapshot.text) {
      e.preventDefault();
      e.stopPropagation();
      void this.showContextMenu(e.clientX, e.clientY, snapshot, hitAnnIds);
      return;
    }

    // 无选区：点击处有标注 → 「一键清除」原生菜单。
    // 只需右键点击标注区域内任意位置，无需选中整段文字。
    // 批注气泡有自己的右键菜单（删除批注），不抢占。
    const el = e.target as HTMLElement | null;
    if (hitAnnIds.length > 0 && !el?.closest?.('.fleur-comment-bubble')) {
      e.preventDefault();
      e.stopPropagation();
      void this.showClearAnnotationMenu(e.clientX, e.clientY, hitAnnIds);
    }
  }

  /* ════════════════════════════════════════════
     移动端：选中文字 → 自动弹出批注菜单
     ════════════════════════════════════════════ */

  /**
   * 选区变化 → 去抖后判定是否弹出 / 收起批注菜单（仅移动端注册）。
   *
   * 与 FleurEPUB 的 `selectionchange` 处理完全同构：每次变化都重置计时器 ⇒
   * 只有**停手 300ms** 才真正判定一次。拖动选择手柄期间 selectionchange 连续派发、
   * 计时器不断被推后，因此**拖动全程绝不会弹菜单** —— 这正是用户要的
   * 「选完了再弹」，而不是靠猜手势。
   *
   * ⚠️ 0.5 移除的三样东西（均为 0.4.4 所加，真机证明有害或无效）：
   *   · 「选区一变就先收掉面板」—— 拖动中面板被反复收放、闪烁，观感是「菜单乱弹」；
   *   · 「手势静默期」(touchSelecting / lastTouchAt) —— 拖原生选择手柄时 WebView
   *     不向页面派发 touch 事件，那些标志位在真机恒为假，纯属无效复杂度；
   *   · 900ms 去抖 —— 比 FleurEPUB 的 300ms 更钝，用户选完还要干等半秒。
   */
  private onSelectionChange(): void {
    if (this.selectionMenuTimer !== null) window.clearTimeout(this.selectionMenuTimer);
    this.selectionMenuTimer = window.setTimeout(() => {
      this.selectionMenuTimer = null;
      this.syncMobileMenuWithSelection();
    }, PDFPatcher.SELECTION_SETTLE_MS);
  }

  /**
   * 选区稳定后同步批注面板：有选区就弹（或保持），没选区就收。
   *
   * 语义与 FleurEPUB 的 `selectionchange` 处理完全一致 —— 它用的是
   * 「稳定 300ms 后有选区就显示工具条 / 无选区且已显示超过 350ms 就隐藏」。
   * 两个数字直接照搬，那是真机调出来的手感：去掉隐藏分支就会留下一个
   * 「选区早没了、面板还杵在那」的僵尸面板。
   */
  private syncMobileMenuWithSelection(): void {
    // 手写模式下 textLayer 已禁选：既不再弹，也要把可能在切换前留下的面板收掉
    if (document.body.classList.contains('fleur-pdf-ink-active')) {
      this.hideContextMenu();
      return;
    }

    const selection = window.getSelection();
    const text =
      selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.toString().trim() : '';

    if (!text || !selection) {
      // 选区被清空（点空白 / 取消选择）→ 面板跟着收起来
      if (this.openPanel?.isConnected && Date.now() - this.contextMenuShownAt > 350) this.hideContextMenu();
      return;
    }

    if (!this.currentPagePath) return;

    // 焦点在输入框 / 我们自己的面板里 → 不弹（批注编辑中、AI 提问中）
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest?.('input, textarea, .fleur-context-panel, .modal-container')) return;

    const range = selection.getRangeAt(0);
    const anchorNode = range.commonAncestorContainer;
    const anchor = (anchorNode.nodeType === Node.ELEMENT_NODE
      ? anchorNode
      : anchorNode.parentElement) as HTMLElement | null;
    if (!anchor || !this.isInPDFView(anchor)) return;

    const snapshot = this.buildSnapshotFromSelection(selection);
    if (!snapshot?.text) return;

    // 同一段选区且面板已经开着 → 原样保持，不重建（重建会让面板闪一下）。
    // 注意条件里必须带 `this.openPanel`：旧版只比 key，而 key 一旦记下就永不清空，
    // 于是「同一段文字第二次选中」时菜单根本不出现，用户以为功能又坏了。
    const key = `${ text.length }|${ text.slice(0, 48) }`;
    if (key === this.lastAutoMenuKey && this.openPanel?.isConnected) return;
    this.lastAutoMenuKey = key;

    const rect = range.getBoundingClientRect();
    // ↓ 44px：Android 选区两端的原生拖拽滑杆有 ~36px 高、从选区下角向下伸，
    // 10px 的旧间距会让菜单正好压在滑杆上（真机反馈「滑杆挡住菜单」）。
    void this.showContextMenu(
      Math.min(Math.max(8, rect.left + rect.width / 2), Math.max(8, window.innerWidth - 8)),
      rect.bottom + 44,
      snapshot,
      [],
      // 声明这是「选区自动唤起」的面板：onSelectionChange 据此判断能否在选区变化时收起它。
      // ⚠️ 必须作为参数传进去，不能在这里直接给 this.openAutoKey 赋值 —— showContextMenu
      // 内部有一句同步的 hideContextMenu()（单实例清理），会把刚赋的值清成空串，
      // 于是「选区一变就收面板」的判定永远不成立。
      key,
    );
  }

  /** 根据页码查找页面元素 */
  private findPageByNumber(pageNum: number): HTMLElement | null {
    const pages = document.querySelectorAll('.page');
    for (const page of Array.from(pages)) {
      const num = parseInt(page.getAttribute('data-page-number') || '0');
      if (num === pageNum) return page as HTMLElement;
    }
    return null;
  }

  /**
   * 关闭当前的文本批注面板（单实例语义）。
   *
   * 对齐 FleurEPUB 的选区工具条做法：它只维护一个 `selToolbar` 引用，
   * 任何新工具条出现前先 hide 旧的；面板消失时（选区被清空）也主动 hide。
   * 本插件此前缺这两条 —— openPanel 字段声明了却从未赋值，于是每弹一次就
   * 往 body 上叠一个新的，真机表现为「选字后菜单反复弹、叠成一片」。
   */
  private hideContextMenu(): void {
    if (this.contextMenuCloser) {
      document.removeEventListener('pointerdown', this.contextMenuCloser, true);
      this.contextMenuCloser = null;
    }
    this.openPanel?.remove();
    this.openPanel = null;
    this.openAutoKey = '';
  }

  /** 外部强制收起浮动面板（进入手写模式时调用：移动端选不出文本，面板只会挡路）。 */
  closeFloatingMenu(): void {
    // 代际 +1：把「已在 await 途中、还没来得及创建面板」的那次请求一并作废，
    // 否则它会在手写模式已经打开之后又把面板弹出来。
    this.contextMenuEpoch++;
    this.hideContextMenu();
  }

  private async showContextMenu(
    _x: number,
    _y: number,
    snapshot: SelectionSnapshot,
    hitAnnIds: string[] = [],
    /** 非空表示「这是选区自动唤起的面板」，值即该选区的指纹（见 openAutoKey）。 */
    autoKey = '',
  ) {
    // 本次请求的代际。下面有 await，快速连续选字时可能多个请求同时在途，
    // 而它们的耗时不定 —— 可能出现「旧快照后落地、盖掉新面板」。await 之后校验一次。
    const epoch = ++this.contextMenuEpoch;

    const s = this.plugin.settings;
    const underlineColor = s.underlineColor || '#6B0000';
    const highlightColors = s.highlightColors.length >= 3
      ? s.highlightColors
      : ['#D4A017', '#2979C4', '#D32F2F'];

    const { text, pageNum, endPage, pages } = snapshot;

    // 预先捕获文件路径（菜单显示后 PDF 视图可能失去焦点）
    const filePath = this.plugin.app.workspace.getActiveFile()?.path ?? null;

    // 解析点击处各标注层的类型（用于清除项的分层标签；存储缺失时退化为通用标签）
    const hitItems: { id: string; ann?: Annotation }[] = hitAnnIds.map((id) => ({ id }));
    if (hitAnnIds.length > 0 && filePath) {
      const data = await this.plugin.store.load(filePath);
      for (const item of hitItems) {
        item.ann = data.annotations.find((a) => a.id === item.id);
      }
    }

    // await 期间有更新的请求进来（或被强制关闭）→ 本次让位，不再创建面板
    if (epoch !== this.contextMenuEpoch) return;

    // 单实例：先把上一个面板收掉。
    // 此前这里缺了这一步（openPanel 字段声明了却从未赋值），于是选区每稳定一次
    // 就往 body 上叠一个新面板 —— 真机表现就是「选中文本后菜单反复弹出、越叠越多，
    // 挡住正文没法继续干活」。FleurEPUB 的选区工具条是同样的单实例语义。
    this.hideContextMenu();
    // hideContextMenu 刚把 openAutoKey 清空，这里按调用方声明重新登记
    this.openAutoKey = autoKey;

    // 创建浮动面板
    const panel = createDiv({ cls: 'fleur-context-panel' });
    this.openPanel = panel;
    this.contextMenuShownAt = Date.now();
    /** 关闭当前面板（各按钮动作完成后统一走它，保证 openPanel 被清空）。 */
    const close = () => this.hideContextMenu();

    // 拖拽把手：菜单默认贴着选区弹出，可能挡住正文或选区滑杆 —— 用户可拖走。
    // 只认把手，按钮区交互不受影响（与手写笔盒的把手语义一致）。
    // ⚠️ 仅移动端创建：桌面端面板 DOM 与 1.5.15 保持一致。
    if (isMobileBody()) {
      const grip = panel.createDiv('fleur-context-grip');
      setIcon(grip, 'grip-vertical');
      grip.setAttribute('aria-label', '拖动菜单');
      this.attachPanelDrag(panel, grip);
    }

    // 复制
    const copyBtn = panel.createEl('button');
    copyBtn.addClass('fleur-context-item');
    copyBtn.title = '复制';
    iconCopy(copyBtn);
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(text).then(() => new Notice('已复制'));
      close();
    });

    // 分隔
    panel.createDiv({ cls: 'fleur-context-sep' });

    // 三个高亮颜色圆点
    const hlGroup = panel.createDiv('fleur-context-group');
    highlightColors.forEach((color, idx) => {
      const hlBtn = hlGroup.createEl('button');
      hlBtn.addClass('fleur-context-item', 'fleur-context-hl');
      hlBtn.title = `高亮 ${idx + 1}`;
      if (isMobileBody()) {
        // 移动端用 SVG 圆点，而不是「div + 行内背景色」。
        //
        // 这是踩过两次的同一道坎：移动端 WebView 下，div 的尺寸与背景最终都由样式表
        // 决定，一旦用户主题对 button/div 有更高优先级的规则（或样式表时序异常），
        // 圆点就渲染成一个不可见的空盒子 —— 真机反馈的「图标有了、颜色没了」。
        // 而 SVG 的 fill / width / height 是**元素自身的属性**，样式表只能叠加，
        // 不能让它「没有颜色、没有尺寸」。菜单里其余图标之所以一直好好的，
        // 正因为它们本来就是 SVG；现在圆点与它们同源。
        // 桌面端保持 1.5.15 的 div 圆点，DOM 与样式完全一致。
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        dot.setAttribute('class', 'fleur-context-hl-dot');
        dot.setAttribute('width', '20');
        dot.setAttribute('height', '20');
        dot.setAttribute('viewBox', '0 0 20 20');
        dot.setAttribute('aria-hidden', 'true');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '10');
        circle.setAttribute('cy', '10');
        circle.setAttribute('r', '9');
        circle.setAttribute('fill', color);
        dot.appendChild(circle);
        hlBtn.appendChild(dot);
      } else {
        const dot = hlBtn.createDiv({ cls: 'fleur-context-hl-dot' });
        dot.setCssStyles({ background: color });
      }
      hlBtn.addEventListener('click', () => {
        void this.applyHighlight(text, pageNum, pages, color, 'highlight', filePath, endPage);
        close();
      });
    });

    // 分隔
    panel.createDiv({ cls: 'fleur-context-sep' });

    // 划线 - 直线
    const solidUlBtn = panel.createEl('button');
    solidUlBtn.addClass('fleur-context-item');
    solidUlBtn.title = '直线';
    iconUnderlineSolid(solidUlBtn, underlineColor);
    solidUlBtn.addEventListener('click', () => {
      void this.applyUnderline(text, pageNum, pages, 'solid', underlineColor, filePath, endPage);
      close();
    });

    // 划线 - 波浪：桌面端保留 1.5.15 的波浪线（text-decoration 在桌面渲染正常）。
    // 移动端不提供入口 —— Android WebView 的 wavy 装饰在小字 + 缩放下退化成点。
    // 历史数据里的 wavy 在移动端由 CSS 覆盖为直线渲染（见 styles.css）。
    if (!isMobileBody()) {
      const wavyUlBtn = panel.createEl('button');
      wavyUlBtn.addClass('fleur-context-item');
      wavyUlBtn.title = '波浪';
      iconUnderlineWavy(wavyUlBtn, underlineColor);
      wavyUlBtn.addEventListener('click', () => {
        void this.applyUnderline(text, pageNum, pages, 'wavy', underlineColor, filePath, endPage);
        close();
      });
    }

    // 分隔
    panel.createDiv({ cls: 'fleur-context-sep' });

    // 批注
    const commentBtn = panel.createEl('button');
    commentBtn.addClass('fleur-context-item');
    commentBtn.title = '批注';
    iconComment(commentBtn);
    commentBtn.addEventListener('click', () => {
      this.showCommentDialog(text, pageNum, pages, filePath, endPage);
      close();
    });

    // 分隔
    panel.createDiv({ cls: 'fleur-context-sep' });

    // 询问AI
    const askBtn = panel.createEl('button');
    askBtn.addClass('fleur-context-item');
    askBtn.title = '询问AI';
    iconAI(askBtn);
    askBtn.addEventListener('click', () => {
      this.askAI(text, '请回答关于这段内容的问题', _x, _y);
      close();
    });

    // 分隔
    panel.createDiv({ cls: 'fleur-context-sep' });

    // AI 翻译
    const translateBtn = panel.createEl('button');
    translateBtn.addClass('fleur-context-item');
    translateBtn.title = 'AI 翻译';
    iconTranslate(translateBtn);
    translateBtn.addEventListener('click', () => {
      this.askAITranslate(text, _x, _y);
      close();
    });

    // 清除标注（右键点击处命中标注层时显示 — 分层列出，叠加标注逐项清除）
    if (hitItems.length > 0) {
      panel.createDiv({ cls: 'fleur-context-sep' });
      for (const item of hitItems) {
        const clearBtn = panel.createEl('button');
        clearBtn.addClass('fleur-context-item');
        clearBtn.title = this.describeAnnotation(item.ann);
        iconEraser(clearBtn);
        clearBtn.addEventListener('click', () => {
          close();
          void this.removeAnnotationFromPdf(item.id, item.ann);
        });
      }
    }

    // 点击外部关闭面板。
    // 用 pointerdown 而不是 mousedown：移动端触摸只派发 pointer/touch 事件，
    // mousedown 在部分 WebView 里要等 300ms 才合成，面板会「点外面关不掉」。
    const closeHandler = (e: Event) => {
      if (panel.contains(e.target as Node)) return;
      this.hideContextMenu();
    };
    this.contextMenuCloser = closeHandler;
    window.setTimeout(() => {
      // 这一拍内面板可能已被关掉（连续选字会重建面板），此时不要再挂监听，
      // 否则会积下一堆永不触发也永不释放的 document 级监听。
      if (this.openPanel === panel) document.addEventListener('pointerdown', closeHandler, true);
    }, 0);

    // 定位面板（确保不超出视口）
    document.body.appendChild(panel);
    const panelRect = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let posX = _x;
    let posY = _y;

    if (_x + panelRect.width > vw - 8) {
      posX = vw - panelRect.width - 8;
    }
    if (_y + panelRect.height > vh - 8) {
      posY = vh - panelRect.height - 8;
    }
    if (posX < 8) posX = 8;
    if (posY < 8) posY = 8;

    panel.setCssStyles({ left: `${posX}px`, top: `${posY}px` });
  }

  /**
   * 选区菜单面板拖拽（只认把手）。
   *
   * pointer capture 拖动：move 里按「起点面板位置 + 指针位移」重设 left/top，
   * 并夹紧到视口内（留 8px 边距）。不持久化 —— 面板随选区即时重建，
   * 每次弹出都回到默认位置，拖动只是当次的临时避让。
   */
  private attachPanelDrag(panel: HTMLElement, grip: HTMLElement): void {
    let dragging = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;

    grip.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      pointerId = e.pointerId;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      baseX = rect.left;
      baseY = rect.top;
      // touch-action: none（见样式）已挡掉触摸滚动，capture 保证指针移出把手也继续收事件
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const nx = Math.min(Math.max(8, baseX + (e.clientX - startX)), window.innerWidth - w - 8);
      const ny = Math.min(Math.max(8, baseY + (e.clientY - startY)), window.innerHeight - h - 8);
      panel.setCssStyles({ left: `${nx}px`, top: `${ny}px` });
      e.preventDefault();
    });
    const end = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* 指针已释放，忽略 */
      }
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // ════════════════════════════════════════════
  //  右键一键清除标注 — 点击标注区域内任意位置即可，无需选中
  // ════════════════════════════════════════════

  /** 收集右键点击处（由内向外）所有标注层的 id。叠加标注以嵌套子 span 形式存在，每层各有 annId */
  private collectAnnotationIdsAt(target: EventTarget | null): string[] {
    const el = target as HTMLElement | null;
    if (!el?.closest) return [];
    const pageEl = el.closest('.page');
    const ids: string[] = [];
    let cur: HTMLElement | null = el;
    while (cur && cur !== pageEl) {
      const id = cur.dataset?.['annId'];
      if (id && !ids.includes(id)) ids.push(id);
      cur = cur.parentElement;
    }
    return ids;
  }

  /**
   * 移动端点按已有标注 → 弹清除菜单（桌面端的对应入口是右键）。
   *
   * 触发条件从严，避免误弹：
   *   ① 命中处必须真的有标注层（由内向外收集，叠加标注逐层列出）；
   *   ② 当前无文字选区 —— 选区语义交给 selectionchange 菜单；
   *   ③ 不抢批注气泡自己的交互（它有独立的删除菜单）；
   *   ④ 只认 textLayer 里的命中，我们的面板 / 弹窗 / 按钮一律放行。
   */
  private onAnnotationTap(e: MouseEvent) {
    if (!this.isInPDFView(e.target)) return;
    // 手写批注模式下，点按属于墨迹引擎（落笔 / 擦除 / 套索 / 滚动），
    // 永不弹文本标注清除菜单 —— 真机反馈「点手写笔迹也弹出清除高亮窗口」。
    if (document.body.hasClass('fleur-pdf-ink-active')) return;
    const el = e.target as HTMLElement | null;
    if (!el?.closest) return;
    if (el.closest('.fleur-comment-bubble, .fleur-context-panel, .modal-container, button, a')) return;
    if (!el.closest('.textLayer')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    const ids = this.collectAnnotationIdsAt(e.target);
    if (ids.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void this.showClearAnnotationMenu(e.clientX, e.clientY, ids);
  }

  /** 无选区右键命中标注 → 原生菜单分层列出清除项（与批注气泡右键菜单风格一致） */
  private async showClearAnnotationMenu(x: number, y: number, annIds: string[]) {
    const file = this.plugin.app.workspace.getActiveFile();
    const data = file ? await this.plugin.store.load(file.path) : null;
    const menu = new Menu();
    for (const id of annIds) {
      const ann = data?.annotations.find((a) => a.id === id);
      menu.addItem((item) => {
        item.setTitle(this.describeAnnotation(ann)).setIcon('eraser');
        item.onClick(() => void this.removeAnnotationFromPdf(id, ann));
      });
    }
    menu.showAtPosition({ x, y });
  }

  /** 清除项标签：按标注类型给出具体名称 */
  private describeAnnotation(ann?: Annotation): string {
    if (!ann) return '清除标注';
    if (ann.type === 'highlight') return '清除高亮';
    if (ann.type === 'underline') return ann.underlineStyle === 'wavy' ? '清除波浪线' : '清除直线';
    if (ann.type === 'comment') return '清除批注';
    return '清除标注';
  }

  /** 从存储与 DOM 中移除一条标注（含跨页全部片段、批注气泡），并刷新侧边栏 */
  private async removeAnnotationFromPdf(annId: string, ann?: Annotation) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;
    // 先使在途/排队的恢复失效（同步执行，抢在任何 await 之前）：
    // 否则删除期间正在等 textLayer 的恢复会把旧数据里的标注重新画回原文
    this.invalidateRestoreState();
    const data = await this.plugin.store.load(file.path);
    const target = ann ?? data.annotations.find((a) => a.id === annId);
    data.annotations = data.annotations.filter((a) => a.id !== annId);
    await this.plugin.store.save(data);
    this.clearAnnotationDom(annId, target);
    this.pruneFlashSpans();
    this.removeCommentBubble(annId);
    // 兜底清扫：该页上凡是不属于任何剩余标注的气泡一并移除
    // （覆盖气泡 id 与标注 id 不一致、历史气泡缺 data-ann-id 等异常情况）
    if (target) {
      const keepIds = new Set(data.annotations.map((a) => a.id));
      this.sweepBubblesForPage(target.page, keepIds);
    }
    new Notice('已清除', 2000);
    void this.plugin.getSidebar()?.refresh(file.path);
  }

  /** 清扫指定页上的孤儿气泡：id 不在保留集合中（或缺 id）的气泡全部移除 */
  sweepBubblesForPage(pageNum: number, keepIds: Set<string>) {
    const pageEl = this.findPageByNumber(pageNum);
    if (!pageEl) return;
    pageEl.querySelectorAll('.fleur-comment-bubble').forEach((el) => {
      const bubble = el as HTMLElement;
      const id = bubble.dataset?.['annId'];
      if (!id || !keepIds.has(id)) {
        bubble.remove();
        const idx = this.commentBubbles.findIndex((b) => b.el === bubble);
        if (idx >= 0) this.commentBubbles.splice(idx, 1);
      }
    });
  }

  /** 清除某条标注在 DOM 上的全部样式（与 sidebar.clearAnnotationStyles 对称，避免残留） */
  private clearAnnotationDom(annId: string, ann?: Annotation) {
    const clear = (el: HTMLElement) => {
      // fleur-search-flash 也要摘（同 sidebar：先定位后删除时会残留涂色）
      el.removeClass('fleur-highlight', 'fleur-underline', 'fleur-underline-wavy', 'fleur-underline-solid', 'fleur-search-flash');
      el.setCssStyles({ background: '', borderRadius: '', textDecoration: '', textUnderlineOffset: '' });
      el.setCssProps({ '--fleur-underline-color': '' });
      delete el.dataset['annId'];
    };

    const matched = document.querySelectorAll(`[data-ann-id="${annId}"]`);
    matched.forEach((span) => clear(span as HTMLElement));

    if (matched.length === 0 && ann) {
      const pages = document.querySelectorAll(`.page[data-page-number="${ann.page}"]`);
      pages.forEach((page) => {
        const textLayer = page.querySelector('.textLayer');
        if (!textLayer) return;
        textLayer.querySelectorAll('span').forEach((span) => {
          if (span.textContent?.trim() === ann.text.trim()) clear(span as HTMLElement);
        });
      });
    }
  }

  // ════════════════════════════════════════════
  //  应用标注 — segments 失效时按页内文本重新定位
  // ════════════════════════════════════════════

  /**
   * 对每一页应用样式。segments 已失效（PDF.js 重渲染导致节点脱离文档）时，
   * 用该页的选中文本在 textLayer 中重新匹配。返回成功着色的 span 列表。
   */
  private styleAllPages(pages: PageSelection[], styleFn: (el: HTMLElement) => void): HTMLElement[] {
    const styledSpans: HTMLElement[] = [];
    for (const ps of pages) {
      let segs = ps.segments.filter((s) => s.textNode.isConnected && s.textNode.parentNode !== null);
      if (segs.length === 0 && ps.text.trim()) {
        const pageEl = this.findPageByNumber(ps.page);
        const textLayer = pageEl?.querySelector('.textLayer') as HTMLElement | null;
        if (textLayer) {
          segs = this._collectByTextMatch(ps.text, textLayer);
        }
      }
      for (const seg of segs) {
        const span = this.wrapAndStyle(seg, styleFn);
        if (span) styledSpans.push(span);
      }
    }
    return styledSpans;
  }

  /**
   * 深度回退：连页内文本都定位不到时（如快照丢失），
   * 按跨页切分算法把标注文本拆到各页再逐页匹配。
   */
  private deepFallback(
    text: string, pageNum: number, endPage: number | undefined,
    styleFn: (el: HTMLElement) => void
  ): HTMLElement[] {
    const spans: HTMLElement[] = [];
    const last = endPage ?? pageNum;
    const portions = last > pageNum
      ? this.splitAnnotationTextByPage(text, pageNum, last)
      : new Map<number, string>([[pageNum, text]]);
    for (const [page, portion] of portions) {
      if (!portion) continue;
      const pageEl = this.findPageByNumber(page);
      const textLayer = pageEl?.querySelector('.textLayer') as HTMLElement | null;
      if (!textLayer) continue;
      for (const seg of this._collectByTextMatch(portion, textLayer)) {
        const span = this.wrapAndStyle(seg, styleFn);
        if (span) spans.push(span);
      }
    }
    return spans;
  }

  private async applyHighlight(
    text: string, pageNum: number, pages: PageSelection[],
    color: string, type: 'highlight' | 'comment',
    filePath?: string | null, endPage?: number
  ): Promise<string> {
    // 先保存数据（文本锚点制：数据是源头，显示可随时重建）
    const annId = await this.saveAnnotation(text, pageNum, color, type, undefined, undefined, filePath, endPage, computeSelectionPos(pages));
    if (!annId) return '';

    const styleFn = (el: HTMLElement) => {
      el.setCssStyles({ background: color });
      el.addClass('fleur-highlight');
      el.dataset['annId'] = annId;
    };
    let spans = this.styleAllPages(pages, styleFn);
    if (spans.length === 0) {
      spans = this.deepFallback(text, pageNum, endPage, styleFn);
    }
    if (spans.length === 0) {
      new Notice('标注已保存，但暂未定位到文本位置；可用命令「重新渲染标注」恢复显示');
    }
    return annId;
  }

  /**
   * 应用划线标注。
   *
   * 桌面端保留 solid / wavy 两种样式（与 1.5.15 一致）；移动端菜单只提供 solid
   * 入口 —— Android WebView 的 text-decoration:wavy 在小字 + 缩放下退化成
   * 不规则点（真机反馈「下划波浪线没有波浪，都是点」）。
   * 历史数据里的 underlineStyle: 'wavy' 在移动端由 CSS 覆盖为直线渲染，
   * 数据字段保留读写兼容。
   */
  private async applyUnderline(
    text: string, pageNum: number, pages: PageSelection[],
    style: UnderlineStyle, color: string,
    filePath?: string | null, endPage?: number
  ): Promise<string> {
    const annId = await this.saveAnnotation(text, pageNum, color, 'underline', undefined, style, filePath, endPage, computeSelectionPos(pages));
    if (!annId) return '';

    const styleFn = (el: HTMLElement) => {
      el.addClass('fleur-underline');
      el.addClass(style === 'wavy' ? 'fleur-underline-wavy' : 'fleur-underline-solid');
      el.setCssProps({ '--fleur-underline-color': color });
      el.dataset['annId'] = annId;
    };
    let spans = this.styleAllPages(pages, styleFn);
    if (spans.length === 0) {
      spans = this.deepFallback(text, pageNum, endPage, styleFn);
    }
    if (spans.length === 0) {
      new Notice('标注已保存，但暂未定位到文本位置；可用命令「重新渲染标注」恢复显示');
    }
    return annId;
  }

  private async saveAnnotation(
    text: string, pageNum: number, color: string,
    type: 'highlight' | 'comment' | 'underline',
    comment?: string, underlineStyle?: UnderlineStyle,
    filePath?: string | null, endPage?: number,
    pos?: { top: number; left: number }
  ): Promise<string> {
    const path = filePath ?? this.plugin.app.workspace.getActiveFile()?.path;
    if (!path) { new Notice('未找到当前文件'); return ''; }

    const annotation: Annotation = {
      id: this.plugin.generateId(),
      type,
      page: pageNum,
      endPage: endPage,
      text,
      color,
      comment,
      underlineStyle,
      createdAt: Date.now(),
      pos,
    };

    await this.plugin.store.addAnnotation(path, annotation);
    void this.plugin.getSidebar()?.refresh(path);
    new Notice(type === 'comment' ? '已添加批注' : type === 'underline' ? '已添加划线' : '已添加高亮');
    return annotation.id;
  }

  // ════════════════════════════════════════════
  //  批注
  // ════════════════════════════════════════════

  private showCommentDialog(text: string, pageNum: number, pages: PageSelection[], filePath?: string | null, endPage?: number) {
    const hlColor = this.plugin.settings.highlightColors[0] || '#D4A017';
    const path = filePath ?? this.plugin.app.workspace.getActiveFile()?.path ?? null;

    const modal = new Modal(this.plugin.app);
    modal.titleEl.hide();

    const root = modal.contentEl.createDiv();
    root.addClass('fleur-comment-dialog-root');

    const quoteBlock = root.createDiv();
    quoteBlock.addClass('fleur-comment-dialog-quote');
    const quoteBar = quoteBlock.createDiv();
    quoteBar.addClass('fleur-comment-dialog-quote-bar');
    quoteBar.setCssProps({ '--fleur-hl-color': hlColor });
    const quoteText = quoteBlock.createDiv();
    quoteText.addClass('fleur-comment-dialog-quote-text');
    quoteText.textContent = text;

    const inputLabel = root.createDiv();
    inputLabel.addClass('fleur-comment-dialog-label');
    inputLabel.textContent = '注释';

    const textarea = root.createEl('textarea');
    textarea.addClass('fleur-comment-dialog-textarea');
    textarea.placeholder = '';

    const btnRow = root.createDiv();
    btnRow.addClass('fleur-comment-dialog-btn-row');

    const cancelBtn = btnRow.createEl('button', { text: '取消' });
    cancelBtn.addClass('fleur-comment-dialog-btn', 'cancel');
    cancelBtn.addEventListener('click', () => modal.close());

    const saveBtn = btnRow.createEl('button', { text: '保存' });
    saveBtn.addClass('fleur-comment-dialog-btn', 'save');

    const doAdd = async () => {
      const comment = textarea.value.trim();
      if (!comment) { new Notice('批注内容不能为空'); return; }
      if (!path) { new Notice('未找到当前文件'); return; }

      // 1. 保存数据
      const annotation: Annotation = {
        id: this.plugin.generateId(),
        type: 'comment',
        page: pageNum,
        endPage: endPage,
        text,
        color: hlColor,
        comment,
        createdAt: Date.now(),
        pos: computeSelectionPos(pages),
      };
      await this.plugin.store.addAnnotation(path, annotation);
      const annId = annotation.id;

      // 2. 关闭弹窗（focus 回到 PDF 视图）
      modal.close();

      // 3. 等待 focus 稳定后再做 DOM 操作（避免 PDF.js 重新渲染清除节点）
      await new Promise((r) => window.setTimeout(r, 80));

      try {
        // 4. 高亮文本（segments 失效时按页内文本重新定位，仍失败则深度回退）
        const styleFn = (el: HTMLElement) => {
          el.setCssStyles({ background: hlColor });
          el.addClass('fleur-highlight');
          el.dataset['annId'] = annId;
        };
        let styledSpans = this.styleAllPages(pages, styleFn);
        if (styledSpans.length === 0) {
          styledSpans = this.deepFallback(text, pageNum, endPage, styleFn);
        }

        // 5. 添加气泡（使用最新的 DOM 引用）
        const firstSpan = styledSpans[0];
        const pageEl = firstSpan?.closest<HTMLElement>('.page') ?? null;
        if (pageEl && firstSpan) {
          this.addCommentBubble(comment, firstSpan, pageEl, annId);
        }

        // 6. 刷新侧边栏
        void this.plugin.getSidebar()?.refresh(path);
        new Notice('已添加批注', 2000);
      } catch {
        new Notice('批注保存后渲染失败，数据已保存');
      }
    };

    saveBtn.addEventListener('click', () => { void doAdd(); });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void doAdd();
      }
      if (e.key === 'Escape') {
        modal.close();
      }
    });

    modal.open();
    window.setTimeout(() => textarea.focus(), 100);
  }

  // ════════════════════════════════════════════
  //  批注气泡
  // ════════════════════════════════════════════

  addCommentBubbleFromSidebar(
    comment: string, anchorSpan: HTMLElement, pageEl: HTMLElement, annId: string
  ): void {
    this.addCommentBubble(comment, anchorSpan, pageEl, annId);
  }

  private addCommentBubble(
    comment: string, anchorSpan: HTMLElement, pageEl: HTMLElement, annId?: string
  ) {
    if (getComputedStyle(pageEl).position === 'static') {
      pageEl.addClass('fleur-page-relative');
    }

    const pageRect = pageEl.getBoundingClientRect();
    const spanRect = anchorSpan.getBoundingClientRect();
    const scaleX = pageEl.clientWidth / pageRect.width;
    const scaleY = pageEl.clientHeight / pageRect.height;

    const anchorX = (spanRect.right - pageRect.left) * scaleX + 6;
    const anchorY = (spanRect.top - pageRect.top) * scaleY - 4;

    const wrapper = pageEl.createDiv();
    wrapper.addClass('fleur-comment-bubble');
    if (annId) wrapper.dataset['annId'] = annId;
    wrapper.setCssStyles({ left: `${anchorX}px`, top: `${anchorY - 6}px` });

    const icon = wrapper.createDiv();
    icon.addClass('fleur-comment-bubble-icon');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#fff');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
    svg.appendChild(pathEl);
    icon.appendChild(svg);

    const popup = wrapper.createDiv();
    popup.addClass('fleur-comment-bubble-popup');

    const tail = popup.createDiv();
    tail.addClass('fleur-comment-bubble-tail');

    const textEl = popup.createDiv();
    const plainText = markdownToPlain(normalizeWhitespace(comment));
    textEl.textContent = plainText;

    // 长批注默认折叠（>80 字符）
    if (plainText.length > 80) {
      textEl.addClass('is-clamped');
      const toggle = popup.createDiv({ text: '展开' });
      toggle.addClass('fleur-comment-toggle');
      toggle.addEventListener('click', () => {
        if (textEl.hasClass('is-clamped')) {
          textEl.removeClass('is-clamped');
          toggle.textContent = '收起';
        } else {
          textEl.addClass('is-clamped');
          toggle.textContent = '展开';
        }
      });
    }

    wrapper.appendChild(icon);
    wrapper.appendChild(popup);

    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle('删除批注');
        item.setIcon('trash-2');
        item.onClick(() => this.removeComment(comment, wrapper));
      });
      menu.showAtPosition({ x: e.clientX, y: e.clientY });
    });

    pageEl.appendChild(wrapper);
    this.commentBubbles.push({ el: wrapper });
  }

  private async removeComment(comment: string, bubble: HTMLElement) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (file) {
      const data = await this.plugin.store.load(file.path);
      data.annotations = data.annotations.filter(a => a.comment !== comment);
      await this.plugin.store.save(data);
      void this.plugin.getSidebar()?.refresh(file.path);
    }
    bubble.remove();
    new Notice('已删除批注', 2000);
  }

  removeCommentBubble(annId: string) {
    // 移除全部同 id 气泡：页面重渲染后数组中可能残留已脱离 DOM 的旧引用，
    // 只删第一个匹配项会把仍挂载的活气泡漏掉
    for (let i = this.commentBubbles.length - 1; i >= 0; i--) {
      if (this.commentBubbles[i].el.dataset?.['annId'] === annId) {
        this.commentBubbles[i].el.remove();
        this.commentBubbles.splice(i, 1);
      }
    }
    // 兜底：数组跟踪不到的气泡（历史遗留/重建后丢失记录）直接按 DOM 查删，
    // 保证删除标注后气泡一定同步消失
    document.querySelectorAll(`.fleur-comment-bubble[data-ann-id="${annId}"]`).forEach((el) => el.remove());
  }

  // ════════════════════════════════════════════
  //  AI
  // ════════════════════════════════════════════

  private askAI(text: string, _prompt: string, anchorX?: number, anchorY?: number) {
    const panel = new AIChatPanel(this.plugin, text, 'explain');
    panel.open(anchorX, anchorY);
  }

  private askAITranslate(text: string, anchorX?: number, anchorY?: number) {
    const panel = new AIChatPanel(this.plugin, text, 'translate');
    panel.open(anchorX, anchorY);
  }

  // ════════════════════════════════════════════
  //  文本定位引擎
  // ════════════════════════════════════════════

  /**
   * 规范化文本 — 使用 NFKC 统一视觉相同但编码不同的 Unicode 字符
   * NFKC（Normalization Form Compatibility Composition）可处理：
   *   - 康熙部首（U+2F00-U+2FD5）→ 标准 CJK 汉字
   *   - 全角 ASCII / 标点 → 半角
   *   - CJK 兼容字符 → 标准形式
   */
  private normalizeText(text: string): string {
    return text
      .normalize('NFKC')
      .replace(/[\u200B\u200C\u200D\uFEFF\u2060\uFFF9\uFFFA\uFFFB]/g, '');
  }

  /** textLayer 的全部文本（按 DOM 顺序拼接，不加分隔符） */
  private textLayerToString(textLayer: HTMLElement): string {
    let full = '';
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, null);
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) {
      full += n.textContent || '';
    }
    return full;
  }

  /**
   * 跨页标注文本切分：把整段标注文本按页拆开。
   * 算法（规范化+去空白空间上的贪心前缀消耗）：
   *   - 在起始页定位剩余文本的起点（前 10 字探针，失败缩短到前 3 字）
   *   - 起始页/中间页：取「起点 → 本页末尾」为本页份额（跨页标注必然延伸到页尾）
   *   - 末页：剩余全部文本
   *   - 页面未渲染（虚拟滚动）时跳过该页，由重试机制兜底
   */
  private splitAnnotationTextByPage(annText: string, startPage: number, endPage: number): Map<number, string> {
    const result = new Map<number, string>();

    // 收集已渲染页面的全文（规范化 + 去空白）
    const pageInfos: { page: number; text: string }[] = [];
    for (let p = startPage; p <= endPage; p++) {
      const pageEl = this.findPageByNumber(p);
      if (!pageEl) continue;
      const textLayer = pageEl.querySelector('.textLayer') as HTMLElement | null;
      if (!textLayer) continue;
      const raw = this.textLayerToString(textLayer);
      if (!raw.trim()) continue;
      pageInfos.push({ page: p, text: this.normalizeText(raw).replace(/\s+/g, '') });
    }

    let remaining = this.normalizeText(annText).replace(/\s+/g, '');
    if (!remaining || pageInfos.length === 0) return result;

    for (const { page, text } of pageInfos) {
      if (!remaining) break;

      if (page === endPage) {
        // 末页：剩余全部
        result.set(page, remaining);
        remaining = '';
        break;
      }

      // 在本页定位剩余文本的起点
      const probe = remaining.substring(0, Math.min(10, remaining.length));
      let idx = text.indexOf(probe);
      if (idx === -1 && probe.length > 3) {
        idx = text.indexOf(probe.substring(0, 3));
      }
      if (idx === -1) {
        // 本页找不到起点（可能起点其实在更后面的页），跳过继续
        continue;
      }

      const portion = text.substring(idx);
      if (portion.length >= remaining.length) {
        // 剩余文本全部落在本页（endPage 记录偏大的情况）
        result.set(page, remaining);
        remaining = '';
        break;
      }
      result.set(page, portion);
      remaining = remaining.substring(portion.length);
    }

    // 有剩余但末页未渲染 → 记到末页名下，匹配失败会触发重试
    if (remaining && !result.has(endPage)) {
      result.set(endPage, remaining);
    }
    return result;
  }

  /** 用文本内容在 textLayer 中匹配定位 */
  private _collectByTextMatch(targetText: string, textLayer: HTMLElement): TextSegment[] {
    // 清理目标文本：去除首尾空白和标点
    const cleaned = targetText
      .trim()
      .replace(/^\p{P}+/u, '')
      .replace(/\p{P}+$/u, '')
      .trim();
    if (!cleaned) return [];

    // 收集所有文本节点
    const nodes: { node: Text; content: string }[] = [];
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, null);
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) {
      const content = n.textContent || '';
      if (!content.trim()) continue;
      nodes.push({ node: n, content });
    }
    if (nodes.length === 0) return [];

    // 拼接全文 — 不加空格！中文文本无词间空格，之前在节点间加空格导致匹配失败
    let fullText = '';
    const map: { node: Text; start: number; end: number }[] = [];
    for (const { node, content } of nodes) {
      const s = fullText.length;
      fullText += content;
      map.push({ node, start: s, end: fullText.length });
    }

    // 策略1: 精确匹配
    const idx = fullText.indexOf(cleaned);
    if (idx !== -1) {
      return this._textRangeToSegments(map, idx, idx + cleaned.length);
    }

    // 策略2: NFKC 规范化匹配（康熙部首 U+2F00-U+2FD5 → 标准 CJK）
    // NFKC 对 CJK 字符是一对一映射，长度不变，位置可直接对应
    const nfkcFull = this.normalizeText(fullText);
    const nfkcTarget = this.normalizeText(cleaned);
    if (nfkcFull.length === fullText.length) {
      const nIdx = nfkcFull.indexOf(nfkcTarget);
      if (nIdx !== -1) {
        return this._textRangeToSegments(map, nIdx, nIdx + nfkcTarget.length);
      }
    }

    // 策略3: 去空格匹配（处理 textLayer 中 span 间的空白/换行差异）
    const noWsFull = fullText.replace(/\s+/g, '');
    const noWsTarget = cleaned.replace(/\s+/g, '');
    if (noWsTarget.length >= 3) {
      const nsIdx = noWsFull.indexOf(noWsTarget);
      if (nsIdx !== -1) {
        const [oStart, oEnd] = this._noWsToOrig(fullText, nsIdx, nsIdx + noWsTarget.length);
        if (oStart >= 0 && oEnd > oStart) {
          return this._textRangeToSegments(map, oStart, oEnd);
        }
      }
    }

    // 策略4: NFKC + 去空格双重匹配
    if (nfkcFull.length === fullText.length) {
      const noWsNfkcFull = nfkcFull.replace(/\s+/g, '');
      const noWsNfkcTarget = nfkcTarget.replace(/\s+/g, '');
      if (noWsNfkcTarget.length >= 3) {
        const nsNfkcIdx = noWsNfkcFull.indexOf(noWsNfkcTarget);
        if (nsNfkcIdx !== -1) {
          const [oStart, oEnd] = this._noWsToOrig(fullText, nsNfkcIdx, nsNfkcIdx + noWsNfkcTarget.length);
          if (oStart >= 0 && oEnd > oStart) {
            return this._textRangeToSegments(map, oStart, oEnd);
          }
        }
      }
    }

    // 策略5: 前缀匹配（取目标前 10 字符，容错性最高）
    const prefix = nfkcTarget.substring(0, Math.min(10, nfkcTarget.length));
    if (prefix.length >= 4 && nfkcFull.length === fullText.length) {
      const pIdx = nfkcFull.indexOf(prefix);
      if (pIdx !== -1) {
        const endPos = Math.min(pIdx + nfkcTarget.length, nfkcFull.length);
        return this._textRangeToSegments(map, pIdx, endPos);
      }
    }

    return [];
  }

  /** 将去空格后的位置映射回原始文本位置 */
  private _noWsToOrig(fullText: string, wsStart: number, wsEnd: number): [number, number] {
    let wsPos = 0;
    let oStart = -1;
    let oEnd = -1;
    for (let i = 0; i < fullText.length; i++) {
      if (/\s/.test(fullText[i])) continue;
      if (wsPos === wsStart) oStart = i;
      if (wsPos === wsEnd - 1) { oEnd = i + 1; break; }
      wsPos++;
    }
    return [oStart, oEnd];
  }

  /** 根据原始文本范围构建 TextSegment 数组 */
  private _textRangeToSegments(
    map: { node: Text; start: number; end: number }[],
    rangeStart: number, rangeEnd: number
  ): TextSegment[] {
    const result: TextSegment[] = [];
    for (const { node, start, end } of map) {
      if (start < rangeEnd && end > rangeStart) {
        const ns = Math.max(0, rangeStart - start);
        const ne = Math.min(end - start, rangeEnd - start);
        if (ns < ne) result.push({ textNode: node, start: ns, end: ne });
      }
    }
    return result;
  }

  /**
   * 将文本片段拆分为子 span 并应用样式
   * 注意：父 span 已被其他标注占用（fleurSel）时不再复用父 span，
   * 而是创建子 span，避免覆盖旧标注的样式与 annId。
   */
  private wrapAndStyle(segment: TextSegment, styleFn: (el: HTMLElement) => void): HTMLElement | null {
    const { textNode, start, end } = segment;
    const full = textNode.textContent || '';

    if (!textNode.parentNode) return null;
    if (start >= end || start < 0 || end > full.length) return null;

    const before = full.substring(0, start);
    const middle = full.substring(start, end);
    const after = full.substring(end);

    const parent = textNode.parentNode;
    if (!parent) return null;

    if (start === 0 && end === full.length) {
      const parentEl = parent as HTMLElement;
      if (parentEl.tagName === 'SPAN' && !parentEl.dataset['fleurSel']) {
        styleFn(parentEl);
        parentEl.dataset['fleurSel'] = '1';
        return parentEl;
      }
    }

    const container = parent as HTMLElement;
    const subSpan = container.createEl('span');
    subSpan.textContent = middle;
    subSpan.dataset['fleurSel'] = '1';
    styleFn(subSpan);

    if (before) {
      parent.insertBefore(document.createTextNode(before), textNode);
    }
    parent.insertBefore(subSpan, textNode);
    if (after) {
      parent.insertBefore(document.createTextNode(after), textNode);
    }
    parent.removeChild(textNode);

    return subSpan;
  }

  // ════════════════════════════════════════════
  //  全文检索跳转（侧边栏搜索结果点击后定位）
  // ════════════════════════════════════════════

  /** 当前检索定位高亮的 span（短暂停留后自动消失） */
  private flashSpans: HTMLElement[] = [];
  /** 定位高亮代际：新一轮定位/Esc 清除时 +1，旧轮的定时清除自动作废，防止误清新一轮的高亮 */
  private flashGen = 0;

  /** 从指定片段摘除 flash 样式（正式标注只摘 class，临时片段连内联一起清） */
  private removeFlashFrom(spans: HTMLElement[]) {
    spans.forEach((el) => {
      el.removeClass('fleur-search-flash');
      if (!el.dataset['annId']) {
        el.setCssStyles({ transition: '', background: '', boxShadow: '' });
        delete el.dataset['fleurSel'];
      }
    });
  }

  /** 清除检索定位高亮 */
  clearSearchFlash() {
    this.flashGen++;
    this.removeFlashFrom(this.flashSpans);
    this.flashSpans = [];
  }

  /** 删除标注清除样式后同步调用：不再携带 flash 类或已脱离 DOM 的片段移出跟踪列表 */
  pruneFlashSpans() {
    this.flashSpans = this.flashSpans.filter((el) => el.isConnected && el.hasClass('fleur-search-flash'));
  }

  /**
   * 应用定位高亮。
   * - 检索跳转（persistent=true）：常驻到下一个动作（点击其他结果/新搜索/Esc/清空）
   * - 标注定位（persistent=false）：瞬间出现、停留约 1 秒即消失——驻留过久会让用户误以为盖住了原标注
   */
  private applyFlash(spans: HTMLElement[], persistent = false) {
    const gen = ++this.flashGen;
    this.flashSpans = spans;
    spans.forEach((el) => {
      if (!el.hasClass('fleur-search-flash')) el.addClass('fleur-search-flash');
    });
    if (persistent) return;
    window.setTimeout(() => {
      if (gen !== this.flashGen) return; // 已有新一轮定位/Esc 接管
      this.removeFlashFrom(spans);
      if (this.flashSpans === spans) this.flashSpans = [];
    }, 1000);
  }

  /** 滚动到对应页并高亮该页内第 occurrence 处关键词（常驻到下一个动作） */
  async revealText(pageNum: number, keyword: string, occurrence: number) {
    const pageEl = this.findPageByNumber(pageNum);
    if (!pageEl) {
      new Notice(`未找到第 ${pageNum} 页`);
      return;
    }
    // 先清掉上一次的定位高亮
    this.clearSearchFlash();
    pageEl.scrollIntoView({ block: 'start' });
    const ready = await this.waitForTextLayer(pageEl, 8000);
    if (!ready) {
      new Notice('页面尚未渲染完成，请稍后重试');
      return;
    }
    const textLayer = pageEl.querySelector('.textLayer') as HTMLElement | null;
    if (!textLayer) return;

    let segments = this._segmentsForOccurrence(keyword, textLayer, occurrence);
    // 提取文本与 DOM 文本偶有差异导致计数不一致时，退化为定位该页第一处
    if (segments.length === 0 && occurrence !== 1) {
      segments = this._segmentsForOccurrence(keyword, textLayer, 1);
    }
    if (segments.length === 0) return;

    const spans: HTMLElement[] = [];
    for (const seg of segments) {
      const span = this.wrapAndStyle(seg, (el) => el.addClass('fleur-search-flash'));
      if (span) spans.push(span);
    }
    // 检索跳转：常驻到下一个动作
    this.applyFlash(spans, true);
  }

  /** 侧边栏定位：滚动到标注所在页并高亮标注片段（常驻到下一个动作，与检索定位共用样式与清除逻辑） */
  async revealAnnotation(ann: Annotation) {
    this.clearSearchFlash();

    const startPage = ann.page;
    const endPage = ann.endPage || ann.page;
    const pageEls: HTMLElement[] = [];
    for (let p = startPage; p <= endPage; p++) {
      const el = this.findPageByNumber(p);
      if (el) pageEls.push(el);
    }
    if (pageEls.length === 0) {
      new Notice(`未找到第 ${startPage} 页`);
      return;
    }

    // 起始页可能未渲染（懒渲染），先滚动过去等 textLayer 就绪
    const first = pageEls[0];
    first.scrollIntoView({ block: 'start' });
    const ready = await this.waitForTextLayer(first, 8000);
    if (!ready) {
      new Notice('页面尚未渲染完成，请稍后重试');
      return;
    }

    // 优先复用已渲染的标注片段（恢复流程画上去的正式标注）
    let spans: HTMLElement[] = [];
    for (const p of pageEls) {
      p.querySelectorAll(`[data-ann-id="${ann.id}"]`).forEach((el) => spans.push(el as HTMLElement));
    }

    // 片段不存在（页面被 pdf.js 重渲染、恢复流程尚未跑完）→ 按文本匹配临时定位，只闪不落库
    if (spans.length === 0) {
      const portions: Array<{ page: number; text: string }> = [];
      if (endPage > startPage) {
        const split = this.splitAnnotationTextByPage(ann.text, startPage, endPage);
        for (const [page, text] of split.entries()) portions.push({ page, text });
      } else {
        portions.push({ page: startPage, text: ann.text });
      }
      for (const { page, text } of portions) {
        const el = page === startPage ? first : this.findPageByNumber(page);
        const tl = el?.querySelector('.textLayer') as HTMLElement | null;
        if (!el || !tl || (tl.textContent || '').trim().length === 0) continue;
        for (const seg of this._collectByTextMatch(text, tl)) {
          const span = this.wrapAndStyle(seg, (s) => s.addClass('fleur-search-flash'));
          if (span) spans.push(span);
        }
      }
    }

    if (spans.length === 0) {
      new Notice('未能在原文中定位到该标注');
      return;
    }

    // 已渲染的正式标注只叠加闪烁样式（清除时 removeFlashFrom 会区分 annId）
    this.applyFlash(spans);
    // 精确滚到标注处（长页时只滚到页首可能看不到目标位置）
    spans[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** 在页面 textLayer 中定位关键词第 occurrence 次出现的片段（大小写不敏感 + NFKC 兜底） */
  private _segmentsForOccurrence(keyword: string, textLayer: HTMLElement, occurrence: number): TextSegment[] {
    const kw = keyword.trim();
    if (!kw) return [];

    const nodes: { node: Text; content: string }[] = [];
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, null);
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) {
      const content = n.textContent || '';
      if (!content.trim()) continue;
      nodes.push({ node: n, content });
    }
    if (nodes.length === 0) return [];

    let fullText = '';
    const map: { node: Text; start: number; end: number }[] = [];
    for (const { node, content } of nodes) {
      const s = fullText.length;
      fullText += content;
      map.push({ node, start: s, end: fullText.length });
    }

    const findOccurrence = (haystack: string, needle: string, occ: number): number => {
      let idx = haystack.indexOf(needle);
      let count = 1;
      while (idx !== -1 && count < occ) {
        idx = haystack.indexOf(needle, idx + needle.length);
        count++;
      }
      return idx;
    };

    // 策略1: 大小写不敏感精确匹配（长度不变时偏移才可靠）
    const lowerFull = fullText.toLowerCase();
    let idx = -1;
    if (lowerFull.length === fullText.length) {
      idx = findOccurrence(lowerFull, kw.toLowerCase(), occurrence);
    }
    // 策略2: NFKC 规范化兜底（与 _collectByTextMatch 同思路）
    if (idx === -1) {
      const nfkcFull = this.normalizeText(fullText).toLowerCase();
      const nfkcKw = this.normalizeText(kw).toLowerCase();
      if (nfkcFull.length === fullText.length) {
        idx = findOccurrence(nfkcFull, nfkcKw, occurrence);
      }
    }
    if (idx === -1) return [];
    return this._textRangeToSegments(map, idx, idx + kw.length);
  }

  // ════════════════════════════════════════════
  //  卸载
  // ════════════════════════════════════════════

  uninstall() {
    // 清理恢复定时器
    if (this.restoreTimer) {
      window.clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }

    if (this.boundContextMenu) {
      document.removeEventListener('contextmenu', this.boundContextMenu, true);
      this.boundContextMenu = null;
    }
    if (this.boundMouseDown) {
      document.removeEventListener('mousedown', this.boundMouseDown, true);
      this.boundMouseDown = null;
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp, true);
      this.boundMouseUp = null;
    }
    if (this.boundKeyDown) {
      document.removeEventListener('keydown', this.boundKeyDown, true);
      this.boundKeyDown = null;
    }
    if (this.boundSelectionChange) {
      document.removeEventListener('selectionchange', this.boundSelectionChange);
      this.boundSelectionChange = null;
    }
    if (this.boundAnnotationTap) {
      document.removeEventListener('click', this.boundAnnotationTap, true);
      this.boundAnnotationTap = null;
    }
    // 0.5 起不再有 touchstart / touchmove / touchend 的菜单相关监听
    // （随「手势静默期」一并移除，见 onSelectionChange 的说明）
    if (this.selectionMenuTimer !== null) {
      window.clearTimeout(this.selectionMenuTimer);
      this.selectionMenuTimer = null;
    }
    this.hideContextMenu();
    this.stopPdfViewerWatcher();
    this.commentBubbles.forEach(b => b.el.remove());
    this.commentBubbles = [];
  }
}
