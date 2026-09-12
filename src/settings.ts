import { App, PluginSettingTab, Setting, DropdownComponent, Notice, requestUrl } from 'obsidian';
import type FleurPDFPlugin from './main';
import { PROMPT_PRESETS, getPromptPreset, getPresetPreview, ANNOTATION_DEFAULT_BASE_LIMIT } from './ai-prompts';
import type { PromptPresetKey } from './ai-prompts';

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
  customPrompt: string; // 自定义 AI prompt（仅 promptPreset = 'custom' 时生效）
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
}

export const DEFAULT_SETTINGS: FleurSettings = {
  aiProvider: 'deepseek',
  apiKey: '',
  secretStorageMode: 'system',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.7,
  promptPreset: 'default',
  customPrompt: '',
  annotationLimit: 250,
  highlightColors: ['#D4A017', '#2979C4', '#D32F2F'], // 深金、深蓝、深红
  underlineColor: '#6B0000', // 极深红
  noteFolder: 'FleurReader',
  sidebarPosition: 'right',
  sidebarDefaultOpen: true,
  annotationSort: 'time',
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

      if (this.plugin.settings.promptPreset === 'custom') {
        new Setting(promptDetailEl)
          .setName('自定义提示词')
          .setDesc('留空则回落到「默认」模式')
          .setClass('fleur-setting-block')
          .addTextArea(text => text
            .setPlaceholder('在此写下你自己的系统提示词。例如：你是一位……请根据用户高亮的文本……')
            .setValue(this.plugin.settings.customPrompt)
            .onChange(async (value) => {
              this.plugin.settings.customPrompt = value;
              await this.plugin.saveSettings();
            }));
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
          .setTooltip('以此为基础改为自定义')
          .onClick(async () => {
            this.plugin.settings.promptPreset = 'custom';
            this.plugin.settings.customPrompt = preset.body;
            await this.plugin.saveSettings();
            dropdownComp?.setValue('custom');
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
            const response = await requestUrl({
              url: `${baseUrl}/chat/completions`,
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
            });
            if (response.status >= 200 && response.status < 300) {
              btn.setButtonText('✓ 连接成功');
              btn.buttonEl.addClass('fleur-setting-test-success');
            } else {
              btn.setButtonText(`✗ 失败 (${response.status})`);
              btn.buttonEl.addClass('fleur-setting-test-error');
            }
          } catch (_e) {
            btn.setButtonText('✗ 网络错误');
            btn.buttonEl.addClass('fleur-setting-test-error');
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
    this.app.vault.getAllLoadedFiles().forEach(file => {
      if (file.path.includes('/')) {
        const parts = file.path.split('/');
        let current = '';
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i];
          folderSet.add(current);
        }
      }
    });
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
