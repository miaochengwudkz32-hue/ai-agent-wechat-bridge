// Minimal client for Tencent's WeChat ClawBot iLink API.
// Protocol details follow the official MIT-licensed plugin @tencent-weixin/openclaw-weixin (v2.4.10).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const PROTOCOL_VERSION = "2.4.10"; // iLink protocol version this client implements
const APP_ID = "bot";
const BOT_AGENT = "ClaudeCodeWeChatBridge/0.1";

export const MessageType = { USER: 1, BOT: 2 };
export const MessageState = { FINISH: 2 };
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5, TOOL_CALL_START: 11, TOOL_CALL_RESULT: 12 };
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3 };
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const TypingStatus = { TYPING: 1, CANCEL: 2 };
export const STALE_TOKEN = -14; // bot token expired -> re-scan QR
export const RATE_LIMITED = -2; // roughly 7 messages / 5 minutes per bot

export class ILinkError extends Error {
  constructor(message, ret) {
    super(message);
    this.ret = ret;
  }
}

function clientVersion(v) {
  const [a = 0, b = 0, c = 0] = v.split(".").map((n) => parseInt(n, 10) || 0);
  return ((a & 0xff) << 16) | ((b & 0xff) << 8) | (c & 0xff);
}

const COMMON_HEADERS = {
  "iLink-App-Id": APP_ID,
  "iLink-App-ClientVersion": String(clientVersion(PROTOCOL_VERSION)),
};

function randomUin() {
  const n = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), "utf-8").toString("base64");
}

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };
}

function withSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/** JSON.parse that keeps uint64 message ids as strings. */
export function parseJson(raw) {
  const fixed = raw.replace(/"(message_id|msg_id|svr_id)"(\s*:\s*)(-?\d+)/g, '"$1"$2"$3"');
  return JSON.parse(fixed);
}

