/* 手写批注所需的样式（自备）
 *
 * 来源：pdf.js v5.3.31
 *   - web/draw_layer_builder.css              （绘制层定位）
 *   - web/annotation_editor_layer_builder.css （编辑器、工具栏、手柄与 CSS 变量）
 *   许可证：Apache License 2.0, Mozilla Foundation
 *   修改（相对上游）：去掉 @import 与版权头（改为本注释集中声明）；
 *                     url(images/*.svg) 由 inlineIconUrls() 在运行时换为内联 data URI。
 *
 * 另含 LAYER_BASE_CSS：本项目在离线复现中实测得出的一小组基础定位规则，
 * 因为 pdf.js 把 .annotationEditorLayer 的基础定位放在 web/pdf_viewer.css 里，
 * 而那一份我们不需要（它带有整套 viewer chrome 样式）。
 *
 * 为什么必须自备（v0.3 实测结论）：Obsidian 的 app.css 有意裁掉了整套批注编辑样式
 * （app.css 中 EditorLayer / inkEditor / drawLayer / freeTextEditor 均 0 处命中，
 *  原位只留一条 Obsidian 自己的 TODO 注释）。其中最隐蔽的一条是绘制层定位：
 * 缺了它笔迹 SVG 会退化为流内元素、被绝对定位的 <canvas> 盖住 —— 数据在、但完全看不见。
 *
 * 使用方式：仅在「移动端 UI 生效」时注入 <style>，桌面端永不注入（见 platform.ts）。
 * ⚠️ 运行时实际注入的是 ink-css.flat.ts（由 scripts/flatten-ink-css.mjs 从本文件生成）：
 *    原生 CSS 嵌套需 Safari 17.2+ / Chromium 120+，light-dark() 需 Safari 17.5+ / Chromium 123+，
 *    移动端 WebView 版本不可控（0.2.1 前旧 WebView 上工具栏白条、图标隐形），故构建期降级为
 *    「全平铺选择器 + 明暗静态色」。本文件保留作为可读的源（对照 / 重新生成入口）。
 */

/** 本项目实测补充的基础定位规则（pdf.js 把它们放在 pdf_viewer.css，我们不需要那一份）。 */
export const LAYER_BASE_CSS = `
/* ============================================================
   补齐 Obsidian 裁掉的 pdf.js AnnotationEditor 样式
   ------------------------------------------------------------
   证据：Obsidian app.css 中 .annotationEditorLayer / .drawLayer /
   .inkEditor 出现次数均为 0，而 .annotationLayer 有 71 处。原位置
   留有 Obsidian 的注释，标记这里应在启用批注编辑时补回。
   因此使用内置墨迹引擎时，这些样式必须由插件自带。
   注意：本文件注释内不得再出现注释定界符，否则会吞掉后续规则。
   ============================================================ */

.annotationEditorLayer {
  /* 不要在此声明 --scale-factor / --total-scale-factor：
     两者由 .pdfViewer（inline，实际缩放比）与 .page（派生）提供，
     在此重声明会覆盖继承值，导致编辑层按 1x 计算尺寸（612x792 而非 816x1056）。
     实测结论，勿改。 */
  background: transparent;
  inset: 0;
  position: absolute;
  z-index: 3;
  user-select: none;
  -webkit-user-select: none;
}

.annotationEditorLayer.disabled {
  pointer-events: none;
}

/* 墨迹绘制层：DrawLayer 的容器 + canvas */
.annotationEditorLayer .drawLayer,
.drawLayer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.annotationEditorLayer .drawLayer canvas,
.drawLayer canvas,
canvas.draw {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* 墨迹编辑器容器 */
.inkEditor {
  position: absolute;
  background: transparent;
}

/* 选中态 —— 不画外框。
   真机（小米平板 0.3.0）：手写时 pdf.js 会把刚画完的编辑器留在选择集里，
   outline: 1px solid Highlight 会让每一笔都带上系统高亮色描边；
   几笔相邻时用户看到的就是「一整片选区框把几笔串起来」。
   用户明确要求手写时不得出现选区框（要框选请用套索工具），故不设描边。 */
.selectedEditor {
  outline: none;
}

/* 荧光笔模式（body.fleur-pdf-ink-marker 由 InkUI 在选中荧光笔时同步）：
   pdf.js 自由高亮的 pointerdown 闸门只认「文本层 div 本身」，
   按在文字 span 上会走「选字 → 高亮」路径（在 Obsidian 中不闭环，只剩选字框）。
   关掉 span 的指针事件后，拖拽永远落在文本层 div → 自由绘制；顺带根除选字 marquee。 */
body.fleur-pdf-ink-marker .textLayer span,
body.fleur-pdf-ink-marker .textLayer br {
  pointer-events: none;
}
body.fleur-pdf-ink-marker .textLayer {
  user-select: none;
  -webkit-user-select: none;
}

/* 套索（InkUI 套索笔的实时圈选预览层）：
   fixed 全屏 SVG，只做视觉，绝不吃事件 —— 事件由 InkUI 的捕获接管消费。 */
.fleur-pdf-lasso-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 100000;
}
.fleur-pdf-lasso-overlay path {
  fill: rgba(74, 114, 245, 0.08);
  stroke: #4a72f5;
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
  vector-effect: non-scaling-stroke;
}
`;

