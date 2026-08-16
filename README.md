# FleurPDF

**Smart PDF Reading and Annotation Plugin for Obsidian**

[中文文档](#中文文档)

---

## ✨ Features

### Why Choose FleurPDF Over Other PDF Plugins?

1. **Chinese-Friendly Design**
   - Optimized text selection for Chinese characters
   - Proper handling of CJK text in PDFs
   - Smart text boundary detection

2. **WYSIWYG Highlights with AI Annotations**
   - What you see is what you get - highlights appear exactly where you select
   - AI can automatically generate insightful annotations for highlighted text
   - Visual feedback is immediate and accurate

3. **AI-Powered Assistance**
   - **AI Explain**: Get detailed explanations of selected text
   - **AI Translation**: Instant translation between Chinese and English
   - **AI Annotations**: Auto-generate thoughtful notes for your highlights
   - Supports any OpenAI-compatible API (DeepSeek, OpenAI, etc.)

4. **One-Click Note Export**
   - Export all annotations and highlights to a new Obsidian note
   - Preserves page numbers and organization
   - Perfect for creating reading summaries

### Complete Feature List

- 📝 **Highlighting**: Yellow, blue, green, and customizable colors
- 📏 **Underlining**: Solid, dashed, dotted, or wavy styles
- 💬 **Comments**: Add personal notes to any text selection
- 🤖 **AI Features**:
  - Explain complex passages
  - Translate text
  - Generate intelligent annotations
  - Interactive Q&A about selected content
- 📊 **Sidebar**: View and manage all annotations in one place
- 📤 **Export**: One-click export to Obsidian notes
- 🎨 **Customizable**: Adjust colors, styles, and AI settings

## 📦 Installation

### Manual Installation

1. Download the latest release from GitHub
2. Extract the files to your vault: `<vault>/.obsidian/plugins/fleur-pdf/`
3. Reload Obsidian
4. Enable "FleurPDF" in Settings → Community plugins

### Build from Source

```bash
git clone https://github.com/yourusername/fleur-pdf.git
cd fleur-pdf
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder.

## 🔧 Configuration

### AI Setup

1. Open Obsidian Settings → FleurPDF
2. Choose your AI provider (DeepSeek, OpenAI, or Custom)
3. Enter your API Key (**stored locally only**)
4. Configure the Base URL if using a custom endpoint
5. Click "Test Connection" to verify

**Security Note**: Your API Key is stored locally in Obsidian's data and never leaves your device except when making API calls.

### Annotation Settings

- **Default Highlight Color**: Choose your preferred highlight color
- **Default Underline Style**: Select solid, dashed, dotted, or wavy
- **Note Export Folder**: Specify where exported notes should be saved
- **Sidebar Position**: Choose left or right sidebar

## 📖 Usage Guide

### Basic Annotations

1. **Select Text**: Click and drag to select text in the PDF
2. **Right-Click Menu**: Choose from the following options:
   - **Highlight**: Add a colored background to the text
   - **Underline**: Add an underline with various styles
   - **Comment**: Add a personal annotation
   - **Ask AI**: Get AI explanation of the selected text
   - **AI Translation**: Translate the text instantly

### AI Features

#### AI Explain
Select text → Right-click → "Ask AI" → Get detailed explanation with:
- Key concept definitions
- Background context
- Deep analysis

#### AI Translation
Select text → Right-click → "AI Translation" → Instant bidirectional translation (Chinese ↔ English)

#### AI Annotations
Highlight text → Click the 💡 icon in sidebar → AI generates intelligent annotations automatically

### Managing Annotations

The sidebar shows all your annotations:
- 📌 View all highlights and comments
- ✏️ Edit annotations inline
- 🗑️ Delete unwanted items
- 💾 Export everything to a note

### Exporting Notes

Click "Export Notes" in the sidebar to create a new Obsidian note with:
- All highlights with page numbers
- All comments and annotations
- Organized by page for easy reference

## 🛠️ Development

### Project Structure

```
fleur-pdf/
├── src/
│   ├── main.ts           # Plugin entry point
│   ├── patcher.ts        # PDF view interception
│   ├── sidebar.ts        # Annotation sidebar
│   ├── ai-chat-modal.ts  # AI dialog panel
│   ├── ai-service.ts     # AI API service
│   ├── settings.ts       # Settings panel
│   └── store.ts          # Data persistence
├── manifest.json
├── package.json
└── styles.css
```

### Build Commands

```bash
npm run build      # Build for production
npm run dev        # Development mode with watch
```

## 🐛 Troubleshooting

### "Text not found" Error

This can happen when:
- The PDF text layer is not fully loaded
- You're selecting across multiple pages

**Solution**: Wait a moment after selecting text, or try selecting again.

### AI Not Responding

Check:
- API Key is correctly configured
- Base URL is accessible
- Internet connection is stable

Use the "Test Connection" button to verify your setup.

## 📝 License

MIT License

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

---

# 中文文档

## ✨ 功能特色

### 为什么选择 FleurPDF？

1. **中文友好**
   - 针对中文字符优化的文本选择
   - 正确处理 PDF 中的中日韩文字
   - 智能文本边界检测

2. **所见即所得的高亮 + AI 批注**
   - 高亮效果所见即所得，精确显示在选中的位置
   - AI 可以自动为高亮文本生成有见地的批注
   - 视觉反馈即时且准确

3. **AI 智能助手**
   - **AI 解释**：获取选中文本的详细解释
   - **AI 翻译**：中英文即时互译
   - **AI 批注**：为高亮内容自动生成智能批注
   - 支持任何 OpenAI 兼容 API（DeepSeek、OpenAI 等）

4. **一键导出笔记**
   - 将所有批注和高亮导出为新的 Obsidian 笔记
   - 保留页码和结构组织
   - 非常适合创建阅读摘要

### 完整功能列表

- 📝 **高亮标注**：黄色、蓝色、绿色等多种可自定义颜色
- 📏 **下划线**：实线、虚线、点线、波浪线等多种样式
- 💬 **批注**：为任何选中文本添加个人注释
- 🤖 **AI 功能**：
  - 解释复杂段落
  - 翻译文本
  - 生成智能批注
  - 针对选中内容进行互动问答
- 📊 **侧边栏**：在一个地方查看和管理所有批注
- 📤 **导出**：一键导出为 Obsidian 笔记
- 🎨 **可定制**：调整颜色、样式和 AI 设置

## 📦 安装方法

### 手动安装

1. 从 GitHub 下载最新版本
2. 解压文件到你的仓库：`<vault>/.obsidian/plugins/fleur-pdf/`
3. 重新加载 Obsidian
4. 在设置 → 第三方插件中启用"FleurPDF"

### 从源码构建

```bash
git clone https://github.com/yourusername/fleur-pdf.git
cd fleur-pdf
npm install
npm run build
```

然后将 `main.js`、`manifest.json` 和 `styles.css` 复制到你的仓库的插件文件夹。

## 🔧 配置说明

### AI 设置

1. 打开 Obsidian 设置 → FleurPDF
2. 选择 AI 提供商（DeepSeek、OpenAI 或自定义）
3. 输入 API Key（**仅保存在本地**）
4. 如果使用自定义端点，配置 Base URL
5. 点击"测试连接"验证设置

**安全说明**：您的 API Key 仅保存在 Obsidian 本地数据中，除调用 API 外不会离开您的设备。

### 批注设置

- **默认高亮颜色**：选择您偏好的高亮颜色
- **默认下划线样式**：选择实线、虚线、点线或波浪线
- **笔记导出文件夹**：指定导出笔记的保存位置
- **侧边栏位置**：选择左侧或右侧边栏

## 📖 使用指南

### 基础批注

1. **选中文本**：在 PDF 中点击并拖动选择文本
2. **右键菜单**：从以下选项中选择：
   - **高亮**：为文本添加彩色背景
   - **划线**：添加各种样式的下划线
   - **批注**：添加个人注释
   - **询问 AI**：获取选中内容的 AI 解释
   - **AI 翻译**：即时翻译文本

### AI 功能

#### AI 解释
选中文本 → 右键 → "询问 AI" → 获取详细解释，包括：
- 关键概念定义
- 背景信息
- 深度分析

#### AI 翻译
选中文本 → 右键 → "AI 翻译" → 即时双向翻译（中文 ↔ 英文）

#### AI 批注
高亮文本 → 点击侧边栏的 💡 图标 → AI 自动生成智能批注

### 管理批注

侧边栏显示您的所有批注：
- 📌 查看所有高亮和批注
- ✏️ 内联编辑批注
- 🗑️ 删除不需要的项目
- 💾 全部导出为笔记

### 导出笔记

点击侧边栏中的"导出笔记"创建新的 Obsidian 笔记，包含：
- 所有高亮及页码
- 所有批注和注释
- 按页码组织，便于查阅

## 🐛 故障排除

### "未找到选中文本"错误

可能发生在：
- PDF 文本层未完全加载
- 跨页选择文本

**解决方法**：选中文本后稍等片刻，或重新选择。

### AI 无响应

检查：
- API Key 配置正确
- Base URL 可访问
- 网络连接稳定

使用"测试连接"按钮验证您的设置。

## 📝 许可证

MIT 许可证

## 🤝 贡献

欢迎贡献！请随时提交 issue 或 pull request。
