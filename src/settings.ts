import { App, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import type FleurPDFPlugin from './main';

export interface FleurSettings {
  // AI 配置
  aiProvider: string;
  apiKey: string;
  baseUrl: string;
  model: string;

  // 标注默认值
  highlightColor: string;
  underlineStyle: 'solid' | 'dashed' | 'dotted' | 'wavy';
  underlineColor: string;

  // 笔记导出
  noteFolder: string;

  // 侧边栏配置
  sidebarPosition: 'right' | 'left';
  sidebarDefaultOpen: boolean;
}

export const DEFAULT_SETTINGS: FleurSettings = {
  aiProvider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  highlightColor: '#FFD43B',
  underlineStyle: 'solid',
  underlineColor: '#E8590C',
  noteFolder: 'FleurReader',
  sidebarPosition: 'right',
  sidebarDefaultOpen: true,
};

export class FleurSettingTab extends PluginSettingTab {
  plugin: FleurPDFPlugin;

  constructor(app: App, plugin: FleurPDFPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): any[] {
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

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('仅保存在本地')
      .addText(text => text
        .setPlaceholder('sk-...')
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        }));

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
          } catch (e) {
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

    // 高亮颜色 — 颜色选择器 + 色值文本双控
    new Setting(containerEl)
      .setName('默认高亮颜色')
      .setDesc('右键高亮时使用的颜色')
      .addColorPicker(color => color
        .setValue(this.plugin.settings.highlightColor)
        .onChange(async (value) => {
          this.plugin.settings.highlightColor = value;
          await this.plugin.saveSettings();
          this.display(); // 刷新以同步文本框
        }))
      .addText(text => text
        .setPlaceholder('#FFD43B')
        .setValue(this.plugin.settings.highlightColor)
        .onChange(async (value) => {
          if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
            this.plugin.settings.highlightColor = value;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    // 下划线样式
    new Setting(containerEl)
      .setName('默认下划线样式')
      .setDesc('右键划线时使用的样式')
      .addDropdown(dropdown => dropdown
        .addOption('solid', '直线')
        .addOption('dashed', '虚线')
        .addOption('dotted', '点线')
        .addOption('wavy', '波浪')
        .setValue(this.plugin.settings.underlineStyle)
        .onChange(async (value) => {
          this.plugin.settings.underlineStyle = value as 'solid' | 'dashed' | 'dotted' | 'wavy';
          await this.plugin.saveSettings();
        }));

    // 下划线颜色 — 颜色选择器 + 色值文本双控
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
        .setPlaceholder('#E8590C')
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
  }
}
