const $ = (selector) => document.querySelector(selector);
const localEndpoint = `${window.location.origin}/v1`;
let settingsCache = null;
let availableModels = [];


function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
  return data;
}

function switchPage(page) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  document.querySelectorAll(".page").forEach((item) => item.classList.toggle("active", item.id === page));
  if (page === "dashboard") loadDashboard();
  if (page === "settings") loadSettings();
}

function renderCurlExample(settings) {
  const model = settings?.defaultModel || "your-model";
  const auth = settings?.hasClientApiKey ? " -H \"Authorization: Bearer YOUR_PROXY_API_KEY\"" : "";
  $("#curlExample").textContent = `curl ${localEndpoint}/chat/completions \\\n  -H "Content-Type: application/json"${auth} \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role":"user","content":"Hello"}],\n    "stream": false\n  }'`;
}

function renderRequests(rows) {
  const tbody = $("#requestsTable");
  if (!rows?.length) {
    tbody.innerHTML = `<tr><td colspan="6">暂无请求记录</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((row) => `
    <tr>
      <td>${new Date(row.at).toLocaleString()}</td>
      <td>${row.path || "-"}</td>
      <td>${row.model || "-"}</td>
      <td><span class="badge ${row.ok ? "ok" : "warn"}">${row.status}</span></td>
      <td>${row.attempts || 1}</td>
      <td>${row.latencyMs}ms</td>
    </tr>
  `).join("");
}

function setModelListMessage(message, className = "model-empty") {
  const list = $("#modelList");
  list.innerHTML = "";
  const item = document.createElement("div");
  item.className = className;
  item.textContent = message;
  list.appendChild(item);
}

function renderModelList(filter = $("#modelSearch")?.value || "") {
  const list = $("#modelList");
  if (!list) return;
  const query = filter.trim().toLowerCase();
  const matched = availableModels.filter((model) => model.id.toLowerCase().includes(query));
  list.innerHTML = "";

  if (!availableModels.length) {
    setModelListMessage("保存上游配置后，点击“读取模型”加载可用模型。");
    return;
  }

  if (!matched.length) {
    setModelListMessage("没有匹配的模型");
    return;
  }

  matched.slice(0, 100).forEach((model) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `model-option ${$("#defaultModel").value === model.id ? "selected" : ""}`;

    const name = document.createElement("strong");
    name.textContent = model.id;
    item.appendChild(name);

    if (model.ownedBy) {
      const meta = document.createElement("small");
      meta.textContent = model.ownedBy;
      item.appendChild(meta);
    }

    item.addEventListener("click", () => {
      $("#defaultModel").value = model.id;
      if (settingsCache) settingsCache.defaultModel = model.id;
      renderCurlExample(settingsCache);
      renderModelList($("#modelSearch").value);
    });
    list.appendChild(item);
  });

  if (matched.length > 100) {
    const more = document.createElement("div");
    more.className = "model-empty";
    more.textContent = `还有 ${matched.length - 100} 个模型，请继续输入关键词筛选。`;
    list.appendChild(more);
  }
}

async function loadModels(showToast = true, { refresh = false } = {}) {
  try {
    setModelListMessage(refresh ? "正在强制刷新上游模型列表..." : "正在读取上游模型列表...");
    const data = await api(`/api/models${refresh ? "?refresh=1" : ""}`);
    availableModels = data.models || [];
    renderModelList($("#modelSearch").value);
    if (showToast) {
      if (data.fromCache && data.staleError) {
        toast(`上游暂时不可达，使用缓存的 ${availableModels.length} 个模型`);
      } else if (data.fromCache) {
        toast(`使用缓存：${availableModels.length} 个模型`);
      } else {
        toast(`已读取 ${availableModels.length} 个模型`);
      }
    }
  } catch (error) {
    availableModels = [];
    setModelListMessage(`${error.message}（可点击“读取模型”重试）`, "model-empty warn-text");
    if (showToast) toast(error.message);
  }
}

async function loadDashboard() {

  try {
    const [dashboard, settings] = await Promise.all([api("/api/dashboard"), api("/api/settings")]);
    settingsCache = settings;
    $("#endpoint").textContent = localEndpoint;
    $("#upstreamStatus").textContent = dashboard.upstreamConfigured ? "已配置上游" : "未配置上游";
    $("#upstreamStatus").className = `badge ${dashboard.upstreamConfigured ? "ok" : "warn"}`;
    $("#totalRequests").textContent = dashboard.stats.totalRequests;
    $("#successRequests").textContent = dashboard.stats.successRequests;
    $("#failedRequests").textContent = dashboard.stats.failedRequests;
    $("#averageLatencyMs").textContent = `${dashboard.stats.averageLatencyMs}ms`;
    renderCurlExample(settings);
    renderRequests(dashboard.stats.lastRequests);
  } catch (error) {
    toast(error.message);
  }
}

async function loadSettings() {
  try {
    const settings = await api("/api/settings");
    settingsCache = settings;
    $("#upstreamBaseUrl").value = settings.upstreamBaseUrl || "";
    $("#upstreamApiKey").value = settings.hasUpstreamApiKey ? "********" : "";
    $("#clientApiKey").value = settings.hasClientApiKey ? "********" : "";
    $("#defaultModel").value = settings.defaultModel || "";
    $("#modelSearch").value = "";
    $("#requestTimeoutMs").value = settings.requestTimeoutMs || 120000;
    const locked = Object.entries(settings.envLocks || {}).filter(([, value]) => value).map(([key]) => key);
    $("#settingsHint").textContent = locked.length ? `以下配置由环境变量锁定，页面保存不会覆盖：${locked.join(", ")}` : "配置会保存到本地 data/settings.json。请只接入你有权使用的 OpenAI-compatible 上游服务。";
    renderCurlExample(settings);
    if (settings.upstreamBaseUrl) await loadModels(false);
    else renderModelList();
  } catch (error) {

    toast(error.message);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const payload = {
      upstreamBaseUrl: $("#upstreamBaseUrl").value,
      upstreamApiKey: $("#upstreamApiKey").value,
      clientApiKey: $("#clientApiKey").value,
      defaultModel: $("#defaultModel").value,
      requestTimeoutMs: Number($("#requestTimeoutMs").value)
    };
    const saved = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    settingsCache = saved;
    toast("配置已保存");
    await loadSettings();
  } catch (error) {
    toast(error.message);
  }
}

document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => switchPage(item.dataset.page)));
$("#refreshBtn").addEventListener("click", loadDashboard);
$("#reloadSettings").addEventListener("click", loadSettings);
$("#loadModels").addEventListener("click", () => loadModels(true, { refresh: true }));
$("#modelSearch").addEventListener("input", (event) => renderModelList(event.target.value));
$("#defaultModel").addEventListener("input", () => renderCurlExample({ ...settingsCache, defaultModel: $("#defaultModel").value }));
$("#settingsForm").addEventListener("submit", saveSettings);

loadDashboard();

setInterval(() => {
  if ($("#dashboard").classList.contains("active")) loadDashboard();
}, 7000);
