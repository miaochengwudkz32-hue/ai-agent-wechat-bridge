# AI Agent 接入微信（ClawBot）

让任意 AI 编程 agent 接入微信 ClawBot：在微信里发消息，agent 在你的电脑上执行，结果发回微信。

本仓库包含三部分：

1. **任务书**（下面「一、给 AI agent 的任务书」）：整段复制给 Claude Code、Codex、Gemini CLI 等任何 agent，它就能按要求开工。
2. **指南 PDF**：
   - `让ai-agent接入微信.pdf`：通用版，架构、协议参考、agent 接口约定、踩坑清单、验收清单。
   - `在微信上指挥Claude-code.pdf`：Claude Code 的具体搭建经验。
3. **参考实现**（Claude Code 版）：`bridge.js`、`login.js`、`wake.js` 等。它是这套方案的一个可运行例子，详见 `docs/bridge-setup.md`。

> 本项目与腾讯无关联。协议细节参考腾讯官方开源插件 `@tencent-weixin/openclaw-weixin`（MIT）。腾讯可能随时修改接口。

---

## 一、给 AI agent 的任务书

把下面整段复制给你的 agent（在希望它运行的 Windows 电脑上）。

```
【目标】
帮我把「微信 ClawBot」接入这台电脑上的 AI agent。我在微信里给 ClawBot 发消息，agent 在本机执行，结果发回微信。
要支持：多轮对话（会话可恢复）、进度提示、文字和文件/图片回传、/stop /new /status 等指令、定时主动推送、开机后台自启。

【硬性要求】
1. 只绑定我自己的微信账号。扫码后记录绑定用户的 ID，之后只处理这个用户的消息，其他人的消息直接忽略、不回复。
2. 不要在输出、日志或聊天里打印 bot_token、账号文件内容或任何 API key。凭据只保存在本地 state/ 目录，并加入 .gitignore。
3. 不要猜测接口字段。以本仓库 PDF 的协议参考为准；参考里没有的、或你不确定的字段，先查证，查不到就告诉我，不要编。
4. 调用 agent 时，要把 API key 相关的环境变量从子进程里删掉，让它使用 agent 自己的登录方式。
5. 无界面运行时没法弹窗确认。危险操作要被拦下，拦下的操作列给我，等我在微信回复 /approve 后才执行。
6. 凡是对外发消息、删除或覆盖文件、付款、改账号设置，必须先在微信里问我，等我同意再做。

【交付物】
- src/ilink.js：微信接口封装（请求头、收消息、发文字、上传并发文件、正在输入）。
- src/agent.js：本机 agent 调用层，实现 PDF 中的接口约定，只写这一个文件就能换 agent。
- bridge.js：常驻主程序（长轮询、白名单、消息队列、指令、本机控制口）。
- login.js：生成二维码，扫码后保存绑定信息。wake.js：本机命令行工具（发文字、发文件、查状态、停止）。
- config.json、README.md（写清楚怎么启动、怎么停止、怎么看日志）、test/（模拟微信服务器的端到端测试）。

【执行顺序】
第 1 步：列出你要用的 agent 的非交互调用方式：执行命令、输出格式、会话恢复、权限参数。标明哪些是你查到的，哪些是猜的。查不到就停下来问我。
第 2 步：实现 ilink.js，用模拟服务器测通收发、上传。
第 3 步：实现 agent.js，单独跑一条「只回复收到」，确认能拿到文本和会话 ID。
第 4 步：实现 bridge.js 和 wake.js，跑 PDF 中的验收清单，每项给出实测结果。
第 5 步：做开机自启：放进「启动」文件夹的 vbs，后台无窗口运行；程序崩溃 30 秒后自动重启。
每完成一步就汇报。扫码绑定需要我手动完成，你给出二维码后暂停等我。

【完成标准】
验收清单每一项都有实测结果。没测过的项目要明说，不能写成「应该可以」。
```

---

## 二、仓库结构

| 路径 | 内容 |
|---|---|
| `让ai-agent接入微信.pdf` | 通用版指南 |
| `在微信上指挥Claude-code.pdf` | Claude Code 版搭建经验 |
| `bridge.js` | 桥接主程序 |
| `login.js` | 扫码绑定 |
| `wake.js` | 本机命令行工具（发消息、发文件、停止） |
| `src/ilink.js` | 微信 iLink 接口封装 |
| `src/claude.js` | Claude Code 调用层（换 agent 时替换这一层） |
| `src/store.js`、`src/text.js` | 配置、持久化、文本切分等辅助函数 |
| `prompts/wechat-system.md` | 给 agent 的微信场景说明 |
| `config.json` | 配置（模型、权限模式、定时任务等） |
| `launcher.vbs`、`open-in-desktop.cmd` | 后台启动器、在桌面 app 中打开对话 |
| `test/` | 单元测试和模拟微信服务器的端到端测试 |
| `docs/bridge-setup.md` | Claude Code 版的使用说明 |

运行时生成的 `state/`（含绑定凭据）和 `workspace/` 已在 `.gitignore` 中排除，不会被提交。

## 三、快速开始（Claude Code 版）

需要 Node.js 22 或更新版本，以及已登录的 Claude Code。

```powershell
npm install
node login.js        # 用手机微信扫码并确认
node bridge.js       # 启动桥接程序
```

更多说明见 `docs/bridge-setup.md`。

## 四、安全须知

- 这相当于把电脑上 agent 的能力开放给微信。只绑定你自己的账号，并保留白名单。
- `state/` 里的绑定文件等于凭据，不要提交、不要分享。
- 不要把权限模式设成完全放行。删除、覆盖、发送、付款等操作应该先让你确认。

## 许可证

MIT，见 `LICENSE`。
