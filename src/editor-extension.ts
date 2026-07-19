import { App, Component, editorInfoField } from "obsidian";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { ParsedMeta } from "./types";
import { COMMENT_REGEX, parseMeta, unescapeMultiline } from "./criticmarkup";
import { appendCommentBubble, renderIntoInlineContext } from "./ui/comment-bubble";
import type ReviewCommentsPlugin from "../main";

export class CommentWidget extends WidgetType {
  // Markdown再レンダリングが登録する子コンポーネントを受け止める専用インスタンス。
  // decoration再構築のたびにwidgetは使い捨てられるため、destroy()でunloadして
  // 蓄積させない（親のPluginをcomponentとして使い回すと解放されずリークする）。
  private renderComponent: Component | null = null;

  constructor(
    private readonly highlighted: string,
    private readonly meta: ParsedMeta,
    private readonly app: App,
    private readonly sourcePath: string,
    private readonly range: { from: number; to: number },
    private readonly pulse: boolean = false
  ) {
    super();
  }

  eq(other: CommentWidget): boolean {
    // pulse は意図的に比較から除外する。挿入直後に1回だけpulseクラス付きで
    // 生成したDOM要素は、以後decorationが再構築されても使い回されてよく
    // （CSSアニメーションは1回再生されればそのまま自然に終わる）、比較に
    // 含めるとpulse終了後にDOM要素が余分に作り直されてしまう。
    return (
      other.highlighted === this.highlighted &&
      other.sourcePath === this.sourcePath &&
      other.range.from === this.range.from &&
      other.range.to === this.range.to &&
      other.meta.type === this.meta.type &&
      other.meta.author === this.meta.author &&
      other.meta.date === this.meta.date &&
      other.meta.body === this.meta.body
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "review-comment-widget";
    if (this.pulse) {
      wrapper.addClass("review-comment-widget-pulse");
    }

    this.renderComponent = new Component();
    this.renderComponent.load();

    const content = wrapper.createSpan({ cls: "review-comment-widget-content" });
    void renderIntoInlineContext(
      this.app,
      this.highlighted,
      content,
      this.sourcePath,
      this.renderComponent
    );

    appendCommentBubble(wrapper, this.meta, () => {
      view.dispatch({
        changes: {
          from: this.range.from,
          to: this.range.to,
          insert: this.highlighted,
        },
      });
    });
    return wrapper;
  }

  destroy(): void {
    this.renderComponent?.unload();
    this.renderComponent = null;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function createCommentDecorationExtension(plugin: ReviewCommentsPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const text = view.state.doc.toString();
        const regex = new RegExp(COMMENT_REGEX);
        let m: RegExpExecArray | null;
        const ranges = view.state.selection.ranges;
        const info = view.state.field(editorInfoField, false);
        const sourcePath = info?.file?.path ?? "";

        while ((m = regex.exec(text))) {
          const start = m.index;
          const end = start + m[0].length;
          // カーソル・選択範囲がこのコメントの内部に実際に入り込んでいるとき
          // だけ生のCriticMarkup記法のまま編集させる（wikilinkのconcealと同
          // じfocus-awareパターン）。境界にちょうど接しているだけ（例:挿入
          // 直後にキャレットがコメント直後にある状態）はrendered mode（widget
          // 表示）のままにする。マルチカーソルの場合は全rangeを見る。
          const cursorInside = ranges.some((r) => r.from < end && r.to > start);
          // ハイライト対象・コメント本文は挿入時にescapeMultilineで改行を
          // エスケープしているため通常ここには来ないが、外部で手書きされた
          // 記法など生の改行が残るケースへの保険。CodeMirrorのViewPlugin由来
          // のDecoration.replaceは改行をまたぐ範囲を置き換えられずRangeError
          // になるため、widget化せず生表示にフォールバックする。
          const spansMultipleLines = m[0].includes("\n");

          if (cursorInside || spansMultipleLines) {
            const highlightTextStart = start + 3;
            const highlightTextEnd = highlightTextStart + m[1].length;
            const metaStart = highlightTextEnd + 2;

            builder.add(
              highlightTextStart,
              highlightTextEnd,
              Decoration.mark({ class: "review-comment-highlight-live" })
            );
            builder.add(
              metaStart,
              end,
              Decoration.mark({ class: "review-comment-meta-live" })
            );
          } else {
            const meta = parseMeta(m[2]);
            const isPulseTarget = plugin.pendingPulseOffset === start;
            if (isPulseTarget) {
              plugin.pendingPulseOffset = null;
            }
            builder.add(
              start,
              end,
              Decoration.replace({
                widget: new CommentWidget(
                  unescapeMultiline(m[1]),
                  meta,
                  plugin.app,
                  sourcePath,
                  { from: start, to: end },
                  isPulseTarget
                ),
              })
            );
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
