// 手写批注样式的注入与移除。
//
// 设计要点：样式表「整表注入」，而不是「加 body class + 后代选择器隔离」。
// 原因是这两张官方表内部使用原生 CSS 嵌套（如 `.annotationEditorLayer { &.inkEditing {} }`），
// 做选择器前缀改写会破坏嵌套结构。整表注入的好处更彻底：
//   桌面端（isMobileUI 为假）连 <style> 元素都不存在 —— 不是「选择器不匹配」，
//   而是「这些规则根本没进文档」，样式计算阶段的开销都是零。
//
// 缺了这些样式会怎样（v0.3 实测）：笔迹的 SVG path 数据齐全、但一个像素都看不到 ——
// SVG 退化为流内元素后被绝对定位的 <canvas> 盖住。这是最难排查的一类「功能不存在」。

import { inlineIconUrls } from './ink-icons';
import { INK_EDITOR_CSS_FLAT } from './ink-css.flat';

const STYLE_ID = 'fleur-pdf-ink-styles';

let injected: HTMLStyleElement | null = null;

/** 是否已注入。 */
export function inkStylesInstalled(): boolean {
	return !!injected?.isConnected;
}

/**
 * 注入手写批注所需样式（幂等）。
 *
 * CSS 来源：ink-css.flat.ts（由 scripts/flatten-ink-css.mjs 从 ink-css.ts 生成）——
 * 全部选择器已平铺、light-dark() 已拆为明暗静态值，兼容旧移动端 WebView
 * （原生 CSS 嵌套需 Safari 17.2+/Chromium 120+，light-dark() 需 Safari 17.5+/Chromium 123+，
 * 真机版本不可控，不能赌）。
 */
export function installInkStyles(): void {
	if (injected?.isConnected) return;
	const css = inlineIconUrls(INK_EDITOR_CSS_FLAT);
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = css;
	document.head.appendChild(el);
	injected = el;
}

/** 移除注入的样式（插件卸载、或关掉移动端调试开关时调用）。 */
export function removeInkStyles(): void {
	if (injected) {
		injected.remove();
		injected = null;
		return;
	}
	// 兜底：清理可能由上一次会话残留的同 id 元素
	document.getElementById(STYLE_ID)?.remove();
}
