import test from "node:test";
import assert from "node:assert/strict";
import { toPlainText, chunkText, extractSendMarkers, toolLabel } from "../src/text.js";
import { parseJson } from "../src/ilink.js";
import { denialsToAllowedTools } from "../src/claude.js";

test("extracts send markers and keeps the rest of the text", () => {
  const r = extractSendMarkers('找到了，发给你：\n[[发送: C:\\Users\\a\\b.pdf]]\n  [[send：“D:\\x y\\c.png”]]  \n还有别的吗？');
  assert.deepEqual(r.files, ["C:\\Users\\a\\b.pdf", "D:\\x y\\c.png"]);
  assert.equal(r.text, "找到了，发给你：\n\n还有别的吗？");
});

test("labels tool calls for progress display", () => {
  assert.equal(toolLabel("Bash", { command: "dir C:\\Users\\你的用户名\\Desktop" }), "运行命令：dir C:\\Users\\你的用户名\\Desktop");
  assert.equal(toolLabel("Read", { file_path: "C:\\a\\b\\notes.md" }), "读取 notes.md");
  assert.equal(toolLabel("Glob", { pattern: "**/*.pdf" }), "查找文件：**/*.pdf");
  assert.ok(toolLabel("Bash", { command: "x".repeat(100) }).endsWith("…"));
});

test("maps permission denials to one-time allow rules", () => {
  const rules = denialsToAllowedTools([
    { tool_name: "Bash", tool_input: { command: "del C:\\tmp\\a.txt" } },
    { tool_name: "Write", tool_input: { file_path: "C:\\x.txt" } },
    { tool_name: "Bash", tool_input: { command: "echo (weird)" } },
  ]);
  assert.deepEqual(rules, ["Bash(del C:\\tmp\\a.txt)", "Write", "Bash"]);
});

test("strips common markdown", () => {
  const md = "# 标题\n**加粗** 和 *斜体* 和 `code`\n- 一\n- 二\n[链接](https://a.b)\n```js\nx=1\n```";
  const out = toPlainText(md);
  assert.equal(out, "【标题】\n加粗 和 斜体 和 code\n・一\n・二\n链接（https://a.b）\nx=1");
});

test("flattens tables", () => {
  const out = toPlainText("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(out, "a  b\n\n1  2");
});

test("chunks long text on paragraph boundaries", () => {
  const para = "字".repeat(700);
  const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 1800);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 1800));
  assert.equal(chunks.join("").replace(/\s/g, "").length, 2100);
});

test("hard-splits text without breaks", () => {
  const chunks = chunkText("a".repeat(4000), 1800);
  assert.deepEqual(chunks.map((c) => c.length), [1800, 1800, 400]);
});

test("keeps uint64 ids lossless", () => {
  const data = parseJson('{"msgs":[{"message_id":123456789012345678901,"text":"\\"message_id\\":5"}],"seq":7}');
  assert.equal(data.msgs[0].message_id, "123456789012345678901");
  assert.equal(data.msgs[0].text, '"message_id":5');
  assert.equal(data.seq, 7);
});
