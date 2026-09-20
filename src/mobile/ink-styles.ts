// 手写批注样式的装载说明（v1.6.1 起）。
//
// 历史方案是运行时创建 <style> 元素整表注入 —— Obsidian Community 审核
// 明确禁止（样式必须走 styles.css，由 Obsidian 统一加载）。
// 现已改为：ink 编辑器 CSS 平铺并内联图标后，作为生成区块并入 styles.css
// （见 styles.css 尾部「Fleur ink editor styles」标记区，由
// scripts/inline-ink-css-to-styles.mjs 从 ink-css.flat.ts + ink-icons.ts 生成）。
//
// install/remove 保留为空操作存根，main.ts 的调用点不动：
// 桌面端（isMobileUI 为假）原本就「不注入」，现在变成「styles.css 里有一段
// 不会命中的规则」—— 这些选择器只作用于 pdf.js 编辑层在墨迹模式下才会
// 出现的元素（.annotationEditorLayer.inkEditing 等），桌面端样式计算零成本、
// 行为零变化。
//
// removeInkStyles 仍保留「按 id 清理旧版可能残留的 <style> 元素」的兜底：
// 从旧版升级时，上一会话注入的元素随插件重载自然消失，但保险起见
// 卸载时再扫一次。

const STYLE_ID = 'fleur-pdf-ink-styles';

/** 装载样式（现在是空操作：样式常驻 styles.css）。 */
export function installInkStyles(): void {
	/* 样式已并入 styles.css，无需运行时注入。 */
}

/** 移除样式（空操作；仅清理旧版可能残留的注入元素）。 */
export function removeInkStyles(): void {
	document.getElementById(STYLE_ID)?.remove();
}
