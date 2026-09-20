// 平台分支基建：桌面端零影响的核心守卫。
//
// 与 FleurEPUB 的差别：那边对移动端样式用 body class + 后代选择器做隔离；
// 这边的移动端样式是 pdf.js 官方的两张编辑器样式表（约 37 KB，内部使用原生 CSS 嵌套，
// 如 `.annotationEditorLayer { &.inkEditing { ... } }`）。对它做选择器前缀改写会破坏嵌套结构，
// 因此改为「整表注入 / 移除」：桌面端连 <style> 元素都不存在 —— 不是「选择器不匹配」，
// 而是「样式规则根本没进文档」。
//
// 铁律：所有移动端专属逻辑必须经由 isMobileUI() 判断。

import { Platform } from 'obsidian';
import type FleurPDFPlugin from './main';

/** body 上的移动端标记类名。真机移动端与桌面调试开关共用同一开关。 */
export const MOBILE_BODY_CLASS = 'fleur-pdf-mobile';

/**
 * 是否启用移动端 UI：
 * - 真机移动端（Platform.isMobile）
 * - 桌面端开启「移动端调试」开关（settings.mobileDebug，默认 false）
 *
 * 默认两者皆否，因此桌面端用户的行为与加入本模块之前完全一致。
 */
export function isMobileUI(plugin: FleurPDFPlugin): boolean {
	return Platform.isMobile || plugin.settings.mobileDebug === true;
}

/** 把移动端标记类同步到 body。onload、设置里切换开关、以及布局就绪后都要调一次。 */
export function applyMobileBodyClass(plugin: FleurPDFPlugin): void {
	document.body.classList.toggle(MOBILE_BODY_CLASS, isMobileUI(plugin));
}
