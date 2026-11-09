// WeChat ClawBot <-> Claude Code bridge.
// Receives your WeChat messages, answers them with `claude -p` (showing tool progress like Claude Code),
// sends files/screenshots back, and can wake Claude on a schedule to message you first.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as ilink from "./src/ilink.js";
import { runClaude, findClaude, denialsToAllowedTools } from "./src/claude.js";
import { toPlainText, chunkText, extractSendMarkers, toolLabel } from "./src/text.js";
import { projectDirOf, listSessions, takeActiveApproval, APPROVAL_TTL_MS } from "./src/sessions.js";
import {
  ROOT,
  STATE_DIR,
  MEDIA_DIR,
  ACCOUNT_FILE,
  RUNTIME_FILE,
  LOCAL_TOKEN_FILE,
  readJson,
  writeJson,
  loadConfig,
  log,
  appendUsage,
  usageSince,
} from "./src/store.js";

const cfg = loadConfig();
const account = readJson(ACCOUNT_FILE);
if (!account?.token) {
  console.error("还没有绑定微信 ClawBot：请先运行  node login.js");
  process.exit(1);
}
const api = { baseUrl: account.baseUrl || ilink.FIXED_BASE_URL, token: account.token };
const claudePath = findClaude(cfg.claudePath);
const WORKSPACE = process.env.CLAUDE_WECHAT_WORKSPACE
  ? path.resolve(process.env.CLAUDE_WECHAT_WORKSPACE)
  : path.join(ROOT, "workspace");
const SCREENSHOT_SCRIPT = path.join(ROOT, "tools", "screenshot.ps1");
fs.mkdirSync(WORKSPACE, { recursive: true });

// Render the system prompt with this install's paths.
const SYSTEM_PROMPT_FILE = path.join(STATE_DIR, "system-prompt.md");
fs.writeFileSync(
  SYSTEM_PROMPT_FILE,
  fs.readFileSync(path.join(ROOT, "prompts", "wechat-system.md"), "utf-8").replaceAll("{{ROOT}}", ROOT),
  "utf-8",
);

const rt = readJson(RUNTIME_FILE, {});
const saveRt = () => writeJson(RUNTIME_FILE, rt);

// The appended system prompt is fixed when a conversation starts, so a changed prompt
// (new features, new instructions) needs a fresh conversation to take effect.
// Called only after this instance owns the control port, so a duplicate copy never touches state.
function resetSessionIfPromptChanged() {
  const promptHash = crypto.createHash("sha1").update(fs.readFileSync(SYSTEM_PROMPT_FILE)).digest("hex");
  if (rt.promptHash === promptHash) return;
  if (rt.sessionId) log("系统提示已更新，下一条消息会开启新对话");
  rt.sessionId = null;
  rt.promptHash = promptHash;
  saveRt();
}

let localToken = fs.existsSync(LOCAL_TOKEN_FILE) ? fs.readFileSync(LOCAL_TOKEN_FILE, "utf-8").trim() : "";
if (!localToken) {
  localToken = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(LOCAL_TOKEN_FILE, localToken, "utf-8");
}

let stopping = false;
const abort = new AbortController();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (ms) => {
  const d = ms ? new Date(ms) : new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const HELP = [
  "可用指令：",
  "/stop  立刻停止正在做的事",
  `/approve  批准刚才被安全检查拦下的操作并继续（${APPROVAL_TTL_MS / 60_000} 分钟内有效）`,
  "/resume  列出最近的对话；发 /resume 编号 就接着聊那一段",
  "/screenshot  截一张电脑屏幕发给你",
  "/new  开始新对话（清空上下文，更省额度）",
  "/model opus|sonnet|haiku|default  切换模型",
  "/effort low|medium|high|xhigh|max|default  调整思考程度",
  "/status  查看状态和用量",
  "/help  显示这条帮助",
  "其他消息都会直接交给 Claude：可以让它查找、整理、修改电脑上的文件，运行命令，把文件发给你。",
].join("\n");

// ------------------------------------------------------------------ who we talk to

function ownerId() {
  return account.userId || rt.ownerId || null;
}
function peerId() {
  return rt.peerUserId || ownerId();
}

function isOwner(userId) {
  if (!ownerId()) {
    rt.ownerId = userId; // no user id from login: lock onto the first sender
    saveRt();
    return true;
  }
  return userId === ownerId();
}

function currentModel() {
  return rt.model !== undefined ? rt.model : cfg.model;
}
function currentEffort() {
  return rt.effort !== undefined ? rt.effort : cfg.effort;
}

// ------------------------------------------------------------------ sending

const sentTimes = [];
async function rateGate() {
  for (;;) {
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 5 * 60_000) sentTimes.shift();
    if (sentTimes.length < 6) return;
    const wait = 5 * 60_000 - (now - sentTimes[0]) + 1000;
    log(`接近微信发送频率上限，等待 ${Math.ceil(wait / 1000)} 秒`);
    await sleep(wait);
  }
}

