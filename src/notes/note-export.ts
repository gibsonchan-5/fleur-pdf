// 便签一键导出 md 笔记。
//
// 覆盖识别：sidecar 里记住上次导出的路径（exportPath，见 note-store.ts）。
//   · 记得到 → 原地 vault.modify 覆盖（用户移动/改名过也跟过去）；
//   · 记不到（首次 / 文件已被删）→ 落默认路径 `<noteFolder>/便签 <PDF名>.md`，
//     默认路径上已有文件同样覆盖 —— 语义就是「这份文件归便签导出管」。

import { Notice, TFile, normalizePath } from 'obsidian';
import type FleurPDFPlugin from '../main';
import type { NoteLayer } from './note-layer';
import type { PDFNote } from './note-store';

/** 导出顺序：页码 → 纵向 → 横向（与阅读便签的视线一致）。 */
export function sortNotesForExport(notes: PDFNote[]): PDFNote[] {
  return [...notes].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

function fmtTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 纯函数（无头测试直接喂数据断言结构）。
 * 正文不写 H1：导出文件名本身就是「便签 <PDF名>」，Obsidian 会把它显示为
 * 行内标题，正文再重复一个主标题就成了双标题。
 */
export function buildNotesMarkdown(
  pdfPath: string,
  sortedNotes: PDFNote[],
  now: Date = new Date(),
): string {
  const lines: string[] = [];
  lines.push(`> 来源：\`${pdfPath}\``, `> 导出时间：${fmtTime(now)}`, '', '---', '');
  let page = 0;
  for (const n of sortedNotes) {
    if (n.page !== page) {
      page = n.page;
      lines.push(`## 第 ${page} 页`, '');
    }
    // 便签内部多行原样保留；行首缩进会破坏 md 段落，统一 trim 掉。
    const body = n.text
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .trim();
    lines.push(body || '（空白便签）', '');
  }
  return lines.join('\n');
}

/** `<noteFolder>/便签 <PDF名>.md`，非法文件名字符按 '_' 处理。 */
export function defaultExportPath(plugin: FleurPDFPlugin, pdfPath: string): string {
  const pdfName = pdfPath.split('/').pop() ?? pdfPath;
  const base = pdfName.replace(/\.pdf$/i, '').replace(/[#|[\]^:*?/\\]/g, '_');
  const folder = (plugin.settings.noteFolder ?? '').trim().replace(/\/+$/, '');
  return normalizePath(`${folder ? folder + '/' : ''}便签 ${base}.md`);
}

async function ensureFolder(plugin: FleurPDFPlugin, folder: string): Promise<void> {
  if (!folder) return;
  const { vault } = plugin.app;
  if (vault.getAbstractFileByPath(folder)) return;
  try {
    await vault.createFolder(folder);
  } catch {
    // 并发创建会抛「已存在」；确认在册即可
    if (!vault.getAbstractFileByPath(folder)) throw new Error(`无法创建导出文件夹 ${folder}`);
  }
}

export async function exportNotesToMd(plugin: FleurPDFPlugin, layer: NoteLayer): Promise<void> {
  const pdfPath = layer.currentPdfPath;
  if (!pdfPath) {
    new Notice('请先打开一个 PDF 再导出便签', 3000);
    return;
  }
  const notes = sortNotesForExport(layer.currentNotes.filter((n) => n.text.trim()));
  if (!notes.length) {
    new Notice('当前 PDF 没有可导出的便签内容', 3000);
    return;
  }
  const { vault } = plugin.app;
  const md = buildNotesMarkdown(pdfPath, notes);

  // 覆盖识别：先跟 sidecar 记的路径，失效再落默认路径
  let target = layer.currentExportPath;
  let file = target ? vault.getAbstractFileByPath(target) : null;
  if (!(file instanceof TFile)) {
    target = defaultExportPath(plugin, pdfPath);
    file = vault.getAbstractFileByPath(target);
  }

  try {
    if (file instanceof TFile) {
      await vault.modify(file, md);
    } else {
      const dir = target.split('/').slice(0, -1).join('/');
      await ensureFolder(plugin, dir);
      const created = await vault.create(normalizePath(target), md);
      file = created;
    }
    layer.setExportPath((file as TFile).path);
    new Notice(`已导出 ${notes.length} 条便签 → ${(file as TFile).path}`, 5000);
  } catch (err) {
    console.warn('[FleurPDF Notes] 导出失败:', err);
    new Notice('便签导出失败，详情见控制台', 5000);
  }
}
