import {
  Editor,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
} from "obsidian";
import type { ReviewCommentsSettings } from "./src/types";
import { DEFAULT_SETTINGS, TYPES, VIEW_TYPE_COMMENTS } from "./src/types";
import {
  COMMENT_REGEX,
  escapeMultiline,
  formatDate,
  parseMeta,
  sanitizeAuthor,
  unescapeMultiline,
} from "./src/criticmarkup";
import {
  CommentInputModal,
  appendCommentBubble,
  closeAllCommentPopovers,
  renderIntoInlineContext,
} from "./src/ui/comment-bubble";
import { createCommentDecorationExtension } from "./src/editor-extension";
import { CommentsView, ReviewCommentsSettingTab } from "./src/views";

/** compositionend後、compositionstartが即座に再発火しないか待つグレース期間(ms) */
const COMPOSITION_END_GRACE_MS = 150;

export default class ReviewCommentsPlugin extends Plugin {
  settings: ReviewCommentsSettings = DEFAULT_SETTINGS;
  floatingBar: HTMLDivElement | null = null;
  selectionDebounce: number | null = null;
  /** 日本語入力などIME変換中はtrue。変換候補の下線がDOM選択として拾われてしまうのを避ける */
  isComposing: boolean = false;
  /** compositionend後にisComposingをfalseへ戻す猶予タイマーのID */
  compositionEndGrace: number | null = null;
  /** 直後にwidget化される新規コメントの開始オフセット（1回だけ消費してpulse演出を出す） */
  pendingPulseOffset: number | null = null;

  async onload() {
    console.log("[ReviewComments] onload");
    await this.loadSettings();

    for (const t of TYPES) {
      this.addCommand({
        id: `add-comment-${t.id}`,
        name: `Add ${t.label} comment ${t.icon} to selection`,
        editorCallback: (editor: Editor) =>
          this.addCommentToSelection(editor, t.tag),
      });
    }

    this.addCommand({
      id: "open-comments-panel",
      name: "Open comments panel",
      callback: () => this.activateView(),
    });

    this.addRibbonIcon("message-circle", "Review Comments", () => {
      this.activateView();
    });

    this.registerView(
      VIEW_TYPE_COMMENTS,
      (leaf) => new CommentsView(leaf, this)
    );

    this.registerEditorExtension([createCommentDecorationExtension(this)]);

    this.registerMarkdownPostProcessor((el, ctx) =>
      this.renderCommentsInReadingMode(el, ctx)
    );

    this.registerDomEvent(document, "click", (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(".review-comment-anchor")) {
        closeAllCommentPopovers();
      }
    });

