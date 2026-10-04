import { Modal, Notice, Setting, TextAreaComponent, TextComponent } from 'obsidian';
import type FleurPDFPlugin from './main';
import type { WordbookItem } from './settings';

/**
 * 独立生词本管理（设置页「独立生词本 → 管理」打开）。
 * （移植自 fleur-epub 同名模块，样式前缀 fleur-epub-wb → fleur-pdf-wb）
 * 设计约束：设置页零增量（只多一个按钮）；本 Modal 收放自如，词多不爆面板。
 * 功能：搜索（词/释义）、行内编辑（词/音标/释义）、删除、导出 CSV、清空（二次确认）、
 *      分段渲染（每 100 条 + 显示更多，不引第三方虚拟滚动，保持零依赖）。
 * 所有变更落词后广播 'fleur-pdf:wordbook-changed'。
 */

const CHUNK_SIZE = 100;

export class WordbookManagerModal extends Modal {
	private query = '';
	private shownCount = CHUNK_SIZE;

	constructor(private plugin: FleurPDFPlugin) {
		super(plugin.app);
	}

	override onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass('fleur-pdf-wb-manager');
		this.titleEl.setText(`独立生词本（${this.plugin.settings.wordbook.length} 词）`);
		this.render();
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private filtered(): WordbookItem[] {
		const q = this.query.trim().toLowerCase();
		const list = [...this.plugin.settings.wordbook].reverse(); // 最新在前
		if (!q) return list;
		return list.filter((w) => w.word.includes(q) || w.meaning.toLowerCase().includes(q));
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		// ── 搜索 ──
		new Setting(contentEl).setName('搜索').setClass('fleur-pdf-wb-search').addText((t) => {
			t.setPlaceholder('按单词或释义过滤…').setValue(this.query).onChange((v) => {
				this.query = v;
				this.shownCount = CHUNK_SIZE;
				this.render();
				// 重渲染后保持焦点回搜索框
				const input = contentEl.querySelector<HTMLInputElement>('.fleur-pdf-wb-search input');
				if (input) {
					input.focus();
					const len = input.value.length;
					input.setSelectionRange(len, len);
				}
			});
		});

		// ── 列表 ──
		const list = this.filtered();
		const listEl = contentEl.createDiv('fleur-pdf-wb-list');
		if (list.length === 0) {
			listEl.createDiv('fleur-pdf-wb-empty').setText(this.query ? '没有匹配的词条' : '生词本为空：在 PDF 里查词后点「＋ 加入生词本」即可收藏');
		} else {
			for (const item of list.slice(0, this.shownCount)) {
				this.renderRow(listEl, item);
			}
			if (list.length > this.shownCount) {
				const more = listEl.createDiv('fleur-pdf-wb-more');
				more.setText(`显示更多（还有 ${list.length - this.shownCount} 条）`);
				more.onClickEvent(() => {
					this.shownCount += CHUNK_SIZE;
					this.render();
					const input = contentEl.querySelector<HTMLInputElement>('.fleur-pdf-wb-search input');
					if (input) input.focus();
				});
			}
		}

		// ── 底部操作 ──
		if (this.plugin.settings.wordbook.length > 0) {
			new Setting(contentEl).setClass('fleur-pdf-wb-footer')
				.addButton((b) =>
					b.setIcon('download').setTooltip('导出 CSV（词，音标，释义，加入时间）').onClick(() => void this.exportCsv()),
				)
				.addButton((b) =>
					b.setIcon('trash-2').setTooltip('清空生词本').onClick(() => new ConfirmClearModal(this.plugin, () => {
						void this.plugin.clearWordbook().then(() => this.refresh());
					}).open()),
				);
		}
	}

