// 便签输入期间接管左右方向键。
//
// 为什么需要：Obsidian 的 PDF 视图把 ArrowLeft/ArrowRight 注册进 app.keymap
// （1.13.1 app.js：`r.register([], "ArrowLeft", o(previousPage))`），keymap 在
// **window 捕获阶段**处理，先于 textarea 拿到事件。它的守卫 `yg(targetNode)`
// 只认 `INPUT` 与 `contentEditable === "true"`，**没有 TEXTAREA**——于是便签
// textarea 里的左右键被当成翻页，光标纹丝不动。
//
// 修法：编辑便签时压入一个自己的 Scope，左右键返回 true。
//   · 返回 true（非 false）→ keymap 不会 preventDefault / stopPropagation，
//     浏览器默认的光标移动照常执行；
//   · 命中后不再继续找父级 → PDF 视图那两条翻页处理器不会被调用；
//   · 其余按键不注册，原样下发给 parent（app.scope，全局热键不受影响）。
// 便签失焦 / 层被拆 / 插件卸载时 release，翻页立刻恢复。
import { Scope } from 'obsidian';

/** 只依赖 d.ts 里公开的 app.scope / app.keymap。 */
interface KeymapHost {
  scope: Scope;
  keymap: {
    pushScope(scope: Scope): void;
    popScope(scope: Scope): void;
  };
}

export class NoteArrowKeyGuard {
  private scope: Scope | null = null;

  constructor(private app: KeymapHost) {}

  /** 当前是否已接管（供 blur / 卸载时的清理判断）。 */
  get active(): boolean {
    return this.scope !== null;
  }

  /** 便签正文拿到焦点时调用；重复调用无副作用。 */
  acquire(): void {
    if (this.scope) return;
    const scope = new Scope(this.app.scope);
    // 不限制修饰键（[]），与 PDF 视图的注册形态一致；返回 true = 放行默认行为
    scope.register([], 'ArrowLeft', () => true);
    scope.register([], 'ArrowRight', () => true);
    this.scope = scope;
    this.app.keymap.pushScope(scope);
  }

  /** 便签正文失焦 / 清理时调用；未持有时无副作用。 */
  release(): void {
    if (!this.scope) return;
    this.app.keymap.popScope(this.scope);
    this.scope = null;
  }
}