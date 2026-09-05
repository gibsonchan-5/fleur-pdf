// PDF 视图拦截 + 右键菜单 + 批注气泡
// ── 文本锚点架构 ──
// 核心原则：标注的"身份"是「文本 + 页码范围」，不是 DOM 节点引用。
// 初始高亮与恢复高亮走同一套文本定位管线：
//   1. 选区 → 按 Range∩页面 交集切分出"每页选中了哪些文字"
//   2. 每页内：DOM 交集遍历定位 segments；失败则降级为文本匹配
//   3. 应用时 segments 若已失效（节点被 PDF.js 重渲染），按页内文本重新匹配
//   4. 恢复时：跨页标注先按页切分文本，再逐页匹配
import { Menu, Modal, Notice } from 'obsidian';
import type FleurPDFPlugin from './main';
import type { Annotation } from './types';
import { AIChatPanel } from './ai-chat-modal';
import { markdownToPlain } from './md-utils';
import { normalizeWhitespace } from './text-utils';

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
function iconUnderlineSolid(c: Node, color: string) {
  return svgIcon(c, color, [
    { tag: 'line', attrs: { x1: '3', y1: '18', x2: '21', y2: '18' } },
  ]);
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
  private commentBubbles: CommentBubble[] = [];
  private lastSnapshot: SelectionSnapshot | null = null;
  /** 快照有效期：活选区被清空后，右键仍可用最近一次选区 */
  private static readonly SNAPSHOT_TTL_MS = 10000;

  // ── 标注恢复相关 ──
  private currentPagePath: string | null = null;
  private restoreTimer: number | null = null;
  private pdfViewerObserver: MutationObserver | null = null;
  private pdfResizeObserver: ResizeObserver | null = null;

  constructor(private plugin: FleurPDFPlugin) {}

  install() {
    console.log('[FleurPDF] patcher installed (text-anchored v2)');

    this.boundContextMenu = (e: MouseEvent) => this.onContextMenu(e);
    this.boundMouseDown = (e: MouseEvent) => this.onMouseDown(e);
    this.boundMouseUp = (e: MouseEvent) => this.onMouseUp(e);

    document.addEventListener('contextmenu', this.boundContextMenu, true);
    document.addEventListener('mousedown', this.boundMouseDown, true);
    document.addEventListener('mouseup', this.boundMouseUp, true);

    // 监听 file-open（文件切换时触发）
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file?.extension === 'pdf') {
          this.currentPagePath = file.path;
          this.scheduleRestore(file.path);
          this.startPdfViewerWatcher();
        } else {
          this.currentPagePath = null;
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

  /** 延迟去抖后触发恢复（等待 PDF.js 渲染完成） */
  private scheduleRestore(filePath: string, attempt = 0) {
    if (this.restoreTimer) window.clearTimeout(this.restoreTimer);
    // 指数退避：500ms → 1s → 2s → 3s → 5s
    const delays = [500, 1000, 2000, 3000, 5000];
    const delay = delays[Math.min(attempt, delays.length - 1)];
    this.restoreTimer = window.setTimeout(() => {
      void this.restoreAnnotationsForFile(filePath, attempt);
    }, delay);
  }

  /** 手动触发：命令「重新渲染当前 PDF 的标注」 */
  restoreNow(): void {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file || file.extension !== 'pdf') {
      new Notice('当前活动文件不是 PDF');
      return;
    }
    this.currentPagePath = file.path;
    this.startPdfViewerWatcher();
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
    const data = await this.plugin.store.load(filePath);
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

        // 等待 textLayer 渲染完成
        if (attempt === 0) {
          const ready = await this.waitForTextLayer(pageEl, 5000);
          if (!ready) {
            needsRetry = true;
            continue;
          }
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
          console.log('[FleurPDF] restore: no segments for', ann.id, 'attempt', attempt);
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

    if (!snapshot || !snapshot.text) return;

    e.preventDefault();
    e.stopPropagation();
    this.showContextMenu(e.clientX, e.clientY, snapshot);
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

  private showContextMenu(_x: number, _y: number, snapshot: SelectionSnapshot) {
    const s = this.plugin.settings;
    const underlineColor = s.underlineColor || '#6B0000';
    const highlightColors = s.highlightColors.length >= 3
      ? s.highlightColors
      : ['#D4A017', '#2979C4', '#D32F2F'];

    const { text, pageNum, endPage, pages } = snapshot;

    // 预先捕获文件路径（菜单显示后 PDF 视图可能失去焦点）
    const filePath = this.plugin.app.workspace.getActiveFile()?.path ?? null;

    // 创建浮动面板
    const panel = createDiv({ cls: 'fleur-context-panel' });

    // 复制
    const copyBtn = panel.createEl('button');
    copyBtn.addClass('fleur-context-item');
    copyBtn.title = '复制';
    iconCopy(copyBtn);
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(text).then(() => new Notice('已复制'));
      panel.remove();
    });

    // 分隔
    panel.createDiv({ cls: 'fleur-context-sep' });

    // 三个高亮颜色圆点
    const hlGroup = panel.createDiv({ cls: 'fleur-context-group' });
    highlightColors.forEach((color, idx) => {
      const hlBtn = hlGroup.createEl('button');
      hlBtn.addClass('fleur-context-item', 'fleur-context-hl');
      hlBtn.title = `高亮 ${idx + 1}`;
      const dot = hlBtn.createDiv({ cls: 'fleur-context-hl-dot' });
      dot.setCssStyles({ background: color });
      hlBtn.addEventListener('click', () => {
        void this.applyHighlight(text, pageNum, pages, color, 'highlight', filePath, endPage);
        panel.remove();
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
      panel.remove();
    });

    // 划线 - 波浪
    const wavyUlBtn = panel.createEl('button');
    wavyUlBtn.addClass('fleur-context-item');
    wavyUlBtn.title = '波浪';
    iconUnderlineWavy(wavyUlBtn, underlineColor);
    wavyUlBtn.addEventListener('click', () => {
      void this.applyUnderline(text, pageNum, pages, 'wavy', underlineColor, filePath, endPage);
      panel.remove();
    });

    // 分隔
    panel.createDiv({ cls: 'fleur-context-sep' });

    // 批注
    const commentBtn = panel.createEl('button');
    commentBtn.addClass('fleur-context-item');
    commentBtn.title = '批注';
    iconComment(commentBtn);
    commentBtn.addEventListener('click', () => {
      this.showCommentDialog(text, pageNum, pages, filePath, endPage);
      panel.remove();
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
      panel.remove();
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
      panel.remove();
    });

    // 点击外部关闭面板
    const closeHandler = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node)) {
        panel.remove();
        document.removeEventListener('mousedown', closeHandler, true);
      }
    };
    window.setTimeout(() => {
      document.addEventListener('mousedown', closeHandler, true);
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
    const idx = this.commentBubbles.findIndex(b => b.el.dataset?.['annId'] === annId);
    if (idx >= 0) {
      this.commentBubbles[idx].el.remove();
      this.commentBubbles.splice(idx, 1);
    }
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
    this.stopPdfViewerWatcher();
    this.commentBubbles.forEach(b => b.el.remove());
    this.commentBubbles = [];
  }
}
