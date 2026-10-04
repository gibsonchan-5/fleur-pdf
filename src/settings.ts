import { App, PluginSettingTab, Setting, DropdownComponent, Notice, requestUrl } from 'obsidian';
import type FleurPDFPlugin from './main';
import { PROMPT_PRESETS, getPromptPreset, getPresetPreview, isCustomPresetKey, ANNOTATION_DEFAULT_BASE_LIMIT } from './ai-prompts';
import type { PromptPresetKey } from './ai-prompts';
import { resolveChatEndpoint } from './ai-transport';
import { getFleurDictBridge } from './dict-bridge';
import { WordbookManagerModal } from './wordbook-manager-modal';
import { isMobileUI } from './platform';

/** 独立生词本词条（dictSyncWordbook = false 时写入 settings.wordbook；与 fleur-epub 同构） */
export interface WordbookItem {
  word: string;
  /** 查询得到的释义（可能为空：查询失败/离线时也允许落词） */
  meaning: string;
  phonetic: string;
  /** 查词时的原文上下文（选段） */
  context?: string;
  /** 落词时间（ISO） */
  addedAt: string;
}

export interface FleurSettings {
  // AI 配置
  aiProvider: string;
  apiKey: string;
  /** 密钥保存位置：system=系统钥匙串（默认），vault=data.json 明文随 vault 同步。 */
  secretStorageMode: 'system' | 'vault';
  baseUrl: string;
  model: string;
  temperature: number; // AI 温度参数
  promptPreset: PromptPresetKey; // AI 提示词预设模式
  customPrompts: string[]; // 三个自定义提示词模版（promptPreset = custom-1/2/3 时对应生效）
  annotationLimit: number; // 侧边栏 AI 批注基准字数上限（正文「询问 AI」不限）

  // 标注默认值
  highlightColors: string[]; // 3种高亮颜色
  underlineColor: string; // 下划线颜色

  // 笔记导出
  noteFolder: string;

  // 侧边栏配置
  sidebarPosition: 'right' | 'left';
  sidebarDefaultOpen: boolean;
  annotationSort: 'time' | 'position'; // 同一页内批注的排序方式

  // AI 面板位置持久化
  aiPanelPos?: { left: number; top: number };

  // 手写批注
  /**
   * 桌面端手写批注（默认关闭）。
   * 开启后桌面端获得与移动端一致的手写批注能力：三态胶囊（编辑 / 手写 / 批注列表）
   * 切换模式，手写模式用鼠标落墨，并渲染移动端写入的笔迹
   * （笔迹存 vault 内 .fleur-pdf/ink/ sidecar，随同步服务跨设备）。
   * 真机移动端（Platform.isMobile）始终启用，不受此项影响。
   */
  desktopInk: boolean;

  /**
   * 手写笔迹跨设备同步（默认关）。
   * 开启后，每本有手写批注的 PDF 会在 vault 内生成一份**非隐藏**副本
   * （FleurPDF/data/ink/<文件名>.<哈希>.json），随 Remotely Save / iCloud 等
   * 同步到其他设备；双向合并，删除走墓碑不复活。
   * 每台设备需分别开启。副本内容与内部数据（.fleur-pdf/ink/）等量，
   * 大量笔迹会占用相应空间。
   */
  inkCrossDeviceSync: boolean;

  // ── 截图与 OCR（手写模式相机工具） ──
  /**
   * 是否启用本地 OCR（tesseract.js）。默认关闭——不需要 OCR 的用户
   * 不接触任何 tesseract 相关 UI 与下载行为；开启后结果面板才出现
   * 「本地 OCR」通道，语言包设置与首次下载行为随之可见。
   */
  ocrEnabled: boolean;
  /**
   * 截图取字的默认引擎（结果面板可单次切换）。
   * 'local' = tesseract.js 本地识别（截图不出本机，需先开启 ocrEnabled）；
   * 'vision' = 视觉模型（截图 base64 发往用户配置的端点）。
   * 无论选哪个，PDF 文本层缺位的数字 PDF 才会走到这一步。
   */
  snapOcrEngine: 'local' | 'vision';
  /** 本地 OCR 语言组合（tesseract 语言码，+ 连接）。 */
  ocrLangs: string;
  /** 本地 OCR 语言包下载源（纯数据文件，首次下载后缓存 IndexedDB 离线可用）。 */
  ocrLangPath: string;
  /** 视觉模型 Base URL（OpenAI 兼容；GLM-4V / Qwen-VL / OpenRouter 等均可）。 */
  visionBaseUrl: string;
  /** 视觉模型 API Key（与主 AI 配置互相独立）。 */
  visionApiKey: string;
  /** 视觉模型名（如 glm-4v-plus / qwen-vl-max）。 */
  visionModel: string;

