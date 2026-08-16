// 主入口
import { Plugin, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { SidebarView, VIEW_TYPE_SIDEBAR } from './sidebar';
import { PDFPatcher } from './patcher';
import { AnnotationStore } from './store';
import { FleurSettings, DEFAULT_SETTINGS, FleurSettingTab } from './settings';

export default class FleurPDFPlugin extends Plugin {
  store: AnnotationStore;
  patcher: PDFPatcher;
  sidebar: SidebarView | null = null;
  settings: FleurSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.store = new AnnotationStore(this.app, this.manifest.id);
    this.patcher = new PDFPatcher(this);
    this.patcher.install();

    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      this.sidebar = new SidebarView(leaf, this);
      return this.sidebar;
    });

    this.addRibbonIcon('file-text', 'FleurPDF', () => {
      this.activateSidebar();
    });

    this.addCommand({
      id: 'open-sidebar',
      name: '打开批注侧边栏',
      callback: () => this.activateSidebar()
    });

    this.addSettingTab(new FleurSettingTab(this.app, this));

  // 监听文件切换，刷新侧边栏
  this.registerEvent(
    this.app.workspace.on('file-open', (file) => {
      if (file?.extension === 'pdf') {
        this.sidebar?.refresh();
      }
    })
  );

    // 默认打开侧边栏
    this.app.workspace.onLayoutReady(() => {
      this.activateSidebar();
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

  async activateSidebar() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: true });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}
