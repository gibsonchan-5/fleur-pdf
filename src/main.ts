// 主入口
import { Plugin } from 'obsidian';
import { SidebarView, VIEW_TYPE_SIDEBAR } from './sidebar';
import { PDFPatcher } from './patcher';
import { AnnotationStore } from './store';
import { FleurSettings, DEFAULT_SETTINGS, FleurSettingTab } from './settings';

export default class FleurPDFPlugin extends Plugin {
  store: AnnotationStore;
  patcher: PDFPatcher;
  settings: FleurSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.store = new AnnotationStore(this.app, this.manifest.id);
    this.patcher = new PDFPatcher(this);
    this.patcher.install();

    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      return new SidebarView(leaf, this);
    });

    this.addRibbonIcon('file-text', 'FleurPDF', () => {
      void this.activateSidebar();
    });

    this.addCommand({
      id: 'open-sidebar',
      name: '打开批注侧边栏',
      callback: () => { void this.activateSidebar(); }
    });

    this.addCommand({
      id: 'restore-annotations',
      name: '重新渲染当前 PDF 的标注',
      callback: () => { this.patcher.restoreNow(); }
    });

    this.addCommand({
      id: 'diagnose-pdf',
      name: '诊断当前 PDF 结构',
      callback: () => { this.patcher.diagnose(); }
    });

    this.addSettingTab(new FleurSettingTab(this.app, this));

    // 监听文件切换，刷新侧边栏
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file?.extension === 'pdf') {
          void this.getSidebar()?.refresh();
        }
      })
    );

    // 默认打开侧边栏
    // 问题根因：onLayoutReady 后 Obsidian 可能还在异步恢复工作区状态，
    // 如果此时就创建新叶子，之后状态恢复又会恢复旧叶子 → 两个
    // 解决方案：不主动创建叶子，只清理重复的叶子
    // 用户可通过 ribbon 图标 / 命令 / 打开 PDF 时自动出现
    let cleanupTimer: number | null = null;

    const deduplicate = () => {
      if (cleanupTimer) window.clearTimeout(cleanupTimer);
      cleanupTimer = window.setTimeout(() => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
        if (leaves.length > 1) {
          for (let i = 1; i < leaves.length; i++) {
            leaves[i].detach();
          }
        }
      }, 1500);
    };

    // 监听 layout-change（工作区状态恢复完成后会触发，此时去重）
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        deduplicate();
      })
    );

    // 打开 PDF 时激活侧边栏
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file?.extension === 'pdf') {
          void this.activateSidebar();
        }
      })
    );

    // 延迟去重兜底（确保状态恢复完成后的叶子不重复）
    this.app.workspace.onLayoutReady(() => {
      deduplicate();
    });
  }

  onunload() {
    this.patcher?.uninstall();
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // 迁移：早期版本只有单一的「自定义 Prompt」文本框。已填写过内容的用户
    // 升级后自动落到「自定义」模式，避免他们写好的提示词被预设静默覆盖。
    if (
      saved && !('promptPreset' in saved) &&
      typeof saved.customPrompt === 'string' && saved.customPrompt.trim()
    ) {
      this.settings.promptPreset = 'custom';
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getSidebar(): SidebarView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR)[0];
    const view = leaf?.view;
    // instanceof 守卫：叶子在 view 切换/卸载间隙时 leaf.view 可能是其它对象，
    // 直接强转会导致 file-open 等事件里 .refresh() 抛 "refresh is not a function"
    return view instanceof SidebarView ? view : null;
  }

  async activateSidebar() {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);

    // 优先使用已存在的叶子（可能是状态恢复的），只保留第一个，关闭多余的
    if (existingLeaves.length > 1) {
      for (let i = 1; i < existingLeaves.length; i++) {
        existingLeaves[i].detach();
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }

    let leaf = existingLeaves[0];

    // 如果没有叶子（首次使用），才创建新的
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: true });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}
