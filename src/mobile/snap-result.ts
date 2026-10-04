// 局部截图结果面板：预览 + 复制图像 / 复制文本 / 询问 AI / 存入 vault。
//
// 文本获取三通道（按用户选择或自动降级）：
//   1. PDF 文本层 —— 数字 PDF 精确、离线、瞬时（text-extract.ts）
//   2. 本地 OCR   —— tesseract.js 本地推理，截图不出本机（ocr.ts）
//   3. 视觉模型   —— 用户自配端点，走 AI 四通道传输（ai-service.ts）
//
// 形态：桌面居中浮动卡（可拖）；移动端底部抽屉。风格对齐 AI 面板。

import { Notice, normalizePath, Platform, setIcon, TFolder } from 'obsidian';
import type FleurPDFPlugin from '../main';
import { AIChatPanel } from '../ai-chat-modal';
import { AIService } from '../ai-service';
import { renderSnapRegion, type SnapImage, type SnapRegion } from './ink/snap-renderer';
import { extractTextInRect } from './ink/text-extract';
import type { SnapRect } from './ink/overlay-engine';

/** 文本通道选择：auto = 文本层优先，缺位时落settings 默认引擎。 */
type TextChannel = 'auto' | 'local' | 'vision';

const CHANNEL_LABEL: Record<TextChannel, string> = {
	auto: '自动',
	local: '本地 OCR',
	vision: '视觉模型',
};

export class SnapResultPanel {
	private panelEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private previewEl: HTMLImageElement | null = null;
	private channel: TextChannel = 'auto';
	private extracting = false;
	private dragHandlers: ((e: MouseEvent) => void) | null = null;

	constructor(
		private plugin: FleurPDFPlugin,
		private region: SnapRegion,
		private image: SnapImage,
		private viewer: any
	) {
		this.channel = 'auto';
	}

	open() {
		this.close();
		const mobile = Platform.isMobile;
		const panel = document.body.createDiv('fleur-snap-panel');
		if (mobile) panel.addClass('is-mobile');
		this.panelEl = panel;

		// ── 标题栏 ──
		const header = panel.createDiv('fleur-snap-header');
		header.createSpan({ cls: 'fleur-snap-title', text: `截图 · 第 ${this.region.page} 页` });
		const closeBtn = header.createEl('button', { cls: 'fleur-snap-close', text: '×' });
		closeBtn.addEventListener('click', () => this.close());
		if (!mobile) header.addEventListener('mousedown', (e) => this.onDragStart(e));

		// ── 预览 ──
		const previewWrap = panel.createDiv('fleur-snap-preview');
		this.previewEl = previewWrap.createEl('img');
		this.previewEl.src = this.image.dataUrl;
		this.previewEl.alt = '截图预览';

		// ── 通道切换（文字提取用哪个引擎）──
		// 本地 OCR 通道仅在设置开启时出现（ocrEnabled 总开关，默认关）
		const localAllowed = this.plugin.settings.ocrEnabled === true;
		const channelRow = panel.createDiv('fleur-snap-channel');
		channelRow.createSpan({ cls: 'fleur-snap-channel-label', text: '取字引擎' });
		const channels: TextChannel[] = localAllowed
			? ['auto', 'local', 'vision']
			: ['auto', 'vision'];
		if (!channels.includes(this.channel)) this.channel = 'auto';
		for (const ch of channels) {
			const chip = channelRow.createEl('button', { cls: 'fleur-snap-chip', text: CHANNEL_LABEL[ch] });
			if (ch === this.channel) chip.addClass('is-active');
			chip.addEventListener('click', () => {
				this.channel = ch;
				channelRow.findAll('.fleur-snap-chip').forEach((el) => el.removeClass('is-active'));
				chip.addClass('is-active');
			});
		}

		// ── 动作区 ──
		const actions = panel.createDiv('fleur-snap-actions');
		this.addButton(actions, '复制图像', 'camera', () => this.copyImage());
		this.addButton(actions, '复制文本', 'clipboard-copy', () => void this.copyText());
		this.addButton(actions, '询问 AI', 'sparkles', () => this.askAI());
		this.addButton(actions, '存入 vault', 'save', () => void this.saveToVault());

		// ── 状态行 ──
		this.statusEl = panel.createDiv('fleur-snap-status');
		this.statusEl.setText('复制文本将按所选引擎提取');

		// 点击面板外关闭（桌面）
		if (!mobile) {
			const handler = (e: MouseEvent) => {
				if (this.panelEl && !this.panelEl.contains(e.target as Node)) this.close();
			};
			window.setTimeout(() => document.addEventListener('mousedown', handler), 50);
			this.dragHandlers = handler;
		}
	}

	close() {
		if (this.dragHandlers) {
			document.removeEventListener('mousedown', this.dragHandlers);
			this.dragHandlers = null;
		}
		this.panelEl?.remove();
		this.panelEl = null;
	}

	private setStatus(text: string) {
		this.statusEl?.setText(text);
	}

