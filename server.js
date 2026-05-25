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
  requestTimeoutMs: 600000
};

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

function openAIError(res, status, message, type = "proxy_error") {
  return res.status(status).json({
    error: {
      message,
      type,
      param: null,
      code: null
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

function forwardHeaders(req, settings) {
  const skip = new Set(["host", "connection", "content-length", "accept-encoding"]);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skip.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) headers[key] = value.join(",");
    else if (value !== undefined) headers[key] = value;
  }

  if (settings.upstreamApiKey) headers.authorization = `Bearer ${settings.upstreamApiKey}`;
  else if (settings.clientApiKey) delete headers.authorization;
  return headers;
}

function copyResponseHeaders(upstream, res) {
  const skip = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);
  upstream.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
  });
}

function requestBodyForProxy(req) {
  if (["GET", "HEAD"].includes(req.method.toUpperCase())) return undefined;
  if (req.rawBody?.length) return req.rawBody;
  if (req.body && Object.keys(req.body).length) return Buffer.from(JSON.stringify(req.body));
  return undefined;
}

function upstreamHeaders(settings) {
  const headers = { accept: "application/json" };
  if (settings.upstreamApiKey) headers.authorization = `Bearer ${settings.upstreamApiKey}`;
  return headers;
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

async function fetchAvailableModels(settings) {
  if (!settings.upstreamBaseUrl) {
    const error = new Error("请先在 Settings 页面配置并保存上游 Base URL");
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs || defaultSettings.requestTimeoutMs);
  try {
    const response = await fetch(buildTargetUrl(settings.upstreamBaseUrl, "/v1/models"), {
      method: "GET",
      headers: upstreamHeaders(settings),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message = payload?.error?.message || text || `上游返回 HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return normalizeModels(payload);
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("读取上游模型列表超时");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs || defaultSettings.requestTimeoutMs);
  const targetUrl = buildTargetUrl(settings.upstreamBaseUrl, req.originalUrl);

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders(req, settings),
      body: requestBodyForProxy(req),
      signal: controller.signal
    });

    const contentType = upstream.headers.get("content-type") || "";
    const streamed = requestedStream || contentType.includes("text/event-stream");
    copyResponseHeaders(upstream, res);
    res.status(upstream.status);

    if (streamed && upstream.body) {
      await recordRequest({
        at: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        model,
        status: upstream.status,
        ok: upstream.ok,
        streamed: true,
        latencyMs: Date.now() - startedAt
      });
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    }

    const text = await upstream.text();
    let usage = null;
    if (contentType.includes("application/json")) {
      try {
        usage = JSON.parse(text).usage || null;
      } catch {
        usage = null;
      }
    }

    await recordRequest({
      at: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      model,
      status: upstream.status,
      ok: upstream.ok,
      streamed: false,
      latencyMs: Date.now() - startedAt,
      usage
    });
    return res.send(text);
  } catch (error) {
    const message = error.name === "AbortError" ? "上游请求超时" : error.message;
    await recordRequest({
      at: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      model,
      status: 502,
      ok: false,
      streamed: requestedStream,
      latencyMs: Date.now() - startedAt,
      error: message
    });
    return openAIError(res, 502, `Proxy upstream error: ${message}`);
  } finally {
    clearTimeout(timeout);
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

app.get("/api/models", async (_req, res, next) => {
  try {
    const settings = await loadSettings();
    const models = await fetchAvailableModels(settings);
    res.json({ models, count: models.length });
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
