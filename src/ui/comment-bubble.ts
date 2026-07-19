import { App, Component, MarkdownRenderer, Modal, setIcon } from "obsidian";
import type { ParsedMeta } from "../types";
import { TYPE_META } from "../types";

export class CommentInputModal extends Modal {
  private readonly typeTag: string;
  private readonly onSubmit: (body: string) => void;

  constructor(app: App, typeTag: string, onSubmit: (body: string) => void) {
    super(app);
    this.typeTag = typeTag;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("review-comment-modal");
    this.setTitle(`Add ${this.typeTag} comment`);

    contentEl.createEl("p", {
      text: "複数行や箇条書きもそのまま入力できます。",
      cls: "review-comment-modal-help",
    });

    const textarea = contentEl.createEl("textarea", {
      cls: "review-comment-modal-textarea",
    });
    textarea.placeholder = "例:\n1. ここを修正したい\n・理由\n・補足";

    const actions = contentEl.createDiv({
      cls: "review-comment-modal-actions",
    });
    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "mod-muted",
    });
    const submitBtn = actions.createEl("button", {
      text: "Add comment",
      cls: "mod-cta",
    });

    cancelBtn.addEventListener("click", () => this.close());
    submitBtn.addEventListener("click", () => this.submit(textarea.value));
    textarea.addEventListener("keydown", (evt: KeyboardEvent) => {
      if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
        evt.preventDefault();
        this.submit(textarea.value);
      }
    });

    window.setTimeout(() => textarea.focus(), 0);
  }

  private submit(body: string) {
    this.onSubmit(body);
    this.close();
  }
}

/**
 * MarkdownRenderer.render は常にブロック要素でラップして返すため、
 * ハイライト対象が単一の <p> になっている場合はその中身だけ展開して
 * インライン文脈（表セル・見出し以外の地の文など）に自然に溶け込ませる。
 * 見出し・リスト等のブロック構文はそのまま挿入する（表示はCSS側で
 * display: inline に上書きし、同じ行に流し込む）。
 */
export async function renderIntoInlineContext(
  app: App,
  markdown: string,
  target: HTMLElement,
  sourcePath: string,
  component: Component
) {
  const tmp = document.createElement("div");
  await MarkdownRenderer.render(app, markdown, tmp, sourcePath, component);
  if (tmp.children.length === 1 && tmp.firstElementChild?.tagName === "P") {
    const p = tmp.firstElementChild;
    while (p.firstChild) target.appendChild(p.firstChild);
  } else {
    while (tmp.firstChild) target.appendChild(tmp.firstChild);
  }
}

/**
 * 吹き出しボタン＋クリックで開閉するポップオーバーを container に追加する。
 * onDelete を渡すと、ポップオーバー右上に削除（×）ボタンが付き、クリックで
 * コメント記法を除去してハイライトされていたテキストだけを残す。
 */
export function appendCommentBubble(
  container: HTMLElement,
  meta: ParsedMeta,
  onDelete?: () => void
) {
  container.addClass("review-comment-anchor");
  container.dataset.type = meta.type;

  const btn = container.createEl("button", {
    cls: "review-comment-bubble-btn",
    attr: { type: "button", "aria-label": "コメントを表示" },
  });
  setIcon(btn, TYPE_META[meta.type]?.lucide || "message-circle");

  const popover = container.createDiv({ cls: "review-comment-bubble-popover" });

  if (onDelete) {
    const closeBtn = popover.createEl("button", {
      cls: "review-comment-bubble-popover-close",
      attr: { type: "button", "aria-label": "コメントを削除" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("mousedown", (e) => e.preventDefault());
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAllCommentPopovers();
      onDelete();
    });
  }

  const header = popover.createDiv({ cls: "review-comment-bubble-popover-header" });
  header.setText(`${meta.author} · ${meta.date}`);
  const body = popover.createDiv({ cls: "review-comment-bubble-popover-body" });
  body.setText(meta.body);

  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = popover.hasClass("is-open");
    closeAllCommentPopovers();
    if (!isOpen) popover.addClass("is-open");
  });
}

export function closeAllCommentPopovers() {
  document
    .querySelectorAll(".review-comment-bubble-popover.is-open")
    .forEach((el) => el.removeClass("is-open"));
}
