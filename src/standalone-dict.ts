/**
 * 内置独立查词管线（不依赖 FleurDict）：
 * 有道 jsonapi（英汉）+ Free Dictionary API（英释），均免费无 Key，
 * 查询与解析逻辑与 FleurDict 的 online-dict.ts 同构，结果展示用自绘弹窗。
 * （移植自 fleur-epub 同名模块，样式前缀 fleur-epub-dict → fleur-pdf-dict）
 *
 * 分流原则（patcher 工具条）：
 * - FleurDict 在场 → 走桥接（FleurDict 查词窗：AI 详解、生词本全功能）；
 * - FleurDict 不在场 → 走本模块。弹窗交互与 FleurDict 查词窗对齐：
 *   整窗可拖拽、右下角缩放、位置/尺寸记忆、AI 详解、加入生词本（还原式反馈）。
 */

import { requestUrl } from 'obsidian';
import type FleurPDFPlugin from './main';

export interface DictPhonetic {
	text: string;
	audio?: string;
}

export interface DictMeaning {
	partOfSpeech: string;
	definitions: Array<{ definition: string; example?: string | null }>;
}

export interface DictEntry {
	word: string;
	phonetics: DictPhonetic[];
	meanings: DictMeaning[];
}

/** requestUrl 主路径（Electron 无 CORS 顾虑），fetch 兜底 */
async function httpGet(url: string): Promise<{ status: number; json: unknown }> {
	try {
		const resp = await requestUrl({ url, method: 'GET' });
		return { status: resp.status, json: resp.json };
	} catch {
		const resp = await fetch(url);
		return { status: resp.status, json: await resp.json() };
	}
}

const POS_MAP: Record<string, string> = {
	'n.': 'n.',
	'v.': 'v.',
	'vt.': 'vt.',
	'vi.': 'vi.',
	'adj.': 'adj.',
	'adv.': 'adv.',
	'prep.': 'prep.',
	'conj.': 'conj.',
	'pron.': 'pron.',
	'int.': 'int.',
	'interj.': 'int.',
	'det.': 'det.',
	'art.': 'art.',
	'aux.': 'aux.',
};

