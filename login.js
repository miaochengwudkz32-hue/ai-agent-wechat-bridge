// Bind this computer to your WeChat ClawBot by scanning a QR code.
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import readline from "node:readline/promises";
import QRCode from "qrcode";
import * as ilink from "./src/ilink.js";
import { STATE_DIR, ACCOUNT_FILE, RUNTIME_FILE, readJson, writeJson } from "./src/store.js";

const QR_PNG = path.join(STATE_DIR, "login-qr.png");
const MAX_REFRESH = 3;

async function showQr(content) {
  console.log(await QRCode.toString(content, { type: "terminal", small: true }));
  await QRCode.toFile(QR_PNG, content, { width: 360, margin: 2 });
  console.log(`二维码图片：${QR_PNG}（终端里的二维码扫不了时，扫这张图片）`);
  console.log(`二维码内容：${content}`);
  if (process.platform === "win32") exec(`start "" "${QR_PNG}"`);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function main() {
  const existing = readJson(ACCOUNT_FILE);
  console.log("正在向微信申请绑定二维码…");
  let qr = await ilink.fetchQrCode(existing?.token ? [existing.token] : []);
  if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error(`没拿到二维码：${JSON.stringify(qr).slice(0, 300)}`);
  console.log("\n用手机微信扫描下面的二维码，在手机上确认连接：\n");
  await showQr(qr.qrcode_img_content);

  let baseUrl = ilink.FIXED_BASE_URL;
  let verifyCode;
  let refreshes = 1;
  let scannedShown = false;
  const deadline = Date.now() + 8 * 60_000;

  while (Date.now() < deadline) {
    const st = await ilink.pollQrStatus(baseUrl, qr.qrcode, verifyCode);
    switch (st.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        verifyCode = undefined;
        if (!scannedShown) console.log("\n已扫码，请在手机上确认…");
        scannedShown = true;
        break;
      case "need_verifycode":
        verifyCode = await ask(verifyCode ? "数字不对，请重新输入手机微信上显示的数字：" : "请输入手机微信上显示的数字：");
        continue;
      case "scaned_but_redirect":
        if (st.redirect_host) baseUrl = `https://${st.redirect_host}`;
        break;
      case "expired":
      case "verify_code_blocked":
        refreshes++;
        if (refreshes > MAX_REFRESH) throw new Error("二维码多次失效，请稍后重新运行 node login.js");
        console.log(st.status === "expired" ? "\n二维码过期了，正在刷新…" : "\n输入错误次数过多，正在刷新二维码…");
        qr = await ilink.fetchQrCode(existing?.token ? [existing.token] : []);
        verifyCode = undefined;
        scannedShown = false;
        await showQr(qr.qrcode_img_content);
        break;
      case "binded_redirect":
        if (existing?.token) {
          console.log("\n这台电脑之前已经绑定过，原来的绑定仍然有效，不用重复绑定。");
          return;
        }
        throw new Error("微信提示这个 ClawBot 已经绑定过别的程序。请在微信 ClawBot 里解除原来的连接后再试。");
      case "confirmed": {
        if (!st.ilink_bot_id || !st.bot_token) throw new Error("微信确认了，但没有返回 bot 凭据，请重试。");
        const account = {
          token: st.bot_token,
          botId: st.ilink_bot_id,
          baseUrl: st.baseurl || baseUrl,
          userId: st.ilink_user_id || null,
          savedAt: new Date().toISOString(),
        };
        writeJson(ACCOUNT_FILE, account);
        if (existing?.botId && existing.botId !== account.botId && fs.existsSync(RUNTIME_FILE)) {
          fs.unlinkSync(RUNTIME_FILE); // different bot: old sync cursor / tokens are useless
        }
        try {
          fs.unlinkSync(QR_PNG);
        } catch {
          /* ignore */
        }
        console.log("\n✅ 绑定成功！现在运行  node bridge.js  启动桥接程序，然后在微信里给 ClawBot 发条消息试试。");
        return;
      }
      default:
        break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("等待扫码超时，请重新运行 node login.js");
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