async function withRateLimitRetry(fn) {
  await rateGate();
  try {
    await fn();
  } catch (err) {
    if (err.ret !== ilink.RATE_LIMITED) throw err;
    log("被微信限流，60 秒后重试一次");
    await sleep(60_000);
    await fn();
  }
  sentTimes.push(Date.now());
}

async function sendToOwner(text, { runId } = {}) {
  const to = peerId();
  if (!to) throw new Error("还不知道要发给谁：请先在微信里给 ClawBot 发一条消息");
  let chunks = chunkText(text, cfg.maxChunkChars);
  if (chunks.length > 4) chunks = chunkText(text, 3800);
  if (chunks.length > 5) {
    const file = path.join(WORKSPACE, `long-reply-${Date.now()}.txt`);
    fs.writeFileSync(file, text, "utf-8");
    chunks = [...chunks.slice(0, 4), `（内容太长，后面省略了。完整内容保存在电脑上：${file}）`];
  }
  for (let i = 0; i < chunks.length; i++) {
    await withRateLimitRetry(() => ilink.sendText({ ...api, to, text: chunks[i], contextToken: rt.contextToken, runId }));
    if (i < chunks.length - 1) await sleep(800);
  }
  log(`已回复（${chunks.length} 条，${text.length} 字）`);
}

/** Send local files; returns a list of human-readable problems (empty when all were sent). */
async function sendFilesToOwner(files, { runId } = {}) {
  const to = peerId();
  if (!to) throw new Error("还不知道要发给谁：请先在微信里给 ClawBot 发一条消息");
  const problems = [];
  for (const raw of files) {
    const file = path.resolve(WORKSPACE, raw);
    if (!fs.existsSync(file)) {
      problems.push(`找不到文件：${raw}`);
      continue;
    }
    try {
      let kind = "file";
      await withRateLimitRetry(async () => {
        kind = await ilink.sendFile({ ...api, to, filePath: file, contextToken: rt.contextToken, runId });
      });
      log(`已发送${kind === "image" ? "图片" : kind === "video" ? "视频" : "文件"}：${path.basename(file)}`);
    } catch (err) {
      log("发送文件失败:", file, err.message);
      problems.push(`${path.basename(file)} 发送失败：${err.message}`);
    }
  }
  return problems;
}

// ------------------------------------------------------------------ typing indicator & tool progress

async function typingTicket() {
  const to = peerId();
  if (!to) return null;
  if (rt.typingTicket && Date.now() - (rt.typingTicketAt || 0) < 12 * 3600_000) return rt.typingTicket;
  try {
    const r = await ilink.getConfig({ ...api, userId: to, contextToken: rt.contextToken });
    if (r.typing_ticket) {
      rt.typingTicket = r.typing_ticket;
      rt.typingTicketAt = Date.now();
      saveRt();
    }
  } catch (err) {
    log("getconfig 失败（不影响收发）:", err.message);
  }
  return rt.typingTicket || null;
}

function startTyping() {
  let stopped = false;
  let timer = null;
  const to = peerId();
  const ready = (async () => {
    const ticket = await typingTicket();
    if (!ticket || !to) return null;
    const tick = async () => {
      if (stopped) return;
      try {
        await ilink.sendTyping({ ...api, userId: to, ticket, status: ilink.TypingStatus.TYPING });
      } catch {
        /* cosmetic only */
      }
      if (!stopped) timer = setTimeout(tick, 5000);
    };
    await tick();
    return ticket;
  })();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    const ticket = await ready.catch(() => null);
    if (!ticket) return;
    try {
      await ilink.sendTyping({ ...api, userId: to, ticket, status: ilink.TypingStatus.CANCEL });
    } catch {
      /* cosmetic only */
    }
  };
}

