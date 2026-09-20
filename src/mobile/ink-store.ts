// 手写笔迹的 sidecar 存储（覆盖层自绘架构，0.6.0 起）。
//
// 架构定调（沿袭 0.5 方案 C 并更进一步）：
//   笔迹的**唯一真相源**是这里 —— 插件自己的 JSON，**不是** PDF 文件。
//   与 0.5 的区别：笔迹不再经 pdf.js 编辑器中转，直接以自有模型
//   （PDF 用户空间点列，见 ink/strokes.ts）存储，由覆盖层 canvas 自绘。
//
// 为什么必须这样 —— 0.4.0 → 0.5.1 连续六轮修复都没能根治的真机问题，
// 根因是笔迹活在 **pdf.js 编辑器表**里，而 pdf.js 在移动端会虚拟化页面：
//   · page DOM 被销毁重建 ⇒ 编辑器跟着消失，进视图时恢复一次远远不够；
//   · 擦除依赖编辑器在册 ⇒ 编辑器没了就「擦不掉」；
//   · serialize / deserialize 往返有损 ⇒ 恢复出来的笔迹观感变差。
//
// 覆盖层自绘后这一切消失：canvas 挂在 page DOM 上，页面重建时
// MutationObserver 自动重挂并从**自己的数据**重绘（三个成功插件的共同做法）。
//
// 数据版本：
//   v1 —— 0.5.x：pdf.js 编辑器快照（paths.points 归一化坐标）。仍可读，
//         读到后由调用方迁移成 v2（见 migrateLegacyInk）。
//   v2 —— 0.6.0 起：自有笔迹模型（PDF 用户空间）。

import { App, TFile, normalizePath } from 'obsidian';
import { compactStroke, type InkStroke, type V1InkEntry } from './ink/strokes';

/** 笔迹数据目录（vault 内相对路径）。点开头 → 不进 Obsidian 文件索引。 */
export const INK_DATA_DIR = '.fleur-pdf/ink';

/** 当前数据格式版本。 */
export const INK_DATA_VERSION = 2;

/** v1 sidecar 的形状（只用于迁移读取）。 */
export interface LegacyInkSidecar {
	version: 1;
	file: string;
	updated: number;
	entries: V1InkEntry[];
	claimedIds?: string[];
}

/** v2 sidecar。 */
export interface InkSidecarV2 {
	version: 2;
	/** 对应的 PDF 在 vault 内的相对路径，便于人工核对与排障。 */
	file: string;
	/** 最后写入时间（Unix 毫秒）。 */
	updated: number;
	strokes: InkStroke[];
	/**
	 * 曾经从 PDF 固有注释（0.4.x 写回的 /Ink）接管过来的注释 id 全集（只增不减）。
	 * 原件仍在 PDF 里（我们不写回、不删它），不记这个名单就会在下次进入时
	 * 重新接管 —— 用户的感受就是「擦掉的笔迹又长回来了」。
	 */
	claimedIds: string[];
}

/** load() 的返回：v2 直接可用；v1 需要迁移；null = 没有数据或读不出来。 */
export type LoadedInk =
	| { kind: 'v2'; strokes: InkStroke[]; claimedIds: string[] }
	| { kind: 'v1'; legacy: LegacyInkSidecar }
	| null;

/**
 * 路径 → 稳定短哈希（djb2）。
 * 把可能很长的 vault 相对路径压成定长后缀，避免文件名超长与中文转义问题。
 */
function shortHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

export class InkStore {
	constructor(private app: App) {}

