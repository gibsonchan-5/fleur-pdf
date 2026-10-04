// 手写笔迹的跨设备同步（inkCrossDeviceSync 开关，默认关）。
//
// 与生词本同步（wordbook-sync.ts）同构：vault 内**非隐藏**文件作交换介质，
// read-merge-write 全量合并，删除走墓碑防复活。区别于 sidecar 的点：
//   · sidecar（.fleur-pdf/ink/）点开头 —— Remotely Save 默认跳过隐藏目录，
//     iCloud 虽全量同步但用户不可见、不可核对；
//   · 同步副本放 `FleurPDF/data/ink/`（与 wordbook.json 同一非隐藏根目录），
//     文件名与 sidecar 1:1 对应（inkDataFileName），每本有手写批注的 PDF 一份。
//
// 合并语义（按笔迹 id）：
//   · 同 id 冲突 → 本端胜（正在书写的设备是活跃真相）；
//   · 仅对端有的笔迹 → 收编，除非墓碑时刻 ≥ 笔迹时刻 t（删后不复活）；
//   · 本端仍有的笔迹若被对端删除（墓碑更新）→ 跟随删除（t 更晚则存活，
//     即「删后又在别处移动/重画」的情形）；
//   · 墓碑并集保留（不 GC，量极小：每条是 id → 毫秒时间戳）。
// data.json / sidecar 仍是本机运行时真相，关闭开关即回原行为，vault 文件保留不动。

import { App, TFile } from 'obsidian';
import { compactStroke, type InkStroke } from './ink/strokes';
import { inkDataFileName, sanitizeStrokes, sanitizeTombstones } from './ink-store';

/** vault 内同步副本目录（非隐藏，随 Remotely Save / iCloud 等跨设备）。 */
export const INK_SYNC_DIR = 'FleurPDF/data/ink';

/** 同步文件结构（每本 PDF 一份，文件名与 sidecar 相同）。 */
interface InkSyncFile {
	version: 1;
	/** 对应的 PDF 在 vault 内的相对路径（人工核对 / 排障用）。 */
	file: string;
	updatedAt: string;
	strokes: InkStroke[];
	claimedIds: string[];
	/** 删除墓碑：笔迹 id → 删除时刻 ms。 */
	tombstones: Record<string, number>;
}

/** 一次合并的输入：本端当前状态。 */
export interface InkLocalState {
	strokes: InkStroke[];
	claimedIds: Set<string>;
	/** 本端墓碑（增删改后由 InkUI 维护并随 sidecar 持久化）。 */
	deleted: Record<string, number>;
}

/** 一次合并的输出：合并后的本端应采用的状态。 */
export interface InkMergedState {
	strokes: InkStroke[];
	claimedIds: string[];
	deleted: Record<string, number>;
	/** 本端状态是否被合并改变（调用方据此决定是否重绘 / 重写 sidecar）。 */
	changed: boolean;
}

export class InkSync {
	constructor(private app: App, private isEnabled: () => boolean) {}

	private filePathFor(file: TFile): string {
		return `${INK_SYNC_DIR}/${inkDataFileName(file)}`;
	}

	/** 读同步文件。missing → null（常态）；解析失败 → null（随后写入会覆盖）。 */
	private async readFile(path: string): Promise<InkSyncFile | null> {
		try {
			const raw = await this.app.vault.adapter.read(path);
			if (!raw) return null;
			const v = JSON.parse(raw) as InkSyncFile;
			if (!v || typeof v !== 'object' || v.version !== 1) return null;
			return {
				version: 1,
				file: String(v.file ?? ''),
				updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
				strokes: sanitizeStrokes(v.strokes),
				claimedIds: Array.isArray(v.claimedIds)
					? v.claimedIds.filter((x): x is string => typeof x === 'string')
					: [],
				tombstones: sanitizeTombstones(v.tombstones),
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!/ENOENT|no such file|not exist|404/i.test(msg)) {
				console.warn('[FleurPDF Ink] 手写同步文件解析失败，将按空处理', path, e);
			}
			return null;
		}
	}

	private async writeFile(path: string, data: InkSyncFile): Promise<void> {
		try {
			const dir = path.slice(0, path.lastIndexOf('/'));
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			// 紧凑 JSON：笔迹点列体积大，缩进美化会让文件膨胀数倍
			await adapter.write(path, JSON.stringify(data));
		} catch (e) {
			console.warn('[FleurPDF Ink] 手写同步文件写入失败', path, e);
		}
	}

	/**
	 * 全量 read-merge-write：同步文件 ↔ 本端状态双向合并。
	 *
	 * 始终写回同步文件（本端可能是新增方）；本端状态被改变时由调用方决定
	 * 是否重绘 / 重写 sidecar。开关关闭时原样返回（changed = false）。
	 */
	async merge(file: TFile, local: InkLocalState): Promise<InkMergedState> {
		if (!this.isEnabled()) {
			return { strokes: local.strokes, claimedIds: Array.from(local.claimedIds), deleted: local.deleted, changed: false };
		}
		const path = this.filePathFor(file);
		const remote = await this.readFile(path);

		// ── 墓碑并集（同 id 保留更晚时刻）──
		const tomb: Record<string, number> = { ...(remote?.tombstones ?? {}) };
		for (const [id, ts] of Object.entries(local.deleted)) {
			if (!tomb[id] || ts > tomb[id]) tomb[id] = ts;
		}

		// ── 笔迹合并：对端打底、本端覆盖（同 id 本端胜）──
		const byId = new Map<string, InkStroke>();
		for (const s of remote?.strokes ?? []) byId.set(s.id, s);
		for (const s of local.strokes) byId.set(s.id, s);

		// ── 应用墓碑：墓碑时刻 ≥ 笔迹时刻 → 已删（t 缺省视为 0，必被删）──
		const merged: InkStroke[] = [];
		for (const s of byId.values()) {
			const t = tomb[s.id];
			if (t !== undefined && t >= (s.t ?? 0)) continue;
			merged.push(s);
		}
		merged.sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || a.id.localeCompare(b.id));

		// ── claimedIds 并集（防固有注释复活）──
		const claimed = new Set<string>([...(remote?.claimedIds ?? []), ...local.claimedIds]);

		// ── 本端墓碑同步并集（对端删了、本端还没有的墓碑要补记，否则下轮又复活）──
		const deleted: Record<string, number> = { ...local.deleted };
		for (const [id, ts] of Object.entries(tomb)) deleted[id] = ts;

		// ── 变化判定（id + t + 点列长度足够敏感；写回是幂等的，宁可多写一次）──
		const changed =
			merged.length !== local.strokes.length ||
			claimed.size !== local.claimedIds.size ||
			Object.keys(tomb).length !== Object.keys(local.deleted).length ||
			merged.some((s, i) => local.strokes[i]?.id !== s.id);

		const payload: InkSyncFile = {
			version: 1,
			file: file.path,
			updatedAt: new Date().toISOString(),
			strokes: merged.map(compactStroke),
			claimedIds: Array.from(claimed),
			tombstones: tomb,
		};
		await this.writeFile(path, payload);

		return { strokes: merged, claimedIds: Array.from(claimed), deleted, changed };
	}
}