/** 有道 jsonapi（ec 词典）：中文释义 + 英美音标 + 真人发音 */
async function queryYoudao(word: string): Promise<DictEntry[]> {
	const dictsParam = encodeURIComponent(JSON.stringify({ count: 99, dicts: [['ec']] }));
	const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}&dicts=${dictsParam}`;
	const { json } = await httpGet(url);
	const ec = (json as any)?.ec;
	const wordData = ec?.word?.[0];
	if (!wordData) return [];

	const phonetics: DictPhonetic[] = [];
	if (wordData.ukphone) phonetics.push({ text: `英 ${wordData.ukphone}`, audio: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=1` });
	if (wordData.usphone) phonetics.push({ text: `美 ${wordData.usphone}`, audio: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2` });

	const posMap = new Map<string, DictMeaning>();
	if (Array.isArray(wordData.trs)) {
		for (const trOuter of wordData.trs) {
			const trArray = trOuter?.tr;
			if (!Array.isArray(trArray)) continue;
			for (const trItem of trArray) {
				const l = trItem?.l;
				if (!l) continue;
				const fullDef: string = Array.isArray(l.i) ? l.i.join('') : typeof l.i === 'string' ? l.i : '';
				if (!fullDef) continue;
				const posMatch = fullDef.match(/^([a-z]+\.)\s*(.+)$/i);
				const pos = posMatch ? (POS_MAP[posMatch[1].toLowerCase()] ?? posMatch[1]) : '';
				const definition = posMatch ? posMatch[2] : fullDef;
				if (!posMap.has(pos)) posMap.set(pos, { partOfSpeech: pos, definitions: [] });
				for (const sub of definition.split(/[；;]/).map((s: string) => s.trim()).filter(Boolean)) {
					posMap.get(pos)!.definitions.push({ definition: sub });
				}
			}
		}
	}

	const rp = wordData['return-phrase'];
	const entryWord: string = typeof rp === 'string' ? rp : (rp?.l?.i ? (Array.isArray(rp.l.i) ? rp.l.i.join('') : String(rp.l.i)) : word);
	return [{ word: entryWord, phonetics, meanings: Array.from(posMap.values()) }];
}

/** Free Dictionary API（dictionaryapi.dev）：英文释义 */
async function queryFreeDict(word: string): Promise<DictEntry[]> {
	const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
	const { status, json } = await httpGet(url);
	if (status !== 200 || !Array.isArray(json)) return [];
	return (json as any[]).map((item) => ({
		word: item.word || word,
		phonetics: (item.phonetics || []).map((p: any) => ({ text: p.text || '', audio: p.audio || undefined })).filter((p: DictPhonetic) => p.text || p.audio),
		meanings: (item.meanings || []).map((m: any) => ({
			partOfSpeech: m.partOfSpeech || '',
			definitions: (m.definitions || []).map((d: any) => ({ definition: d.definition || '', example: d.example ?? null })),
		})),
	}));
}

/**
 * 按来源查询；指定来源查不到时以另一来源兜底（与 FleurDict 引擎的回退次序一致）。
 * 返回空数组 = 无结果。
 */
export async function queryDict(word: string, source: 'youdao' | 'free-dict'): Promise<DictEntry[]> {
	const primary = source === 'youdao' ? queryYoudao : queryFreeDict;
	const fallback = source === 'youdao' ? queryFreeDict : queryYoudao;
	try {
		const entries = await primary(word);
		if (entries.length > 0) return entries;
	} catch { /* 落兜底 */ }
	try {
		return await fallback(word);
	} catch {
		return [];
	}
}

/** 弹窗控制回调（与 FleurDict DictPopupOptions 语义对齐） */
export interface StandalonePopupOptions {
	x: number;
	y: number;
	/** 待查词（单词或 ≤4 词短语） */
	word: string;
	source: 'youdao' | 'free-dict';
	/** 点击「✨ AI 详解」；宿主关闭本弹窗并打开 AI 面板 */
	onAIDetail?: () => void;
	/** 点击「+ 加入生词本」；由宿主决定落词去向 */
	onAddToWordbook?: () => void;
	/** 查询完成（含无结果/失败，传 null）；宿主借此复用查询结果（如生词本释义） */
	onQueryResult?: (entry: DictEntry | null) => void;
}

/** 弹窗内不允许触发拖拽的控件（对齐 FleurDict 的 NO_DRAG_SELECTOR） */
const NO_DRAG_SELECTOR = [
	'button', 'a', 'input', 'textarea', 'select',
	'[role="button"]', '[contenteditable="true"]',
	'.fleur-pdf-dict-close', '.fleur-pdf-dict-resize', '.fleur-pdf-dict-play',
].join(', ');

const DRAG_THRESHOLD_PX = 4;
const POPUP_MIN_W = 290;
const POPUP_MIN_H = 220;

/**
 * 内置查词弹窗 — 交互对齐 FleurDict 查词窗：
 * 整窗拖拽、右下角缩放、位置/尺寸记忆（存 plugin.settings.dictPopupRect）、
 * 首次贴选区定位、点外部 / Esc 关闭、AI 详解、加入生词本（2 秒还原式反馈）。
 */
export class StandaloneDictPopup {
	private container: HTMLElement | null = null;
	private overlay: HTMLElement | null = null;
	private audio: HTMLAudioElement | null = null;
	private closed = false;

	constructor(private plugin: FleurPDFPlugin, private opts: StandalonePopupOptions) {}

	async open(): Promise<void> {
		const overlay = document.body.createDiv('fleur-pdf-dict-overlay');
		this.overlay = overlay;

		const container = document.body.createDiv('fleur-pdf-dict-popup');
		this.container = container;
		container.setCssStyles({ left: `${this.opts.x}px`, top: `${this.opts.y}px` });
		// 查询完成、最终定位前保持不可见：否则弹窗先以原始坐标（选区左上角）
		// 可见地挂出，查询返回后才 clampTo 归位 → 肉眼可见地「跳一下」。
		// 与 FleurDict 桥接路径一致（查询完成后一次性落位显示）。
		container.setCssStyles({ visibility: 'hidden' });

		const content = container.createDiv('fleur-pdf-dict-content');

		// ── header：词头 + 关闭（音标待查询结果回来后追加，结构与 FleurDict 一致）──
		const header = content.createDiv('fleur-pdf-dict-header');
		const topRow = header.createDiv('fleur-pdf-dict-header-top');
		topRow.createDiv('fleur-pdf-dict-word').setText(this.opts.word);
		const closeBtn = topRow.createSpan('fleur-pdf-dict-close');
		closeBtn.setText('×');
		closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
		closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

		const body = content.createDiv('fleur-pdf-dict-body');
		body.createDiv('fleur-pdf-dict-loading').setText('查询中…');

		// ── footer：AI 详解 + 加入生词本（与 FleurDict 同布局）──
		const footer = content.createDiv('fleur-pdf-dict-footer');
		if (this.opts.onAIDetail) {
			const aiBtn = footer.createEl('button', { text: '✨ AI 详解', cls: 'fleur-pdf-dict-action-btn fleur-pdf-dict-ai-btn' });
			aiBtn.addEventListener('mousedown', (e) => e.stopPropagation());
			aiBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.opts.onAIDetail?.();
				this.close();
			});
		}
		if (this.opts.onAddToWordbook) {
			const addBtn = footer.createEl('button', { text: '+ 加入生词本', cls: 'fleur-pdf-dict-action-btn fleur-pdf-dict-add-btn' });
			addBtn.addEventListener('mousedown', (e) => e.stopPropagation());
			addBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.opts.onAddToWordbook?.();
				// 还原式反馈（对齐 FleurDict）：2 秒后恢复可点，方便纠误
				addBtn.setText('✓ 已添加');
				addBtn.addClass('fleur-pdf-dict-added');
				setTimeout(() => {
					if (this.closed) return;
					addBtn.setText('+ 加入生词本');
					addBtn.removeClass('fleur-pdf-dict-added');
				}, 2000);
			});
		}

		// ── 定位：有记忆位置则恢复（对齐 FleurDict），否则贴选区 ──
		const rect = this.plugin.settings.dictPopupRect;
		if (rect) {
			container.setCssStyles({ left: `${rect.left}px`, top: `${rect.top}px` });
			if (rect.width > 0) container.setCssStyles({ width: `${rect.width}px` });
			if (rect.height > 0) container.setCssStyles({ height: `${rect.height}px` });
		}

		// ── 查询并渲染（意外异常也必须显示弹窗，不能永远隐形）──
		try {
			const entries = await queryDict(this.opts.word.toLowerCase().trim(), this.opts.source);
			if (this.closed) return;
			this.opts.onQueryResult?.(entries[0] ?? null);
			body.empty();

			if (entries.length === 0) {
				body.createDiv('fleur-pdf-dict-noresult').setText('暂无释义');
			} else {
				this.renderHeaderPhonetics(header, entries[0]);
				this.renderBody(body, entries[0]);
			}

			// ── 记忆位置缺失时贴选区钳制落位；定位完成后一次性显示 ──
			if (!rect) this.clampTo(this.opts.x, this.opts.y);
		} finally {
			if (!this.closed) container.setCssStyles({ visibility: '' });
		}

		this.setupDrag(container);
		this.setupResize(container);

		this.outsideHandler = (e) => {
			if (container.contains(e.target as Node)) return;
			this.close();
		};
		document.addEventListener('mousedown', this.outsideHandler, true);
		this.escHandler = (e) => { if (e.key === 'Escape') this.close(); };
		document.addEventListener('keydown', this.escHandler);
	}

	private outsideHandler: ((e: MouseEvent) => void) | null = null;
	private escHandler: ((e: KeyboardEvent) => void) | null = null;

	/** 音标列：每行 英/美 badge + IPA + 发音喇叭（对齐 FleurDict buildHeader） */
	private renderHeaderPhonetics(header: HTMLElement, entry: DictEntry): void {
		if (entry.phonetics.length === 0) return;
		header.addClass('has-phonetics');
		const col = header.createDiv('fleur-pdf-dict-phonetics-col');
		for (const p of entry.phonetics) {
			if (!p.text && !p.audio) continue;
			const item = col.createDiv('fleur-pdf-dict-phonetic-item');
			if (p.text) {
				const isUK = p.text.startsWith('英');
				item.createSpan('fleur-pdf-dict-phonetic-badge').setText(isUK ? '英' : '美');
				item.createSpan('fleur-pdf-dict-phonetic-ipa').setText(p.text.replace(/^[英美]\s*/, ''));
			}
			if (p.audio) {
				const play = item.createSpan('fleur-pdf-dict-play');
				play.setText('🔊');
				play.setAttribute('role', 'button');
				play.setAttribute('aria-label', isUKLabel(p.text) ? '英式发音' : '美式发音');
				play.addEventListener('mousedown', (e) => e.stopPropagation());
				play.addEventListener('click', (e) => { e.stopPropagation(); this.play(p.audio!); });
			}
		}
	}

	/** 释义主体：词性分组 + 多义项编号列表（对齐 FleurDict buildBody） */
	private renderBody(body: HTMLElement, entry: DictEntry): void {
		for (const m of entry.meanings) {
			const sec = body.createDiv('fleur-pdf-dict-pos-section');
			if (m.partOfSpeech) sec.createDiv('fleur-pdf-dict-pos-label').setText(m.partOfSpeech);

			const defs = m.definitions.slice(0, 10);
			if (defs.length === 0) continue;
			if (defs.length === 1) {
				// 单义项不编号（对齐 FleurDict）
				const item = sec.createDiv('fleur-pdf-dict-def-item');
				item.createSpan('fleur-pdf-dict-def-text').setText(defs[0].definition);
				if (defs[0].example) item.createDiv('fleur-pdf-dict-example').setText(defs[0].example);
			} else {
				const list = sec.createEl('ol', { cls: 'fleur-pdf-dict-def-list' });
				for (const d of defs) {
					const item = list.createEl('li', { cls: 'fleur-pdf-dict-def-item' });
					item.createSpan('fleur-pdf-dict-def-text').setText(d.definition);
					if (d.example) item.createDiv('fleur-pdf-dict-example').setText(d.example);
				}
			}
		}
	}

	/** 首次贴选区定位：弹窗渲染完成后按实际尺寸钳制到视口内（选区下方优先，放不下移上方） */
	private clampTo(x: number, y: number): void {
		const c = this.container;
		if (!c) return;
		const w = c.offsetWidth;
		const h = c.offsetHeight;
		const margin = 16;
		let left = x - w / 2;
		let top = y + 10;
		left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
		if (top + h > window.innerHeight - margin) top = y - h - 10;
		top = Math.max(margin, top);
		c.setCssStyles({ left: `${left}px`, top: `${top}px` });
	}

	/** 整窗拖拽（对齐 FleurDict：控件不触发、4px 阈值、拖完持久化） */
	private setupDrag(container: HTMLElement): void {
		container.addEventListener('mousedown', (e) => {
			if ((e.target as HTMLElement).closest(NO_DRAG_SELECTOR)) return;
			e.preventDefault();
			let dragging = false;
			const startX = e.clientX;
			const startY = e.clientY;
			const startLeft = parseInt(container.style.left || '0', 10);
			const startTop = parseInt(container.style.top || '0', 10);

			const onMove = (ev: MouseEvent) => {
				if (!dragging) {
					const moved = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY);
					if (moved < DRAG_THRESHOLD_PX) return;
					dragging = true;
					document.body.addClass('fleur-pdf-dict-dragging');
				}
				container.setCssStyles({ left: `${startLeft + ev.clientX - startX}px`, top: `${startTop + ev.clientY - startY}px` });
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove);
				document.removeEventListener('mouseup', onUp);
				document.body.removeClass('fleur-pdf-dict-dragging');
				if (dragging) this.saveRect();
			};
			document.addEventListener('mousemove', onMove);
			document.addEventListener('mouseup', onUp);
		});
	}

	/** 右下角缩放手柄（min 290×220，对齐 FleurDict） */
	private setupResize(container: HTMLElement): void {
		const handle = container.createDiv('fleur-pdf-dict-resize');
		handle.addEventListener('mousedown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startY = e.clientY;
			const startW = container.offsetWidth;
			const startH = container.offsetHeight;

			const onMove = (ev: MouseEvent) => {
				const w = Math.max(POPUP_MIN_W, startW + ev.clientX - startX);
				const h = Math.max(POPUP_MIN_H, startH + ev.clientY - startY);
				container.setCssStyles({ width: `${w}px`, height: `${h}px` });
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove);
				document.removeEventListener('mouseup', onUp);
				this.saveRect();
			};
			document.addEventListener('mousemove', onMove);
			document.addEventListener('mouseup', onUp);
		});
	}

	/** 位置/尺寸持久化（仅实际移动/缩放过才写） */
	private saveRect(): void {
		const c = this.container;
		if (!c) return;
		this.plugin.settings.dictPopupRect = {
			left: parseInt(c.style.left || '0', 10),
			top: parseInt(c.style.top || '0', 10),
			width: c.offsetWidth,
			height: c.offsetHeight,
		};
		void this.plugin.saveSettings();
	}

	private play(url: string): void {
		try {
			this.audio?.pause();
			this.audio = new Audio(url);
			void this.audio.play().catch(() => {/* 自动播放被拦截时静默 */ });
		} catch { /* 忽略 */ }
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.outsideHandler) document.removeEventListener('mousedown', this.outsideHandler, true);
		if (this.escHandler) document.removeEventListener('keydown', this.escHandler);
		this.audio?.pause();
		this.container?.remove();
		this.overlay?.remove();
	}
}

function isUKLabel(text: string): boolean {
	return text.startsWith('英');
}
