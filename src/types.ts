export interface ReviewCommentsSettings {
  authorName: string;
  dateFormat: "iso" | "japanese";
}

export const DEFAULT_SETTINGS: ReviewCommentsSettings = {
  authorName: "you",
  dateFormat: "iso",
};

export interface ParsedMeta {
  author: string;
  date: string;
  type: string;
  body: string;
}

export const VIEW_TYPE_COMMENTS = "review-comments-view";

export const TYPES: { id: string; tag: string; label: string; icon: string; lucide: string }[] = [
  { id: "ask", tag: "ASK", label: "Ask", icon: "❓", lucide: "help-circle" },
  { id: "edit", tag: "EDIT", label: "Edit", icon: "✏️", lucide: "pencil" },
  { id: "praise", tag: "PRAISE", label: "Praise", icon: "👍", lucide: "thumbs-up" },
  { id: "note", tag: "NOTE", label: "Note", icon: "💬", lucide: "message-circle" },
];

// 吹き出しボタンはテーマに追従するLucideアイコンを使う（絵文字はOS依存でテーマ色に馴染まないため）
export const TYPE_META: Record<string, { icon: string; lucide: string }> = TYPES.reduce(
  (acc, t) => {
    acc[t.tag] = { icon: t.icon, lucide: t.lucide };
    return acc;
  },
  {} as Record<string, { icon: string; lucide: string }>
);