  /** 手写笔参数持久化（四支笔的颜色/粗细/不透明度，由 InkUI 维护）。 */
  inkPens?: Array<{
    kind: 'pen' | 'marker' | 'eraser' | 'lasso';
    color: string;
    thickness: number;
    opacity: number;
  }>;
  /**
   * 手指滚动（GoodNotes 式防误触，默认开）：手写模式下手指滚动页面、
   * 只有笔（Apple Pencil 等）落墨。关闭后手指也可以直接书写/擦除。
   */
  inkFingerScroll?: boolean;
  /** 橡皮擦除模式：pixel=像素擦除（切开口保留盘外线段） stroke=笔画擦除 select=选区擦除。 */
  inkEraserMode?: 'pixel' | 'stroke' | 'select';
  /**
   * 抬笔归并判定（治小米平板「写成了连笔」，只管移动端手写批注）。
   *
   * true（默认）= 笔抬起后重新落下时，按抬笔前的末端速度、方向、悬停轨迹这些
   * 现场物理证据决定「那段该不该画」：判明确连续才连线，拿不准就归并但不落墨
   * （橡皮仍能整条擦、撤销仍是一步）。
   * false = 完全回到 1.7.6 的行为：窗口内近端一律连线续写。
   * 真机若因此觉得笔画容易断，关掉这一项就退回旧手感，不必重装插件。
   */
  inkGraceMerge?: boolean;
  /** 幽灵抬笔归并窗口（ms，默认 150）。抬笔到重新落笔超过它一律算新笔画。 */
  inkGhostWindowMs?: number;
  /** 归并的近端距离上限（CSS px，默认 96）。新落点比这更远一律算新笔画。 */
  inkGhostNearPx?: number;
  /**
   * 悬浮切换器（编辑 / 手写 / 批注 三态胶囊）的位置与形态。
   *
   * 拖动后吸附到左或右边；y 存的是**视口比例**（0~1）而不是像素 ——
   * 换设备、转屏、改分辨率后像素值会跑到屏幕外，比例不会。
   * collapsed = 收成贴边小把手（用户嫌它挡内容时的出路，点把手即可恢复）。
   */
  inkSwitcherSide?: 'left' | 'right';
  inkSwitcherY?: number;
  inkSwitcherCollapsed?: boolean;

  /**
   * 悬浮入口可见性。
   *
   * 背景：胶囊是挂在 document.body 上的，与当前打开的文件无关 —— 用户在
   * 非 PDF 视图（普通笔记、设置页）里它照样浮着，「全局都显示很碍眼」。
   * 于是分两层控制：
   *   ① 运行期自动判定：只有活动文件是 PDF 时才出现（见 InkUI.syncSwitcherVisibility）；
   *   ② 用户手动彻底关掉：inkSwitcherHidden。
   */
  inkSwitcherHidden?: boolean;
  /**
   * 胶囊上三段各自的显隐（缺省 = 显示）。
   *
   * 三段的语义：编辑 = 退出批注回到普通阅读；手写 = 进入落墨；批注列表 = 打开文本批注侧边栏。
   * 用户「手写批注和文本批注的按钮要能隐藏」的诉求即落在后两段上，因此逐段给开关，
   * 而不是只给一个「全有 / 全无」的总闸。
   */
  inkShowEditSeg?: boolean;
  inkShowInkSeg?: boolean;
  inkShowSideSeg?: boolean;

  /**
   * 手写笔盒（落墨时弹出的工具胶囊）的拖动位置。
   * 存的是**笔盒中心的视口比例**（0~1）—— 与切换器同理，像素会随设备/转屏失效，比例不会。
   * 缺省（未拖过）= CSS 默认位置（底部居中）。
   */
  inkBarPos?: { x: number; y: number };

  /** 隐藏左侧栏的 FleurPDF 图标（全局生效，桌面端与移动端同一条规则）。 */
  hideRibbonIcon?: boolean;

  // ── 词典查词与生词本（移植自 fleur-epub；桥接 FleurDict，需 FleurDict ≥ 1.5.12） ──
  /** 查词来源（fleur-pdf 内查词固定用此选项，不读取 FleurDict 的设置） */
  dictSource: 'youdao' | 'free-dict';
  /** 内置查词弹窗位置/尺寸记忆（对齐 FleurDict：拖拽/缩放后持久化，下次打开恢复） */
  dictPopupRect?: { left: number; top: number; width: number; height: number };
  /** 生词本同步：true = 写入 FleurDict 词库（联动闪卡/词高亮/欧路同步）；false = 存 fleur-pdf 独立生词本（wordbook） */
  dictSyncWordbook: boolean;
  /** 独立生词本（仅 dictSyncWordbook = false 时写入；存 data.json，跨设备随配置目录） */
  wordbook: WordbookItem[];
  /**
   * 独立生词本跨设备同步（默认关）。开启后 wordbook 双向合并到 Vault 内
   * FleurPDF/data/wordbook.json（随同步插件跨设备；删除走墓碑防复活），
   * data.json 仍作本机运行时数据与回退。每台设备需分别开启。
   */
  wordbookSync: boolean;
}

export const DEFAULT_SETTINGS: FleurSettings = {
  aiProvider: 'deepseek',
  apiKey: '',
  secretStorageMode: 'system',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.7,
  promptPreset: 'default',
  customPrompts: ['', '', ''],
  annotationLimit: 250,
  highlightColors: ['#D4A017', '#2979C4', '#D32F2F'], // 深金、深蓝、深红
  underlineColor: '#6B0000', // 极深红
  noteFolder: 'FleurReader',
  sidebarPosition: 'right',
  sidebarDefaultOpen: true,
  annotationSort: 'time',
  desktopInk: false,
  inkCrossDeviceSync: false,
  ocrEnabled: false,
  snapOcrEngine: 'local',
  ocrLangs: 'chi_sim+eng',
  ocrLangPath: 'https://tessdata.projectnaptha.com/4.0.0',
  visionBaseUrl: '',
  visionApiKey: '',
  visionModel: '',
  inkSwitcherHidden: false,
  inkShowEditSeg: true,
  inkShowInkSeg: true,
  inkShowSideSeg: true,
  hideRibbonIcon: false,
  dictSource: 'youdao',
  dictSyncWordbook: true,
  wordbook: [],
  wordbookSync: false,
};

