// 数据存储层
import { App, normalizePath } from 'obsidian';
import type { Annotation, PDFAnnotationData, AIResult } from './types';

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
    const hash = this.hashPath(pdfPath);
    return normalizePath(`${this.baseDir}/${hash}.json`);
  }

  private hashPath(path: string): string {
    return path.replace(/[^a-zA-Z0-9]/g, '_');
  }

  async ensureDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.baseDir))) {
      await this.app.vault.adapter.mkdir(this.baseDir);
    }
  }

  async load(pdfPath: string): Promise<PDFAnnotationData> {
    await this.ensureDir();
    const filePath = this.getFilePath(pdfPath);

    try {
      if (await this.app.vault.adapter.exists(filePath)) {
        const content = await this.app.vault.adapter.read(filePath);
        return JSON.parse(content) as PDFAnnotationData;
      }
    } catch {
      // 加载失败时返回空数据
    }

    return { fileId: pdfPath, annotations: [] };
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
