// 文本批注的跨设备同步（annCrossDeviceSync 开关，默认关）。
//
// 与手写笔迹同步（mobile/ink-sync.ts）同构：vault 内**非隐藏**文件作交换介质，
// read-merge-write 全量合并，删除走持久化墓碑防复活。为什么需要这个模块 ——
// 批注的 sidecar 一直在 .obsidian/plugins/fleur-pdf/data/（配置目录），
// Remotely Save 默认不同步配置目录 ⇒ 桌面端做的批注永远到不了平板
// （手写笔迹有 FleurPDF/data/ink/ 副本，所以「线在、批注不在」）。
//
// 合并语义（按批注/AI 结果 id，规则与 ink-sync 一致）：
//   · 同 id 编辑冲突 → updatedAt 后写者胜；双方都缺 updatedAt（历史数据）→ 本端胜；
//   · 仅对端有 → 收编，除非墓碑时刻 ≥ 该条时刻（删后不复活）；
//   · 本端仍有的条目被对端删除（墓碑更新）→ 跟随删除；
//   · 墓碑并集保留（不 GC，量极小：每条是 id → 毫秒时间戳）；
//   · 「删后又在别处重新标注」→ 新时刻晚于墓碑，自然存活。
//
// 同步副本只落在用户自己的 vault（随 Remotely Save / iCloud 走），无任何网络出站。

import type { App } from 'obsidian';
import type { Annotation, AIResult, PDFAnnotationData } from './types';

/** vault 内同步副本目录（非隐藏，随 Remotely Save / iCloud 等跨设备）。 */
export const ANN_SYNC_DIR = 'FleurPDF/data/annotations';

/** 同步文件结构（每本 PDF 一份）。 */
export interface AnnSyncFile {
	version: 1;
	/** 对应的 PDF 在 vault 内的相对路径（回查 PDF 用 / 人工核对 / 排障）。 */
	file: string;
	updatedAt: string;
	annotations: Annotation[];
	aiResults?: AIResult[];
	/** 删除墓碑：批注/AI 结果 id → 删除时刻 ms。 */
	tombstones: Record<string, number>;
}

