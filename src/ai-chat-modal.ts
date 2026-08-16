/**
 * AI 对话浮动面板 — 打开即自动解释，支持多轮追问
 * 直接浮在 PDF 上方，可拖拽移动、可调整尺寸
 */
import { Notice, MarkdownRenderer } from 'obsidian';
import type FleurPDFPlugin from './main';
import { AIService } from './ai-service';

// SVG 图标常量
const ICON_SEND = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
const ICON_STOP = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;

export class AIChatPanel {
  private panelEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private followUpInput: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  private chatHistory: { role: string; content: string }[] = [];
  private rawMarkdown = '';
  private initialSent = false;
  /** 最后一轮 AI 回答的 DOM 引用（用于"重新生成"） */
  private lastResponseEl: HTMLElement | null = null;
  private lastActionsEl: HTMLElement | null = null;

  // ─── 流式中断 ───
  private abortController: AbortController | null = null;
  private isStreaming = false;

  // ─── 拖拽 & 缩放状态 ───
  private isDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private isResizing = false;

  constructor(
    private plugin: FleurPDFPlugin,
    private selectedText: string,
    private mode: 'explain' | 'translate' = 'explain'
  ) {}

  open() {
    if (this.panelEl) this.close();
    this.buildPanel();
    // DOM 渲染完成后自动发送
    requestAnimationFrame(() => this.sendInitial());
  }

  close() {
    // 如果有正在进行的流式请求，先中断
    this.abortStream();
    if (this.clickOutsideHandler) {
      document.removeEventListener('mousedown', this.clickOutsideHandler);
      this.clickOutsideHandler = null;
    }
    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
  }

