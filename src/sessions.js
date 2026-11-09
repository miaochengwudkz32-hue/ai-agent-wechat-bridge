// Helpers for listing and resuming past Claude Code sessions, and for expiring pending approvals.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APPROVAL_TTL_MS = 10 * 60_000;

/** Claude Code keeps a project's session logs in ~/.claude/projects/<cwd with every non-alphanumeric character replaced by a dash>. */
export function projectDirOf(cwd, home = os.homedir()) {
  return path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
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