/** draw_layer_builder.css —— 绘制层定位，缺它笔迹不可见。 */
export const DRAW_LAYER_CSS = `
.canvasWrapper {
  svg {
    transform: none;

    &.moving {
      z-index: 100000;
    }

    &.highlight,
    &.highlightOutline {
      &[data-main-rotation="90"] {
        mask,
        use:not(.clip, .mask) {
          transform: matrix(0, 1, -1, 0, 1, 0);
        }
      }

      &[data-main-rotation="180"] {
        mask,
        use:not(.clip, .mask) {
          transform: matrix(-1, 0, 0, -1, 1, 1);
        }
      }

      &[data-main-rotation="270"] {
        mask,
        use:not(.clip, .mask) {
          transform: matrix(0, -1, 1, 0, 0, 1);
        }
      }
    }

    &.draw {
      position: absolute;
      mix-blend-mode: normal;

      &[data-draw-rotation="90"] {
        transform: rotate(90deg);
      }

      &[data-draw-rotation="180"] {
        transform: rotate(180deg);
      }

      &[data-draw-rotation="270"] {
        transform: rotate(270deg);
      }
    }

    &.highlight {
      --blend-mode: multiply;

      @media screen and (forced-colors: active) {
        --blend-mode: difference;
      }

      position: absolute;
      mix-blend-mode: var(--blend-mode);

      &:not(.free) {
        fill-rule: evenodd;
      }
    }

    &.highlightOutline {
      position: absolute;
      mix-blend-mode: normal;
      fill-rule: evenodd;
      fill: none;

      &:not(.free) {
        &.hovered:not(.selected) {
          stroke: var(--hover-outline-color);
          stroke-width: var(--outline-width);
        }

        &.selected {
          .mainOutline {
            stroke: var(--outline-around-color);
            stroke-width: calc(
              var(--outline-width) + 2 * var(--outline-around-width)
            );
          }

          .secondaryOutline {
            stroke: var(--outline-color);
            stroke-width: var(--outline-width);
          }
        }
      }

      &.free {
        /*
          When drawing the outline we use a mask in order to remove the parts
          that are inside the shape. Unfortunately, this removes the part of the
          outline that is inside the shape. To "fix" this we increase the width
          to have what we want to be visible outside the shape.
          This is not a perfect solution, but it works well enough.
        */
        &.hovered:not(.selected) {
          stroke: var(--hover-outline-color);
          stroke-width: calc(2 * var(--outline-width));
        }

        &.selected {
          .mainOutline {
            stroke: var(--outline-around-color);
            stroke-width: calc(
              2 * (var(--outline-width) + var(--outline-around-width))
            );
          }

          .secondaryOutline {
            stroke: var(--outline-color);
            stroke-width: calc(2 * var(--outline-width));
          }
        }
      }
    }
  }
}
`;