	private renderRow(listEl: HTMLElement, item: WordbookItem): void {
		const row = listEl.createDiv('fleur-pdf-wb-row');
		const main = row.createDiv('fleur-pdf-wb-main');
		const head = main.createDiv('fleur-pdf-wb-head');
		head.createSpan('fleur-pdf-wb-word').setText(item.word);
		if (item.phonetic) head.createSpan('fleur-pdf-wb-phonetic').setText(item.phonetic);
		const meaningText = item.meaning || '（无释义，可点编辑补全）';
		main.createDiv('fleur-pdf-wb-meaning').setText(meaningText);

		const actions = row.createDiv('fleur-pdf-wb-actions');
		const editBtn = actions.createSpan('fleur-pdf-wb-icon');
		editBtn.setText('✎');
		editBtn.setAttribute('aria-label', '编辑');
		editBtn.onClickEvent(() => new WordbookEditModal(this.plugin, item, () => this.refresh()).open());

		const delBtn = actions.createSpan('fleur-pdf-wb-icon fleur-pdf-wb-del');
		delBtn.setText('🗑');
		delBtn.setAttribute('aria-label', '删除');
		delBtn.onClickEvent(() => {
			void this.plugin.removeWordbookEntry(item.word).then(() => this.refresh());
		});
	}

	/** 变更后刷新词数标题与列表 */
	private refresh(): void {
		this.titleEl.setText(`独立生词本（${this.plugin.settings.wordbook.length} 词）`);
		this.render();
	}

	private async exportCsv(): Promise<void> {
		const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
		const lines = ['word,phonetic,meaning,addedAt'];
		for (const w of this.plugin.settings.wordbook) {
			lines.push([esc(w.word), esc(w.phonetic), esc(w.meaning), w.addedAt].join(','));
		}
		const name = `fleur-pdf-wordbook-${new Date().toISOString().slice(0, 10)}.csv`;
		try {
			await this.plugin.app.vault.adapter.write(name, '\uFEFF' + lines.join('\n'));
			new Notice(`已导出到 vault 根目录：${name}`, 4000);
		} catch (e) {
			new Notice(`导出失败：${e instanceof Error ? e.message : String(e)}`, 4000);
		}
	}
}

/** 行内编辑：词 / 音标 / 释义 三字段（对齐 FleurDict EditEntryModal 语义） */
class WordbookEditModal extends Modal {
	constructor(
		private plugin: FleurPDFPlugin,
		private item: WordbookItem,
		private onSaved: () => void,
	) {
		super(plugin.app);
	}

	override onOpen(): void {
		this.contentEl.addClass('fleur-pdf-wb-edit');
		this.titleEl.setText('编辑词条');

		let word = this.item.word;
		let phonetic = this.item.phonetic;
		let meaning = this.item.meaning;

		new Setting(this.contentEl).setName('单词').addText((t: TextComponent) =>
			t.setValue(word).onChange((v) => (word = v.trim().toLowerCase())),
		);
		new Setting(this.contentEl).setName('音标').addText((t) => t.setValue(phonetic).onChange((v) => (phonetic = v.trim())));
		new Setting(this.contentEl).setName('释义').addTextArea((t: TextAreaComponent) => {
			t.setValue(meaning).onChange((v) => (meaning = v.trim()));
			t.inputEl.rows = 4;
			t.inputEl.addClass('fleur-pdf-wb-edit-meaning');
		});

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setCta()
					.setButtonText('保存')
					.onClick(() => {
						if (!word) {
							new Notice('单词不能为空', 2000);
							return;
						}
						void this.plugin.updateWordbookEntry(this.item.word, { word, phonetic, meaning }).then(() => {
							this.close();
							this.onSaved();
						});
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** 清空二次确认（唯一需要确认的破坏性操作） */
class ConfirmClearModal extends Modal {
	constructor(
		private plugin: FleurPDFPlugin,
		private onConfirm: () => void,
	) {
		super(plugin.app);
	}

	override onOpen(): void {
		this.contentEl.addClass('fleur-pdf-wb-confirm');
		this.contentEl.createEl('p', {
			text: `⚠️ 将清空独立生词本全部 ${this.plugin.settings.wordbook.length} 个词条，不可恢复。确定继续？`,
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText('清空')
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
