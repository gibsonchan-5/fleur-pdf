// PDF 视图拦截 + 右键菜单 + 批注气泡
// 核心策略：mouseup 时保存 Range 对象（持有 DOM 节点引用），
// 右键菜单点击时直接用 Range + compareBoundaryPoints 定位 segments
import { Menu, Modal, Notice } from 'obsidian';
import type FleurPDFPlugin from './main';
import type { Annotation } from './types';
import { AIChatPanel } from './ai-chat-modal';

type UnderlineStyle = 'solid' | 'dashed' | 'dotted' | 'wavy';

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

export class PDFPatcher {
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;
  private boundMouseDown: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;
  private commentBubbles: CommentBubble[] = [];
  private lastSnapshot: SelectionSnapshot | null = null;

  constructor(private plugin: FleurPDFPlugin) {}

  install() {
    this.boundContextMenu = (e: MouseEvent) => this.onContextMenu(e);
    this.boundMouseDown = (e: MouseEvent) => this.onMouseDown(e);
    this.boundMouseUp = (e: MouseEvent) => this.onMouseUp(e);

    document.addEventListener('contextmenu', this.boundContextMenu, true);
    document.addEventListener('mousedown', this.boundMouseDown, true);
    document.addEventListener('mouseup', this.boundMouseUp, true);
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
    const menu = new Menu();

    // 1. 复制
    menu.addItem((item) => {
      item.setTitle('复制');
      item.setIcon('copy');
      item.onClick(() => {
        navigator.clipboard.writeText(text).then(() => {
          new Notice('已复制');
        });
      });
    });

    menu.addSeparator();

    // 2. 高亮
    menu.addItem((item) => {
      item.setTitle('高亮');
      item.setIcon('highlighter');
      item.onClick(() => {
        void this.applyHighlight(text, pageNum, segments, s.highlightColor, 'highlight');
      });
    });

    menu.addSeparator();

    // 2. 划线
    menu.addItem((item) => {
      item.setTitle('划线');
      item.setIcon('underline');
      item.onClick(() => {
        void this.applyUnderline(text, pageNum, segments, s.underlineStyle, s.underlineColor);
      });
    });

    menu.addSeparator();

    // 3. 批注
    menu.addItem((item) => {
      item.setTitle('批注');
      item.setIcon('message-square');
      item.onClick(() => {
        this.showCommentDialog(text, pageNum, segments);
      });
    });

    menu.addSeparator();

    // 4. 询问AI
    menu.addItem((item) => {
      item.setTitle('询问AI');
      item.setIcon('bot');
      item.onClick(() => this.askAI(text, '请回答关于这段内容的问题', x, y));
    });

    menu.addSeparator();

    // 5. AI 翻译
    menu.addItem((item) => {
      item.setTitle('AI 翻译');
      item.setIcon('languages');
      item.onClick(() => this.askAITranslate(text, x, y));
    });

    menu.showAtPosition({ x, y });
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

  /** 用文本内容在 textLayer 中匹配定位（回退方案） */
  private _collectByTextMatch(targetText: string, textLayer: HTMLElement): TextSegment[] {
    // 清理目标文本：去除首尾的引号、空白、标点
    const cleaned = targetText
      .trim()
      .replace(/^\s+/, '')      // 去除开头空白
      .replace(/\s+$/, '')      // 去除结尾空白
      .replace(/^\p{P}+/u, '')  // 去除开头标点
      .replace(/\p{P}+$/u, '')  // 去除结尾标点
      .trim();
    if (!cleaned) return [];

    // 收集所有文本节点（不跳过 fleurSel 标记的节点，因为用户可能想对已高亮文本再次操作）
    const nodes: { node: Text; content: string }[] = [];
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT, null);
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) {
      const content = n.textContent || '';
      if (!content.trim()) continue;  // 跳过纯空白节点
      nodes.push({ node: n, content });
    }

