# 🎬 CoupleWatch

异地恋两人专用的「一起看视频」自托管工具。

- **URL 同步播放**：粘贴视频链接，双方同步看（YouTube / 推特 / 各种盗版小站等 yt-dlp 支持的源）
- **双向投屏**：任意一方共享屏幕，对方实时看到（用于 B 站 / 爱奇艺 / 网盘 / 任何不能解析的内容）
- **油猴脚本一键推送**：在任意视频站抓取 m3u8 / mp4，一键推到房间播放
- **文字聊天**：边看边聊
- **跨境友好**：Cloudflare Tunnel 暴露公网，Cloudflare Realtime TURN 兜底跨境 WebRTC

## 快速开始

### 1. 装依赖（macOS）

```bash
brew install node cloudflared ffmpeg
```

> **B 站等需要 yt-dlp nightly 版**（stable 版有 KeyError('bvid') bug）。下载到项目内：
>
> ```bash
> mkdir -p bin
> curl -fsSL https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos -o ./bin/yt-dlp
> chmod +x ./bin/yt-dlp
> ```
>
> 后端会自动优先使用 `./bin/yt-dlp`，找不到就 fallback 到系统 `yt-dlp`。Linux 用户把 URL 里的 `yt-dlp_macos` 换成 `yt-dlp_linux`。

### 2. 装 Node 依赖

```bash
npm install
```

### 3. 配置

```bash
cp .env.example .env
```

编辑 `.env`：

| 字段 | 说明 |
|---|---|
| `ROOM_PIN` | 4 位数字房间 PIN。留空则启动时随机生成（控制台打印）|
| `PORT` | 后端监听端口，默认 8787 |
| `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` | **强烈建议**，跨境投屏 P2P 打洞失败时走 TURN 中继；申请见下文 |
| `TUNNEL_NAME` | 留空 = quick tunnel（每次重启换 URL）；填名字 = named tunnel（需提前 cloudflared login + create + route dns）|
| `YTDLP_PROXY` | yt-dlp 走代理（如 `http://127.0.0.1:7890`），用于解析对当前服务器 IP 反爬的网站 |
| `YTDLP_COOKIES` | yt-dlp cookies 文件路径，绕登录墙 |

### 4. 配 Cloudflare TURN（强烈建议跨境用户配）

跨境 WebRTC P2P 打洞成功率不到一半，必须有 TURN 中继才稳定。

