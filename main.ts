import {
  App,
  Component,
  Editor,
  ItemView,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  editorInfoField,
  setIcon,
} from "obsidian";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

interface ReviewCommentsSettings {
  authorName: string;
  dateFormat: "iso" | "japanese";
}

const DEFAULT_SETTINGS: ReviewCommentsSettings = {
  authorName: "you",
  dateFormat: "iso",
};

const COMMENT_REGEX = /\{==([\s\S]+?)==\}\{>>([\s\S]+?)<<\}/g;
const VIEW_TYPE_COMMENTS = "review-comments-view";

const TYPES: { id: string; tag: string; label: string; icon: string; lucide: string }[] = [
  { id: "ask", tag: "ASK", label: "Ask", icon: "❓", lucide: "help-circle" },
  { id: "edit", tag: "EDIT", label: "Edit", icon: "✏️", lucide: "pencil" },
  { id: "praise", tag: "PRAISE", label: "Praise", icon: "👍", lucide: "thumbs-up" },
  { id: "note", tag: "NOTE", label: "Note", icon: "💬", lucide: "message-circle" },
];

// 吹き出しボタンはテーマに追従するLucideアイコンを使う（絵文字はOS依存でテーマ色に馴染まないため）
const TYPE_META: Record<string, { icon: string; lucide: string }> = TYPES.reduce(
  (acc, t) => {
    acc[t.tag] = { icon: t.icon, lucide: t.lucide };
    return acc;
  },
  {} as Record<string, { icon: string; lucide: string }>
);

interface ParsedMeta {
  author: string;
  date: string;
  type: string;
  body: string;
}