let progressPausedUntil = 0;

/** Shows each tool call in WeChat as ClawBot's native progress item, like watching Claude Code work. */
function createProgress(runId, enabled) {
  const to = peerId();
  const labels = new Map();
  let chain = Promise.resolve();
  const push = (args) => {
    if (!enabled || !to || Date.now() < progressPausedUntil) return;
    chain = chain
      .then(() => ilink.sendToolProgress({ ...api, to, contextToken: rt.contextToken, runId, ...args }))
      .catch((err) => {
        if (err.ret === ilink.RATE_LIMITED) {
          progressPausedUntil = Date.now() + 10 * 60_000;
          log("工具进度被微信限流，暂停显示进度 10 分钟");
        }
      });
  };
  return {
    start({ id, name, input }) {
      const label = toolLabel(name, input);
      labels.set(id, label);
      log(`  · ${label}`);
      push({ phase: "start", toolName: label, toolCallId: id });
    },
    end({ id, isError }) {
      push({ phase: "end", toolName: labels.get(id) || "工具", toolCallId: id, status: isError ? "failed" : "completed" });
    },
    drain: () => chain,
  };
}

// ------------------------------------------------------------------ inbound messages

function detectExt(buf, fallback) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf.length > 3 && buf.toString("ascii", 0, 3) === "GIF") return ".gif";
  if (buf.length > 12 && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return fallback;
}