/** annotation_editor_layer_builder.css —— 编辑器、工具栏、编辑手柄与整套 CSS 变量。 */
export const EDITOR_LAYER_CSS = `
/* Copyright 2022 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


:root {
  --outline-width: 2px;
  --outline-color: #0060df;
  --outline-around-width: 1px;
  --outline-around-color: #f0f0f4;
  --hover-outline-around-color: var(--outline-around-color);
  --focus-outline: solid var(--outline-width) var(--outline-color);
  --unfocus-outline: solid var(--outline-width) transparent;
  --focus-outline-around: solid var(--outline-around-width)
    var(--outline-around-color);
  --hover-outline-color: #8f8f9d;
  --hover-outline: solid var(--outline-width) var(--hover-outline-color);
  --hover-outline-around: solid var(--outline-around-width)
    var(--hover-outline-around-color);
  --freetext-line-height: 1.35;
  --freetext-padding: 2px;
  --resizer-bg-color: var(--outline-color);
  --resizer-size: 6px;
  --resizer-shift: calc(
    0px - (var(--outline-width) + var(--resizer-size)) / 2 -
      var(--outline-around-width)
  );
  --editorFreeText-editing-cursor: text;
  --editorInk-editing-cursor: url(images/cursor-editorInk.svg) 0 16, pointer;
  --editorHighlight-editing-cursor:
    url(images/cursor-editorTextHighlight.svg) 24 24, text;
  --editorFreeHighlight-editing-cursor:
    url(images/cursor-editorFreeHighlight.svg) 1 18, pointer;

  --new-alt-text-warning-image: url(images/altText_warning.svg);
}

/* The following class is used to hide an element but keep it available to
 * for screen readers. */
.visuallyHidden {
  position: absolute;
  top: 0;
  left: 0;
  border: 0;
  margin: 0;
  padding: 0;
  width: 0;
  height: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 0;
}

.textLayer {
  &.highlighting {
    cursor: var(--editorFreeHighlight-editing-cursor);

    &:not(.free) span {
      cursor: var(--editorHighlight-editing-cursor);

      &[role="img"] {
        cursor: var(--editorFreeHighlight-editing-cursor);
      }
    }

    &.free span {
      cursor: var(--editorFreeHighlight-editing-cursor);
    }
  }
}

#viewerContainer.pdfPresentationMode:fullscreen,
.annotationEditorLayer.disabled {
  .noAltTextBadge {
    display: none !important;
  }
}

@media (min-resolution: 1.1dppx) {
  :root {
    --editorFreeText-editing-cursor:
      url(images/cursor-editorFreeText.svg) 0 16, text;
  }
}

@media screen and (forced-colors: active) {
  :root {
    --outline-color: CanvasText;
    --outline-around-color: ButtonFace;
    --resizer-bg-color: ButtonText;
    --hover-outline-color: Highlight;
    --hover-outline-around-color: SelectedItemText;
  }
}

[data-editor-rotation="90"] {
  transform: rotate(90deg);
}

[data-editor-rotation="180"] {
  transform: rotate(180deg);
}

[data-editor-rotation="270"] {
  transform: rotate(270deg);
}

.annotationEditorLayer {
  background: transparent;
  position: absolute;
  inset: 0;
  font-size: calc(100px * var(--total-scale-factor));
  transform-origin: 0 0;
  cursor: auto;

  .selectedEditor {
    z-index: 100000 !important;
  }

  &.drawing * {
    pointer-events: none !important;
  }
}

.annotationEditorLayer.waiting {
  content: "";
  cursor: wait;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.annotationEditorLayer.disabled {
  pointer-events: none;

  &.highlightEditing
    :is(.freeTextEditor, .inkEditor, .stampEditor, .signatureEditor) {
    pointer-events: auto;
  }
}

.annotationEditorLayer.freetextEditing {
  cursor: var(--editorFreeText-editing-cursor);
}

.annotationEditorLayer.inkEditing {
  cursor: var(--editorInk-editing-cursor);
}

.annotationEditorLayer .draw {
  box-sizing: border-box;
}

.annotationEditorLayer
  :is(.freeTextEditor, .inkEditor, .stampEditor, .signatureEditor) {
  position: absolute;
  background: transparent;
  z-index: 1;
  transform-origin: 0 0;
  cursor: auto;
  max-width: 100%;
  max-height: 100%;
  border: var(--unfocus-outline);

  &.draggable.selectedEditor {
    cursor: move;
  }

  &.selectedEditor {
    border: var(--focus-outline);
    outline: var(--focus-outline-around);

    &::before {
      /*
        This is a workaround for the lack of support for stripes(...) (see
        https://drafts.csswg.org/css-images-4/#stripes).
        The outline should be composed of 1px white, 2px blue and 1px white.
        This could be achieved in different ways:
          - using a linear-gradient;
          - using a box-shadow;
          - using an outline on the selected element and an outline+border on
            the ::before pseudo-element.
        All these options lead to incorrect rendering likely due to rounding
        issues.
        That said it doesn't mean that the current is ideal, but it's the best
        we could come up with for the moment.
        One drawback of this approach is that we use a border on the selected
        element which means that we must take care of it when positioning the
        div in js (see AnnotationEditor._borderLineWidth in editor.js).
      */
      content: "";
      position: absolute;
      inset: 0;
      border: var(--focus-outline-around);
      pointer-events: none;
    }
  }

  &:hover:not(.selectedEditor) {
    border: var(--hover-outline);
    outline: var(--hover-outline-around);

    &::before {
      content: "";
      position: absolute;
      inset: 0;
      border: var(--focus-outline-around);
    }
  }
}

.annotationEditorLayer
  :is(
    .freeTextEditor,
    .inkEditor,
    .stampEditor,
    .highlightEditor,
    .signatureEditor
  ),
.textLayer {
  .editToolbar {
    --editor-toolbar-delete-image: url(images/editor-toolbar-delete.svg);
    --editor-toolbar-bg-color: light-dark(#f0f0f4, #2b2a33);
    --editor-toolbar-highlight-image: url(images/toolbarButton-editorHighlight.svg);
    --editor-toolbar-fg-color: light-dark(#2e2e56, #fbfbfe);
    --editor-toolbar-border-color: #8f8f9d;
    --editor-toolbar-hover-border-color: var(--editor-toolbar-border-color);
    --editor-toolbar-hover-bg-color: light-dark(#e0e0e6, #52525e);
    --editor-toolbar-hover-fg-color: var(--editor-toolbar-fg-color);
    --editor-toolbar-hover-outline: none;
    --editor-toolbar-focus-outline-color: light-dark(#0060df, #0df);
    --editor-toolbar-shadow: 0 2px 6px 0 rgb(58 57 68 / 0.2);
    --editor-toolbar-vert-offset: 6px;
    --editor-toolbar-height: 28px;
    --editor-toolbar-padding: 2px;
    --alt-text-done-color: light-dark(#2ac3a2, #54ffbd);
    --alt-text-warning-color: light-dark(#0090ed, #80ebff);
    --alt-text-hover-done-color: var(--alt-text-done-color);
    --alt-text-hover-warning-color: var(--alt-text-warning-color);

    @media screen and (forced-colors: active) {
      --editor-toolbar-bg-color: ButtonFace;
      --editor-toolbar-fg-color: ButtonText;
      --editor-toolbar-border-color: ButtonText;
      --editor-toolbar-hover-border-color: AccentColor;
      --editor-toolbar-hover-bg-color: ButtonFace;
      --editor-toolbar-hover-fg-color: AccentColor;
      --editor-toolbar-hover-outline: 2px solid
        var(--editor-toolbar-hover-border-color);
      --editor-toolbar-focus-outline-color: ButtonBorder;
      --editor-toolbar-shadow: none;
      --alt-text-done-color: var(--editor-toolbar-fg-color);
      --alt-text-warning-color: var(--editor-toolbar-fg-color);
      --alt-text-hover-done-color: var(--editor-toolbar-hover-fg-color);
      --alt-text-hover-warning-color: var(--editor-toolbar-hover-fg-color);
    }

    display: flex;
    width: fit-content;
    height: var(--editor-toolbar-height);
    flex-direction: column;
    justify-content: center;
    align-items: center;
    cursor: default;
    pointer-events: auto;
    box-sizing: content-box;
    padding: var(--editor-toolbar-padding);

    position: absolute;
    inset-inline-end: 0;
    inset-block-start: calc(100% + var(--editor-toolbar-vert-offset));

    border-radius: 6px;
    background-color: var(--editor-toolbar-bg-color);
    border: 1px solid var(--editor-toolbar-border-color);
    box-shadow: var(--editor-toolbar-shadow);

    &.hidden {
      display: none;
    }

    &:has(:focus-visible) {
      border-color: transparent;
    }

    &:dir(ltr) {
      transform-origin: 100% 0;
    }

    &:dir(rtl) {
      transform-origin: 0 0;
    }

    .buttons {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0;
      height: 100%;

      button {
        padding: 0;
      }

      .divider {
        width: 0;
        height: calc(
          2 * var(--editor-toolbar-padding) + var(--editor-toolbar-height)
        );
        border-left: 1px solid var(--editor-toolbar-border-color);
        border-right: none;
        display: inline-block;
        margin-inline: 2px;
      }

      .highlightButton {
        width: var(--editor-toolbar-height);

        &::before {
          content: "";
          mask-image: var(--editor-toolbar-highlight-image);
          mask-repeat: no-repeat;
          mask-position: center;
          display: inline-block;
          background-color: var(--editor-toolbar-fg-color);
          width: 100%;
          height: 100%;
        }

        &:hover::before {
          background-color: var(--editor-toolbar-hover-fg-color);
        }
      }

      .delete {
        width: var(--editor-toolbar-height);

        &::before {
          content: "";
          mask-image: var(--editor-toolbar-delete-image);
          mask-repeat: no-repeat;
          mask-position: center;
          display: inline-block;
          background-color: var(--editor-toolbar-fg-color);
          width: 100%;
          height: 100%;
        }

        &:hover::before {
          background-color: var(--editor-toolbar-hover-fg-color);
        }
      }

      > * {
        height: var(--editor-toolbar-height);
      }

      > :not(.divider) {
        border: none;
        background-color: transparent;
        cursor: pointer;

        &:hover {
          border-radius: 2px;
          background-color: var(--editor-toolbar-hover-bg-color);
          color: var(--editor-toolbar-hover-fg-color);
          outline: var(--editor-toolbar-hover-outline);
          outline-offset: 1px;

          &:active {
            outline: none;
          }
        }

        &:focus-visible {
          border-radius: 2px;
          outline: 2px solid var(--editor-toolbar-focus-outline-color);
        }
      }

      .altText {
        --alt-text-add-image: url(images/altText_add.svg);
        --alt-text-done-image: url(images/altText_done.svg);

        display: flex;
        align-items: center;
        justify-content: center;
        width: max-content;
        padding-inline: 8px;
        pointer-events: all;
        font: menu;
        font-weight: 590;
        font-size: 12px;
        color: var(--editor-toolbar-fg-color);

        &:disabled {
          pointer-events: none;
        }

        &::before {
          content: "";
          mask-image: var(--alt-text-add-image);
          mask-repeat: no-repeat;
          mask-position: center;
          display: inline-block;
          width: 12px;
          height: 13px;
          background-color: var(--editor-toolbar-fg-color);
          margin-inline-end: 4px;
        }

        &:hover::before {
          background-color: var(--editor-toolbar-hover-fg-color);
        }

        &.done::before {
          mask-image: var(--alt-text-done-image);
        }

        &.new {
          &::before {
            width: 16px;
            height: 16px;
            mask-image: var(--new-alt-text-warning-image);
            background-color: var(--alt-text-warning-color);
            mask-size: cover;
          }

          &:hover::before {
            background-color: var(--alt-text-hover-warning-color);
          }

          &.done {
            &::before {
              mask-image: var(--alt-text-done-image);
              background-color: var(--alt-text-done-color);
            }

            &:hover::before {
              background-color: var(--alt-text-hover-done-color);
            }
          }
        }

        .tooltip {
          display: none;
          word-wrap: anywhere;

          &.show {
            --alt-text-tooltip-bg: light-dark(#f0f0f4, #1c1b22);
            --alt-text-tooltip-fg: light-dark(#15141a, #fbfbfe);
            --alt-text-tooltip-border: #8f8f9d;
            --alt-text-tooltip-shadow: 0px 2px 6px 0px
              light-dark(rgb(58 57 68 / 0.2), #15141a);

            @media screen and (forced-colors: active) {
              --alt-text-tooltip-bg: Canvas;
              --alt-text-tooltip-fg: CanvasText;
              --alt-text-tooltip-border: CanvasText;
              --alt-text-tooltip-shadow: none;
            }

            display: inline-flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            position: absolute;
            top: calc(100% + 2px);
            inset-inline-start: 0;
            padding-block: 2px 3px;
            padding-inline: 3px;
            max-width: 300px;
            width: max-content;
            height: auto;
            font-size: 12px;

            border: 0.5px solid var(--alt-text-tooltip-border);
            background: var(--alt-text-tooltip-bg);
            box-shadow: var(--alt-text-tooltip-shadow);
            color: var(--alt-text-tooltip-fg);

            pointer-events: none;
          }
        }
      }
    }
  }
}

.annotationEditorLayer .freeTextEditor {
  padding: calc(var(--freetext-padding) * var(--total-scale-factor));
  width: auto;
  height: auto;
  touch-action: none;
}

.annotationEditorLayer .freeTextEditor .internal {
  background: transparent;
  border: none;
  inset: 0;
  overflow: visible;
  white-space: nowrap;
  font: 10px sans-serif;
  line-height: var(--freetext-line-height);
  user-select: none;
}

.annotationEditorLayer .freeTextEditor .overlay {
  position: absolute;
  display: none;
  background: transparent;
  inset: 0;
  width: 100%;
  height: 100%;
}

.annotationEditorLayer freeTextEditor .overlay.enabled {
  display: block;
}

.annotationEditorLayer .freeTextEditor .internal:empty::before {
  content: attr(default-content);
  color: gray;
}

.annotationEditorLayer .freeTextEditor .internal:focus {
  outline: none;
  user-select: auto;
}

.annotationEditorLayer .inkEditor {
  width: 100%;
  height: 100%;
}

.annotationEditorLayer .inkEditor.editing {
  cursor: inherit;
}

.annotationEditorLayer .inkEditor .inkEditorCanvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}

.annotationEditorLayer .stampEditor {
  width: auto;
  height: auto;

  canvas {
    position: absolute;
    width: 100%;
    height: 100%;
    margin: 0;
    top: 0;
    left: 0;
  }

  .noAltTextBadge {
    --no-alt-text-badge-border-color: light-dark(#f0f0f4, #52525e);
    --no-alt-text-badge-bg-color: light-dark(#cfcfd8, #fbfbfe);
    --no-alt-text-badge-fg-color: light-dark(#5b5b66, #15141a);

    @media screen and (forced-colors: active) {
      --no-alt-text-badge-border-color: ButtonText;
      --no-alt-text-badge-bg-color: ButtonFace;
      --no-alt-text-badge-fg-color: ButtonText;
    }

    position: absolute;
    inset-inline-end: 5px;
    inset-block-end: 5px;
    display: inline-flex;
    width: 32px;
    height: 32px;
    padding: 3px;
    justify-content: center;
    align-items: center;
    pointer-events: none;
    z-index: 1;

    border-radius: 2px;
    border: 1px solid var(--no-alt-text-badge-border-color);
    background: var(--no-alt-text-badge-bg-color);

    &::before {
      content: "";
      display: inline-block;
      width: 16px;
      height: 16px;
      mask-image: var(--new-alt-text-warning-image);
      mask-size: cover;
      background-color: var(--no-alt-text-badge-fg-color);
    }
  }
}

.annotationEditorLayer {
  :is(.freeTextEditor, .inkEditor, .stampEditor, .signatureEditor) {
    & > .resizers {
      position: absolute;
      inset: 0;

      &.hidden {
        display: none;
      }

      & > .resizer {
        width: var(--resizer-size);
        height: var(--resizer-size);
        background: content-box var(--resizer-bg-color);
        border: var(--focus-outline-around);
        border-radius: 2px;
        position: absolute;

        &.topLeft {
          top: var(--resizer-shift);
          left: var(--resizer-shift);
        }

        &.topMiddle {
          top: var(--resizer-shift);
          left: calc(50% + var(--resizer-shift));
        }

        &.topRight {
          top: var(--resizer-shift);
          right: var(--resizer-shift);
        }

        &.middleRight {
          top: calc(50% + var(--resizer-shift));
          right: var(--resizer-shift);
        }

        &.bottomRight {
          bottom: var(--resizer-shift);
          right: var(--resizer-shift);
        }

        &.bottomMiddle {
          bottom: var(--resizer-shift);
          left: calc(50% + var(--resizer-shift));
        }

        &.bottomLeft {
          bottom: var(--resizer-shift);
          left: var(--resizer-shift);
        }

        &.middleLeft {
          top: calc(50% + var(--resizer-shift));
          left: var(--resizer-shift);
        }
      }
    }
  }

  &[data-main-rotation="0"]
    :is([data-editor-rotation="0"], [data-editor-rotation="180"]),
  &[data-main-rotation="90"]
    :is([data-editor-rotation="270"], [data-editor-rotation="90"]),
  &[data-main-rotation="180"]
    :is([data-editor-rotation="180"], [data-editor-rotation="0"]),
  &[data-main-rotation="270"]
    :is([data-editor-rotation="90"], [data-editor-rotation="270"]) {
    & > .resizers > .resizer {
      &.topLeft,
      &.bottomRight {
        cursor: nwse-resize;
      }

      &.topMiddle,
      &.bottomMiddle {
        cursor: ns-resize;
      }

      &.topRight,
      &.bottomLeft {
        cursor: nesw-resize;
      }

      &.middleRight,
      &.middleLeft {
        cursor: ew-resize;
      }
    }
  }

  &[data-main-rotation="0"]
    :is([data-editor-rotation="90"], [data-editor-rotation="270"]),
  &[data-main-rotation="90"]
    :is([data-editor-rotation="0"], [data-editor-rotation="180"]),
  &[data-main-rotation="180"]
    :is([data-editor-rotation="270"], [data-editor-rotation="90"]),
  &[data-main-rotation="270"]
    :is([data-editor-rotation="180"], [data-editor-rotation="0"]) {
    & > .resizers > .resizer {
      &.topLeft,
      &.bottomRight {
        cursor: nesw-resize;
      }

      &.topMiddle,
      &.bottomMiddle {
        cursor: ew-resize;
      }

      &.topRight,
      &.bottomLeft {
        cursor: nwse-resize;
      }

      &.middleRight,
      &.middleLeft {
        cursor: ns-resize;
      }
    }
  }

  &
    :is(
      [data-main-rotation="0"] [data-editor-rotation="90"],
      [data-main-rotation="90"] [data-editor-rotation="0"],
      [data-main-rotation="180"] [data-editor-rotation="270"],
      [data-main-rotation="270"] [data-editor-rotation="180"]
    ) {
    .editToolbar {
      rotate: 270deg;

      &:dir(ltr) {
        inset-inline-end: calc(0px - var(--editor-toolbar-vert-offset));
        inset-block-start: 0;
      }

      &:dir(rtl) {
        inset-inline-end: calc(100% + var(--editor-toolbar-vert-offset));
        inset-block-start: 0;
      }
    }
  }

  &
    :is(
      [data-main-rotation="0"] [data-editor-rotation="180"],
      [data-main-rotation="90"] [data-editor-rotation="90"],
      [data-main-rotation="180"] [data-editor-rotation="0"],
      [data-main-rotation="270"] [data-editor-rotation="270"]
    ) {
    .editToolbar {
      rotate: 180deg;
      inset-inline-end: 100%;
      inset-block-start: calc(0pc - var(--editor-toolbar-vert-offset));
    }
  }

  &
    :is(
      [data-main-rotation="0"] [data-editor-rotation="270"],
      [data-main-rotation="90"] [data-editor-rotation="180"],
      [data-main-rotation="180"] [data-editor-rotation="90"],
      [data-main-rotation="270"] [data-editor-rotation="0"]
    ) {
    .editToolbar {
      rotate: 90deg;

      &:dir(ltr) {
        inset-inline-end: calc(100% + var(--editor-toolbar-vert-offset));
        inset-block-start: 100%;
      }

      &:dir(rtl) {
        inset-inline-start: calc(0px - var(--editor-toolbar-vert-offset));
        inset-block-start: 0;
      }
    }
  }
}

.dialog.altText {
  &::backdrop {
    /* This is needed to avoid to darken the image the user want to describe. */
    mask: url(#alttext-manager-mask);
  }

  /* See alt_text_manager.js */
  &.positioned {
    margin: 0;
  }

  & #altTextContainer {
    width: 300px;
    height: fit-content;
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;

    & #overallDescription {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      align-self: stretch;

      & span {
        align-self: stretch;
      }

      & .title {
        font-size: 13px;
        font-style: normal;
        font-weight: 590;
      }
    }

    & #addDescription {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;

      & .descriptionArea {
        flex: 1;
        padding-inline: 24px 10px;

        textarea {
          width: 100%;
          min-height: 75px;
        }
      }
    }

    & #buttons {
      display: flex;
      justify-content: flex-end;
      align-items: flex-start;
      gap: 8px;
      align-self: stretch;
    }
  }
}

.dialog.newAltText {
  --new-alt-text-ai-disclaimer-icon: url(images/altText_disclaimer.svg);
  --new-alt-text-spinner-icon: url(images/altText_spinner.svg);
  --preview-image-bg-color: light-dark(#f0f0f4, #2b2a33);
  --preview-image-border: none;

  @media screen and (forced-colors: active) {
    --preview-image-bg-color: ButtonFace;
    --preview-image-border: 1px solid ButtonText;
  }

  width: 80%;
  max-width: 570px;
  min-width: 300px;
  padding: 0;

  &.noAi {
    #newAltTextDisclaimer,
    #newAltTextCreateAutomatically {
      display: none !important;
    }
  }

  &.aiInstalling {
    #newAltTextCreateAutomatically {
      display: none !important;
    }
    #newAltTextDownloadModel {
      display: flex !important;
    }
  }

  &.error {
    #newAltTextNotNow {
      display: none !important;
    }

    #newAltTextCancel {
      display: inline-block !important;
    }
  }

  &:not(.error) #newAltTextError {
    display: none !important;
  }

  #newAltTextContainer {
    display: flex;
    width: auto;
    padding: 16px;
    flex-direction: column;
    justify-content: flex-end;
    align-items: flex-start;
    gap: 12px;
    flex: 0 1 auto;
    line-height: normal;

    #mainContent {
      display: flex;
      justify-content: flex-end;
      align-items: flex-start;
      gap: 12px;
      align-self: stretch;
      flex: 1 1 auto;

      #descriptionAndSettings {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
        flex: 1 0 0;
        align-self: stretch;
      }

      #descriptionInstruction {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        align-self: stretch;
        flex: 1 1 auto;

        #newAltTextDescriptionContainer {
          width: 100%;
          height: 70px;
          position: relative;

          textarea {
            width: 100%;
            height: 100%;
            padding: 8px;

            &::placeholder {
              color: var(--text-secondary-color);
            }
          }

          .altTextSpinner {
            display: none;
            position: absolute;
            width: 16px;
            height: 16px;
            inset-inline-start: 8px;
            inset-block-start: 8px;
            mask-size: cover;
            background-color: var(--text-secondary-color);
            pointer-events: none;
          }

          &.loading {
            textarea::placeholder {
              color: transparent;
            }

            .altTextSpinner {
              display: inline-block;
              mask-image: var(--new-alt-text-spinner-icon);
            }
          }
        }

        #newAltTextDescription {
          font-size: 11px;
        }

        #newAltTextDisclaimer {
          display: flex;
          flex-direction: row;
          align-items: flex-start;
          gap: 4px;
          font-size: 11px;

          &::before {
            content: "";
            display: inline-block;
            width: 17px;
            height: 16px;
            mask-image: var(--new-alt-text-ai-disclaimer-icon);
            mask-size: cover;
            background-color: var(--text-secondary-color);
            flex: 1 0 auto;
          }
        }
      }

      #newAltTextDownloadModel {
        display: flex;
        align-items: center;
        gap: 4px;
        align-self: stretch;

        &::before {
          content: "";
          display: inline-block;
          width: 16px;
          height: 16px;
          mask-image: var(--new-alt-text-spinner-icon);
          mask-size: cover;
          background-color: var(--text-secondary-color);
        }
      }

      #newAltTextImagePreview {
        width: 180px;
        aspect-ratio: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        flex: 0 0 auto;
        background-color: var(--preview-image-bg-color);
        border: var(--preview-image-border);

        > canvas {
          max-width: 100%;
          max-height: 100%;
        }
      }
    }
  }
}

.colorPicker {
  --hover-outline-color: light-dark(#0250bb, #80ebff);
  --selected-outline-color: light-dark(#0060df, #aaf2ff);
  --swatch-border-color: light-dark(#cfcfd8, #52525e);

  @media screen and (forced-colors: active) {
    --hover-outline-color: Highlight;
    --selected-outline-color: var(--hover-outline-color);
    --swatch-border-color: ButtonText;
  }

  .swatch {
    width: 16px;
    height: 16px;
    border: 1px solid var(--swatch-border-color);
    border-radius: 100%;
    outline-offset: 2px;
    box-sizing: border-box;
    forced-color-adjust: none;
  }

  button:is(:hover, .selected) > .swatch {
    border: none;
  }
}

.annotationEditorLayer {
  &[data-main-rotation="0"] {
    .highlightEditor:not(.free) > .editToolbar {
      rotate: 0deg;
    }
  }

  &[data-main-rotation="90"] {
    .highlightEditor:not(.free) > .editToolbar {
      rotate: 270deg;
    }
  }

  &[data-main-rotation="180"] {
    .highlightEditor:not(.free) > .editToolbar {
      rotate: 180deg;
    }
  }

  &[data-main-rotation="270"] {
    .highlightEditor:not(.free) > .editToolbar {
      rotate: 90deg;
    }
  }

  .highlightEditor {
    position: absolute;
    background: transparent;
    z-index: 1;
    cursor: auto;
    max-width: 100%;
    max-height: 100%;
    border: none;
    outline: none;
    pointer-events: none;
    transform-origin: 0 0;

    &:not(.free) {
      transform: none;
    }

    .internal {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: auto;
    }

    &.disabled .internal {
      pointer-events: none;
    }

    &.selectedEditor {
      .internal {
        cursor: pointer;
      }
    }

    .editToolbar {
      --editor-toolbar-colorpicker-arrow-image: url(images/toolbarButton-menuArrow.svg);

      transform-origin: center !important;

      .buttons {
        .colorPicker {
          position: relative;
          width: auto;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 4px;
          padding: 4px;

          &::after {
            content: "";
            mask-image: var(--editor-toolbar-colorpicker-arrow-image);
            mask-repeat: no-repeat;
            mask-position: center;
            display: inline-block;
            background-color: var(--editor-toolbar-fg-color);
            width: 12px;
            height: 12px;
          }

          &:hover::after {
            background-color: var(--editor-toolbar-hover-fg-color);
          }

          &:has(.dropdown:not(.hidden)) {
            background-color: var(--editor-toolbar-hover-bg-color);

            &::after {
              scale: -1;
            }
          }

          .dropdown {
            position: absolute;
            display: flex;
            justify-content: center;
            align-items: center;
            flex-direction: column;
            gap: 11px;
            padding-block: 8px;
            border-radius: 6px;
            background-color: var(--editor-toolbar-bg-color);
            border: 1px solid var(--editor-toolbar-border-color);
            box-shadow: var(--editor-toolbar-shadow);
            inset-block-start: calc(100% + 4px);
            width: calc(100% + 2 * var(--editor-toolbar-padding));

            button {
              width: 100%;
              height: auto;
              border: none;
              cursor: pointer;
              display: flex;
              justify-content: center;
              align-items: center;
              background: none;

              &:is(:active, :focus-visible) {
                outline: none;
              }

              > .swatch {
                outline-offset: 2px;
              }

              &[aria-selected="true"] > .swatch {
                outline: 2px solid var(--selected-outline-color);
              }

              &:is(:hover, :active, :focus-visible) > .swatch {
                outline: 2px solid var(--hover-outline-color);
              }
            }
          }
        }
      }
    }
  }
}

.editorParamsToolbar:has(#highlightParamsToolbarContainer) {
  padding: unset;
}

#highlightParamsToolbarContainer {
  gap: 16px;
  padding-inline: 10px;
  padding-block-end: 12px;

  .colorPicker {
    display: flex;
    flex-direction: column;
    gap: 8px;

    .dropdown {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-direction: row;
      height: auto;

      button {
        width: auto;
        height: auto;
        border: none;
        cursor: pointer;
        display: flex;
        justify-content: center;
        align-items: center;
        background: none;
        flex: 0 0 auto;
        padding: 0;

        .swatch {
          width: 24px;
          height: 24px;
        }

        &:is(:active, :focus-visible) {
          outline: none;
        }

        &[aria-selected="true"] > .swatch {
          outline: 2px solid var(--selected-outline-color);
        }

        &:is(:hover, :active, :focus-visible) > .swatch {
          outline: 2px solid var(--hover-outline-color);
        }
      }
    }
  }

  #editorHighlightThickness {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    align-self: stretch;

    .editorParamsLabel {
      height: auto;
      align-self: stretch;
    }

    .thicknessPicker {
      display: flex;
      justify-content: space-between;
      align-items: center;
      align-self: stretch;

      --example-color: light-dark(#bfbfc9, #80808e);

      @media screen and (forced-colors: active) {
        --example-color: CanvasText;
      }

      :is(& > .editorParamsSlider[disabled]) {
        opacity: 0.4;
      }

      &::before,
      &::after {
        content: "";
        width: 8px;
        aspect-ratio: 1;
        display: block;
        border-radius: 100%;
        background-color: var(--example-color);
      }
      &::after {
        width: 24px;
      }

      .editorParamsSlider {
        width: unset;
        height: 14px;
      }
    }
  }

  #editorHighlightVisibility {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    align-self: stretch;

    .divider {
      --divider-color: light-dark(#d7d7db, #8f8f9d);

      @media screen and (forced-colors: active) {
        --divider-color: CanvasText;
      }

      margin-block: 4px;
      width: 100%;
      height: 1px;
      background-color: var(--divider-color);
    }

    .toggler {
      display: flex;
      justify-content: space-between;
      align-items: center;
      align-self: stretch;
    }
  }
}

#altTextSettingsDialog {
  padding: 16px;

  #altTextSettingsContainer {
    display: flex;
    width: 573px;
    flex-direction: column;
    gap: 16px;

    .mainContainer {
      gap: 16px;
    }

    .description {
      color: var(--text-secondary-color);
    }

    #aiModelSettings {
      display: flex;
      flex-direction: column;
      gap: 12px;

      button {
        width: fit-content;
      }

      &.download {
        #deleteModelButton {
          display: none;
        }
      }

      &:not(.download) {
        #downloadModelButton {
          display: none;
        }
      }
    }

    #automaticAltText,
    #altTextEditor {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    #createModelDescription,
    #aiModelSettings,
    #showAltTextDialogDescription {
      padding-inline-start: 40px;
    }

    #automaticSettings {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   手写笔迹：不显示任何「选中框 / 缩放手柄」
   ───────────────────────────────────────────────────────────────────────
   真机（小米平板 0.3.0）实测：pdf.js 在 INK 模式下画完一笔会把编辑器留在
   选择集里（unselectAll() 在编辑模式下不清选择集 —— 见 ink-engine.ts
   clearSelection 的注释），于是每一笔都带一圈 Highlight 描边；
   相邻几笔连起来看就是「一整片选区框把几笔串起来」。

   用户明确要求：手写时不要出现任何选区框，要框选请用套索工具。
   套索的选择虚线框由 ink-lasso.ts 自绘，不受此处影响。

   放在本表最末：平铺后与官方 .annotationEditorLayer :is(.inkEditor, …)
   特异性相同（0,2,0），靠「后出现者胜出」压掉官方的 border / ::before 描边，
   另用 !important 兜住 .resizers 手柄的 display。
   ═══════════════════════════════════════════════════════════════════════ */
.annotationEditorLayer .inkEditor,
.annotationEditorLayer .inkEditor.selectedEditor {
  border: none !important;
  outline: none !important;
}

.annotationEditorLayer .inkEditor::before,
.annotationEditorLayer .inkEditor.selectedEditor::before {
  content: none !important;
}

.annotationEditorLayer .inkEditor > .resizers {
  display: none !important;
}
`;

/** 三张表的拼接结果（基础定位在前，官方表在后以便覆盖）。 */
export function getInkStylesSource(): string {
  return `${LAYER_BASE_CSS}\n${DRAW_LAYER_CSS}\n${EDITOR_LAYER_CSS}`;
}
