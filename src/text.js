// Text helpers: make Claude's reply WeChat-friendly and split long replies.

/** WeChat shows raw text, so strip the most common Markdown syntax. */
export function toPlainText(md) {
  let s = String(md ?? "").replace(/\r\n/g, "\n");
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => code.trimEnd()); // code fences
  s = s.replace(/`([^`\n]+)`/g, "$1"); // inline code
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "【$1】"); // headings
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1"); // bold
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2"); // italic
  s = s.replace(/^\s*[-*+]\s+/gm, "・"); // bullets
  s = s.replace(/^\s*>\s?/gm, ""); // block quotes
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 $2").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）"); // links
  s = s.replace(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ""); // table separator rows
  s = s.replace(/^\|(.+)\|$/gm, (_, row) => row.split("|").map((c) => c.trim()).join("  ")); // table rows
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Pull out [[发送: path]] / [[send: path]] lines. Returns the remaining text and the file paths. */
export function extractSendMarkers(text) {
  const files = [];
  const rest = String(text ?? "").replace(/^[ \t]*`?\[\[\s*(?:发送|send)\s*[:：]\s*(.+?)\s*\]\]`?[ \t]*$/gim, (_, p) => {
    files.push(p.trim().replace(/^["'“”]|["'“”]$/g, ""));
    return "";
  });
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), files };
}

const short = (s, n = 40) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() || String(p ?? "");

/** Human-readable label for a Claude Code tool call, shown as WeChat progress. */
export function toolLabel(name, input = {}) {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return `运行命令：${short(input.command)}`;
    case "Read":
      return `读取 ${short(base(input.file_path))}`;
    case "Write":
      return `写入 ${short(base(input.file_path))}`;
    case "Edit":
    case "MultiEdit":
      return `修改 ${short(base(input.file_path))}`;
    case "Glob":
      return `查找文件：${short(input.pattern)}`;
    case "Grep":
      return `搜索内容：${short(input.pattern)}`;
    case "WebSearch":
      return `上网搜索：${short(input.query)}`;
    case "WebFetch":
      return `打开网页：${short(input.url)}`;
    case "Skill":
      return `使用技能：${short(input.skill || input.name)}`;
    case "Task":
    case "Agent":
      return `派出子任务：${short(input.description)}`;
    case "TodoWrite":
      return "更新任务清单";
    default:
      return short(name, 30);
  }
}

/** Split text into chunks no longer than maxLen, preferring paragraph and line breaks. */
export function chunkText(text, maxLen) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf("。", maxLen) + 1;
    if (cut < maxLen * 0.4) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
