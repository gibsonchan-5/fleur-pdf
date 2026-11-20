// 数据存储层
import { App, normalizePath } from 'obsidian';
import type { Annotation, PDFAnnotationData, AIResult } from './types';

/**
 * 路径 → sidecar 键（64 位：djb2 + FNV-1a 各 32 位，base36 拼接）。
 *
 * 历史实现是 `path.replace(/[^a-zA-Z0-9]/g, '_')`：中文、空格、标点全部塌成
 * `_`，同目录下等长的中文书名会落到同一份 json —— 这是「打开新 PDF，侧栏
 * 批注总览里出现另一本书批注、继续批注还会混在一起」的根因。
 * 换成哈希后键与路径一一对应（64 位撞名在正常 vault 规模下可忽略）。
 */
function stableKey(s: string): string {
  let h1 = 5381; // djb2
  let h2 = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/** 批注 sidecar 文件名（不含 .json）。前置 `ann-` 与便签的 `notes-` 区分。 */
export function annotationKey(pdfPath: string): string {
  return `ann-${stableKey(pdfPath)}`;
}

/** 旧版有损键（仅用于一次性迁移），与历史落盘文件名逐字一致。 */
export function legacyAnnotationKey(pdfPath: string): string {
  return pdfPath.replace(/[^a-zA-Z0-9]/g, '_');
}

export class AnnotationStore {
  private baseDir: string;
  /**
   * 落盘后回调（跨设备同步推写用，main.ts 注入）：每次 save 成功后以刚写入的
   * 数据调用一次，fire-and-forget。skipSync 的写入不触发（防 pull-merge 回环）。
   */
  syncHook?: (data: PDFAnnotationData) => void;

  constructor(private app: App, private pluginId: string) {
    this.baseDir = `${app.vault.configDir}/plugins/${pluginId}/data`;
  }

  private getFilePath(pdfPath: string): string {
    return normalizePath(`${this.baseDir}/${annotationKey(pdfPath)}.json`);
  }

  /** 旧版有损键对应的 sidecar 路径（只读不写，迁移用）。 */
  private getLegacyFilePath(pdfPath: string): string {
    return normalizePath(`${this.baseDir}/${legacyAnnotationKey(pdfPath)}.json`);
  }

  async ensureDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.baseDir))) {
      await this.app.vault.adapter.mkdir(this.baseDir);
    }
  }

  /**
   * 读取一份 sidecar 并校验归属（fileId 必须精确等于 pdfPath）。
   * 不存在 / 解析失败 / 归属不符一律 null —— 归属校验是旧版撞键数据的最后一道闸：
   * 撞键共享的旧文件（fileId 记的是另一本书）绝不能被当前文件认领。
   */
  private async readOwned(filePath: string, pdfPath: string): Promise<PDFAnnotationData | null> {
    try {
      if (!(await this.app.vault.adapter.exists(filePath))) return null;
      const parsed = JSON.parse(await this.app.vault.adapter.read(filePath)) as PDFAnnotationData;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.annotations)) {
        console.warn('[FleurPDF] 批注 sidecar 结构不可用，按空处理', filePath);
        return null;
      }
      if (parsed.fileId !== pdfPath) {
        console.warn(
          '[FleurPDF] 批注 sidecar 归属不符，已忽略（旧版路径哈希撞名 / 手工拷贝）',
          filePath, '记录归属:', parsed.fileId, '当前文件:', pdfPath,
        );
        return null;
      }
      return { ...parsed, fileId: pdfPath };
    } catch (e) {
      console.warn('[FleurPDF] 批注 sidecar 读取失败，按空处理', filePath, e);
      return null;
    }
  }

  async load(pdfPath: string): Promise<PDFAnnotationData> {
    await this.ensureDir();
    const own = await this.readOwned(this.getFilePath(pdfPath), pdfPath);
    if (own) return own;
    // 新键有文件但归属不符：说明该键被别处占用（极端撞名/脏数据），
    // 不复用旧键数据，避免把两本书再搅在一起。
    if (await this.app.vault.adapter.exists(this.getFilePath(pdfPath))) {
      return { fileId: pdfPath, annotations: [] };
    }

    // 一次性迁移：旧键文件 + fileId 精确匹配才认领。
    // 撞键共享的旧文件（fileId 是另一本）不认领、也不删除 —— 删了可能毁掉
    // 真正主人的数据；留着等它自己的文件来认领，或被用户手工整理。
    const legacyPath = this.getLegacyFilePath(pdfPath);
    const legacy = await this.readOwned(legacyPath, pdfPath);
    if (!legacy) return { fileId: pdfPath, annotations: [] };
    try {
      await this.app.vault.adapter.write(this.getFilePath(pdfPath), JSON.stringify(legacy, null, 2));
      await this.app.vault.adapter.remove(legacyPath);
      console.debug('[FleurPDF] 批注 sidecar 已迁移到新键', pdfPath);
    } catch (e) {
      // 迁移失败不影响本次使用；旧键仍在，下次 load 会再试
      console.warn('[FleurPDF] 批注 sidecar 迁移失败（旧键保留，下次重试）', pdfPath, e);
    }
    return legacy;
  }

  async save(data: PDFAnnotationData, opts?: { skipSync?: boolean }): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(data.fileId);
    await this.app.vault.adapter.write(filePath, JSON.stringify(data, null, 2));
    if (!opts?.skipSync && this.syncHook) {
      try { this.syncHook(data); } catch { /* 推写失败不影响本地保存 */ }
    }
  }

  /** 落盘但不触发同步推写（pull-merge 写回合并结果时用，防回环）。 */
  async saveRaw(data: PDFAnnotationData): Promise<void> {
    await this.save(data, { skipSync: true });
  }

  /**
   * 持久化删除墓碑：跨设备同步开启后，删除必须落盘 —— 否则 A 端删除后，
   * B 端旧数据经同步副本回来就「复活」了（会话内存墓碑重启即失效）。
   */
  async recordTombstones(pdfPath: string, ids: string[]): Promise<void> {
    const fresh = ids.filter(Boolean);
    if (fresh.length === 0) return;
    const data = await this.load(pdfPath);
    if (!data.tombstones) data.tombstones = {};
    const now = Date.now();
    for (const id of fresh) {
      if (!data.tombstones[id] || data.tombstones[id] < now) data.tombstones[id] = now;
    }
    await this.save(data);
  }

  async addAnnotation(pdfPath: string, annotation: Annotation): Promise<void> {
    const data = await this.load(pdfPath);
    // 防止重复：检查是否已存在相同 id 的批注
    const exists = data.annotations.some(a => a.id === annotation.id);
    if (!exists) {
      data.annotations.push(annotation);
      await this.save(data);
    }
  }

  async removeAnnotation(pdfPath: string, annotationId: string): Promise<void> {
    const data = await this.load(pdfPath);
    data.annotations = data.annotations.filter(a => a.id !== annotationId);
    if (!data.tombstones) data.tombstones = {};
    data.tombstones[annotationId] = Date.now();
    await this.save(data);
  }

  // AI 缓存相关方法
  async addAIResult(pdfPath: string, result: AIResult): Promise<void> {
    const data = await this.load(pdfPath);
    if (!data.aiResults) {
      data.aiResults = [];
    }
    data.aiResults.push(result);
    await this.save(data);
  }

  async getAIResults(pdfPath: string): Promise<AIResult[]> {
    const data = await this.load(pdfPath);
    const results: AIResult[] = data.aiResults ?? [];
    return results;
  }

  async removeAIResult(pdfPath: string, resultId: string): Promise<void> {
    const data = await this.load(pdfPath);
    if (data.aiResults) {
      data.aiResults = data.aiResults.filter(r => r.id !== resultId);
      if (!data.tombstones) data.tombstones = {};
      data.tombstones[resultId] = Date.now();
      await this.save(data);
    }
  }
}
