// 主入口
import { Notice, Plugin } from 'obsidian';
import { SidebarView, VIEW_TYPE_SIDEBAR } from './sidebar';
import { PDFPatcher } from './patcher';
import { AnnotationStore } from './store';
import { PdfSearchService } from './search';
import { FleurSettings, DEFAULT_SETTINGS, FleurSettingTab } from './settings';
import {
  hydrateSecrets,
  scrubSecretsForPersistence,
  secretStorageAvailable,
  migrateSecrets,
  resolveBackend,
  type SecretBackend,
} from './secret-store';
import { applyMobileBodyClass, isMobileUI } from './platform';
import { InkEngine } from './mobile/ink-engine';
import { InkUI } from './mobile/ink-ui';
import { installInkStyles, removeInkStyles } from './mobile/ink-styles';

export default class FleurPDFPlugin extends Plugin {
  store: AnnotationStore;
  patcher: PDFPatcher;
  search: PdfSearchService;
  settings: FleurSettings = DEFAULT_SETTINGS;
  /** 本机 Obsidian 是否支持官方 SecretStorage（系统钥匙串）。 */
  secretStorageAvailable = false;

  /** 移动端手写批注：内置墨迹引擎的接入层。桌面端也会构造，但不会激活。 */
  inkEngine: InkEngine;
  /** 移动端手写批注的 UI。仅 isMobileUI() 为真时创建，桌面端恒为 null。 */
  inkUI: InkUI | null = null;

  /**
   * 左侧栏图标元素。
   *
   * `addRibbonIcon` 返回的就是那颗 .side-dock-ribbon-action，持有它才能在设置里
   * 把图标藏起来 —— 真机反馈「批注按钮全局都显示很碍眼」，而 ribbon 是桌面端
   * 与移动端共用的同一个入口，两边都要能关。
   */
  private ribbonEl: HTMLElement | null = null;

  /** 当前实际生效的密钥后端（system=钥匙串，vault=data.json 明文）。 */
  get secretBackend(): SecretBackend {
    return resolveBackend(this.app, this.settings.secretStorageMode);
  }