export class FleurSettingTab extends PluginSettingTab {
  plugin: FleurPDFPlugin;

  constructor(app: App, plugin: FleurPDFPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions() {
    return [];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── AI 配置 ──
    new Setting(containerEl).setName('AI 配置').setHeading();

    const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-3.5-turbo' },
      zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
      moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    };

    new Setting(containerEl)
      .setName('AI 提供商')
      .setDesc('选择 AI 服务提供商')
      .addDropdown(dropdown => dropdown
        .addOption('deepseek', 'DeepSeek')
        .addOption('openai', 'OpenAI')
        .addOption('zhipu', '智谱 AI')
        .addOption('moonshot', 'Moonshot')
        .setValue(this.plugin.settings.aiProvider)
        .onChange(async (value) => {
          this.plugin.settings.aiProvider = value;
          const defaults = PROVIDER_DEFAULTS[value];
          if (defaults) {
            this.plugin.settings.baseUrl = defaults.baseUrl;
            this.plugin.settings.model = defaults.model;
          }
          await this.plugin.saveSettings();
          this.display(); // 重新渲染以同步 URL 和模型显示
        }));

    // 密钥存储位置
    const secretSection = containerEl.createDiv('fleurpdf-settings-section');
    new Setting(secretSection).setHeading().setName('密钥存储');

    secretSection.createEl('p', {
      text: '决定 API Key 保存在哪里（主 AI 与视觉模型两把 Key 同等对待）。切换后密钥会自动搬到新位置，不会丢失，也不需要重新填写。',
      cls: 'setting-item-description',
    });

    new Setting(secretSection)
      .setName('密钥保存位置')
      .setDesc(
        this.plugin.secretStorageAvailable
          ? '系统钥匙串更安全，但密钥不进 vault，因此每台设备都要各自填写一次；data.json 可随 vault 同步给多台设备共用，代价是密钥以明文保存在仓库中。'
          : '当前 Obsidian 版本不支持系统钥匙串，密钥只能明文保存在 data.json。',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('system', '系统钥匙串（推荐）');
        dropdown.addOption('vault', 'data.json（随 vault 同步）');
        dropdown.setValue(this.plugin.secretBackend);
        if (!this.plugin.secretStorageAvailable) {
          dropdown.setDisabled(true);
        }
        dropdown.onChange(async (value) => {
          const mode = value === 'vault' ? 'vault' : 'system';
          const result = await this.plugin.setSecretStorageMode(mode);
          if (!result.ok) {
            new Notice('FleurPDF：密钥移入系统钥匙串失败，已保持原设置');
          } else if (mode === 'vault') {
            new Notice('FleurPDF：密钥将以明文保存在 data.json，并随 vault 同步');
          } else {
            new Notice('FleurPDF：密钥已移入系统钥匙串，data.json 中不再保存明文');
          }
          // 重新渲染，让密钥说明与警告同步更新
          this.display();
        });
      });

    if (this.plugin.secretStorageAvailable && this.plugin.secretBackend === 'vault') {
      secretSection.createEl('p', {
        text: '注意：当前为明文存储。密钥会随 Obsidian Sync / iCloud / OneDrive 上传到云端，请确认你接受这一点。',
        cls: 'setting-item-description mod-warning',
      });
    }

    new Setting(containerEl)
      .setName('API Key')
      .setDesc(this.secretDesc())
      .addText(text => {
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('API 基础 URL')
      .addText(text => text
        .setPlaceholder('https://api.deepseek.com/v1')
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (value) => {
          this.plugin.settings.baseUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('模型')
      .setDesc('使用的 AI 模型')
      .addText(text => text
        .setPlaceholder('deepseek-chat')
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        }));

    // 温度参数
    new Setting(containerEl)
      .setName('AI 温度')
      .setDesc('控制 AI 输出的随机性。值越高（如 1.0）输出越多样，值越低（如 0.1）输出越保守')
      .addSlider(slider => slider
        .setLimits(0, 1, 0.1)
        .setValue(this.plugin.settings.temperature)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.temperature = value;
          await this.plugin.saveSettings();
        }));

    // 提示词模式（预设选项卡）
    //
    // 切换模式时只重绘下方的「详情区」，不调用 this.display() 重建整个面板。
    // 重建会销毁当前获得焦点的 <select>，浏览器在 DOM 变动后重新定位焦点，
    // 表现为设置窗口自己滚动一下。局部重绘即可避免。
    let dropdownComp: DropdownComponent | null = null;

    new Setting(containerEl)
      .setName('提示词模式')
      .setDesc('选择 AI 生成批注时的角色定位。默认沿用原有的文献批注风格，可随时切换')
      .addDropdown(dropdown => {
        dropdownComp = dropdown;
        PROMPT_PRESETS.forEach(p => dropdown.addOption(p.key, p.label));
        dropdown.setValue(this.plugin.settings.promptPreset)
          .onChange(async (value) => {
            this.plugin.settings.promptPreset = value as PromptPresetKey;
            await this.plugin.saveSettings();
            renderPromptDetail();
          });
      });

    const promptDetailEl = containerEl.createDiv();
    promptDetailEl.addClass('fleur-setting-prompt-detail');