/** 路径 → 稳定短哈希（djb2，与 ink-store 的 shortHash 同款；复制以保持模块独立）。 */
function pathHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** 该 PDF 的同步副本文件名：可读基名 + 路径哈希，同名不同路径不冲突。 */
export function annSyncFileName(pdfPath: string): string {
	const base = pdfPath.split('/').pop() ?? 'unknown';
	const safe = base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
	return `${safe}.${pathHash(pdfPath)}.json`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 条目的「内容时刻」：编辑时刻优先，回退创建时刻。 */
function stampOf(it: { updatedAt?: number; createdAt?: number }): number {
	return it.updatedAt ?? it.createdAt ?? 0;
}

/** 判断时间戳字段是否有效（历史数据可能是 undefined / NaN）。 */
function validTs(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 纯合并函数：本端数据 ↔ 同步副本内容 → 合并后的本端数据。
 * 不做任何 IO；changed 表示本端数据是否被改变（调用方据此决定是否写回本地）。
 */
export function mergeAnnotationData(
	local: PDFAnnotationData,
	remote: AnnSyncFile | null,
): { data: PDFAnnotationData; changed: boolean } {
	// ── 墓碑并集（同 id 保留更晚时刻）──
	const tomb: Record<string, number> = {};
	const remoteTomb = remote?.tombstones;
	if (isRecord(remoteTomb)) {
		for (const [id, ts] of Object.entries(remoteTomb)) {
			if (validTs(ts)) tomb[id] = ts;
		}
	}
	if (isRecord(local.tombstones)) {
		for (const [id, ts] of Object.entries(local.tombstones)) {
			if (!validTs(ts)) continue;
			if (!tomb[id] || ts > tomb[id]) tomb[id] = ts;
		}
	}

	/** 按 id 合并一组条目：远端打底、本端覆盖；同 id 编辑冲突按 updatedAt 后写者胜 */
	function mergeById<T extends { id: string; createdAt?: number; updatedAt?: number }>(
		localItems: T[] | undefined,
		remoteItems: T[] | undefined,
	): T[] {
		const byId = new Map<string, T>();
		for (const it of Array.isArray(remoteItems) ? remoteItems : []) {
			if (it && typeof it.id === 'string') byId.set(it.id, it);
		}
		for (const it of Array.isArray(localItems) ? localItems : []) {
			if (!it || typeof it.id !== 'string') continue;
			const cur = byId.get(it.id);
			if (!cur) { byId.set(it.id, it); continue; }
			// 同 id：双方都有 updatedAt → 后写者胜；任一方缺 → 本端胜（历史数据兜底）
			const lt = validTs(it.updatedAt) ? it.updatedAt : -1;
			const rt = validTs(cur.updatedAt) ? cur.updatedAt : -1;
			if (lt >= 0 && rt >= 0 && rt > lt) continue; // 远端更晚，保留远端
			byId.set(it.id, it);
		}
		// 应用墓碑：墓碑时刻 ≥ 条目时刻 → 已删（时刻缺省视为 0，必被删）
		const out: T[] = [];
		for (const it of byId.values()) {
			const t = tomb[it.id];
			if (t !== undefined && t >= stampOf(it)) continue;
			out.push(it);
		}
		out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
		return out;
	}

	const annotations = mergeById<Annotation>(local.annotations, remote?.annotations);
	const aiResults = mergeById<AIResult>(local.aiResults, remote?.aiResults);

	const data: PDFAnnotationData = {
		...local,
		annotations,
		aiResults,
		tombstones: tomb,
	};

	// 内容级比较（而非引用级）：远端与本端本就来自不同 JSON.parse，
	// 引用必不相同；内容相同就不算变化，避免每轮 read-merge-write 自己制造同步风暴
	const changed =
		JSON.stringify([annotations, aiResults, tomb]) !==
		JSON.stringify([local.annotations ?? [], local.aiResults ?? [], local.tombstones ?? {}]);

	return { data, changed };
}

/**
 * 文本批注跨设备同步服务。本机运行时真相仍是 store（.obsidian/.../data/*.json），
 * 本类只维护 vault 内同步副本；开关关闭时全部方法原样返回（零行为差异）。
 */
export class AnnotationSync {
	constructor(
		private app: App,
		private isEnabled: () => boolean,
	) {}

	private filePathFor(pdfPath: string): string {
		return `${ANN_SYNC_DIR}/${annSyncFileName(pdfPath)}`;
	}

	/** 该路径是否是本模块的同步副本文件（vault 事件过滤用）。 */
	isSyncFile(path: string): boolean {
		return path.startsWith(`${ANN_SYNC_DIR}/`) && path.endsWith('.json');
	}

	/** 从同步副本文件读出对应 PDF 的 vault 路径（事件回查用）；读不出 → null。 */
	async pdfPathOfSyncFile(syncFilePath: string): Promise<string | null> {
		const remote = await this.readSyncFile(syncFilePath);
		return remote?.file || null;
	}

	private async readSyncFile(path: string): Promise<AnnSyncFile | null> {
		try {
			const raw = await this.app.vault.adapter.read(path);
			if (!raw) return null;
			const v = JSON.parse(raw) as AnnSyncFile;
			if (!v || typeof v !== 'object' || v.version !== 1) return null;
			return v;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!/ENOENT|no such file|not exist|404/i.test(msg)) {
				console.warn('[FleurPDF ann-sync] 同步副本解析失败，将按空处理', path, e);
			}
			return null;
		}
	}

	private syncPayload(pdfPath: string, data: PDFAnnotationData): AnnSyncFile {
		return {
			version: 1,
			file: pdfPath,
			updatedAt: new Date().toISOString(),
			annotations: data.annotations,
			aiResults: data.aiResults,
			tombstones: data.tombstones ?? {},
		};
	}

	private async writeSyncFile(path: string, data: AnnSyncFile): Promise<void> {
		try {
			const dir = path.slice(0, path.lastIndexOf('/'));
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(path, JSON.stringify(data));
		} catch (e) {
			console.warn('[FleurPDF ann-sync] 同步副本写入失败（不影响本地批注）', path, e);
		}
	}

	/**
	 * 拉取合并：同步副本 → 本端 store 数据。
	 * changed 时把合并结果同时写回本地（saveRaw 防回环）与同步副本；
	 * 本端有数据而副本缺失时（首次开启 / 新设备）推写副本完成引导。
	 * 返回调用方应使用的（可能已合并的）数据。
	 */
	async pullMerge(
		pdfPath: string,
		store: { load: (p: string) => Promise<PDFAnnotationData>; saveRaw: (data: PDFAnnotationData) => Promise<void> },
		local?: PDFAnnotationData,
	): Promise<PDFAnnotationData> {
		if (!this.isEnabled()) return local ?? await store.load(pdfPath);
		const cur = local ?? await store.load(pdfPath);
		const path = this.filePathFor(pdfPath);
		const remote = await this.readSyncFile(path);
		const { data, changed } = mergeAnnotationData(cur, remote);
		if (changed || (!remote && (data.annotations.length > 0 || (data.aiResults?.length ?? 0) > 0))) {
			if (changed) await store.saveRaw(data); // 本端采用合并结果（不触发推写，防回环）
			await this.writeSyncFile(path, this.syncPayload(pdfPath, data));
		}
		return data;
	}

	/**
	 * 推写：本端数据 → 同步副本（store.save 的挂钩调用）。read-merge-write，
	 * 对端新增/删除在本轮一并收编进副本；只写副本不动本地 store（本地刚写完）。
	 */
	async pushSyncFile(pdfPath: string, local: PDFAnnotationData): Promise<void> {
		if (!this.isEnabled()) return;
		const path = this.filePathFor(pdfPath);
		const remote = await this.readSyncFile(path);
		const { data } = mergeAnnotationData(local, remote);
		await this.writeSyncFile(path, this.syncPayload(pdfPath, data));
	}
}


