// 侧边栏视图 - HiNote 风格内联批注
import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer } from 'obsidian';
import type FleurPDFPlugin from './main';
import type { Annotation, PDFAnnotationData } from './types';
import { AIService } from './ai-service';

export const VIEW_TYPE_SIDEBAR = 'fleur-sidebar';

/** Create an SVG element (SVG tags aren't in HTMLElementTagNameMap) */
function createSvgEl(parent: Node, tag: string, attrs?: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
  }
  parent.appendChild(el);
  return el;
}

/** Helper: create an SVG element with children */
function appendSvg(
  container: HTMLElement,
  attrs: Record<string, string>,
  children: Array<{ tag: string; attrs: Record<string, string> }>
): SVGElement {
  const svg = createSvgEl(container, 'svg', attrs);
  for (const child of children) {
    createSvgEl(svg, child.tag, child.attrs);
  }
  return svg;
}

const SVG_ATTRS = {
  width: '14', height: '14',
  viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', 'stroke-width': '2',
  'stroke-linecap': 'round', 'stroke-linejoin': 'round',
};

export class SidebarView extends ItemView {
  private data: PDFAnnotationData | null = null;
  /** 当前正在内联编辑的标注 id */
  private editingId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: FleurPDFPlugin) {
    super(leaf);
  }

  getViewType() { return VIEW_TYPE_SIDEBAR; }
  getDisplayText() { return '批注总览'; }
  getIcon() { return 'list'; }

  async onOpen() { await this.refresh(); }

  async refresh() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'pdf') {
      this.renderEmpty();
      return;
    }
    this.data = await this.plugin.store.load(file.path);
    this.render();
  }

  // ── 空状态 ──

  private renderEmpty() {
    const c = this.contentEl;
    c.empty();
    c.addClass('fleur-sidebar-content');

    const wrap = c.createDiv();
    wrap.addClass('fleur-sidebar-empty');

    const icon = wrap.createDiv();
    icon.addClass('fleur-sidebar-empty-icon');
    appendSvg(icon,
      { width: '32', height: '32', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      [
        { tag: 'path', attrs: { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' } },
        { tag: 'polyline', attrs: { points: '14 2 14 8 20 8' } },
      ]
    );

    const txt = wrap.createDiv();
    txt.addClass('fleur-sidebar-empty-text');
    txt.textContent = '选中文本后右键开始标注';
  }

  // ── 主渲染 ──

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass('fleur-sidebar-root');

    if (!this.data || this.data.annotations.length === 0) {
      this.renderEmpty();
      return;
    }

    // 顶栏
    const header = c.createDiv();
    header.addClass('fleur-sidebar-header');

    const titleWrap = header.createDiv();
    titleWrap.addClass('fleur-sidebar-header-title-wrap');

    const title = titleWrap.createDiv({ text: '批注' });
    title.addClass('fleur-sidebar-header-title');

    const count = titleWrap.createDiv({ text: `${this.data.annotations.length}` });
    count.addClass('fleur-sidebar-header-count');

    // 导出笔记按钮
    const exportBtn = header.createEl('button');
    exportBtn.title = '导出所有批注为笔记';
    exportBtn.addClass('fleur-sidebar-export-btn');
    appendSvg(exportBtn, SVG_ATTRS, [
      { tag: 'path', attrs: { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' } },
      { tag: 'polyline', attrs: { points: '14 2 14 8 20 8' } },
      { tag: 'line', attrs: { x1: '12', y1: '18', x2: '12', y2: '12' } },
      { tag: 'polyline', attrs: { points: '9 15 12 18 15 15' } },
    ]);
    exportBtn.append(' 导出笔记');
    exportBtn.addEventListener('click', () => this.exportAllNotes());

    // 内容区
    const body = c.createDiv();
    body.addClass('fleur-sidebar-body');

    // 按页分组
    const grouped = new Map<number, Annotation[]>();
    this.data.annotations.forEach(ann => {
      if (!grouped.has(ann.page)) grouped.set(ann.page, []);
      grouped.get(ann.page)!.push(ann);
    });

    const sortedPages = Array.from(grouped.keys()).sort((a, b) => a - b);

    sortedPages.forEach(pageNum => {
      const section = body.createDiv();
      section.addClass('fleur-sidebar-section');

      // 页码标签
      const pageTag = section.createDiv();
      pageTag.addClass('fleur-sidebar-page-tag');
      pageTag.textContent = `p.${pageNum}`;

      grouped.get(pageNum)!.forEach(ann => {
        this.renderAnnotation(section, ann);
      });
    });
  }

  // ── 单条标注（HiNote 风格卡片） ──

  private renderAnnotation(parent: HTMLElement, ann: Annotation) {
    const card = parent.createDiv();
    card.addClass('fleur-sidebar-card');

    // 顶部色条
    const bar = card.createDiv();
    bar.addClass('fleur-sidebar-card-bar');
    bar.style.setProperty('--fleur-bar-color', ann.color || (ann.type === 'underline' ? '#E8590C' : '#FFC107'));

    // 主体
    const main = card.createDiv();
    main.addClass('fleur-sidebar-card-main');

    // 选中文本行（带悬停操作）
    const row = main.createDiv();
    row.addClass('fleur-sidebar-card-row');

    // 类型图标
    const typeIcon = row.createDiv();
    typeIcon.addClass('fleur-sidebar-card-type-icon');
    if (ann.type === 'highlight') {
      appendSvg(typeIcon, SVG_ATTRS, [
        { tag: 'path', attrs: { d: 'M12 20h9' } },
        { tag: 'path', attrs: { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' } },
      ]);
    } else if (ann.type === 'underline') {
      appendSvg(typeIcon, SVG_ATTRS, [
        { tag: 'path', attrs: { d: 'M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3' } },
        { tag: 'line', attrs: { x1: '4', y1: '21', x2: '20', y2: '21' } },
      ]);
    } else {
      appendSvg(typeIcon, SVG_ATTRS, [
        { tag: 'path', attrs: { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' } },
      ]);
    }

    // 选中文本
    const textWrap = row.createDiv();
    textWrap.addClass('fleur-sidebar-card-text-wrap');

    const textEl = textWrap.createDiv();
    textEl.addClass('fleur-sidebar-card-text');
    textEl.textContent = ann.text;

    // 操作按钮（悬停显示）
    const actions = row.createDiv();
    actions.addClass('fleur-sidebar-card-actions');

    // AI 生成批注按钮
    const aiBtn = actions.createEl('button');
    aiBtn.title = 'AI 生成批注';
    aiBtn.addClass('fleur-sidebar-icon-btn');
    appendSvg(aiBtn, SVG_ATTRS, [
      { tag: 'path', attrs: { d: 'M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22' } },
      { tag: 'path', attrs: { d: 'M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93' } },
      { tag: 'path', attrs: { d: 'M8 6h8' } },
      { tag: 'path', attrs: { d: 'M9 10h6' } },
      { tag: 'path', attrs: { d: 'M10 14h4' } },
      { tag: 'path', attrs: { d: 'M11 18h2' } },
    ]);
    aiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.generateAIComment(ann);
    });

    // 删除按钮
    const delBtn = actions.createEl('button');
    delBtn.title = '删除';
    delBtn.addClass('fleur-sidebar-icon-btn');
    delBtn.addClass('danger');
    appendSvg(delBtn, SVG_ATTRS, [
      { tag: 'line', attrs: { x1: '18', y1: '6', x2: '6', y2: '18' } },
      { tag: 'line', attrs: { x1: '6', y1: '6', x2: '18', y2: '18' } },
    ]);
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.deleteAnnotation(ann);
    });

    // 批注区：有内容时显示文本 + 编辑入口；编辑时变为 textarea
    // ★ 始终显示在文本下方（有批注时），无需点击按钮展开
    const commentSlot = main.createDiv();
    commentSlot.dataset['commentSlotFor'] = ann.id;

    if (ann.comment) {
      this.renderCommentDisplay(commentSlot, ann);
    } else {
      // 无批注时，显示一个低调的"添加批注"入口
      this.renderAddCommentHint(commentSlot, ann);
    }

    // 时间戳
    const footer = main.createDiv();
    footer.addClass('fleur-sidebar-footer');
    footer.textContent = new Date(ann.createdAt).toLocaleString('zh-CN');
  }

  /** 显示批注文本 + 编辑/删除小图标（悬停出现） */
  private renderCommentDisplay(slot: HTMLElement, ann: Annotation) {
    slot.empty();
    const wrap = slot.createDiv();
    wrap.addClass('fleur-sidebar-comment-display');

    const text = wrap.createDiv();
    text.addClass('fleur-sidebar-comment-text');
    // 用 MarkdownRenderer 渲染批注内容（支持 **加粗**、标题、列表等格式）
    if (ann.comment) {
      MarkdownRenderer.renderMarkdown(
        ann.comment,
        text,
        this.app.workspace.getActiveFile()?.path ?? '',
        this.plugin
      );
    } else {
      text.textContent = '';
    }

    // 悬停操作（右上角）
    const ops = wrap.createDiv();
    ops.addClass('fleur-sidebar-comment-ops');

    const editBtn = ops.createEl('button');
    editBtn.title = '编辑';
    editBtn.addClass('fleur-sidebar-comment-ops-btn');
    appendSvg(editBtn, { ...SVG_ATTRS, width: '12', height: '12' }, [
      { tag: 'path', attrs: { d: 'M12 20h9' } },
      { tag: 'path', attrs: { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' } },
    ]);
    editBtn.addEventListener('click', () => void this.openCommentEditor(slot, ann, true));

    const delCommentBtn = ops.createEl('button');
    delCommentBtn.title = '删除批注';
    delCommentBtn.addClass('fleur-sidebar-comment-ops-btn');
    delCommentBtn.addClass('danger');
    appendSvg(delCommentBtn, { ...SVG_ATTRS, width: '12', height: '12' }, [
      { tag: 'polyline', attrs: { points: '3 6 5 6 21 6' } },
      { tag: 'path', attrs: { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' } },
    ]);
    delCommentBtn.addEventListener('click', async () => {
      await this.clearComment(ann);
    });
  }

  /** 无批注时显示的小入口（点击展开编辑器） */
  private renderAddCommentHint(slot: HTMLElement, ann: Annotation) {
    slot.empty();
    const hint = slot.createDiv();
    hint.addClass('fleur-sidebar-add-hint');
    appendSvg(hint, { ...SVG_ATTRS, width: '12', height: '12' }, [
      { tag: 'line', attrs: { x1: '12', y1: '5', x2: '12', y2: '19' } },
      { tag: 'line', attrs: { x1: '5', y1: '12', x2: '19', y2: '12' } },
    ]);
    hint.createSpan({ text: '添加批注' });
    hint.addEventListener('click', () => void this.openCommentEditor(slot, ann, false));
  }

  /** 把批注区切换为 textarea 编辑器 */
  private async openCommentEditor(slot: HTMLElement, ann: Annotation, isEdit: boolean) {
    slot.empty();
    const wrap = slot.createDiv();
    wrap.addClass('fleur-sidebar-editor-wrap');

    // 如果是编辑 AI 生成的批注，先显示预览，再进入编辑
    const textarea = wrap.createEl('textarea');
    textarea.value = ann.comment || '';
    textarea.placeholder = '写批注…';
    textarea.addClass('fleur-sidebar-textarea');
    // 自动撑高 textarea 以显示全部内容
    window.setTimeout(() => {
      textarea.style.setProperty('height', 'auto');
      textarea.style.setProperty('height', Math.min(Math.max(textarea.scrollHeight, 120), 400) + 'px');
    }, 10);
    textarea.addEventListener('input', () => {
      textarea.style.setProperty('height', 'auto');
      textarea.style.setProperty('height', Math.min(Math.max(textarea.scrollHeight, 120), 400) + 'px');
    });

    const btnRow = wrap.createDiv();
    btnRow.addClass('fleur-sidebar-editor-btn-row');

    if (isEdit) {
      const cancelBtn = btnRow.createEl('button', { text: '取消' });
      cancelBtn.addClass('fleur-sidebar-editor-btn');
      cancelBtn.addClass('cancel');
      cancelBtn.addEventListener('click', () => {
        this.renderCommentDisplay(slot, ann);
      });

      // 删除批注按钮
      const delBtn = btnRow.createEl('button', { text: '删除' });
      delBtn.addClass('fleur-sidebar-editor-btn');
      delBtn.addClass('danger');
      delBtn.addEventListener('click', async () => {
        await this.clearComment(ann);
      });
    }

    const saveBtn = btnRow.createEl('button', { text: '保存' });
    saveBtn.addClass('fleur-sidebar-editor-btn');
    saveBtn.addClass('save');
    saveBtn.addEventListener('click', async () => {
      const val = textarea.value.trim();
      if (!val) { new Notice('批注不能为空'); return; }

      const file = this.app.workspace.getActiveFile();
      if (!file) return;
      const data = await this.plugin.store.load(file.path);
      const target = data.annotations.find(a => a.id === ann.id);
      if (target) {
        target.comment = val;
        await this.plugin.store.save(data);

        // 同步气泡
        this.plugin.patcher?.removeCommentBubble(ann.id);
        const anchor = document.querySelector(`[data-ann-id="${ann.id}"]`) as HTMLElement;
        const pageEl = anchor?.closest('.page') as HTMLElement;
        if (anchor && pageEl) {
          this.plugin.patcher?.addCommentBubbleFromSidebar(val, anchor, pageEl, ann.id);
        }
      }

      new Notice('已保存');
      await this.refresh();
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveBtn.click();
      }
      if (e.key === 'Escape') {
        if (isEdit) this.renderCommentDisplay(slot, ann);
        else this.renderAddCommentHint(slot, ann);
      }
    });

    window.setTimeout(() => textarea.focus(), 30);
  }

  /** 删除批注（保留高亮/划线，仅删除 comment 字段） */
  private async clearComment(ann: Annotation) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const data = await this.plugin.store.load(file.path);
    const target = data.annotations.find(a => a.id === ann.id);
    if (target) {
      target.comment = undefined;
      await this.plugin.store.save(data);
      this.plugin.patcher?.removeCommentBubble(ann.id);
    }
    new Notice('已删除批注');
    await this.refresh();
  }

  // ── 内联编辑器（HiNote 风格，不弹 Modal） ──

  private toggleInlineEditor(card: HTMLElement, ann: Annotation) {
    const editorContainer = card.querySelector(
      `[data-editor-for="${ann.id}"]`
    ) as HTMLElement;
    if (!editorContainer) return;

    // 如果已经展开，收起
    if (editorContainer.style.display !== 'none') {
      editorContainer.hide();
      editorContainer.empty();
      this.editingId = null;
      return;
    }

    // 展开编辑器
    this.editingId = ann.id;
    editorContainer.empty();
    editorContainer.show();
    editorContainer.addClass('fleur-sidebar-inline-editor');

    const textarea = editorContainer.createEl('textarea');
    textarea.value = ann.comment || '';
    textarea.placeholder = '写批注…';
    textarea.addClass('fleur-sidebar-inline-textarea');

    const btnRow = editorContainer.createDiv();
    btnRow.addClass('fleur-sidebar-inline-btn-row');

    if (ann.comment) {
      // 已有批注：显示"清除"和"保存"
      const clearBtn = btnRow.createEl('button', { text: '清除' });
      clearBtn.addClass('fleur-sidebar-inline-btn');
      clearBtn.addClass('clear');
      clearBtn.addEventListener('click', async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        const data = await this.plugin.store.load(file.path);
        const target = data.annotations.find(a => a.id === ann.id);
        if (target) {
          target.comment = undefined;
          await this.plugin.store.save(data);
          this.plugin.patcher?.removeCommentBubble(ann.id);
        }
        editorContainer.hide();
        editorContainer.empty();
        this.editingId = null;
        new Notice('已清除批注');
        await this.refresh();
      });
    }

    const saveBtn = btnRow.createEl('button', { text: '保存' });
    saveBtn.addClass('fleur-sidebar-inline-btn');
    saveBtn.addClass('save');
    saveBtn.addEventListener('click', async () => {
      const val = textarea.value.trim();
      if (!val) { new Notice('批注不能为空'); return; }

      const file = this.app.workspace.getActiveFile();
      if (!file) return;
      const data = await this.plugin.store.load(file.path);
      const target = data.annotations.find(a => a.id === ann.id);
      if (target) {
        target.comment = val;
        await this.plugin.store.save(data);

        // 同步气泡
        this.plugin.patcher?.removeCommentBubble(ann.id);
        const anchor = document.querySelector(`[data-ann-id="${ann.id}"]`) as HTMLElement;
        const pageEl = anchor?.closest('.page') as HTMLElement;
        if (anchor && pageEl) {
          this.plugin.patcher?.addCommentBubbleFromSidebar(val, anchor, pageEl, ann.id);
        }
      }

      editorContainer.hide();
      editorContainer.empty();
      this.editingId = null;
      new Notice('已保存');
      await this.refresh();
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveBtn.click();
      }
      if (e.key === 'Escape') {
        editorContainer.hide();
        editorContainer.empty();
        this.editingId = null;
      }
    });

    window.setTimeout(() => textarea.focus(), 50);
  }

  // ── AI 生成批注 ──

  private async generateAIComment(ann: Annotation) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    // 检查 API Key 是否配置
    if (!this.plugin.settings.apiKey) {
      new Notice('请先在设置中配置 AI API Key');
      return;
    }

    // 找到侧边栏中对应的评论槽位
    const commentSlot = this.contentEl.querySelector<HTMLElement>(`[data-comment-slot-for="${ann.id}"]`);
    if (!commentSlot) return;

    // 显示加载状态
    commentSlot.empty();
    const loadingWrap = commentSlot.createDiv();
    loadingWrap.addClass('fleur-sidebar-ai-loading');

    // 旋转动画
    const spinner = loadingWrap.createDiv();
    spinner.addClass('fleur-sidebar-ai-spinner');

    const loadingText = loadingWrap.createDiv({ text: 'AI 正在生成批注…' });
    loadingText.addClass('fleur-sidebar-ai-loading-text');

    const aiService = new AIService(this.plugin);
    const fullResponse: string[] = [];

    const messages = [
      {
        role: 'system' as const,
        content: '你是一位专业的文献阅读助手。请根据用户提供的高亮文本，给出简明扼要的批注，包括：关键词释义、核心要点、深层含义。批注应简洁有力，适合用作阅读笔记。请用中文回答。'
      },
      {
        role: 'user' as const,
        content: `请为以下高亮文本生成批注：\n\n「${ann.text}」`
      }
    ];

    await aiService.streamChat(
      messages,
      (chunk) => {
        fullResponse.push(chunk);
        // 实时显示正在生成的内容
        const currentText = fullResponse.join('');
        loadingText.textContent = currentText;
        loadingText.addClass('fleur-sidebar-ai-loading-text-streaming');
      },
      async () => {
        // 流式完成
        const comment = fullResponse.join('').trim();
        if (!comment) {
          new Notice('AI 未能生成批注');
          commentSlot.empty();
          if (!ann.comment) {
            this.renderAddCommentHint(commentSlot, ann);
          } else {
            this.renderCommentDisplay(commentSlot, ann);
          }
          return;
        }

        // 保存到标注数据
        const data = await this.plugin.store.load(file.path);
        const target = data.annotations.find(a => a.id === ann.id);
        if (target) {
          target.comment = comment;
          await this.plugin.store.save(data);

          // 同步气泡
          this.plugin.patcher?.removeCommentBubble(ann.id);
          const anchor = document.querySelector(`[data-ann-id="${ann.id}"]`) as HTMLElement;
          const pageEl = anchor?.closest('.page') as HTMLElement;
          if (anchor && pageEl) {
            this.plugin.patcher?.addCommentBubbleFromSidebar(comment, anchor, pageEl, ann.id);
          }
        }

        new Notice('AI 批注已生成');
        await this.refresh();
      },
      (error) => {
        new Notice(`AI 生成失败：${error}`);
        commentSlot.empty();
        if (!ann.comment) {
          this.renderAddCommentHint(commentSlot, ann);
        } else {
          this.renderCommentDisplay(commentSlot, ann);
        }
      }
    );
  }

  // ── 删除 ─

  private async deleteAnnotation(ann: Annotation) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const data = await this.plugin.store.load(file.path);
    data.annotations = data.annotations.filter(a => a.id !== ann.id);
    await this.plugin.store.save(data);
    this.clearAnnotationStyles(ann);
    this.plugin.patcher?.removeCommentBubble(ann.id);
    new Notice('已删除');
    await this.refresh();
  }

  // ── 导出所有批注为笔记 ──

  private async exportAllNotes() {
    const file = this.app.workspace.getActiveFile();
    if (!file || !this.data) return;

    const noteName = `${file.basename} - 批注笔记`;
    const folder = this.plugin.settings.noteFolder?.trim() || '';
    const notePath = folder ? `${folder}/${noteName}.md` : `${noteName}.md`;

    // 确保文件夹存在
    if (folder) {
      const folderExists = await this.app.vault.adapter.exists(folder);
      if (!folderExists) {
        await this.app.vault.createFolder(folder);
      }
    }

    let md = `> 导出时间：${new Date().toLocaleString('zh-CN')}\n\n`;

    const grouped = new Map<number, Annotation[]>();
    this.data.annotations.forEach(ann => {
      if (!grouped.has(ann.page)) grouped.set(ann.page, []);
      grouped.get(ann.page)!.push(ann);
    });

    const sortedPages = Array.from(grouped.keys()).sort((a, b) => a - b);

    sortedPages.forEach(pageNum => {
      md += `## 第 ${pageNum} 页\n\n`;
      grouped.get(pageNum)!.forEach(ann => {
        // 用字体格式区分：高亮用==高亮==、划线用<u>下划线</u>、批注用浅灰色
        if (ann.type === 'highlight') {
          md += `==${ann.text}==\n\n`;
        } else if (ann.type === 'underline') {
          md += `<u>${ann.text}</u>\n\n`;
        } else {
          // 批注类型：文本用浅灰色
          md += `<span style="color:var(--text-muted)">${ann.text}</span>\n\n`;
        }
        // 如果有批注内容，用引用块显示
        if (ann.comment) {
          md += `> ${ann.comment}\n\n`;
        }
        md += `---\n\n`;
      });
    });

    // notePath 已在上方定义
    await this.app.vault.create(notePath, md);
    new Notice('笔记已导出');
  }

  // ── 清除样式 ──

  private clearAnnotationStyles(ann: Annotation) {
    const matched = document.querySelectorAll(`[data-ann-id="${ann.id}"]`);
    matched.forEach((span) => {
      const el = span as HTMLElement;
      el.style.removeProperty('background-color');
      el.style.removeProperty('border-radius');
      el.style.removeProperty('text-decoration');
      el.style.removeProperty('text-underline-offset');
      delete el.dataset['annId'];
    });

    if (matched.length === 0) {
      const pages = document.querySelectorAll(`.page[data-page-number="${ann.page}"]`);
      pages.forEach(page => {
        const textLayer = page.querySelector('.textLayer');
        if (!textLayer) return;
        textLayer.querySelectorAll('span').forEach(span => {
          if (span.textContent?.trim() === ann.text.trim()) {
            const el = span as HTMLElement;
            el.style.removeProperty('background-color');
            el.style.removeProperty('border-radius');
            el.style.removeProperty('text-decoration');
            el.style.removeProperty('text-underline-offset');
          }
        });
      });
    }
  }
}
