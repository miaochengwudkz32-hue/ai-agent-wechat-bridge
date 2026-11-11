# 微信 ⇄ Claude Code 桥接程序

在微信里通过官方「微信 ClawBot」插件和电脑上的 Claude Code 聊天，Claude 也能按定时任务主动给你发消息。
用的是你电脑上已登录的 Claude Code（订阅或企业账号），不需要 API key。

## 第一次使用

```powershell
cd C:\Users\你的用户名\.claude-wechat
npm install          # 只装一个生成二维码的小依赖
node login.js        # 弹出二维码，用手机微信扫码并确认
node bridge.js       # 启动桥接程序，窗口不要关
```

然后在微信里找到 ClawBot，发一条消息试试。

## 开机自启动（已设置）

登录 Windows 后，`启动` 文件夹里的 `Claude WeChat Bridge.vbs` 会在后台（无窗口）运行 `launcher.vbs`，
它负责启动 bridge.js，程序崩溃时 30 秒后自动重启。

| 想做的事 | 怎么做 |
|---|---|
| 看是否在运行 | `node wake.js --status`，或看 `state\bridge.log` |
| 暂时停止 | `node wake.js --stop`（下次开机会自动再启动） |
| 手动启动 | 双击 `launcher.vbs` |
| 关闭开机自启动 | 删除 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Claude WeChat Bridge.vbs`，或在任务管理器 → 启动应用里禁用 |

注意：
- 同一时间只能运行一个 bridge.js。想在终端里手动运行调试，先 `node wake.js --stop`。
- 手动启动请双击 `launcher.vbs`（或运行 `explorer.exe C:\Users\你的用户名\.claude-wechat\launcher.vbs`）。不要在终端里直接运行 `wscript launcher.vbs`：关掉那个终端时，程序可能会被一起结束，微信里就会显示「暂时无法连接」。

## 在桌面 app 里打开微信对话

- 双击 `open-in-desktop.cmd`（或运行 `node wake.js --open`）：把当前这段微信对话在 Claude 桌面 app 里打开，能看到完整记录，也能接着聊。
- 打开以前的会话：`claude --desktop --resume <会话ID>`。会话 ID 就是 `C:\Users\你的用户名\.claude\projects\<项目目录编码>\` 里 `.jsonl` 文件的文件名。
- 注意：同一段对话不要在桌面 app 和微信里同时聊，两边会各写各的、把对话写乱。在桌面里聊完，想回到微信继续，最好先关掉桌面里这个会话；或者在微信里发 `/new` 开新对话。

## 微信里能用的指令

| 指令 | 作用 |
|---|---|
| `/stop` | 立刻停止正在做的事（相当于在 Claude Code 里按 Esc），连它开的命令一起结束 |
| `/approve` | 批准刚才被安全检查拦下的操作，让 Claude 继续。批准只在 10 分钟内有效，过期后需要重新发起操作 |
| `/resume` | 列出当前项目最近 5 段对话；发 `/resume 编号` 就接着聊那一段（在副本里继续，原记录不改动） |
| `/project` | 列出最近用过的项目文件夹；发 `/project 编号`（或 `/project 文件夹名`）切换过去，接着那个项目最近的对话聊、发任务；`/project 0` 回到微信默认目录 |
| `/screenshot`（或 `/截图`） | 截一张电脑全屏发给你，不经过 Claude、不耗额度 |
| `/new` | 开始新对话（清空上下文，更省额度） |
| `/model opus` / `sonnet` / `haiku` / `default` | 切换模型 |
| `/effort low` / `medium` / `high` / `xhigh` / `max` / `default` | 调整思考程度（越高越准，也越慢、越费额度） |
| `/status` | 查看模型、会话、今天和近 7 天的用量 |
| `/help` | 显示帮助 |

其他消息都直接交给 Claude。图片、文件、视频会先存到 `state\media\`，再把路径告诉 Claude；语音用微信自带的转文字结果。

## 像在 Claude Code 里一样用

- **看它干活**：Claude 每调用一次工具（运行命令、读写文件、搜索、上网），微信里都会出现一条进度提示，和 ClawBot 官方插件的显示方式一样。不想看可以在 `config.json` 里把 `showToolProgress` 改成 `false`。
- **操作电脑上的文件**：直接说，比如"把下载文件夹里的 PDF 按课程分类""把这份笔记改成提纲"。删除、覆盖文件这类难撤销的事，它会先问你。
- **要文件、要截图**：说"把 xx 发我""截个图看看"，它找到后会发到微信（图片按图片发，其他按文件发，单个上限 100 MB）。原理是 Claude 在回复里写一行 `[[发送: 路径]]`，程序识别后上传发送。
- **中途停下**：发 `/stop`。
- **被拦下的操作**：自动安全检查拦下某个操作时，回复里会列出来，回 `/approve` 就批准这一次并继续。批准 10 分钟内有效；过期后不会执行，需要重新让它做一次。
- **维护提醒**：`config.json` 里的「微信协议检查」定时任务每周一 9 点检查官方插件有没有新版本，有新版本才会发消息提醒你。
- 程序更新了给 Claude 的说明后，下一条消息会自动开新对话，让新说明生效。

## 让 Claude 主动给你发消息

**方式一：定时任务。** 编辑 `config.json` 里的 `schedules`，把 `enabled` 改成 `true`，然后重启 bridge.js。

- 每天固定时间：`"time": "08:30"`，可选 `"days": [1,2,3,4,5]`（0 是周日）
- 每隔一段时间：`"everyMinutes": 120`，可选 `"activeHours": ["09:00", "22:00"]`
- Claude 判断没必要打扰你时会回复 `NO_MESSAGE`，这时不会发消息。

**方式二：从脚本叫醒**（bridge.js 要在运行）：

```powershell
node wake.js "看看今天有没有需要处理的事，有就提醒我"   # Claude 处理后发到你微信
node wake.js --send "直接发这句话"                     # 原样发送，不调用 Claude
node wake.js --file "C:\路径\文件.pdf"                  # 把文件或图片发到你微信
node wake.js --status                                  # 查看状态
node wake.js --stop                                    # 停止桥接程序
```

注意：你至少要先给 ClawBot 发过一条消息，它才能主动发给你。如果很久没聊，主动消息可能不弹通知，随手给它发一句就能刷新。

## config.json 说明

| 字段 | 默认 | 说明 |
|---|---|---|
| `model` | `""` | 空 = 跟随 Claude Code 默认模型（目前是 Opus 5.5）。可填 `sonnet`、`haiku` 等。微信里 `/model` 切换的优先级更高 |
| `effort` | `""` | 思考强度：`low` / `medium` / `high` 等，空 = 默认 |
| `permissionMode` | `auto` | Claude Code 的权限模式。无界面模式没法弹窗问你，`auto` 会自动拦下危险操作 |
| `addDirs` | 用户目录 | 允许 Claude 访问的目录 |
| `showToolProgress` | `true` | 在微信里显示 Claude 的每一步工具调用 |
| `strictMcp` | `true` | 不加载 MCP 服务器（claude.ai 连接器等）。这样每次的提示词前缀完全一致，接着聊时几乎全走缓存，便宜很多。需要用连接器时改成 `false` |
| `sessionIdleResetHours` | `6` | 闲置超过这么多小时后自动开新对话，0 = 不自动 |
| `claudeTimeoutMinutes` | `15` | 单次处理的最长时间 |
| `maxChunkChars` | `1800` | 长回复按这个长度拆成多条 |
| `wakePort` | `18765` | 本机控制端口（只监听 127.0.0.1，带随机口令） |
| `announceOnStart` | `false` | 启动时在微信里说一声「我上线了」 |

## 文件位置

- `state\account.json`：微信 ClawBot 的绑定凭据（不要发给别人）
- `state\runtime.json`：会话、消息游标等运行状态
- `state\usage.jsonl`：每次调用的用量（按官方标价折算的美元）
- `state\bridge.log`：运行日志
- `workspace\`：Claude 运行时的工作目录

## 常见问题

- **日志里出现 -14**：微信 ClawBot 登录态失效，重新运行 `node login.js` 扫码。
- **微信里提示 Claude 登录失效**：在电脑上运行 `claude auth login` 重新登录。
- **提示端口被占用**：已经有一个 bridge.js 在运行。两个同时运行会抢消息，所以只能开一个。
- **测试**：`npm test`（文字处理）和 `node test/e2e.mjs`（用模拟的微信服务器跑一遍完整流程，会调用几次 Haiku）。

协议细节参考腾讯官方开源插件 `@tencent-weixin/openclaw-weixin`（MIT）。