async function request(method, baseUrl, endpoint, { body, token, timeoutMs = 15000, signal } = {}) {
  const url = new URL(endpoint, withSlash(baseUrl));
  const headers = { ...COMMON_HEADERS };
  if (method === "POST") {
    Object.assign(headers, {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomUin(),
    });
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return raw ? parseJson(raw) : {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------- login (QR)

export function fetchQrCode(localTokens = []) {
  return request("POST", FIXED_BASE_URL, "ilink/bot/get_bot_qrcode?bot_type=3", {
    body: { local_token_list: localTokens },
  });
}

export async function pollQrStatus(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await request("GET", baseUrl, endpoint, { timeoutMs: 35000 });
  } catch {
    return { status: "wait" }; // long-poll timeout or transient network error
  }
}

// ---------------------------------------------------------------- messaging

export async function getUpdates({ baseUrl, token, buf, timeoutMs = 35000, signal }) {
  try {
    return await request("POST", baseUrl, "ilink/bot/getupdates", {
      body: { get_updates_buf: buf ?? "", base_info: baseInfo() },
      token,
      timeoutMs,
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError" && !signal?.aborted) {
      return { ret: 0, msgs: [], get_updates_buf: buf }; // normal long-poll timeout
    }
    throw err;
  }
}

function clientId() {
  return `claude-wechat-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Send one message item (text, image, file, tool progress...). runId groups items of one reply. */
export async function sendItem({ baseUrl, token, to, item, contextToken, runId }) {
  const resp = await request("POST", baseUrl, "ilink/bot/sendmessage", {
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: contextToken || undefined,
        run_id: runId || undefined,
      },
      base_info: baseInfo(),
    },
    token,
  });
  if (resp.ret && resp.ret !== 0) {
    throw new ILinkError(`sendmessage ret=${resp.ret} ${resp.errmsg ?? ""}`.trim(), resp.ret);
  }
  return resp;
}

export function sendText({ text, ...rest }) {
  return sendItem({ ...rest, item: { type: ItemType.TEXT, text_item: { text } } });
}

/** Tool-call progress shown natively by ClawBot (same items the official plugin sends). */
export function sendToolProgress({ phase, toolName, toolCallId, status, ...rest }) {
  const now = Date.now();
  const item =
    phase === "start"
      ? {
          type: ItemType.TOOL_CALL_START,
          create_time_ms: now,
          is_completed: false,
          tool_call_start_item: { tool_name: toolName, tool_call_id: toolCallId },
        }
      : {
          type: ItemType.TOOL_CALL_RESULT,
          create_time_ms: now,
          is_completed: true,
          tool_call_result_item: { tool_name: toolName, tool_call_id: toolCallId, status: status || "completed" },
        };
  return sendItem({ ...rest, item });
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);

/** Encrypt (AES-128-ECB) and upload a file to the WeChat CDN; returns what a media item needs. */
async function uploadMedia({ baseUrl, token, to, buf, mediaType }) {
  const rawsize = buf.length;
  const filesize = Math.ceil((rawsize + 1) / 16) * 16;
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const up = await request("POST", baseUrl, "ilink/bot/getuploadurl", {
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: to,
      rawsize,
      rawfilemd5: crypto.createHash("md5").update(buf).digest("hex"),
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: baseInfo(),
    },
    token,
  });
  const url =
    up.upload_full_url?.trim() ||
    (up.upload_param
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : "");
  if (!url) throw new Error(`getuploadurl 没有返回上传地址：${JSON.stringify(up).slice(0, 200)}`);
  const cipher = crypto.createCipheriv("aes-128-ecb", aeskey, null);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
      if (res.status !== 200) {
        const msg = res.headers.get("x-error-message") || `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`CDN 上传被拒绝：${msg}`), { fatal: true });
        throw new Error(`CDN 上传失败：${msg}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) throw new Error("CDN 响应里没有下载参数");
      // aes_key in messages is base64 of the hex string, as the official plugin sends it
      return { encrypt_query_param: downloadParam, aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"), encrypt_type: 1, rawsize, filesize };
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
    }
  }
  throw lastErr;
}

/** Send a local file to WeChat as an image, video or file depending on its extension. */
export async function sendFile({ baseUrl, token, to, filePath, contextToken, runId }) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("不是文件");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error(`文件太大（${(stat.size / 1048576).toFixed(1)} MB，上限 100 MB）`);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const kind = IMAGE_EXT.has(ext) ? "image" : VIDEO_EXT.has(ext) ? "video" : "file";
  const mediaType = kind === "image" ? UploadMediaType.IMAGE : kind === "video" ? UploadMediaType.VIDEO : UploadMediaType.FILE;
  const m = await uploadMedia({ baseUrl, token, to, buf, mediaType });
  const media = { encrypt_query_param: m.encrypt_query_param, aes_key: m.aes_key, encrypt_type: m.encrypt_type };
  const item =
    kind === "image"
      ? { type: ItemType.IMAGE, image_item: { media, mid_size: m.filesize } }
      : kind === "video"
        ? { type: ItemType.VIDEO, video_item: { media, video_size: m.filesize } }
        : { type: ItemType.FILE, file_item: { media, file_name: path.basename(filePath), len: String(m.rawsize) } };
  await sendItem({ baseUrl, token, to, item, contextToken, runId });
  return kind;
}

export function getConfig({ baseUrl, token, userId, contextToken }) {
  return request("POST", baseUrl, "ilink/bot/getconfig", {
    body: { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() },
    token,
    timeoutMs: 10000,
  });
}

export function sendTyping({ baseUrl, token, userId, ticket, status }) {
  return request("POST", baseUrl, "ilink/bot/sendtyping", {
    body: { ilink_user_id: userId, typing_ticket: ticket, status, base_info: baseInfo() },
    token,
    timeoutMs: 10000,
  });
}

export function notifyStart({ baseUrl, token }) {
  return request("POST", baseUrl, "ilink/bot/msg/notifystart", {
    body: { base_info: baseInfo() },
    token,
    timeoutMs: 10000,
  });
}

export function notifyStop({ baseUrl, token }) {
  return request("POST", baseUrl, "ilink/bot/msg/notifystop", {
    body: { base_info: baseInfo() },
    token,
    timeoutMs: 10000,
  });
}

// ---------------------------------------------------------------- media (CDN)

function parseAesKey(keyB64) {
  const decoded = Buffer.from(keyB64, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  throw new Error(`unexpected aes key length ${decoded.length}`);
}

/**
 * Download an inbound CDN file and decrypt it (AES-128-ECB).
 * @param media CDNMedia object from the message item
 * @param hexKey optional raw 16-byte key as hex (image_item.aeskey); preferred when present
 */
export async function downloadMedia(media, hexKey) {
  if (!media?.encrypt_query_param && !media?.full_url) throw new Error("no media reference");
  const url =
    media.full_url ||
    `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const key = hexKey ? Buffer.from(hexKey, "hex") : media.aes_key ? parseAesKey(media.aes_key) : null;
  if (!key) return data; // plain (unencrypted) media
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