    const renderPromptDetail = () => {
      promptDetailEl.empty();
      const preset = getPromptPreset(this.plugin.settings.promptPreset) ?? PROMPT_PRESETS[0];
      const baseLimit = this.plugin.settings.annotationLimit || ANNOTATION_DEFAULT_BASE_LIMIT;

      if (isCustomPresetKey(this.plugin.settings.promptPreset)) {
        // 三个自定义槽位（与 FleurEPUB / FleurAnnotation 对齐）：当前选中的槽位加高亮提示
        const activeSlot = this.plugin.settings.promptPreset === 'custom-1' ? 1
          : this.plugin.settings.promptPreset === 'custom-2' ? 2 : 3;
        for (let i = 1; i <= 3; i++) {
          new Setting(promptDetailEl)
            .setName(`自定义提示词 ${i}${i === activeSlot ? '（当前使用）' : ''}`)
            .setDesc(i === 1 ? '留空则回落到「默认」模式' : '')
            .setClass('fleur-setting-block')
            .addTextArea(text => {
              text
                .setPlaceholder('在此写下你自己的系统提示词。例如：你是一位……请根据用户高亮的文本……')
                .setValue(this.plugin.settings.customPrompts?.[i - 1] ?? '')
                .onChange(async (value) => {
                  const idx = i - 1;
                  if (!Array.isArray(this.plugin.settings.customPrompts)) {
                    this.plugin.settings.customPrompts = ['', '', ''];
                  }
                  this.plugin.settings.customPrompts[idx] = value;
                  await this.plugin.saveSettings();
                });
              // 覆盖 CSS 里 170px 的默认高度：非当前槽位压到 90px，避免三个框把设置页撑得太长
              text.inputEl.setCssStyles({ width: '100%', minHeight: i === activeSlot ? '170px' : '90px' });
            });
        }
      } else {
        const previewSetting = new Setting(promptDetailEl)
          .setName('当前提示词')
          .setDesc(`仅侧边栏批注受 ${baseLimit} 字限制（原文过长自动放宽），正文「询问 AI」不限。`);

        // 用一个 wrapper 包住「提示词正文」和「附注」，让 wrapper 整体占满剩余空间，
        // 避免附注和铅笔按钮跟预览框在 flex 容器里平级抢宽度。
        const previewWrap = previewSetting.controlEl.createDiv();
        previewWrap.addClass('fleur-setting-prompt-block');

        const preview = previewWrap.createDiv();
        preview.addClass('fleur-setting-prompt-preview');
        preview.textContent = getPresetPreview(preset, baseLimit);

        previewSetting.addExtraButton(btn => btn
          .setIcon('pencil')
          .setTooltip('以此为基础改为自定义 1')
          .onClick(async () => {
            this.plugin.settings.promptPreset = 'custom-1';
            if (!Array.isArray(this.plugin.settings.customPrompts)) {
              this.plugin.settings.customPrompts = ['', '', ''];
            }
            this.plugin.settings.customPrompts[0] = preset.body;
            await this.plugin.saveSettings();
            dropdownComp?.setValue('custom-1');
            renderPromptDetail();
          }));
      }
    };

    renderPromptDetail();

