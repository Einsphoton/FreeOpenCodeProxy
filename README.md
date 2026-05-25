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
