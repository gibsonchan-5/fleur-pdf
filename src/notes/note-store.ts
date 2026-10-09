// 便签（贴页备忘录）的持久化。
//
// 数据落点：`.obsidian/plugins/<id>/data/notes-<路径hash>.json`，按 PDF 路径 keyed。
//   · 与 AnnotationStore 同目录但文件名带 `notes-` 前缀 —— 两者的路径 hash 算法相同
//     （非字母数字 → '_'），不加前缀会互相覆盖。
//   · 刻意不放 vault（区别于 ink sidecar）：便签是低频写、小体量的用户笔记附件，
//     跟 data.json 一样随配置目录走即可，不需要跨设备实时同步语义。
//
// 坐标系（与 ink 笔迹不同，这里选「缩放 100% 时的页内 CSS 像素」）：
//   x/y = 便签左上角相对 .page 元素左上角，w/h = 便签宽高；全部按 scale=1 记。
//   渲染时乘当前 viewport.scale，数据永不迁移。
//   不选 PDF 用户空间（ink 的做法）的原因：那个坐标系原点在左下角（y 向上），
//   便签是纯 DOM 盒模型，两套坐标来回翻转只会引入符号错误；旋转页两种方案都有
//   局限（pdf.js 旋转会改变页盒本身），已知限制、不为此复杂化。

import { App, normalizePath } from 'obsidian';

/** 一张便签。 */
export interface PDFNote {
  id: string;
  /** 1 基页码（与 pdf.js 的 data-page-number 一致）。 */
  page: number;
  /** 左上角，页内 CSS px @ scale=1。 */
  x: number;
  y: number;
  /** 宽高，页内 CSS px @ scale=1。 */
  w: number;
  h: number;
  text: string;
  createdAt: number;
  /** 折叠态：收成顶栏一条（摘要 = 首行），展开尺寸仍是 w/h。缺省 = 展开。 */
  collapsed?: boolean;
}

/** 一个 PDF 的便签全集。 */
export interface NotesData {
  notes: PDFNote[];
  /** 上次导出的 md 笔记在 vault 内的路径（'' = 从未导出）。二次导出按它识别覆盖。 */
  exportPath: string;
}

export const NOTE_DEFAULT_W = 220;
export const NOTE_DEFAULT_H = 160;
export const NOTE_MIN_W = 120;
export const NOTE_MIN_H = 80;

let noteSeq = 0;

/** 会话内唯一的便签 id。 */
export function mintNoteId(): string {
  noteSeq += 1;
  return `fleur-note-${Date.now().toString(36)}-${noteSeq}`;
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 逐条结构校验（宁缺毋滥：一条坏数据不能毒化整份文件）。
 * 尺寸越界一律夹回合法区间而不是丢弃 —— 丢数据比丢一点版式严重。
 */
export function sanitizeNotes(raw: unknown): PDFNote[] {
  if (!Array.isArray(raw)) return [];
  const out: PDFNote[] = [];
  for (const n of raw) {
    if (!n || typeof n !== 'object') continue;
    const { id, page, x, y, w, h, text, createdAt, collapsed } = n as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    if (typeof page !== 'number' || !(page >= 1)) continue;
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    out.push({
      id,
      page: Math.floor(page),
      x,
      y,
      w: Math.max(NOTE_MIN_W, finite(w, NOTE_DEFAULT_W)),
      h: Math.max(NOTE_MIN_H, finite(h, NOTE_DEFAULT_H)),
      text: typeof text === 'string' ? text : '',
      createdAt: finite(createdAt, 0),
      // 只认 true，其余（缺省/坏值）一律展开态 —— 旧数据零迁移
      ...(collapsed === true ? { collapsed: true } : {}),
    });
  }
  return out;
}

export class NoteStore {
  private baseDir: string;

  constructor(private app: App, pluginId: string) {
    this.baseDir = `${app.vault.configDir}/plugins/${pluginId}/data`;
  }

  /** `<configDir>/plugins/<id>/data/notes-<hash>.json`（前缀避开 AnnotationStore 同名文件）。 */
  pathFor(pdfPath: string): string {
    const hash = pdfPath.replace(/[^a-zA-Z0-9]/g, '_');
    return normalizePath(`${this.baseDir}/notes-${hash}.json`);
  }

  /** 读取。任何异常（不存在 / JSON 损坏 / 版本不认识）都回退为空数据，绝不抛。 */
  async load(pdfPath: string): Promise<NotesData> {
    const adapter = this.app.vault.adapter;
    const filePath = this.pathFor(pdfPath);
    try {
      if (!(await adapter.exists(filePath))) return { notes: [], exportPath: '' };
      const parsed = JSON.parse(await adapter.read(filePath));
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
        return { notes: [], exportPath: '' };
      }
      return {
        notes: sanitizeNotes(parsed.notes),
        exportPath: typeof parsed.exportPath === 'string' ? parsed.exportPath : '',
      };
    } catch {
      return { notes: [], exportPath: '' };
    }
  }

  /** 覆盖写入；便签全删且没有导出记录时直接删文件（不留空壳）。 */
  async save(pdfPath: string, data: NotesData): Promise<void> {
    if (!data.notes.length && !data.exportPath) {
      await this.remove(pdfPath);
      return;
    }
    if (!(await this.app.vault.adapter.exists(this.baseDir))) {
      await this.app.vault.adapter.mkdir(this.baseDir);
    }
    const payload = {
      version: 1,
      file: pdfPath,
      updated: Date.now(),
      notes: data.notes,
      exportPath: data.exportPath,
    };
    await this.app.vault.adapter.write(this.pathFor(pdfPath), JSON.stringify(payload));
  }

  async remove(pdfPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const filePath = this.pathFor(pdfPath);
    try {
      if (await adapter.exists(filePath)) await adapter.remove(filePath);
    } catch {
      /* 删不掉不影响使用，下次 save 会覆盖 */
    }
  }
}