function saveMedia(buf, ext, originalName) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const safe = originalName ? originalName.replace(/[\\/:*?"<>|]/g, "_").slice(-80) : `${crypto.randomBytes(3).toString("hex")}${ext}`;
  const file = path.join(MEDIA_DIR, `${stamp}-${safe}`);
  fs.writeFileSync(file, buf);
  return file;
}

function plainTextOf(m) {
  const items = m.item_list || [];
  return items.length === 1 && items[0].type === ilink.ItemType.TEXT ? String(items[0].text_item?.text ?? "").trim() : "";
}

async function describeMessage(m) {
  const parts = [];
  for (const item of m.item_list || []) {
    const quoted = item.ref_msg?.message_item?.text_item?.text || item.ref_msg?.title;
    if (quoted) parts.push(`（引用了：「${String(quoted).slice(0, 200)}」）`);
    switch (item.type) {
      case ilink.ItemType.TEXT:
        parts.push(item.text_item?.text ?? "");
        break;
      case ilink.ItemType.VOICE:
        parts.push(item.voice_item?.text ? `（语音转文字）${item.voice_item.text}` : "（发来一条语音，但没有转文字结果）");
        break;
      case ilink.ItemType.IMAGE:
        try {
          const buf = await ilink.downloadMedia(item.image_item?.media, item.image_item?.aeskey);
          parts.push(`（发来一张图片，已保存到：${saveMedia(buf, detectExt(buf, ".jpg"))}）`);
        } catch (err) {
          parts.push(`（发来一张图片，但下载失败：${err.message}）`);
        }
        break;
      case ilink.ItemType.FILE: {
        const name = item.file_item?.file_name || "file";
        try {
          const buf = await ilink.downloadMedia(item.file_item?.media);
          parts.push(`（发来文件「${name}」，已保存到：${saveMedia(buf, "", name)}）`);
        } catch (err) {
          parts.push(`（发来文件「${name}」，但下载失败：${err.message}）`);
        }
        break;
      }
      case ilink.ItemType.VIDEO:
        try {
          const buf = await ilink.downloadMedia(item.video_item?.media);
          parts.push(`（发来一段视频，已保存到：${saveMedia(buf, ".mp4")}）`);
        } catch (err) {
          parts.push(`（发来一段视频，但下载失败：${err.message}）`);
        }
        break;
      default:
        break;
    }
  }
  return parts.filter((p) => p !== "").join("\n").trim();
}

// ------------------------------------------------------------------ talking to Claude

let currentRun = null; // { abort: AbortController, startedAt, label }

function loginExpiryNote() {
  if (!rt.credentialExpiresAt) return "";
  const days = (new Date(rt.credentialExpiresAt) - Date.now()) / 86400_000;
  const today = new Date().toDateString();
  if (days > 3 || rt.loginWarnedOn === today) return "";
  rt.loginWarnedOn = today;
  saveRt();
  return `\n\n（提醒：电脑上 Claude 的登录大约 ${Math.max(0, Math.ceil(days))} 天后过期，记得在电脑上运行 claude auth login 续期。）`;
}

function describeDenial(d) {
  const input = d.tool_input || {};
  if (input.command) return `运行命令：${String(input.command).slice(0, 200)}`;
  if (input.file_path) return `${d.tool_name}：${input.file_path}`;
  if (input.url) return `${d.tool_name}：${input.url}`;
  return d.tool_name || "未知操作";
}

async function converse(prompt, { isWake = false, allowedTools = [] } = {}) {
  const idleMs = cfg.sessionIdleResetHours * 3600_000;
  if (rt.sessionId && idleMs > 0 && Date.now() - (rt.sessionUpdatedAt || 0) > idleMs) {
    log("闲置时间较长，开启新会话");
    rt.sessionId = null;
  }
  const runId = crypto.randomUUID();
  const progress = createProgress(runId, cfg.showToolProgress !== false && !isWake);
  const stopTyping = isWake ? async () => {} : startTyping();
  const ctl = new AbortController();
  currentRun = { abort: ctl, startedAt: Date.now() };
  const prevSessionId = rt.sessionId;
  const call = () =>
    runClaude({
      claudePath,
      prompt,
      sessionId: rt.sessionId,
      model: currentModel(),
      effort: currentEffort(),
      permissionMode: cfg.permissionMode,
      systemPromptFile: SYSTEM_PROMPT_FILE,
      addDirs: cfg.addDirs,
      allowedTools,
      strictMcp: cfg.strictMcp,
      cwd: WORKSPACE,
      timeoutMs: cfg.claudeTimeoutMinutes * 60_000,
      signal: ctl.signal,
      onToolStart: (e) => progress.start(e),
      onToolEnd: (e) => progress.end(e),
    });
  let res;
  try {
    log(`调用 Claude（模型：${currentModel() || "默认"}，思考：${currentEffort() || "默认"}，${rt.sessionId ? "继续会话" : "新会话"}）`);
    res = await call();
    if (!res.ok && !res.aborted && rt.sessionId && /no conversation found|session.*not found/i.test(res.error || "")) {
      log("旧会话不可用，改用新会话重试");
      rt.sessionId = null;
      res = await call();
    }
  } finally {
    currentRun = null;
    await stopTyping();
    await progress.drain();
  }

  // total_cost_usd is cumulative for a resumed session, so record the difference for this call.
  let callCost = res.costUsd || 0;
  if (res.sessionId && res.sessionId === prevSessionId) {
    // rt.sessionCostUsd is null right after /resume: this call only sets the baseline, so it is not counted.
    if (rt.sessionCostUsd == null) callCost = 0;
    else if (callCost >= rt.sessionCostUsd) callCost -= rt.sessionCostUsd;
  }
  if (res.sessionId) {
    rt.sessionId = res.sessionId;
    rt.sessionUpdatedAt = Date.now();
    rt.sessionCostUsd = res.costUsd || 0;
  }
  if (res.credentialExpiresAt) rt.credentialExpiresAt = res.credentialExpiresAt;
  rt.pendingApproval = res.permissionDenials?.length ? { denials: res.permissionDenials, at: Date.now() } : null;
  saveRt();
  appendUsage({
    kind: isWake ? "wake" : "chat",
    ok: res.ok,
    costUsd: callCost,
    model: currentModel() || "default",
    cacheWrite: res.usage?.cache_creation_input_tokens,
    cacheRead: res.usage?.cache_read_input_tokens,
    output: res.usage?.output_tokens,
  });

  if (res.aborted) {
    log("任务已被 /stop 停止");
    return;
  }
  if (!res.ok) {
    log("Claude 出错:", res.error);
    const hint = /log ?in|auth|credential|401|403/i.test(res.error || "")
      ? "\n可能是电脑上 Claude 的登录失效了：请在电脑上运行 claude auth login 重新登录。"
      : "";
    await sendToOwner(`⚠️ ${isWake ? "定时任务" : ""}出错了：${res.error}${hint}`, { runId });
    return;
  }

  const { text: withoutMarkers, files } = extractSendMarkers(res.text);
  let text = toPlainText(withoutMarkers);
  if (isWake && /^NO_MESSAGE[。.!！]?$/i.test(text) && !files.length) {
    log("定时任务：Claude 判断现在不需要打扰你");
    return;
  }
  const pa = takeActiveApproval(rt);
  saveRt();
  if (pa.state === "active") {
    const list = pa.pending.denials.map((d, i) => `${i + 1}. ${describeDenial(d)}`).join("\n");
    text += `\n\n⚠️ 下面这些操作被安全检查拦下了：\n${list}\n回复 /approve 批准并让我继续（${APPROVAL_TTL_MS / 60_000} 分钟内有效）；不回复就当不批准。`;
    log(`有 ${pa.pending.denials.length} 个操作被拦下，等待 /approve`);
  }
  if (!text && !files.length) text = "（没有文字回复）";
  if (text) await sendToOwner(text + loginExpiryNote(), { runId });
  if (files.length) {
    const problems = await sendFilesToOwner(files, { runId });
    if (problems.length) await sendToOwner(`⚠️ 有文件没发出去：\n${problems.join("\n")}`, { runId });
  }
}

// ------------------------------------------------------------------ screenshots

function takeScreenshot() {
  const outDir = path.join(MEDIA_DIR, "outbox");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `screenshot-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.png`);
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCREENSHOT_SCRIPT, "-Out", out],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        const file = String(stdout).trim().split(/\r?\n/).pop();
        if (err || !file || !fs.existsSync(file)) return reject(new Error((stderr || err?.message || "截图失败").trim().slice(0, 300)));
        resolve(file);
      },
    );
  });
}

