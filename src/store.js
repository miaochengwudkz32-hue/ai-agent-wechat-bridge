// Paths, config and small JSON persistence helpers.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = process.env.CLAUDE_WECHAT_STATE_DIR
  ? path.resolve(process.env.CLAUDE_WECHAT_STATE_DIR)
  : path.join(ROOT, "state");
export const MEDIA_DIR = path.join(STATE_DIR, "media");
export const ACCOUNT_FILE = path.join(STATE_DIR, "account.json");
export const RUNTIME_FILE = path.join(STATE_DIR, "runtime.json");
export const USAGE_FILE = path.join(STATE_DIR, "usage.jsonl");
export const LOG_FILE = path.join(STATE_DIR, "bridge.log");
export const LOCAL_TOKEN_FILE = path.join(STATE_DIR, "local-token");
export const CONFIG_FILE = process.env.CLAUDE_WECHAT_CONFIG
  ? path.resolve(process.env.CLAUDE_WECHAT_CONFIG)
  : path.join(ROOT, "config.json");

fs.mkdirSync(MEDIA_DIR, { recursive: true });

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

const DEFAULT_CONFIG = {
  model: "",
  effort: "",
  permissionMode: "auto",
  addDirs: [os.homedir()],
  strictMcp: true,
  showToolProgress: true,
  claudePath: "",
  sessionIdleResetHours: 6,
  claudeTimeoutMinutes: 15,
  maxChunkChars: 1800,
  wakePort: 18765,
  announceOnStart: false,
  schedules: [],
};

export function loadConfig() {
  const user = readJson(CONFIG_FILE, {});
  return { ...DEFAULT_CONFIG, ...user };
}

export function log(...parts) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    /* ignore */
  }
}

export function appendUsage(entry) {
  try {
    fs.appendFileSync(USAGE_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
  } catch {
    /* ignore */
  }
}

/** Sum of recorded list-price cost (USD) since the given date. */
export function usageSince(since) {
  let total = 0;
  let calls = 0;
  try {
    for (const line of fs.readFileSync(USAGE_FILE, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (new Date(e.at) >= since) {
        total += e.costUsd || 0;
        calls += 1;
      }
    }
  } catch {
    /* no usage yet */
  }
  return { total, calls };
}
