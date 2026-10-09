// 便签的工具栏入口：「+ 贴便签」与「导出便签笔记」两个按钮。
//
// 按钮只有一个 DOM 容器，按环境**换爹**（同一节点 move 不丢监听）：
//   ① 移动端 UI（真机或桌面开启手写批注）→ 挂进右下角悬浮胶囊尾部，
//      胶囊的显隐/收起/拖动全部自动生效，不另造一个浮窗；
//   ② 桌面默认形态 → 插进 PDF 视图自带工具栏（用户截图指认的位置）。
//      工具栏 DOM 是 Obsidian 内部结构，不做单点猜测：以「含缩放按钮的那一行」
//      为判据反查父容器，跨版本稳；
//   ③ 反查不到（视图结构变了 / 工具栏未渲染）→ 退化为窗格内右下角独立小胶囊
//      （钉在当前焦点的 PDF 窗格里，不挂 body —— 焦点不在 PDF 就整体隐藏）。

import { setIcon } from 'obsidian';
import type FleurPDFPlugin from '../main';
import type { NoteLayer } from './note-layer';
import { exportNotesToMd } from './note-export';

export class NoteUI {
  private el: HTMLElement;
  private syncTimer: number | null = null;

  constructor(private plugin: FleurPDFPlugin, private layer: NoteLayer) {
    this.el = document.body.createDiv({ cls: 'fleur-pdf-note-tools is-hidden' });

    const addBtn = this.el.createDiv({ cls: 'fleur-pdf-note-tool-btn fleur-pdf-ink-switch-btn' });
    setIcon(addBtn, 'sticky-note');
    addBtn.setAttribute('aria-label', '贴便签');
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.layer.addNote();
    });

    const exportBtn = this.el.createDiv({ cls: 'fleur-pdf-note-tool-btn fleur-pdf-ink-switch-btn' });
    setIcon(exportBtn, 'file-output');
    exportBtn.setAttribute('aria-label', '导出全部便签为笔记（再次导出会覆盖上次）');
    exportBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void exportNotesToMd(this.plugin, this.layer);
    });

    const ws = this.plugin.app.workspace;
    const on = (): void => this.scheduleSyncPlacement();
    plugin.registerEvent(ws.on('active-leaf-change', on));
    plugin.registerEvent(ws.on('file-open', on));
    plugin.registerEvent(ws.on('layout-change', on));
    this.syncPlacement();
  }

  hide(): void {
    this.el.addClass('is-hidden');
  }

  /** 去抖 + 尾部补试：PDF 视图/工具栏是异步渲染的，一次没找到过一会儿再看。 */
  scheduleSyncPlacement(): void {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncPlacement();
      window.setTimeout(() => this.syncPlacement(), 400);
      window.setTimeout(() => this.syncPlacement(), 1200);
    }, 120);
  }

  syncPlacement(): void {
    if (!this.plugin.settings.notesEnabled) {
      this.hide();
      return;
    }
    let host: HTMLElement | null = null;
    let mode: 'capsule' | 'toolbar' | 'fab' = 'fab';

    const capsule = document.body.querySelector('.fleur-pdf-ink-toggle');
    if (document.body.classList.contains('fleur-pdf-mobile') && capsule) {
      // ① 胶囊内：随胶囊一起显隐（含 is-hidden / is-collapsed 态）
      host = capsule as HTMLElement;
      mode = 'capsule';
    } else {
      // ② 桌面 PDF 工具栏
      const toolbar = this.findToolbarHost();
      if (toolbar) {
        host = toolbar;
        mode = 'toolbar';
      } else {
        // ③ 兜底 FAB：也钉进当前焦点的 PDF 窗格（不再挂 body —— 悬浮层不进非 PDF 区域）
        host = this.activePdfLeafHost();
        mode = 'fab';
      }
    }

    if (!host) {
      this.hide();
      return;
    }
    if (this.el.parentElement !== host) {
      if (mode === 'capsule') {
        // 折叠钮要保持在最末端：便签两段插到它前面
        const anchor = host.querySelector('.fleur-pdf-ink-collapse');
        if (anchor) host.insertBefore(this.el, anchor);
        else host.appendChild(this.el);
      } else {
        host.appendChild(this.el);
      }
    }
    this.el.toggleClass('is-fab', mode === 'fab');
    this.el.removeClass('is-hidden');
  }

  /** 当前焦点 PDF 叶子的 .workspace-leaf 容器；焦点不在 PDF 上返回 null（与 ink-ui 同判据）。 */
  private activePdfLeafHost(): HTMLElement | null {
    try {
      const leaf = this.plugin.app.workspace.activeLeaf;
      if (!leaf) return null;
      if ((leaf.view as any)?.getViewType?.() !== 'pdf') return null;
      return ((leaf as any).containerEl as HTMLElement | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 反查 PDF 视图工具栏宿主：找「缩放按钮所在的行」。
   * 判据用 aria-label/title 里的 zoom 语义（中英 UI 都认），不依赖具体类名；
   * 再兜一层已知候选类。找不到返回 null（调用方退化 FAB）。
   */
  private findToolbarHost(): HTMLElement | null {
    const leaves = this.plugin.app.workspace.getLeavesOfType('pdf');
    for (const leaf of leaves) {
      // 只认主工作区里可见的 PDF 叶子（getRoot 运行时返回 'rootSplit' 字符串，
      // d.ts 标的是 WorkspaceItem —— 与 ink-engine.findPdfView 同款 any 处理）
      let root: unknown = null;
      try {
        root = (leaf as any).getRoot?.();
      } catch {
        /* 老版本没有 getRoot 就放行 */
      }
      if (typeof root === 'string' && root !== 'rootSplit') continue;
      const content = (leaf.view as any)?.contentEl as HTMLElement | undefined;
      if (!content) continue;
      const btns = Array.from(content.querySelectorAll<HTMLElement>('button, .clickable-icon'));
      const zoom = btns.find((b) =>
        /zoom|缩小|放大/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title ?? ''}`),
      );
      const row = zoom?.parentElement;
      if (row && row !== content && row.querySelectorAll('button, .clickable-icon').length >= 2) return row;
      const known = content.querySelector<HTMLElement>('.pdf-toolbar, .toolbar.toolbarHorizontal, .view-actions');
      if (known) return known;
    }
    return null;
  }
}
