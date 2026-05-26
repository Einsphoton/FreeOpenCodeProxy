import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// 流式（SSE）响应不需要 ETag，关闭后 Express 不会尝试缓冲响应体来算 hash
app.disable("etag");
// 反代场景下需要信任 X-Forwarded-* 才能拿到正确的客户端协议/IP
app.set("trust proxy", true);

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const settingsPath = path.join(dataDir, "settings.json");
const statsPath = path.join(dataDir, "stats.json");

const envLocks = {
  upstreamBaseUrl: Boolean(process.env.UPSTREAM_BASE_URL),
  upstreamApiKey: Boolean(process.env.UPSTREAM_API_KEY),
  clientApiKey: Boolean(process.env.PROXY_API_KEY)
};

const defaultSettings = {
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || "",
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  clientApiKey: process.env.PROXY_API_KEY || "",
  defaultModel: "",
  requestTimeoutMs: 120000
};

// 多个常见浏览器/客户端 UA，随机使用，降低被简单防代理拦截的概率
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "curl/8.5.0",
  "node-fetch/1.0 (+https://github.com/) Node.js/20"
];
function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const RETRYABLE_NET_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
  "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"
]);

function isRetryableError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  const code = error.code || error.cause?.code || "";
  if (RETRYABLE_NET_CODES.has(code)) return true;
  const msg = String(error.message || "").toLowerCase();
  return msg.includes("fetch failed") || msg.includes("socket hang up") || msg.includes("network");
}

function diagnoseError(error) {
  const code = error?.code || error?.cause?.code || "";
  const name = error?.name || "Error";
  const msg = error?.message || String(error);
  return { name, code, message: msg };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 简单内存缓存：模型列表
let modelsCache = { at: 0, key: "", models: [] };
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

const defaultStats = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  streamedRequests: 0,
  totalLatencyMs: 0,
  lastRequests: []
};

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return { ...fallback };
  }
}

