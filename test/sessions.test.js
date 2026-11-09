import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDirOf, firstUserText, listSessions, takeActiveApproval, APPROVAL_TTL_MS } from "../src/sessions.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sessions-test-"));

test("projectDirOf encodes the working directory the way Claude Code does", () => {
  const home = path.join("C:", "Users", "x");
  assert.equal(
    projectDirOf("C:\\Users\\x\\.claude-wechat\\workspace", home),
    path.join(home, ".claude", "projects", "C--Users-x--claude-wechat-workspace"),
  );
});

test("firstUserText skips system and scheduled prompts and strips the time prefix", () => {
  const dir = tmpDir();
  const file = path.join(dir, "s.jsonl");
  const lines = [
    { type: "system", message: { content: "x" } },
    { type: "user", message: { content: "<system-reminder>background</system-reminder>" } },
    { type: "user", message: { content: "【系统定时任务「早安」触发，这不是用户发来的消息。" } },
    { type: "user", message: { content: [{ type: "text", text: "[11月8日 22:31] 帮我查一下作业" }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(firstUserText(file), "帮我查一下作业");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("firstUserText tolerates a truncated last line and missing files", () => {
  const dir = tmpDir();
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "你好" } }) + "\n{\"type\":\"us");
  assert.equal(firstUserText(file), "你好");
  assert.equal(firstUserText(path.join(dir, "missing.jsonl")), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listSessions returns the newest non-empty sessions first, up to the limit", () => {
  const dir = tmpDir();
  const make = (id, mtimeSec, body) => {
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, body);
    fs.utimesSync(f, mtimeSec, mtimeSec);
  };
  const userLine = (t) => JSON.stringify({ type: "user", message: { content: t } }) + "\n";
  make("old", 1000, userLine("旧的"));
  make("new", 3000, userLine("新的"));
  make("empty", 4000, "");
  make("mid", 2000, userLine("中间的"));
  const list = listSessions(dir, { limit: 2 });
  assert.deepEqual(
    list.map((s) => [s.id, s.title]),
    [
      ["new", "新的"],
      ["mid", "中间的"],
    ],
  );
  assert.deepEqual(listSessions(path.join(dir, "nope")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("takeActiveApproval distinguishes none, active and expired", () => {
  const now = 1_000_000;
  const rt = {};
  assert.equal(takeActiveApproval(rt, now).state, "none");

  rt.pendingApproval = { denials: [{ tool_name: "Bash" }], at: now - 60_000 };
  const active = takeActiveApproval(rt, now);
  assert.equal(active.state, "active");
  assert.equal(active.pending.denials.length, 1);
  assert.ok(rt.pendingApproval, "active approval is kept");

  rt.pendingApproval = { denials: [{ tool_name: "Bash" }], at: now - APPROVAL_TTL_MS - 1 };
  assert.equal(takeActiveApproval(rt, now).state, "expired");
  assert.equal(rt.pendingApproval, null, "expired approval is cleared");
});
