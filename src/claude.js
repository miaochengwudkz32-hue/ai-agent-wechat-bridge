// Runs Claude Code headless (`claude -p`) and returns its reply, reporting tool calls as they happen.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function findClaude(configured) {
  const candidates = [
    configured,
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`找不到 claude 可执行文件，请在 config.json 里设置 claudePath。已尝试：${candidates.join(" ; ")}`);
}

/** Kill claude and everything it started (commands it is running), not just the top process. */
function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    child.kill();
  }
}

/**
 * Turn permission denials from a run into --allowedTools rules for a one-time approval.
 * Bash commands are approved exactly; other tools are approved by name for that single run.
 */
export function denialsToAllowedTools(denials = []) {
  const rules = new Set();
  for (const d of denials) {
    const name = d?.tool_name;
    if (!name) continue;
    const cmd = d.tool_input?.command;
    if ((name === "Bash" || name === "PowerShell") && typeof cmd === "string" && cmd && !/[()]/.test(cmd)) {
      rules.add(`${name}(${cmd})`);
    } else {
      rules.add(name);
    }
  }
  return [...rules];
}

/**
 * @param {object} o
 * @param {(e:{id:string,name:string,input:any})=>void} [o.onToolStart]
 * @param {(e:{id:string,isError:boolean})=>void} [o.onToolEnd]
 * @param {AbortSignal} [o.signal] abort to stop the run (like pressing Esc in Claude Code)
 * @returns {Promise<{ok:boolean, text:string, sessionId?:string, costUsd?:number, usage?:any, error?:string,
 *   aborted?:boolean, credentialExpiresAt?:string, permissionDenials?:any[]}>}
 */
export function runClaude({
  claudePath,
  prompt,
  sessionId,
  forkSession = false,
  model,
  effort,
  permissionMode,
  systemPromptFile,
  addDirs = [],
  allowedTools = [],
  strictMcp = true,
  cwd,
  timeoutMs,
  signal,
  onToolStart,
  onToolEnd,
}) {
  // --exclude-dynamic-system-prompt-sections and --strict-mcp-config keep the prompt prefix identical
  // between calls, so resumed turns are served from the prompt cache instead of re-written (much cheaper).
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--exclude-dynamic-system-prompt-sections"];
  if (strictMcp) args.push("--strict-mcp-config");
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  for (const d of addDirs) args.push("--add-dir", d);
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (sessionId) {
    args.push("--resume", sessionId);
    // Continue a copy of the session: the original log (maybe still open in the desktop app) is never written.
    if (forkSession) args.push("--fork-session");
  } else if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // always use the claude.ai (school plan) login, never an API key

  return new Promise((resolve) => {
    const child = spawn(claudePath, args, { cwd, env, windowsHide: true });
    let finished = false;
    let result = null;
    let buffer = "";
    const errChunks = [];
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, text: "", error: `超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）` });
    }, timeoutMs);
    const onAbort = () => {
      killTree(child);
      finish({ ok: false, aborted: true, text: "", error: "已停止" });
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const handleEvent = (ev) => {
      if (ev.type === "assistant") {
        for (const block of ev.message?.content || []) {
          if (block.type === "tool_use") onToolStart?.({ id: block.id, name: block.name, input: block.input });
        }
      } else if (ev.type === "user") {
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") onToolEnd?.({ id: block.tool_use_id, isError: !!block.is_error });
          }
        }
      } else if (ev.type === "result") {
        result = ev;
      }
    };

    child.stdout.on("data", (d) => {
      buffer += d.toString("utf-8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          /* not a JSON event line */
        }
      }
    });
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", (e) => finish({ ok: false, text: "", error: `无法启动 claude：${e.message}` }));
    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          handleEvent(JSON.parse(buffer.trim()));
        } catch {
          /* ignore */
        }
      }
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      if (!result) {
        finish({ ok: false, text: "", error: (stderr || `claude 退出码 ${code}`).slice(0, 800) });
        return;
      }
      const ok = !result.is_error && result.subtype === "success";
      finish({
        ok,
        text: typeof result.result === "string" ? result.result : "",
        sessionId: result.session_id,
        costUsd: result.total_cost_usd,
        usage: result.usage,
        credentialExpiresAt: result.credential_expires_at,
        permissionDenials: result.permission_denials,
        error: ok ? undefined : String(result.result || result.subtype || stderr || "未知错误").slice(0, 800),
      });
    });

    child.stdin.end(prompt, "utf-8");
  });
}
