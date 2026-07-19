import {
  App,
  ItemView,
  MarkdownView,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import type { ParsedMeta } from "./types";
import { TYPE_META, TYPES, VIEW_TYPE_COMMENTS } from "./types";
import { COMMENT_REGEX, parseMeta, unescapeMultiline } from "./criticmarkup";
import type ReviewCommentsPlugin from "../main";

export class CommentsView extends ItemView {
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
        highlighted: unescapeMultiline(m[1]),
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

export class ReviewCommentsSettingTab extends PluginSettingTab {
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
