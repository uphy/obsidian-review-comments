# Obsidian Review Comments

Notionスタイルのレビューコメント機能。テキスト選択でフローティングボタンが出て、コメントを書ける。
コメントは **CriticMarkup形式** で `.md` ファイルに直接保存されるため、ClaudeやGPTがそのまま読んで修正できる。

## コメント形式

```markdown
原文の{==ここ==}{>>shirai|2026-05-13: 直したい<<}に問題があります。
```

- `{==...==}` … ハイライト対象（黄色でレンダリング）
- `{>>author|date: comment<<}` … コメントメタデータ

## ビルド

```bash
git clone https://github.com/ShotaShirai1719/obsidian-review-comments.git
cd obsidian-review-comments
npm install
npm run build
```

`main.js` が生成される。

## インストール

ObsidianのVaultパスを `$VAULT` とすると:

```bash
mkdir -p "$VAULT/.obsidian/plugins/review-comments"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/review-comments/"
```

または開発時はシンボリックリンク:

```bash
ln -s "$(pwd)" "$VAULT/.obsidian/plugins/review-comments"
```

その後Obsidianで:
1. 設定 → コミュニティプラグイン → インストール済みプラグインで「Review Comments」を有効化
2. 設定 → Review Comments で `Author name` を自分の名前に変更

## 使い方

1. テキストをドラッグで選択
2. 選択範囲の右上に表示される **💬 Comment** ボタンをクリック
3. 「コメントを書く」のプレースホルダが選択状態になるので、そのまま入力

または:
- 選択 → コマンドパレット → `Review Comments: Add comment to selection`
- ホットキー割り当て推奨（例: `Cmd + Shift + M`）

## サイドパネル

左リボンの吹き出しアイコン、または `Review Comments: Open comments panel` コマンドで開く。

- カードクリック … 該当箇所にジャンプ
- `Resolve` ボタン … `{==text==}{>>...<<}` を `text` に置換（コメント削除）

## AI連携

`.md` をそのままClaude Codeなどに渡して:

> このファイル内のCriticMarkup記法（`{==...==}{>>...<<}`）のコメント指示に従って本文を修正し、対応したコメント記法は削除して、ハイライト部分も通常テキストに戻してください。

これで「Notionでコメント → AIに渡して修正」のフローが完結する。

## 開発

```bash
npm run dev   # watch mode
npm run build # production build
```

## ライセンス

AGPL-3.0-or-later。詳細は [LICENSE](./LICENSE) を参照。
