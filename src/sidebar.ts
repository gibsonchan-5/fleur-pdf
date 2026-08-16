// 侧边栏视图 - HiNote 风格内联批注
import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer } from 'obsidian';
import type FleurPDFPlugin from './main';
import type { Annotation, PDFAnnotationData } from './types';
import { AIService } from './ai-service';

export const VIEW_TYPE_SIDEBAR = 'fleur-sidebar';

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
    c.style.padding = '24px 20px';

    const wrap = c.createDiv();
    wrap.style.cssText = 'text-align:center;margin-top:60px;';

    const icon = wrap.createDiv();
    icon.style.cssText = 'color:var(--text-faint);margin-bottom:12px;';
    icon.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

    const txt = wrap.createDiv();
    txt.style.cssText = 'color:var(--text-muted);font-size:13px;letter-spacing:0.01em;';
    txt.textContent = '选中文本后右键开始标注';
  }

  // ── 主渲染 ──

  private render() {
    const c = this.contentEl;
    c.empty();
    c.style.cssText = 'padding:0;overflow-y:auto;';

    if (!this.data || this.data.annotations.length === 0) {
      this.renderEmpty();
      return;
    }

    // 顶栏
    const header = c.createDiv();
    header.style.cssText = `
      position:sticky;top:0;z-index:10;
      padding:14px 20px 12px;
      background:var(--background-primary);
      border-bottom:1px solid var(--background-modifier-border);
      display:flex;align-items:center;justify-content:space-between;
    `;

    const titleWrap = header.createDiv();
    titleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';

    const title = titleWrap.createDiv({ text: '批注' });
    title.style.cssText = 'font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--text-normal);';

    const count = titleWrap.createDiv({ text: `${this.data.annotations.length}` });
    count.style.cssText = `
      font-size:11px;font-weight:500;
      padding:1px 6px;border-radius:8px;
      background:var(--background-secondary);
      color:var(--text-muted);
    `;

    // 导出笔记按钮
    const exportBtn = header.createEl('button');
    exportBtn.title = '导出所有批注为笔记';
    exportBtn.style.cssText = `
      display:flex;align-items:center;gap:5px;
      font-size:12px;font-weight:500;
      padding:4px 10px;border-radius:6px;
      border:1px solid var(--background-modifier-border);
      background:transparent;color:var(--text-muted);
      cursor:pointer;font-family:inherit;
      transition:all 0.15s ease;
    `;
    exportBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg> 导出笔记`;
    exportBtn.addEventListener('mouseenter', () => {
      exportBtn.style.borderColor = 'var(--interactive-accent)';
      exportBtn.style.color = 'var(--interactive-accent)';
    });
    exportBtn.addEventListener('mouseleave', () => {
      exportBtn.style.borderColor = 'var(--background-modifier-border)';
      exportBtn.style.color = 'var(--text-muted)';
    });
    exportBtn.addEventListener('click', () => this.exportAllNotes());

    // 内容区
    const body = c.createDiv();
    body.style.cssText = 'padding:12px 16px 24px;';

    // 按页分组
    const grouped = new Map<number, Annotation[]>();
    this.data.annotations.forEach(ann => {
      if (!grouped.has(ann.page)) grouped.set(ann.page, []);
      grouped.get(ann.page)!.push(ann);
    });

    const sortedPages = Array.from(grouped.keys()).sort((a, b) => a - b);

    sortedPages.forEach(pageNum => {
      const section = body.createDiv();
      section.style.cssText = 'margin-bottom:16px;';

      // 页码标签
      const pageTag = section.createDiv();
      pageTag.style.cssText = `
        display:inline-flex;align-items:center;
        font-size:11px;font-weight:500;letter-spacing:0.04em;
        color:var(--text-faint);text-transform:uppercase;
        padding:2px 0;margin-bottom:8px;
        border-bottom:1px solid var(--background-modifier-border);
        width:100%;
      `;
      pageTag.textContent = `p.${pageNum}`;

      grouped.get(pageNum)!.forEach(ann => {
        this.renderAnnotation(section, ann);
      });
    });
  }

  // ── 单条标注（HiNote 风格卡片） ──

  private renderAnnotation(parent: HTMLElement, ann: Annotation) {
    const card = parent.createDiv();
    card.style.cssText = `
      margin-bottom:6px;
      border-radius:6px;
      background:var(--background-primary);
      border:1px solid var(--background-modifier-border);
      overflow:hidden;
      transition:border-color 0.15s ease;
    `;

    // 顶部色条
    const bar = card.createDiv();
    const barColor = ann.type === 'underline'
      ? (ann.color || '#E8590C')
      : (ann.color || '#FFC107');
    bar.style.cssText = `height:2px;background:${barColor};`;

    // 主体
    const main = card.createDiv();
    main.style.cssText = 'padding:10px 12px;';

    // 选中文本行（带悬停操作）
    const row = main.createDiv();
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;';

    // 类型图标
    const typeIcon = row.createDiv();
    typeIcon.style.cssText = `
      flex-shrink:0;width:18px;height:18px;margin-top:1px;
      display:flex;align-items:center;justify-content:center;
      color:var(--text-faint);
    `;
    if (ann.type === 'highlight') {
      typeIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    } else if (ann.type === 'underline') {
      typeIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>`;
    } else {
      typeIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    }

    // 选中文本
    const textWrap = row.createDiv();
    textWrap.style.cssText = 'flex:1;min-width:0;';

    const textEl = textWrap.createDiv();
    textEl.style.cssText = `
      font-size:13px;line-height:1.5;
      color:var(--text-normal);
      word-break:break-word;
      overflow:hidden;
      display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;
    `;
    textEl.textContent = ann.text;

    // 操作按钮（悬停显示）
    const actions = row.createDiv();
    actions.style.cssText = `
      flex-shrink:0;display:flex;gap:2px;
      opacity:0;transition:opacity 0.12s ease;
    `;
    card.addEventListener('mouseenter', () => { actions.style.opacity = '1'; });
    card.addEventListener('mouseleave', () => { actions.style.opacity = '0'; });

    // AI 生成批注按钮
    const aiBtn = actions.createEl('button');
    aiBtn.title = 'AI 生成批注';
    aiBtn.style.cssText = `
      width:22px;height:22px;padding:3px;
      border:none;background:transparent;
      color:var(--text-faint);cursor:pointer;border-radius:3px;
      display:flex;align-items:center;justify-content:center;
    `;
    aiBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93"/><path d="M8 6h8"/><path d="M9 10h6"/><path d="M10 14h4"/><path d="M11 18h2"/></svg>`;
    aiBtn.addEventListener('mouseenter', () => {
      aiBtn.style.background = 'var(--background-modifier-hover)';
      aiBtn.style.color = 'var(--interactive-accent)';
    });
    aiBtn.addEventListener('mouseleave', () => {
      aiBtn.style.background = 'transparent';
      aiBtn.style.color = 'var(--text-faint)';
    });
    aiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.generateAIComment(ann);
    });

    // 删除按钮
    const delBtn = actions.createEl('button');
    delBtn.title = '删除';
    delBtn.style.cssText = `
      width:22px;height:22px;padding:3px;
      border:none;background:transparent;
      color:var(--text-faint);cursor:pointer;border-radius:3px;
      display:flex;align-items:center;justify-content:center;
    `;
    delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    delBtn.addEventListener('mouseenter', () => {
      delBtn.style.background = 'var(--background-modifier-hover)';
      delBtn.style.color = 'var(--text-error)';
    });
    delBtn.addEventListener('mouseleave', () => {
      delBtn.style.background = 'transparent';
      delBtn.style.color = 'var(--text-faint)';
    });
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteAnnotation(ann);
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
    footer.style.cssText = `
      margin-top:6px;margin-left:26px;
      font-size:11px;color:var(--text-faint);
      letter-spacing:0.01em;
    `;
    footer.textContent = new Date(ann.createdAt).toLocaleString('zh-CN');
  }

  /** 显示批注文本 + 编辑/删除小图标（悬停出现） */
  private renderCommentDisplay(slot: HTMLElement, ann: Annotation) {
    slot.empty();
    const wrap = slot.createDiv();
    wrap.style.cssText = `
      margin-top:8px;margin-left:26px;
      padding:8px 10px;
      border-left:2px solid var(--interactive-accent);
      background:var(--background-secondary);
      border-radius:0 4px 4px 0;
      position:relative;
    `;

    const text = wrap.createDiv();
    text.style.cssText = `
      font-size:12.5px;line-height:1.6;
      color:var(--text-normal);
      word-break:break-word;
      padding-right:36px;
    `;
    // 用 MarkdownRenderer 渲染批注内容（支持 **加粗**、标题、列表等格式）
    if (ann.comment) {
      MarkdownRenderer.renderMarkdown(
        ann.comment,
        text,
        this.app.workspace.getActiveFile()?.path ?? '',
        this.plugin as any
      );
    } else {
      text.textContent = '';
    }

    // 悬停操作（右上角）
    const ops = wrap.createDiv();
    ops.style.cssText = `
      position:absolute;top:6px;right:6px;
      display:flex;gap:2px;
      opacity:0;transition:opacity 0.12s ease;
    `;
    wrap.addEventListener('mouseenter', () => { ops.style.opacity = '1'; });
    wrap.addEventListener('mouseleave', () => { ops.style.opacity = '0'; });

    const iconBtnStyle = `
      width:20px;height:20px;padding:2px;
      border:none;background:transparent;
      color:var(--text-muted);cursor:pointer;border-radius:3px;
      display:flex;align-items:center;justify-content:center;
    `;

    const editBtn = ops.createEl('button');
    editBtn.title = '编辑';
    editBtn.style.cssText = iconBtnStyle;
    editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    editBtn.addEventListener('mouseenter', () => { editBtn.style.background = 'var(--background-modifier-hover)'; });
    editBtn.addEventListener('mouseleave', () => { editBtn.style.background = 'transparent'; });
    editBtn.addEventListener('click', () => this.openCommentEditor(slot, ann, true));

    const delCommentBtn = ops.createEl('button');
    delCommentBtn.title = '删除批注';
    delCommentBtn.style.cssText = iconBtnStyle;
    delCommentBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    delCommentBtn.addEventListener('mouseenter', () => {
      delCommentBtn.style.background = 'var(--background-modifier-hover)';
      delCommentBtn.style.color = 'var(--text-error)';
    });
    delCommentBtn.addEventListener('mouseleave', () => {
      delCommentBtn.style.background = 'transparent';
      delCommentBtn.style.color = 'var(--text-muted)';
    });
    delCommentBtn.addEventListener('click', async () => {
      await this.clearComment(ann);
    });
  }

  /** 无批注时显示的小入口（点击展开编辑器） */
  private renderAddCommentHint(slot: HTMLElement, ann: Annotation) {
    slot.empty();
    const hint = slot.createDiv();
    hint.style.cssText = `
      margin-top:6px;margin-left:26px;
      font-size:12px;color:var(--text-faint);
      cursor:pointer;padding:4px 8px;
      border-radius:3px;display:inline-flex;align-items:center;gap:5px;
      transition:all 0.12s ease;
    `;
    hint.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>添加批注</span>`;
    hint.addEventListener('mouseenter', () => {
      hint.style.color = 'var(--interactive-accent)';
      hint.style.background = 'var(--background-modifier-hover)';
    });
    hint.addEventListener('mouseleave', () => {
      hint.style.color = 'var(--text-faint)';
      hint.style.background = 'transparent';
    });
    hint.addEventListener('click', () => this.openCommentEditor(slot, ann, false));
  }

  /** 把批注区切换为 textarea 编辑器 */
  private async openCommentEditor(slot: HTMLElement, ann: Annotation, isEdit: boolean) {
    slot.empty();
    const wrap = slot.createDiv();
    wrap.style.cssText = `
      margin-top:8px;margin-left:26px;
      padding:8px 10px;
      border-left:2px solid var(--interactive-accent);
      background:var(--background-secondary);
      border-radius:0 4px 4px 0;
    `;

    // 如果是编辑 AI 生成的批注，先显示预览，再进入编辑
    const textarea = wrap.createEl('textarea');
    textarea.value = ann.comment || '';
    textarea.placeholder = '写批注…';
    textarea.style.cssText = `
      width:100%;min-height:120px;max-height:400px;
      padding:8px 10px;
      border:1px solid var(--background-modifier-border);
      border-radius:4px;resize:vertical;
      font-size:12.5px;line-height:1.6;
      font-family:inherit;
      color:var(--text-normal);
      background:var(--background-primary);
      outline:none;box-sizing:border-box;
    `;
    // 自动撑高 textarea 以显示全部内容
    setTimeout(() => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(Math.max(textarea.scrollHeight, 120), 400) + 'px';
    }, 10);
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(Math.max(textarea.scrollHeight, 120), 400) + 'px';
    });

    const btnRow = wrap.createDiv();
    btnRow.style.cssText = `
      display:flex;justify-content:flex-end;gap:6px;margin-top:6px;
    `;

    if (isEdit) {
      const cancelBtn = btnRow.createEl('button', { text: '取消' });
      cancelBtn.style.cssText = `
        font-size:11.5px;padding:2px 8px;border-radius:3px;
        border:1px solid var(--background-modifier-border);
        background:transparent;color:var(--text-muted);
        cursor:pointer;font-family:inherit;
      `;
      cancelBtn.addEventListener('click', () => {
        this.renderCommentDisplay(slot, ann);
      });

      // 删除批注按钮
      const delBtn = btnRow.createEl('button', { text: '删除' });
      delBtn.style.cssText = `
        font-size:11.5px;padding:2px 8px;border-radius:3px;
        border:1px solid var(--background-modifier-border);
        background:transparent;color:var(--text-error);
        cursor:pointer;font-family:inherit;
      `;
      delBtn.addEventListener('click', async () => {
        await this.clearComment(ann);
      });
    }

    const saveBtn = btnRow.createEl('button', { text: '保存' });
    saveBtn.style.cssText = `
      font-size:11.5px;padding:2px 10px;border-radius:3px;
      border:none;background:var(--interactive-accent);
      color:var(--text-on-accent);
      cursor:pointer;font-weight:500;font-family:inherit;
    `;
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

    setTimeout(() => textarea.focus(), 30);
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
      editorContainer.style.display = 'none';
      editorContainer.empty();
      this.editingId = null;
      return;
    }

    // 展开编辑器
    this.editingId = ann.id;
    editorContainer.empty();
    editorContainer.style.cssText = `
      display:block;
      padding:0 12px 10px;
      margin-left:26px;
    `;

    const textarea = editorContainer.createEl('textarea');
    textarea.value = ann.comment || '';
    textarea.placeholder = '写批注…';
    textarea.style.cssText = `
      width:100%;min-height:60px;max-height:200px;
      padding:8px 10px;
      border:1px solid var(--background-modifier-border);
      border-radius:5px;resize:vertical;
      font-size:13px;line-height:1.55;
      font-family:inherit;
      color:var(--text-normal);
      background:var(--background-primary);
      outline:none;box-sizing:border-box;
      transition:border-color 0.15s ease;
    `;
    textarea.addEventListener('focus', () => {
      textarea.style.borderColor = 'var(--interactive-accent)';
    });
    textarea.addEventListener('blur', () => {
      textarea.style.borderColor = 'var(--background-modifier-border)';
    });

    const btnRow = editorContainer.createDiv();
    btnRow.style.cssText = `
      display:flex;justify-content:flex-end;gap:6px;margin-top:6px;
    `;

    if (ann.comment) {
      // 已有批注：显示"清除"和"保存"
      const clearBtn = btnRow.createEl('button', { text: '清除' });
      clearBtn.style.cssText = `
        font-size:12px;padding:3px 10px;border-radius:4px;
        border:1px solid var(--background-modifier-border);
        background:transparent;color:var(--text-muted);
        cursor:pointer;font-family:inherit;
      `;
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
        editorContainer.style.display = 'none';
        editorContainer.empty();
        this.editingId = null;
        new Notice('已清除批注');
        await this.refresh();
      });
    }

    const saveBtn = btnRow.createEl('button', { text: '保存' });
    saveBtn.style.cssText = `
      font-size:12px;padding:3px 12px;border-radius:4px;
      border:none;background:var(--interactive-accent);
      color:var(--text-on-accent);
      cursor:pointer;font-weight:500;font-family:inherit;
    `;
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

      editorContainer.style.display = 'none';
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
        editorContainer.style.display = 'none';
        editorContainer.empty();
        this.editingId = null;
      }
    });

    setTimeout(() => textarea.focus(), 50);
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
    loadingWrap.style.cssText = `
      margin-top:8px;margin-left:26px;
      padding:8px 10px;
      border-left:2px solid var(--interactive-accent);
      background:var(--background-secondary);
      border-radius:0 4px 4px 0;
      display:flex;align-items:center;gap:8px;
    `;

    // 旋转动画
    const spinner = loadingWrap.createDiv();
    spinner.style.cssText = `
      width:14px;height:14px;
      border:2px solid var(--background-modifier-border);
      border-top-color:var(--interactive-accent);
      border-radius:50%;
      animation:spin 0.8s linear infinite;
    `;

    const loadingText = loadingWrap.createDiv({ text: 'AI 正在生成批注…' });
    loadingText.style.cssText = `
      font-size:12px;color:var(--text-muted);
    `;

    // 注入旋转动画（只注入一次）
    if (!document.getElementById('fleur-spin-style')) {
      const style = document.createElement('style');
      style.id = 'fleur-spin-style';
      style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
      document.head.appendChild(style);
    }

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
        loadingText.style.whiteSpace = 'pre-wrap';
        loadingText.style.lineHeight = '1.5';
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
      el.style.backgroundColor = '';
      el.style.borderRadius = '';
      el.style.textDecoration = '';
      el.style.textUnderlineOffset = '';
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
            el.style.backgroundColor = '';
            el.style.borderRadius = '';
            el.style.textDecoration = '';
            el.style.textUnderlineOffset = '';
          }
        });
      });
    }
  }
}
