/**
 * 将 Markdown 文本剥离为纯文本（去除所有 MD 语法标记）
 * 用于气泡和侧边栏流式显示，避免 MD 源码直接呈现
 */
export function markdownToPlain(text: string): string {
  let s = text;

  // 代码块整体移除
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ');

  // 行内代码 → 去除标记保留内容
  s = s.replace(/`([^`]+)`/g, '$1');

  // 加粗 / 斜体
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  s = s.replace(/\*(.+?)\*/g, '$1');
  s = s.replace(/_(.+?)_/g, '$1');

  // 标题标记
  s = s.replace(/^#{1,6}\s+/gm, '');

  // 图片
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

  // 链接 → 保留文字
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 表格竖线 → 空格
  s = s.replace(/\|/g, ' ');

  // 表格分隔行
  s = s.replace(/^\s*:?-+:?\s*(\|\s*:?-+:?\s*)*$/gm, '');

  // 列表标记
  s = s.replace(/^[\s]*[-*+]\s+/gm, '');
  s = s.replace(/^[\s]*\d+\.\s+/gm, '');

  // 引用标记
  s = s.replace(/^>\s+/gm, '');

  // 水平线
  s = s.replace(/^[-*_]{3,}\s*$/gm, '');

  // 多余空行 → 单个换行
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}
