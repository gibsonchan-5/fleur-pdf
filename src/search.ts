// PDF 全文检索：逐页提取文本（pdf.js getTextContent，不依赖懒渲染的 DOM textLayer）
// + 单文件缓存 + 关键词匹配。内存策略：只保留当前文件一份全文缓存，
// 切换文件后旧缓存自动被新文件覆盖，不会随打开文件数量累积。
import { App, TFile, loadPdfJs } from 'obsidian';

export interface SearchResult {
  pageNum: number;
  /** 该页内第几处出现（从 1 起） */
  occurrence: number;
  /** 上下文片段（空白已收敛为单空格） */
  context: string;
  /** 关键词在 context 中的起始偏移 */
  matchStart: number;
  matchLength: number;
}

/** 上下文片段：关键词前后的字符数 */
const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 64;
/** 结果上限：避免极端关键词（如单字）把 DOM 撑爆 */
const RESULT_LIMIT = 300;

export class PdfSearchService {
  /** 单文件缓存：{ 文件路径, 全文文本数组（下标 = 页码-1） } */
  private cache: { path: string; pages: string[] } | null = null;
  /** 兜底用的独立 pdf.js 文档代理（视图内部结构取不到时才创建） */
  private fallbackDoc: { path: string; doc: any } | null = null;
  /** 提取令牌：新请求会使旧的提取循环自行终止 */
  private extractToken = 0;

  constructor(private app: App) {}

  /** 释放缓存并中断进行中的提取（文件切换时可调用） */
  clearCache() {
    this.cache = null;
    this.extractToken++;
  }

  /** 解析当前打开 PDF 视图底层的 pdf.js 文档代理 */
  private async getDocument(filePath: string): Promise<any | null> {
    const activeFile = this.app.workspace.getActiveFile();
    const leaves = this.app.workspace.getLeavesOfType('pdf');
    // 活动文件对应的 leaf 优先
    const sorted = [...leaves].sort((a, b) => {
      const am = (a.view as any)?.file?.path === activeFile?.path ? 0 : 1;
      const bm = (b.view as any)?.file?.path === activeFile?.path ? 0 : 1;
      return am - bm;
    });
    for (const leaf of sorted) {
      const view = leaf.view as any;
      // 多候选兼容：Obsidian 内部结构随版本演进，逐个尝试
      const doc =
        view?.viewer?.pdfViewer?.pdfDocument ??
        view?.viewer?.pdfDocument ??
        view?.pdfViewer?.pdfDocument ??
        view?._pdfViewer?.pdfDocument ??
        view?._pdf;
      if (this.isValidDoc(doc)) return doc;
    }
    return this.getFallbackDocument(filePath);
  }

  private isValidDoc(doc: any): boolean {
    return (
      !!doc &&
      typeof doc.numPages === 'number' &&
      doc.numPages > 0 &&
      typeof doc.getPage === 'function'
    );
  }

  /** 兜底：用 pdf.js 独立解析文件（会多占用一份文件数据内存，仅在无法直接访问视图内部文档时使用） */
  private async getFallbackDocument(filePath: string): Promise<any | null> {
    try {
      if (this.fallbackDoc?.path === filePath && this.isValidDoc(this.fallbackDoc.doc)) {
        return this.fallbackDoc.doc;
      }
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return null;
      const lib = await loadPdfJs();
      const data = await this.app.vault.readBinary(file);
      const doc = await lib.getDocument({ data }).promise;
      this.fallbackDoc = { path: filePath, doc };
      return doc;
    } catch {
      return null;
    }
  }

  /**
   * 提取全文（惰性：首次搜索时才逐页提取；单文件缓存）。
   * 返回 null 表示文档不可用或被新的提取请求中断。
   */
  async extract(
    filePath: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<string[] | null> {
    const doc = await this.getDocument(filePath);
    if (!this.isValidDoc(doc)) return null;

    if (this.cache && this.cache.path === filePath && this.cache.pages.length === doc.numPages) {
      return this.cache.pages;
    }

    const token = ++this.extractToken;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      if (token !== this.extractToken) return null;
      try {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        pages.push(this.itemsToText(tc.items));
        // 及时释放页面代理的渲染资源（不影响文档级缓存）
        page.cleanup?.();
      } catch {
        pages.push('');
      }
      onProgress?.(i, doc.numPages);
    }
    if (token !== this.extractToken) return null;
    this.cache = { path: filePath, pages };
    return pages;
  }

  /** pdf.js 文本项拼接为页面文本（尊重换行标记） */
  private itemsToText(items: any[]): string {
    let out = '';
    for (const item of items) {
      if (typeof item?.str !== 'string') continue;
      out += item.str;
      if (item.hasEOL) out += '\n';
    }
    return out;
  }

  /**
   * 全文检索。大小写不敏感；结果按行文顺序（页码升序 + 页内出现顺序）。
   * 返回 null 表示文档不可用或提取被中断。
   */
  async search(
    filePath: string,
    keyword: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<SearchResult[] | null> {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];
    const pages = await this.extract(filePath, onProgress);
    if (!pages) return null;

    const results: SearchResult[] = [];
    for (let p = 0; p < pages.length; p++) {
      // 空白收敛后再搜索：与上下文片段展示保持同一坐标系
      const norm = pages[p].replace(/\s+/g, ' ');
      if (!norm) continue;
      const lower = norm.toLowerCase();
      let idx = lower.indexOf(kw);
      let occ = 0;
      while (idx !== -1) {
        occ++;
        const start = Math.max(0, idx - CONTEXT_BEFORE);
        const end = Math.min(norm.length, idx + kw.length + CONTEXT_AFTER);
        const prefix = start > 0 ? 1 : 0;
        results.push({
          pageNum: p + 1,
          occurrence: occ,
          context:
            (prefix ? '…' : '') +
            norm.slice(start, end) +
            (end < norm.length ? '…' : ''),
          matchStart: idx - start + prefix,
          matchLength: kw.length,
        });
        if (results.length >= RESULT_LIMIT) return results;
        idx = lower.indexOf(kw, idx + kw.length);
      }
    }
    return results;
  }
}
