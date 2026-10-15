# CodexWatch 产品设计与技术方案

> 用手机(微信式 App)随时查看与操控 PC 上的 Codex 任务,任务结束手机通知,支持多人共用。

## 1. 需求

| 需求 | 方案 |
|---|---|
| 随时查看 PC 上各 Codex 任务状态 | PC 常驻守护进程解析 `~/.codex/sessions/**.jsonl`,经云端中继实时推送到手机 |
| 任务结束手机通知 | 前台服务持有 WebSocket 长连接,本地系统通知(国内无 FCM,微信同款保活思路) |
| 操控:发起新任务/追加指令/停止 | 守护进程调用 `codex exec` / `codex exec resume` / `codex queue` / 结束进程树 |
| UI/交互完全仿微信 | 会话列表=任务列表,聊天窗口=任务详情流,底部 4 Tab,微信配色与气泡 |
| 外网访问 | PC 主动外连云服务器(al),手机连云服务器,无需 PC 公网/端口映射;下载依赖走本地代理 10808 |
| 多人使用 | 云端账号体系:邀请码注册、设备配对码绑定,管理员/成员两级角色 |

## 2. 总体架构

```
┌──────────────安卓 App(微信式 UI)──────────────┐
│ WebView(本地 Web UI) ⇄ JS桥 ⇄ 前台服务(WS长连接+通知) │
└───────────────────┬───────────────────────────┘
                    │ wss://pcphone.jingxixi.top/ws (443, 有效证书)
┌───────────────────▼───────────┐
│ 云中继 Relay(阿里云 al, 127.0.0.1:35500, nginx 反代)│
│  账号/邀请码/设备配对/消息路由/离线通知暂存            │
└───────────────────┬───────────┘
                    │ wss 出站连接(PC 在 NAT 内,无需开端口)
┌───────────────────▼───────────────────────────┐
│ PC 守护进程 Bridge(Windows, Node.js)           │
│  · 监听解析 ~/.codex/sessions/**/rollout-*.jsonl │
│  · 会话状态机:running/idle/stopped/error          │
│  · codex exec / exec resume / queue / kill       │
│  · 本机 127.0.0.1:3599 同款 Web UI(浏览器可预览)    │
└────────────────┬──────────────────────────────┘
                 │ 读写
        Codex CLI 0.159.x (~/.codex)
```

**为什么中继而不直连**:PC 在家宽 NAT 后,手机在 4G,只有云服务器双方都能直连;阿里云在国内,手机访问无需代理、延迟低。

## 3. 关键技术决策

| 决策点 | 选择 | 理由(含备选) |
|---|---|---|
| Codex 数据源 | 监听 rollout jsonl 文件 | 唯一覆盖所有来源(TUI/Desktop/exec)的统一事实源;`codex app-server` 协议为实验性、版本敏感,仅作后备增强 |
| 任务完成判定 | `event_msg.task_complete`(含 last_agent_message、duration) | 实测存在且信息完整;`turn_aborted`→已停止,`error`→出错 |
| 会话→"聊天"归组 | 按 `session_meta.payload.session_id`(线程 id)聚合多个 rollout 文件 | resume/fork 会产生新文件但同线程;子代理(guardian 等)按 `source.subagent` 过滤隐藏 |
| 发起新任务 | `codex exec --cd <dir> --skip-git-repo-check --json` | 用户配置 approval=never + full-access,不会卡审批;事件经 watcher 统一管道 |
| 追加指令 | 空闲会话:`codex exec resume <id>`;运行中会话:`codex queue --thread <id> --message` | queue 走共享 daemon,可注入正在跑的交互会话 |
| 停止任务 | 守护进程自建任务:taskkill /T /F 杀进程树;外部会话:只读+提示 | 外部进程无可靠 PID 映射 |
| 推送通道 | 前台服务 + WebSocket 长连接 + 本地通知 | 国内 FCM 不可达;微信/钉钉同思路;离线通知由中继暂存、重连补发 |
| App 形态 | 原生壳(WebView + Service)+ 与 PC 同一套 Web UI | UI 100% 复用、浏览器可测;比纯 PWA 通知可靠,比纯原生快 10 倍交付 |
| APK 构建 | JDK17 + aapt2/d8/apksigner 直构(无 Gradle) | 免 Gradle 海量依赖下载;Java 单 Activity 极简,Java-WebSocket 唯一 jar |
| 中继 TLS | 复用 pcphone.jingxixi.top(Let's Encrypt 重签,自动续期) | 域名+证书现成、DNS 已解析;原 ClipBridge 后端已停用,配置备份保留 |
| 中继/桥 技术栈 | Node.js 20 + ws,数据 JSON 文件(无数据库) | 服务器内存仅 1.6G;单文件 systemd 部署;低流量场景零依赖足够 |

## 4. 通信协议(WS JSON 帧)

- 客户端→中继:`hello{token}` `send{deviceId,frame}` `mark_read{chatId}` `create_pair` 等
- 中继→客户端:`authed` `devices[]` `device_frame{deviceId,frame}` `notify{...}`
- 桥→中继(设备通道):`hello{deviceToken}` + 业务帧透传
- 业务帧(桥⇄UI):`state{chats[]摘要}` `chat_events{chatId,items[],seq}` `chat_tail{chatId,item}` `new_task{cwd,prompt,model}` `send_msg{chatId,text}` `stop{chatId}` `task_result{...}` `notify{title,body,chatId,tick}`

chat 摘要:`{id,title,cwd,project,status,running_turn,lastMsg,lastTs,origin,model,tokens}`(status: running/idle/stopped/error)

## 5. 产品界面(仿微信)

- **微信Tab=任务**:搜索栏、会话列表(项目头像+渐变色、标题=会话名/首条指令、预览=最新输出或"正在执行…"+状态点、时间、未读红点),右上 ⊕→发起任务/扫一扫占位
- **聊天窗口=任务详情**:双方气泡(用户右绿、Codex 左白),工具调用为可折叠卡片,思考灰色小字,系统事件居中胶囊,正在运行时"对方正在输入…"动效;底部输入栏可发追加指令;⊕面板:停止任务/任务信息/复制ID
- **通讯录Tab=设备**:设备卡片(在线状态、版本、任务数)、添加设备(显示6位配对码)
- **发现Tab=动态**:今日任务统计(完成数/Token 消耗/运行时长)时间线
- **我Tab**:账号、邀请用户(管理员生成邀请码)、通知设置、服务器信息、关于
- 登录:邀请码注册 / 账号密码登录,微信绿主按钮

## 6. 安全

- 全链路 wss/https(Let's Encrypt);密码 scrypt 存储;token 随机 256bit
- 设备凭 deviceToken 连接;配对码 10 分钟有效;注册需邀请码;管理员/成员两级
- 中继仅转发业务帧,凭据仅存哈希;数据文件 600 权限

## 7. 交付物

`bridge/`(PC 守护进程)、`relay/`(云中继)、`web/`(微信式 UI)、`app/`(安卓工程+APK)、`docs/`、`README.md`(安装/配对/保活说明)。