1. 注册 [Cloudflare](https://dash.cloudflare.com) 账号（免费）
2. 进入 **Realtime** → **TURN**，点 **Create TURN App**
3. 拿到 `Key ID` 和 `API Token`，写入 `.env`
4. 免费额度 **1TB/月**，超出 $0.05/GB（按用量自动扣，无最低消费）

### 5. 启动

最简单两步（前后台两个终端）：

```bash
# 终端 1：起后端
node server/index.js

# 终端 2：暴露公网
cloudflared tunnel --url http://localhost:8787
```

输出里会有：
- 公网 URL（`https://random-words.trycloudflare.com`）
- 房间 PIN

把链接 + PIN 发给对方，对方浏览器打开即可。

> **想要永久 URL** 而不是每次重启换：用 named tunnel——`cloudflared tunnel login` 选自己域名 → `cloudflared tunnel create couplewatch` → `cloudflared tunnel route dns couplewatch your.domain.com` → 启动改成 `cloudflared tunnel run --url http://localhost:8787 couplewatch`，然后在 `.env` 设 `TUNNEL_NAME=couplewatch`。

## 怎么用

### URL 同步模式

1. 控制方（默认进房第一人）粘贴视频链接，点「加载」
2. 双方播放器同步加载，控制方按播放/暂停/拖进度，对方自动跟进
3. 想换控制方？另一方点「取得控制权」

**适用片源**：
- ✅ YouTube、Twitter、Vimeo 等海外站
- ✅ 大部分盗版聚合站（zoechip 等，yt-dlp 覆盖的）
- ❌ B 站、爱奇艺、优酷、腾讯视频（跨境反爬，建议用投屏模式 / 油猴脚本）

### 投屏模式

1. 切到「🖥 投屏」标签
2. 点「开始投屏」，浏览器弹窗选窗口/标签页/整个屏幕
3. **想要带声音**：勾选「分享标签页音频」（macOS 只能拿到标签页音频，拿不到系统音频）
4. 对方自动看到画面

**典型用法**：
- B 站 / 爱奇艺 → 国内一方在自己电脑播 → 投屏给海外一方 ✅
- Netflix / HBO → 海外一方播 → 投屏给国内一方 ✅
- 本地下载的电影 → 谁有片谁投屏 ✅

### 油猴脚本（一键推送任意视频站）⭐

`extras/couplewatch-sender.user.js` 是个 Userscript，装到任意浏览器的油猴扩展（Tampermonkey / Userscripts / Violentmonkey）后，**任何视频网站**右下角都会出现一个 📺 按钮：

1. 在视频站播放视频，按钮上 badge 数字 +1（抓到了 m3u8/mp4）
2. 点按钮 → 选一条 → **自动推送到 CoupleWatch 房间**，对方瞬间收到加载
3. 首次使用点「配置」填你的 server URL 和 PIN

原理：脚本注入页面 hook XHR/fetch，抓所有 `.m3u8` `.mp4` 等流地址。详细见脚本头部注释。

## 架构

```
本机 (Node 后端) ←→ Cloudflare Tunnel ←→ 双方浏览器
                                          ↓
                                      WebSocket（信令）
                                          ↓
                                 ┌────────┴────────┐
                                 │                 │
                        URL 同步 (HTTP 视频流)   投屏 (WebRTC P2P / TURN)
                                 │                 │
                          后端 yt-dlp 解析    Cloudflare Realtime TURN
                          + 反盗链代理        （跨境中继）
```

## 安全说明

- 房间 PIN 是唯一鉴权机制，仅 4 位数字。**别公开发布链接**，1/10000 概率被随机猜中
- 视频流通过你本机代理（`/api/proxy`），所以源站看到的请求 IP 是你的服务器
- WebRTC 投屏是端到端的（即使走 TURN 中继，CF 也只看加密包，看不到内容）
- `.env` 已加入 `.gitignore`，凭证不会被提交

## 文件结构

```
CoupleWatch/
├── server/
│   ├── index.js      # HTTP + WebSocket 主入口 + CORS
│   ├── room.js       # 房间逻辑 + host 模型 + ts 同步协议
│   ├── resolve.js    # /api/resolve  (yt-dlp 包装)
│   ├── proxy.js      # /api/proxy    (反盗链 Referer 伪造 + m3u8 子分片重写)
│   └── turn.js       # /api/turn     (CF TURN 凭证签发)
├── public/
│   ├── index.html    # 单页前端
│   ├── app.css
│   ├── app.js        # 同步播放器 + WebRTC 投屏 + 聊天
│   └── vendor/hls.min.js
├── extras/
│   └── couplewatch-sender.user.js  # 油猴脚本
├── .env.example
└── package.json
```

## 排错

**「PIN 错误」反复出现**
→ 检查后端控制台打印的 PIN，或在 `.env` 里固定 `ROOM_PIN=1234`。

**视频解析超时 / 报 -352 错误**
→ 站点对你的服务器 IP 反爬（B 站对海外 IP 必现）。配置 `YTDLP_PROXY` 走国内代理，或用油猴脚本 / 投屏。

**投屏画面卡 / 黑屏 / 几秒后断开**
→ 大概率是没配 Cloudflare TURN。浏览器 console 的 `[CW] ICE servers` 输出 `source` 应该是 `cloudflare`，是 `fallback` 表示没配上。

**macOS 投屏没声音**
→ macOS 限制：`getDisplayMedia` 只能拿「标签页音频」。workaround 是把视频在 Chrome 标签页里播再共享。

**视频转圈一直加载不出来**
→ 看浏览器 console 的 hls.js 错误。常见原因：m3u8 token 过期（重新抓一次）、CDN 防盗链未通过（检查后端 `[proxy]` 日志）。

## License

[MIT](LICENSE)