// ------------------------------------------------------------------ commands

/** Commands that act immediately, even while Claude is busy. */
async function handleUrgentCommand(text) {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  if (cmd === "/stop") {
    if (currentRun) {
      currentRun.abort.abort();
      const dropped = queue.filter((q) => q.type === "wechat").length;
      await sendToOwner(`⏹ 已停止当前任务。${dropped ? `后面还有 ${dropped} 条消息会接着处理。` : ""}`);
    } else {
      await sendToOwner("现在没有正在进行的任务。");
    }
    return true;
  }
  if (cmd === "/status") {
    await sendToOwner(statusText());
    return true;
  }
  return false;
}

async function handleCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/help":
      await sendToOwner(HELP);
      return true;
    case "/new":
      rt.sessionId = null;
      rt.pendingApproval = null;
      saveRt();
      await sendToOwner("好的，已经开始新对话，之前的上下文不会再带上。");
      return true;
    case "/screenshot":
    case "/截图": {
      try {
        const file = await takeScreenshot();
        const problems = await sendFilesToOwner([file]);
        if (problems.length) await sendToOwner(`⚠️ ${problems.join("\n")}`);
      } catch (err) {
        await sendToOwner(`⚠️ 截图失败：${err.message}`);
      }
      return true;
    }
    case "/approve": {
      const pa = takeActiveApproval(rt);
      saveRt();
      if (pa.state === "none") {
        await sendToOwner("现在没有等待批准的操作。");
        return true;
      }
      if (pa.state === "expired") {
        await sendToOwner(`刚才被拦下的操作超过 ${APPROVAL_TTL_MS / 60_000} 分钟了，没有执行。如果还需要，请重新让我做一次。`);
        return true;
      }
      const allowed = denialsToAllowedTools(pa.pending.denials);
      log(`用户批准：${allowed.join(" , ")}`);
      rt.pendingApproval = null;
      saveRt();
      await converse("用户已经批准了刚才被安全检查拦下的操作。请继续完成刚才的任务。", { allowedTools: allowed });
      return true;
    }
    case "/resume": {
      const arg = args[0];
      if (!arg) {
        const list = listSessions(projectDirOf(WORKSPACE), { limit: 5 });
        if (!list.length) {
          await sendToOwner("还没有可以接着聊的历史对话。");
          return true;
        }
        rt.resumeChoices = list.map((s) => s.id);
        saveRt();
        const lines = list.map((s, i) => {
          const title = s.title ? s.title.slice(0, 30) : "（无文字记录）";
          const mark = s.id === rt.sessionId ? "  ← 当前" : "";
          return `${i + 1}. ${fmtTime(s.mtime)}  ${title}${mark}`;
        });
        await sendToOwner(`最近的对话：\n${lines.join("\n")}\n发 /resume 编号 接着聊，例如 /resume 2。`);
        return true;
      }
      const n = Number(arg);
      const id = Number.isInteger(n) ? rt.resumeChoices?.[n - 1] : undefined;
      if (!id) {
        await sendToOwner("没有这个编号。先发 /resume 看一下列表。");
        return true;
      }
      if (rt.sessionId !== id) {
        rt.sessionId = id;
        rt.sessionCostUsd = null; // baseline for this session's cost is set by the next call
      }
      rt.sessionUpdatedAt = Date.now();
      rt.pendingApproval = null;
      saveRt();
      await sendToOwner("好的，已经切换到那段对话，接下来的消息会接着它聊。");
      return true;
    }
    case "/model": {
      const m = args[0];
      if (!m) {
        await sendToOwner(`当前模型：${currentModel() || "默认（跟随 Claude Code）"}\n可选：opus / sonnet / haiku / fable / default`);
        return true;
      }
      rt.model = m.toLowerCase() === "default" ? "" : m;
      saveRt();
      await sendToOwner(`已切换到：${rt.model || "默认模型"}，下一条消息开始生效。`);
      return true;
    }
    case "/effort": {
      const e = (args[0] || "").toLowerCase();
      if (!e) {
        await sendToOwner(
          `当前思考程度：${currentEffort() || "默认（跟随模型）"}\n可选：${EFFORT_LEVELS.join(" / ")} / default\n越高想得越久、越准，也越费额度和时间。`,
        );
        return true;
      }
      if (e !== "default" && !EFFORT_LEVELS.includes(e)) {
        await sendToOwner(`没有「${args[0]}」这一档。可选：${EFFORT_LEVELS.join(" / ")} / default`);
        return true;
      }
      rt.effort = e === "default" ? "" : e;
      saveRt();
      await sendToOwner(`思考程度已调到：${rt.effort || "默认"}，下一条消息开始生效。`);
      return true;
    }
    default:
      return false;
  }
}