async function writeJson(filePath, value) {
  await ensureDataDir();
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function applyEnvOverrides(settings) {
  return {
    ...settings,
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || settings.upstreamBaseUrl || "",
    upstreamApiKey: process.env.UPSTREAM_API_KEY || settings.upstreamApiKey || "",
    clientApiKey: process.env.PROXY_API_KEY || settings.clientApiKey || ""
  };
}

async function loadSettings() {
  const settings = await readJson(settingsPath, defaultSettings);
  return applyEnvOverrides(settings);
}

async function saveSettings(input) {
  const current = await readJson(settingsPath, defaultSettings);
  const next = {
    ...current,
    upstreamBaseUrl: envLocks.upstreamBaseUrl ? current.upstreamBaseUrl : input.upstreamBaseUrl,
    upstreamApiKey: envLocks.upstreamApiKey ? current.upstreamApiKey : input.upstreamApiKey,
    clientApiKey: envLocks.clientApiKey ? current.clientApiKey : input.clientApiKey,
    defaultModel: input.defaultModel,
    requestTimeoutMs: input.requestTimeoutMs
  };
  await writeJson(settingsPath, next);
  // 上游变更时清模型缓存
  modelsCache = { at: 0, key: "", models: [] };
  return applyEnvOverrides(next);
}

async function loadStats() {
  return readJson(statsPath, defaultStats);
}

async function recordRequest(entry) {
  const stats = await loadStats();
  stats.totalRequests += 1;
  stats.totalLatencyMs += entry.latencyMs;
  if (entry.ok) stats.successRequests += 1;
  else stats.failedRequests += 1;
  if (entry.streamed) stats.streamedRequests += 1;
  stats.lastRequests = [entry, ...(stats.lastRequests || [])].slice(0, 30);
  await writeJson(statsPath, stats);
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

function publicSettings(settings) {
  return {
    upstreamBaseUrl: settings.upstreamBaseUrl,
    upstreamApiKeyMasked: maskSecret(settings.upstreamApiKey),
    hasUpstreamApiKey: Boolean(settings.upstreamApiKey),
    clientApiKeyMasked: maskSecret(settings.clientApiKey),
    hasClientApiKey: Boolean(settings.clientApiKey),
    defaultModel: settings.defaultModel,
    requestTimeoutMs: settings.requestTimeoutMs,
    envLocks
  };
}

function validateSettings(input) {
  const next = {
    upstreamBaseUrl: String(input.upstreamBaseUrl || "").trim().replace(/\/+$/, ""),
    upstreamApiKey: input.upstreamApiKey === "********" ? undefined : String(input.upstreamApiKey || "").trim(),
    clientApiKey: input.clientApiKey === "********" ? undefined : String(input.clientApiKey || "").trim(),
    defaultModel: String(input.defaultModel || "").trim(),
    requestTimeoutMs: Number(input.requestTimeoutMs || defaultSettings.requestTimeoutMs)
  };

  if (next.upstreamBaseUrl) {
    try {
      const parsed = new URL(next.upstreamBaseUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      const error = new Error("上游 Base URL 必须是合法的 http(s) 地址");
      error.status = 400;
      throw error;
    }
  }

  if (!Number.isFinite(next.requestTimeoutMs) || next.requestTimeoutMs < 1000) {
    next.requestTimeoutMs = defaultSettings.requestTimeoutMs;
  }

  return next;
}

function openAIError(res, status, message, type = "proxy_error", extra = {}) {
  return res.status(status).json({
    error: {
      message,
      type,
      param: null,
      code: null,
      ...extra
    }
  });
}

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : "";
}

async function requireClientAuth(req, res, next) {
  const settings = await loadSettings();
  req.proxySettings = settings;
  if (!settings.clientApiKey) return next();
  if (getBearerToken(req) === settings.clientApiKey) return next();
  return openAIError(res, 401, "Invalid proxy API key", "authentication_error");
}

function buildTargetUrl(baseUrl, originalUrl) {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const baseAlreadyIncludesV1 = /\/v1$/i.test(cleanBase);
  const suffix = baseAlreadyIncludesV1 ? originalUrl.replace(/^\/v1(?=\/|\?|$)/, "") || "/" : originalUrl;
  return `${cleanBase}${suffix}`;
}

// 浏览器/真实客户端风格的请求头，用于降低被简单防代理识别的概率
function browserLikeHeaders(targetUrl) {
  let origin = "";
  try {
    const u = new URL(targetUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    /* ignore */
  }
  const headers = {
    "user-agent": pickUserAgent(),
    "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "accept-encoding": "identity",
    "cache-control": "no-cache",
    "pragma": "no-cache"
  };
  if (origin) {
    headers["origin"] = origin;
    headers["referer"] = `${origin}/`;
  }
  return headers;
}

function forwardHeaders(req, settings, targetUrl) {
  // 跳过会破坏 fetch 行为或暴露本地代理身份的头
  const skip = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "user-agent",
    "origin",
    "referer",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "via",
    "forwarded",
    "cf-connecting-ip",
    "cdn-loop"
  ]);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skip.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) headers[key] = value.join(",");
    else if (value !== undefined) headers[key] = value;
  }

  // 用上游 Key 覆盖客户端 Authorization；若没有上游 Key 但本地有客户端 Key，删除以免泄漏
  if (settings.upstreamApiKey) headers.authorization = `Bearer ${settings.upstreamApiKey}`;
  else if (settings.clientApiKey) delete headers.authorization;

  // 注入浏览器化头
  const fake = browserLikeHeaders(targetUrl);
  for (const [k, v] of Object.entries(fake)) {
    if (!headers[k]) headers[k] = v;
  }
  return headers;
}

function copyResponseHeaders(upstream, res) {
  // 这些头由 Node/Express 自行管理，原样透传会出问题
  const skip = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);
  upstream.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
  });
}

// 让 SSE / 流式响应能穿透 nginx / 绿联 UGREENlink / Cloudflare 之类的反代网关
// 不被缓冲、压缩或合并 chunk，导致客户端「秒结束 + 空内容」
function applyStreamingHeaders(res) {
  // 强制 SSE Content-Type（即使上游写的是别的，比如 application/octet-stream）
  if (!String(res.getHeader("content-type") || "").includes("text/event-stream")) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  }
  // 关键：让上游网关关闭 buffering / 压缩 / 转码
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");          // nginx 系（含 UGREENlink）
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Pragma", "no-cache");
  // 让浏览器/中间层不要去猜内容类型
  res.setHeader("X-Content-Type-Options", "nosniff");
  // 显式去除可能被上游带过来的压缩头（fetch 已自动解压，再标 encoding 会让下游二次解压失败）
  res.removeHeader("Content-Encoding");
  res.removeHeader("Content-Length");
}