    this.setupFloatingBar();
    this.addSettingTab(new ReviewCommentsSettingTab(this.app, this));
  }

  onunload() {
    console.log("[ReviewComments] onunload");
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_COMMENTS);
    if (this.floatingBar) {
      this.floatingBar.remove();
      this.floatingBar = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  escapeCommentBody(body: string): string {
    return body.replace(/<<}/g, "<< }");
  }

  addCommentToSelection(editor: Editor, typeTag: string = "NOTE") {
    const rawSelection = editor.getSelection();

    // 行全体を選択した場合など前後の改行が選択に含まれていると、その改行を
    // {==...==}の中に埋め込んでしまい、本来その改行が担っていた前後行との
    // 区切りがreplaceRangeで消費されて隣接行と結合してしまう。前後の改行は
    // 選択から除外する（先に先頭を切り出してから残りの末尾を判定することで、
    // 改行だけの選択で前後の除去量が重複するのを避ける）。
    const leadingNewline = rawSelection.match(/^\n+/)?.[0] ?? "";
    const rest = rawSelection.slice(leadingNewline.length);
    const trailingNewline = rest.match(/\n+$/)?.[0] ?? "";
    const selection = trailingNewline
      ? rest.slice(0, -trailingNewline.length)
      : rest;

    if (!selection) {
      new Notice("先にテキストを選択してください");
      return;
    }
    if (
      selection.includes("{==") ||
      selection.includes("==}") ||
      selection.includes("{>>") ||
      selection.includes("<<}")
    ) {
      new Notice("選択範囲に既にコメント記法が含まれています");
      return;
    }

    const fromOffset =
      editor.posToOffset(editor.getCursor("from")) + leadingNewline.length;
    const toOffset =
      editor.posToOffset(editor.getCursor("to")) - trailingNewline.length;
    const from = editor.offsetToPos(fromOffset);
    const to = editor.offsetToPos(toOffset);

    new CommentInputModal(this.app, typeTag, (body) => {
      const date = formatDate(new Date(), this.settings.dateFormat);
      const author = sanitizeAuthor(this.settings.authorName);
      const commentBody = this.escapeCommentBody(
        escapeMultiline(body.trim() || "コメントを書く")
      );
      const wrapped = `{==${escapeMultiline(selection)}==}{>>${author}|${date}|${typeTag}: ${commentBody}<<}`;
      const insertOffset = fromOffset;
      editor.replaceRange(wrapped, from, to);
      this.pendingPulseOffset = insertOffset;
      this.placeCaretAfterInsertion(editor, insertOffset, wrapped);
      this.hideFloatingBar();
      editor.focus();
    }).open();
  }

  /**
   * コメント挿入直後は選択範囲がハイライト全体を覆ったままになる。選択を
   * キャレットだけの状態にリセットし、挿入した記法の直後に置く。
   * focus-aware判定（createCommentDecorationExtension）は範囲の境界に接し
   * ているだけでは「中」とみなさないので、このキャレット位置ならwidget化
   * された表示（rendered mode）のまま保たれる。
   */
  placeCaretAfterInsertion(
    editor: Editor,
    insertOffset: number,
    wrapped: string
  ) {
    const insertEndPos = editor.offsetToPos(insertOffset + wrapped.length);
    editor.setSelection(insertEndPos, insertEndPos);
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_COMMENTS);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_COMMENTS, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  setupFloatingBar() {
    const bar = document.createElement("div");
    bar.className = "review-comment-floating-bar";
    bar.style.display = "none";
    document.body.appendChild(bar);
    this.floatingBar = bar;

    for (const t of TYPES) {
      const btn = document.createElement("button");
      btn.className = "review-comment-type-btn";
      btn.title = `${t.label} (insert ${t.tag})`;
      btn.innerHTML = `<span class="rc-icon">${t.icon}</span><span class="rc-label">${t.label}</span>`;
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mdView && mdView.editor.getSelection()) {
          this.addCommentToSelection(mdView.editor, t.tag);
        }
        this.hideFloatingBar();
      });
      bar.appendChild(btn);
    }

    this.registerDomEvent(document, "selectionchange", () => {
      if (this.isComposing) return;
      if (this.selectionDebounce !== null) {
        window.clearTimeout(this.selectionDebounce);
      }
      this.selectionDebounce = window.setTimeout(
        () => this.updateFloatingBar(),
        80
      );
    });

    // IME変換中は候補文字列がDOM上「選択」として見え、selectionchangeが発火して
    // バーがちらつく。compositionstart〜compositionendの間は強制的に隠す。
    // スペースキーでの変換候補選択時などはcompositionendの直後にcompositionstart
    // が即座に再発火することがあるため、compositionendはグレース期間を置いてから
    // 反映し、その間に次のcompositionstart/updateが来たら「継続中」とみなす。
    const clearCompositionEndGrace = () => {
      if (this.compositionEndGrace === null) return;
      window.clearTimeout(this.compositionEndGrace);
      this.compositionEndGrace = null;
    };

    const enterComposing = () => {
      clearCompositionEndGrace();
      this.isComposing = true;
      this.hideFloatingBar();
    };

    this.registerDomEvent(document, "compositionstart", enterComposing);
    this.registerDomEvent(document, "compositionupdate", enterComposing);

    this.registerDomEvent(document, "compositionend", () => {
      clearCompositionEndGrace();
      this.compositionEndGrace = window.setTimeout(() => {
        this.compositionEndGrace = null;
        this.isComposing = false;
        this.updateFloatingBar();
      }, COMPOSITION_END_GRACE_MS);
    });

    this.registerDomEvent(window, "scroll", () => this.hideFloatingBar(), {
      capture: true,
    });

    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") this.hideFloatingBar();
    });
  }

  updateFloatingBar() {
    if (!this.floatingBar) return;

    if (this.isComposing) {
      this.hideFloatingBar();
      return;
    }

    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) {
      this.hideFloatingBar();
      return;
    }

    const selText = mdView.editor.getSelection();
    if (!selText) {
      this.hideFloatingBar();
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.hideFloatingBar();
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideFloatingBar();
      return;
    }

    const bar = this.floatingBar;
    bar.style.display = "flex";
    const barWidth = bar.offsetWidth || 280;
    const barHeight = bar.offsetHeight || 36;

    let left = rect.left;
    let top = rect.top - barHeight - 8;

    if (left + barWidth > window.innerWidth - 8) {
      left = window.innerWidth - barWidth - 8;
    }
    if (left < 8) left = 8;
    if (top < 8) {
      top = rect.bottom + 6;
    }

    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  hideFloatingBar() {
    if (this.floatingBar) {
      this.floatingBar.style.display = "none";
    }
  }

  async renderCommentsInReadingMode(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) {
    // MarkdownRendererに渡すComponentはel専属のMarkdownRenderChildにする。
    // ctx.addChild()に登録しておくと、このブロックがDOMから外れた（編集で
    // 再レンダリングされた等）タイミングで自動的にunloadされ、pluginを
    // componentとして使い回すよりも子コンポーネントが蓄積しない。
    const renderChild = new MarkdownRenderChild(el);
    ctx.addChild(renderChild);
    const renderTasks: Promise<void>[] = [];

    // ブロック全体がちょうど1つのCriticMarkupコメントのケース（見出し行等を
    // まるごとコメントで囲んだ場合）。ハイライト部分を独立してMarkdown再レン
    // ダリングすることで、通常のMarkdown構文解析の外側にいても見出し等が正し
    // く描画されるようにする。
    const wholeBlockRegex = new RegExp(`^${COMMENT_REGEX.source}$`);
    const blockCandidates = Array.from(
      el.querySelectorAll("p, li, td, th, blockquote")
    ).filter((elm) => elm.children.length === 0);

    for (const blockEl of blockCandidates) {
      const m = (blockEl.textContent || "").match(wholeBlockRegex);
      if (!m) continue;

      const meta = parseMeta(m[2]);
      const highlighted = unescapeMultiline(m[1]);
      const replaced = document.createElement("div");
      replaced.className = "review-comment-block";

      const content = replaced.createDiv({ cls: "review-comment-block-content" });
      renderTasks.push(
        renderIntoInlineContext(this.app, highlighted, content, ctx.sourcePath, renderChild)
      );

      appendCommentBubble(replaced, meta, () =>
        this.deleteCommentInFile(ctx.sourcePath, m[0], highlighted)
      );
      blockEl.replaceWith(replaced);
    }

    // 表セル内の値など、ブロックの一部だけがCriticMarkupのケース。
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text);
    }

    for (const tn of textNodes) {
      const text = tn.textContent || "";
      if (text.indexOf("{==") === -1) continue;

      const regex = new RegExp(COMMENT_REGEX);
      let m: RegExpExecArray | null;
      let lastIndex = 0;
      const frag = document.createDocumentFragment();
      let matched = false;

      while ((m = regex.exec(text))) {
        matched = true;
        if (m.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
        }

        const meta = parseMeta(m[2]);
        const fullMatch = m[0];
        const highlighted = unescapeMultiline(m[1]);
        const span = document.createElement("span");
        span.className = "review-comment-highlight";

        const content = span.createSpan({ cls: "review-comment-highlight-content" });
        renderTasks.push(
          renderIntoInlineContext(this.app, highlighted, content, ctx.sourcePath, renderChild)
        );

        appendCommentBubble(span, meta, () =>
          this.deleteCommentInFile(ctx.sourcePath, fullMatch, highlighted)
        );
        frag.appendChild(span);
        lastIndex = m.index + m[0].length;
      }

      if (!matched) continue;
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      tn.parentNode?.replaceChild(frag, tn);
    }

    await Promise.all(renderTasks);
  }

  /**
   * Reading View用の削除処理。post-processorには編集中のEditorインスタンス
   * が渡ってこないため、ファイルを直接読み書きする（Vault.processでアトミッ
   * クに読み込み→置換→保存する）。
   */
  async deleteCommentInFile(
    sourcePath: string,
    fullMatch: string,
    highlighted: string
  ) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    await this.app.vault.process(file, (data) =>
      data.replace(fullMatch, highlighted)
    );
  }
}
