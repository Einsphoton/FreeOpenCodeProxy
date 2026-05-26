# FreeOpenCodeProxy

一个可 Docker 部署的 OpenAI-compatible 反向代理应用，带本地 Dashboard 和 Settings 页面。你可以把自己有权使用的 opencode / OpenAI-compatible 上游服务配置为上游，然后在其他应用里使用本项目暴露的 `/v1` API。

> 注意：本项目只做协议兼容代理，不绕过任何服务的鉴权、额度或使用条款。请只接入你有权使用的上游服务。

## 功能

- OpenAI 格式 API：`/v1/*` 会代理到配置的上游服务
- 支持流式响应：`stream: true` / `text/event-stream`
- Dashboard：请求量、成功/失败、延迟、最近请求
- Settings：配置上游 Base URL、上游 Key、本地代理 Key；可读取、搜索并选择默认模型

- Docker 一键部署
- Windows / macOS 一键本地运行脚本

## Docker 一键部署

本地构建运行：

```bash
docker compose up -d --build
```

从 GitHub Container Registry 拉取运行：

```bash
docker pull ghcr.io/einsphoton/freeopencodeproxy:latest
docker run -d \
  --name free-open-code-proxy \
  -p 3000:3000 \
  -v free-open-code-proxy-data:/app/data \
  ghcr.io/einsphoton/freeopencodeproxy:latest
```

打开：<http://localhost:3000>

如需通过环境变量锁定配置：

```bash
docker run -d \
  --name free-open-code-proxy \
  -p 3000:3000 \
  -e UPSTREAM_BASE_URL="https://your-upstream.example/v1" \
  -e UPSTREAM_API_KEY="your-upstream-key" \
  -e PROXY_API_KEY="your-local-proxy-key" \
  -v free-open-code-proxy-data:/app/data \
  ghcr.io/einsphoton/freeopencodeproxy:latest
```

镜像会由 GitHub Actions 自动构建并推送到：

```text
ghcr.io/einsphoton/freeopencodeproxy:latest
```


## Windows 一键本地运行

双击：

```text
scripts\run-windows.bat
```

脚本会自动：

1. 检查 Node.js；如果缺失，尝试通过 `winget` 安装 Node.js LTS
2. 执行 `npm install`
3. 启动服务并打开 <http://localhost:3000>

## macOS 一键本地运行

终端运行一次授权后双击，或直接运行：

```bash
chmod +x scripts/run-macos.command
./scripts/run-macos.command
```

脚本会自动：

1. 检查 Node.js；如果缺失，尝试通过 Homebrew 安装 Node.js
2. 如果项目位于 `/Volumes/*` 挂载盘，先同步到 `~/FreeOpenCodeProxy`，避免挂载盘不支持 npm 软链接
3. 执行 `npm install --no-bin-links`
4. 启动服务并打开 <http://localhost:3000>


## 在其他应用中使用

Base URL：

```text
http://localhost:3000/v1
```

Chat Completions 示例：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -d '{
    "model": "your-model",
    "messages": [{"role":"user","content":"Hello"}],
    "stream": false
  }'
