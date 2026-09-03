/**
 * 文本规范化工具
 * 用于把 PDF.js textLayer 选区里的"假空白"收敛为视觉连续的字符串
 */

/**
 * CJK 字符集：
 * - \u4E00-\u9FFF   CJK Unified Ideographs（常用汉字）
 * - \u3400-\u4DBF   CJK Unified Ideographs Extension A
 * - \u2E80-\u2EFF   CJK Radicals Supplement
 * - \u3000-\u303F   CJK Symbols and Punctuation（含全角空格、中文标点）
 * - \uFF00-\uFFEF   Halfwidth and Fullwidth Forms（含全角 ASCII、全角标点）
 * - \uF900-\uFAFF   CJK Compatibility Ideographs
 */
const CJK_CHAR = '[\\u2E80-\\u2EFF\\u3000-\\u303F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF]';

// CJK 字符之间的空白（含空格/制表/换行/全角空格）→ 全部移除
const CJK_BETWEEN_WS = new RegExp(`(${CJK_CHAR})\\s+(${CJK_CHAR})`, 'g');

/**
 * 把任意连续空白收敛为视觉连续：
 * 1. 多空白（含换行、制表、回车、全角空格）→ 单个空格
 * 2. 迭代移除 **CJK 字符之间** 的所有空白
 * 3. 英文/数字单词之间的空白保留（避免 "hello world" 变 "helloworld"）
 * 4. 去除首尾空白
 *
 * 应用场景：
 * - PDF.js textLayer 把每个字符放在独立 `<span>`，通过 CSS transform 定位。
 * - 跨字符选区时 Chromium 在 span 之间插入 ASCII 空格作为视觉分隔。
 * - 中文段落里字符本应紧密相邻，这些"视觉分隔空格"是 PDF 渲染产物，需全部去除。
 * - 跨行选区时 `selection.toString()` 还会拼接 `\n`，本函数一并收敛。
 * - `_collectByTextMatch` 已自带"去空白匹配"策略（replace(/\s+/g, '')），规范化不会破坏文本定位恢复。
 *
 * 示例：
 *   "袭人 送母 殡后， 业已回来"   → "袭人送母殡后，业已回来"
 *   "hello world"                  → "hello world"
 *   "hello 中 world"               → "hello 中 world"
 *   "一面说，一面\n出去开了"      → "一面说，一面出去开了"
 */
export function normalizeWhitespace(text: string): string {
  let result = text.replace(/\s+/g, ' ').trim();
  // 迭代：相邻 CJK 之间的空白可能跨多个 span，需要多次扫描直到稳定
  let prev: string;
  do {
    prev = result;
    result = result.replace(CJK_BETWEEN_WS, '$1$2');
  } while (result !== prev);
  return result;
}