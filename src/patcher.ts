// PDF 视图拦截 + 右键菜单 + 批注气泡
// 核心策略：mouseup 时保存 Range 对象（持有 DOM 节点引用），
// 右键菜单点击时直接用 Range + compareBoundaryPoints 定位 segments
import { Menu, Modal, Notice } from 'obsidian';
import type FleurPDFPlugin from './main';
import type { Annotation } from './types';
import { AIChatPanel } from './ai-chat-modal';

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

/** 选区快照 — mouseup 时立即计算 segments 并保存，右键时直接使用 */
interface SelectionSnapshot {
  text: string;
  pageNum: number;
  timestamp: number;
  /** 立即计算的 segments（在 DOM 还新鲜时） */
  segments: TextSegment[];
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

  // ── 标注恢复相关 ──
  private currentPagePath: string | null = null;
  private restoreTimer: number | null = null;
  private pdfViewerObserver: MutationObserver | null = null;

  constructor(private plugin: FleurPDFPlugin) {}

  install() {
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
  }

  /** 用 MutationObserver 直接监听 PDF viewer 容器内的 .page 元素变化 */
  private startPdfViewerWatcher() {
    this.stopPdfViewerWatcher();
    
    // 查找 PDF viewer 容器
    const container = document.querySelector('.pdf-viewer, .pdf-scroll-container, .pdf-container, .pdfViewer');
    if (!container) return;
    
    this.pdfViewerObserver = new MutationObserver((mutations) => {
      // 检查是否有新页面被添加
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

  /** 为当前 PDF 文件恢复所有已保存的标注 */
  async restoreAnnotationsForFile(filePath: string, attempt = 0): Promise<void> {
    console.log('[FleurPDF] restoreAnnotationsForFile called for:', filePath, 'attempt:', attempt);
    const data = await this.plugin.store.load(filePath);
    console.log('[FleurPDF] Loaded data, annotations count:', data.annotations?.length || 0);
    if (!data.annotations || data.annotations.length === 0) return;

    const MAX_ATTEMPTS = 6;
    let restored = 0;
    let needsRetry = false;

    for (const ann of data.annotations) {
      // 实时检查 DOM 上是否已有该 ID 的标注元素（幂等）
      if (document.querySelector(`[data-ann-id="${ann.id}"]`)) {
        continue;
      }

      const pageEl = this.findPageByNumber(ann.page);
      if (!pageEl) {
        needsRetry = true;
        continue;
      }

      // 等待 textLayer 渲染完成（首次和重试时都等待）
      if (attempt === 0) {
        // 首次尝试：异步等待 textLayer 就绪
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

      const textLayerContent = textLayer.textContent || '';
      if (textLayerContent.trim().length === 0) {
        needsRetry = true;
        continue;
      }

      // 用文本匹配定位 segments
      const segments = this._collectByTextMatch(ann.text, textLayer);
      if (segments.length === 0) {
        console.log('[FleurPDF] No segments found for annotation:', ann.id, 'attempt:', attempt);
        // 仅在最后一次尝试时打印详细调试信息
        if (attempt >= MAX_ATTEMPTS - 1) {
          const normalizedTarget = this.normalizeText(ann.text);
          const normalizedLayer = this.normalizeText(textLayerContent.substring(0, 100));
          console.log('[FleurPDF] Target (raw):', ann.text.substring(0, 60));
          console.log('[FleurPDF] Target (NFKC):', normalizedTarget.substring(0, 60));
          console.log('[FleurPDF] Layer (raw):', textLayerContent.substring(0, 60));
          console.log('[FleurPDF] Layer (NFKC):', normalizedLayer.substring(0, 60));
        }
        needsRetry = true;
        continue;
      }

      if (ann.type === 'highlight' || ann.type === 'comment') {
        const hlColor = ann.color || '#FFC107';
        segments.forEach((seg) => {
          this.wrapAndStyle(seg, (el) => {
            el.setCssStyles({ background: hlColor });
            el.addClass('fleur-highlight');
            el.dataset['annId'] = ann.id;
          });
        });

        // 恢复批注气泡
        if (ann.type === 'comment' && ann.comment) {
          const firstSpan = this.findAnnotationSpan(pageEl, ann.id);
          if (firstSpan) {
            this.addCommentBubble(ann.comment, firstSpan, pageEl, ann.id);
          }
        }
      } else if (ann.type === 'underline') {
        const ulColor = ann.color || '#E8590C';
        segments.forEach((seg) => {
          this.wrapAndStyle(seg, (el) => {
            el.addClass('fleur-underline');
            el.addClass(ann.underlineStyle === 'wavy' ? 'fleur-underline-wavy' : 'fleur-underline-solid');
            el.setCssProps({ '--fleur-underline-color': ulColor });
            el.dataset['annId'] = ann.id;
          });
        });
      }

      restored++;
    }
    console.log('[FleurPDF] Restore complete, restored:', restored, 'attempt:', attempt);

    // 如果有标注未恢复且还有重试机会，调度下一次重试
    if (needsRetry && attempt < MAX_ATTEMPTS) {
      console.log('[FleurPDF] Scheduling retry, attempt:', attempt + 1);
      this.scheduleRestore(filePath, attempt + 1);
    }
  }

  /** 找到某个批注 ID 对应的第一个已标注 span */
  private findAnnotationSpan(pageEl: HTMLElement, annId: string): HTMLElement | null {
    const spans = pageEl.querySelectorAll(`[data-ann-id="${annId}"]`);
    return spans.length > 0 ? (spans[0] as HTMLElement) : null;
  }

  // ════════════════════════════════════════════
  //  选区保存 — 核心：保存 Range 对象
  // ════════════════════════════════════════════

  private findPageEl(target: Node | null): HTMLElement | null {
    if (!target) return null;
    // Text 节点没有 .closest()，先取父元素
    const el = target.nodeType === Node.TEXT_NODE ? target.parentElement : target as HTMLElement;
    return el?.closest?.('.page') ?? null;
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
    if (!this.isInPDFView(e.target)) {
      return;
    }

    // 同步处理选区（不用 rAF，避免 Obsidian 清空选区）
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      return;
    }

    const range = selection.getRangeAt(0);

    // 验证 Range 在 PDF 页面内（findPageEl 已处理 Text 节点）
    const pageEl = this.findPageEl(range.commonAncestorContainer);
    if (!pageEl) {
      return;
    }

    const pageNum = parseInt(pageEl.getAttribute('data-page-number') || '1');

    // 立即计算 segments（此时 DOM 还新鲜）
    const segments = this.collectSegmentsFromRange(range, pageNum);

    this.lastSnapshot = {
      text,
      pageNum,
      timestamp: Date.now(),
      segments,
    };
  }

  // ════════════════════════════════════════════
  //  右键菜单 — 用保存的 Range 直接定位 segments
  // ════════════════════════════════════════════

  private onContextMenu(e: MouseEvent) {
    if (!this.isInPDFView(e.target)) {
      return;
    }

    // 优先用当前选区（如果还活着）
    const selection = window.getSelection();
    let selectedText = (selection && !selection.isCollapsed)
      ? selection.toString().trim()
      : '';
    let segments: TextSegment[] = [];
    let pageNum = 1;
    let _source = '';

    if (selectedText) {
      // 当前选区还在，立即计算 segments
      _source = 'live-selection';
      const range = selection!.getRangeAt(0);
      const pageEl = this.findPageEl(range.commonAncestorContainer);
      if (pageEl) {
        pageNum = parseInt(pageEl.getAttribute('data-page-number') || '1');
        segments = this.collectSegmentsFromRange(range, pageNum);
      }
    } else if (this.lastSnapshot && Date.now() - this.lastSnapshot.timestamp < 3000) {
      // 选区已被清除（右键 mousedown 导致），用保存的快照
      _source = 'snapshot';
      selectedText = this.lastSnapshot.text;
      segments = this.lastSnapshot.segments;
      pageNum = this.lastSnapshot.pageNum;
    } else {
      return;
    }

    // 如果 segments 为空，尝试文本匹配回退
    if (segments.length === 0) {
      const pageEl = this.findPageByNumber(pageNum);
      if (pageEl) {
        const textLayer = pageEl.querySelector('.textLayer') as HTMLElement;
        if (textLayer) {
          segments = this._collectByTextMatch(selectedText, textLayer);
        }
      }
    }

    e.preventDefault();
    e.stopPropagation();

    this.showContextMenu(e.clientX, e.clientY, selectedText, pageNum, segments);
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

  private showContextMenu(
    x: number, y: number,
    text: string,
    pageNum: number,
    segments: TextSegment[]
  ) {
    const s = this.plugin.settings;
    const underlineColor = s.underlineColor || '#6B0000';
    const highlightColors = s.highlightColors.length >= 3
      ? s.highlightColors
      : ['#D4A017', '#2979C4', '#D32F2F'];

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
        void this.applyHighlight(text, pageNum, segments, color, 'highlight', filePath);
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
      void this.applyUnderline(text, pageNum, segments, 'solid', underlineColor, filePath);
      panel.remove();
    });

    // 划线 - 波浪
    const wavyUlBtn = panel.createEl('button');
    wavyUlBtn.addClass('fleur-context-item');
    wavyUlBtn.title = '波浪';
    iconUnderlineWavy(wavyUlBtn, underlineColor);
    wavyUlBtn.addEventListener('click', () => {
      void this.applyUnderline(text, pageNum, segments, 'wavy', underlineColor, filePath);
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
      this.showCommentDialog(text, pageNum, segments, filePath);
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
      this.askAI(text, '请回答关于这段内容的问题', x, y);
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
      this.askAITranslate(text, x, y);
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

    let posX = x;
    let posY = y;

    if (x + panelRect.width > vw - 8) {
      posX = vw - panelRect.width - 8;
    }
    if (y + panelRect.height > vh - 8) {
      posY = vh - panelRect.height - 8;
    }
    if (posX < 8) posX = 8;
    if (posY < 8) posY = 8;

    panel.setCssStyles({ left: `${posX}px`, top: `${posY}px` });
  }

  // ════════════════════════════════════════════
  //  DOM 辅助
  // ════════════════════════════════════════════

  /**
   * 用 Range 定位 segments
   * 优先用 DOM 遍历，失败则回退到文本内容匹配
   */
  private collectSegmentsFromRange(range: Range, pageNum: number): TextSegment[] {
    const pageEl = this.findPageByNumber(pageNum);
    if (!pageEl) {
      return [];
    }

    const textLayer = pageEl.querySelector('.textLayer') as HTMLElement;
    if (!textLayer) {
      return [];
    }

    // 第一步：DOM 遍历定位
    const result = this._collectByBoundary(range, textLayer);
    if (result.length > 0) {
      return result;
    }

    // 第二步：boundary 失败 → 文本匹配回退
    const targetText = range.toString().trim();
    if (!targetText) return [];
    
    const textResult = this._collectByTextMatch(targetText, textLayer);
    return textResult;
  }

  /**
   * 定位 segments — 用 DOM 顺序遍历，不依赖 compareBoundaryPoints
   * 核心思路：先找到 range 的起止 textNode，然后按 DOM 顺序收集中间所有节点
   */
  private _collectByBoundary(range: Range, textLayer: HTMLElement): TextSegment[] {
    // 第一步：解析 range 的起止 textNode 和偏移
    let startText: Text | null = null;
    let startOff = 0;
    let endText: Text | null = null;
    let endOff = 0;

    // 解析 startContainer
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      startText = range.startContainer as Text;
      startOff = range.startOffset;
    } else {
      // Element 节点 — startOffset 是子节点索引
      const el = range.startContainer as Element;
      const child = el.childNodes[range.startOffset];
      if (child) {
        startText = this._firstTextNode(child);
        startOff = 0;
      } else if (range.startOffset > 0) {
        const prev = el.childNodes[range.startOffset - 1];
        if (prev) {
          startText = this._lastTextNode(prev);
          startOff = startText ? startText.length : 0;
        }
      }
    }

    // 解析 endContainer
    if (range.endContainer.nodeType === Node.TEXT_NODE) {
      endText = range.endContainer as Text;
      endOff = range.endOffset;
    } else {
      const el = range.endContainer as Element;
      const child = el.childNodes[range.endOffset];
      if (child) {
        endText = this._firstTextNode(child);
        endOff = 0;
      } else if (range.endOffset > 0) {
        const prev = el.childNodes[range.endOffset - 1];
        if (prev) {
          endText = this._lastTextNode(prev);
          endOff = endText ? endText.length : 0;
        }
      }
    }

    if (!startText || !endText) {
      return [];
    }

    // 检查解析出的 textNode 是否在 textLayer 内
    if (!textLayer.contains(startText) || !textLayer.contains(endText)) {
      return [];
    }

    // 第二步：按 DOM 顺序遍历 textLayer 中的所有 textNode，收集 start→end 之间的
    const result: TextSegment[] = [];
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, null);
    let textNode: Text | null;
    let collecting = false;

    while ((textNode = walker.nextNode() as Text | null)) {
      const content = textNode.textContent || '';
      if (!content) continue;

      const parentEl = textNode.parentElement;
      if (!parentEl || parentEl.tagName !== 'SPAN') continue;
      if (parentEl.dataset['fleurSel']) continue;

      if (textNode === startText) collecting = true;

      if (!collecting) continue;

      let start = 0;
      let end = content.length;

      if (textNode === startText) {
        start = Math.min(startOff, content.length);
      }
      if (textNode === endText) {
        end = Math.min(endOff, content.length);
      }

      if (start < end) {
        result.push({ textNode, start, end });
      }

      if (textNode === endText) break;
    }

    return result;
  }

  /** 查找节点内第一个 textNode */
  private _firstTextNode(node: Node): Text | null {
    if (node.nodeType === Node.TEXT_NODE) return node as Text;
    for (const child of Array.from(node.childNodes)) {
      const found = this._firstTextNode(child);
      if (found) return found;
    }
    return null;
  }

  /** 查找节点内最后一个 textNode */
  private _lastTextNode(node: Node): Text | null {
    if (node.nodeType === Node.TEXT_NODE) return node as Text;
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const found = this._lastTextNode(node.childNodes[i]);
      if (found) return found;
    }
    return null;
  }

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
      // 去除零宽字符（NFKC 不会移除它们）
      .replace(/[\u200B\u200C\u200D\uFEFF\u2060\uFFF9\uFFFA\uFFFB]/g, '');
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
      if (parentEl.tagName === 'SPAN') {
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
  //  高亮 / 划线
  // ════════════════════════════════════════════

  private async applyHighlight(
    text: string, pageNum: number, segments: TextSegment[],
    color: string, type: 'highlight' | 'comment',
    filePath?: string | null
  ): Promise<string> {
    if (segments.length === 0) { new Notice('未找到选中文本'); return ''; }

    const annId = await this.saveAnnotation(text, pageNum, color, type, undefined, undefined, filePath);
    if (!annId) return '';

    segments.forEach((seg) => {
      this.wrapAndStyle(seg, (el) => {
        el.setCssStyles({ background: color });
        el.addClass('fleur-highlight');
        el.dataset['annId'] = annId;
      });
    });

    return annId;
  }

  private async applyUnderline(
    text: string, pageNum: number, segments: TextSegment[],
    style: UnderlineStyle, color: string,
    filePath?: string | null
  ): Promise<string> {
    if (segments.length === 0) { new Notice('未找到选中文本'); return ''; }

    const annId = await this.saveAnnotation(text, pageNum, color, 'underline', undefined, style, filePath);
    if (!annId) return '';

    segments.forEach((seg) => {
      this.wrapAndStyle(seg, (el) => {
        el.addClass('fleur-underline');
        el.addClass(style === 'wavy' ? 'fleur-underline-wavy' : 'fleur-underline-solid');
        el.setCssProps({ '--fleur-underline-color': color });
        el.dataset['annId'] = annId;
      });
    });

    return annId;
  }

  private async saveAnnotation(
    text: string, pageNum: number, color: string,
    type: 'highlight' | 'comment' | 'underline',
    comment?: string, underlineStyle?: UnderlineStyle,
    filePath?: string | null
  ): Promise<string> {
    // 优先使用传入的 filePath（菜单打开时捕获），其次才用 getActiveFile()
    const path = filePath ?? this.plugin.app.workspace.getActiveFile()?.path;
    if (!path) { new Notice('未找到当前文件'); return ''; }

    const annotation: Annotation = {
      id: this.plugin.generateId(),
      type,
      page: pageNum,
      text,
      color,
      comment,
      underlineStyle,
      createdAt: Date.now()
    };

    await this.plugin.store.addAnnotation(path, annotation);
    void this.plugin.getSidebar()?.refresh(path);
    new Notice(type === 'comment' ? '已添加批注' : type === 'underline' ? '已添加划线' : '已添加高亮');
    return annotation.id;
  }

  // ════════════════════════════════════════════
  //  批注
  // ════════════════════════════════════════════

  private showCommentDialog(text: string, pageNum: number, segments: TextSegment[], filePath?: string | null) {
    if (segments.length === 0) { new Notice('未找到选中文本'); return; }

    const hlColor = this.plugin.settings.highlightColors[0] || '#D4A017';

    // 使用传入的 filePath（菜单打开时捕获）
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
    textarea.addEventListener('focus', () => {
      textarea.addClass('is-focused');
    });
    textarea.addEventListener('blur', () => {
      textarea.removeClass('is-focused');
    });

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
        text,
        color: hlColor,
        comment,
        createdAt: Date.now()
      };
      await this.plugin.store.addAnnotation(path, annotation);
      const annId = annotation.id;

      // 2. 关闭弹窗（focus 回到 PDF 视图）
      modal.close();

      // 3. 等待 focus 稳定后再做 DOM 操作（避免 PDF.js 重新渲染清除节点）
      await new Promise((r) => window.setTimeout(r, 80));

      try {
        // 4. 高亮文本
        const styledSpans: HTMLElement[] = [];
        segments.forEach((seg) => {
          const span = this.wrapAndStyle(seg, (el) => {
            el.setCssStyles({ background: hlColor });
            el.addClass('fleur-highlight');
            el.dataset['annId'] = annId;
          });
          if (span) styledSpans.push(span);
        });

        // 如果 wrapAndStyle 全部失败（textNode 已被 PDF.js 重渲染清除），用文本匹配回退
        if (styledSpans.length === 0) {
          const pageEl = this.findPageByNumber(pageNum);
          if (pageEl) {
            const textLayer = pageEl.querySelector('.textLayer') as HTMLElement;
            if (textLayer) {
              const retrySegments = this._collectByTextMatch(text, textLayer);
              retrySegments.forEach((seg) => {
                const span = this.wrapAndStyle(seg, (el) => {
                  el.setCssStyles({ background: hlColor });
                  el.addClass('fleur-highlight');
                  el.dataset['annId'] = annId;
                });
                if (span) styledSpans.push(span);
              });
            }
          }
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
    textEl.textContent = comment;

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
    this.commentBubbles.forEach(b => b.el.remove());
    this.commentBubbles = [];
  }
}