function requestBodyForProxy(req) {
  if (["GET", "HEAD"].includes(req.method.toUpperCase())) return undefined;
  if (req.rawBody?.length) return req.rawBody;
  if (req.body && Object.keys(req.body).length) return Buffer.from(JSON.stringify(req.body));
  return undefined;
}

function upstreamHeaders(settings, targetUrl) {
  const headers = {
    accept: "application/json, text/event-stream;q=0.9, */*;q=0.5",
    ...browserLikeHeaders(targetUrl)
  };
  if (settings.upstreamApiKey) headers.authorization = `Bearer ${settings.upstreamApiKey}`;
  return headers;
}

// 带重试 + 超时 + 跟随重定向 的 fetch 封装
// 关键：手动处理 3xx，保留 POST + body + headers（上游 CDN/WAF 经常用 302 做流量调度，
// OpenAI 类客户端 SDK 默认不跟随 POST 重定向，会导致 chat/completions 直接挂掉）
async function fetchWithRetry(url, init, { timeoutMs, maxRetries = 3, onAttempt, maxRedirects = 5 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      if (typeof onAttempt === "function") onAttempt(attempt);

      let currentUrl = url;
      let currentInit = init;
      let redirectChain = [];
      let response;

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        // 每跳随机化 UA
        const headers = { ...(currentInit.headers || {}), "user-agent": pickUserAgent() };
        response = await fetch(currentUrl, {
          ...currentInit,
          headers,
          signal: controller.signal,
          redirect: "manual" // 我们自己处理 3xx
        });

        const status = response.status;
        const location = response.headers.get("location");

        // 不是重定向，或没 location，跳出
        if (status < 300 || status >= 400 || !location) break;
        // 301/302/303/307/308 都尝试跟随
        if (hop >= maxRedirects) {
          // 重定向次数超限，把当前响应当作结果返回，上层会按 3xx 处理
          break;
        }

        // 解析新 URL（支持相对路径）
        let nextUrl;
        try { nextUrl = new URL(location, currentUrl).toString(); } catch { break; }
        redirectChain.push({ from: currentUrl, to: nextUrl, status });

        // 释放当前响应体
        try { await response.arrayBuffer(); } catch { /* noop */ }

        // 303 永远变 GET 且丢 body；301/302 老规范说应保留方法但很多浏览器变 GET；
        // 这里对 POST + 301/302 也强制保留 method/body（OpenAI 风控类 302 是要求原样重发）
        let nextInit = { ...currentInit };
        if (status === 303) {
          nextInit.method = "GET";
          delete nextInit.body;
        }

        // 如果跨主机，剔除 cookie/authorization 之外的"可能带敏感信息"的头，
        // 但保留 authorization（上游同一服务商不同节点跳转时一般需要）
        try {
          const fromHost = new URL(currentUrl).host;
          const toHost = new URL(nextUrl).host;
          if (fromHost !== toHost) {
            const h = { ...(nextInit.headers || {}) };
            // 跨主机时 origin/referer 需要更新
            delete h.origin;
            delete h.referer;
            nextInit.headers = h;
          }
        } catch { /* noop */ }

        currentUrl = nextUrl;
        currentInit = nextInit;
      }

      // 记录重定向链方便诊断
      if (redirectChain.length) {
        response._redirectChain = redirectChain;
        response._finalUrl = currentUrl;
      }

      // 5xx 或 429 视为可重试
      if (attempt < maxRetries && (response.status === 429 || (response.status >= 500 && response.status <= 599))) {
        const retryAfter = Number(response.headers.get("retry-after")) || 0;
        try { await response.arrayBuffer(); } catch { /* noop */ }
        const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * attempt, 6000) + Math.floor(Math.random() * 400);
        await sleep(backoff);
        lastError = new Error(`upstream HTTP ${response.status}`);
        lastError.status = response.status;
        continue;
      }
      return { response, attempts: attempt, redirectChain };
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw Object.assign(error, { attempts: attempt });
      }
      const backoff = Math.min(1000 * attempt, 4000) + Math.floor(Math.random() * 400);
      await sleep(backoff);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw Object.assign(lastError || new Error("upstream failed"), { attempts: maxRetries });
}

