// Wake the running bridge from a script or Task Scheduler.
//   node wake.js "看看今天有没有需要处理的事，有就提醒我"   -> Claude runs the prompt and messages you
//   node wake.js --send "直接发这句话"                   -> send text as-is (no Claude, no quota)
//   node wake.js --status                                -> print bridge status
//   node wake.js --file "C:\path\to\file.pdf"           -> send a file or image to your WeChat
//   node wake.js --stop                                 -> stop the bridge (and the background launcher)
//   node wake.js --open                                  -> open the current WeChat conversation in the Claude desktop app
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LOCAL_TOKEN_FILE, RUNTIME_FILE, loadConfig, readJson } from "./src/store.js";
import { findClaude } from "./src/claude.js";

const cfg = loadConfig();
const token = fs.existsSync(LOCAL_TOKEN_FILE) ? fs.readFileSync(LOCAL_TOKEN_FILE, "utf-8").trim() : "";
const base = `http://127.0.0.1:${cfg.wakePort}`;
const args = process.argv.slice(2);

async function call(method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json", "x-local-token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

try {
  if (args[0] === "--open") {
    const rt = readJson(RUNTIME_FILE, {});
    if (!rt.sessionId) throw new Error("现在没有进行中的会话（在微信里发条消息就会有）");
    const r = spawnSync(findClaude(cfg.claudePath), ["--desktop", "--resume", rt.sessionId], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  } else if (args[0] === "--status") {
    console.log((await call("GET", "/status")).text);
  } else if (args[0] === "--stop") {
    await call("POST", "/shutdown", {});
    console.log("已让桥接程序退出（后台启动器也会随之结束，直到下次开机或手动启动）");
  } else if (args[0] === "--file") {
    const file = args.slice(1).join(" ");
    if (!file) throw new Error('用法：node wake.js --file "文件路径"');
    await call("POST", "/sendfile", { path: path.resolve(file) });
    console.log("已发送文件");
  } else if (args[0] === "--send") {
    const text = args.slice(1).join(" ");
    if (!text) throw new Error('用法：node wake.js --send "要发的文字"');
    await call("POST", "/send", { text });
    console.log("已发送");
  } else {
    const prompt = args.join(" ");
    if (!prompt) throw new Error('用法：node wake.js "让 Claude 做的事"');
    await call("POST", "/wake", { prompt, name: "脚本唤醒" });
    console.log("已交给 Claude 处理，结果会发到你微信");
  }
} catch (err) {
  const msg = err.cause?.code === "ECONNREFUSED" ? "桥接程序没有在运行（先运行 node bridge.js）" : err.message;
  console.error(`失败：${msg}`);
  process.exit(1);
}