  async onload() {
    await this.loadSettings();

    this.store = new AnnotationStore(this.app, this.manifest.id);
    this.patcher = new PDFPatcher(this);
    this.patcher.install();
    this.search = new PdfSearchService(this.app);

    // 这里必须真正 new 一次，不能只把 InkEngine 当类型用。
    // 若它只出现在类型位置（`inkEngine: InkEngine`），TS 类型擦除后就没有任何值引用，
    // 打包器（esbuild treeShaking）会把整个 mobile/ink-engine 模块摇掉 ——
    // 产物里没有引擎，移动端 this.inkEngine 恒为 undefined，
    // 而故障是静默的：笔盒按钮照常显示，点下去毫无反应，控制台也不报错。
    this.inkEngine = new InkEngine(this.app);

    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      return new SidebarView(leaf, this);
    });

    this.ribbonEl = this.addRibbonIcon('file-text', 'FleurPDF', () => {
      void this.activateSidebar();
    });
    this.applyRibbonVisibility();

    this.addCommand({
      id: 'open-sidebar',
      name: '打开批注侧边栏',
      callback: () => { void this.activateSidebar(); }
    });

    // 移动端 UI 相关命令只在移动端（或桌面开启预览形态）注册 ——
    // 桌面默认状态下命令面板与 1.5.15 完全一致（桌面零影响）。
    if (isMobileUI(this)) {
      // 悬浮胶囊被收起 / 被隐藏后，必须留一条「用命令就能找回来」的路：
      // 否则用户一旦关掉，就只能翻设置页。
      this.addCommand({
        id: 'toggle-ink-switcher',
        name: '显示 / 隐藏手写批注悬浮按钮',
        callback: () => {
          if (!this.inkUI) {
            new Notice('当前未启用移动端批注界面');
            return;
          }
          this.inkUI.toggleSwitcher();
        }
      });

      // ribbon 图标藏起来之后的找回路径（设置页之外的第二条）。
      this.addCommand({
        id: 'toggle-ribbon-icon',
        name: '显示 / 隐藏左侧栏图标',
        callback: () => {
          this.settings.hideRibbonIcon = this.settings.hideRibbonIcon !== true;
          void this.saveSettings();
          this.applyRibbonVisibility();
          new Notice(this.settings.hideRibbonIcon ? '已隐藏左侧栏图标' : '已显示左侧栏图标');
        }
      });
    }

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

    this.addCommand({
      id: 'clear-search-flash',
      name: '清除检索定位高亮',
      callback: () => { this.patcher.clearSearchFlash(); }
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

    // 首次加载就同步一次移动端状态。
    // 桌面端走 else 分支：body class 不添加、<style> 不存在 —— 零影响；
    // 真机移动端则在插件加载完就把手写入口挂上，不必等用户进设置里拨开关。
    this.applyMobileMode();
  }

  onunload() {
    this.patcher?.uninstall();
    this.inkUI?.unmount();
    this.inkUI = null;
    this.inkEngine?.dispose();
    removeInkStyles();
  }

  /**
   * 同步左侧栏图标的显隐（设置项 / 命令 / 视图重建后都要调一次）。
   *
   * 用 class 而不是 detach()：`addRibbonIcon` 的自动清理只在插件卸载时生效，
   * 手动 detach 后如果用户又打开开关，就得自己重新 add 一次并重挂 click，
   * 徒增一条易错分支。加类只影响绘制，元素本身始终在册。
   */
  applyRibbonVisibility(): void {
    this.ribbonEl?.toggleClass('fleur-pdf-ribbon-hidden', this.settings.hideRibbonIcon === true);
  }

  /**
   * 同步「移动端 UI 是否生效」这一全局状态。
   *
   * 由 onload 与设置里的调试开关共同调用，是桌面零影响的唯一开关点：
   * 关闭时不仅不创建 UI，连 <style> 元素也会从文档里移除 —— 桌面端既不加载
   * 移动端样式，也不执行任何移动端事件逻辑。
   */
  applyMobileMode(): void {
    applyMobileBodyClass(this);
    if (isMobileUI(this)) {
      installInkStyles();
      if (!this.inkUI) {
        this.inkUI = new InkUI(this, this.inkEngine);
        this.inkUI.mount();
      }
    } else {
      this.inkUI?.unmount();
      this.inkUI = null;
      removeInkStyles();
    }
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // 迁移：早期版本只有单一的「自定义 Prompt」文本框（customPrompt: string），
    // 现已改为三个自定义槽（customPrompts: string[]，对应 custom-1/2/3）。
    // 把旧文本落进 1 号槽，并沿用旧版行为——写过自定义提示词的用户自动切到「自定义 1」，
    // 避免他们写好的内容被预设静默覆盖。
    const legacyCustomPrompt = (this.settings as unknown as Record<string, unknown>).customPrompt;
    const hasLegacyKey = typeof legacyCustomPrompt === 'string';
    if (hasLegacyKey && legacyCustomPrompt.trim()) {
      if (!Array.isArray(this.settings.customPrompts)) {
        this.settings.customPrompts = ['', '', ''];
      }
      if (!(this.settings.customPrompts[0] ?? '').trim()) {
        this.settings.customPrompts[0] = legacyCustomPrompt;
      }
      if (!saved || !('promptPreset' in saved)) {
        this.settings.promptPreset = 'custom-1';
      }
    }
    // 旧键（无论有没有内容）都不再需要，留着只会在 data.json 里堆积死字段
    if (hasLegacyKey) {
      delete (this.settings as unknown as Record<string, unknown>).customPrompt;
    }
    // 防止共享 DEFAULT_SETTINGS 的数组引用，并补齐长度
    const customArr: string[] = Array.isArray(this.settings.customPrompts)
      ? this.settings.customPrompts
      : ['', '', ''];
    this.settings.customPrompts = [customArr[0] ?? '', customArr[1] ?? '', customArr[2] ?? ''];
    // 兼容更旧的 'custom' 模式键 → custom-1
    if ((this.settings.promptPreset as string) === 'custom') {
      this.settings.promptPreset = 'custom-1';
    }

    // API Key 存入系统钥匙串；磁盘上若还留有明文，在这里迁走并清掉。
    // 用户切到 data.json 模式时则反其道行之：文件即真相，不写钥匙串。
    this.secretStorageAvailable = secretStorageAvailable(this.app);
    const secrets = await hydrateSecrets(
      this.app,
      this.settings as unknown as Record<string, unknown>,
      saved as Record<string, unknown> | null,
      this.secretBackend,
    );
    if (secrets.migrated.length > 0) {
      await this.saveData(
        await scrubSecretsForPersistence(
          this.app,
          this.settings as unknown as Record<string, unknown>,
          this.secretBackend,
        ),
      );
      new Notice('FleurPDF：API Key 已移入系统钥匙串，data.json 中不再保存明文');
    }
  }

  async saveSettings() {
    // 密钥只写系统钥匙串；写盘时从副本里抹掉（钥匙串不可用时保留明文，避免丢密钥）。
    // data.json 模式下原样落盘——明文正是用户的选择。
    await this.saveData(
      await scrubSecretsForPersistence(
        this.app,
        this.settings as unknown as Record<string, unknown>,
        this.secretBackend,
      ),
    );
  }

  /**
   * 切换密钥保存位置并搬迁现有密钥。
   *
   * 搬入钥匙串逐字段校验；任何一步写不进去就回滚到原模式，
   * 宁可维持明文也不丢密钥。
   */
  async setSecretStorageMode(
    mode: 'system' | 'vault',
  ): Promise<{ ok: boolean; failed: string[] }> {
    const previous = this.settings.secretStorageMode;
    const target = resolveBackend(this.app, mode);

    this.settings.secretStorageMode = mode;
    const result = await migrateSecrets(
      this.app,
      this.settings as unknown as Record<string, unknown>,
      target,
    );

    if (!result.ok) {
      this.settings.secretStorageMode = previous;
      await this.saveSettings();
      return { ok: false, failed: [...result.failed] };
    }

    await this.saveSettings();
    return { ok: true, failed: [] };
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
