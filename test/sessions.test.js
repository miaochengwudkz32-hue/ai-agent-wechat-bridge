import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDirOf, firstUserText, listSessions, sessionCwd, listProjects, findFolders, takeActiveApproval, APPROVAL_TTL_MS } from "../src/sessions.js";

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

test("sessionCwd finds the working directory recorded on a later line", () => {
  const dir = tmpDir();
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session-owner", sessionId: "x" }),
      JSON.stringify({ type: "user", cwd: "C:\\Users\\x\\Desktop\\He", message: { content: "hi" } }),
    ].join("\n"),
  );
  assert.equal(sessionCwd(file), "C:\\Users\\x\\Desktop\\He");
  assert.equal(sessionCwd(path.join(dir, "missing.jsonl")), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

// Folders under the temp directory are never projects, so these fixtures live inside the repo instead.
const repoTmpDir = () => fs.mkdtempSync(path.join(process.cwd(), "test-tmp-"));

test("listProjects lists each folder once, newest first, skipping scratch runs and the excluded folder", () => {
  const home = repoTmpDir();
  const root = path.join(home, ".claude", "projects");
  const alpha = path.join(home, "Desktop", "Alpha");
  const beta = path.join(home, "Desktop", "Beta Two 复习");
  const scratch = path.join(home, "AppData", "Local", "Claude-Data", "scratch-workspaces", "x");
  const workspace = path.join(home, ".claude-wechat", "workspace");
  for (const d of [alpha, beta, scratch, workspace]) fs.mkdirSync(d, { recursive: true });

  // Writes one session log into the project directory Claude Code would use for `dir`.
  const log = (dir, cwdRecorded, id, mtime) => {
    const pdir = projectDirOf(dir, home);
    fs.mkdirSync(pdir, { recursive: true });
    const file = path.join(pdir, id + ".jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "user", cwd: cwdRecorded, message: { content: "hi" } }) + "\n");
    fs.utimesSync(file, mtime, mtime);
  };
  log(alpha, alpha, "a1", new Date("2026-11-01T00:00:00Z"));
  log(alpha, alpha, "a2", new Date("2026-11-03T00:00:00Z")); // newer, same folder: listed once
  // Beta's sessions ran in scratch space, so its folder is found by name under the search roots.
  log(beta, scratch, "b1", new Date("2026-11-05T00:00:00Z"));
  // A scratch run that is not tied to any folder.
  log(scratch, scratch, "s1", new Date("2026-11-09T00:00:00Z"));
  log(workspace, workspace, "w1", new Date("2026-11-10T00:00:00Z"));

  const list = listProjects(root, { exclude: workspace, searchRoots: [path.join(home, "Desktop")] });
  assert.deepEqual(list.map((p) => p.name), ["Beta Two 复习", "Alpha"]);
  assert.equal(list[1].mtime, new Date("2026-11-03T00:00:00Z").getTime());
  assert.deepEqual(listProjects(path.join(home, "nope")), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test("findFolders matches folder names case-insensitively and skips hidden folders", () => {
  const home = repoTmpDir();
  fs.mkdirSync(path.join(home, "Desktop", "Northeastern Notes"), { recursive: true });
  fs.mkdirSync(path.join(home, "Desktop", "northeastern-old"), { recursive: true });
  fs.mkdirSync(path.join(home, ".northeastern"), { recursive: true });
  const hits = findFolders("NORTHEASTERN", [home, path.join(home, "Desktop")]).map((p) => path.basename(p)).sort();
  assert.deepEqual(hits, ["Northeastern Notes", "northeastern-old"]);
  assert.deepEqual(findFolders("zzz", [home]), []);
  fs.rmSync(home, { recursive: true, force: true });
});
