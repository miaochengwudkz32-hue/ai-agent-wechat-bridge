// Fake iLink server for an end-to-end test of bridge.js without touching real WeChat.
// Usage: node test/mock-ilink.mjs <port> "<first user message>"
import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.argv[2] || 18799);
const firstText = process.argv[3] || "只回复两个字：你好";
let delivered = false;
const pending = []; // messages queued via POST /inject
const uploads = new Map(); // filekey -> { aeskey, rawsize, md5 }
let nextId = 987654321098765433n;
const inbound = (text) =>
  `{"message_id":${nextId++},"from_user_id":"owner@im.wechat","to_user_id":"bot@im.bot","message_type":1,"context_token":"ctx-1","create_time_ms":${Date.now()},"item_list":[{"type":1,"text_item":{"text":${JSON.stringify(text)}}}]}`;

function describeItem(it) {
  if (!it) return "item=none";
  switch (it.type) {
    case 1:
      return `item=1 text=${JSON.stringify(it.text_item?.text)}`;
    case 2:
      return `item=2 image mid_size=${it.image_item?.mid_size} param=${it.image_item?.media?.encrypt_query_param} key=${it.image_item?.media?.aes_key ? "yes" : "no"}`;
    case 4:
      return `item=4 file name=${JSON.stringify(it.file_item?.file_name)} len=${it.file_item?.len} param=${it.file_item?.media?.encrypt_query_param}`;
    case 5:
      return `item=5 video size=${it.video_item?.video_size}`;
    default:
      return `item=${it.type}`;
  }
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const route = url.pathname;
  const send = (obj, rawJson, headers = {}) => {
    res.writeHead(200, { "Content-Type": "application/json", ...headers });
    res.end(rawJson ?? JSON.stringify(obj));
  };

  if (route === "/cdn/upload") {
    const filekey = url.searchParams.get("filekey");
    const meta = uploads.get(filekey);
    let detail = "unknown filekey";
    if (meta) {
      const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(meta.aeskey, "hex"), null);
      const plain = Buffer.concat([decipher.update(raw), decipher.final()]);
      const md5 = crypto.createHash("md5").update(plain).digest("hex");
      detail = `decrypted=${plain.length} rawsize=${meta.rawsize} md5match=${md5 === meta.md5}`;
    }
    console.log(`MOCK cdn upload ${detail}`);
    return send({}, "{}", { "x-encrypted-param": `dl-${filekey}` });
  }

  const json = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
  if (route !== "/inject" && req.headers.authorization !== "Bearer test-token") {
    console.log(`MOCK bad auth on ${route}: ${req.headers.authorization}`);
  }
  switch (route) {
    case "/ilink/bot/getupdates":
      if (!delivered) {
        delivered = true;
        // raw JSON with an unquoted uint64 id, like the real server
        return send(null, `{"ret":0,"get_updates_buf":"buf-1","msgs":[${inbound(firstText)}]}`);
      }
      if (pending.length) {
        return send(null, `{"ret":0,"get_updates_buf":"buf-2","msgs":[${inbound(pending.shift())}]}`);
      }
      setTimeout(() => send({ ret: 0, msgs: [], get_updates_buf: json.get_updates_buf }), 1500);
      return;
    case "/ilink/bot/getuploadurl":
      uploads.set(json.filekey, { aeskey: json.aeskey, rawsize: json.rawsize, md5: json.rawfilemd5 });
      console.log(`MOCK getuploadurl media_type=${json.media_type} rawsize=${json.rawsize} filesize=${json.filesize}`);
      return send({ upload_full_url: `http://127.0.0.1:${port}/cdn/upload?filekey=${json.filekey}` });
    case "/ilink/bot/sendmessage": {
      const it = json.msg?.item_list?.[0];
      if (it?.type === 11 || it?.type === 12) {
        const p = it.tool_call_start_item || it.tool_call_result_item;
        console.log(`MOCK progress ${it.type === 11 ? "start" : "end"} run=${json.msg?.run_id ? "yes" : "no"} tool=${JSON.stringify(p?.tool_name)}${p?.status ? ` status=${p.status}` : ""}`);
        return send({ ret: 0 });
      }
      console.log(`MOCK sendmessage to=${json.msg?.to_user_id} ctx=${json.msg?.context_token} type=${json.msg?.message_type} ${describeItem(it)}`);
      return send({ ret: 0 });
    }
    case "/ilink/bot/getconfig":
      console.log(`MOCK getconfig user=${json.ilink_user_id}`);
      return send({ ret: 0, typing_ticket: "ticket-1" });
    case "/ilink/bot/sendtyping":
      console.log(`MOCK sendtyping status=${json.status}`);
      return send({ ret: 0 });
    case "/ilink/bot/msg/notifystart":
    case "/ilink/bot/msg/notifystop":
      console.log(`MOCK ${route.split("/").pop()} agent=${json.base_info?.bot_agent}`);
      return send({ ret: 0 });
    case "/inject":
      pending.push(json.text);
      console.log(`MOCK injected ${JSON.stringify(json.text)}`);
      return send({ ok: true });
    default:
      console.log(`MOCK unknown route ${route}`);
      return send({ ret: -1, errmsg: "unknown" });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`MOCK listening on ${port}`));