    // 侧边栏 AI 批注字数上限（正文「询问 AI」不受此限制）
    new Setting(containerEl)
      .setName('侧边栏批注字数上限')
      .setDesc('侧边栏「AI 生成批注」的输出基准字数。选中原文较长时上限会自动放宽；正文「询问 AI」不设字数限制')
      .addSlider(slider => slider
        .setLimits(100, 600, 10)
        .setValue(this.plugin.settings.annotationLimit || ANNOTATION_DEFAULT_BASE_LIMIT)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.annotationLimit = value;
          await this.plugin.saveSettings();
          renderPromptDetail();
        }));

    // 测试连接按钮
    const testSetting = new Setting(containerEl);
    testSetting.setName('测试连接');
    testSetting.setDesc('验证 API 配置是否正确');
    testSetting.addButton(btn => {
      btn
        .setButtonText('测试')
        .onClick(async () => {
          btn.setButtonText('测试中...');
          btn.setDisabled(true);
          try {
            const { baseUrl, apiKey, model } = this.plugin.settings;
            const endpoint = resolveChatEndpoint(baseUrl);
            if (!endpoint) {
              btn.setButtonText('✗ 请先填写 Base URL');
              btn.buttonEl.addClass('fleur-setting-test-error');
            } else {
              const response = await requestUrl({
                url: endpoint,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model,
                  messages: [{ role: 'user', content: 'hi' }],
                  max_tokens: 5,
                }),
                // 让 4xx/5xx 走下面的状态码分支，而不是一律被 catch 成「网络错误」。
                // 401 密钥错、403 无权限或地区不支持、404 路径或模型名错、429 限流都要能分辨出来。
                throw: false,
              });
              if (response.status >= 200 && response.status < 300) {
                btn.setButtonText('✓ 连接成功');
                btn.buttonEl.addClass('fleur-setting-test-success');
              } else {
                btn.setButtonText(`✗ 失败 (${response.status})`);
                btn.buttonEl.addClass('fleur-setting-test-error');
                new Notice(`FleurPDF：连接被拒绝 (${response.status})\n${response.text.slice(0, 200)}`);
              }
            }
          } catch (e) {
            // 只有真的没连上（DNS、超时、TLS、代理不通）才归类为网络错误
            btn.setButtonText('✗ 无法连接');
            btn.buttonEl.addClass('fleur-setting-test-error');
            new Notice(`FleurPDF：无法连接，请检查网络、代理与 Base URL\n${e instanceof Error ? e.message : String(e)}`);
          }
          window.setTimeout(() => {
            btn.setButtonText('测试');
            btn.setDisabled(false);
            btn.buttonEl.removeClass('fleur-setting-test-success', 'fleur-setting-test-error');
          }, 3000);
        });
    });

    // ── 查词与生词本（移植自 fleur-epub；桥接 FleurDict） ──
    new Setting(containerEl).setName('查词与生词本').setHeading();

    // FleurDict 检测状态提示（对齐 fleur-epub：让用户知道桥接是否可用）
    containerEl.createEl('p', {
      text: getFleurDictBridge(this.app)
        ? '已检测到 FleurDict：PDF 里选中单词 / 短语可查词（含 AI 详解、加入生词本），选中句子可 AI 翻译。'
        : '未检测到 FleurDict（或版本低于 1.5.12）：选中单词将使用内置词典查词，功能不缺席；安装并启用 FleurDict 后自动切换为它的查词窗。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('查词来源')
      .setDesc('选中单词 / 短语查词时使用的词典（只影响 fleur-pdf 内的查词）')
      .addDropdown((drop) =>
        drop
          .addOption('youdao', '有道词典（英汉释义）')
          .addOption('free-dict', 'Free Dictionary（英文释义）')
          .setValue(this.plugin.settings.dictSource)
          .onChange(async (v) => {
            this.plugin.settings.dictSource = v === 'free-dict' ? 'free-dict' : 'youdao';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('生词本与 FleurDict 同步')
      .setDesc('开启 = 加入生词本时写入 FleurDict 词库（闪卡复习、生词高亮、欧路同步全链路生效）；关闭 = 存入 fleur-pdf 独立生词本，与 FleurDict 互不影响')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.dictSyncWordbook).onChange(async (v) => {
          this.plugin.settings.dictSyncWordbook = v;
          await this.plugin.saveSettings();
          // 原地刷新「独立生词本」描述即可；不可 this.display()——会整页重建导致滚动跳回顶部
          if (wordbookEntry) wordbookEntry.setDesc(wordbookDesc());
        }),
      );

    // 独立生词本条目始终显示：同步关闭时是主词库；同步开启时也可能有历史遗留
    // 词条（开同步前落的词「保留不动」，仍需管理入口），为空且同步开则只提示。
    /** 描述文案随「生词本与 FleurDict 同步」开关状态变化（供初始渲染与原地刷新共用）。 */
    const wordbookDesc = () => {
      const count = this.plugin.settings.wordbook.length;
      return this.plugin.settings.dictSyncWordbook
        ? count > 0
          ? `另有 ${count} 条历史词条存于本插件（开启同步前落的词，保留不动；新查的词已写入 FleurDict）`
          : '为空（开启同步中：新查的词将写入 FleurDict 词库）'
        : `当前 ${count} 词（存于本插件 data.json；勾选上方同步后新查的词将写入 FleurDict，已有词条保留不动）`;
    };
    let wordbookEntry: Setting | null = null;
    {
      const entry = new Setting(containerEl).setName('独立生词本').setDesc(wordbookDesc());
      wordbookEntry = entry;
      // 同步开 + 独立词库为空 → 无可管理内容，不给按钮
      if (this.plugin.settings.wordbook.length > 0) {
        entry.addButton((b) =>
          b.setButtonText('管理').onClick(() => {
            new WordbookManagerModal(this.plugin).open();
          }),
        );
      }
    }

    // ── 独立生词本跨设备同步（与 FleurDict 同步互不相干：只管本插件的独立词库） ──
    new Setting(containerEl)
      .setName('生词本跨设备同步')
      .setDesc(
        '开启后，独立生词本双向同步到 Vault 内 FleurPDF/data/wordbook.json，可被 Remotely Save / iCloud 等同步到其他设备（增删改全同步，删除走墓碑不会复活；data.json 保留作本机回退）。' +
          '需在每台设备上分别开启；仅「生词本与 FleurDict 同步」关闭（独立词库）时有意义。',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.wordbookSync ?? false).onChange(async (v) => {
          this.plugin.settings.wordbookSync = v;
          await this.plugin.saveSettings();
          if (v) {
            // 首次开启即迁移：把本机 data.json 里的存量词条合并进 vault 文件
            const changed = await this.plugin.wordbookSync.pullAndMerge('local-change');
            if (changed) this.plugin.app.workspace.trigger('fleur-pdf:wordbook-changed');
          }
        }),
      );

    // ── 标注设置 ──
    new Setting(containerEl).setName('标注设置').setHeading();

    // 三种高亮颜色
    const hlColors = this.plugin.settings.highlightColors;
    const colorLabels = ['高亮颜色 1', '高亮颜色 2', '高亮颜色 3'];
    const colorDescs = ['右键菜单第一个颜色', '右键菜单第二个颜色', '右键菜单第三个颜色'];

    for (let i = 0; i < 3; i++) {
      new Setting(containerEl)
        .setName(colorLabels[i])
        .setDesc(colorDescs[i])
        .addColorPicker(color => color
          .setValue(hlColors[i])
          .onChange(async (value) => {
            this.plugin.settings.highlightColors[i] = value;
            await this.plugin.saveSettings();
          }))
        .addText(text => text
          .setPlaceholder('#FFFFFF')
          .setValue(hlColors[i])
          .onChange(async (value) => {
            if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
              this.plugin.settings.highlightColors[i] = value;
              await this.plugin.saveSettings();
              this.display();
            }
          }));
    }

    // 下划线颜色
    new Setting(containerEl)
      .setName('默认下划线颜色')
      .setDesc('右键划线时使用的颜色')
      .addColorPicker(color => color
        .setValue(this.plugin.settings.underlineColor)
        .onChange(async (value) => {
          this.plugin.settings.underlineColor = value;
          await this.plugin.saveSettings();
          this.display();
        }))
      .addText(text => text
        .setPlaceholder('#6B0000')
        .setValue(this.plugin.settings.underlineColor)
        .onChange(async (value) => {
          if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
            this.plugin.settings.underlineColor = value;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    // ── 笔记导出 ──
    new Setting(containerEl).setName('笔记导出').setHeading();

    // 扫描 vault 中的所有文件夹供选择
    const folderSet = new Set<string>();
    folderSet.add(''); // 根目录选项
    // 直接枚举 vault 里的文件夹（含空文件夹）。不要用 getAllLoadedFiles 反推祖先目录，
    // 那样空文件夹永远不会出现在下拉里。getAllFolders() @since 1.6.6，默认不含根目录。
    for (const folder of this.app.vault.getAllFolders()) {
      folderSet.add(folder.path);
    }
    const folders = Array.from(folderSet).sort();

    new Setting(containerEl)
      .setName('导出文件夹')
      .setDesc('选择笔记导出的存放文件夹')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'Vault 根目录');
        folders.forEach(folder => {
          if (folder) dropdown.addOption(folder, folder);
        });
        dropdown.setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder = value;
            await this.plugin.saveSettings();
          });
      });

    // ── 侧边栏配置 ──
    new Setting(containerEl).setName('侧边栏配置').setHeading();

    new Setting(containerEl)
      .setName('侧边栏位置')
      .setDesc('选择侧边栏显示位置')
      .addDropdown(dropdown => dropdown
        .addOption('right', '右侧')
        .addOption('left', '左侧')
        .setValue(this.plugin.settings.sidebarPosition)
        .onChange(async (value) => {
          this.plugin.settings.sidebarPosition = value as 'right' | 'left';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认打开侧边栏')
      .setDesc('打开 PDF 时自动显示侧边栏')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.sidebarDefaultOpen)
        .onChange(async (value) => {
          this.plugin.settings.sidebarDefaultOpen = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('同页批注排序')
      .setDesc('同一页内多条批注的排列方式（批注始终按页码先后分页）。按行文顺序即依照文字在页面上的先后位置，从上到下、从左到右')
      .addDropdown(dropdown => dropdown
        .addOption('time', '按时间顺序')
        .addOption('position', '按行文顺序')
        .setValue(this.plugin.settings.annotationSort)
        .onChange(async (value) => {
          this.plugin.settings.annotationSort = value as 'time' | 'position';
          await this.plugin.saveSettings();
          const file = this.app.workspace.getActiveFile();
          void this.plugin.getSidebar()?.refresh(file?.path ?? null);
        }));

    // ── 手写批注 ──
    new Setting(containerEl).setName('手写批注').setHeading();

    new Setting(containerEl)
      .setName('桌面端手写批注')
      .setDesc(
        '开启后，桌面端获得与移动端一致的手写批注能力：通过悬浮胶囊切换「编辑（文本批注）/ 手写」模式，'
        + '手写模式用鼠标落墨，并能查看与编辑移动端写入的手写笔迹'
        + '（笔迹存于 vault 内 .fleur-pdf/ink/，随 Remotely Save / iCloud 等跨设备同步）。'
        + '移动端始终启用，不受此项影响；关闭时桌面端不加载任何手写批注样式。',
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.desktopInk)
        .onChange(async (value) => {
          this.plugin.settings.desktopInk = value;
          await this.plugin.saveSettings();
          this.plugin.applyMobileMode();
        }));

    // 手写笔迹跨设备同步：桌面端与移动端都渲染（用户要求两端都有开关）。
    // 桌面端未开「桌面端手写批注」时本开关不产生实际效果（无手写数据可同步）。
    new Setting(containerEl)
      .setName('手写笔迹跨设备同步')
      .setDesc(
        '开启后，每本有手写批注的 PDF 会在 vault 内生成一份可见副本（FleurPDF/data/ink/），'
        + '随 Remotely Save / iCloud 等同步到其他设备；双向合并，删除走墓碑不会复活，'
        + '需在每台设备上分别开启。'
        + '注意：副本与内部手写数据等量，大量笔迹批注会占用相应 vault 空间；'
        + '同步动作发生在进入手写模式与每次落盘时。',
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.inkCrossDeviceSync)
        .onChange(async (value) => {
          this.plugin.settings.inkCrossDeviceSync = value;
          await this.plugin.saveSettings();
          void this.plugin.inkUI?.syncNow();
        }));

    // 手写批注的其余设置只在移动端 UI 下渲染（真机，或桌面开启手写批注）——
    // 桌面设置页仅保留上面的「桌面端手写批注」开关，其余零新增（桌面零影响）。
    if (isMobileUI(this.plugin)) this.renderInkSettings(containerEl);

    // ── 截图与 OCR ──
    new Setting(containerEl).setName('截图与 OCR').setHeading();

    // 本地 OCR 总开关：默认关闭，不需要 OCR 的用户零接触（无 UI、无下载行为）
    let engineDropdown: DropdownComponent | null = null;
    let ocrRows: HTMLElement | undefined;
    new Setting(containerEl)
      .setName('启用本地 OCR')
      .setDesc(
        '默认关闭。开启后首次使用本地 OCR 时自动下载引擎文件（worker + WASM 内核，'
        + '共约 9.4MB，jsdelivr 固定版本，仅此一次），之后完全离线运行；'
        + '识别全程本机推理、截图不出设备。关闭时截图仅支持 PDF 文本层与视觉模型。',
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.ocrEnabled)
        .onChange(async (value) => {
          this.plugin.settings.ocrEnabled = value;
          // 关闭时若默认引擎停在 local，原地纠正为 vision（不动页面滚动）
          if (!value && this.plugin.settings.snapOcrEngine === 'local') {
            this.plugin.settings.snapOcrEngine = 'vision';
            engineDropdown?.setValue('vision');
          }
          await this.plugin.saveSettings();
          if (ocrRows) ocrRows.hidden = !value;
        }));

    new Setting(containerEl)
      .setName('截图取字引擎')
      .setDesc(
        '手写模式相机工具框选截图后的文字识别方式。数字 PDF 优先走自带文本层（精确、离线），'
        + '文本层缺位（扫描版）时才使用此引擎。本地 OCR 全程本机推理、截图不出设备；'
        + '视觉模型会把截图发送到你配置的端点。结果面板上也可单次切换。',
      )
      .addDropdown(dropdown => {
        engineDropdown = dropdown;
        return dropdown
          .addOption('local', '本地 OCR（tesseract）')
          .addOption('vision', '视觉模型')
          .setValue(this.plugin.settings.snapOcrEngine)
          .onChange(async (value) => {
            this.plugin.settings.snapOcrEngine = value as 'local' | 'vision';
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('视觉模型 Base URL')
      .setDesc('OpenAI 兼容端点即可：GLM-4V（https://open.bigmodel.cn/api/paas/v4）、Qwen-VL、OpenRouter 等。与主 AI 配置互相独立。')
      .addText(text => text
        .setPlaceholder('https://open.bigmodel.cn/api/paas/v4')
        .setValue(this.plugin.settings.visionBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.visionBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('视觉模型 API Key')
      .setDesc(this.secretDesc('视觉模型 API Key'))
      .addText(text => {
        text
          .setPlaceholder('sk-…')
          .setValue(this.plugin.settings.visionApiKey)
          .onChange(async (value) => {
            this.plugin.settings.visionApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        // 与主 API Key 一致：输入框掩码显示，避免 shoulder-surfing / 录屏泄露
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    new Setting(containerEl)
      .setName('视觉模型名称')
      .addText(text => text
        .setPlaceholder('glm-4v-plus')
        .setValue(this.plugin.settings.visionModel)
        .onChange(async (value) => {
          this.plugin.settings.visionModel = value.trim();
          await this.plugin.saveSettings();
        }));

    // 本地 OCR 专属设置：仅 ocrEnabled 开启时可见（容器显隐，不重建页面）
    ocrRows = containerEl.createDiv();
    ocrRows.hidden = !this.plugin.settings.ocrEnabled;

    new Setting(ocrRows)
      .setName('本地 OCR 语言')
      .setDesc('tesseract 语言码，+ 连接（默认 chi_sim+eng 简中+英文）。')
      .addText(text => text
        .setPlaceholder('chi_sim+eng')
        .setValue(this.plugin.settings.ocrLangs)
        .onChange(async (value) => {
          this.plugin.settings.ocrLangs = value.trim() || 'chi_sim+eng';
          await this.plugin.saveSettings();
        }));

    new Setting(ocrRows)
      .setName('OCR 语言包下载源')
      .setDesc(
        '仅首次使用时下载语言包（纯数据文件，约几 MB），之后缓存离线可用。'
        + '默认源不可达时可换成自建 URL（需提供 <语言码>.traineddata.gz 文件）。'
        + 'OCR 代码与推理全部随插件本地运行，不加载任何远程代码。',
      )
      .addText(text => text
        .setPlaceholder('https://tessdata.projectnaptha.com/4.0.0')
        .setValue(this.plugin.settings.ocrLangPath)
        .onChange(async (value) => {
          this.plugin.settings.ocrLangPath = value.trim();
          await this.plugin.saveSettings();
        }));
  }

  /**
   * 移动端手写批注设置（isMobileUI() 为真时才渲染）。
   * 包含：擦除模式、抬笔归并（连笔/断触）、悬浮胶囊显隐、逐段显隐、左侧栏图标开关。
   */
  private renderInkSettings(containerEl: HTMLElement): void {
    // ── 移动端手写批注 ──
    const inkSection = containerEl.createDiv('fleurpdf-settings-section');
    new Setting(inkSection).setHeading().setName('移动端手写批注');

    // 「手指滚动」设置项已随 0.6.0 覆盖层架构移除：手指滚动现在是浏览器原生行为
    // （覆盖层 canvas 的 touch-action 放行平移，touch 永不落墨），没有可关的东西。

    new Setting(inkSection)
      .setName('默认擦除模式')
      .setDesc('笔画擦除：触到哪笔删哪笔；选区擦除：拖一个矩形，相交的笔画整笔删除。')
      .addDropdown(dropdown => dropdown
        .addOption('stroke', '笔画擦除')
        .addOption('select', '选区擦除')
        .setValue(this.plugin.settings.inkEraserMode ?? 'stroke')
        .onChange(async (value) => {
          this.plugin.settings.inkEraserMode = value as 'pixel' | 'stroke' | 'select';
          await this.plugin.saveSettings();
        }));

    // ── 抬笔归并（连笔修复）──
    // 小米平板等笔固件会在连续书写中瞬时上报「抬笔 + 悬停 + 落笔」（实测 24-71ms）。
    // 1.7.5 为治断触把这类瞬时抬笔接回同一笔，代价是「有意的下一笔」也被一根线接上
    // =连笔。现在接不接由现场证据判，并留这条一键退回旧行为的路。
    new Setting(inkSection)
      .setName('智能抬笔归并')
      .setDesc('修复「写着写着变成连笔」。开启后，笔抬起再落下时按运动速度、方向与悬停轨迹判断该不该把这段连上；拿不准就不连线，但仍然算同一条笔画（橡皮整条擦、撤销一步退）。关闭则回到旧行为：窗口内只要落点够近就直接连线。若开了反而觉得笔画容易断，关掉这一项即可退回旧手感。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.inkGraceMerge !== false)
        .onChange(async (value) => {
          this.plugin.settings.inkGraceMerge = value;
          await this.plugin.saveSettings();
          this.plugin.inkUI?.applyGraceTuning();
        }));

    const graceNumber = (
      name: string,
      desc: string,
      placeholder: string,
      read: () => number | undefined,
      write: (v: number | undefined) => void,
    ) => {
      new Setting(inkSection)
        .setName(name)
        .setDesc(desc)
        .addText(text => text
          .setPlaceholder(placeholder)
          .setValue(String(read() ?? ''))
          .onChange(async (value) => {
            const trimmed = value.trim();
            const n = trimmed === '' ? undefined : Number(trimmed);
            // 空 = 用默认值；非数字 = 不改（避免把 NaN 写进 data.json）
            if (trimmed !== '' && (!Number.isFinite(n as number) || (n as number) <= 0)) return;
            write(n);
            await this.plugin.saveSettings();
            this.plugin.inkUI?.applyGraceTuning();
          }));
    };

    graceNumber(
      '归并窗口（毫秒）',
      '抬笔后多久之内落笔才算同一笔。默认 150：真机实测瞬时抬笔都在 71ms 内，有意提笔都在 384ms 以上。调大会把有意笔画也并进来，调小会重新出现断触。',
      '150',
      () => this.plugin.settings.inkGhostWindowMs,
      (v) => { this.plugin.settings.inkGhostWindowMs = v; },
    );
    graceNumber(
      '归并距离（像素）',
      '落笔点离上一个点多远以内才可能算同一笔。默认 96（屏幕像素，与缩放无关）。调大更容易连笔，调小更容易断。',
      '96',
      () => this.plugin.settings.inkGhostNearPx,
      (v) => { this.plugin.settings.inkGhostNearPx = v; },
    );

    // ── 悬浮按钮：整体显隐 ──
    // 按钮只在打开 PDF 时出现（运行期自动判定，不占这一栏）；这里管的是「即便在 PDF 里也不想看到它」。
    new Setting(inkSection)
      .setName('显示悬浮按钮')
      .setDesc('右下角的「编辑 / 手写 / 批注」胶囊。按钮仅在当前文件是 PDF 时出现，浏览普通笔记时会自动隐藏；关闭此项则任何情况下都不出现，可在命令面板用「显示 / 隐藏手写批注悬浮按钮」找回。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.inkSwitcherHidden !== true)
        .onChange(async (value) => {
          this.plugin.settings.inkSwitcherHidden = !value;
          await this.plugin.saveSettings();
          this.plugin.inkUI?.refreshVisibility();
        }));

    // ── 悬浮按钮：逐段显隐 ──
    const segToggle = (
      name: string,
      desc: string,
      current: boolean,
      write: (on: boolean) => void,
    ) => {
      new Setting(inkSection)
        .setName(name)
        .setDesc(desc)
        .addToggle(toggle => toggle
          .setValue(current)
          .onChange(async (value) => {
            write(value);
            await this.plugin.saveSettings();
            this.plugin.inkUI?.refreshVisibility();
          }));
    };

    segToggle(
      '保留「编辑」按钮',
      '用于从手写模式退回普通阅读。',
      this.plugin.settings.inkShowEditSeg !== false,
      (on) => { this.plugin.settings.inkShowEditSeg = on; },
    );
    segToggle(
      '保留「手写批注」按钮',
      '关闭后胶囊上不再有落墨入口。手写状态下再点一次同一按钮也能退出，所以关掉它不会把人困住。',
      this.plugin.settings.inkShowInkSeg !== false,
      (on) => { this.plugin.settings.inkShowInkSeg = on; },
    );
    segToggle(
      '保留「批注列表」按钮',
      '打开文本批注侧边栏的入口。关掉后仍可用命令面板或普通视图的 ribbon 图标打开侧边栏。',
      this.plugin.settings.inkShowSideSeg !== false,
      (on) => { this.plugin.settings.inkShowSideSeg = on; },
    );

    // ── 界面入口 ──
    new Setting(containerEl).setName('界面入口').setHeading();

    new Setting(containerEl)
      .setName('显示左侧栏图标')
      .setDesc('左侧边栏（移动端需展开抽屉）里的 FleurPDF 图标，用于打开批注侧边栏。关闭后可用命令面板的「打开批注侧边栏」替代。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.hideRibbonIcon !== true)
        .onChange(async (value) => {
          this.plugin.settings.hideRibbonIcon = !value;
          await this.plugin.saveSettings();
          this.plugin.applyRibbonVisibility();
        }));
  }

  /**
   * 描述密钥当前保存在哪里，措辞与「密钥保存位置」设置保持一致。
   */
  private secretDesc(label = 'API Key'): string {
    if (!this.plugin.secretStorageAvailable) {
      return `${label}。当前 Obsidian 版本不支持系统钥匙串，将以明文保存在 data.json。`;
    }
    return this.plugin.secretBackend === 'system'
      ? `${label}。已保存在系统钥匙串，不会写入 data.json，也不会随 vault 同步。`
      : `${label}。当前以明文保存在 data.json，会随 vault 同步到其他设备。`;
  }
}
