import { App, Plugin, TAbstractFile } from 'obsidian';
import type { WordbookItem } from './settings';

/** 稳定 JSON 序列化（键排序），用于合并前后的内容比对（fleur-pdf store.ts 未导出同名函数，此处内联） */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	const o = value as Record<string, unknown>;
	return '{' + Object.keys(o).sort()
		.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
		.join(',') + '}';
}

/** Vault 内同步文件结构（wordbook.json）。
 *  tombstones：删除墓碑（word → 删除时刻 ISO）。合并时墓碑时间晚于词条 addedAt
 *  则词条视为已删；若词条 addedAt 晚于墓碑（删后又加），词条存活、墓碑保留——
 *  它仍能杀掉其他设备上 addedAt 更早的旧副本。墓碑不 GC（量极小）。 */
interface WordbookSyncFile {
	version: 1;
	updatedAt: string;
	entries: WordbookItem[];
	tombstones: Record<string, string>;
}

/** 本端删除 / 改名 / 清空时提交的墓碑 */
export interface WordbookTombstone {
	word: string;
	/** 被删词条的 addedAt（用于删后重加的先后判定） */
	deletedAt: string;
}

const FILE_NAME = 'wordbook.json';
/** vault 内固定目录：与 fleur-pdf 批注数据解耦，随同步插件跨设备 */
const DATA_DIR = 'FleurPDF/data';
/** 同步工具落盘常触发多次 modify：去抖后再合并 */
const MODIFY_DEBOUNCE_MS = 800;

/** 本插件的结构化最小视图（避免与基类 Plugin.settings: unknown 撞名，也避免循环导入） */
interface WordbookHost extends Plugin {
	settings: { wordbook: WordbookItem[]; wordbookSync?: boolean };
	saveSettings(): Promise<void>;
}

/**
 * 独立生词本跨设备同步（wordbookSync 开关，默认关）。
 * 数据落在 Vault 内 `FleurPDF/data/wordbook.json`（随同步插件跨设备）。
 * 核心是 read-merge-write 全量合并：词条按 word 去重、早 addedAt 胜、空释义用
 * 对端非空补齐；删除走墓碑。data.json 仍是本机运行时数据，关闭开关即回原行为，
 * vault 文件保留不动。（机制与 fleur-epub 0.2.44 同构，目录独立互不干扰）
 */
export class WordbookSync {
	/** 自写内容指纹：modify 事件区分「自己写的」与「另一端同步来的」 */
	private lastWrittenRaw = '';
	private modifyTimer: number | null = null;
	private syncing = false;

	constructor(
		private app: App,
		private plugin: WordbookHost,
	) {}

	enabled(): boolean {
		return this.plugin.settings?.wordbookSync === true;
	}

	private filePath(): string {
		return `${DATA_DIR}/${FILE_NAME}`;
	}