	/** 该 PDF 对应的 sidecar 路径：`<原文件名>.<路径哈希>.json`（保留原名便于肉眼定位）。 */
	pathFor(file: TFile): string {
		const base = file.name
			.replace(/\.pdf$/i, '')
			.replace(/[\\/:*?"<>|]/g, '_')
			.slice(0, 60);
		return normalizePath(`${INK_DATA_DIR}/${base}.${shortHash(file.path)}.json`);
	}

	/** 确保数据目录存在。 */
	private async ensureDir(): Promise<boolean> {
		const adapter = this.app.vault.adapter;
		const dir = normalizePath(INK_DATA_DIR);
		try {
			if (await adapter.exists(dir)) return true;
			await adapter.mkdir(dir);
			return true;
		} catch {
			// 并发创建时 mkdir 可能抛「已存在」，再确认一次即可
			try {
				return await adapter.exists(dir);
			} catch {
				return false;
			}
		}
	}

	/**
	 * 读取该 PDF 的笔迹数据。
	 *
	 * 任何异常（文件不存在 / JSON 损坏 / 版本不认识）都返回 null —— 调用方据此
	 * 走「当作还没有笔迹」的正常路径。这里**不能抛**：它跑在进入手写模式的入口上，
	 * 抛出去会让整个手写模块挂不上。
	 */
	async load(file: TFile): Promise<LoadedInk> {
		const adapter = this.app.vault.adapter;
		const path = this.pathFor(file);
		try {
			if (!(await adapter.exists(path))) return null;
			const raw = await adapter.read(path);
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object') return null;

			if (parsed.version === 2) {
				const strokes = this.sanitizeV2(parsed.strokes);
				const claimedIds = Array.isArray(parsed.claimedIds)
					? parsed.claimedIds.filter((x: unknown): x is string => typeof x === 'string')
					: [];
				return { kind: 'v2', strokes, claimedIds };
			}
			if (parsed.version === 1 && Array.isArray(parsed.entries)) {
				// 逐条过滤结构不完整的项：宁可少几个笔画，也不能让一条坏数据毒化迁移
				const entries = parsed.entries.filter(
					(e: any) => e && typeof e.page === 'number' && e.data && typeof e.data === 'object',
				) as V1InkEntry[];
				const claimedIds = Array.isArray(parsed.claimedIds)
					? parsed.claimedIds.filter((x: unknown): x is string => typeof x === 'string')
					: [];
				return {
					kind: 'v1',
					legacy: { version: 1, file: String(parsed.file ?? file.path), updated: Number(parsed.updated ?? 0), entries, claimedIds },
				};
			}
			return null;
		} catch {
			return null;
		}
	}

	/** v2 笔迹的逐条结构校验：宁缺毋滥，一条坏数据不能拖垮整份文件。 */
	private sanitizeV2(raw: unknown): InkStroke[] {
		if (!Array.isArray(raw)) return [];
		const out: InkStroke[] = [];
		for (const s of raw) {
			if (!s || typeof s !== 'object') continue;
			const { id, page, color, width, opacity, kind, pts } = s as Record<string, unknown>;
			if (typeof id !== 'string' || !id) continue;
			if (typeof page !== 'number' || !(page >= 1)) continue;
			if (typeof color !== 'string') continue;
			if (typeof width !== 'number' || !(width > 0)) continue;
			if (kind !== 'pen' && kind !== 'marker') continue;
			if (!Array.isArray(pts) || pts.length < 6 || pts.length % 3 !== 0) continue;
			if (pts.some((v) => typeof v !== 'number' || !Number.isFinite(v))) continue;
			out.push({
				id,
				page,
				color,
				width,
				opacity: typeof opacity === 'number' && Number.isFinite(opacity) ? Math.max(0.05, Math.min(1, opacity)) : 1,
				kind,
				pts: pts as number[],
			});
		}
		return out;
	}

	/**
	 * 写入笔迹数据（覆盖）。
	 *
	 * 「笔迹全被擦光」时才删文件 —— 判据必须同时看 strokes 与 claimedIds：
	 * 用户把接管来的笔迹全擦了，strokes 会变空，但 PDF 里的原件仍在，
	 * claimedIds 一旦丢掉，下次进入就会把它们全部重新接管回来。
	 */
	async save(file: TFile, strokes: InkStroke[], claimedIds: string[] = []): Promise<void> {
		const claimed = Array.from(new Set(claimedIds));
		if (!strokes.length && !claimed.length) {
			await this.remove(file);
			return;
		}
		if (!(await this.ensureDir())) throw new Error('无法创建笔迹数据目录');
		const payload: InkSidecarV2 = {
			version: INK_DATA_VERSION,
			file: file.path,
			updated: Date.now(),
			strokes: strokes.map(compactStroke),
			claimedIds: claimed,
		};
		await this.app.vault.adapter.write(this.pathFor(file), JSON.stringify(payload));
	}

	/** 删除该 PDF 的笔迹数据（笔迹被全部擦掉时调用）。 */
	async remove(file: TFile): Promise<void> {
		const adapter = this.app.vault.adapter;
		const path = this.pathFor(file);
		try {
			if (await adapter.exists(path)) await adapter.remove(path);
		} catch {
			/* 删不掉不影响使用，下次 save 会覆盖 */
		}
	}
}
