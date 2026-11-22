(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CONFIG_STORAGE_KEY = "agy_mobile_config_v2";
  const DRAFTS_STORAGE_KEY = "agy_mobile_drafts_v1";
  const NEW_DRAFT_KEY = "__new__";
  const DEFAULT_MODEL = "gemini-4-neon-medium";
  const SIDECAR = (window.__AGY_SIDECAR__ && window.__AGY_SIDECAR__.active) ? window.__AGY_SIDECAR__ : null;
  const SIDECAR_CID_RE = /^[A-Za-z0-9_-]{6,80}$/;

  function withSidecarToken(url) {
    if (!SIDECAR || !url) return url;
    try {
      if (typeof SIDECAR.withToken === "function") {
        return SIDECAR.withToken(url);
      }
      const token = String(SIDECAR.token || "").trim();
      if (!token) return url;
      const u = new URL(String(url), location.origin);
      if (u.origin === location.origin && !u.searchParams.has("sidecar_token")) {
        u.searchParams.set("sidecar_token", token);
        return u.toString();
      }
    } catch (_) {}
    return url;
  }

  function getSidecarConversationId() {
    if (!SIDECAR) return "";
    const raw = String(SIDECAR.conversationId || window.sidecar?.conversationId || "").trim();
    return SIDECAR_CID_RE.test(raw) ? raw : "";
  }

  function resolveSidecarHostTheme(themeHint) {
    const candidate = String(
      themeHint ||
      document.documentElement.dataset.agyTheme ||
      (SIDECAR && typeof SIDECAR.getTheme === "function" ? SIDECAR.getTheme() : "") ||
      ""
    ).toLowerCase();
    if (candidate === "dark" || candidate === "light") return candidate;
    return (darkMedia && darkMedia.matches) ? "dark" : "light";
  }

  const state = {
    themePref: "light", // "light" | "dark" | "system"
    resolvedDark: false,
    hosts: [],          // [{ id, name, url, token }]
    activeHostId: "",
    selectedModel: DEFAULT_MODEL,
    downloadSubdir: "Antigravity",
    downloadAskFolder: false,
    serverInfo: null,
    qqbotAvailable: false,
    workspaceRoot: "",
    sidecarAutoFollowed: false,
    sidecarUserPicked: false,

    ws: null,
    wsConnected: false,
    reconnectTimer: null,
    connectEpoch: 0,

    conversations: [],
    filter: "all",           // "all" | "mobile" | "desktop" | "external"
    showExternalCli: false,
    search: "",
    currentCid: "",
    currentConv: null,
    openConvSeq: 0,
    lastRenderedConvFp: "",
    models: [],

    drafts: {}, // { [cid || "__new__"]: { text: string, attachments: Array } }
    swarmMode: false,
    attachments: [],
    streaming: false,
    streamBuffer: "",
    streamTools: [],

    recentPhotos: [],
    recentPhotosGranted: false,
    recentPhotosPartial: false,
    selectedPhotoIds: [],
    mediaPermRequestedOnce: false,
    nativeUploadCallbacks: {},
    nativeUploadSeq: 0,

    currentDir: "",
    previewFile: null,
    usageData: null,
    usageWindow: "5h",
  };

  const darkMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  // =========================================================================
  // 1. NATIVE ANDROID BRIDGE WRAPPERS (100% Defensive Optional Chaining)
  // =========================================================================
  function haptic(kind = "light") {
    try {
      window.AndroidBridge?.vibrate?.(kind);
    } catch (_) {}
  }

  function bridgeCopyText(text) {
    try {
      if (window.AndroidBridge?.copyText) {
        window.AndroidBridge.copyText(text);
        return true;
      }
    } catch (_) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return true;
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (_) {
      return false;
    }
  }

  function openOfficialRemote() {
    haptic("light");
    try {
      if (window.AndroidBridge?.openOfficialWeb) {
        window.AndroidBridge.openOfficialWeb();
        return;
      }
    } catch (_) {}
    window.open("https://antigravity.google", "_blank", "noopener");
  }

  function openQrScanner() {
    haptic("light");
    try {
      if (window.AndroidBridge?.openQrScanner) {
        window.AndroidBridge.openQrScanner();
        return;
      }
    } catch (_) {}
    const alt = $("welcome-alt-card");
    if (alt && !$("welcome-view").classList.contains("hidden")) {
      alt.open = true;
    }
    showToast("请在 Android 客户端内使用相机扫码，或在下方粘贴配对链接");
  }

  function syncSystemBars(isDark) {
    try {
      window.AndroidBridge?.setSystemBarTheme?.(Boolean(isDark));
    } catch (_) {}
    const meta = $("meta-theme-color");
    if (meta) {
      meta.setAttribute("content", isDark ? "#131314" : "#FFFFFF");
    }
  }

  // Exposed native inset hook: MainActivity WindowInsetsListener -> CSS vars
  window.__setAndroidInsets = (topPx, bottomPx, kbPx) => {
    const t = Math.max(0, Number(topPx) || 0);
    const b = Math.max(0, Number(bottomPx) || 0);
    const k = Math.max(0, Number(kbPx) || 0);
    document.documentElement.style.setProperty("--safe-top", `${t}px`);
    document.documentElement.style.setProperty("--safe-bottom", `${b}px`);
    document.documentElement.style.setProperty("--kb-height", `${k}px`);
    if (k > 0) scrollToBottom(true);
  };

  // Exposed native back button hook
  window.__handleAndroidBack = () => {
    const confirmDlg = $("pair-confirm-dialog");
    if (confirmDlg && !confirmDlg.classList.contains("hidden")) {
      closePairConfirmDialog(true);
      return true;
    }
    for (const mid of ["preview-modal", "pair-modal", "usage-modal", "files-modal", "qqbot-modal", "settings-modal"]) {
      const el = $(mid);
      if (el && !el.classList.contains("hidden")) {
        el.classList.add("hidden");
        return true;
      }
    }
    if (
      !$("model-sheet").classList.contains("hidden") ||
      !$("host-sheet").classList.contains("hidden") ||
      !$("attach-sheet").classList.contains("hidden")
    ) {
      closeAllSheets();
      return true;
    }
    if ($("drawer").classList.contains("open")) {
      closeDrawer();
      return true;
    }
    return false;
  };

  // Exposed native QR deep-link hook: agylink://pair?u=...&t=...&n=...
  window.__onAndroidPairUri = (uri) => {
    if (uri) {
      handlePairUri(String(uri), { source: "deeplink" });
    }
  };

  // Exposed native Android Activity.onResume() hook for silent foreground sync
  window.__onAndroidResume = () => {
    syncOnForegroundResume();
  };

  // Exposed native media permission callback for QQ-style bottom photo drawer
  window.__onAndroidMediaPermissionResult = (granted, partial) => {
    state.recentPhotosGranted = Boolean(granted);
    state.recentPhotosPartial = Boolean(partial);
    const sheet = $("attach-sheet");
    if (sheet && !sheet.classList.contains("hidden")) {
      loadRecentPhotosInSheet(false);
    }
  };

  // Exposed native lossless photo upload callback
  window.__onNativeUploadDone = (cbId, responseJson, errorMsg) => {
    const entry = state.nativeUploadCallbacks[cbId];
    if (!entry) return;
    delete state.nativeUploadCallbacks[cbId];
    if (errorMsg) {
      entry.reject(new Error(String(errorMsg)));
      return;
    }
    try {
      const data = JSON.parse(String(responseJson || "{}"));
      if (!data || data.ok === false) {
        entry.reject(new Error(data?.error || "上传返回异常"));
        return;
      }
      entry.resolve(data);
    } catch (_) {
      entry.reject(new Error("上传响应解析失败"));
    }
  };

  // =========================================================================
  // 2. THEME ENGINE (Light Default + Google Dark + Follow System / Sidecar)
  // =========================================================================
  function syncSidecarTheme(themeHint) {
    if (!SIDECAR) return;
    const hostTheme = resolveSidecarHostTheme(themeHint);
    document.documentElement.dataset.agyTheme = hostTheme;
    if (state.themePref === "system") {
      applyTheme("system", false);
    }
  }

  function applyTheme(pref, persist = false) {
    const valid = ["light", "dark", "system"].includes(pref) ? pref : "light";
    state.themePref = valid;
    const isDark =
      valid === "dark" ||
      (valid === "system" &&
        (SIDECAR ? resolveSidecarHostTheme() === "dark" : Boolean(darkMedia && darkMedia.matches)));
    state.resolvedDark = isDark;

    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    syncSystemBars(isDark);

    // Update theme labels & icons
    const wLbl = $("welcome-theme-label");
    if (wLbl) wLbl.textContent = isDark ? "深色" : "浅色";

    const wBtn = $("btn-welcome-theme");
    if (wBtn) {
      wBtn.querySelector(".icon-sun")?.classList.toggle("hidden", isDark);
      wBtn.querySelector(".icon-moon")?.classList.toggle("hidden", !isDark);
    }

    document.querySelectorAll(".theme-opt").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeChoice === valid);
    });

    if (persist) {
      persistConfig();
    }
  }

  if (darkMedia && darkMedia.addEventListener) {
    darkMedia.addEventListener("change", () => {
      if (state.themePref === "system") {
        applyTheme("system", false);
      }
    });
  }

  if (SIDECAR) {
    window.addEventListener("agy-sidecar-theme", (ev) => {
      const nextTheme = ev && ev.detail && ev.detail.theme ? String(ev.detail.theme) : "";
      syncSidecarTheme(nextTheme);
    });
  }

  // =========================================================================
  // 3. MULTI-HOST CONFIG PERSISTENCE (Universal — Zero Hardcoded Data)
  // =========================================================================
  function makeHostId() {
    return "h_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  }

  function normalizeServerUrl(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) {
      return "";
    }
    if (/^(javascript|data|vbscript|file|blob|about):/i.test(s)) {
      return "";
    }
    if (!/^https?:\/\//i.test(s)) {
      s = "http://" + s;
    }
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      if (!u.hostname) return "";
      // If user omitted port on a plain LAN/Tailscale IPv4 or localhost over http, default to :18795
      if (
        u.protocol === "http:" &&
        !u.port &&
        (/^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) || u.hostname === "localhost")
      ) {
        u.port = "18795";
      }
      return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.replace(/\/+$/, "");
    } catch (_) {
      return "";
    }
  }

  function hostDisplayFallback(url) {
    try {
      return new URL(url).host;
    } catch (_) {
      return String(url || "").replace(/^https?:\/\//i, "");
    }
  }

  function getActiveHost() {
    if (!state.hosts.length) return null;
    const found = state.hosts.find((h) => h.id === state.activeHostId);
    if (found) return found;
    state.activeHostId = state.hosts[0].id;
    return state.hosts[0];
  }

  function loadConfig() {
    let parsed = null;
    try {
      const rawBridge = window.AndroidBridge?.getConfig?.();
      if (rawBridge && String(rawBridge).trim()) {
        parsed = JSON.parse(String(rawBridge));
      }
    } catch (_) {}

    if (!parsed) {
      try {
        const rawLocal = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (rawLocal) parsed = JSON.parse(rawLocal);
      } catch (_) {}
    }

    // Migrate legacy single-host format if present (never hardcoding defaults)
    if (!parsed) {
      try {
        const oldUrl = (localStorage.getItem("agy_mob_url") || "").trim();
        const oldTok = (localStorage.getItem("agy_mob_tok") || "").trim();
        if (oldUrl && oldTok) {
          const id = makeHostId();
          parsed = {
            version: 2,
            theme: "light",
            hosts: [{ id, name: hostDisplayFallback(oldUrl), url: normalizeServerUrl(oldUrl), token: oldTok }],
            activeHostId: id,
            selectedModel: localStorage.getItem("agy_mob_model") || DEFAULT_MODEL,
          };
        }
      } catch (_) {}
    }

    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.hosts)) {
        state.hosts = parsed.hosts
          .filter((h) => h && h.url)
          .map((h) => ({
            id: String(h.id || makeHostId()),
            name: String(h.name || hostDisplayFallback(h.url)).trim(),
            url: normalizeServerUrl(h.url),
            token: String(h.token || "").trim(),
          }));
        state.activeHostId = String(parsed.activeHostId || (state.hosts[0] ? state.hosts[0].id : ""));
      } else if (parsed.serverUrl) {
        const url = normalizeServerUrl(parsed.serverUrl);
        const id = makeHostId();
        state.hosts = [{ id, name: hostDisplayFallback(url), url, token: String(parsed.token || "").trim() }];
        state.activeHostId = id;
      }

      if (parsed.theme) state.themePref = parsed.theme;
      if (parsed.selectedModel) state.selectedModel = String(parsed.selectedModel);
      if (parsed.downloadSubdir !== undefined) state.downloadSubdir = String(parsed.downloadSubdir);
      if (parsed.downloadAskFolder !== undefined) state.downloadAskFolder = Boolean(parsed.downloadAskFolder);
      if (parsed.showExternalCli !== undefined) state.showExternalCli = Boolean(parsed.showExternalCli);
      if (typeof parsed.filter === "string" && ["all", "mobile", "desktop", "external"].includes(parsed.filter)) {
        state.filter = parsed.filter;
      }
      if (!state.showExternalCli && state.filter === "external") {
        state.filter = "all";
      }
    }

    // Optional URL theme override (?theme=dark or ?theme=light) for quick testing
    try {
      const qs = new URLSearchParams(location.search);
      const qTheme = qs.get("theme");
      if (qTheme === "dark" || qTheme === "light" || qTheme === "system") {
        state.themePref = qTheme;
      }
    } catch (_) {}
  }

  function persistConfig() {
    const payload = {
      version: 2,
      theme: state.themePref,
      hosts: state.hosts,
      activeHostId: state.activeHostId,
      selectedModel: state.selectedModel,
      downloadSubdir: state.downloadSubdir,
      downloadAskFolder: state.downloadAskFolder,
      showExternalCli: state.showExternalCli,
      filter: state.filter,
    };
    const jsonStr = JSON.stringify(payload);
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, jsonStr);
    } catch (_) {}
    try {
      window.AndroidBridge?.saveConfig?.(jsonStr);
    } catch (_) {}
  }

  function upsertHost({ name, url, token }, activate = true) {
    const normUrl = normalizeServerUrl(url);
    const cleanTok = String(token || "").trim();
    const cleanName = String(name || "").trim() || hostDisplayFallback(normUrl);

    let existing = state.hosts.find((h) => h.url.toLowerCase() === normUrl.toLowerCase());
    if (existing) {
      existing.token = cleanTok;
      if (cleanName) existing.name = cleanName;
    } else {
      existing = { id: makeHostId(), name: cleanName, url: normUrl, token: cleanTok };
      state.hosts.unshift(existing);
    }

    if (activate) {
      state.activeHostId = existing.id;
    }
    persistConfig();
    return existing;
  }

  function deleteHost(hostId) {
    const idx = state.hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return;
    const wasActive = state.hosts[idx].id === state.activeHostId;
    state.hosts.splice(idx, 1);

    if (wasActive) {
      state.activeHostId = state.hosts.length ? state.hosts[0].id : "";
      persistConfig();
      renderSettingsHosts();
      renderHostSheetList();
      if (state.hosts.length) {
        activateCurrentHost();
      } else {
        disconnectWs();
        $("settings-modal").classList.add("hidden");
        showWelcomeScreen();
      }
    } else {
      persistConfig();
      renderSettingsHosts();
      renderHostSheetList();
    }
  }

  // =========================================================================
  // 4. VIEW ROUTING (Welcome vs Workspace) & TOAST
  // =========================================================================
  function showWelcomeScreen() {
    disconnectWs();
    document.body.classList.add("welcome-active");
    $("welcome-view").classList.remove("hidden");
    $("app").classList.add("hidden");

    // Pre-fill current host:port ONLY when opened from an HTTP server (never hardcode IPs)
    const hostInp = $("welcome-host-input");
    if (hostInp && !hostInp.value && (location.protocol === "http:" || location.protocol === "https:") && location.host) {
      hostInp.value = location.host;
    }
  }

  function showWorkspaceScreen() {
    document.body.classList.remove("welcome-active");
    $("welcome-view").classList.add("hidden");
    $("app").classList.remove("hidden");
    updateHostDisplays();
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = String(msg || "");
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2500);
  }

  function showBanner(el, kind, msg) {
    if (!el) return;
    if (!msg) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.className = `m3-inline-banner ${kind}`;
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  // =========================================================================
  // 5. UNIVERSAL PAIRING FLOWS (6-Digit PIN, agylink:// URI, Manual)
  // =========================================================================
  async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
    if (typeof AbortController === "undefined") {
      return fetch(url, opts);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("连接超时（8秒无响应）：请检查电脑防火墙是否已放行 18795 端口，或在校园网下改用 Tailscale (100.x.x.x) 地址");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function claimPinPair(rawHost, rawPin, bannerEl, btnEl) {
    const url = normalizeServerUrl(rawHost);
    const pin = String(rawPin || "").replace(/\D+/g, "");
    if (!url) {
      showBanner(bannerEl, "err", "请先填写电脑的局域网或 Tailscale 地址");
      return false;
    }
    if (!/^\d{6}$/.test(pin)) {
      showBanner(bannerEl, "err", "请输入完整的 6 位数字配对码");
      return false;
    }

    if (btnEl) btnEl.disabled = true;
    showBanner(bannerEl, "info", "正在向电脑验证 6 位配对码...");
    try {
      const resp = await fetchWithTimeout(`${url}/api/pair/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      }, 8000);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false || !data.token) {
        const reason = data.error || (resp.status === 429 ? "尝试过于频繁，请一分钟后重试" : resp.status === 401 || resp.status === 403 ? "配对码错误或已过期" : `HTTP ${resp.status}`);
        throw new Error(reason);
      }

      if (data.default_model) {
        state.selectedModel = String(data.default_model);
        updateModelPill();
      }
      const host = upsertHost({ name: data.hostname || hostDisplayFallback(url), url, token: data.token }, true);
      showBanner(bannerEl, "ok", `配对成功：${host.name}`);
      haptic("success");
      showToast(`已配对并连接到 ${host.name}`);
      $("settings-modal").classList.add("hidden");
      showWorkspaceScreen();
      activateCurrentHost();
      return true;
    } catch (err) {
      showBanner(bannerEl, "err", `配对失败：${err.message || "无法连接到该地址"}`);
      return false;
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  function parsePairUri(rawUri) {
    const trimmed = String(rawUri || "").trim();
    if (!trimmed) return null;
    if (!/^(agylink|https?):\/\//i.test(trimmed)) return null;
    try {
      // Support agylink://pair?u=...&t=...&n=... (or http(s)://... with query params)
      const normalized = /^agylink:\/\//i.test(trimmed)
        ? trimmed.replace(/^agylink:\/\//i, "https://")
        : trimmed;
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      const q = parsed.searchParams;
      const u = (q.get("u") || q.get("url") || q.get("host") || "").trim();
      const t = (q.get("t") || q.get("token") || "").trim();
      const n = (q.get("n") || q.get("name") || "").trim();
      if (!u || !t) return null;
      if (!/^https?:\/\//i.test(u)) return null;
      const target = new URL(u);
      if (target.protocol !== "http:" && target.protocol !== "https:") return null;
      if (!target.hostname) return null;
      const normUrl = normalizeServerUrl(u);
      if (!normUrl) return null;
      return { url: normUrl, token: t, name: n };
    } catch (_) {
      return null;
    }
  }

  let _pendingPairConfirm = null;

  function closePairConfirmDialog(cancelled = false) {
    const dlg = $("pair-confirm-dialog");
    if (dlg) dlg.classList.add("hidden");
    const prev = _pendingPairConfirm;
    _pendingPairConfirm = null;
    if (cancelled && prev) {
      if (prev.opts?.bannerEl) {
        showBanner(prev.opts.bannerEl, "info", "已取消导入主机");
      } else {
        showToast("已取消导入主机");
      }
    }
  }

  function applyConfirmedPair(parsed, opts = {}) {
    const host = upsertHost(parsed, true);
    haptic("success");
    if (opts.bannerEl) showBanner(opts.bannerEl, "ok", `已导入主机：${host.name}`);
    $("settings-modal").classList.add("hidden");
    showWorkspaceScreen();
    activateCurrentHost();
    showToast(`已配对并连接：${host.name}`);
    return true;
  }

  function promptPairConfirm(parsed, opts = {}) {
    const dlg = $("pair-confirm-dialog");
    const displayName = parsed.name || hostDisplayFallback(parsed.url);
    if (!dlg) {
      const ok = window.confirm(`确认导入并切换到此主机？\n\n名称：${displayName}\n地址：${parsed.url}`);
      if (!ok) {
        showToast("已取消导入主机");
        return false;
      }
      return applyConfirmedPair(parsed, opts);
    }
    _pendingPairConfirm = { parsed, opts };
    const nameEl = $("pair-confirm-name");
    const urlEl = $("pair-confirm-url");
    if (nameEl) nameEl.textContent = displayName;
    if (urlEl) urlEl.textContent = parsed.url;
    dlg.classList.remove("hidden");
    $("btn-pair-confirm-ok")?.focus();
    return false;
  }

  function handlePairUri(rawUri, opts = {}) {
    const trimmed = String(rawUri || "").trim();
    const parsed = parsePairUri(trimmed);
    if (!parsed) {
      // If user scanned a plain server URL like http://10.x.x.x:18795/pair without token, prefill host input
      if (/^https?:\/\//i.test(trimmed)) {
        try {
          const u = new URL(trimmed);
          if (u.protocol === "http:" || u.protocol === "https:") {
            const hostAddr = `${u.protocol}//${u.host}`;
            const wHost = $("welcome-host-input");
            const sHost = $("add-pin-host");
            if (wHost) wHost.value = hostAddr;
            if (sHost) sHost.value = hostAddr;
            showToast("已识别电脑地址，请继续输入 6 位配对码");
            return false;
          }
        } catch (_) {}
      }
      if (opts.bannerEl) {
        showBanner(opts.bannerEl, "err", "配对链接格式无效，请扫描电脑 /pair 页面上的二维码");
      } else if (opts.source === "deeplink" || opts.source === "qr") {
        showToast("未识别到有效的 Antigravity 配对二维码");
      }
      return false;
    }

    const source = opts.source || "";
    if (source === "deeplink" || source === "qr" || source === "query") {
      return promptPairConfirm(parsed, opts);
    }
    return applyConfirmedPair(parsed, opts);
  }

  async function pairManual(rawName, rawUrl, rawToken, bannerEl, btnEl) {
    const url = normalizeServerUrl(rawUrl);
    const token = String(rawToken || "").trim();
    if (!url || !token) {
      showBanner(bannerEl, "err", "请填写完整的服务地址和访问令牌");
      return false;
    }

    if (btnEl) btnEl.disabled = true;
    showBanner(bannerEl, "info", "正在验证主机连通性与令牌...");
    try {
      const resp = await fetchWithTimeout(`${url}/api/server-info`, {
        headers: { Authorization: `Bearer ${token}` },
      }, 8000);
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) throw new Error("访问令牌无效 (401)");
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);

      const name = String(rawName || "").trim() || data.hostname || hostDisplayFallback(url);
      if (data.default_model) {
        state.selectedModel = String(data.default_model);
        updateModelPill();
      }
      const host = upsertHost({ name, url, token }, true);
      haptic("success");
      showBanner(bannerEl, "ok", `连接成功：${host.name}`);
      $("settings-modal").classList.add("hidden");
      showWorkspaceScreen();
      activateCurrentHost();
      showToast(`已连接到 ${host.name}`);
      return true;
    } catch (err) {
      showBanner(bannerEl, "err", `连接失败：${err.message || "网络不可达"}`);
      return false;
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function testConnectionDirect(rawUrl, rawToken, bannerEl) {
    const url = normalizeServerUrl(rawUrl);
    const token = String(rawToken || "").trim();
    if (!url) {
      showBanner(bannerEl, "err", "请先输入服务地址");
      return;
    }
    showBanner(bannerEl, "info", "正在测试连通性...");
    try {
      const resp = await fetchWithTimeout(`${url}/api/server-info`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }, 8000);
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) throw new Error("服务器可达，但访问令牌校验未通过 (401)");
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
      showBanner(
        bannerEl,
        "ok",
        `连接正常 · 主机 ${data.hostname || hostDisplayFallback(url)} · CLI ${data.agy_cli_ready ? "就绪" : "未检测到"}`
      );
    } catch (err) {
      showBanner(bannerEl, "err", `测试失败：${err.message || "无法访问该地址"}`);
    }
  }

  // =========================================================================
  // 6. API CLIENT & WEBSOCKET CONNECTION
  // =========================================================================
  async function apiFetch(path, opts = {}) {
    const host = getActiveHost();
    if (!host || !host.url) throw new Error("未配置主机");
    const headers = Object.assign({}, opts.headers || {});
    if (host.token) headers["Authorization"] = `Bearer ${host.token}`;
    if (opts.body && !(opts.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const resp = await fetch(`${host.url}${path}`, Object.assign({}, opts, { headers }));
    if (resp.status === 401) {
      setConnState("offline", "访问令牌无效，请在主机设置检查");
      throw new Error("身份校验失败 (401)");
    }
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await resp.json();
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  }

  function setConnState(mode, subText) {
    ["conn-dot", "empty-host-dot", "drawer-host-dot"].forEach((id) => {
      const dot = $(id);
      if (dot) dot.className = `conn-dot ${mode}`;
    });
    if (subText !== undefined) {
      $("conv-subtitle").textContent = subText;
    }
  }

  function updateHostDisplays() {
    const host = getActiveHost();
    const isDesktopHost = isLocalDesktopBrowser();
    const label = host ? host.name : (isDesktopHost ? "本机主机" : "未配置主机");
    const sub = isDesktopHost
      ? (state.wsConnected ? "本机主机在线 · 点此出示手机扫码" : "正在连接本机服务...")
      : (host ? host.url.replace(/^https?:\/\//i, "") : "点击添加主机");
    const dName = $("drawer-host-name");
    const dUrl = $("drawer-host-url");
    const eName = $("empty-host-name");
    if (dName) dName.textContent = label;
    if (dUrl) dUrl.textContent = sub;
    if (eName) {
      eName.textContent = isDesktopHost
        ? (state.wsConnected ? `${label} · 点此出示手机扫码二维码` : "正在连接本机主机...")
        : (state.wsConnected ? `已连接 · ${label}` : label);
    }
  }

  let _refreshConvsTimer = null;
  let _lastRefreshConvsAt = 0;
  let _lastResumeSyncAt = 0;

  function disconnectWs() {
    state.connectEpoch += 1;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    clearTimeout(_refreshConvsTimer);
    _refreshConvsTimer = null;
    if (state.sseAbort) {
      try {
        state.sseAbort.abort();
      } catch (_) {}
      state.sseAbort = null;
    }
    if (state.ws) {
      try {
        state.ws.onopen = null;
        state.ws.onmessage = null;
        state.ws.onclose = null;
        state.ws.onerror = null;
        state.ws.close();
      } catch (_) {}
      state.ws = null;
    }
    state.wsConnected = false;
  }

  function syncOnForegroundResume() {
    if (!getActiveHost()) return;
    const now = Date.now();
    if (now - _lastResumeSyncAt < 600) return;
    _lastResumeSyncAt = now;
    if (!state.wsConnected) {
      const rs = state.ws ? state.ws.readyState : WebSocket.CLOSED;
      if (rs === WebSocket.CLOSED || rs === WebSocket.CLOSING) {
        connectWs();
      }
    }
    refreshConversationsThrottled(500);
    if (state.currentCid && !state.streaming) {
      openConversation(state.currentCid, { silent: true });
    }
  }

  // =========================================================================
  // 5.5 PER-CONVERSATION ISOLATED DRAFTS ("一个萝卜一个坑")
  // =========================================================================
  function currentDraftKey() {
    return state.currentCid || NEW_DRAFT_KEY;
  }

  function draftStorageKeyForHost() {
    return `${DRAFTS_STORAGE_KEY}:${state.activeHostId || "default"}`;
  }

  function hasDraftContent(d) {
    if (!d || typeof d !== "object") return false;
    const hasTxt = typeof d.text === "string" && d.text.trim().length > 0;
    const hasAtt = Array.isArray(d.attachments) && d.attachments.length > 0;
    return hasTxt || hasAtt;
  }

  function loadHostDrafts() {
    state.drafts = {};
    try {
      const raw = localStorage.getItem(draftStorageKeyForHost());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (hasDraftContent(v)) {
              state.drafts[k] = {
                text: typeof v.text === "string" ? v.text : "",
                attachments: Array.isArray(v.attachments) ? v.attachments : [],
              };
            }
          }
        }
      }
    } catch (_) {}
    updateNewChatDraftHint();
  }

  function persistHostDrafts() {
    try {
      const clean = {};
      for (const [k, v] of Object.entries(state.drafts)) {
        if (hasDraftContent(v)) {
          clean[k] = {
            text: typeof v.text === "string" ? v.text : "",
            attachments: Array.isArray(v.attachments) ? v.attachments : [],
          };
        }
      }
      state.drafts = clean;
      localStorage.setItem(draftStorageKeyForHost(), JSON.stringify(clean));
    } catch (_) {}
    updateNewChatDraftHint();
  }

  function updateNewChatDraftHint() {
    const pill = $("new-chat-draft-pill");
    if (pill) {
      pill.classList.toggle("hidden", !hasDraftContent(state.drafts[NEW_DRAFT_KEY]));
    }
  }

  function resizePromptInput() {
    const inp = $("prompt-input");
    if (!inp) return;
    inp.style.height = "auto";
    if (inp.value) {
      inp.style.height = `${Math.min(128, inp.scrollHeight)}px`;
    }
  }

  function saveCurrentDraft(explicitKey) {
    const key = explicitKey || currentDraftKey();
    const inp = $("prompt-input");
    const text = inp ? inp.value : "";
    const atts = Array.isArray(state.attachments) ? state.attachments.slice() : [];
    if (text.trim().length > 0 || text.length > 0 || atts.length > 0) {
      state.drafts[key] = { text, attachments: atts };
    } else {
      delete state.drafts[key];
    }
    persistHostDrafts();
  }

  function restoreDraftFor(key) {
    const d = state.drafts[key];
    const inp = $("prompt-input");
    if (inp) {
      inp.value = d && typeof d.text === "string" ? d.text : "";
      resizePromptInput();
    }
    state.attachments = d && Array.isArray(d.attachments) ? d.attachments.slice() : [];
    renderAttachTray();
    updateSendButton();
  }

  function migrateDraftKey(oldKey, newKey) {
    if (!oldKey || !newKey || oldKey === newKey) return;
    if (state.drafts[oldKey] && !state.drafts[newKey]) {
      state.drafts[newKey] = state.drafts[oldKey];
      delete state.drafts[oldKey];
      persistHostDrafts();
    }
  }

  function activateCurrentHost() {
    const host = getActiveHost();
    if (!host) {
      showWelcomeScreen();
      return;
    }
    loadHostDrafts();
    state.openConvSeq += 1;
    state.lastRenderedConvFp = "";
    state.currentCid = "";
    state.currentConv = null;
    state.conversations = [];
    state.streaming = false;
    state.streamBuffer = "";
    state.streamTools = [];
    state.serverInfo = null;
    state.qqbotAvailable = false;
    state.workspaceRoot = "";
    state.currentDir = "";
    state.sidecarAutoFollowed = false;
    state.sidecarUserPicked = false;
    $("settings-open-qqbot")?.classList.add("hidden");

    restoreDraftFor(NEW_DRAFT_KEY);
    updateHostDisplays();
    updateSidecarHeaderActions();
    renderConversation();
    renderConvList();
    // Kick off HTTP bootstrap immediately so sidebar/models populate even while stream connects
    fetchServerInfo();
    refreshConversations();
    loadModels();
    connectWs();
  }

  async function connectSidecarSse(host, epoch) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    state.sseAbort = ctrl;
    setConnState("connecting", `正在连接 ${host.name}...`);
    try {
      const resp = await fetch(`${host.url}/__sidecar/events`, {
        method: "GET",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${host.token}`,
          Accept: "text/event-stream",
        },
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (epoch !== state.connectEpoch) return;
      if (!resp.ok || !resp.body || typeof resp.body.getReader !== "function") {
        throw new Error(`SSE HTTP ${resp.status}`);
      }

      state.wsConnected = true;
      updateHostDisplays();
      updateSendButton();
      fetchServerInfo();
      refreshConversations();
      loadModels();
      if (state.currentCid && !state.streaming) {
        openConversation(state.currentCid, { silent: true });
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      while (epoch === state.connectEpoch) {
        const { value, done } = await reader.read();
        if (done) break;
        if (epoch !== state.connectEpoch) break;
        buf += decoder.decode(value, { stream: true });
        let splitIdx = buf.indexOf("\n\n");
        while (splitIdx !== -1) {
          const frame = buf.slice(0, splitIdx);
          buf = buf.slice(splitIdx + 2);
          for (const rawLine of frame.split(/\r?\n/)) {
            if (!rawLine.startsWith("data:")) continue;
            const payload = rawLine.slice(5).trim();
            if (!payload) continue;
            try {
              onWsEvent(JSON.parse(payload));
            } catch (_) {}
          }
          splitIdx = buf.indexOf("\n\n");
        }
      }
    } catch (_) {
      // Fall through to clean disconnect/reconnect below
    } finally {
      if (state.sseAbort === ctrl) state.sseAbort = null;
      if (epoch === state.connectEpoch) {
        state.wsConnected = false;
        updateHostDisplays();
        updateSendButton();
        if (getActiveHost()) {
          state.reconnectTimer = setTimeout(connectWs, 2500);
        }
      }
    }
  }

  function connectWs() {
    disconnectWs();
    const host = getActiveHost();
    if (!host || !host.url) {
      setConnState("offline", "未配置主机");
      return;
    }

    const epoch = state.connectEpoch;
    if (SIDECAR) {
      connectSidecarSse(host, epoch);
      return;
    }

    const wsUrl = host.url.replace(/^http/i, "ws") + `/ws?token=${encodeURIComponent(host.token)}`;
    setConnState("connecting", `正在连接 ${host.name}...`);

    try {
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        if (epoch !== state.connectEpoch) return;
        state.wsConnected = true;
        updateHostDisplays();
        updateSendButton();
        fetchServerInfo();
        refreshConversations();
        loadModels();
        if (state.currentCid && !state.streaming) {
          openConversation(state.currentCid, { silent: true });
        }
      };

      ws.onmessage = (ev) => {
        if (epoch !== state.connectEpoch) return;
        try {
          const msg = JSON.parse(ev.data);
          onWsEvent(msg);
        } catch (_) {}
      };

      ws.onclose = () => {
        if (epoch !== state.connectEpoch) return;
        state.wsConnected = false;
        updateHostDisplays();
        updateSendButton();
        if (getActiveHost()) {
          state.reconnectTimer = setTimeout(connectWs, 3200);
        }
      };

      ws.onerror = () => {
        if (epoch !== state.connectEpoch) return;
        try { ws.close(); } catch (_) {}
      };
    } catch (_) {
      if (epoch === state.connectEpoch && getActiveHost()) {
        state.reconnectTimer = setTimeout(connectWs, 4000);
      }
    }
  }

  async function fetchServerInfo() {
    try {
      const data = await apiFetch("/api/server-info");
      state.serverInfo = data;
      state.qqbotAvailable = Boolean(data.qqbot_available);
      $("settings-open-qqbot")?.classList.toggle("hidden", !state.qqbotAvailable);

      if (data.workspace_root) {
        state.workspaceRoot = String(data.workspace_root);
        if (!state.currentDir) state.currentDir = state.workspaceRoot;
      }

      const host = getActiveHost();
      if (host && data.hostname && host.name === hostDisplayFallback(host.url)) {
        host.name = String(data.hostname);
        persistConfig();
      }
      updateHostDisplays();
      updateSendButton();
    } catch (_) {}
  }

  function onWsEvent(ev) {
    const cid = ev.conversation_id || "";
    const adoptPendingCid = () => {
      if (cid && state.streaming && (!state.currentCid || state.currentCid.startsWith("pending-"))) {
        const prevCid = state.currentCid;
        state.currentCid = cid;
        if (state.currentConv) state.currentConv.id = cid;
        if (prevCid && prevCid !== cid) {
          migrateDraftKey(prevCid, cid);
        }
        updateSidecarHeaderActions();
      }
    };

    const ensurePeerStreamAttached = (promptText, attachments, modelId) => {
      if (!cid || cid !== state.currentCid) return;
      if (modelId) {
        state.selectedModel = String(modelId);
        updateModelPill();
      }
      if (!state.streaming) {
        if (!state.currentConv) {
          state.currentConv = {
            id: cid,
            title: String(promptText || "").slice(0, 36) || "新对话",
            source: "mobile",
            messages: [],
            deliverables: [],
          };
        }
        const pTxt = String(promptText || "").trim();
        const atts = Array.isArray(attachments) ? attachments : [];
        if (pTxt || atts.length) {
          const msgs = state.currentConv.messages || [];
          const last = msgs[msgs.length - 1];
          const alreadyHas = Boolean(last && last.role === "user" && (last.text || "").trim() === pTxt);
          if (!alreadyHas) {
            msgs.push({
              role: "user",
              text: pTxt,
              attachments: atts,
              time: new Date().toISOString(),
            });
          }
        }
        state.streaming = true;
        state.streamBuffer = "";
        state.streamTools = [];
        renderConversation();
      } else if (!$("streaming-row")) {
        renderConversation();
      }
    };

    if (ev.type === "run_start" || ev.type === "run_init") {
      adoptPendingCid();
      if (cid && cid === state.currentCid) {
        ensurePeerStreamAttached(ev.prompt, ev.attachments, ev.model);
      }
      refreshConversations();
    } else if (ev.type === "run_tool") {
      adoptPendingCid();
      if (cid === state.currentCid) {
        if (!state.streaming || !$("streaming-row")) {
          ensurePeerStreamAttached("", [], ev.model);
        }
        const t = ev.tool;
        if (t && t.state === "DONE" && state.streamTools.length && state.streamTools[state.streamTools.length - 1].name === t.name) {
          state.streamTools[state.streamTools.length - 1] = t;
        } else if (t) {
          state.streamTools.push(t);
        }
        updateStreamingRow();
      }
    } else if (ev.type === "run_delta") {
      adoptPendingCid();
      if (cid === state.currentCid) {
        if (!state.streaming || !$("streaming-row")) {
          ensurePeerStreamAttached("", [], ev.model);
        }
        state.streamBuffer += ev.delta || "";
        updateStreamingRow();
      }
    } else if (ev.type === "run_done") {
      adoptPendingCid();
      haptic("success");
      if (cid === state.currentCid || (ev.aliased_cid && ev.aliased_cid === state.currentCid)) {
        state.streaming = false;
        openConversation(state.currentCid, { silent: true });
      }
      refreshConversationsThrottled(400);
    } else if (ev.type === "run_canceled") {
      adoptPendingCid();
      const matchesCurrent =
        (cid && cid === state.currentCid) ||
        (ev.run_id && state.currentCid === `pending-${ev.run_id}`);
      if (matchesCurrent) {
        state.streaming = false;
        renderConversation({ preserveScroll: true });
      }
      refreshConversationsThrottled(400);
    } else if (ev.type === "run_error") {
      adoptPendingCid();
      const matchesCurrent =
        (cid && cid === state.currentCid) ||
        (ev.run_id && state.currentCid === `pending-${ev.run_id}`) ||
        (!state.currentCid && state.streaming);
      if (matchesCurrent) {
        state.streaming = false;
        state.streamBuffer = "";
        state.streamTools = [];
        const errText = String(ev.error || "未知错误");
        if (state.currentConv) {
          state.currentConv.messages.push({
            role: "assistant",
            text: `执行发生错误：\n\`\`\`\n${errText}\n\`\`\``,
            model: state.selectedModel,
          });
        }
        renderConversation({ preserveScroll: true });
        showToast(`执行失败：${errText.slice(0, 80)}`);
      }
      refreshConversationsThrottled(400);
    } else if (ev.type === "tunnel_status" && ev.tunnel) {
      if (isLocalDesktopBrowser()) {
        const ts = String(ev.tunnel.status || "");
        if (ts === "reconnecting") {
          showToast("检测到公网隧道断连，后台正在自动自愈重连...");
        } else if (ts === "online" && ev.tunnel.url) {
          showToast("公网隧道已恢复在线，可点右上角「供手机扫码」刷新二维码");
        }
      }
    } else if (ev.type === "desktop_update") {
      const aliasedCid = ev.aliased_cid || "";
      const matchesCurrent = Boolean(state.currentCid) && (
        cid === state.currentCid || (aliasedCid && aliasedCid === state.currentCid)
      );
      if (matchesCurrent && !state.streaming) {
        openConversation(state.currentCid, { silent: true });
      }
      refreshConversationsThrottled();
    }
  }

  // =========================================================================
  // 7. MARKDOWN RENDERER & FORMATTING HELPERS
  // =========================================================================
  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function unescHtml(s) {
    return String(s ?? "")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
  }

  function makeRenderNonce() {
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        const buf = new Uint32Array(2);
        window.crypto.getRandomValues(buf);
        return buf[0].toString(36) + buf[1].toString(36);
      }
    } catch (_) {}
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }

  function applyEmphasis(str) {
    let out = str;
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return out;
  }

  function renderInline(text) {
    const nonce = makeRenderNonce();
    let s = escHtml(text);

    // 1. Inline code first (protect content inside backticks with per-render nonce)
    const inlineCodes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      const idx = inlineCodes.length;
      inlineCodes.push({ raw: "`" + c + "`", html: `<code class="inline-code">${c}</code>` });
      return `@@IC_${nonce}_${idx}@@`;
    });

    const icRe = new RegExp(`@@IC_${nonce}_(\\d+)@@`, "g");
    const restoreIcRaw = (str) =>
      str.replace(icRe, (_, idx) => {
        const item = inlineCodes[Number(idx)];
        return item ? item.raw : "";
      });
    const restoreIcHtml = (str) =>
      str.replace(icRe, (_, idx) => {
        const item = inlineCodes[Number(idx)];
        return item ? item.html : "";
      });

    // 2. Tokenize Markdown links [text](url) into placeholders BEFORE emphasis
    //    Never restore inline-code HTML tags inside href attributes!
    const linkTokens = [];
    s = s.replace(/\[([^\]]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g, (_, lbl, href) => {
      const cleanHref = unescHtml(restoreIcRaw(href)).trim();
      const renderedLbl = restoreIcHtml(applyEmphasis(lbl));
      if (cleanHref.startsWith("file:///")) {
        let fp = "";
        try {
          fp = decodeURIComponent(cleanHref.replace(/^file:\/\//, "")).split("#")[0];
        } catch (_) {
          fp = cleanHref.replace(/^file:\/\//, "").split("#")[0];
        }
        if (/^\/[A-Za-z]:\//.test(fp)) fp = fp.slice(1);
        const idx = linkTokens.length;
        linkTokens.push(`<a href="#" class="file-link" data-filepath="${escHtml(fp)}">${renderedLbl}</a>`);
        return `@@LK_${nonce}_${idx}@@`;
      }
      if (/^https?:\/\//i.test(cleanHref)) {
        let finalHref = cleanHref;
        if (SIDECAR) {
          try {
            const u = new URL(cleanHref);
            if (
              u.origin === location.origin &&
              (u.pathname === "/download-apk" ||
                u.pathname === "/pair" ||
                u.pathname.startsWith("/api/files/"))
            ) {
              finalHref = withSidecarToken(cleanHref);
            }
          } catch (_) {}
        }
        const idx = linkTokens.length;
        linkTokens.push(`<a href="${escHtml(finalHref)}" target="_blank" rel="noopener">${renderedLbl}</a>`);
        return `@@LK_${nonce}_${idx}@@`;
      }
      if (SIDECAR && /^\/(download-apk|pair|api\/files\/)/i.test(cleanHref)) {
        const idx = linkTokens.length;
        linkTokens.push(`<a href="${escHtml(withSidecarToken(cleanHref))}" target="_blank" rel="noopener">${renderedLbl}</a>`);
        return `@@LK_${nonce}_${idx}@@`;
      }
      return renderedLbl;
    });

    // 3. Tokenize bare http(s):// URLs into placeholders BEFORE emphasis
    s = s.replace(/(^|[\s(（【\[>])(https?:\/\/[^\s<>"'\]）】]+)/gi, (m, lead, rawUrl) => {
      let urlPart = rawUrl;
      let trail = "";
      while (/[.,;:!?。，；：！？]$/.test(urlPart)) {
        trail = urlPart.slice(-1) + trail;
        urlPart = urlPart.slice(0, -1);
      }
      while (urlPart.endsWith(")")) {
        const opens = (urlPart.match(/\(/g) || []).length;
        const closes = (urlPart.match(/\)/g) || []).length;
        if (closes > opens) {
          trail = ")" + trail;
          urlPart = urlPart.slice(0, -1);
        } else {
          break;
        }
      }
      const cleanUrl = unescHtml(restoreIcRaw(urlPart)).trim();
      if (!/^https?:\/\/\S+$/i.test(cleanUrl)) return m;
      const safeUrl = escHtml(cleanUrl);
      const idx = linkTokens.length;
      linkTokens.push(`<a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>`);
      return `${lead}@@LK_${nonce}_${idx}@@${trail}`;
    });

    // 4. Bold, strikethrough, italic (cannot corrupt tokenized URLs or inline code)
    s = applyEmphasis(s);

    // 5. Restore inline code FIRST, then links (so inline code can never touch <a> attributes)
    s = restoreIcHtml(s);
    const lkRe = new RegExp(`@@LK_${nonce}_(\\d+)@@`, "g");
    s = s.replace(lkRe, (_, idx) => linkTokens[Number(idx)] || "");
    return s;
  }

  function renderMarkdown(md) {
    const nonce = makeRenderNonce();
    const src = String(md || "").replace(/\r\n/g, "\n");
    const blocks = [];
    const codeTokens = [];

    // Extract fenced code blocks (supports c#, c++, trailing spaces, and streaming open fences)
    let stripped = src.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, rawLang, code) => {
      const idx = codeTokens.length;
      const lang = String(rawLang || "").trim().slice(0, 32) || "code";
      codeTokens.push({ lang, code: code.replace(/\n$/, "") });
      return `\n@@CB_${nonce}_${idx}@@\n`;
    });
    stripped = stripped.replace(/```([^\n`]*)\n([\s\S]+)$/, (_, rawLang, code) => {
      const idx = codeTokens.length;
      const lang = String(rawLang || "").trim().slice(0, 32) || "code";
      codeTokens.push({ lang, code: code.replace(/\n$/, "") });
      return `\n@@CB_${nonce}_${idx}@@\n`;
    });

    const codeLineRe = new RegExp(`^@@CB_${nonce}_(\\d+)@@$`);
    const lines = stripped.split("\n");
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      const trim = ln.trim();
      if (!trim) { i++; continue; }

      const mCode = trim.match(codeLineRe);
      if (mCode) {
        const cb = codeTokens[Number(mCode[1])];
        if (cb) {
          blocks.push(
            `<div class="code-block">` +
              `<div class="code-head"><span>${escHtml(cb.lang)}</span>` +
              `<button class="code-copy-btn" type="button" data-copy="${encodeURIComponent(cb.code)}">复制</button></div>` +
              `<pre><code>${escHtml(cb.code)}</code></pre>` +
            `</div>`
          );
          i++;
          continue;
        }
      }

      if (/^---+$/.test(trim) || /^\*\*\*+$/.test(trim)) {
        blocks.push("<hr/>");
        i++;
        continue;
      }

      const mH = trim.match(/^(#{1,6})\s+(.+)$/);
      if (mH) {
        const lvl = mH[1].length;
        blocks.push(`<h${lvl}>${renderInline(mH[2])}</h${lvl}>`);
        i++;
        continue;
      }

      if (trim.startsWith("> ") || trim === ">") {
        const qLines = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          qLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        blocks.push(`<blockquote>${qLines.map(renderInline).join("<br/>")}</blockquote>`);
        continue;
      }

      // Markdown table
      if (trim.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        const parseRow = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const headers = parseRow(ln);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().includes("|")) {
          rows.push(parseRow(lines[i]));
          i++;
        }
        const ths = headers.map((h) => `<th>${renderInline(h)}</th>`).join("");
        const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("");
        blocks.push(`<div class="md-table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
        continue;
      }

      // Unordered list
      if (/^[-*•]\s+/.test(trim)) {
        const items = [];
        while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
          items.push(`<li>${renderInline(lines[i].trim().replace(/^[-*•]\s+/, ""))}</li>`);
          i++;
        }
        blocks.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(trim)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          items.push(`<li>${renderInline(lines[i].trim().replace(/^\d+\.\s+/, ""))}</li>`);
          i++;
        }
        blocks.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      // Paragraph
      const pLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !codeLineRe.test(lines[i].trim()) &&
        !/^(#{1,6}\s+|[-*•]\s+|\d+\.\s+|>\s|---+$|\*\*\*+$)/.test(lines[i].trim())
      ) {
        pLines.push(lines[i]);
        i++;
      }
      blocks.push(`<p>${pLines.map(renderInline).join("<br/>")}</p>`);
    }
    return blocks.join("");
  }

  function formatSize(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
  }

  function shortModelLabel(mid) {
    const m = String(mid || DEFAULT_MODEL).toLowerCase();
    if (m.includes("orchestrator")) {
      if (m.includes("neon")) return "Orch·Neon";
      if (m.includes("argon")) return "Orch·Argon";
      return "Orch·Carbon";
    }
    const tail = (m.split("-").pop() || "").toLowerCase();
    const mapTier = (t) => (t === "xhigh" ? "XH" : t === "high" ? "High" : t === "medium" ? "Med" : t === "low" ? "Low" : t);
    if (m.includes("neon")) return `Neon ${mapTier(tail)}`;
    if (m.includes("hydrogen")) return `Hydrogen ${mapTier(tail)}`;
    if (m.includes("carbon")) return `Carbon ${mapTier(tail)}`;
    if (m.includes("argon")) return `Argon ${mapTier(tail)}`;
    if (m.includes("flash")) return `3.8 Flash ${mapTier(tail)}`;
    if (m.includes("opus")) return `Opus 5.5 ${mapTier(tail)}`;
    if (m.includes("sonnet")) return `Sonnet 5.5 ${mapTier(tail)}`;
    if (m.includes("gpt-oss")) return "GPT-OSS 120B";
    return m.slice(0, 14);
  }

  function updateModelPill() {
    $("model-pill-text").textContent = shortModelLabel(state.selectedModel);
  }

  function updateSendButton() {
    const btn = $("btn-send");
    const inp = $("prompt-input");
    const hasContent = Boolean((inp && inp.value.trim()) || state.attachments.length);
    const host = getActiveHost();

    if (state.streaming) {
      btn.classList.add("stopping");
      btn.classList.remove("ready");
      btn.setAttribute("aria-label", "停止生成");
      $("icon-send").classList.add("hidden");
      $("icon-stop").classList.remove("hidden");
      setConnState("running", "正在执行任务...");
    } else {
      btn.classList.remove("stopping");
      btn.classList.toggle("ready", hasContent);
      btn.setAttribute("aria-label", "发送");
      $("icon-send").classList.remove("hidden");
      $("icon-stop").classList.add("hidden");
      if (state.wsConnected) {
        const hostName = host ? host.name : "主机";
        setConnState("online", `${hostName} · 已连接`);
      } else {
        setConnState("offline", host ? `正在重连 ${host.name}...` : "未连接主机");
      }
    }
  }

  function scrollToBottom(force = false) {
    const el = $("chat-scroll");
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (force || nearBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }

  function assistantMarkSvg() {
    return `<img src="./logo-mark.png" width="15" height="15" alt="" style="display:block;object-fit:contain;" />`;
  }

  const CHEVRON_SVG = `<svg class="m3-tool-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
  const CHECK_SVG = `<svg class="tool-done-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  const COPY_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  // =========================================================================
  // 8. CHAT & STREAMING RENDER
  // =========================================================================
  function computeConvFingerprint(conv, isRunning) {
    if (!conv) return "";
    const cid = conv.id || state.currentCid || "";
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const lastTime = last && last.time ? String(last.time) : "";
    const lastTextLen = last && typeof last.text === "string" ? last.text.length : 0;
    const lastRole = last && last.role ? String(last.role) : "";
    const lastToolsLen = last && Array.isArray(last.tools) ? last.tools.length : 0;
    const lastAttsLen = last && Array.isArray(last.attachments) ? last.attachments.length : 0;
    let totalTextLen = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m && typeof m.text === "string") totalTextLen += m.text.length;
    }
    const delivs = Array.isArray(conv.deliverables) ? conv.deliverables : [];
    const running = isRunning ? 1 : 0;
    const title = conv.title || "";
    return `${cid}|${msgs.length}|${lastRole}|${lastTime}|${lastTextLen}|${totalTextLen}|${lastToolsLen}|${lastAttsLen}|${running}|${delivs.length}|${title}`;
  }

  function renderConversation(opts = {}) {
    const { preserveScroll = false } = opts || {};
    const list = $("messages-list");
    const conv = state.currentConv;
    const scrollEl = $("chat-scroll");

    if (!conv || (!conv.messages.length && !state.streaming)) {
      state.lastRenderedConvFp = "";
      $("empty-state").classList.remove("hidden");
      list.innerHTML = "";
      $("deliverables-box").classList.add("hidden");
      $("conv-title").textContent = "Antigravity";
      updateHostDisplays();
      updateSidecarHeaderActions();
      updateSendButton();
      return;
    }

    // Check scroll position BEFORE replacing DOM so silent refresh never yanks user
    const prevScrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const wasNearBottom = scrollEl
      ? (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120)
      : true;

    $("empty-state").classList.add("hidden");
    $("conv-title").textContent = conv.title || "新对话";
    list.innerHTML = "";

    for (const msg of conv.messages) {
      const row = document.createElement("div");
      row.className = `msg-row ${msg.role}`;

      if (msg.role === "user") {
        const host = getActiveHost();
        const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
        let attsHtml = "";
        if (atts.length) {
          const imgs = atts.filter((a) => a && a.is_image && a.path);
          const files = atts.filter((a) => a && !a.is_image && a.path);
          const parts = [];
          if (imgs.length) {
            const imgCards = imgs
              .map((a) => {
                const rawSrcUrl = host
                  ? `${host.url}${a.preview_url || `/api/files/preview?path=${encodeURIComponent(a.path)}`}&token=${encodeURIComponent(host.token)}`
                  : "";
                const srcUrl = rawSrcUrl ? withSidecarToken(rawSrcUrl) : "";
                return `<button class="msg-img-thumb msg-att-btn" type="button" data-path="${escHtml(a.path)}" data-name="${escHtml(a.name || "image")}" aria-label="查看原图 ${escHtml(a.name || "")}">` +
                  `<img src="${escHtml(srcUrl)}" alt="${escHtml(a.name || "")}" loading="lazy" />` +
                `</button>`;
              })
              .join("");
            parts.push(`<div class="msg-att-grid ${imgs.length === 1 ? "single-img" : ""}">${imgCards}</div>`);
          }
          if (files.length) {
            const filePills = files
              .map(
                (a) =>
                  `<button class="msg-file-pill msg-att-btn" type="button" data-path="${escHtml(a.path)}" data-name="${escHtml(a.name || "file")}">` +
                    `<span>📎 ${escHtml(a.name || "文件")}</span>` +
                  `</button>`
              )
              .join("");
            parts.push(`<div class="msg-att-grid">${filePills}</div>`);
          }
          attsHtml = parts.join("");
        }
        const bubbleHtml = msg.text ? `<div class="user-bubble">${escHtml(msg.text)}</div>` : "";
        row.innerHTML = `<div class="user-msg-stack">${attsHtml}${bubbleHtml}</div>`;
      } else {
        let toolsHtml = "";
        const hasTools = Boolean(msg.tools && msg.tools.length);
        const hasThinking = Boolean(msg.thinking && msg.thinking.trim());

        if (hasTools || hasThinking) {
          const items = (msg.tools || [])
            .map(
              (t) =>
                `<div class="tool-step">` +
                  `<span class="tool-step-status">✓</span>` +
                  `<span class="tool-step-name">${escHtml(t.name)}</span>` +
                  `<span class="tool-step-target">${escHtml(t.target || "")}</span>` +
                `</div>`
            )
            .join("");
          const thinkHtml = hasThinking
            ? `<div class="thinking-snippet">${escHtml(msg.thinking.trim())}</div>`
            : "";
          const summaryTitle = hasTools ? `已执行 ${msg.tools.length} 个工具步骤` : "查看思考摘要";
          toolsHtml = `
            <details class="m3-tool-card">
              <summary>
                ${CHECK_SVG}
                <span class="m3-tool-summary-text">${summaryTitle}</span>
                ${CHEVRON_SVG}
              </summary>
              <div class="tool-items">${items}${thinkHtml}</div>
            </details>`;
        }

        const mLabel = msg.model ? shortModelLabel(msg.model) : shortModelLabel(state.selectedModel);
        row.innerHTML = `
          <div class="assistant-flow">
            <div class="assistant-head">
              <span class="assistant-avatar">${assistantMarkSvg()}</span>
              <span>${escHtml(mLabel)}</span>
            </div>
            ${toolsHtml}
            ${msg.text ? `<div class="md-body">${renderMarkdown(msg.text)}</div>` : ""}
            ${
              msg.text
                ? `<div class="msg-actions">
                     <button class="msg-action-btn copy-msg" type="button" data-raw="${encodeURIComponent(msg.text)}">
                       ${COPY_SVG}<span>复制全文</span>
                     </button>
                   </div>`
                : ""
            }
          </div>`;
      }
      list.appendChild(row);
    }

    if (state.streaming) {
      const sRow = document.createElement("div");
      sRow.id = "streaming-row";
      sRow.className = "msg-row assistant";
      list.appendChild(sRow);
      updateStreamingRow();
    }

    // Inline Deliverables (Default Collapsed; preserve expanded state on silent refresh)
    const delivs = conv.deliverables || [];
    const delivBox = $("deliverables-box");
    if (delivs.length) {
      const wasOpen = preserveScroll && delivBox.open;
      delivBox.classList.remove("hidden");
      delivBox.open = wasOpen;
      const cntEl = $("deliverables-count");
      if (cntEl) cntEl.textContent = `本会话生成与关联文件（${delivs.length} 个）`;
      $("deliverables-list").innerHTML = delivs
        .map(
          (d) =>
            `<button class="deliv-chip" type="button" data-path="${escHtml(d.path)}" data-name="${escHtml(d.name)}">` +
              `<span class="deliv-chip-name">${escHtml(d.name)}</span>` +
              `<span class="deliv-chip-size">${formatSize(d.size)}</span>` +
            `</button>`
        )
        .join("");
    } else {
      delivBox.classList.add("hidden");
      delivBox.open = false;
    }

    state.lastRenderedConvFp = computeConvFingerprint(conv, state.streaming);
    updateSidecarHeaderActions();
    updateSendButton();
    if (!preserveScroll || wasNearBottom) {
      scrollToBottom(true);
    } else if (scrollEl) {
      scrollEl.scrollTop = prevScrollTop;
      requestAnimationFrame(() => {
        scrollEl.scrollTop = prevScrollTop;
        const away = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > 220;
        $("btn-scroll-bottom").classList.toggle("hidden", !away);
      });
    }
  }

  function updateStreamingRow() {
    const sRow = $("streaming-row");
    if (!sRow) return;
    const tools = state.streamTools || [];
    const items = tools
      .map(
        (t) =>
          `<div class="tool-step">` +
            `<span class="tool-step-status ${t.state === "ACTIVE" ? "active" : ""}">${t.state === "ACTIVE" ? "●" : "✓"}</span>` +
            `<span class="tool-step-name">${escHtml(t.name)}</span>` +
            `<span class="tool-step-target">${escHtml(t.target || "")}</span>` +
          `</div>`
      )
      .join("");

    const summaryText = tools.length
      ? `正在执行 (${tools.length} 步): ${escHtml(tools[tools.length - 1].name)}`
      : "正在思考与规划任务...";

    const traceHtml = `
      <details class="m3-tool-card" open>
        <div class="prism-progress-track" aria-hidden="true"><div class="prism-progress-bar"></div></div>
        <summary>
          <span class="tool-spinner" aria-hidden="true"></span>
          <span class="m3-tool-summary-text">${summaryText}</span>
          ${CHEVRON_SVG}
        </summary>
        ${items ? `<div class="tool-items">${items}</div>` : ""}
      </details>`;

    sRow.innerHTML = `
      <div class="assistant-flow">
        <div class="assistant-head">
          <span class="assistant-avatar">${assistantMarkSvg()}</span>
          <span>${escHtml(shortModelLabel(state.selectedModel))} · 实时输出</span>
        </div>
        ${traceHtml}
        ${state.streamBuffer ? `<div class="md-body">${renderMarkdown(state.streamBuffer)}</div>` : ""}
      </div>`;
    scrollToBottom(false);
  }

  // =========================================================================
  // 9. CONVERSATIONS LIST & DRAWER
  // =========================================================================
  function refreshConversationsThrottled(minIntervalMs = 1500) {
    const now = Date.now();
    const elapsed = now - _lastRefreshConvsAt;
    if (elapsed >= minIntervalMs && !_refreshConvsTimer) {
      refreshConversations();
      return;
    }
    if (_refreshConvsTimer) return;
    const wait = Math.max(250, minIntervalMs - elapsed);
    _refreshConvsTimer = setTimeout(() => {
      _refreshConvsTimer = null;
      refreshConversations();
    }, wait);
  }

  function syncFilterUi() {
    if (!state.showExternalCli && state.filter === "external") {
      state.filter = "all";
    }
    const extPill = $("filter-pill-external");
    if (extPill) {
      extPill.classList.toggle("hidden", !state.showExternalCli);
    }
    document.querySelectorAll("#conv-filter-bar [data-filter]").forEach((btn) => {
      const isAct = btn.dataset.filter === state.filter;
      btn.classList.toggle("active", isAct);
      btn.setAttribute("aria-selected", String(isAct));
    });
    document.querySelectorAll(".ext-cli-opt[data-ext-cli]").forEach((btn) => {
      btn.classList.toggle("active", (btn.dataset.extCli === "on") === Boolean(state.showExternalCli));
    });
  }

  function isDesktopBackedConversation(cid, conv) {
    if (!cid || String(cid).startsWith("pending-")) return false;
    if (conv && conv.source === "desktop") return true;
    const hostCid = getSidecarConversationId();
    if (hostCid && cid === hostCid) return true;
    const listed = state.conversations.find((c) => c && c.id === cid);
    return Boolean(listed && listed.source === "desktop");
  }

  function updateSidecarHeaderActions() {
    const followBtn = $("sidecar-follow-btn");
    const followTxt = $("sidecar-follow-text");
    const openMainBtn = $("sidecar-open-main-btn");
    if (!followBtn && !openMainBtn) return;

    if (!SIDECAR) {
      followBtn?.classList.add("hidden");
      openMainBtn?.classList.add("hidden");
      return;
    }

    const hostCid = getSidecarConversationId();
    const activeCid = state.currentCid || (state.currentConv && state.currentConv.id) || "";
    const hasValidActiveCid = Boolean(activeCid && !String(activeCid).startsWith("pending-"));

    if (followBtn) {
      if (!hostCid) {
        followBtn.classList.add("hidden");
      } else {
        followBtn.classList.remove("hidden");
        const isFollowing = hasValidActiveCid && activeCid === hostCid;
        followBtn.classList.toggle("following", isFollowing);
        followBtn.setAttribute("aria-disabled", isFollowing ? "true" : "false");
        if (followTxt) {
          followTxt.textContent = isFollowing ? "已跟随主窗口" : "回到主窗口对话";
        }
        followBtn.title = isFollowing
          ? "当前正跟随 Antigravity 主窗口对话"
          : "点击跳回 Antigravity 主窗口正在查看的对话";
      }
    }

    if (openMainBtn) {
      const canToggle = typeof SIDECAR.toggleConversation === "function";
      const isDesktopBacked = hasValidActiveCid && isDesktopBackedConversation(activeCid, state.currentConv);
      openMainBtn.classList.toggle("hidden", !(canToggle && isDesktopBacked));
    }
  }

  function maybeAutoFollowSidecarConversation() {
    if (!SIDECAR || state.sidecarAutoFollowed || state.sidecarUserPicked) return;
    if (state.currentCid || state.streaming) return;
    const hostCid = getSidecarConversationId();
    if (!hostCid) return;
    state.sidecarAutoFollowed = true;
    openConversation(hostCid, { silent: true, autoFollow: true });
  }

  async function refreshConversations() {
    _lastRefreshConvsAt = Date.now();
    const reqFilter = state.filter || "all";
    const reqExt = Boolean(state.showExternalCli);
    try {
      const qs = `limit=80&source=${encodeURIComponent(reqFilter)}&include_external_cli=${reqExt ? "1" : "0"}`;
      const data = await apiFetch(`/api/conversations?${qs}`);
      if (reqFilter !== (state.filter || "all") || reqExt !== Boolean(state.showExternalCli)) {
        return;
      }
      state.conversations = data.conversations || [];
      renderConvList();
      maybeAutoFollowSidecarConversation();
      updateSidecarHeaderActions();
      const anyRunning = state.conversations.some((c) => c.status === "running");
      $("running-badge").classList.toggle("hidden", !anyRunning);
    } catch (_) {}
  }

  function renderConvList() {
    updateNewChatDraftHint();
    const el = $("conv-list");
    const q = state.search.trim().toLowerCase();
    const filtered = state.conversations.filter((c) => {
      if (q && !(c.title || "").toLowerCase().includes(q) && !(c.preview || "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });

    if (!filtered.length) {
      el.innerHTML = `<div class="empty-placeholder">暂无匹配会话</div>`;
      return;
    }

    el.innerHTML = filtered
      .map((c) => {
        const act = c.id === state.currentCid ? "active" : "";
        let badge = "";
        if (c.status === "running") {
          badge = `<span class="ci-badge run">运行中</span>`;
        } else if (c.source === "external") {
          badge = `<span class="ci-badge ext">外部</span>`;
        } else if (c.source === "mobile") {
          badge = `<span class="ci-badge mob">移动</span>`;
        } else if (c.hasMobile && c.source === "desktop") {
          badge = `<span class="ci-badge sync">同步</span>`;
        }
        const draft = state.drafts[c.id];
        let prevHtml = escHtml(c.preview || c.shortId);
        if (hasDraftContent(draft)) {
          const dTxt = (draft.text || "").trim().replace(/\s+/g, " ");
          const dAtt = draft.attachments && draft.attachments.length ? `[${draft.attachments.length} 个附件]` : "";
          prevHtml = `<span class="ci-draft-tag">[草稿]</span>${escHtml(dTxt || dAtt)}`;
        }
        return `
          <button class="conv-item ${act}" type="button" data-cid="${escHtml(c.id)}">
            <div class="ci-top">
              <span class="ci-title">${escHtml(c.title)}</span>
              ${badge}
            </div>
            <div class="ci-prev">${prevHtml}</div>
          </button>`;
      })
      .join("");
  }

  async function openConversation(cid, opts = {}) {
    const { silent = false, autoFollow = false, userPicked = false } = opts || {};
    if (!cid) return;
    if (userPicked) {
      state.sidecarUserPicked = true;
    }
    const prevKey = currentDraftKey();
    const switching = cid !== state.currentCid;
    if (switching) {
      saveCurrentDraft(prevKey);
      state.currentCid = cid;
      state.lastRenderedConvFp = "";
      restoreDraftFor(cid);
      renderConvList();
      updateSidecarHeaderActions();
    }
    if (!silent) {
      closeDrawer();
    }
    const reqSeq = ++state.openConvSeq;
    try {
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}`);
      if (reqSeq !== state.openConvSeq || state.currentCid !== cid) return;
      const nextConv = data.conversation;
      const nextRunning = Boolean(nextConv && nextConv.activeRun && nextConv.activeRun.running);
      const nextFp = computeConvFingerprint(nextConv, nextRunning);

      state.currentConv = nextConv;
      if ((!silent || switching) && nextConv && nextConv.model) {
        state.selectedModel = nextConv.model;
        updateModelPill();
      }
      if (nextRunning) {
        state.streaming = true;
        state.streamBuffer = nextConv.activeRun.streamText || "";
        state.streamTools = nextConv.activeRun.tools || [];
      } else {
        state.streaming = false;
        state.streamBuffer = "";
        state.streamTools = [];
      }

      if (!switching && nextFp && nextFp === state.lastRenderedConvFp) {
        if (nextRunning) {
          updateStreamingRow();
        }
        updateSidecarHeaderActions();
        return;
      }

      renderConversation({ preserveScroll: silent && !switching });
      if (!silent || switching) {
        renderConvList();
      }
    } catch (e) {
      if (reqSeq !== state.openConvSeq) return;
      if (autoFollow && !state.currentConv && state.currentCid === cid) {
        state.currentCid = "";
        restoreDraftFor(NEW_DRAFT_KEY);
        renderConvList();
        updateSidecarHeaderActions();
      }
      if (!silent) {
        showToast(`加载会话失败：${e.message}`);
      }
    }
  }

  function startNewChat() {
    haptic("light");
    state.sidecarUserPicked = true;
    const prevKey = currentDraftKey();
    closeDrawer();
    if (prevKey !== NEW_DRAFT_KEY) {
      saveCurrentDraft(prevKey);
      state.openConvSeq += 1;
      state.lastRenderedConvFp = "";
      state.currentCid = "";
      state.currentConv = null;
      state.streaming = false;
      state.streamBuffer = "";
      state.streamTools = [];
      restoreDraftFor(NEW_DRAFT_KEY);
      renderConversation();
      renderConvList();
    } else {
      updateSidecarHeaderActions();
    }
    $("prompt-input").focus();
  }

  // =========================================================================
  // 10. SEND / CANCEL & FILE UPLOADS
  // =========================================================================
  async function handleSendOrStop() {
    haptic("light");
    if (state.streaming && state.currentCid) {
      try {
        await apiFetch(`/api/chat/cancel/${encodeURIComponent(state.currentCid)}`, { method: "POST" });
        state.streaming = false;
        updateSendButton();
        showToast("已停止任务");
      } catch (e) {
        showToast(`停止失败：${e.message}`);
      }
      return;
    }

    const inp = $("prompt-input");
    const rawText = inp.value;
    const text = rawText.trim();
    if (!text && !state.attachments.length) return;

    const sendDraftKey = currentDraftKey();
    const prevAttachments = state.attachments.slice();
    const attPaths = prevAttachments.map((a) => a.path);

    const createdNewConv = !state.currentConv;
    if (createdNewConv) {
      state.sidecarUserPicked = true;
      state.currentConv = {
        id: "",
        title: text.slice(0, 36) || (prevAttachments[0]?.name || "新对话"),
        source: "mobile",
        messages: [],
        deliverables: [],
      };
    }
    const targetConv = state.currentConv;
    const optimisticMsg = {
      role: "user",
      text: text,
      attachments: prevAttachments,
      time: new Date().toISOString(),
    };
    targetConv.messages.push(optimisticMsg);
    delete state.drafts[sendDraftKey];
    persistHostDrafts();
    inp.value = "";
    inp.style.height = "auto";
    state.attachments = [];
    renderAttachTray();

    const sendSeq = ++state.openConvSeq;
    state.streaming = true;
    state.streamBuffer = "";
    state.streamTools = [];
    renderConversation();

    try {
      const res = await apiFetch("/api/chat/send", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: state.currentCid || "__new__",
          prompt: text,
          model: state.selectedModel,
          attachments: attPaths,
          swarm_mode: state.swarmMode,
        }),
      });
      if (sendSeq === state.openConvSeq) {
        const nextCid = res.conversation_id;
        if (
          nextCid &&
          !(String(nextCid).startsWith("pending-") && state.currentCid && !state.currentCid.startsWith("pending-"))
        ) {
          state.currentCid = nextCid;
          if (state.currentConv) state.currentConv.id = nextCid;
          updateSidecarHeaderActions();
        }
      }
      refreshConversations();
    } catch (e) {
      const msgIdx = targetConv.messages.lastIndexOf(optimisticMsg);
      if (msgIdx !== -1) {
        targetConv.messages.splice(msgIdx, 1);
      }
      if (sendSeq === state.openConvSeq) {
        state.streaming = false;
        state.streamBuffer = "";
        state.streamTools = [];
        if (createdNewConv && targetConv.messages.length === 0) {
          state.currentConv = null;
        }
      }
      if (currentDraftKey() === sendDraftKey) {
        inp.value = rawText;
        resizePromptInput();
        state.attachments = prevAttachments;
        renderAttachTray();
        saveCurrentDraft(sendDraftKey);
      } else {
        state.drafts[sendDraftKey] = { text: rawText, attachments: prevAttachments };
        persistHostDrafts();
      }
      if (sendSeq === state.openConvSeq) {
        renderConversation({ preserveScroll: true });
      } else {
        updateSendButton();
      }
      showToast(`发送失败：${e.message}`);
    }
  }

  function appendUploadedAttachment(res, targetDraftKey) {
    const key = targetDraftKey || currentDraftKey();
    if (currentDraftKey() === key) {
      state.attachments.push(res);
      renderAttachTray();
      saveCurrentDraft(key);
    } else {
      const existing = state.drafts[key] || { text: "", attachments: [] };
      const nextAtts = Array.isArray(existing.attachments) ? existing.attachments.slice() : [];
      nextAtts.push(res);
      state.drafts[key] = { text: existing.text || "", attachments: nextAtts };
      persistHostDrafts();
      renderConvList();
    }
  }

  function renderAttachTray() {
    const tray = $("attach-tray");
    const host = getActiveHost();
    if (!state.attachments.length) {
      tray.classList.add("hidden");
      tray.innerHTML = "";
      updateSendButton();
      return;
    }
    tray.classList.remove("hidden");
    tray.innerHTML = state.attachments
      .map((a, idx) => {
        const rawThumb =
          a.is_image && host
            ? `${host.url}${a.preview_url || `/api/files/preview?path=${encodeURIComponent(a.path || "")}`}&token=${encodeURIComponent(host.token)}`
            : "";
        const imgTag = rawThumb
          ? `<img src="${escHtml(withSidecarToken(rawThumb))}" alt="" />`
          : "";
        return `
          <div class="attach-chip">
            ${imgTag}
            <span>${escHtml((a.name || "文件").slice(0, 18))}</span>
            <button type="button" data-rm="${idx}" aria-label="移除附件">✕</button>
          </div>`;
      })
      .join("");
    updateSendButton();
  }

  async function uploadFiles(fileList) {
    const targetKey = currentDraftKey();
    for (const f of Array.from(fileList || [])) {
      showToast(`正在上传 ${f.name}...`);
      const fd = new FormData();
      fd.append("file", f, f.name);
      try {
        const res = await apiFetch("/api/upload", { method: "POST", body: fd });
        appendUploadedAttachment(res, targetKey);
        haptic("light");
        const kindTag = res.is_image ? "无损原图" : "原文件";
        showToast(`已上传${kindTag} ${f.name} (${formatSize(res.size)})`);
      } catch (e) {
        showToast(`上传失败：${e.message}`);
      }
    }
  }

  function uploadNativeMediaPhoto(photo) {
    return new Promise((resolve, reject) => {
      const host = getActiveHost();
      if (!host || !host.url) {
        reject(new Error("未配置主机"));
        return;
      }
      if (!window.AndroidBridge?.uploadMediaImage) {
        reject(new Error("当前环境不支持原生相册直传"));
        return;
      }
      const cbId = `up_${Date.now()}_${++state.nativeUploadSeq}`;
      state.nativeUploadCallbacks[cbId] = { resolve, reject };
      try {
        window.AndroidBridge.uploadMediaImage(
          Number(photo.id),
          String(photo.name || `IMG_${photo.id}.jpg`),
          `${host.url}/api/upload`,
          String(host.token || ""),
          cbId
        );
      } catch (err) {
        delete state.nativeUploadCallbacks[cbId];
        reject(err);
      }
    });
  }

  // =========================================================================
  // 11. BOTTOM SHEETS (Models & Host Switcher)
  // =========================================================================
  async function loadModels() {
    try {
      const data = await apiFetch("/api/models");
      state.models = data.groups || [];
      if (!state.selectedModel && data.default_model) {
        state.selectedModel = data.default_model;
        updateModelPill();
      }
    } catch (_) {}
  }

  function closeAllSheets() {
    $("sheet-backdrop").classList.add("hidden");
    $("model-sheet").classList.add("hidden");
    $("host-sheet").classList.add("hidden");
    $("attach-sheet")?.classList.add("hidden");
  }

  function openModelSheet() {
    haptic("light");
    const body = $("model-groups");
    body.innerHTML =
      state.models
        .map(
          (g) => `
        <div>
          <div class="mg-title">${escHtml(g.group)} <span class="mg-tag">${escHtml(g.tag)}</span></div>
          <div class="mg-grid">
            ${(g.models || [])
              .map(
                (m) => `
              <button class="m-option ${m.id === state.selectedModel ? "selected" : ""}" type="button" data-mid="${escHtml(m.id)}">
                <span class="ml">${escHtml(m.label)}</span>
                <span class="md">${escHtml(m.desc)}</span>
              </button>`
              )
              .join("")}
          </div>
        </div>`
        )
        .join("") || `<div class="empty-placeholder">连接主机后自动加载可用模型列表</div>`;

    $("host-sheet").classList.add("hidden");
    $("attach-sheet")?.classList.add("hidden");
    $("sheet-backdrop").classList.remove("hidden");
    $("model-sheet").classList.remove("hidden");
  }

  function renderHostSheetList() {
    const el = $("host-sheet-list");
    if (!el) return;
    if (!state.hosts.length) {
      el.innerHTML = `<div class="empty-placeholder">暂无已配对主机</div>`;
      return;
    }
    el.innerHTML = state.hosts
      .map((h) => {
        const isAct = h.id === state.activeHostId;
        return `
          <button class="host-sheet-item ${isAct ? "active" : ""}" type="button" data-hid="${escHtml(h.id)}">
            <span class="conn-dot ${isAct ? (state.wsConnected ? "online" : "connecting") : ""}"></span>
            <div class="host-sheet-meta">
              <div class="host-sheet-name">${escHtml(h.name)}</div>
              <div class="host-sheet-url">${escHtml(h.url)}</div>
            </div>
            ${isAct ? CHECK_SVG : ""}
          </button>`;
      })
      .join("");
  }

  function openHostSheet() {
    haptic("light");
    renderHostSheetList();
    $("model-sheet").classList.add("hidden");
    $("attach-sheet")?.classList.add("hidden");
    $("sheet-backdrop").classList.remove("hidden");
    $("host-sheet").classList.remove("hidden");
  }

  // --- QQ-Style Bottom Photo & Attachment Drawer ---
  function updateAttachSelectionUi() {
    const strip = $("attach-photo-strip");
    if (strip) {
      strip.querySelectorAll(".photo-tile").forEach((tile) => {
        const pid = Number(tile.dataset.pid);
        const idx = state.selectedPhotoIds.indexOf(pid);
        const selected = idx !== -1;
        tile.classList.toggle("selected", selected);
        const chk = tile.querySelector(".photo-check");
        if (chk) chk.textContent = selected ? String(idx + 1) : "";
      });
    }
    const btn = $("btn-attach-confirm");
    if (btn) {
      const cnt = state.selectedPhotoIds.length;
      btn.disabled = cnt === 0;
      btn.textContent = cnt > 0 ? `添加 (${cnt})` : "添加";
    }
  }

  function loadRecentPhotosInSheet(autoRequestPerm = false) {
    const strip = $("attach-photo-strip");
    if (!strip) return;

    if (!window.AndroidBridge?.getRecentPhotosJson) {
      strip.innerHTML = `
        <div class="photo-perm-card">
          <div class="photo-perm-title">快速添加图片或文件</div>
          <div class="photo-perm-desc">点击下方「相册」选择图片，或点击「打开文件夹」浏览任意文件</div>
        </div>`;
      return;
    }

    let data = null;
    try {
      const raw = window.AndroidBridge.getRecentPhotosJson(60);
      data = JSON.parse(String(raw || "{}"));
    } catch (_) {
      data = { granted: false, items: [] };
    }

    state.recentPhotosGranted = Boolean(data && data.granted);
    state.recentPhotosPartial = Boolean(data && data.partial);

    if (!state.recentPhotosGranted) {
      strip.innerHTML = `
        <div class="photo-perm-card">
          <div class="photo-perm-title">开启相册权限，滑出即选最近图片</div>
          <div class="photo-perm-desc">授权后可像 QQ 一样直接横滑勾选最新截图与照片；不授权也可直接点下方「相册」或「打开文件夹」</div>
          <button id="btn-grant-media-perm" class="m3-btn tonal sm" type="button">授权查看最近照片</button>
        </div>`;
      if (autoRequestPerm && !state.mediaPermRequestedOnce) {
        state.mediaPermRequestedOnce = true;
        try {
          window.AndroidBridge.requestMediaPermission?.();
        } catch (_) {}
      }
      return;
    }

    const items = Array.isArray(data.items) ? data.items : [];
    state.recentPhotos = items;
    if (!items.length) {
      strip.innerHTML = `
        <div class="photo-perm-card">
          <div class="photo-perm-title">暂无最近照片</div>
          <div class="photo-perm-desc">可点击下方「相册」选择系统图库图片，或点击「打开文件夹」选择文件</div>
          ${state.recentPhotosPartial ? `<button id="btn-grant-media-perm" class="m3-btn tonal sm" type="button">添加更多授权照片</button>` : ""}
        </div>`;
      return;
    }

    const tilesHtml = items
      .map((p) => {
        const w = Number(p.width) || 0;
        const h = Number(p.height) || 0;
        const ratio = w > 0 && h > 0 ? w / h : 0.66;
        const cardW = Math.max(112, Math.min(244, Math.round(230 * ratio)));
        return `
          <button class="photo-tile" type="button" data-pid="${Number(p.id)}" style="width:${cardW}px" aria-label="${escHtml(p.name || "照片")}">
            <img src="${escHtml(p.thumbUrl)}" loading="lazy" decoding="async" alt="" />
            <span class="photo-check" aria-hidden="true"></span>
          </button>`;
      })
      .join("");

    const manageTile = state.recentPhotosPartial
      ? `<button class="photo-manage-tile" type="button">
           <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
             <line x1="12" y1="5" x2="12" y2="19"></line>
             <line x1="5" y1="12" x2="19" y2="12"></line>
           </svg>
           <span>管理更多<br/>授权照片</span>
         </button>`
      : "";

    strip.innerHTML = tilesHtml + manageTile;
    strip.scrollLeft = 0;
    updateAttachSelectionUi();
  }

  function openAttachSheet() {
    haptic("light");
    if (!window.AndroidBridge?.getRecentPhotosJson) {
      $("file-input")?.click();
      return;
    }
    const inp = $("prompt-input");
    if (inp && document.activeElement === inp) {
      inp.blur();
    }
    state.selectedPhotoIds = [];
    $("model-sheet").classList.add("hidden");
    $("host-sheet").classList.add("hidden");
    $("sheet-backdrop").classList.remove("hidden");
    $("attach-sheet").classList.remove("hidden");
    updateAttachSelectionUi();
    loadRecentPhotosInSheet(true);
  }

  async function confirmSelectedPhotos() {
    if (!state.selectedPhotoIds.length) return;
    const byId = new Map(state.recentPhotos.map((p) => [Number(p.id), p]));
    const picked = state.selectedPhotoIds.map((id) => byId.get(id)).filter(Boolean);
    if (!picked.length) return;

    const targetKey = currentDraftKey();
    state.selectedPhotoIds = [];
    closeAllSheets();
    haptic("light");

    let succeeded = 0;
    let lastSucceededName = "";
    for (let i = 0; i < picked.length; i++) {
      const p = picked[i];
      showToast(picked.length > 1 ? `正在上传原图 (${i + 1}/${picked.length})...` : `正在上传原图 ${p.name}...`);
      try {
        const res = await uploadNativeMediaPhoto(p);
        appendUploadedAttachment(res, targetKey);
        succeeded += 1;
        lastSucceededName = p.name || "";
        haptic("light");
      } catch (err) {
        showToast(`上传 ${p.name} 失败：${err.message}`);
      }
    }
    if (succeeded > 1) {
      showToast(
        succeeded === picked.length
          ? `已添加 ${succeeded} 张无损原图`
          : `已添加 ${succeeded}/${picked.length} 张无损原图`
      );
    } else if (succeeded === 1) {
      showToast(
        picked.length === 1
          ? `已添加无损原图 ${lastSucceededName}`
          : `已添加 1/${picked.length} 张无损原图`
      );
    }
  }

  // =========================================================================
  // 12. WORKSPACE FILES, PREVIEW, DOWNLOAD, QQ BOT & SETTINGS
  // =========================================================================
  const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
  const IMAGE_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
  const FILE_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;

  async function loadFilesDir(dirPath) {
    const list = $("files-list");
    list.innerHTML = `<div class="empty-placeholder">正在读取目录...</div>`;
    try {
      const qs = dirPath ? `?dir=${encodeURIComponent(dirPath)}` : "";
      const data = await apiFetch(`/api/files${qs}`);
      state.currentDir = data.dir || "";
      $("files-path").textContent = data.dir || "工作区";
      $("btn-files-up").dataset.parent = data.parent || "";
      $("btn-files-up").disabled = !data.parent;

      list.innerHTML =
        (data.items || [])
          .map((it) => {
            const isImg = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"].includes(it.ext);
            const ic = it.is_dir ? FOLDER_SVG : isImg ? IMAGE_SVG : FILE_SVG;
            return `
              <div class="file-row" data-isdir="${it.is_dir ? "1" : "0"}" data-path="${escHtml(it.path)}" data-name="${escHtml(it.name)}">
                <div class="file-ic ${it.is_dir ? "folder" : ""}">${ic}</div>
                <div class="file-info">
                  <div class="file-name">${escHtml(it.name)}</div>
                  <div class="file-meta">${it.is_dir ? "文件夹" : formatSize(it.size)}</div>
                </div>
              </div>`;
          })
          .join("") || `<div class="empty-placeholder">空目录</div>`;
    } catch (e) {
      list.innerHTML = `<div class="empty-placeholder">读取目录失败：${escHtml(e.message)}</div>`;
    }
  }

  async function openFilePreview(path, name) {
    const host = getActiveHost();
    if (!host) return;
    state.previewFile = { path, name };
    $("preview-name").textContent = name || path.split("/").pop();
    $("preview-meta").textContent = path;
    $("preview-body").innerHTML = `<div class="empty-placeholder">正在加载预览...</div>`;
    $("preview-modal").classList.remove("hidden");

    const ext = (path.split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) {
      const imgUrl = withSidecarToken(
        `${host.url}/api/files/preview?path=${encodeURIComponent(path)}&token=${encodeURIComponent(host.token)}`
      );
      $("preview-body").innerHTML = `<img src="${escHtml(imgUrl)}" alt="${escHtml(name || "")}" />`;
      return;
    }

    try {
      const data = await apiFetch(`/api/files/preview?path=${encodeURIComponent(path)}`);
      if (typeof Response !== "undefined" && data instanceof Response) {
        const txt = await data.text();
        $("preview-body").innerHTML = `<pre>${escHtml(txt.slice(0, 65536) || "(空文件)")}</pre>`;
      } else if (data.binary) {
        $("preview-body").innerHTML = `<div class="m3-card"><p class="info-text">该文件为二进制格式（${formatSize(data.size)}），请点击右上角「下载」保存到手机查看。</p></div>`;
      } else {
        $("preview-body").innerHTML = `<pre>${escHtml(data.content || "(空文件)")}</pre>`;
      }
    } catch (e) {
      $("preview-body").innerHTML = `<div class="m3-card"><p class="info-text">预览失败：${escHtml(e.message)}</p></div>`;
    }
  }

  function sanitizeSubdirInput(raw) {
    return String(raw || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.\.+/g, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/[<>:"|?*\x00-\x1f]+/g, "_");
  }

  function syncDownloadSettingsUi() {
    const ask = Boolean(state.downloadAskFolder);
    const sub = sanitizeSubdirInput(state.downloadSubdir);
    document.querySelectorAll(".dl-mode-opt").forEach((b) => {
      b.classList.toggle("active", b.dataset.dlMode === (ask ? "ask" : "subdir"));
    });
    const wrap = $("dl-subdir-wrap");
    if (wrap) wrap.classList.toggle("hidden", ask);
    const inp = $("settings-dl-subdir");
    if (inp && document.activeElement !== inp) inp.value = sub;
    const hint = $("settings-dl-hint");
    if (hint) {
      if (ask) {
        hint.innerHTML = "每次点击下载将弹出系统<strong>「另存为」</strong>窗口，可自由选择手机任意文件夹。";
      } else {
        const pathTxt = sub ? `Download/${escHtml(sub)}/` : "Download/";
        hint.innerHTML = `当前将直接保存到手机 <code>${pathTxt}</code>`;
      }
    }
  }

  function triggerDownload(path, name) {
    const host = getActiveHost();
    if (!host) return;
    const filename = name || path.split("/").pop() || "download";
    const url = withSidecarToken(
      `${host.url}/api/files/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(host.token)}`
    );
    const subdir = sanitizeSubdirInput(state.downloadSubdir);
    const ask = Boolean(state.downloadAskFolder);
    haptic("light");
    if (window.AndroidBridge?.downloadFileWithOptions) {
      try {
        window.AndroidBridge.downloadFileWithOptions(url, filename, subdir, ask);
        if (!ask) {
          const dest = subdir ? `Download/${subdir}/` : "Download/";
          showToast(`已开始下载到 ${dest}`);
        }
        return;
      } catch (_) {}
    }
    if (window.AndroidBridge?.downloadFile) {
      try {
        window.AndroidBridge.downloadFile(url, filename);
        showToast("已开始下载到手机 Downloads/Antigravity/");
        return;
      } catch (_) {}
    }
    window.open(url, "_blank", "noopener");
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 万`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function fmtLocalTime(isoStr) {
    if (!isoStr) return "";
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return "";
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    } catch (_) {
      return "";
    }
  }

  function openUsageModal() {
    closeDrawer();
    $("settings-modal")?.classList.add("hidden");
    $("usage-modal")?.classList.remove("hidden");
    loadUsageData();
  }

  async function loadUsageData() {
    const body = $("usage-body");
    if (!body) return;
    body.innerHTML = `<div class="empty-placeholder">正在核算本机对话日志用量...</div>`;
    try {
      const qs = state.currentCid ? `?cid=${encodeURIComponent(state.currentCid)}` : "";
      const data = await apiFetch(`/api/usage${qs}`);
      state.usageData = data;
      const sub = $("usage-subtitle");
      if (sub) {
        const cnt = Number(data.scanned_conversations || 0);
        const tStr = fmtLocalTime(data.generated_at);
        sub.textContent = `已核算近 7 天 ${cnt} 个会话 · 更新于 ${tStr || "刚刚"}`;
      }
      renderUsageView();
    } catch (e) {
      body.innerHTML = `<div class="m3-card"><p class="info-text">查询用量失败：${escHtml(e.message || "未知错误")}</p></div>`;
    }
  }

  function renderUsageView() {
    const body = $("usage-body");
    const data = state.usageData;
    if (!body || !data) return;

    const win = state.usageWindow || "5h";
    document.querySelectorAll("[data-usage-win]").forEach((btn) => {
      const active = btn.dataset.usageWin === win;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    const bucket =
      win === "5h"
        ? data.window_5h
        : win === "24h"
        ? data.window_24h
        : win === "7d"
        ? data.window_7d
        : data.current_conversation;

    const parts = [];

    // Optional user-configured external quota percentages (empty by default)
    if (data.external_quota && Array.isArray(data.external_quota.pools) && data.external_quota.pools.length) {
      const extRows = data.external_quota.pools
        .map((p) => {
          const pct = p.remaining_pct !== null && p.remaining_pct !== undefined ? Math.max(0, Math.min(100, Number(p.remaining_pct))) : null;
          const barCls = pct === null ? "" : pct <= 20 ? "low" : pct <= 50 ? "warn" : "ok";
          const pctTxt = pct !== null ? `剩余 ${pct.toFixed(1)}%` : "--";
          const rst = p.reset_at ? ` · 重置 ${escHtml(p.reset_at)}` : "";
          const note = p.note ? ` · ${escHtml(p.note)}` : "";
          return `
            <div class="usage-pool-row">
              <div class="usage-pool-top">
                <span class="usage-pool-name">${escHtml(p.name || "模型池")}</span>
                <span class="usage-pool-meta">${pctTxt}${rst}${note}</span>
              </div>
              <div class="usage-bar-track"><div class="usage-bar-fill ${barCls}" style="width:${pct !== null ? pct : 0}%"></div></div>
            </div>`;
        })
        .join("");
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">云端参考额度（${escHtml(data.external_quota.source || "自定义桥接")}）</div>
          <div class="usage-pool-list">${extRows}</div>
        </div>`);
    }

    if (!bucket) {
      parts.push(`<div class="m3-card"><div class="empty-placeholder">${win === "conv" ? "请先打开一个会话再查看「当前会话」统计" : "该时间窗口内暂无 Token 消耗记录"}</div></div>`);
      body.innerHTML = parts.join("");
      return;
    }

    const totalTok = Number(bucket.total_tokens || 0);
    const inTok = Number(bucket.input_tokens || 0);
    const caTok = Number(bucket.cache_read_tokens || 0);
    const outTok = Number(bucket.output_tokens || 0);
    const steps = Number(bucket.steps || 0);
    const hitPct = Number(bucket.cache_hit_pct || 0);
    const reliefTxt = win === "5h" && bucket.relief_at ? ` · 最早批次预计 ${fmtLocalTime(bucket.relief_at)} 滑出 5h 窗口` : "";

    parts.push(`
      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-k">总 Token 消耗</div>
          <div class="stat-v">${escHtml(fmtTokens(totalTok))}</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">缓存命中率</div>
          <div class="stat-v" style="color:var(--md-success)">${hitPct.toFixed(1)}%</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">模型推理步数${win === "conv" && bucket.turns ? " / 轮次" : ""}</div>
          <div class="stat-v">${steps} 步${win === "conv" && bucket.turns ? ` · ${bucket.turns} 轮` : ""}</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">净输入 / 输出</div>
          <div class="stat-v" style="font-size:13.5px">${escHtml(fmtTokens(inTok))} / ${escHtml(fmtTokens(outTok))}</div>
        </div>
      </div>`);

    const pools = Array.isArray(bucket.pools) ? bucket.pools : [];
    if (pools.length) {
      const poolHtml = pools
        .map((p) => {
          const share = Math.max(2, Math.min(100, Number(p.share_pct || 0)));
          return `
            <div class="usage-pool-row">
              <div class="usage-pool-top">
                <span class="usage-pool-name">${escHtml(p.label || p.id)}</span>
                <span class="usage-pool-meta">${escHtml(fmtTokens(p.total_tokens))} · ${Number(p.steps || 0)} 步 · 缓存 ${Number(p.cache_hit_pct || 0).toFixed(0)}%</span>
              </div>
              <div class="usage-bar-track"><div class="usage-bar-fill" style="width:${share}%"></div></div>
            </div>`;
        })
        .join("");
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">分模型池消耗明细</div>
          <div class="usage-pool-list">${poolHtml}</div>
        </div>`);
    } else {
      parts.push(`<div class="m3-card"><div class="empty-placeholder">该周期内暂无模型调用记录</div></div>`);
    }

    if (win === "7d" && Array.isArray(bucket.daily) && bucket.daily.length) {
      const maxDay = Math.max(1, ...bucket.daily.map((d) => Number(d.total_tokens || 0)));
      const cols = bucket.daily
        .map((d) => {
          const v = Number(d.total_tokens || 0);
          const pct = v > 0 ? Math.max(6, Math.round((v * 100) / maxDay)) : 0;
          return `
            <div class="usage-daily-col" title="${escHtml(d.date)}: ${escHtml(fmtTokens(v))} (${Number(d.steps || 0)} 步)">
              <span class="usage-daily-val">${v > 0 ? escHtml(fmtTokens(v)) : "0"}</span>
              <div class="usage-daily-bar-wrap"><div class="usage-daily-bar" style="height:${pct}%"></div></div>
              <span class="usage-daily-lbl">${escHtml(d.date)}</span>
            </div>`;
        })
        .join("");
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">近 7 天每日趋势</div>
          <div class="usage-daily-chart">${cols}</div>
        </div>`);
    }

    const models = Array.isArray(bucket.models) ? bucket.models : [];
    if (models.length) {
      const chips = models
        .map(
          (m) => `
          <span class="usage-model-chip">
            <strong>${escHtml(shortModelLabel(m.model))}</strong>
            <span class="m-sub">${escHtml(fmtTokens(m.total_tokens))} · ${Number(m.steps || 0)}步</span>
          </span>`
        )
        .join("");
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">具体模型调用分布</div>
          <div class="usage-model-chips">${chips}</div>
        </div>`);
    }

    parts.push(`
      <div class="m3-card tonal-info-card">
        <p class="info-text">
          统计口径：汇总本机官方桌面端（<code>antigravity/brain</code>）与 CLI（<code>antigravity-cli/brain</code>）完整对话日志（缓存读取 ${escHtml(fmtTokens(caTok))}${reliefTxt}）。<br />
          谷歌官方 CLI 暂未提供云端剩余百分比接口；如需接入自定义额度桥接，可在服务端环境变量设置 <code>AGY_QUOTA_API_URL</code>。
        </p>
      </div>`);

    body.innerHTML = parts.join("");
  }

  async function loadQqBotStatus() {
    const body = $("qqbot-body");
    body.innerHTML = `<div class="empty-placeholder">正在查询本机 QQ Bot 状态...</div>`;
    try {
      const d = await apiFetch("/api/qqbot/status");
      const quickModels = [
        "gemini-4-neon-low",
        "gemini-4-neon-medium",
        "gemini-4-carbon-medium",
        "gemini-4-hydrogen-medium",
        "gemini-3.8-flash-medium",
      ];
      const online = Boolean(d.bridge_online && d.gateway_online);
      body.innerHTML = `
        <div class="stat-grid">
          <div class="stat-box">
            <div class="stat-k">桥接 / 网关</div>
            <div class="stat-v" style="color:${online ? "var(--md-success)" : "var(--md-error)"}">${online ? "全部在线" : "异常"}</div>
          </div>
          <div class="stat-box">
            <div class="stat-k">DeepSeek 余额</div>
            <div class="stat-v">¥${escHtml(d.deepseek_cny ?? "--")}</div>
          </div>
          <div class="stat-box">
            <div class="stat-k">群聊模型</div>
            <div class="stat-v" style="font-size:13.5px">${escHtml(d.group_chat_model || "--")}</div>
          </div>
          <div class="stat-box">
            <div class="stat-k">累计调用</div>
            <div class="stat-v">${escHtml(d.total_calls ?? 0)} 次</div>
          </div>
        </div>
        <div class="m3-card">
          <div class="section-heading">一键切换 QQ 群聊模型</div>
          <div class="mg-grid">
            ${quickModels
              .map(
                (m) => `
              <button class="m-option qq-sw-btn ${m === d.group_chat_model ? "selected" : ""}" type="button" data-qmodel="${escHtml(m)}">
                <span class="ml">${escHtml(shortModelLabel(m))}</span>
                <span class="md">${escHtml(m)}</span>
              </button>`
              )
              .join("")}
          </div>
        </div>`;
    } catch (e) {
      body.innerHTML = `<div class="m3-card"><p class="info-text">查询失败：${escHtml(e.message)}</p></div>`;
    }
  }

  function renderSettingsHosts() {
    const list = $("settings-hosts-list");
    const countEl = $("settings-host-count");
    if (countEl) countEl.textContent = `${state.hosts.length} 台`;
    if (!list) return;

    if (!state.hosts.length) {
      list.innerHTML = `<div class="empty-placeholder">尚未添加任何电脑主机</div>`;
      return;
    }

    list.innerHTML = state.hosts
      .map((h) => {
        const isAct = h.id === state.activeHostId;
        return `
          <div class="saved-host-card ${isAct ? "active" : ""}" data-hid="${escHtml(h.id)}">
            <div class="sh-top">
              <div class="sh-info">
                <div class="sh-name-row">
                  <span class="sh-name">${escHtml(h.name)}</span>
                  ${isAct ? `<span class="sh-active-pill">当前使用</span>` : ""}
                </div>
                <div class="sh-url">${escHtml(h.url)}</div>
              </div>
            </div>
            <div class="sh-actions">
              ${isAct ? "" : `<button class="m3-btn tonal sm host-switch-btn" type="button" data-hid="${escHtml(h.id)}">切换使用</button>`}
              <button class="m3-btn outlined sm host-test-btn" type="button" data-hid="${escHtml(h.id)}">测试连通</button>
              <button class="m3-btn danger-tonal sm host-del-btn" type="button" data-hid="${escHtml(h.id)}">删除</button>
            </div>
          </div>`;
      })
      .join("");
  }

  function openSettingsModal() {
    closeDrawer();
    closeAllSheets();
    renderSettingsHosts();
    syncDownloadSettingsUi();
    syncFilterUi();
    $("settings-open-qqbot")?.classList.toggle("hidden", !state.qqbotAvailable);
    showBanner($("settings-hosts-msg"), "", "");
    showBanner($("settings-add-msg"), "", "");
    $("settings-modal").classList.remove("hidden");
  }

  // =========================================================================
  // 13. DRAWER CONTROL & EVENT WIRING
  // =========================================================================
  function openDrawer() {
    haptic("light");
    updateHostDisplays();
    $("drawer-backdrop").classList.remove("hidden");
    $("drawer").classList.add("open");
    refreshConversations();
  }

  function closeDrawer() {
    $("drawer-backdrop").classList.add("hidden");
    $("drawer").classList.remove("open");
  }

  function bindEvents() {
    // --- Welcome Screen Events ---
    $("btn-welcome-qr-scan")?.addEventListener("click", openQrScanner);
    $("btn-welcome-alt-scan")?.addEventListener("click", openQrScanner);
    $("btn-settings-qr-scan")?.addEventListener("click", openQrScanner);

    $("btn-welcome-theme").addEventListener("click", () => {
      haptic("light");
      applyTheme(state.resolvedDark ? "light" : "dark", true);
    });

    $("btn-welcome-pin-pair").addEventListener("click", () => {
      claimPinPair(
        $("welcome-host-input").value,
        $("welcome-pin-input").value,
        $("welcome-pin-msg"),
        $("btn-welcome-pin-pair")
      );
    });

    $("welcome-pin-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("btn-welcome-pin-pair").click();
      }
    });

    document.querySelectorAll("[data-welcome-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.welcomeTab;
        document.querySelectorAll("[data-welcome-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        $("welcome-tab-uri").classList.toggle("hidden", tab !== "uri");
        $("welcome-tab-manual").classList.toggle("hidden", tab !== "manual");
        showBanner($("welcome-alt-msg"), "", "");
      });
    });

    $("btn-welcome-uri-pair").addEventListener("click", () => {
      handlePairUri($("welcome-uri-input").value, { bannerEl: $("welcome-alt-msg") });
    });

    $("btn-welcome-manual-pair").addEventListener("click", () => {
      pairManual(
        $("welcome-manual-name").value,
        $("welcome-manual-url").value,
        $("welcome-manual-token").value,
        $("welcome-alt-msg"),
        $("btn-welcome-manual-pair")
      );
    });

    $("btn-welcome-official").addEventListener("click", openOfficialRemote);

    // --- Top Bar & Drawer ---
    $("btn-drawer").addEventListener("click", openDrawer);
    $("btn-close-drawer").addEventListener("click", closeDrawer);
    $("drawer-backdrop").addEventListener("click", closeDrawer);
    $("btn-new-top").addEventListener("click", startNewChat);
    $("btn-new-chat").addEventListener("click", startNewChat);

    $("sidecar-follow-btn")?.addEventListener("click", () => {
      if (!SIDECAR) return;
      const hostCid = getSidecarConversationId();
      if (!hostCid) return;
      if (state.currentCid === hostCid) {
        if (!state.streaming) {
          openConversation(hostCid, { silent: true });
        }
        return;
      }
      openConversation(hostCid, { userPicked: true });
    });

    $("sidecar-open-main-btn")?.addEventListener("click", () => {
      if (!SIDECAR || typeof SIDECAR.toggleConversation !== "function") return;
      const activeCid = state.currentCid || (state.currentConv && state.currentConv.id) || "";
      if (!activeCid || String(activeCid).startsWith("pending-")) return;
      try {
        SIDECAR.toggleConversation(activeCid);
        showToast("已在 Antigravity 主窗口打开此对话");
      } catch (err) {
        showToast(`打开主窗口失败：${err?.message || "未知错误"}`);
      }
    });
    $("btn-drawer-host").addEventListener("click", () => {
      closeDrawer();
      if (isLocalDesktopBrowser()) {
        $("btn-top-pair")?.click();
      } else {
        openHostSheet();
      }
    });
    $("empty-host-chip").addEventListener("click", () => {
      if (isLocalDesktopBrowser()) {
        $("btn-top-pair")?.click();
      } else {
        openHostSheet();
      }
    });

    // --- Sheets ---
    $("btn-model").addEventListener("click", openModelSheet);
    $("sheet-backdrop").addEventListener("click", closeAllSheets);
    document.querySelectorAll(".close-sheet").forEach((b) => b.addEventListener("click", closeAllSheets));

    $("model-groups").addEventListener("click", (e) => {
      const btn = e.target.closest(".m-option");
      if (!btn || !btn.dataset.mid) return;
      haptic("light");
      state.selectedModel = btn.dataset.mid;
      persistConfig();
      updateModelPill();
      closeAllSheets();
      showToast(`已切换模型：${shortModelLabel(state.selectedModel)}`);
    });

    $("host-sheet-list").addEventListener("click", (e) => {
      const item = e.target.closest(".host-sheet-item");
      if (!item || !item.dataset.hid) return;
      const targetId = item.dataset.hid;
      closeAllSheets();
      if (targetId !== state.activeHostId) {
        state.activeHostId = targetId;
        persistConfig();
        haptic("light");
        activateCurrentHost();
        const h = getActiveHost();
        if (h) showToast(`已切换到主机：${h.name}`);
      }
    });

    $("btn-host-sheet-add").addEventListener("click", openSettingsModal);

    // --- Conversation Search, Source Filter Bar & Foreground Visibility Sync ---
    $("conv-search").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderConvList();
    });

    $("conv-filter-bar")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      const nextFilter = btn.dataset.filter;
      if (!["all", "mobile", "desktop", "external"].includes(nextFilter)) return;
      if (nextFilter === "external" && !state.showExternalCli) return;
      if (nextFilter === state.filter) return;
      haptic("light");
      state.filter = nextFilter;
      persistConfig();
      syncFilterUi();
      refreshConversations();
    });

    // --- Host Pair Import Confirmation Dialog ---
    $("btn-pair-confirm-cancel")?.addEventListener("click", () => closePairConfirmDialog(true));
    $("btn-pair-confirm-ok")?.addEventListener("click", () => {
      const pending = _pendingPairConfirm;
      closePairConfirmDialog(false);
      if (pending) {
        applyConfirmedPair(pending.parsed, pending.opts);
      }
    });
    $("pair-confirm-dialog")?.addEventListener("click", (e) => {
      if (e.target === $("pair-confirm-dialog")) {
        closePairConfirmDialog(true);
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        syncOnForegroundResume();
      }
    });

    $("conv-list").addEventListener("click", (e) => {
      const item = e.target.closest(".conv-item");
      if (item && item.dataset.cid) openConversation(item.dataset.cid, { userPicked: true });
    });

    // --- Quick Suggestion Cards ---
    document.querySelectorAll(".quick-card").forEach((c) => {
      c.addEventListener("click", () => {
        state.sidecarUserPicked = true;
        $("prompt-input").value = c.dataset.prompt || "";
        updateSendButton();
        handleSendOrStop();
      });
    });

    // --- Composer Controls ---
    $("btn-swarm").addEventListener("click", () => {
      state.swarmMode = !state.swarmMode;
      const btn = $("btn-swarm");
      btn.classList.toggle("active", state.swarmMode);
      btn.setAttribute("aria-pressed", String(state.swarmMode));
      btn.querySelector(".swarm-ic-off")?.classList.toggle("hidden", state.swarmMode);
      btn.querySelector(".swarm-ic-on")?.classList.toggle("hidden", !state.swarmMode);
      haptic("light");
      showToast(state.swarmMode ? "已开启 /swarm 蜂群多智能体协作模式" : "已切回单 Agent 模式");
    });

    $("btn-attach").addEventListener("click", openAttachSheet);
    $("btn-attach-album")?.addEventListener("click", () => {
      haptic("light");
      closeAllSheets();
      $("gallery-input")?.click();
    });
    $("btn-attach-folder")?.addEventListener("click", () => {
      haptic("light");
      closeAllSheets();
      $("file-input")?.click();
    });
    $("btn-attach-confirm")?.addEventListener("click", confirmSelectedPhotos);

    $("attach-photo-strip")?.addEventListener("click", (e) => {
      const permBtn = e.target.closest("#btn-grant-media-perm, .photo-manage-tile");
      if (permBtn) {
        haptic("light");
        try {
          window.AndroidBridge?.requestMediaPermission?.();
        } catch (_) {}
        return;
      }
      const tile = e.target.closest(".photo-tile");
      if (!tile || !tile.dataset.pid) return;
      haptic("light");
      const pid = Number(tile.dataset.pid);
      const idx = state.selectedPhotoIds.indexOf(pid);
      if (idx === -1) {
        state.selectedPhotoIds.push(pid);
      } else {
        state.selectedPhotoIds.splice(idx, 1);
      }
      updateAttachSelectionUi();
    });

    $("gallery-input")?.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
      e.target.value = "";
    });
    $("file-input").addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
      e.target.value = "";
    });

    $("attach-tray").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-rm]");
      if (btn) {
        state.attachments.splice(Number(btn.dataset.rm), 1);
        renderAttachTray();
        saveCurrentDraft();
      }
    });

    const inp = $("prompt-input");
    inp.addEventListener("input", () => {
      resizePromptInput();
      saveCurrentDraft();
      updateSendButton();
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (window.innerWidth > 768 || Boolean(SIDECAR))) {
        e.preventDefault();
        handleSendOrStop();
      }
    });
    $("btn-send").addEventListener("click", handleSendOrStop);

    // --- Message Actions (Copy code, Copy reply, Preview file:///) ---
    $("messages-list").addEventListener("click", (e) => {
      const cpCode = e.target.closest(".code-copy-btn");
      if (cpCode) {
        bridgeCopyText(decodeURIComponent(cpCode.dataset.copy || ""));
        haptic("light");
        cpCode.textContent = "已复制";
        setTimeout(() => {
          cpCode.textContent = "复制";
        }, 1400);
        return;
      }

      const cpMsg = e.target.closest(".copy-msg");
      if (cpMsg) {
        bridgeCopyText(decodeURIComponent(cpMsg.dataset.raw || ""));
        haptic("light");
        showToast("已复制全文");
        return;
      }

      const attBtn = e.target.closest(".msg-att-btn");
      if (attBtn) {
        const fp = attBtn.dataset.path;
        if (fp) openFilePreview(fp, attBtn.dataset.name || fp.split("/").pop());
        return;
      }

      const fl = e.target.closest(".file-link");
      if (fl) {
        e.preventDefault();
        const fp = fl.dataset.filepath;
        if (fp) openFilePreview(fp, fp.split("/").pop());
      }
    });

    $("deliverables-list").addEventListener("click", (e) => {
      const chip = e.target.closest(".deliv-chip");
      if (chip) openFilePreview(chip.dataset.path, chip.dataset.name);
    });

    // --- Scroll State & Scroll FAB ---
    $("chat-scroll").addEventListener("scroll", () => {
      const el = $("chat-scroll");
      $("topbar").classList.toggle("scrolled", el.scrollTop > 6);
      const away = el.scrollHeight - el.scrollTop - el.clientHeight > 220;
      $("btn-scroll-bottom").classList.toggle("hidden", !away);
    });
    $("btn-scroll-bottom").addEventListener("click", () => scrollToBottom(true));

    // --- Unified Drawer Settings Entry & In-App Desktop Phone Pairing ---
    function openPairModal() {
      closeDrawer();
      const modal = $("pair-modal");
      const iframe = $("pair-iframe");
      if (!modal || !iframe) {
        window.open(withSidecarToken(`${location.origin}/pair`), "_blank", "noopener");
        return;
      }
      iframe.src = withSidecarToken(`${location.origin}/pair?_t=${Date.now()}`);
      modal.classList.remove("hidden");
    }
    $("nav-pair-qr")?.addEventListener("click", openPairModal);
    $("btn-top-pair")?.addEventListener("click", openPairModal);
    $("btn-settings-show-qr")?.addEventListener("click", () => {
      $("settings-modal")?.classList.add("hidden");
      openPairModal();
    });
    $("btn-pair-refresh")?.addEventListener("click", () => {
      const iframe = $("pair-iframe");
      if (iframe) iframe.src = withSidecarToken(`${location.origin}/pair?_t=${Date.now()}`);
    });
    $("btn-pair-external")?.addEventListener("click", () => {
      window.open(withSidecarToken(`${location.origin}/pair`), "_blank", "noopener");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const confirmDlg = $("pair-confirm-dialog");
        if (confirmDlg && !confirmDlg.classList.contains("hidden")) {
          closePairConfirmDialog(true);
          e.preventDefault();
          return;
        }
        for (const mid of ["preview-modal", "pair-modal", "usage-modal", "files-modal", "qqbot-modal", "settings-modal"]) {
          const el = $(mid);
          if (el && !el.classList.contains("hidden")) {
            el.classList.add("hidden");
            e.preventDefault();
            return;
          }
        }
      }
    });
    $("nav-usage")?.addEventListener("click", openUsageModal);
    $("nav-settings")?.addEventListener("click", openSettingsModal);
    $("btn-usage-refresh")?.addEventListener("click", loadUsageData);
    document.querySelectorAll("[data-usage-win]").forEach((btn) => {
      btn.addEventListener("click", () => {
        haptic("light");
        state.usageWindow = btn.dataset.usageWin || "5h";
        renderUsageView();
      });
    });

    // --- Desktop Drag & Drop Lossless File/Image Upload + Ctrl+V Paste ---
    const dropOverlay = $("drop-overlay");
    let dragDepth = 0;
    const hasFilesTransfer = (e) => {
      const types = e.dataTransfer && e.dataTransfer.types;
      if (!types) return false;
      return Array.from(types).includes("Files");
    };
    window.addEventListener("dragenter", (e) => {
      if (!hasFilesTransfer(e) || !getActiveHost()) return;
      e.preventDefault();
      dragDepth += 1;
      dropOverlay?.classList.remove("hidden");
    });
    window.addEventListener("dragover", (e) => {
      if (!hasFilesTransfer(e) || !getActiveHost()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFilesTransfer(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        dropOverlay?.classList.add("hidden");
      }
    });
    window.addEventListener("drop", (e) => {
      if (!hasFilesTransfer(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dropOverlay?.classList.add("hidden");
      if (!getActiveHost()) return;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        uploadFiles(files);
      }
    });

    document.addEventListener("paste", (e) => {
      if (!getActiveHost()) return;
      if ($("app")?.classList.contains("hidden")) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items || !items.length) return;
      const pastedFiles = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) {
            if (!f.name || f.name === "image.png") {
              const ext = (f.type && f.type.split("/")[1]) ? f.type.split("/")[1].replace("jpeg", "jpg") : "png";
              try {
                pastedFiles.push(new File([f], `clipboard_${Date.now()}.${ext}`, { type: f.type || "image/png" }));
              } catch (_) {
                pastedFiles.push(f);
              }
            } else {
              pastedFiles.push(f);
            }
          }
        }
      }
      if (pastedFiles.length) {
        e.preventDefault();
        uploadFiles(pastedFiles);
      }
    });

    $("settings-open-usage")?.addEventListener("click", openUsageModal);

    $("settings-open-files")?.addEventListener("click", () => {
      $("settings-modal").classList.add("hidden");
      $("files-modal").classList.remove("hidden");
      loadFilesDir(state.currentDir || state.workspaceRoot || "");
    });

    $("settings-open-qqbot")?.addEventListener("click", () => {
      $("settings-modal").classList.add("hidden");
      $("qqbot-modal").classList.remove("hidden");
      loadQqBotStatus();
    });

    $("settings-open-official")?.addEventListener("click", () => {
      $("settings-modal").classList.add("hidden");
      openOfficialRemote();
    });

    document.querySelectorAll(".dl-mode-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        haptic("light");
        state.downloadAskFolder = btn.dataset.dlMode === "ask";
        persistConfig();
        syncDownloadSettingsUi();
        showToast(state.downloadAskFolder ? "已开启：每次下载手动选择文件夹" : "已切回：固定下载目录");
      });
    });

    $("btn-save-dl-dir")?.addEventListener("click", () => {
      const inp = $("settings-dl-subdir");
      const clean = sanitizeSubdirInput(inp ? inp.value : "");
      state.downloadSubdir = clean;
      persistConfig();
      syncDownloadSettingsUi();
      haptic("success");
      showToast(clean ? `已保存下载目录：Download/${clean}/` : "已保存下载目录：Download/");
    });

    // --- Full-Screen Views Controls ---
    document.querySelectorAll(".close-modal").forEach((b) => {
      b.addEventListener("click", () => {
        const target = $(b.dataset.target);
        if (target) target.classList.add("hidden");
      });
    });

    $("btn-files-up").addEventListener("click", () => {
      const p = $("btn-files-up").dataset.parent;
      if (p) loadFilesDir(p);
    });

    $("files-list").addEventListener("click", (e) => {
      const row = e.target.closest(".file-row");
      if (!row) return;
      if (row.dataset.isdir === "1") loadFilesDir(row.dataset.path);
      else openFilePreview(row.dataset.path, row.dataset.name);
    });

    $("btn-preview-download").addEventListener("click", () => {
      if (state.previewFile) triggerDownload(state.previewFile.path, state.previewFile.name);
    });

    $("btn-qqbot-refresh").addEventListener("click", loadQqBotStatus);
    $("qqbot-body").addEventListener("click", async (e) => {
      const btn = e.target.closest(".qq-sw-btn");
      if (!btn) return;
      try {
        await apiFetch("/api/qqbot/switch-model", {
          method: "POST",
          body: JSON.stringify({ model: btn.dataset.qmodel, target: "group" }),
        });
        haptic("success");
        showToast(`QQ 群聊已切换为 ${shortModelLabel(btn.dataset.qmodel)}`);
        loadQqBotStatus();
      } catch (err) {
        showToast(`切换失败：${err.message}`);
      }
    });

    // --- Settings View ---
    document.querySelectorAll(".theme-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        haptic("light");
        applyTheme(btn.dataset.themeChoice, true);
      });
    });

    document.querySelectorAll(".ext-cli-opt[data-ext-cli]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextShow = btn.dataset.extCli === "on";
        haptic("light");
        state.showExternalCli = nextShow;
        if (!state.showExternalCli && state.filter === "external") {
          state.filter = "all";
        }
        persistConfig();
        syncFilterUi();
        refreshConversations();
        showToast(
          nextShow
            ? "已开启：侧栏可查看「外部/QQ」独立会话"
            : "已关闭：侧栏仅显示桌面端与手机/工作台会话"
        );
      });
    });

    document.querySelectorAll("[data-add-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.addTab;
        document.querySelectorAll("[data-add-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        $("add-tab-pin").classList.toggle("hidden", tab !== "pin");
        $("add-tab-uri").classList.toggle("hidden", tab !== "uri");
        $("add-tab-manual").classList.toggle("hidden", tab !== "manual");
        showBanner($("settings-add-msg"), "", "");
      });
    });

    $("btn-add-pin").addEventListener("click", () => {
      claimPinPair(
        $("add-pin-host").value,
        $("add-pin-code").value,
        $("settings-add-msg"),
        $("btn-add-pin")
      );
    });

    $("btn-add-uri").addEventListener("click", () => {
      handlePairUri($("add-uri-input").value, { bannerEl: $("settings-add-msg") });
    });

    $("btn-test-manual").addEventListener("click", () => {
      testConnectionDirect(
        $("add-manual-url").value,
        $("add-manual-token").value,
        $("settings-add-msg")
      );
    });

    $("btn-add-manual").addEventListener("click", () => {
      pairManual(
        $("add-manual-name").value,
        $("add-manual-url").value,
        $("add-manual-token").value,
        $("settings-add-msg"),
        $("btn-add-manual")
      );
    });

    $("settings-hosts-list").addEventListener("click", (e) => {
      const sw = e.target.closest(".host-switch-btn");
      if (sw && sw.dataset.hid) {
        state.activeHostId = sw.dataset.hid;
        persistConfig();
        haptic("light");
        $("settings-modal").classList.add("hidden");
        showWorkspaceScreen();
        activateCurrentHost();
        const h = getActiveHost();
        if (h) showToast(`已切换到：${h.name}`);
        return;
      }

      const tst = e.target.closest(".host-test-btn");
      if (tst && tst.dataset.hid) {
        const h = state.hosts.find((x) => x.id === tst.dataset.hid);
        if (h) testConnectionDirect(h.url, h.token, $("settings-hosts-msg"));
        return;
      }

      const del = e.target.closest(".host-del-btn");
      if (del && del.dataset.hid) {
        haptic("light");
        deleteHost(del.dataset.hid);
        showToast("已移除该主机");
      }
    });
  }

  // =========================================================================
  // 14. BOOTSTRAP
  // =========================================================================
  function checkInitialPairSources() {
    // 1. Native Android Deep Link intent (agylink://pair?...)
    try {
      const nativeUri = window.AndroidBridge?.getInitialPairUri?.();
      if (nativeUri && String(nativeUri).trim()) {
        handlePairUri(String(nativeUri), { source: "deeplink" });
        return false;
      }
    } catch (_) {}

    // Never auto-import hosts from URL query params on Desktop localhost workbench
    if (isLocalDesktopBrowser()) {
      return false;
    }

    // 2. Browser URL query (?pair=agylink://... or ?u=...&t=...)
    try {
      const qs = new URLSearchParams(location.search);
      const qPair = qs.get("pair");
      if (qPair) {
        if (history.replaceState) {
          history.replaceState(null, "", location.pathname);
        }
        handlePairUri(qPair, { source: "query" });
        return false;
      }
      if (qs.get("u") && qs.get("t")) {
        const hrefSnapshot = location.href;
        if (history.replaceState) {
          history.replaceState(null, "", location.pathname);
        }
        handlePairUri(hrefSnapshot, { source: "query" });
        return false;
      }
    } catch (_) {}

    return false;
  }

  function isLocalDesktopBrowser() {
    if (SIDECAR) return true;
    if (window.AndroidBridge) return false;
    if (location.protocol !== "http:") return false;
    const h = String(location.hostname || "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  }

  function isDesktopHostMode() {
    return Boolean(SIDECAR) || isLocalDesktopBrowser();
  }

  async function tryLocalAutoBootstrap() {
    if (!isDesktopHostMode()) return false;
    $("nav-pair-qr")?.classList.remove("hidden");
    $("btn-top-pair")?.classList.remove("hidden");
    try {
      const resp = await fetch("/api/local-auth", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (!data || !data.ok || !data.token) return false;
      const rawOrigin = (location.origin && location.origin !== "null")
        ? location.origin
        : `${location.protocol}//${location.host}`;
      const localUrl = normalizeServerUrl(rawOrigin);
      const localName = data.hostname ? `${data.hostname}（本机）` : "本机工作台";
      if (data.default_model && !state.hosts.length) {
        state.selectedModel = String(data.default_model);
        updateModelPill();
      }
      upsertHost({ name: localName, url: localUrl, token: data.token }, true);
      showWorkspaceScreen();
      activateCurrentHost();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function boot() {
    const isDesktopHost = isDesktopHostMode();
    if (isDesktopHost) {
      document.body.classList.add("desktop-host-mode");
    }
    if (SIDECAR) {
      document.body.classList.add(
        "agy-sidecar-mode",
        SIDECAR.view === "sidebar" ? "agy-sidecar-sidebar" : "agy-sidecar-auxpane"
      );
    }
    const hadSavedCfg = (() => {
      try {
        return Boolean(localStorage.getItem(CONFIG_STORAGE_KEY));
      } catch (_) {
        return false;
      }
    })();
    loadConfig();
    if (SIDECAR) {
      if (!hadSavedCfg) {
        state.themePref = "system";
      }
      document.documentElement.dataset.agyTheme = resolveSidecarHostTheme();
    } else if (isDesktopHost && !hadSavedCfg && state.themePref === "light") {
      state.themePref = "dark";
    }
    applyTheme(state.themePref, false);
    syncFilterUi();
    updateModelPill();
    bindEvents();
    updateSidecarHeaderActions();

    const wantPairOpen = (() => {
      try {
        const qs = new URLSearchParams(location.search);
        if (qs.get("open") === "pair") {
          qs.delete("open");
          const cleanQs = qs.toString();
          if (history.replaceState) {
            history.replaceState(null, "", location.pathname + (cleanQs ? `?${cleanQs}` : ""));
          }
          return true;
        }
      } catch (_) {}
      return false;
    })();

    if (isDesktopHost) {
      $("nav-pair-qr")?.classList.remove("hidden");
      $("btn-top-pair")?.classList.remove("hidden");
    }

    const pairedFromLaunch = checkInitialPairSources();
    if (!pairedFromLaunch) {
      if (isDesktopHost) {
        let autoOk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          autoOk = await tryLocalAutoBootstrap();
          if (autoOk) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (autoOk) {
          if (wantPairOpen) $("btn-top-pair")?.click();
          return;
        }
        // Host PC must NEVER show the phone "scan PC QR" welcome screen
        showWorkspaceScreen();
        setConnState("offline", "本机服务连接中，请刷新或重启工作台");
        return;
      }
      if (getActiveHost()) {
        showWorkspaceScreen();
        activateCurrentHost();
      } else {
        showWelcomeScreen();
      }
    }
  }

  boot();
})();