function statusText() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = usageSince(startOfDay);
  const week = usageSince(new Date(Date.now() - 7 * 86400_000));
  const lines = [
    `状态：${currentRun ? `正在处理（已 ${Math.round((Date.now() - currentRun.startedAt) / 1000)} 秒，发 /stop 可停止）` : "空闲"}${queue.length ? `，排队 ${queue.length} 条` : ""}`,
    `模型：${currentModel() || "默认（跟随 Claude Code）"}`,
    `思考程度：${currentEffort() || "默认（跟随模型）"}`,
    `会话：${rt.sessionId ? `进行中（上次 ${fmtTime(rt.sessionUpdatedAt)}）` : "新会话"}`,
    `今天：${today.calls} 次，约 $${today.total.toFixed(3)}（按官方标价折算）`,
    `近 7 天：${week.calls} 次，约 $${week.total.toFixed(3)}`,
    `定时任务：${(cfg.schedules || []).filter((s) => s.enabled).length} 个已启用`,
  ];
  const pa = takeActiveApproval(rt);
  saveRt();
  if (pa.state === "active") lines.push(`等待批准：${pa.pending.denials.length} 个操作（发 /approve，${APPROVAL_TTL_MS / 60_000} 分钟内有效）`);
  if (rt.credentialExpiresAt) lines.push(`Claude 登录有效期至：${new Date(rt.credentialExpiresAt).toLocaleString("zh-CN", { hour12: false })}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ work queue (one Claude call at a time)

const queue = [];
let busy = false;

function enqueue(item) {
  queue.push(item);
  // Start on the next tick so all messages from one getupdates batch are queued (and merged) first.
  setImmediate(() => void worker());
}

function wakePrompt({ name, prompt }) {
  return `【系统定时任务「${name}」触发，这不是用户发来的消息。现在是 ${fmtTime()}】\n${prompt}\n\n（如果判断现在没必要打扰用户，只回复 NO_MESSAGE。）`;
}

async function worker() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length && !stopping) {
      const item = queue.shift();
      try {
        if (item.type === "wake") {
          if (!rt.contextToken) {
            log(`定时任务「${item.name}」跳过：还没收到过你的微信消息，无法主动发送`);
            continue;
          }
          await converse(wakePrompt(item), { isWake: true });
          continue;
        }
        const batch = [item];
        while (queue[0]?.type === "wechat") batch.push(queue.shift());
        const texts = [];
        for (const b of batch) texts.push({ at: b.msg.create_time_ms, text: await describeMessage(b.msg) });
        if (batch.length === 1 && texts[0].text.startsWith("/") && (await handleCommand(texts[0].text))) continue;
        const prompt = texts
          .filter((t) => t.text)
          .map((t) => `[${fmtTime(t.at)}] ${t.text}`)
          .join("\n");
        if (!prompt) continue;
        await converse(prompt);
      } catch (err) {
        log("处理失败:", err.stack || err.message);
        try {
          await sendToOwner(`⚠️ 出错了：${err.message}`);
        } catch {
          /* nothing more we can do */
        }
      }
    }
  } finally {
    busy = false;
  }
}

// ------------------------------------------------------------------ long-poll loop

const seen = new Set(rt.seenIds || []);

function handleInbound(m) {
  if (m.message_type === ilink.MessageType.BOT) return;
  const id = m.message_id || `${m.from_user_id}-${m.create_time_ms}-${m.seq}`;
  if (seen.has(id)) return;
  seen.add(id);
  rt.seenIds = [...seen].slice(-200);
  if (!isOwner(m.from_user_id)) {
    log("忽略非绑定用户的消息:", m.from_user_id);
    saveRt();
    return;
  }
  if (m.context_token) {
    rt.contextToken = m.context_token;
    rt.contextTokenAt = Date.now();
  }
  rt.peerUserId = m.from_user_id;
  rt.lastInboundAt = Date.now();
  saveRt();
  log(`收到微信消息（类型 ${(m.item_list || []).map((i) => i.type).join(",") || "无"}）`);
  const text = plainTextOf(m);
  if (/^\/(stop|status)\b/i.test(text)) {
    handleUrgentCommand(text).catch((err) => log("指令处理失败:", err.message));
    return;
  }
  enqueue({ type: "wechat", msg: m });
}

async function pollLoop() {
  let failures = 0;
  let timeoutMs = 35_000;
  while (!stopping) {
    try {
      const resp = await ilink.getUpdates({ ...api, buf: rt.getUpdatesBuf, timeoutMs, signal: abort.signal });
      if (resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;
      const isErr = (resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0);
      if (isErr) {
        if (resp.ret === ilink.STALE_TOKEN || resp.errcode === ilink.STALE_TOKEN) {
          log("微信 ClawBot 登录态失效（-14）：请重新运行 node login.js 扫码。1 小时后自动重试。");
          await sleep(3600_000);
          continue;
        }
        failures++;
        log(`getupdates 失败 ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg || ""}`);
        await sleep(failures >= 3 ? 30_000 : 2000);
        if (failures >= 3) failures = 0;
        continue;
      }
      failures = 0;
      if (resp.get_updates_buf) {
        rt.getUpdatesBuf = resp.get_updates_buf;
        saveRt();
      }
      for (const m of resp.msgs || []) handleInbound(m);
    } catch (err) {
      if (stopping) break;
      failures++;
      log("getupdates 网络错误:", err.message);
      await sleep(failures >= 3 ? 30_000 : 2000);
      if (failures >= 3) failures = 0;
    }
  }
}

// ------------------------------------------------------------------ schedules

function scheduleTick() {
  const now = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const today = now.toDateString();
  rt.scheduleRuns ||= {};
  for (const s of cfg.schedules || []) {
    if (!s.enabled || !s.prompt) continue;
    if (Array.isArray(s.days) && !s.days.includes(now.getDay())) continue;
    const key = s.name || s.time || `every-${s.everyMinutes}`;
    if (s.time) {
      if (s.time !== hhmm || rt.scheduleRuns[key] === today) continue;
      rt.scheduleRuns[key] = today;
    } else if (s.everyMinutes > 0) {
      if (Array.isArray(s.activeHours) && s.activeHours.length === 2) {
        const [from, to] = s.activeHours;
        if (hhmm < from || hhmm >= to) continue;
      }
      const last = Number(rt.scheduleRuns[key]) || 0;
      if (Date.now() - last < s.everyMinutes * 60_000) continue;
      rt.scheduleRuns[key] = Date.now();
    } else {
      continue;
    }
    saveRt();
    log(`定时任务触发：${key}`);
    enqueue({ type: "wake", name: key, prompt: s.prompt });
  }
}

// ------------------------------------------------------------------ local control endpoint (127.0.0.1 only)

const server = http.createServer(async (req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  if (req.headers["x-local-token"] !== localToken) return reply(401, { error: "unauthorized" });
  if (req.method === "GET" && req.url === "/status") return reply(200, { text: statusText(), busy, queued: queue.length });
  if (req.method !== "POST") return reply(404, { error: "not found" });
  let body = "";
  for await (const chunk of req) body += chunk;
  let data;
  try {
    data = JSON.parse(body || "{}");
  } catch {
    return reply(400, { error: "bad json" });
  }
  if (req.url === "/shutdown") {
    reply(200, { stopping: true });
    void shutdown();
    return;
  }
  if (req.url === "/wake") {
    if (!data.prompt) return reply(400, { error: "prompt required" });
    enqueue({ type: "wake", name: data.name || "手动唤醒", prompt: String(data.prompt) });
    return reply(202, { queued: true });
  }
  if (req.url === "/send") {
    if (!data.text) return reply(400, { error: "text required" });
    try {
      await sendToOwner(String(data.text));
      return reply(200, { sent: true });
    } catch (err) {
      return reply(500, { error: err.message });
    }
  }
  if (req.url === "/sendfile") {
    if (!data.path) return reply(400, { error: "path required" });
    try {
      const problems = await sendFilesToOwner([String(data.path)]);
      return problems.length ? reply(500, { error: problems.join("; ") }) : reply(200, { sent: true });
    } catch (err) {
      return reply(500, { error: err.message });
    }
  }
  return reply(404, { error: "not found" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${cfg.wakePort} 已被占用：可能已经有一个桥接程序在运行了。两个同时运行会抢消息，所以本次退出。`);
  } else {
    console.error("本地控制端口启动失败:", err.message);
  }
  process.exit(1);
});