  /** 中断当前流式请求 */
  private abortStream() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.isStreaming) {
      this.isStreaming = false;
      this.updateSendButton();
    }
  }

  // ─── 构建面板 ───

  private buildPanel() {
    this.panelEl = document.body.createDiv('fleur-ai-panel');
    this.panelEl.style.cssText = `
      position: fixed;
      top: 70px;
      right: 24px;
      width: 440px;
      height: 560px;
      background: var(--background-primary);
      border: 1px solid var(--background-modifier-border);
      border-radius: 10px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.14);
      z-index: 10000;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
      animation: fleurPanelIn 0.18s ease-out;
    `;

    // 注入动画 keyframes（只注入一次）
    if (!document.getElementById('fleur-panel-style')) {
      const style = document.createElement('style');
      style.id = 'fleur-panel-style';
      style.textContent = `
        @keyframes fleurPanelIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }

    // 点击外部关闭
    this.clickOutsideHandler = (e: MouseEvent) => {
      if (this.panelEl && !this.panelEl.contains(e.target as Node)) {
        this.close();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', this.clickOutsideHandler!), 50);

    // ─ 标题栏（拖拽手柄） ──
    const header = this.panelEl.createDiv();
    header.style.cssText = `
      padding: 13px 18px;
      border-bottom: 1px solid var(--background-modifier-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      background: var(--background-primary);
      cursor: grab;
      user-select: none;
    `;
    header.addEventListener('mousedown', (e) => this.onDragStart(e));

    const title = header.createSpan({ text: '阅读助手' });
    title.style.cssText = `
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: var(--text-normal);
    `;

    const closeBtn = header.createEl('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = `
      width: 26px; height: 26px;
      border: none; background: transparent;
      color: var(--text-muted); cursor: pointer;
      border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
      line-height: 1;
      transition: all 0.15s ease;
    `;
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = 'var(--background-modifier-hover)';
      closeBtn.style.color = 'var(--text-normal)';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = 'transparent';
      closeBtn.style.color = 'var(--text-muted)';
    });
    closeBtn.addEventListener('click', () => this.close());

    // ── 内容区（唯一滚动区） ──
    this.bodyEl = this.panelEl.createDiv();
    this.bodyEl.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 16px 18px 8px;
    `;

    // ── 底部输入区 ──
    const footer = this.panelEl.createDiv();
    footer.style.cssText = `
      padding: 10px 18px 14px;
      border-top: 1px solid var(--background-modifier-border);
      display: flex;
      gap: 8px;
      align-items: flex-end;
      flex-shrink: 0;
      background: var(--background-primary);
    `;

    this.followUpInput = footer.createEl('textarea');
    this.followUpInput.placeholder = '继续追问…';
    this.followUpInput.style.cssText = `
      flex: 1;
      min-height: 34px;
      max-height: 100px;
      padding: 7px 12px;
      border: 1px solid var(--background-modifier-border);
      border-radius: 6px;
      resize: none;
      font-size: 13px;
      line-height: 1.5;
      font-family: inherit;
      color: var(--text-normal);
      background: var(--background-primary);
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.15s ease;
    `;
    this.followUpInput.addEventListener('focus', () => {
      this.followUpInput!.style.borderColor = 'var(--interactive-accent)';
    });
    this.followUpInput.addEventListener('blur', () => {
      this.followUpInput!.style.borderColor = 'var(--background-modifier-border)';
    });
    this.followUpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendFollowUp();
      }
    });

    this.sendBtn = footer.createEl('button');
    this.sendBtn.innerHTML = ICON_SEND;
    this.sendBtn.style.cssText = `
      width: 36px; height: 36px;
      border: none;
      background: var(--background-secondary);
      color: var(--text-normal);
      cursor: pointer;
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    `;
    this.sendBtn.addEventListener('mouseenter', () => {
      this.sendBtn!.style.background = 'var(--background-modifier-hover)';
      this.sendBtn!.style.boxShadow = '0 2px 6px rgba(0,0,0,0.1)';
    });
    this.sendBtn.addEventListener('mouseleave', () => {
      this.sendBtn!.style.background = 'var(--background-secondary)';
      this.sendBtn!.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)';
    });
    this.sendBtn.addEventListener('click', () => this.onSendOrAbort());

    // ── 右下角尺寸调整手柄 ──
    const resizeHandle = this.panelEl.createDiv();
    resizeHandle.style.cssText = `
      position: absolute;
      right: 0; bottom: 0;
      width: 20px; height: 20px;
      cursor: nwse-resize;
      z-index: 10001;
    `;
    resizeHandle.addEventListener('mousedown', (e) => this.onResizeStart(e));
  }

  // ─── 拖拽移动 ───

  private onDragStart(e: MouseEvent) {
    // 点击关闭按钮时不触发拖拽
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;

    this.isDragging = true;
    const rect = this.panelEl!.getBoundingClientRect();
    this.dragOffsetX = e.clientX - rect.left;
    this.dragOffsetY = e.clientY - rect.top;

    this.panelEl!.style.right = 'auto';
    this.panelEl!.style.left = rect.left + 'px';
    this.panelEl!.style.top = rect.top + 'px';

    const onDragMove = (ev: MouseEvent) => {
      if (!this.isDragging) return;
      this.panelEl!.style.left = (ev.clientX - this.dragOffsetX) + 'px';
      this.panelEl!.style.top = (ev.clientY - this.dragOffsetY) + 'px';
    };
    const onDragEnd = () => {
      this.isDragging = false;
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
    };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  // ─── 尺寸调整 ───

  private onResizeStart(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.isResizing = true;

    const rect = this.panelEl!.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    const onResizeMove = (ev: MouseEvent) => {
      if (!this.isResizing) return;
      const newWidth = Math.max(320, startWidth + (ev.clientX - startX));
      const newHeight = Math.max(300, startHeight + (ev.clientY - startY));
      this.panelEl!.style.width = newWidth + 'px';
      this.panelEl!.style.height = newHeight + 'px';
    };
    const onResizeEnd = () => {
      this.isResizing = false;
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeEnd);
    };
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
  }

  // ─── 对话逻辑 ───

  private async sendInitial() {
    if (this.initialSent) return;
    this.initialSent = true;

    let systemPrompt: string;
    let userMessage: string;

    if (this.mode === 'translate') {
      // 翻译模式
      systemPrompt = '你是一位专业的翻译助手。请将用户提供的文本翻译成中文，保持原文的语义和风格。如果原文已经是中文，则翻译成英文。回答时只给出翻译结果，不需要额外解释。';
      userMessage = `请翻译以下内容：\n\n「${this.selectedText}」`;
    } else {
      // 解释模式（默认）
      systemPrompt = '你是一位专业的文献阅读助手。请根据用户选中的文本内容，给出准确、有条理、有深度的回答。回答时使用 Markdown 格式，标题用 ## 或 ###，重点加粗。';
      const question = '请解释这段内容的含义，包括关键词释义、背景要点和深层逻辑。';
      userMessage = `以下是我从文档中选中的内容：\n\n「${this.selectedText}」\n\n${question}`;
    }

    this.chatHistory = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    await this.doStream();
  }

  private async sendFollowUp() {
    const question = this.followUpInput?.value.trim();
    if (!question) return;

    this.followUpInput!.disabled = true;
    this.followUpInput!.value = '';

    // 用户问题气泡（右对齐，区分 AI 回答）
    const userBubble = this.bodyEl!.createDiv();
    userBubble.style.cssText = `
      margin: 14px 0 6px;
      padding: 8px 14px;
      background: var(--interactive-accent);
      color: var(--text-on-accent, #fff);
      border-radius: 12px 12px 4px 12px;
      font-size: 13px;
      line-height: 1.6;
      max-width: 65%;
      width: fit-content;
      margin-left: auto;
      word-break: break-word;
    `;
    userBubble.setText(question);

    this.chatHistory.push({ role: 'user', content: question });
    await this.doStream();

    this.followUpInput!.disabled = false;
    this.followUpInput!.focus();
  }

  /** 发送或中断按钮点击处理 */
  private onSendOrAbort() {
    if (this.isStreaming) {
      this.abortStream();
    } else {
      this.sendFollowUp();
    }
  }

  /** 更新发送按钮状态（发送/停止图标切换） */
  private updateSendButton() {
    if (!this.sendBtn) return;
    if (this.isStreaming) {
      this.sendBtn.innerHTML = ICON_STOP;
      this.sendBtn.style.background = 'var(--background-modifier-hover)';
    } else {
      this.sendBtn.innerHTML = ICON_SEND;
      this.sendBtn.style.background = 'var(--background-secondary)';
    }
  }

  /** 执行一次流式请求，在 body 中追加一轮对话 */
  private async doStream() {
    this.rawMarkdown = '';
    this.isStreaming = true;
    const controller = new AbortController();
    this.abortController = controller;
    this.updateSendButton();

    // 每轮对话的容器
    const turnContainer = this.bodyEl!.createDiv();
    turnContainer.style.cssText = 'margin-bottom: 4px;';

    // 加载提示
    const loading = turnContainer.createDiv();
    loading.style.cssText = `
      padding: 14px 0;
      font-size: 13px;
      color: var(--text-muted);
      font-style: italic;
    `;
    loading.setText('正在分析…');

    // AI 回答区
    const responseEl = turnContainer.createDiv();
    responseEl.style.cssText = `
      display: none;
      font-size: 14px;
      line-height: 1.75;
      color: var(--text-normal);
      word-break: break-word;
    `;

    // 操作按钮区
    const actionsEl = turnContainer.createDiv();
    actionsEl.style.cssText = `
      display: none;
      gap: 6px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--background-modifier-border);
    `;

    // 开始流式请求
    const aiService = new AIService(this.plugin);
    const messages = this.chatHistory.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content
    }));

    loading.style.display = 'none';
    responseEl.style.display = 'block';

    // 流式过程中 onChunk 回调
    const onChunk = (chunk: string) => {
      this.rawMarkdown += chunk;
      responseEl.innerHTML = this.renderStreamingMarkdown(this.rawMarkdown);
      this.scrollToBottom();
    };

    // 流式结束后统一处理
    const onStreamEnd = async (aborted: boolean, errorMsg?: string) => {
      this.isStreaming = false;
      this.abortController = null;
      this.updateSendButton();

      if (errorMsg && !aborted) {
        responseEl.setText(`请求出错：${errorMsg}`);
        responseEl.style.color = 'var(--text-error)';
      } else if (this.rawMarkdown) {
        // 有内容（正常完成或被中断），完整渲染
        this.chatHistory.push({ role: 'assistant', content: this.rawMarkdown });
        responseEl.empty();
        const sourceFile = this.plugin.app.workspace.getActiveFile();
        await MarkdownRenderer.renderMarkdown(
          this.rawMarkdown,
          responseEl,
          sourceFile?.path ?? '',
          this.plugin as any
        );
        this.lastResponseEl = responseEl;
        this.lastActionsEl = actionsEl;
        this.buildActions(actionsEl);
      } else if (!aborted) {
        responseEl.setText('未能获取回复，请检查 API 配置。');
        responseEl.style.color = 'var(--text-muted)';
      }

      this.scrollToBottom();
      this.followUpInput!.disabled = false;
      this.followUpInput!.focus();
    };

    await aiService.streamChat(
      messages,
      onChunk,
      () => onStreamEnd(false),           // 正常完成
      (error) => onStreamEnd(false, error), // 出错
      controller.signal
    );

    // 如果 streamChat 返回后信号已中止（中断时 onDone/onError 均不触发）
    if (controller.signal.aborted) {
      await onStreamEnd(true);
    }
  }

  private scrollToBottom() {
    if (this.bodyEl) {
      requestAnimationFrame(() => {
        this.bodyEl!.scrollTop = this.bodyEl!.scrollHeight;
      });
    }
  }

  // ─── 操作按钮 ──

  private buildActions(container: HTMLElement) {
    container.style.display = 'flex';

    // 复制
    const copyBtn = container.createEl('button');
    copyBtn.title = '复制回答';
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    copyBtn.style.cssText = `width:30px;height:30px;padding:0;border:none;background:transparent;color:var(--text-muted);cursor:pointer;border-radius:4px;display:flex;align-items:center;justify-content:center;transition:all 0.12s ease;`;
    this.addHover(copyBtn);
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.rawMarkdown)
        .then(() => new Notice('已复制'))
        .catch(() => new Notice('复制失败'));
    });

    // 重新生成
    const regenBtn = container.createEl('button');
    regenBtn.title = '重新生成';
    regenBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
    regenBtn.style.cssText = copyBtn.style.cssText;
    this.addHover(regenBtn);
    regenBtn.addEventListener('click', () => this.regenerate());

    // 保存笔记
    const saveBtn = container.createEl('button');
    saveBtn.title = '保存笔记';
    saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
    saveBtn.style.cssText = copyBtn.style.cssText;
    this.addHover(saveBtn);
    saveBtn.addEventListener('click', () => this.saveNote());
  }

  private addHover(el: HTMLElement, activeColor = 'var(--interactive-accent)') {
    el.addEventListener('mouseenter', () => {
      el.style.background = 'var(--background-modifier-hover)';
      el.style.color = activeColor;
    });
    el.addEventListener('mouseleave', () => {
      el.style.background = 'transparent';
      el.style.color = 'var(--text-muted)';
    });
  }

  /** 重新生成最后一轮 AI 回答 */
  private async regenerate() {
    if (!this.lastResponseEl || !this.lastActionsEl) return;

    this.rawMarkdown = '';
    this.lastResponseEl.empty();
    this.lastActionsEl.empty();
    this.lastActionsEl.style.display = 'none';

    // 移除对话历史中最后一条 assistant 消息
    const lastAssistantIndex = this.chatHistory.map(m => m.role).lastIndexOf('assistant');
    if (lastAssistantIndex !== -1) {
      this.chatHistory.splice(lastAssistantIndex, 1);
    }

    const responseEl = this.lastResponseEl;
    const actionsEl = this.lastActionsEl;

    responseEl.style.display = 'block';
    const aiService = new AIService(this.plugin);
    const messages = this.chatHistory.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content
    }));

    await aiService.streamChat(
      messages,
      (chunk) => {
        this.rawMarkdown += chunk;
        responseEl.innerHTML = this.renderStreamingMarkdown(this.rawMarkdown);
        this.scrollToBottom();
      },
      async () => {
        if (this.rawMarkdown === '') {
          responseEl.setText('未能获取回复，请检查 API 配置。');
          responseEl.style.color = 'var(--text-muted)';
        } else {
          this.chatHistory.push({ role: 'assistant', content: this.rawMarkdown });
          responseEl.empty();
          const sourceFile = this.plugin.app.workspace.getActiveFile();
          await MarkdownRenderer.renderMarkdown(
            this.rawMarkdown,
            responseEl,
            sourceFile?.path ?? '',
            this.plugin as any
          );
          this.buildActions(actionsEl);
        }
        this.scrollToBottom();
      },
      (error) => {
        responseEl.setText(`请求出错：${error}`);
        responseEl.style.color = 'var(--text-error)';
      }
    );
  }

  // ─── 流式 Markdown 实时渲染 ───

  /** 轻量级 Markdown → HTML 转换器（流式过程中使用） */
  private renderStreamingMarkdown(md: string): string {
    // 转义 HTML
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 行内格式
    const inline = (s: string): string => {
      let out = esc(s);
      // 加粗 **text**
      out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // 斜体 *text*
      out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
      // 行内代码 `code`
      out = out.replace(/`([^`]+)`/g, '<code style="background:var(--background-secondary);padding:1px 5px;border-radius:3px;font-size:0.9em;">$1</code>');
      return out;
    };

    const lines = md.split('\n');
    const html: string[] = [];
    let inList = false;
    let inBlockquote = false;
    let paragraphLines: string[] = [];

    const flushParagraph = () => {
      if (paragraphLines.length > 0) {
        html.push(`<p style="margin:0.4em 0;">${inline(paragraphLines.join(' '))}</p>`);
        paragraphLines = [];
      }
    };
    const flushList = () => {
      if (inList) { html.push('</ul>'); inList = false; }
    };
    const flushBlockquote = () => {
      if (inBlockquote) { html.push('</blockquote>'); inBlockquote = false; }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // 空行 → 段落结束
      if (trimmed === '') {
        flushParagraph();
        continue;
      }

      // 标题 ## / ###
      const headingMatch = trimmed.match(/^(#{2,4})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        flushBlockquote();
        const level = headingMatch[1].length;
        const margin = level <= 2 ? '1em 0 0.4em' : '0.8em 0 0.3em';
        const size = level <= 2 ? '1.15em' : '1em';
        html.push(`<h${level} style="margin:${margin};font-size:${size};font-weight:600;line-height:1.4;">${inline(headingMatch[2])}</h${level}>`);
        continue;
      }

      // 引用块 >
      if (trimmed.startsWith('> ')) {
        flushParagraph();
        flushList();
        if (!inBlockquote) {
          html.push('<blockquote style="margin:0.5em 0;padding:4px 12px;border-left:3px solid var(--background-modifier-border);color:var(--text-muted);font-size:0.95em;">');
          inBlockquote = true;
        }
        html.push(`<p style="margin:0.2em 0;">${inline(trimmed.slice(2))}</p>`);
        continue;
      } else if (inBlockquote) {
        flushBlockquote();
      }

      // 列表项 - / * / 数字列表
      const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
      const numListMatch = trimmed.match(/^\d+[.、]\s*(.+)$/);
      if (listMatch || numListMatch) {
        flushParagraph();
        flushBlockquote();
        if (!inList) { html.push('<ul style="margin:0.4em 0;padding-left:1.4em;">'); inList = true; }
        const content = (listMatch ? listMatch[1] : numListMatch![1]);
        html.push(`<li style="margin:0.15em 0;line-height:1.6;">${inline(content)}</li>`);
        continue;
      } else if (inList) {
        flushList();
      }

      // 普通段落文本
      paragraphLines.push(trimmed);
    }

    flushParagraph();
    flushList();
    flushBlockquote();

    return html.join('\n');
  }

  // ─── 保存笔记 ───

  private async saveNote() {
    if (!this.rawMarkdown) return;
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) { new Notice('请先打开 PDF 文件'); return; }

    // 默认放 FleurReader 文件夹
    const folder = 'FleurReader';
    if (!this.plugin.app.vault.getAbstractFileByPath(folder)) {
      await this.plugin.app.vault.createFolder(folder);
    }

    // 每次保存生成唯一文件名（带时间戳），允许多次保存
    const time = new Date().toLocaleString('zh-CN').replace(/[\/:\s]/g, '-').replace(/,/g, '');
    const noteName = `${file.basename} AI笔记 ${time}`;
    const notePath = `${folder}/${noteName}.md`;

    const noteContent = `> 导出时间：${new Date().toLocaleString('zh-CN')}

**选中文本**：
> ${this.selectedText}

**AI 回答**：

${this.rawMarkdown}
`;

    await this.plugin.app.vault.create(notePath, noteContent);
    new Notice('已保存笔记');
  }
}
