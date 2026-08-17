// 数据存储层
import { App, TFile, normalizePath } from 'obsidian';
import type { Annotation, PDFAnnotationData, AIResult } from './types';

export class AnnotationStore {
  private baseDir: string;

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

  async save(data: PDFAnnotationData): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(data.fileId);
    await this.app.vault.adapter.write(filePath, JSON.stringify(data, null, 2));
  }

  async addAnnotation(pdfPath: string, annotation: Annotation): Promise<void> {
    const data = await this.load(pdfPath);
    data.annotations.push(annotation);
    await this.save(data);
  }

  async removeAnnotation(pdfPath: string, annotationId: string): Promise<void> {
    const data = await this.load(pdfPath);
    data.annotations = data.annotations.filter(a => a.id !== annotationId);
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
      await this.save(data);
    }
  }
}
