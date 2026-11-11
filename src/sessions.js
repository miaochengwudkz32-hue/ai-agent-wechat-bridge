// Helpers for listing and resuming past Claude Code sessions, and for expiring pending approvals.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APPROVAL_TTL_MS = 10 * 60_000;

/** Claude Code keeps a project's session logs in ~/.claude/projects/<cwd with every non-alphanumeric character replaced by a dash>. */
export function projectDirOf(cwd, home = os.homedir()) {
  return path.join(home, ".claude", "projects", encodeCwd(cwd));
}
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** Working directory recorded in a session log. Claude Code writes it on each entry, but not on the first line. */
export function sessionCwd(file, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      } catch {
        // a line cut off by the read limit
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Text of the first real user message in a session log. Reads only the head of the file, since logs can be large. */
export function firstUserText(file, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // the last line may be cut off by the read limit
      }
      if (o.type !== "user" || o.isMeta) continue;
      const c = o.message?.content;
      let t = typeof c === "string" ? c : Array.isArray(c) ? c.find((b) => b.type === "text")?.text || "" : "";
      // The bridge puts a "[time] " prefix in front of each message.
      t = t.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
      if (!t || t.startsWith("<") || t.startsWith("【系统定时任务")) continue;
      return t;
    }
    return "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Most recent non-empty sessions in a project directory, newest first. */
export function listSessions(dir, { limit = 5 } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      return { id: f.slice(0, -".jsonl".length), file, mtime: st.mtimeMs, size: st.size };
    })
    .filter((s) => s.size > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((s) => ({ id: s.id, mtime: s.mtime, title: firstUserText(s.file) }));
}

// Claude's own scratch space and temp runs, which are not folders the user works in.
const NOT_A_PROJECT = /scratch-workspaces|scratchpad|claude-wechat-e2e|[\\/]Temp[\\/]claude[\\/]|[\\/]Claude-Data[\\/]|[\\/]AppData[\\/]Roaming[\\/]Claude[\\/]|[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)/i;

/** Folders directly inside `roots`, keyed by their encoded name (the name used for project directories). */
function folderIndex(roots) {
  const index = new Map();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) index.set(encodeCwd(path.join(root, e.name)), path.join(root, e.name));
    }
  }
  return index;
}

/** Folders directly inside `roots` whose name contains `name` (case-insensitive). Hidden folders and scratch space are skipped. */
export function findFolders(name, roots) {
  const want = name.toLowerCase();
  const hits = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(root, e.name);
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.toLowerCase() === "appdata") continue;
      if (e.name.toLowerCase().includes(want) && !NOT_A_PROJECT.test(p)) hits.add(p);
    }
  }
  return [...hits];
}

/**
 * Project folders that have conversations, most recently used first.
 * Each project directory under `projectsRoot` is one folder: the folder recorded in its sessions if it matches the
 * directory name, otherwise the folder under `searchRoots` with that name. Sessions the desktop app ran in its own
 * scratch space don't name a project, so they are skipped. `exclude` is skipped too (the bridge's own workspace).
 */
export function listProjects(projectsRoot, { exclude = "", limit = 12, searchRoots = [] } = {}) {
  if (!fs.existsSync(projectsRoot)) return [];
  let folders = null;
  const out = [];
  for (const dirName of fs.readdirSync(projectsRoot)) {
    const dir = path.join(projectsRoot, dirName);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const logs = [];
    for (const f of files) {
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      if (st.size > 0) logs.push({ file, mtime: st.mtimeMs });
    }
    if (!logs.length) continue;
    let cwd = "";
    for (const l of logs) {
      const c = sessionCwd(l.file);
      if (c && encodeCwd(c) === dirName && !NOT_A_PROJECT.test(c) && fs.existsSync(c)) {
        cwd = c;
        break;
      }
    }
    if (!cwd) {
      folders ??= folderIndex(searchRoots);
      cwd = folders.get(dirName) || "";
    }
    if (!cwd || cwd === exclude || NOT_A_PROJECT.test(cwd) || !fs.existsSync(cwd)) continue;
    out.push({ cwd, name: path.basename(cwd), mtime: Math.max(...logs.map((l) => l.mtime)) });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/**
 * Check the pending approval in the runtime state.
 * Returns { state: "none" | "expired" | "active", pending? }. Clears the stored approval when it is not active.
 * The caller saves the state.
 */
export function takeActiveApproval(rt, now = Date.now(), ttl = APPROVAL_TTL_MS) {
  const p = rt.pendingApproval;
  if (!p?.denials?.length) {
    rt.pendingApproval = null;
    return { state: "none" };
  }
  if (now - p.at > ttl) {
    rt.pendingApproval = null;
    return { state: "expired" };
  }
  return { state: "active", pending: p };
}