```

如果没有设置 `PROXY_API_KEY` / 客户端访问 Key，可以省略 `Authorization`。

## 配置说明

| 配置 | 说明 |
| --- | --- |
| `UPSTREAM_BASE_URL` | 上游 OpenAI-compatible Base URL，可包含或不包含 `/v1` |
| `UPSTREAM_API_KEY` | 上游服务 Key；为空时不会主动添加上游鉴权头 |
| `PROXY_API_KEY` | 本代理的客户端访问 Key；设置后调用 `/v1/*` 需要 `Bearer` |
| `PORT` | 服务端口，默认 `3000` |
| `DATA_DIR` | 设置与统计数据目录，默认 `./data` |

运行时页面配置会保存到 `data/settings.json`，请求统计会保存到 `data/stats.json`。

## 稳定性 / 防代理对策

部分上游（包括 opencode 类免费算力服务）会针对"明显是反向代理"的请求进行限流或拒绝（典型表现：偶发 `502 Proxy upstream error: fetch failed`、模型列表读不出来等）。本项目内置了多项稳定性增强，**默认即生效**：

- 浏览器化请求头：注入随机 `User-Agent`、`Accept-Language`、`Origin`、`Referer`，并剔除 `Via` / `Forwarded` / `X-Forwarded-*` / `cf-connecting-ip` 等会暴露代理身份的头。
- 自动重试：网络错误（`fetch failed`、`ECONNRESET`、`ETIMEDOUT`、`UND_ERR_*` 等）和 5xx / 429 响应会自动指数退避重试，非流式最多 3 次、流式最多 2 次（仅在首字节前重试）。`Retry-After` 头会被尊重。
- 模型列表缓存兜底：`/api/models` 成功后缓存 5 分钟；下次失败时回退到缓存返回，避免 Settings 页面"读不出模型"。点击 **读取模型** 按钮会强制刷新缓存。
- 详细错误诊断：上游失败时返回的错误体中包含 `diagnostics.target / attempts / timeoutMs / errorCode / errorName`，Dashboard "最近请求"也会显示重试次数。

如果仍然不稳定，可逐项尝试：

1. 在 Settings 页面把请求超时调大（默认 120000ms ≈ 2 分钟），上游冷启动较慢的模型可设到 300000。
2. 不要给本地代理设置 `PROXY_API_KEY`，让上游 `Authorization` 直接从 Workbuddy / Agent 端透传也能工作。
3. 如果上游对来源 IP 严格，建议把本服务部署到与你"正常使用上游"时相同的网络环境（家里 / 同一台机器），不要放在云服务器上跑。
4. 通过环境变量自定义 UA 透传（高级用法）：客户端发送 `User-Agent` 不会被透传，本代理一定会改写为浏览器 UA；如需固定 UA，可以临时在 `server.js` 的 `USER_AGENTS` 里只保留一个值。

> 本项目仅提供协议兼容代理与稳定性增强，不绕过任何上游服务的鉴权、配额或使用条款。请只接入你有权使用的上游服务，并自行遵守相应条款。

## 通过 NAS / 反向代理网关访问（绿联 UGREENlink、Cloudflare、nginx、Traefik 等）

如果你把本服务部署在 NAS 或服务器上，并通过下面这类外网网关访问：

- 绿联 UGREENlink（`*.ugdocker.link`）
- Cloudflare Tunnel / Workers
- nginx / Caddy / Traefik 反向代理
- Synology QuickConnect 等

**症状：Web UI 能打开、`/v1/models` 也能返回，但 AI 调用「立刻完成，但内容为空」或「转一下就结束没有任何输出」。**

原因：这些网关默认会对响应做 **缓冲（buffering）** 和 **gzip 压缩**，会把 OpenAI 兼容接口的 `text/event-stream` 流式响应整段吃掉，等上游写完才一次性吐给客户端，导致 SSE 解析失败 → 客户端看到「空内容、正常结束」。

本项目从 v0.2 起在服务端已自动注入下面这些响应头来让网关放弃缓冲：

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`（nginx 系网关的标准关闭缓冲信号，绿联 UGREENlink 同样识别）
- `Connection: keep-alive`
- 同时立即 `flushHeaders` + 关闭 Nagle、逐 chunk 写出

绝大多数网关识别这些头后会自动切到流式模式，不需要你做任何事。如果仍然不工作，请按以下顺序排查：

1. **优先在网关层直接关闭对此服务的缓冲与压缩**（最稳）：
   - nginx：`proxy_buffering off; proxy_cache off; gzip off; proxy_http_version 1.1; proxy_set_header Connection ""; chunked_transfer_encoding on;`
   - Caddy：`flush_interval -1` 或 `reverse_proxy { flush_interval -1 }`
   - Traefik：`buffering` 中间件不要开启
   - Cloudflare：把该域名的 **Auto Minify / Brotli / Polish** 全关；如果用 Tunnel，确保是 HTTP/1.1 模式
2. **不要再叠加 CDN 压缩**：响应头里我们已经声明了 `no-transform`，符合标准的中间层会遵守；不符合的（少数自建网关）需要在网关上手动关 gzip。
3. **直接走局域网 IP**：调用方和 NAS 在同一网络时，把 base URL 改成 `http://<NAS局域网IP>:3000/v1` 即可绕过所有外网网关，性能最好。
4. **临时排查**：在调用方关闭流式（`stream: false`）。如果非流式可用、流式不可用，那基本就是网关缓冲问题，按 1 解决；如果非流式也空，则是上游/鉴权问题，看 Dashboard 的「最近请求」诊断字段。