// ------------------------------------------------------------------ start / stop

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("正在退出…");
  currentRun?.abort.abort();
  try {
    await ilink.notifyStop(api);
  } catch {
    /* ignore */
  }
  saveRt();
  // Exit without aborting the in-flight long-poll first: aborting a socket right before exit
  // trips a libuv assertion on Windows. Exiting tears the socket down anyway.
  setTimeout(() => process.exit(0), 50);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// When started in the background there is no console, so record crashes in bridge.log.
// Exiting non-zero lets launcher.vbs restart the bridge.
process.on("uncaughtException", (err) => {
  log("程序崩溃:", err.stack || err.message);
  setTimeout(() => process.exit(1), 50);
});
process.on("unhandledRejection", (err) => {
  log("未处理的异常:", err?.stack || String(err));
});

server.listen(cfg.wakePort, "127.0.0.1", async () => {
  log(`桥接程序已启动。Claude：${claudePath}；工作目录：${WORKSPACE}`);
  resetSessionIfPromptChanged();
  try {
    await ilink.notifyStart(api);
  } catch (err) {
    log("notifystart 失败（不影响收发）:", err.message);
  }
  if (cfg.announceOnStart && rt.contextToken) {
    sendToOwner("我上线了 👋").catch((err) => log("上线提醒发送失败:", err.message));
  }
  setInterval(scheduleTick, 20_000);
  void pollLoop();
});