	private addButton(parent: HTMLElement, label: string, icon: string, onClick: () => void) {
		const btn = parent.createEl('button', { cls: 'fleur-snap-btn' });
		setIcon(btn, icon);
		btn.createSpan({ text: label });
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			onClick();
		});
	}

	/* ------------------------------ 动作 ------------------------------ */

	private async copyImage(): Promise<void> {
		try {
			const blob = await (await fetch(this.image.dataUrl)).blob();
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			new Notice('已复制截图到剪贴板');
		} catch {
			new Notice('当前环境不支持复制图片，请用「存入 vault」');
		}
	}

	private async copyText(): Promise<void> {
		if (this.extracting) return;
		this.extracting = true;
		try {
			const { text, source } = await this.extractText();
			if (!text.trim()) {
				this.setStatus('未能提取到文字（可换引擎重试）');
				new Notice('未能提取到文字');
				return;
			}
			await navigator.clipboard.writeText(text);
			this.setStatus(`已复制 ${text.length} 字（来源：${source}）`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.setStatus(`提取失败：${msg}`);
		} finally {
			this.extracting = false;
		}
	}

	/** 按当前通道提取文字。返回文本与来源标签。 */
	private async extractText(): Promise<{ text: string; source: string }> {
		const localAllowed = this.plugin.settings.ocrEnabled === true;
		// auto 通道文本层缺位时的回退引擎：本地 OCR 停用 → 一律走视觉模型
		const fallback: 'local' | 'vision' =
			!localAllowed || this.plugin.settings.snapOcrEngine === 'vision' ? 'vision' : 'local';

		if (this.channel === 'local') {
			if (!localAllowed) throw new Error('本地 OCR 已在设置中停用');
			return { text: await this.ocrText(), source: '本地 OCR' };
		}
		if (this.channel === 'vision') return { text: await this.visionText(), source: '视觉模型' };

		// auto：文本层优先（非空即用），缺位时落默认引擎
		const layered = await extractTextInRect(this.viewer, this.region);
		if (layered.trim()) return { text: layered, source: 'PDF 文本层' };
		if (fallback === 'vision') return { text: await this.visionText(), source: '视觉模型' };
		return { text: await this.ocrText(), source: '本地 OCR' };
	}

	private async ocrText(): Promise<string> {
		this.setStatus('本地 OCR 识别中…');
		return this.plugin.ocr.recognize(this.image.dataUrl, (ratio, status) => {
			this.setStatus(`${status}… ${Math.round(ratio * 100)}%`);
		});
	}

	/** 视觉模型提取：复用 AI 四通道传输，仅当用户配置了视觉端点。 */
	private async visionText(): Promise<string> {
		const s = this.plugin.settings;
		if (!s.visionBaseUrl || !s.visionApiKey) {
			throw new Error('请先在设置 → 截图与 OCR 中配置视觉模型');
		}
		this.setStatus('视觉模型提取中…');
		return new Promise<string>((resolve, reject) => {
			let acc = '';
			const aiService = new AIService(this.plugin);
			void aiService.streamChat(
				[
					{
						role: 'user',
						content: [
							{ type: 'text', text: '请逐字提取图片中的全部文字，只输出文字本身，不要解释。' },
							{ type: 'image_url', image_url: { url: this.image.dataUrl } },
						],
					},
				] as any,
				(chunk: string) => {
					acc += chunk;
				},
				() => resolve(acc.trim()),
				(msg: string) => reject(new Error(msg)),
				undefined,
				{ vision: true }
			);
		});
	}

	private askAI(): void {
		new AIChatPanel(this.plugin, '', 'image', this.image.dataUrl).open();
		this.close();
	}

	private async saveToVault(): Promise<void> {
		try {
			const blob = await (await fetch(this.image.dataUrl)).blob();
			const buf = await blob.arrayBuffer();
			// 统一归档到 vault 根目录 FleurPDF/（与其他 Fleur 系列文件夹对齐），不存在则创建
			const app = this.plugin.app;
			const dir = 'FleurPDF';
			const existing = app.vault.getAbstractFileByPath(dir);
			if (!existing) {
				await app.vault.createFolder(dir);
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`vault 中已存在同名文件 ${dir}，无法创建文件夹`);
			}
			const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
			let path = normalizePath(`${dir}/FleurPDF 截图 ${stamp}.png`);
			// 同一秒内多次保存时避免覆盖
			for (let i = 2; app.vault.getAbstractFileByPath(path); i++) {
				path = normalizePath(`${dir}/FleurPDF 截图 ${stamp}-${i}.png`);
			}
			await app.vault.createBinary(path, buf);
			new Notice(`已保存：${path}`);
		} catch (err) {
			new Notice(`保存失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/* ------------------------------ 桌面拖拽 ------------------------------ */

	private onDragStart(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (target.closest('button')) return;
		const panel = this.panelEl;
		if (!panel) return;
		const rect = panel.getBoundingClientRect();
		const ox = e.clientX - rect.left;
		const oy = e.clientY - rect.top;
		const move = (ev: MouseEvent) => {
			panel.setCssStyles({
				left: `${Math.max(0, ev.clientX - ox)}px`,
				top: `${Math.max(0, ev.clientY - oy)}px`,
			});
		};
		const up = () => {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}
}

/** 便捷入口：渲染区域并打开面板（渲染失败给 Notice）。 */
export async function openSnapResult(
	plugin: FleurPDFPlugin,
	viewer: any,
	page: number,
	rect: SnapRect
): Promise<void> {
	const region: SnapRegion = { page, ...rect };
	new Notice('渲染截图中…', 1500);
	const image = await renderSnapRegion(viewer, region);
	if (!image) {
		new Notice('截图失败：页面尚未渲染完成，请稍后重试');
		return;
	}
	new SnapResultPanel(plugin, region, image, viewer).open();
}
