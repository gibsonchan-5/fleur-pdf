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
 * body 上的**真机**移动端标记类名。只看 Platform.isMobile，desktopInk 不加。
 *
 * MOBILE_BODY_CLASS 覆盖「移动端 UI」的样式与行为（手写批注整套 UI）；
 * 但有一批 CSS 是按**真机 DOM** 写死的（如批注浮动菜单的两行 4+4 grid，
 * 依赖把手占位与分隔线隐藏），而菜单 DOM 由 Platform.isMobile 门控 ——
 * desktopInk 开启时 body 有 MOBILE_BODY_CLASS 却是桌面款菜单 DOM，
 * 若这些规则仍命中就会图标互相叠压（1.8.x 实测）。凡 CSS 依赖「菜单是
 * 移动款 DOM」的规则一律挂本类。
 */
export const NATIVE_MOBILE_BODY_CLASS = 'fleur-pdf-native-mobile';

/**
 * 是否启用移动端 UI（手写批注整套界面）：
 * - 真机移动端（Platform.isMobile）
 * - 桌面端开启「桌面端手写批注」开关（settings.desktopInk，默认 false）——
 *   桌面端开启后获得与移动端一致的三态胶囊（编辑 / 手写 / 批注列表），
 *   手写模式以鼠标落墨，并渲染移动端写入的笔迹（sidecar 随 vault 跨端同步）。
 *
 * 默认两者皆否，因此桌面端用户的行为与加入本模块之前完全一致。
 */
export function isMobileUI(plugin: FleurPDFPlugin): boolean {
	return Platform.isMobile || plugin.settings.desktopInk === true;
}

/** 把移动端标记类同步到 body。onload、设置里切换开关、以及布局就绪后都要调一次。
 *  真机额外挂 NATIVE_MOBILE_BODY_CLASS（见其注释）；desktopInk 只挂 MOBILE_BODY_CLASS。 */
export function applyMobileBodyClass(plugin: FleurPDFPlugin): void {
	document.body.classList.toggle(MOBILE_BODY_CLASS, isMobileUI(plugin));
	document.body.classList.toggle(NATIVE_MOBILE_BODY_CLASS, Platform.isMobile);
}
