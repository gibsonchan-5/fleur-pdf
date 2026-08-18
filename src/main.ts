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
    this.app.workspace.onLayoutReady(() => {
      void this.activateSidebar();
    });
  }

  onunload() {
    this.patcher?.uninstall();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getSidebar(): SidebarView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR)[0];
    return leaf ? (leaf.view as SidebarView) : null;
  }

  async activateSidebar() {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);

    // 去重：热重载可能残留旧叶子，只保留一个并关闭多余的
    if (existingLeaves.length > 1) {
      for (let i = 1; i < existingLeaves.length; i++) {
        existingLeaves[i].detach();
      }
    }

    let leaf = existingLeaves[0];

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
