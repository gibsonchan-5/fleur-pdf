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
import { OcrEngine } from './mobile/ocr';
import { InkSync } from './mobile/ink-sync';
import { InkUI } from './mobile/ink-ui';
import { InkDebugRecorder } from './mobile/ink-debug';
import { installInkStyles, removeInkStyles } from './mobile/ink-styles';
import { getFleurDictBridge, queryMeaning, type FleurDictBridge } from './dict-bridge';
import { WordbookSync, type WordbookTombstone } from './wordbook-sync';

export default class FleurPDFPlugin extends Plugin {
  store: AnnotationStore;
  patcher: PDFPatcher;
  search: PdfSearchService;
  settings: FleurSettings = DEFAULT_SETTINGS;
  /** 本机 Obsidian 是否支持官方 SecretStorage（系统钥匙串）。 */
  secretStorageAvailable = false;

  /** 独立生词本跨设备同步（wordbookSync 开关，默认关；详见 wordbook-sync.ts） */
  wordbookSync = new WordbookSync(this.app, this);

  /** 手写笔迹跨设备同步（inkCrossDeviceSync 开关，默认关；详见 mobile/ink-sync.ts） */
  inkSync = new InkSync(this.app, () => this.settings.inkCrossDeviceSync === true);

  /** 移动端手写批注：内置墨迹引擎的接入层。桌面端也会构造，但不会激活。 */
  inkEngine: InkEngine;
  /** 手写批注的 UI。仅 isMobileUI() 为真时创建（真机移动端，或桌面开启「桌面端手写批注」）。 */
  inkUI: InkUI | null = null;
  /** 手写断触真机诊断记录器（命令开关，桌面默认零影响） */
  inkDebug: InkDebugRecorder | null = null;

  /** 本地 OCR（tesseract.js 懒加载）：截图取字的离线通道。 */
  ocr = new OcrEngine(this);

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

  // ── 独立生词本（dictSyncWordbook = false 时使用；存 settings.wordbook → data.json）──
  // 移植自 fleur-epub 同名方法；事件名改为 fleur-pdf:wordbook-changed。

  /**
   * 加入独立生词本：去重（同词忽略）、填充释义（复用 FleurDict 词典引擎，可失败）、
   * 落盘并 Notice。不触碰 FleurDict 的词库数据。
   */
  async addLocalWordbookEntry(word: string, context: string | undefined, bridge: FleurDictBridge | null, prefetched?: { meaning: string; phonetic: string }): Promise<void> {
    const norm = word.trim().toLowerCase();
    if (!norm) return;
    if (this.settings.wordbook.some((w) => w.word === norm)) {
      new Notice(`"${norm}" 已在独立生词本中`, 2000);
      return;
    }
    // 释义来源优先级：弹窗已查到的预取释义 > FleurDict 引擎查询 > 空串
    const { meaning, phonetic } = prefetched ?? (bridge ? await queryMeaning(bridge, norm) : { meaning: '', phonetic: '' });
    this.settings.wordbook.push({
      word: norm,
      meaning,
      phonetic,
      context: context?.trim() || undefined,
      addedAt: new Date().toISOString(),
    });
    await this.saveSettings();
    new Notice(`✓ "${norm}" 已加入 fleur-pdf 独立生词本`, 2500);
    await this.wordbookSync.push();
    this.app.workspace.trigger('fleur-pdf:wordbook-changed');
  }

  /** 删除独立生词本词条（生词本管理 Modal 用；广播事件） */
  async removeWordbookEntry(word: string): Promise<void> {
    const removed = this.settings.wordbook.find((w) => w.word === word);
    const before = this.settings.wordbook.length;
    this.settings.wordbook = this.settings.wordbook.filter((w) => w.word !== word);
    if (this.settings.wordbook.length === before) return;
    await this.saveSettings();
    new Notice(`已删除 "${word}"`, 2000);
    // 删除留墓碑：否则另一端合并时该词会被「复活」
    await this.wordbookSync.push(removed ? [{ word: removed.word, deletedAt: removed.addedAt }] : []);
    this.app.workspace.trigger('fleur-pdf:wordbook-changed');
  }

  /** 编辑独立生词本词条（按原词定位；word 字段允许改名） */
  async updateWordbookEntry(originalWord: string, patch: { word: string; phonetic: string; meaning: string }): Promise<void> {
    const entry = this.settings.wordbook.find((w) => w.word === originalWord);
    if (!entry) return;
    const renamed = patch.word !== originalWord;
    entry.word = patch.word;
    entry.phonetic = patch.phonetic;
    entry.meaning = patch.meaning;
    await this.saveSettings();
    // 改名 = 旧词留墓碑（否则另一端合并时新旧两词并存）；仅改释义不留
    await this.wordbookSync.push(renamed ? [{ word: originalWord, deletedAt: entry.addedAt }] : []);
    this.app.workspace.trigger('fleur-pdf:wordbook-changed');
  }

  /** 清空独立生词本（生词本管理 Modal 二次确认后调用） */
  async clearWordbook(): Promise<void> {
    // 全部词条留墓碑：否则另一端同步会把清空「复活」回来
    const deletions: WordbookTombstone[] = this.settings.wordbook.map((w) => ({ word: w.word, deletedAt: w.addedAt }));
    this.settings.wordbook = [];
    await this.saveSettings();
    await this.wordbookSync.push(deletions);
    new Notice('独立生词本已清空', 2500);
    this.app.workspace.trigger('fleur-pdf:wordbook-changed');
  }

  async onload() {
    await this.loadSettings();

    // 独立生词本跨设备同步（开关关闭时内部全部跳过，桌面/移动零影响）
    this.wordbookSync.init();

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

    // 手写批注相关命令只在移动端 UI 生效时（真机，或桌面开启手写批注）注册 ——
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

      // 手写断触真机诊断：记录断触前后完整的指针/触摸/焦点事件流到
      // FleurPDF/ink-debug.json（非隐藏文件，可随 vault 同步到电脑端分析）。
      this.addCommand({
        id: 'ink-debug-record',
        name: '手写断触诊断：开始 / 停止事件记录',
        callback: () => {
          if (!this.inkDebug) this.inkDebug = new InkDebugRecorder(this);
          if (this.inkDebug.recording) {
            void this.inkDebug.stop().then(({ count, path }) => {
              new Notice(`诊断已停止：共 ${count} 条事件，已写入 ${path}`, 6000);
            });
          } else {
            this.inkDebug.start();
            new Notice('诊断已开始：请正常书写并复现断触，完成后再次运行本命令停止', 8000);
          }
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
    void this.inkDebug?.stop('插件卸载');
    this.inkDebug = null;
    void this.ocr.terminate();
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
    // 迁移：旧的调试开关 mobileDebug（「在桌面端预览移动端形态」）已转正为
    // 正式功能开关 desktopInk（「桌面端手写批注」）。曾开启预览的用户无感升级。
    const legacyMobileDebug = (this.settings as unknown as Record<string, unknown>).mobileDebug;
    if (legacyMobileDebug === true && this.settings.desktopInk !== true) {
      this.settings.desktopInk = true;
    }
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