    // 拼接全文（节点之间加空格，因为 PDF.js 的 span 之间视觉上是有间隔的）
    let fullText = '';
    const map: { node: Text; start: number; end: number }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const { node, content } = nodes[i];
      if (i > 0) fullText += ' ';  // 节点间加空格
      const s = fullText.length;
      fullText += content;
      map.push({ node, start: s, end: fullText.length });
    }

    // 策略1: 精确匹配（清理后）
    let idx = fullText.indexOf(cleaned);
    if (idx !== -1) {
      return this._textRangeToSegments(map, idx, idx + cleaned.length);
    }

    // 策略2: 归一化空白匹配（处理 PDF.js 中多空格/换行的差异）
    const normFull = fullText.replace(/\s+/g, ' ').replace(/[\u200B\u200C\u200D\uFEFF]+/g, '').trim();
    const normTarget = cleaned.replace(/\s+/g, ' ').replace(/[\u200B\u200C\u200D\uFEFF]+/g, '').trim();
    const nIdx = normFull.indexOf(normTarget);
    if (nIdx !== -1) {
      const [origStart, origEnd] = this._normToOrig(fullText, nIdx, nIdx + normTarget.length);
      if (origStart >= 0 && origEnd > origStart) {
        const r = this._textRangeToSegments(map, origStart, origEnd);
        if (r.length > 0) {
          return r;
        }
      }
    }

    // 策略3: 按词逐个匹配（最高容错率）
    const words = normTarget.split(/\s+/).filter(w => w.length > 0);
    if (words.length >= 2) {
      const firstIdx = normFull.indexOf(words[0]);
      if (firstIdx !== -1) {
        let searchPos = firstIdx + words[0].length;
        let lastEnd = searchPos;
        let allFound = true;
        for (let wi = 1; wi < words.length; wi++) {
          const area = normFull.substring(searchPos, searchPos + 15 + words[wi].length);
          const wIdx = area.indexOf(words[wi]);
          if (wIdx >= 0) {
            lastEnd = searchPos + wIdx + words[wi].length;
            searchPos = lastEnd;
          } else { allFound = false; break; }
        }
        if (allFound || words.length <= 3) {
          const [o1, o2] = this._normToOrig(fullText, firstIdx, lastEnd);
          if (o1 >= 0 && o2 > o1) {
            const r = this._textRangeToSegments(map, o1, o2);
            if (r.length > 0) {
              return r;
            }
          }
        }
      }
    }

    return [];
  }

  /** 将归一化位置映射回原始文本位置 */
  private _normToOrig(fullText: string, normStart: number, normEnd: number): [number, number] {
    let normPos = 0;
    let oStart = -1;
    let oEnd = -1;
    for (let i = 0; i < fullText.length; i++) {
      if (/\s/.test(fullText[i]) || /[\u200B\u200C\u200D\uFEFF]/.test(fullText[i])) {
        while (i + 1 < fullText.length && (/\s/.test(fullText[i + 1]) || /[\u200B\u200C\u200D\uFEFF]/.test(fullText[i + 1]))) i++;
        if (normPos > 0) normPos++;
        continue;
      }
      if (normPos === normStart && oStart === -1) oStart = i;
      if (normPos === normEnd - 1) { oEnd = i + 1; break; }
      normPos++;
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
    color: string, type: 'highlight' | 'comment'
  ): Promise<string> {
    if (segments.length === 0) { new Notice('未找到选中文本'); return ''; }

    const annId = await this.saveAnnotation(text, pageNum, color, type);
    if (!annId) return '';

    segments.forEach((seg) => {
      this.wrapAndStyle(seg, (el) => {
        el.style.setProperty('background-color', color);
        el.addClass('fleur-highlight');
        el.dataset['annId'] = annId;
      });
    });

    return annId;
  }

  private async applyUnderline(
    text: string, pageNum: number, segments: TextSegment[],
    style: UnderlineStyle, color: string
  ): Promise<string> {
    if (segments.length === 0) { new Notice('未找到选中文本'); return ''; }

    const annId = await this.saveAnnotation(text, pageNum, color, 'underline', undefined, style);
    if (!annId) return '';

    segments.forEach((seg) => {
      this.wrapAndStyle(seg, (el) => {
        el.style.setProperty('text-decoration', style === 'wavy'
          ? `underline wavy ${color}`
          : `underline ${style} ${color}`);
        el.addClass('fleur-underline');
        el.dataset['annId'] = annId;
      });
    });

    return annId;
  }

  private async saveAnnotation(
    text: string, pageNum: number, color: string,
    type: 'highlight' | 'comment' | 'underline',
    comment?: string, underlineStyle?: UnderlineStyle
  ): Promise<string> {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return '';

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

    await this.plugin.store.addAnnotation(file.path, annotation);
    void this.plugin.getSidebar()?.refresh();
    new Notice(type === 'comment' ? '已添加批注' : type === 'underline' ? '已添加划线' : '已添加高亮');
    return annotation.id;
  }

  // ════════════════════════════════════════════
  //  批注
  // ════════════════════════════════════════════

  private showCommentDialog(text: string, pageNum: number, segments: TextSegment[]) {
    if (segments.length === 0) { new Notice('未找到选中文本'); return; }

    const hlColor = this.plugin.settings.highlightColor;

    const styledSpans: HTMLElement[] = [];
    segments.forEach((seg) => {
      const span = this.wrapAndStyle(seg, (el) => {
        el.style.setProperty('background-color', hlColor);
        el.addClass('fleur-highlight');
      });
      if (span) styledSpans.push(span);
    });

    const pageEl = styledSpans[0]?.closest<HTMLElement>('.page') ?? null;
    const firstSpan = styledSpans[0];

    const modal = new Modal(this.plugin.app);
    modal.titleEl.hide();

    const root = modal.contentEl.createDiv();
    root.addClass('fleur-comment-dialog-root');

    const quoteBlock = root.createDiv();
    quoteBlock.addClass('fleur-comment-dialog-quote');
    const quoteBar = quoteBlock.createDiv();
    quoteBar.addClass('fleur-comment-dialog-quote-bar');
    quoteBar.style.setProperty('--fleur-hl-color', hlColor);
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
      modal.close();
      const annId = await this.saveAnnotation(text, pageNum, hlColor, 'comment', comment);
      if (annId) {
        styledSpans.forEach((span) => {
          span.dataset['annId'] = annId;
        });
        if (pageEl && firstSpan) {
          this.addCommentBubble(comment, firstSpan, pageEl, annId);
        }
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
    wrapper.style.setProperty('left', `${anchorX}px`);
    wrapper.style.setProperty('top', `${anchorY - 6}px`);

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
      void this.plugin.getSidebar()?.refresh();
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
