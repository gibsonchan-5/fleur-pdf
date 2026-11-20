// 便签（贴页备忘录）的持久化。
//
// 数据落点：`.obsidian/plugins/<id>/data/notes-<64 位路径哈希>.json`，按 PDF 路径 keyed。
//   · 与 AnnotationStore 同目录但文件名带 `notes-` 前缀（批注是 `ann-`）。
//   · 旧版用的是「非字母数字一律 → _」的有损键，中文等长书名会撞成同一份文件
//     （便签串书）；新键改为 djb2+FNV-1a 的 64 位哈希，旧的按 `file` 字段
//     精确匹配做一次性迁移（见 load）。
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

/**
 * 路径 → sidecar 键（与 store.ts 的 stableKey 同款：djb2 + FNV-1a 拼 64 位）。
 * 旧实现是「非字母数字一律 → _」，中文等长书名会撞到同一份 json（便签会串书）；
 * 这里复制一份保持模块独立（annotation-sync 同样做法）。
 */
function stableKey(s: string): string {
  let h1 = 5381;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/** 便签 sidecar 文件名（不含 .json），前缀避开批注的 `ann-`。 */
export function notesKey(pdfPath: string): string {
  return `notes-${stableKey(pdfPath)}`;
}

/** 旧版有损键（仅用于一次性迁移）。 */
export function legacyNotesKey(pdfPath: string): string {
  return `notes-${pdfPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

export class NoteStore {
  private baseDir: string;

  constructor(private app: App, pluginId: string) {
    this.baseDir = `${app.vault.configDir}/plugins/${pluginId}/data`;
  }

  /** `<configDir>/plugins/<id>/data/notes-<64 位哈希>.json`（前缀避开 AnnotationStore）。 */
  pathFor(pdfPath: string): string {
    return normalizePath(`${this.baseDir}/${notesKey(pdfPath)}.json`);
  }

  /** 旧版有损键对应的路径（只读不写，迁移用）。 */
  private legacyPathFor(pdfPath: string): string {
    return normalizePath(`${this.baseDir}/${legacyNotesKey(pdfPath)}.json`);
  }

  /**
   * 读取并校验归属：payload 的 `file` 必须精确等于 pdfPath。
   * 归属不符（旧版撞键共享 / 手工拷贝）→ null，绝不认领另一本书的便签。
   */
  private async readOwned(filePath: string, pdfPath: string): Promise<NotesData | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(filePath))) return null;
      const parsed = JSON.parse(await adapter.read(filePath));
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
      if (parsed.file !== pdfPath) {
        console.warn('[FleurPDF] 便签 sidecar 归属不符，已忽略', filePath, '记录归属:', parsed.file, '当前文件:', pdfPath);
        return null;
      }
      return {
        notes: sanitizeNotes(parsed.notes),
        exportPath: typeof parsed.exportPath === 'string' ? parsed.exportPath : '',
      };
    } catch {
      return null;
    }
  }

  /** 读取。任何异常（不存在 / JSON 损坏 / 版本不认识）都回退为空数据，绝不抛。 */
  async load(pdfPath: string): Promise<NotesData> {
    const adapter = this.app.vault.adapter;
    const own = await this.readOwned(this.pathFor(pdfPath), pdfPath);
    if (own) return own;
    if (await adapter.exists(this.pathFor(pdfPath))) return { notes: [], exportPath: '' };

    // 一次性迁移：只认领归属精确匹配的旧键文件；撞键共享的旧文件不认领、不删除
    const legacyPath = this.legacyPathFor(pdfPath);
    const legacy = await this.readOwned(legacyPath, pdfPath);
    if (!legacy) return { notes: [], exportPath: '' };
    try {
      if (!(await adapter.exists(this.baseDir))) await adapter.mkdir(this.baseDir);
      await adapter.write(this.pathFor(pdfPath), JSON.stringify({
        version: 1,
        file: pdfPath,
        updated: Date.now(),
        notes: legacy.notes,
        exportPath: legacy.exportPath,
      }));
      await adapter.remove(legacyPath);
      console.debug('[FleurPDF] 便签 sidecar 已迁移到新键', pdfPath);
    } catch (e) {
      console.warn('[FleurPDF] 便签 sidecar 迁移失败（旧键保留，下次重试）', pdfPath, e);
    }
    return legacy;
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
    // 旧键文件若归属本文件，一并删除 —— 否则下次 load 会把它迁移回来（删除后复活）。
    // 归属别家的撞键旧文件不动。
    const legacyPath = this.legacyPathFor(pdfPath);
    try {
      if (!(await adapter.exists(legacyPath))) return;
      const parsed = JSON.parse(await adapter.read(legacyPath));
      if (parsed?.file === pdfPath) await adapter.remove(legacyPath);
    } catch {
      /* 同样忽略 */
    }
  }
}
