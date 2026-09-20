import { App, PluginSettingTab, Setting, DropdownComponent, Notice, requestUrl } from 'obsidian';
import type FleurPDFPlugin from './main';
import { PROMPT_PRESETS, getPromptPreset, getPresetPreview, isCustomPresetKey, ANNOTATION_DEFAULT_BASE_LIMIT } from './ai-prompts';
import type { PromptPresetKey } from './ai-prompts';
import { resolveChatEndpoint } from './ai-transport';
import { isMobileUI } from './platform';

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

  // 移动端手写批注
  /**
   * 在桌面端预览移动端形态（默认关闭）。
   * 开启后桌面端也会加载手写批注的 UI 与编辑器样式，用于在电脑上调试真机手感。
   * 真机移动端（Platform.isMobile）始终启用，不受此项影响。
   */
  mobileDebug: boolean;

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
  mobileDebug: false,
  inkSwitcherHidden: false,
  inkShowEditSeg: true,
  inkShowInkSeg: true,
  inkShowSideSeg: true,
  hideRibbonIcon: false,
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
      text: '决定 API Key 保存在哪里。切换后密钥会自动搬到新位置，不会丢失，也不需要重新填写。',
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

    // ── 移动端手写批注 ──
    new Setting(containerEl).setName('移动端手写批注').setHeading();

    new Setting(containerEl)
      .setName('在桌面端预览移动端形态')
      .setDesc(
        '开启后，桌面端也会加载手写批注的工具栏与编辑器样式，供在电脑上调试移动端手感。'
        + '真机移动端始终启用，不受此项影响；关闭时桌面端不加载任何手写批注样式。',
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.mobileDebug)
        .onChange(async (value) => {
          this.plugin.settings.mobileDebug = value;
          await this.plugin.saveSettings();
          this.plugin.applyMobileMode();
        }));

    // 手写批注的其余设置只在移动端 UI 下渲染（真机，或桌面开启了预览形态）——
    // 桌面设置页仅保留上面的「预览」开关，其余零新增（桌面零影响）。
    if (isMobileUI(this.plugin)) this.renderInkSettings(containerEl);
  }

  /**
   * 移动端手写批注设置（isMobileUI() 为真时才渲染）。
   * 包含：擦除模式、悬浮胶囊显隐、逐段显隐、左侧栏图标开关。
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
  private secretDesc(): string {
    if (!this.plugin.secretStorageAvailable) {
      return 'API Key。当前 Obsidian 版本不支持系统钥匙串，将以明文保存在 data.json。';
    }
    return this.plugin.secretBackend === 'system'
      ? 'API Key。已保存在系统钥匙串，不会写入 data.json，也不会随 vault 同步。'
      : 'API Key。当前以明文保存在 data.json，会随 vault 同步到其他设备。';
  }
}
