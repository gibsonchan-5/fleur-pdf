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

5. **Sticky Notes on PDF Pages** *(opt-in, v1.8.0)*
   - Pin draggable, resizable, collapsible sticky notes anywhere on a PDF page
   - One click collects all notes into a single Markdown note; re-exporting overwrites the same note
   - Background color and font size are user-configurable
   - Fully local: content lives in a sidecar file under the plugin's `data/` folder (hashed file
     name, no paths or note titles in it), and the exported note is an ordinary vault note

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

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gibsonchan-5/fleur-pdf/releases/latest)
2. Create a folder `<vault>/.obsidian/plugins/fleur-pdf/`
3. Place the three files into the folder
4. Reload Obsidian
5. Enable "FleurPDF" in Settings → Community plugins

### Build from Source

```bash
git clone https://github.com/gibsonchan-5/fleur-pdf.git
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

### Mobile Handwriting (Ink) Annotations

Stylus ink is rendered on the plugin's own overlay canvases and persisted in a sidecar file under
`FleurPDF/data/` — it is never baked into your PDF, and it is only ever written to your own vault.

- **Ink display precision**: rasterising and compositing the ink layer costs scale with the screen
  DPR, so on some tablets writing feels laggy even though the pen itself reports normally (the ink
  trails the stylus). Settings → Mobile handwriting → *Ink display precision* caps the ink layer at
  a lower resolution (*Balanced* ≈ half the pixels, *Smooth* ≈ 40%), which usually makes it
  responsive again. This changes **on-screen resolution only** — stroke data, coordinates, hit
  testing and exports are unaffected, and *Native* restores full sharpness at any time.
- **Stroke-break / lag diagnostics** (command palette → 「手写断触诊断」, mobile only): a passive,
  command-gated recorder that samples pointer and touch timing plus frame gaps while you write, and
  saves them to `FleurPDF/ink-debug.json` and `FleurPDF/ink-debug.md` inside your vault.
  **These are local files; the plugin uploads nothing and has no telemetry.** What a capture
  contains: event timestamps, the on-screen position of each sampled pointer/touch (i.e. roughly
  where on the page you were writing), pressure/size fields, the CSS class of the touched element,
  and small counters (how many canvases/pages/strokes are live, current pen width and opacity,
  frame-gap durations). What it does **not** contain: PDF text, note or file contents, file names,
  vault paths, account details, or API keys. Both files are safe to delete at any time, and the
  recorder only runs between the two invocations of that command.

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


### Screenshot & OCR (network behaviour declaration)

The ink toolbar includes a **camera tool**: drag a rectangle over the PDF to capture a
high-resolution region (re-rendered via pdf.js, independent of screen zoom). From the
result panel you can copy the image, copy recognized text, ask the AI, or save to vault.

- **Text from digital PDFs** is extracted from the PDF text layer — offline and exact.
- **Local OCR** (tesseract.js, Apache-2.0, see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md))
  runs entirely on your machine and is **strictly opt-in** (off by default). Only after you
  enable it in Settings are the engine files (worker script + WASM kernel, ~9.4 MB, version-pinned
  from jsDelivr) downloaded once on first use and cached in the plugin folder — fully offline
  afterwards. The language data file (plain data) is likewise downloaded once from the configured
  source and cached.
- **Vision model** (optional) sends the screenshot to the endpoint *you* configure in
  Settings → Screenshot & OCR; nothing is sent without your explicit action.

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

5. **PDF 页面便签**（可选开启，v1.8.0）
   - 便签可拖拽 pin 在页面任意位置，自由缩放、可折叠成小脚注
   - 一键将全部便签整理导出为一篇 Markdown 笔记，再次导出自动覆盖同一篇
   - 底色与字号均可在设置里自定义
   - 完全本地：便签内容存在插件 `data/` 目录下的 sidecar 文件（文件名为哈希，不含路径信息），
     导出的笔记就是普通 vault 笔记，插件不上传任何内容

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

1. 从 [latest release](https://github.com/gibsonchan-5/fleur-pdf/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`
2. 创建文件夹 `<vault>/.obsidian/plugins/fleur-pdf/`
3. 将三个文件放入该文件夹
4. 重新加载 Obsidian
5. 在设置 → 第三方插件中启用"FleurPDF"

### 从源码构建

```bash
git clone https://github.com/gibsonchan-5/fleur-pdf.git
cd fleur-pdf
npm install
npm run build
```

然后将 `main.js`、`manifest.json` 和 `styles.css` 复制到你的仓库的插件文件夹。

## 🔧 配置说明

### AI 设置

1. 打开 Obsidian 设置 → FleurPDF
2. 选择 AI 提供商（DeepSeek、OpenAI 或自定义）
3. 输入 API Key（**默认保存在系统钥匙串**，可选改为随 vault 同步）
4. 如果使用自定义端点，配置 Base URL
5. 点击"测试连接"验证设置

**安全说明**：主 AI 与视觉模型两把 API Key 默认存入 Obsidian 系统钥匙串（`SecretStorage`），不写入 `data.json`，因此不会随 vault 同步上传；只有在设置里显式把「密钥保存位置」改为 data.json 时，密钥才会以明文随 vault 同步。除调用你所配置的 AI / 词典端点外，插件不向任何服务器发送笔记内容，也没有任何遥测或上报。

### 批注设置

- **默认高亮颜色**：选择您偏好的高亮颜色
- **默认下划线样式**：选择实线、虚线、点线或波浪线
- **笔记导出文件夹**：指定导出笔记的保存位置
- **侧边栏位置**：选择左侧或右侧边栏

### 移动端手写批注

手写笔迹画在插件自建的覆盖层 canvas 上，笔迹数据存在 vault 内的 `FleurPDF/data/` sidecar 文件里，
不会写进你的 PDF 原件，也只写在你自己的 vault 中。

- **笔迹显示精度**：笔迹层的栅格化与合成开销随屏幕 DPR 增长。平板上如果出现「笔的采样一切正常、
  字却跟不上笔尖」的卡顿，可在设置 → 移动端手写批注里把这一项改为「均衡」（像素量约减半）或
  「流畅」（约减六成），通常会立刻跟手。它**只改显示分辨率**：笔迹数据、坐标、命中测试、导出一律
  不受影响，随时改回「原始」即可恢复最锐利的笔迹。
- **断触 / 卡顿诊断**（命令面板 → 「手写断触诊断」，仅移动端）：一个被命令开关的被动记录器，
  在你书写期间采样指针/触摸时序与帧间隔，写入 vault 内的 `FleurPDF/ink-debug.json` 与
  `FleurPDF/ink-debug.md`。**这两个文件只落在本机，插件不上传任何内容，也没有遥测。**
  记录内容：事件时间戳、每次采样的屏幕位置（大致等于你在页面上书写的地方）、压感/接触面尺寸、
  被按到的元素 class，以及若干计数（当前挂着几页覆盖层、多少笔迹、笔的粗细与透明度、掉帧毫秒数）。
  记录内容**不包括**：PDF 文字、笔记正文、文件名、vault 路径、账号信息、API Key。
  两个文件随时可以整篇删除，且记录器只在该命令运行期间工作。

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