function normalizeModels(payload) {
  const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return source
    .map((item) => {
      if (typeof item === "string") return { id: item };
      if (!item || typeof item !== "object") return null;
      const id = String(item.id || item.name || item.model || "").trim();
      if (!id) return null;
      return {
        id,
        ownedBy: item.owned_by || item.ownedBy || item.owner || "",
        created: item.created || null
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchAvailableModels(settings, { useCache = true } = {}) {
  if (!settings.upstreamBaseUrl) {
    const error = new Error("请先在 Settings 页面配置并保存上游 Base URL");
    error.status = 400;
    throw error;
  }

  const cacheKey = `${settings.upstreamBaseUrl}|${settings.upstreamApiKey ? "with-key" : "no-key"}`;
  const now = Date.now();
  if (useCache && modelsCache.key === cacheKey && now - modelsCache.at < MODELS_CACHE_TTL_MS && modelsCache.models.length) {
    return { models: modelsCache.models, fromCache: true };
  }

  const target = buildTargetUrl(settings.upstreamBaseUrl, "/v1/models");
  const timeoutMs = Math.min(settings.requestTimeoutMs || defaultSettings.requestTimeoutMs, 60000);
  try {
    const { response } = await fetchWithRetry(target, {
      method: "GET",
      headers: upstreamHeaders(settings, target)
    }, { timeoutMs, maxRetries: 3 });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const message = payload?.error?.message || text || `上游返回 HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const models = normalizeModels(payload);
    modelsCache = { at: Date.now(), key: cacheKey, models };
    return { models, fromCache: false };
  } catch (error) {
    // 失败时回退缓存
    if (modelsCache.key === cacheKey && modelsCache.models.length) {
      return { models: modelsCache.models, fromCache: true, staleError: diagnoseError(error) };
    }
    if (error.name === "AbortError") {
      const timeoutError = new Error("读取上游模型列表超时");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  }
}

async function proxyToUpstream(req, res) {

  const settings = req.proxySettings || (await loadSettings());
  const startedAt = Date.now();
  const model = req.body?.model || settings.defaultModel || "";
  const requestedStream = Boolean(req.body?.stream);

  if (!settings.upstreamBaseUrl) {
    return openAIError(res, 400, "请先在 Settings 页面配置合法的上游 OpenAI-compatible Base URL");
  }

  const targetUrl = buildTargetUrl(settings.upstreamBaseUrl, req.originalUrl);
  const timeoutMs = settings.requestTimeoutMs || defaultSettings.requestTimeoutMs;
  // 流式只允许小幅重试（首字节前），非流式可以重试更多次
  const maxRetries = requestedStream ? 2 : 3;
  let attemptsTaken = 0;

  try {
    const { response: upstream, attempts, redirectChain } = await fetchWithRetry(targetUrl, {
      method: req.method,
      headers: forwardHeaders(req, settings, targetUrl),
      body: requestBodyForProxy(req)
    }, {
      timeoutMs,
      maxRetries,
      onAttempt: (n) => { attemptsTaken = n; }
    });
    attemptsTaken = attempts;
    if (redirectChain?.length) {
      // eslint-disable-next-line no-console
      console.log(`[proxy] followed ${redirectChain.length} redirect(s):`,
        redirectChain.map((r) => `${r.status} -> ${r.to}`).join(" | "));
      res.setHeader("X-Proxy-Redirects", String(redirectChain.length));
    }

    const contentType = upstream.headers.get("content-type") || "";
    const streamed = requestedStream || contentType.includes("text/event-stream");
    copyResponseHeaders(upstream, res);
    res.status(upstream.status);

    if (streamed && upstream.body) {
      // 关键：注入抗缓冲响应头 + 立刻把 headers flush 给下游网关，
      // 让 UGREENlink / nginx 之类的反代立即进入流式转发模式，
      // 否则它们会缓冲整段响应，客户端表现为「立刻完成、内容为空」
      applyStreamingHeaders(res);
      try { res.flushHeaders?.(); } catch { /* noop */ }
      // 关闭 Nagle，避免小 chunk 被合并造成延迟
      try { req.socket?.setNoDelay?.(true); } catch { /* noop */ }
      try { req.socket?.setKeepAlive?.(true); } catch { /* noop */ }

      await recordRequest({
        at: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        model,
        status: upstream.status,
        ok: upstream.ok,
        streamed: true,
        attempts: attemptsTaken,
        latencyMs: Date.now() - startedAt
      });

      // 手动逐 chunk 写出 + flush，确保不被中间层合并
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("data", (chunk) => {
        const ok = res.write(chunk);
        // 写完立刻尝试 flush（Node 自带 http 没有 flush，但部分中间件/兼容层有）
        if (typeof res.flush === "function") {
          try { res.flush(); } catch { /* noop */ }
        }
        if (!ok) nodeStream.pause();
      });
      res.on("drain", () => nodeStream.resume());
      nodeStream.on("end", () => res.end());
      nodeStream.on("error", (err) => {
        try { res.end(); } catch { /* noop */ }
        // eslint-disable-next-line no-console
        console.error("[stream] upstream error:", err?.message || err);
      });
      // 客户端断开时立刻释放上游
      req.on("close", () => {
        try { nodeStream.destroy(); } catch { /* noop */ }
      });
      return;
    }

    const text = await upstream.text();
    let usage = null;
    if (contentType.includes("application/json")) {
      try { usage = JSON.parse(text).usage || null; } catch { usage = null; }
    }

    await recordRequest({
      at: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      model,
      status: upstream.status,
      ok: upstream.ok,
      streamed: false,
      attempts: attemptsTaken,
      latencyMs: Date.now() - startedAt,
      usage
    });
    return res.send(text);
  } catch (error) {
    const diag = diagnoseError(error);
    const isTimeout = error.name === "AbortError";
    const message = isTimeout
      ? `上游请求超时 (${timeoutMs}ms, 已重试 ${attemptsTaken || maxRetries} 次)`
      : `${diag.message}${diag.code ? ` [${diag.code}]` : ""} (已重试 ${attemptsTaken || maxRetries} 次)`;
    await recordRequest({
      at: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      model,
      status: 502,
      ok: false,
      streamed: requestedStream,
      attempts: attemptsTaken || maxRetries,
      latencyMs: Date.now() - startedAt,
      error: message
    });
    return openAIError(res, 502, `Proxy upstream error: ${message}`, "proxy_error", {
      diagnostics: {
        target: targetUrl,
        attempts: attemptsTaken || maxRetries,
        timeoutMs,
        errorCode: diag.code || null,
        errorName: diag.name
      }
    });
  }
}

app.use(cors());
app.use(express.json({
  limit: "25mb",
  verify: (req, _res, buffer) => {
    req.rawBody = buffer;
  }
}));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", async (_req, res) => {
  const settings = await loadSettings();
  res.json({ ok: true, upstreamConfigured: Boolean(settings.upstreamBaseUrl) });
});

app.get("/api/dashboard", async (_req, res) => {
  const [settings, stats] = await Promise.all([loadSettings(), loadStats()]);
  const averageLatencyMs = stats.totalRequests ? Math.round(stats.totalLatencyMs / stats.totalRequests) : 0;
  res.json({
    endpoint: `http://localhost:${port}/v1`,
    upstreamConfigured: Boolean(settings.upstreamBaseUrl),
    defaultModel: settings.defaultModel,
    stats: { ...stats, averageLatencyMs }
  });
});

app.get("/api/settings", async (_req, res) => {
  const settings = await loadSettings();
  res.json(publicSettings(settings));
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const current = await loadSettings();
    const input = validateSettings(req.body || {});
    if (input.upstreamApiKey === undefined) input.upstreamApiKey = current.upstreamApiKey;
    if (input.clientApiKey === undefined) input.clientApiKey = current.clientApiKey;
    const saved = await saveSettings(input);
    res.json(publicSettings(saved));
  } catch (error) {
    next(error);
  }
});

app.get("/api/models", async (req, res, next) => {
  try {
    const settings = await loadSettings();
    const refresh = String(req.query.refresh || "") === "1";
    const result = await fetchAvailableModels(settings, { useCache: !refresh });
    res.json({
      models: result.models,
      count: result.models.length,
      fromCache: Boolean(result.fromCache),
      staleError: result.staleError || null
    });
  } catch (error) {
    next(error);
  }
});

app.use("/v1", requireClientAuth, proxyToUpstream);


app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({ error: { message: error.message || "Internal Server Error", type: "server_error", param: null, code: null } });
});

await ensureDataDir();
app.listen(port, () => {
  console.log(`FreeOpenCodeProxy listening on http://localhost:${port}`);
});