	/** 插件 onload 调用：注册 vault modify 监听 + 启动合并（开关关闭时全部跳过） */
	init(): void {
		// vault modify 事件：另一端同步下来的文件改动 → 去抖后重新合并
		this.plugin.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (!this.enabled() || file.path !== this.filePath()) return;
				if (this.modifyTimer !== null) window.clearTimeout(this.modifyTimer);
				this.modifyTimer = window.setTimeout(() => {
					this.modifyTimer = null;
					void this.pullAndMerge('modify');
				}, MODIFY_DEBOUNCE_MS);
			}),
		);
		if (this.enabled()) void this.pullAndMerge('startup');
	}

	/** 读 vault 文件。missing → null（常态）；解析失败 → null（留 warning，随后写入会覆盖） */
	private async readFile(): Promise<WordbookSyncFile | null> {
		try {
			const raw = await this.app.vault.adapter.read(this.filePath());
			if (!raw) return null;
			const v = JSON.parse(raw) as WordbookSyncFile;
			if (!v || typeof v !== 'object' || !Array.isArray(v.entries)) return null;
			return {
				version: 1,
				updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
				entries: v.entries.filter((e) => e && typeof e.word === 'string'),
				tombstones: v.tombstones && typeof v.tombstones === 'object' ? v.tombstones : {},
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!/ENOENT|no such file|not exist|404/i.test(msg)) {
				console.warn('[FleurPDF] 生词本同步文件解析失败，将按空处理', this.filePath(), e);
			}
			return null;
		}
	}

	private async writeFile(data: WordbookSyncFile): Promise<void> {
		const path = this.filePath();
		try {
			const dir = path.slice(0, path.lastIndexOf('/'));
			const adapter = this.app.vault.adapter;
			if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
			const raw = JSON.stringify(data, null, '\t');
			await adapter.write(path, raw);
			this.lastWrittenRaw = raw;
		} catch (e) {
			console.warn('[FleurPDF] 生词本同步文件写入失败', path, e);
		}
	}

	/**
	 * 全量 read-merge-write：vault 文件 ↔ settings.wordbook 双向合并。
	 * - 词条：按 word 去重；addedAt 早者胜；胜者 meaning/phonetic 为空时用败者非空值补齐；
	 *   context 取胜者的（缺失回退败者）。
	 * - 墓碑：文件侧与本端新增 deletions 取并（同词保留更晚时刻）；词条 addedAt ≤ 墓碑
	 *   时刻则剔除，否则视为「删后重加」保留。
	 * 返回本机 settings.wordbook 是否被改动（调用方据此 saveSettings + 广播）。
	 */
	async pullAndMerge(reason: 'startup' | 'modify' | 'local-change', deletions?: WordbookTombstone[]): Promise<boolean> {
		if (!this.enabled() || this.syncing) return false;
		this.syncing = true;
		try {
			const file = await this.readFile();
			// 自写回声：modify 可能由本插件自己的写入触发，内容一致时直接跳过
			if (reason === 'modify' && file && this.lastWrittenRaw) {
				try {
					const raw = await this.app.vault.adapter.read(this.filePath());
					if (raw === this.lastWrittenRaw) return false;
				} catch {
					/* 读不出来就按正常合并走 */
				}
			}

			// ── 墓碑并集 ──
			const tomb: Record<string, string> = { ...(file?.tombstones ?? {}) };
			for (const d of deletions ?? []) {
				if (!d.word) continue;
				const cur = tomb[d.word];
				if (!cur || d.deletedAt > cur) tomb[d.word] = d.deletedAt;
			}

			// ── 词条合并：文件侧 + 本机侧 ──
			const byWord = new Map<string, WordbookItem>();
			for (const e of file?.entries ?? []) if (e.word) byWord.set(e.word, e);
			for (const e of this.plugin.settings.wordbook) {
				const cur = byWord.get(e.word);
				if (!cur) {
					byWord.set(e.word, e);
					continue;
				}
				const win = (e.addedAt || '') <= (cur.addedAt || '') ? e : cur;
				const other = win === e ? cur : e;
				byWord.set(e.word, {
					...win,
					meaning: win.meaning || other.meaning || '',
					phonetic: win.phonetic || other.phonetic || '',
					context: win.context ?? other.context,
				});
			}

			// ── 应用墓碑 ──
			const merged: WordbookItem[] = [];
			for (const [word, e] of byWord) {
				const t = tomb[word];
				if (t && (e.addedAt || '') <= t) continue;
				merged.push(e);
			}
			merged.sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));

			// ── 写回 ──
			const localJson = canonicalJson(this.plugin.settings.wordbook);
			const mergedJson = canonicalJson(merged);
			const localChanged = localJson !== mergedJson;
			const fileJson = file ? canonicalJson({ entries: file.entries, tombstones: file.tombstones }) : '';
			const mergedForFile: WordbookSyncFile = {
				version: 1,
				updatedAt: new Date().toISOString(),
				entries: merged,
				tombstones: tomb,
			};
			const fileChanged = !file || fileJson !== canonicalJson({ entries: mergedForFile.entries, tombstones: mergedForFile.tombstones });
			if (localChanged) {
				this.plugin.settings.wordbook = merged;
				await this.plugin.saveSettings();
			}
			if (localChanged || fileChanged || reason === 'local-change') await this.writeFile(mergedForFile);
			return localChanged;
		} finally {
			this.syncing = false;
		}
	}

	/** 本端增/删/改/清空后调用：deletions 为本次产生的墓碑（改名/普通编辑传空数组） */
	async push(deletions: WordbookTombstone[] = []): Promise<void> {
		await this.pullAndMerge('local-change', deletions);
	}
}