class CommentInputModal extends Modal {
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

function parseMeta(meta: string): ParsedMeta {
  const newFmt = meta.match(/^([^|]+)\|([^|]+)\|([A-Z]+):\s*([\s\S]*)$/);
  if (newFmt) {
    return {
      author: newFmt[1].trim(),
      date: newFmt[2].trim(),
      type: newFmt[3].trim(),
      body: newFmt[4].trim(),
    };
  }

  const oldFmt = meta.match(/^([^|]+)\|([^|:]+):\s*([\s\S]*)$/);
  if (oldFmt) {
    return {
      author: oldFmt[1].trim(),
      date: oldFmt[2].trim(),
      type: "NOTE",
      body: oldFmt[3].trim(),
    };
  }

  return { author: "", date: "", type: "NOTE", body: meta };
}

/**
 * MarkdownRenderer.render は常にブロック要素でラップして返すため、
 * ハイライト対象が単一の <p> になっている場合はその中身だけ展開して
 * インライン文脈（表セル・見出し以外の地の文など）に自然に溶け込ませる。
 * 見出し・リスト等のブロック構文はそのまま挿入する。
 */
async function renderIntoInlineContext(
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
function appendCommentBubble(
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

function closeAllCommentPopovers() {
  document
    .querySelectorAll(".review-comment-bubble-popover.is-open")
    .forEach((el) => el.removeClass("is-open"));
}

class CommentWidget extends WidgetType {
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

export default class ReviewCommentsPlugin extends Plugin {
  settings: ReviewCommentsSettings = DEFAULT_SETTINGS;
  floatingBar: HTMLDivElement | null = null;
  selectionDebounce: number | null = null;
  /** 日本語入力などIME変換中はtrue。変換候補の下線がDOM選択として拾われてしまうのを避ける */
  isComposing: boolean = false;
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
    const selection = editor.getSelection();
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

    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    new CommentInputModal(this.app, typeTag, (body) => {
      const date = formatDate(new Date(), this.settings.dateFormat);
      const author = sanitizeAuthor(this.settings.authorName);
      const commentBody = this.escapeCommentBody(
        body.trim() || "コメントを書く"
      );
      const wrapped = `{==${selection}==}{>>${author}|${date}|${typeTag}: ${commentBody}<<}`;
      const insertOffset = editor.posToOffset(from);
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
    this.registerDomEvent(document, "compositionstart", () => {
      this.isComposing = true;
      this.hideFloatingBar();
    });

    this.registerDomEvent(document, "compositionend", () => {
      this.isComposing = false;
      if (this.selectionDebounce !== null) {
        window.clearTimeout(this.selectionDebounce);
      }
      this.selectionDebounce = window.setTimeout(
        () => this.updateFloatingBar(),
        80
      );
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
      const replaced = document.createElement("div");
      replaced.className = "review-comment-block";

      const content = replaced.createDiv({ cls: "review-comment-block-content" });
      renderTasks.push(
        renderIntoInlineContext(this.app, m[1], content, ctx.sourcePath, renderChild)
      );

      appendCommentBubble(replaced, meta, () =>
        this.deleteCommentInFile(ctx.sourcePath, m[0], m[1])
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
        const highlighted = m[1];
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

function sanitizeAuthor(name: string): string {
  const trimmed = (name || "").trim();
  const stripped = trimmed.replace(/[|<>{}=]/g, "_");
  return stripped || "you";
}

function formatDate(d: Date, format: "iso" | "japanese"): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  if (format === "japanese") return `${y}年${m}月${day}日`;
  return `${y}-${m}-${day}`;
}

function createCommentDecorationExtension(plugin: ReviewCommentsPlugin) {
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

          if (cursorInside) {
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
                  m[1],
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

class CommentsView extends ItemView {
  plugin: ReviewCommentsPlugin;
  lastMarkdownView: MarkdownView | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ReviewCommentsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_COMMENTS;
  }

  getDisplayText() {
    return "Review Comments";
  }

  getIcon() {
    return "message-circle";
  }

  async onOpen() {
    this.renderComments();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.renderComments())
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.renderComments())
    );
  }

  async onClose() {}

  getMarkdownView(): MarkdownView | null {
    const activeMdView =
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeMdView) {
      this.lastMarkdownView = activeMdView;
      return activeMdView;
    }

    if (
      this.lastMarkdownView &&
      this.plugin.app.workspace
        .getLeavesOfType("markdown")
        .some((leaf) => leaf.view === this.lastMarkdownView)
    ) {
      return this.lastMarkdownView;
    }

    this.lastMarkdownView = null;
    return null;
  }

  jumpTo(mdView: MarkdownView, offset: number, length: number) {
    this.plugin.app.workspace.setActiveLeaf(mdView.leaf, { focus: true });
    const editor = mdView.editor;
    const pos = editor.offsetToPos(offset);
    const endPos = editor.offsetToPos(offset + length);
    editor.setSelection(pos, endPos);
    editor.scrollIntoView({ from: pos, to: endPos }, true);
    editor.focus();
  }

  renderComments() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    new Setting(container).setName("Review Comments").setHeading();

    const mdView = this.getMarkdownView();
    if (!mdView) {
      container.createEl("p", {
        text: "マークダウンファイルを開いてください",
      });
      return;
    }

    const text = mdView.editor.getValue();
    const regex = new RegExp(COMMENT_REGEX);
    type Match = {
      highlighted: string;
      meta: ParsedMeta;
      rawMeta: string;
      offset: number;
      full: string;
    };
    const matches: Match[] = [];
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text))) {
      matches.push({
        highlighted: m[1],
        meta: parseMeta(m[2]),
        rawMeta: m[2],
        offset: m.index,
        full: m[0],
      });
    }

    if (matches.length === 0) {
      container.createEl("p", {
        text: "コメントはまだありません。テキストを選択して上に出るバーから種類を選んでください。",
        cls: "review-comment-empty",
      });
      return;
    }

    matches.forEach((match) => {
      const card = container.createDiv({ cls: "review-comment-card" });
      card.dataset.type = match.meta.type;

      const header = card.createDiv({ cls: "review-comment-card-header" });
      const icon = header.createSpan({ cls: "review-comment-card-icon" });
      icon.textContent = TYPE_META[match.meta.type]?.icon || "💬";
      const meta = header.createSpan({ cls: "review-comment-card-meta" });
      meta.textContent = `${match.meta.author} · ${match.meta.date}`;

      const original = card.createDiv({ cls: "review-comment-card-original" });
      original.textContent = `"${match.highlighted}"`;

      const body = card.createDiv({ cls: "review-comment-card-body" });
      body.textContent = match.meta.body;

      const actions = card.createDiv({ cls: "review-comment-card-actions" });
      const jumpBtn = actions.createEl("button", {
        text: "Jump",
        cls: "review-comment-action-btn",
      });
      jumpBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.jumpTo(mdView, match.offset, match.full.length);
      });

      const resolveBtn = actions.createEl("button", {
        text: "Resolve",
        cls: "review-comment-action-btn review-comment-resolve-btn",
      });
      resolveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const editor = mdView.editor;
        const value = editor.getValue();
        const newValue = value.replace(match.full, match.highlighted);
        editor.setValue(newValue);
        this.renderComments();
      });

      card.addEventListener("click", () => {
        this.jumpTo(mdView, match.offset, match.full.length);
      });
    });
  }
}

class ReviewCommentsSettingTab extends PluginSettingTab {
  plugin: ReviewCommentsPlugin;

  constructor(app: App, plugin: ReviewCommentsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Author name")
      .setDesc("コメントに記録される名前")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorName)
          .onChange(async (value) => {
            this.plugin.settings.authorName = value || "you";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Date format")
      .addDropdown((dd) =>
        dd
          .addOption("iso", "2026-05-13")
          .addOption("japanese", "2026年05月13日")
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (value: string) => {
            this.plugin.settings.dateFormat = value as "iso" | "japanese";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "コメント種別" });
    const list = containerEl.createEl("ul");
    for (const t of TYPES) {
      const li = list.createEl("li");
      li.textContent = `${t.icon} ${t.label} → タグ: ${t.tag}（コマンド: Add ${t.label} comment）`;
    }

    containerEl.createEl("p", {
      text: "各タイプは個別コマンドとして登録されているので、設定→ホットキーで好きなショートカットを割り当てられます。",
      cls: "setting-item-description",
    });
  }
}
