(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CONFIG_STORAGE_KEY = "agy_mobile_config_v2";
  const DRAFTS_STORAGE_KEY = "agy_mobile_drafts_v1";
  const NEW_DRAFT_KEY = "__new__";
  const DEFAULT_MODEL = "gemini-4-neon-medium";
  const SIDECAR = (window.__AGY_SIDECAR__ && window.__AGY_SIDECAR__.active) ? window.__AGY_SIDECAR__ : null;
  const SIDECAR_CID_RE = /^[A-Za-z0-9_-]{6,80}$/;

  const I18N = window.AGY_I18N || {
    t: (k) => k,
    setLang: () => "zh",
    applyDom: () => {},
    normalizePref: (p) => p || "auto",
    getPref: () => "auto",
    getLang: () => "zh",
    isEn: () => false,
    fmtTokens: (n) => String(Math.round(Number(n) || 0)),
    fmtResetLeft: (d, r, h) => (d > 0 ? `${d}d ${r}h` : `${Math.max(1, h)}h`),
  };
  const t = (key, vars) => I18N.t(key, vars);

  function formatHostDisplayName(rawName) {
    const s = String(rawName || "").trim();
    if (!s) return t("host.localWorkbench");
    if (I18N.isEn()) {
      if (s === "本机工作台") return t("host.localWorkbench");
      if (s.endsWith("（本机）")) {
        return t("host.localSuffix", { name: s.slice(0, -4) });
      }
    } else {
      if (s === "Local Workbench") return t("host.localWorkbench");
      if (s.endsWith(" (Local)")) {
        return t("host.localSuffix", { name: s.slice(0, -8) });
      }
    }
    return s;
  }

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
    langPref: I18N.getPref(), // "auto" | "zh" | "en"
    hosts: [],          // [{ id, name, url, token }]
    activeHostId: "",
    selectedModel: DEFAULT_MODEL,
    downloadSubdir: "Antigravity",
    downloadAskFolder: false,
    serverInfo: null,
    qqbotAvailable: false,
    workspaceRoot: "",
    sidecarAutoFollowed: false,
    sidecarAutoFollowInFlight: false,
    sidecarUserPicked: false,

    ws: null,
    wsConnected: false,
    connPhase: "connecting", // "connecting" | "online" | "reconnecting" | "offline"
    reconnectTimer: null,
    connectEpoch: 0,
    sseAbort: null,
    sidecarPollTimer: null,
    sidecarPollAbort: null,
    sidecarPollSeq: -1,
    sidecarPollEpoch: "",
    sidecarPollUnsupported: false,

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

    // Task 1-3: Authenticated media, instant bottom-snap, and Turn Navigator state
    turns: [],
    turnAnchorEls: [],
    activeTurnIndex: 0,
    turnNavOpen: false,
    turnNavFilter: "",
    mediaRenderGen: 0,
    bottomAnchorActive: false,
    bottomAnchorTimer: null,
    programmaticScrollAt: 0,

    // v1.7.0: Prompt queue & Context window state
    currentQueue: [],
    editingQueueItemId: "",
    editingQueueDraft: "",
    interruptPendingUntil: 0,
    currentContext: null,
    ctxPopoverOpen: false,
    ctxBreakdownOpen: false,
    ctxFetchSeq: 0,

    // v1.7.0 Feature 4: Live Swarm indicator & collapsible right drawer
    currentSwarmSummary: null,
    currentSwarm: null,
    swarmDrawerOpen: false,
    swarmTab: "overview",
    swarmBoardNewestFirst: true,
    swarmSelectedMember: "",
    swarmExpandedKeys: new Set(["goal", "running"]),
    swarmFetchSeq: 0,
    swarmPollTimer: null,
    swarmLoading: false,
    swarmLastError: "",
    swarmLastRenderFp: "",
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
    showToast(t("toast.useAndroidScan"));
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
        if (mid === "preview-modal") {
          closePreviewModal();
        } else {
          el.classList.add("hidden");
        }
        return true;
      }
    }
    if (state.ctxPopoverOpen) {
      closeContextPopover();
      return true;
    }
    if (state.turnNavOpen) {
      closeTurnNavigator();
      return true;
    }
    if (state.swarmDrawerOpen) {
      closeSwarmDrawer();
      return true;
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
        entry.reject(new Error(data?.error || t("err.uploadResp")));
        return;
      }
      entry.resolve(data);
    } catch (_) {
      entry.reject(new Error(t("err.uploadParse")));
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
    if (wLbl) wLbl.textContent = isDark ? t("welcome.themeDark") : t("welcome.themeLight");

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

  function applyLanguage(pref, opts = {}) {
    const { persist = false, notify = false, rerender = true } = opts || {};
    const valid = I18N.normalizePref(pref);
    state.langPref = valid;
    const resolved = I18N.setLang(valid, { persistFast: true, applyDom: true });

    document.querySelectorAll(".lang-opt").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.langChoice === valid);
    });
    const wLangLbl = $("welcome-lang-label");
    if (wLangLbl) wLangLbl.textContent = t("welcome.langChip");
    const wThemeLbl = $("welcome-theme-label");
    if (wThemeLbl) wThemeLbl.textContent = state.resolvedDark ? t("welcome.themeDark") : t("welcome.themeLight");

    if (persist) {
      persistConfig();
    }

    if (rerender) {
      updateHostDisplays();
      updateSendButton();
      updateSidecarHeaderActions();
      renderQueueTray();
      updateContextPill();
      updateSwarmTopbarPill();
      if (state.ctxPopoverOpen) {
        renderContextPopover();
      }
      if (state.swarmDrawerOpen) {
        state.swarmLastRenderFp = "";
        renderSwarmDrawer({ force: true });
      }
      if (activePreviewZoom) {
        activePreviewZoom.updateLabel();
      }
      renderConvList();
      renderHostSheetList();
      renderSettingsHosts();
      syncDownloadSettingsUi();
      if (state.currentConv) {
        renderConversation({ preserveScroll: true });
      } else {
        updateTurnTriggerUi();
      }
      if (state.usageData && !$("usage-modal")?.classList.contains("hidden")) {
        const sub = $("usage-subtitle");
        if (sub) {
          const cnt = Number(state.usageData.scanned_conversations || 0);
          const tStr = fmtLocalTime(state.usageData.generated_at);
          sub.textContent = t("usage.subScanned", { cnt, time: tStr || t("usage.justNow") });
        }
        renderUsageView();
      }
      if (!$("attach-sheet")?.classList.contains("hidden")) {
        loadRecentPhotosInSheet(false);
        updateAttachSelectionUi();
      }
      if (!$("model-sheet")?.classList.contains("hidden")) {
        openModelSheet();
      }
    }

    if (notify) {
      if (valid === "auto") {
        showToast(resolved === "en" ? t("toast.langSwitchedAutoEn") : t("toast.langSwitchedAutoZh"));
      } else {
        showToast(resolved === "en" ? t("toast.langSwitchedEn") : t("toast.langSwitchedZh"));
      }
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
    window.addEventListener("agy-sidecar-conversation", (ev) => {
      const nextCid = ev && ev.detail && ev.detail.conversationId ? String(ev.detail.conversationId).trim() : "";
      if (!SIDECAR_CID_RE.test(nextCid)) return;
      updateSidecarHeaderActions();
      if (
        !state.sidecarUserPicked &&
        !state.streaming &&
        !String(state.currentCid || "").startsWith("pending-") &&
        nextCid !== state.currentCid &&
        getActiveHost()
      ) {
        maybeAutoFollowSidecarConversation({ forceSwitch: true });
      }
    });
    window.addEventListener("pagehide", () => {
      disconnectWs();
    });
    window.addEventListener("beforeunload", () => {
      disconnectWs();
    });
  }

  window.addEventListener("pagehide", () => {
    clearAuthMediaCache();
  });
  window.addEventListener("beforeunload", () => {
    clearAuthMediaCache();
  });

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
        const seenUrls = new Set();
        state.hosts = [];
        for (const h of parsed.hosts) {
          if (!h || !h.url) continue;
          const rawUrl = String(h.url).trim();
          if (rawUrl.toLowerCase() === "http://same-origin") continue;
          const normUrl = (SIDECAR && rawUrl === "same-origin") ? "same-origin" : normalizeServerUrl(rawUrl);
          if (!normUrl) continue;
          const key = normUrl.toLowerCase();
          if (seenUrls.has(key)) continue;
          seenUrls.add(key);
          state.hosts.push({
            id: String(h.id || makeHostId()),
            name: String(h.name || (normUrl === "same-origin" ? t("host.localWorkbench") : hostDisplayFallback(normUrl))).trim(),
            url: normUrl,
            token: String(h.token || "").trim(),
          });
        }
        state.activeHostId = String(parsed.activeHostId || (state.hosts[0] ? state.hosts[0].id : ""));
      } else if (parsed.serverUrl) {
        const url = normalizeServerUrl(parsed.serverUrl);
        const id = makeHostId();
        state.hosts = [{ id, name: hostDisplayFallback(url), url, token: String(parsed.token || "").trim() }];
        state.activeHostId = id;
      }

      if (parsed.theme) state.themePref = parsed.theme;
      if (parsed.lang) state.langPref = I18N.normalizePref(parsed.lang);
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

    // Optional URL theme / lang override (?theme=dark&lang=en) for quick testing
    try {
      const qs = new URLSearchParams(location.search);
      const qTheme = qs.get("theme");
      if (qTheme === "dark" || qTheme === "light" || qTheme === "system") {
        state.themePref = qTheme;
      }
      const qLang = qs.get("lang");
      if (qLang) {
        state.langPref = I18N.normalizePref(qLang);
      }
    } catch (_) {}
  }

  function persistConfig() {
    const payload = {
      version: 2,
      theme: state.themePref,
      lang: state.langPref,
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

  function getApiBase(host) {
    if (SIDECAR) return "";
    return String((host && host.url) || "");
  }

  function upsertHost({ name, url, token }, activate = true) {
    const normUrl = (SIDECAR && url === "same-origin") ? "same-origin" : normalizeServerUrl(url);
    const cleanTok = String(token || "").trim();
    const cleanName = String(name || "").trim() || (normUrl === "same-origin" ? t("host.localWorkbench") : hostDisplayFallback(normUrl));

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
        throw new Error(t("err.pairTimeout"));
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
      showBanner(bannerEl, "err", t("toast.enterHost"));
      return false;
    }
    if (!/^\d{6}$/.test(pin)) {
      showBanner(bannerEl, "err", t("toast.enterPin"));
      return false;
    }

    if (btnEl) btnEl.disabled = true;
    showBanner(bannerEl, "info", t("toast.verifyingPin"));
    try {
      const resp = await fetchWithTimeout(`${url}/api/pair/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      }, 8000);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false || !data.token) {
        const reason = data.error || (resp.status === 429 ? t("err.pairRateLimit") : resp.status === 401 || resp.status === 403 ? t("err.pairBadPin") : `HTTP ${resp.status}`);
        throw new Error(reason);
      }

      if (data.default_model) {
        state.selectedModel = String(data.default_model);
        updateModelPill();
      }
      const host = upsertHost({ name: data.hostname || hostDisplayFallback(url), url, token: data.token }, true);
      showBanner(bannerEl, "ok", t("toast.pairOk", { name: formatHostDisplayName(host.name) }));
      haptic("success");
      showToast(t("toast.pairedAndConnected", { name: formatHostDisplayName(host.name) }));
      $("settings-modal").classList.add("hidden");
      showWorkspaceScreen();
      activateCurrentHost();
      return true;
    } catch (err) {
      showBanner(bannerEl, "err", t("toast.pairFail", { err: err.message || t("err.unreachable") }));
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
        showBanner(prev.opts.bannerEl, "info", t("toast.importCancelled"));
      } else {
        showToast(t("toast.importCancelled"));
      }
    }
  }

  function applyConfirmedPair(parsed, opts = {}) {
    const host = upsertHost(parsed, true);
    haptic("success");
    const dispName = formatHostDisplayName(host.name);
    if (opts.bannerEl) showBanner(opts.bannerEl, "ok", t("toast.importedHost", { name: dispName }));
    $("settings-modal").classList.add("hidden");
    showWorkspaceScreen();
    activateCurrentHost();
    showToast(t("toast.pairedColon", { name: dispName }));
    return true;
  }

  function promptPairConfirm(parsed, opts = {}) {
    const dlg = $("pair-confirm-dialog");
    const displayName = parsed.name || hostDisplayFallback(parsed.url);
    if (!dlg) {
      const ok = window.confirm(t("toast.confirmImportNative", { name: displayName, url: parsed.url }));
      if (!ok) {
        showToast(t("toast.importCancelled"));
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
            showToast(t("toast.detectedHostEnterPin"));
            return false;
          }
        } catch (_) {}
      }
      if (opts.bannerEl) {
        showBanner(opts.bannerEl, "err", t("toast.invalidPairUri"));
      } else if (opts.source === "deeplink" || opts.source === "qr") {
        showToast(t("toast.invalidQr"));
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
      showBanner(bannerEl, "err", t("toast.fillUrlToken"));
      return false;
    }

    if (btnEl) btnEl.disabled = true;
    showBanner(bannerEl, "info", t("toast.verifyingHost"));
    try {
      const resp = await fetchWithTimeout(`${url}/api/server-info`, {
        headers: { Authorization: `Bearer ${token}` },
      }, 8000);
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) throw new Error(t("err.token401"));
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);

      const name = String(rawName || "").trim() || data.hostname || hostDisplayFallback(url);
      if (data.default_model) {
        state.selectedModel = String(data.default_model);
        updateModelPill();
      }
      const host = upsertHost({ name, url, token }, true);
      const dispName = formatHostDisplayName(host.name);
      haptic("success");
      showBanner(bannerEl, "ok", t("toast.connectOk", { name: dispName }));
      $("settings-modal").classList.add("hidden");
      showWorkspaceScreen();
      activateCurrentHost();
      showToast(t("toast.connectedTo", { name: dispName }));
      return true;
    } catch (err) {
      showBanner(bannerEl, "err", t("toast.connectFail", { err: err.message || t("err.netUnreachable") }));
      return false;
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function testConnectionDirect(rawUrl, rawToken, bannerEl) {
    const url = normalizeServerUrl(rawUrl);
    const token = String(rawToken || "").trim();
    if (!url) {
      showBanner(bannerEl, "err", t("toast.enterUrlFirst"));
      return;
    }
    showBanner(bannerEl, "info", t("toast.testingConn"));
    try {
      const resp = await fetchWithTimeout(`${url}/api/server-info`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }, 8000);
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) throw new Error(t("err.serverReachable401"));
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
      showBanner(
        bannerEl,
        "ok",
        t("toast.testOk", {
          host: data.hostname || hostDisplayFallback(url),
          cli: data.agy_cli_ready ? t("toast.cliReady") : t("toast.cliMissing"),
        })
      );
    } catch (err) {
      showBanner(bannerEl, "err", t("toast.testFail", { err: err.message || t("err.cannotAccess") }));
    }
  }

  // =========================================================================
  // 6. API CLIENT & WEBSOCKET CONNECTION
  // =========================================================================
  async function apiFetch(path, opts = {}) {
    const host = getActiveHost();
    if (!host || (!SIDECAR && !host.url)) throw new Error(t("err.noHost"));
    const headers = Object.assign({}, opts.headers || {});
    if (host.token) headers["Authorization"] = `Bearer ${host.token}`;
    if (opts.body && !(opts.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const fetchOpts = Object.assign({}, opts, { headers });
    delete fetchOpts.timeoutMs;
    const isLongOp = opts.body instanceof FormData || path === "/api/chat/send";
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : (isLongOp ? 120000 : 15000);
    let ctrl = null;
    let timer = null;
    if (!fetchOpts.signal && typeof AbortController !== "undefined") {
      ctrl = new AbortController();
      fetchOpts.signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
    }
    let resp;
    try {
      resp = await fetch(`${getApiBase(host)}${path}`, fetchOpts);
    } catch (err) {
      if (err && err.name === "AbortError" && ctrl) {
        throw new Error(t("err.reqTimeout"));
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (resp.status === 401) {
      setConnState("offline", t("conn.tokenInvalid"));
      throw new Error(t("err.auth401"));
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
    const label = host ? formatHostDisplayName(host.name) : (isDesktopHost ? t("host.localHost") : t("err.noHost"));
    const sub = isDesktopHost
      ? (state.wsConnected ? t("host.localOnlineDrawer") : t("host.localConnectingDrawer"))
      : (host ? host.url.replace(/^https?:\/\//i, "") : t("host.tapAddHost"));
    const dName = $("drawer-host-name");
    const dUrl = $("drawer-host-url");
    const eName = $("empty-host-name");
    if (dName) dName.textContent = label;
    if (dUrl) dUrl.textContent = sub;
    if (eName) {
      eName.textContent = isDesktopHost
        ? (state.wsConnected ? t("host.localOnlineChip", { label }) : t("host.localConnectingChip"))
        : (state.wsConnected ? t("host.connectedChip", { label }) : label);
    }
  }

  let _refreshConvsTimer = null;
  let _lastRefreshConvsAt = 0;
  let _lastResumeSyncAt = 0;

  function disconnectWs(opts = {}) {
    const { preservePollCursor = false } = opts || {};
    state.connectEpoch += 1;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    clearTimeout(state.sidecarPollTimer);
    state.sidecarPollTimer = null;
    clearTimeout(_refreshConvsTimer);
    _refreshConvsTimer = null;
    if (state.sidecarPollAbort) {
      try {
        state.sidecarPollAbort.abort();
      } catch (_) {}
      state.sidecarPollAbort = null;
    }
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
    if (!preservePollCursor) {
      state.sidecarPollSeq = -1;
      state.sidecarPollEpoch = "";
      state.wsConnected = false;
    }
  }

  function pauseSidecarTransportForHidden() {
    if (!SIDECAR) return;
    disconnectWs({ preservePollCursor: true });
  }

  function syncOnForegroundResume() {
    if (!getActiveHost()) return;
    const now = Date.now();
    if (now - _lastResumeSyncAt < 600) return;
    _lastResumeSyncAt = now;
    if (SIDECAR) {
      const transportIdle = !state.sidecarPollTimer && !state.sidecarPollAbort && !state.sseAbort;
      if (!state.wsConnected || transportIdle) {
        connectWs({ preservePollCursor: true });
      }
    } else if (!state.wsConnected) {
      const rs = state.ws ? state.ws.readyState : WebSocket.CLOSED;
      if (rs === WebSocket.CLOSED || rs === WebSocket.CLOSING) {
        connectWs();
      }
    }
    refreshConversationsThrottled(500);
    if (state.currentCid && !state.streaming) {
      openConversation(state.currentCid, { silent: true });
    } else if (SIDECAR && !state.currentConv && !state.streaming) {
      maybeAutoFollowSidecarConversation();
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
    clearAuthMediaCache();
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
    stopSwarmPolling();
    destroyPreviewZoom();
    disarmBottomAnchor();
    state.openConvSeq += 1;
    state.lastRenderedConvFp = "";
    state.currentCid = "";
    state.currentConv = null;
    state.currentQueue = [];
    state.editingQueueItemId = "";
    state.editingQueueDraft = "";
    state.interruptPendingUntil = 0;
    state.currentContext = null;
    state.ctxBreakdownOpen = false;
    state.ctxFetchSeq += 1;
    state.currentSwarmSummary = null;
    state.currentSwarm = null;
    state.swarmSelectedMember = "";
    state.swarmLastRenderFp = "";
    state.swarmLastError = "";
    state.swarmFetchSeq += 1;
    state.conversations = [];
    state.streaming = false;
    state.streamBuffer = "";
    state.streamTools = [];
    state.serverInfo = null;
    state.qqbotAvailable = false;
    state.workspaceRoot = "";
    state.currentDir = "";
    state.connPhase = "connecting";
    state.hostActivatedAt = Date.now();
    state.sidecarAutoFollowed = false;
    state.sidecarAutoFollowInFlight = false;
    state.sidecarUserPicked = false;
    $("settings-open-qqbot")?.classList.add("hidden");

    restoreDraftFor(NEW_DRAFT_KEY);
    updateHostDisplays();
    updateSidecarHeaderActions();
    renderQueueTray();
    updateContextPill();
    updateSwarmTopbarPill();
    renderConversation();
    renderConvList();
    // Kick off HTTP bootstrap + active host-conversation auto-follow immediately in parallel
    fetchServerInfo();
    refreshConversations();
    loadModels();
    maybeAutoFollowSidecarConversation();
    connectWs();
  }

  async function connectSidecarPoll(host, epoch) {
    if (epoch !== state.connectEpoch) return;
    if (!state.wsConnected && state.connPhase === "connecting") {
      setConnState("connecting", t("conn.connecting", { name: formatHostDisplayName(host.name) }));
    }

    const runTick = async () => {
      if (epoch !== state.connectEpoch) return;
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      state.sidecarPollAbort = ctrl;
      const timeoutId = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
      let nextDelayMs = state.streaming ? 150 : 1200;
      let stopPolling = false;
      try {
        const sinceParam = state.sidecarPollSeq >= 0 ? String(state.sidecarPollSeq) : "-1";
        const resp = await fetch(`/__sidecar/poll?since=${encodeURIComponent(sinceParam)}`, {
          method: "GET",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${host.token}`,
            Accept: "application/json",
          },
          signal: ctrl ? ctrl.signal : undefined,
        });
        if (epoch !== state.connectEpoch) {
          stopPolling = true;
          return;
        }
        if (resp.status === 404 || resp.status === 405) {
          // Running against an older sidecar without /__sidecar/poll: fall back cleanly to SSE
          stopPolling = true;
          state.sidecarPollUnsupported = true;
          connectSidecarSse(host, epoch);
          return;
        }
        if (resp.status === 401) {
          stopPolling = true;
          state.wsConnected = false;
          state.connPhase = "auth_error";
          updateHostDisplays();
          setConnState("offline", t("conn.tokenInvalid"));
          return;
        }
        if (!resp.ok) {
          throw new Error(`Poll HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (epoch !== state.connectEpoch) {
          stopPolling = true;
          return;
        }
        if (!data || data.ok === false) {
          throw new Error((data && data.error) || "Poll error");
        }

        if (data.connected) {
          const wasConnected = state.wsConnected;
          state.wsConnected = true;
          state.connPhase = "online";
          const nextEpoch = String(data.epoch || "");
          const epochChanged = Boolean(nextEpoch && state.sidecarPollEpoch && nextEpoch !== state.sidecarPollEpoch);
          if (nextEpoch) state.sidecarPollEpoch = nextEpoch;
          if (typeof data.seq === "number" && Number.isFinite(data.seq)) {
            state.sidecarPollSeq = data.seq;
          }

          if (!wasConnected) {
            updateHostDisplays();
            updateSendButton();
            const pastInitialBoot = Date.now() - (state.hostActivatedAt || 0) > 1500;
            if (pastInitialBoot) {
              if (!state.serverInfo) fetchServerInfo();
              if (!state.conversations.length) refreshConversations();
              if (!state.models.length) loadModels();
            }
            if (state.currentCid && !state.currentConv && !state.streaming && !state.sidecarAutoFollowInFlight) {
              openConversation(state.currentCid, { silent: true });
            } else if (!state.currentConv && !state.streaming) {
              maybeAutoFollowSidecarConversation();
            }
          }

          const evList = Array.isArray(data.events) ? data.events : [];
          for (const rawEv of evList) {
            try {
              const parsed = typeof rawEv === "string" ? JSON.parse(rawEv) : rawEv;
              if (parsed && typeof parsed === "object") {
                onWsEvent(parsed);
              }
            } catch (_) {}
          }

          if (data.reset || epochChanged) {
            refreshConversationsThrottled(400);
            if (state.currentCid && !state.streaming) {
              openConversation(state.currentCid, { silent: true });
            }
          }
          nextDelayMs = state.streaming ? 150 : 1200;
        } else {
          state.wsConnected = false;
          state.connPhase = "reconnecting";
          updateHostDisplays();
          updateSendButton();
          nextDelayMs = 2000;
        }
      } catch (_) {
        if (epoch !== state.connectEpoch) {
          stopPolling = true;
          return;
        }
        state.wsConnected = false;
        state.connPhase = "reconnecting";
        updateHostDisplays();
        updateSendButton();
        nextDelayMs = 2200;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (state.sidecarPollAbort === ctrl) state.sidecarPollAbort = null;
        if (!stopPolling && epoch === state.connectEpoch && !state.sidecarPollUnsupported && getActiveHost()) {
          if (document.visibilityState !== "hidden") {
            state.sidecarPollTimer = setTimeout(runTick, nextDelayMs);
          }
        }
      }
    };

    runTick();
  }

  async function connectSidecarSse(host, epoch) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    state.sseAbort = ctrl;
    let stopSseRetry = false;
    if (!state.wsConnected && state.connPhase === "connecting") {
      setConnState("connecting", t("conn.connecting", { name: formatHostDisplayName(host.name) }));
    }
    try {
      const resp = await fetch("/__sidecar/events", {
        method: "GET",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${host.token}`,
          Accept: "text/event-stream",
        },
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (epoch !== state.connectEpoch) {
        stopSseRetry = true;
        return;
      }
      if (resp.status === 401) {
        stopSseRetry = true;
        state.wsConnected = false;
        state.connPhase = "auth_error";
        updateHostDisplays();
        setConnState("offline", t("conn.tokenInvalid"));
        return;
      }
      if (!resp.ok || !resp.body || typeof resp.body.getReader !== "function") {
        throw new Error(`SSE HTTP ${resp.status}`);
      }

      state.wsConnected = true;
      state.connPhase = "online";
      updateHostDisplays();
      updateSendButton();
      const pastInitialBoot = Date.now() - (state.hostActivatedAt || 0) > 1500;
      if (pastInitialBoot) {
        if (!state.serverInfo) fetchServerInfo();
        if (!state.conversations.length) refreshConversations();
        if (!state.models.length) loadModels();
      }
      if (state.currentCid && !state.currentConv && !state.streaming && !state.sidecarAutoFollowInFlight) {
        openConversation(state.currentCid, { silent: true });
      } else if (!state.currentConv && !state.streaming) {
        maybeAutoFollowSidecarConversation();
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
      if (!stopSseRetry && epoch === state.connectEpoch) {
        state.wsConnected = false;
        state.connPhase = "reconnecting";
        updateHostDisplays();
        updateSendButton();
        if (getActiveHost() && document.visibilityState !== "hidden") {
          state.reconnectTimer = setTimeout(connectWs, 2500);
        }
      }
    }
  }

  function connectWs(opts = {}) {
    disconnectWs(opts);
    const host = getActiveHost();
    if (!host || (!SIDECAR && !host.url)) {
      state.connPhase = "offline";
      setConnState("offline", t("err.noHost"));
      return;
    }

    const epoch = state.connectEpoch;
    if (SIDECAR) {
      if (state.sidecarPollUnsupported) {
        connectSidecarSse(host, epoch);
      } else {
        connectSidecarPoll(host, epoch);
      }
      return;
    }

    const wsUrl = host.url.replace(/^http/i, "ws") + `/ws?token=${encodeURIComponent(host.token)}`;
    setConnState("connecting", t("conn.connecting", { name: formatHostDisplayName(host.name) }));

    try {
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        if (epoch !== state.connectEpoch) return;
        state.wsConnected = true;
        state.connPhase = "online";
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
        state.connPhase = "reconnecting";
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
        state.connPhase = "reconnecting";
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
            title: String(promptText || "").slice(0, 36) || t("chat.newConvTitle"),
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
        state.interruptPendingUntil = 0;
        if (Array.isArray(ev.queue)) {
          setCurrentQueue(ev.queue);
        }
        ensurePeerStreamAttached(ev.prompt, ev.attachments, ev.model);
        renderQueueTray();
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
        state.interruptPendingUntil = 0;
        state.streaming = false;
        if (ev.context_window && typeof ev.context_window === "object") {
          setCurrentContext(ev.context_window);
        }
        if (Array.isArray(ev.queue)) {
          setCurrentQueue(ev.queue);
        } else {
          renderQueueTray();
        }
        openConversation(state.currentCid, { silent: true });
      }
      refreshConversationsThrottled(400);
    } else if (ev.type === "run_canceled") {
      adoptPendingCid();
      const matchesCurrent =
        (cid && cid === state.currentCid) ||
        (ev.run_id && state.currentCid === `pending-${ev.run_id}`);
      if (matchesCurrent) {
        if (Array.isArray(ev.queue)) {
          setCurrentQueue(ev.queue);
        }
        const isCutinHandoff = Boolean(ev.interrupted || ev.reason === "interrupt" || Date.now() < state.interruptPendingUntil);
        if (isCutinHandoff) {
          state.streamBuffer = "";
          state.streamTools = [];
          updateStreamingRow();
        } else {
          state.streaming = false;
          renderConversation({ preserveScroll: true });
          renderQueueTray();
        }
      }
      refreshConversationsThrottled(400);
    } else if (ev.type === "run_error") {
      adoptPendingCid();
      const matchesCurrent =
        (cid && cid === state.currentCid) ||
        (ev.run_id && state.currentCid === `pending-${ev.run_id}`) ||
        (!state.currentCid && state.streaming);
      if (matchesCurrent) {
        state.interruptPendingUntil = 0;
        state.streaming = false;
        state.streamBuffer = "";
        state.streamTools = [];
        const errText = String(ev.error || t("err.unknown"));
        if (state.currentConv) {
          state.currentConv.messages.push({
            role: "assistant",
            text: t("chat.execError", { err: errText }),
            model: state.selectedModel,
          });
        }
        renderConversation({ preserveScroll: true });
        renderQueueTray();
        showToast(t("toast.execFail", { err: errText.slice(0, 80) }));
      }
      refreshConversationsThrottled(400);
    } else if (ev.type === "queue_updated") {
      const aliasedCid = ev.aliased_cid || "";
      const matchesCurrent = Boolean(state.currentCid) && (
        cid === state.currentCid || (aliasedCid && aliasedCid === state.currentCid)
      );
      if (matchesCurrent) {
        setCurrentQueue(Array.isArray(ev.queue) ? ev.queue : []);
      }
    } else if (ev.type === "tunnel_status" && ev.tunnel) {
      if (isLocalDesktopBrowser()) {
        const ts = String(ev.tunnel.status || "");
        if (ts === "reconnecting") {
          showToast(t("toast.tunnelDown"));
        } else if (ts === "online" && ev.tunnel.url) {
          showToast(t("toast.tunnelUp"));
        }
      }
    } else if (ev.type === "desktop_update") {
      const aliasedCid = ev.aliased_cid || "";
      const matchesCurrent = Boolean(state.currentCid) && (
        cid === state.currentCid || (aliasedCid && aliasedCid === state.currentCid)
      );
      if (matchesCurrent) {
        if (ev.context_window && typeof ev.context_window === "object") {
          setCurrentContext(ev.context_window);
        }
        if (!state.streaming) {
          openConversation(state.currentCid, { silent: true });
        }
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
              `<button class="code-copy-btn" type="button" data-copy="${encodeURIComponent(cb.code)}">${escHtml(t("chat.copyCode"))}</button></div>` +
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
    const btnCutin = $("btn-cutin");
    const btnQueue = $("btn-queue-send");
    const inp = $("prompt-input");
    const hasContent = Boolean((inp && inp.value.trim()) || state.attachments.length);
    const host = getActiveHost();

    if (state.streaming) {
      btn.classList.add("stopping");
      btn.classList.remove("ready");
      btn.classList.toggle("compact-stop", hasContent);
      btn.setAttribute("aria-label", t("chat.stopAria"));
      $("icon-send").classList.add("hidden");
      $("icon-stop").classList.remove("hidden");
      btnCutin?.classList.toggle("hidden", !hasContent);
      btnQueue?.classList.toggle("hidden", !hasContent);
      setConnState("running", t("conn.runningTask"));
    } else {
      btn.classList.remove("stopping", "compact-stop");
      btn.classList.toggle("ready", hasContent);
      btn.setAttribute("aria-label", t("chat.sendAria"));
      $("icon-send").classList.remove("hidden");
      $("icon-stop").classList.add("hidden");
      btnCutin?.classList.add("hidden");
      btnQueue?.classList.add("hidden");
      if (state.wsConnected) {
        const hostName = host ? formatHostDisplayName(host.name) : t("host.generic");
        setConnState("online", t("conn.connected", { name: hostName }));
      } else if (state.connPhase === "auth_error") {
        setConnState("offline", t("conn.tokenInvalid"));
      } else if (host && state.connPhase === "connecting") {
        setConnState("connecting", t("conn.connecting", { name: formatHostDisplayName(host.name) }));
      } else {
        setConnState("offline", host ? t("conn.reconnecting", { name: formatHostDisplayName(host.name) }) : t("conn.notConnected"));
      }
    }
  }

  // =========================================================================
  // 7.5 AUTHENTICATED MEDIA BLOB LOADER (Sidecar Header-Auth + Bounded LRU)
  // =========================================================================
  const MAX_AUTH_MEDIA_ENTRIES = 80;
  const MAX_AUTH_MEDIA_BYTES = 48 * 1024 * 1024;
  const MAX_AUTH_MEDIA_CONCURRENCY = 3;
  const authMediaCache = new Map(); // key -> { blobUrl, blob, size, dataUrl }
  const authMediaInflight = new Map(); // key -> Promise<entry>
  const authMediaControllers = new Set();
  const authMediaQueue = [];
  let authMediaBytes = 0;
  let authMediaActiveCount = 0;
  let mediaObserver = null;

  function buildPreviewApiPath(previewUrl, rawPath) {
    const pUrl = String(previewUrl || "").trim();
    if (pUrl.startsWith("/api/files/preview")) {
      return pUrl;
    }
    return `/api/files/preview?path=${encodeURIComponent(String(rawPath || ""))}`;
  }

  function buildDirectMediaUrl(host, apiPath) {
    if (!host || !apiPath) return "";
    const sep = apiPath.includes("?") ? "&" : "?";
    const tokPart = host.token ? `${sep}token=${encodeURIComponent(host.token)}` : "";
    return `${getApiBase(host)}${apiPath}${tokPart}`;
  }

  function makeMediaCacheKey(host, apiPath) {
    return `${host ? host.id : "nohost"}|${apiPath}`;
  }

  function touchAuthMediaEntry(cacheKey) {
    const entry = authMediaCache.get(cacheKey);
    if (!entry) return null;
    authMediaCache.delete(cacheKey);
    authMediaCache.set(cacheKey, entry);
    return entry;
  }

  function evictAuthMediaIfNeeded() {
    const previewModal = $("preview-modal");
    const previewOpen = Boolean(previewModal && !previewModal.classList.contains("hidden"));
    const activePreviewImg = previewOpen ? $("preview-body")?.querySelector("img[data-media-key]") : null;
    const protectedKey = activePreviewImg ? activePreviewImg.dataset.mediaKey : "";
    let guard = authMediaCache.size + 2;
    while ((authMediaCache.size > MAX_AUTH_MEDIA_ENTRIES || authMediaBytes > MAX_AUTH_MEDIA_BYTES) && guard-- > 0) {
      const oldestKey = authMediaCache.keys().next().value;
      if (!oldestKey) break;
      if (protectedKey && oldestKey === protectedKey && authMediaCache.size > 1) {
        touchAuthMediaEntry(oldestKey);
        continue;
      }
      const evicted = authMediaCache.get(oldestKey);
      authMediaCache.delete(oldestKey);
      if (evicted) {
        authMediaBytes = Math.max(0, authMediaBytes - (evicted.size || 0));
        // Detach any live DOM image referencing the evicted blob URL before revoking
        try {
          document.querySelectorAll("img[data-media-key]").forEach((img) => {
            if (img.dataset.mediaKey === oldestKey) {
              img.removeAttribute("src");
              img.dataset.mediaLoaded = "0";
              const thumb = img.closest(".msg-img-thumb");
              if (thumb) {
                thumb.classList.remove("img-loaded", "img-error");
                thumb.classList.add("img-loading");
              }
              if (mediaObserver && img.closest("#messages-list")) {
                mediaObserver.observe(img);
              }
            }
          });
        } catch (_) {}
        try {
          URL.revokeObjectURL(evicted.blobUrl);
        } catch (_) {}
      }
    }
  }

  function makeMediaAbortError() {
    const err = new Error("Media request aborted");
    err.name = "AbortError";
    return err;
  }

  function abortPendingMediaQueue(scope = "messages") {
    const matchAll = scope === "all";
    for (let i = authMediaQueue.length - 1; i >= 0; i--) {
      const job = authMediaQueue[i];
      if (!job || matchAll || job.scope === scope) {
        authMediaQueue.splice(i, 1);
        if (job) {
          job.cancelled = true;
          const inflightRec = authMediaInflight.get(job.cacheKey);
          if (inflightRec && inflightRec.job === job) {
            authMediaInflight.delete(job.cacheKey);
          }
          try {
            job.reject(makeMediaAbortError());
          } catch (_) {}
        }
      }
    }
    for (const rec of Array.from(authMediaControllers)) {
      if (matchAll || (rec.job && rec.job.scope === scope)) {
        if (rec.job) {
          rec.job.cancelled = true;
          const inflightRec = authMediaInflight.get(rec.job.cacheKey);
          if (inflightRec && inflightRec.job === rec.job) {
            authMediaInflight.delete(rec.job.cacheKey);
          }
        }
        authMediaControllers.delete(rec);
        try {
          rec.ctrl.abort();
        } catch (_) {}
      }
    }
    if (matchAll) {
      authMediaInflight.clear();
    }
  }

  function clearAuthMediaCache() {
    abortPendingMediaQueue("all");
    if (mediaObserver) {
      try {
        mediaObserver.disconnect();
      } catch (_) {}
    }
    for (const entry of authMediaCache.values()) {
      try {
        URL.revokeObjectURL(entry.blobUrl);
      } catch (_) {}
    }
    authMediaCache.clear();
    authMediaBytes = 0;
  }

  function pumpAuthMediaQueue() {
    while (authMediaActiveCount < MAX_AUTH_MEDIA_CONCURRENCY && authMediaQueue.length > 0) {
      const job = authMediaQueue.shift();
      if (!job || job.cancelled) continue;
      authMediaActiveCount += 1;
      runAuthMediaJob(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          authMediaActiveCount = Math.max(0, authMediaActiveCount - 1);
          pumpAuthMediaQueue();
        });
    }
  }

  async function runAuthMediaJob(job) {
    const { cacheKey, apiPath, host } = job;
    const cached = touchAuthMediaEntry(cacheKey);
    if (cached) return cached;

    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const ctrlRec = ctrl ? { ctrl, job } : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    if (ctrlRec) authMediaControllers.add(ctrlRec);
    try {
      const headers = {};
      if (host && host.token) {
        headers["Authorization"] = `Bearer ${host.token}`;
      }
      const resp = await fetch(`${getApiBase(host)}${apiPath}`, {
        method: "GET",
        headers,
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const ct = String(resp.headers.get("content-type") || "").toLowerCase();
      if (ct && !ct.startsWith("image/") && !ct.includes("octet-stream")) {
        throw new Error(`Unexpected media type: ${ct}`);
      }
      const blob = await resp.blob();
      if (!blob || blob.size === 0) {
        throw new Error("Empty media response");
      }
      const existing = touchAuthMediaEntry(cacheKey);
      if (existing) return existing;

      const blobUrl = URL.createObjectURL(blob);
      const entry = { blobUrl, blob, size: blob.size || 0, dataUrl: "" };
      authMediaCache.set(cacheKey, entry);
      authMediaBytes += entry.size;
      evictAuthMediaIfNeeded();
      return entry;
    } finally {
      if (timer) clearTimeout(timer);
      if (ctrlRec) authMediaControllers.delete(ctrlRec);
    }
  }

  function fetchAuthMediaEntry(apiPath, host, opts = {}) {
    const { priority = 1, forceReload = false, scope = "messages" } = opts || {};
    if (!host || !apiPath) {
      return Promise.reject(new Error("Missing host or media path"));
    }
    const cacheKey = makeMediaCacheKey(host, apiPath);
    if (!forceReload) {
      const cached = touchAuthMediaEntry(cacheKey);
      if (cached) return Promise.resolve(cached);
    }
    const existingRec = authMediaInflight.get(cacheKey);
    if (existingRec && existingRec.job && !existingRec.job.cancelled) {
      // Promote shared in-flight job to standalone + front-of-queue when lightbox/attach-tray awaits it
      if (scope === "standalone") {
        existingRec.job.scope = "standalone";
      }
      if (priority === 0) {
        const qIdx = authMediaQueue.indexOf(existingRec.job);
        if (qIdx > 0) {
          authMediaQueue.splice(qIdx, 1);
          authMediaQueue.unshift(existingRec.job);
        }
      }
      return existingRec.promise;
    }

    let jobRef = null;
    const promise = new Promise((resolve, reject) => {
      const job = { cacheKey, apiPath, host, priority, scope, cancelled: false, resolve, reject };
      jobRef = job;
      if (priority === 0) {
        authMediaQueue.unshift(job);
      } else {
        authMediaQueue.push(job);
      }
      pumpAuthMediaQueue();
    }).finally(() => {
      const cur = authMediaInflight.get(cacheKey);
      if (cur && cur.job === jobRef) {
        authMediaInflight.delete(cacheKey);
      }
    });

    authMediaInflight.set(cacheKey, { promise, job: jobRef });
    return promise;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      if (typeof FileReader === "undefined") {
        reject(new Error("FileReader unavailable"));
        return;
      }
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("Blob decode failed"));
      fr.readAsDataURL(blob);
    });
  }

  function markThumbState(imgEl, nextState) {
    const thumb = imgEl && imgEl.closest ? imgEl.closest(".msg-img-thumb") : null;
    if (!thumb) return;
    thumb.classList.toggle("img-loading", nextState === "loading");
    thumb.classList.toggle("img-loaded", nextState === "loaded");
    thumb.classList.toggle("img-error", nextState === "error");
  }

  function applyMediaEntryToImg(imgEl, entry, renderGen) {
    if (!imgEl || !imgEl.isConnected || (renderGen !== undefined && renderGen !== state.mediaRenderGen)) {
      return;
    }
    const targetUrl = entry.dataUrl || entry.blobUrl;
    if (imgEl.getAttribute("src") === targetUrl && imgEl.complete && imgEl.naturalWidth > 0) {
      imgEl.dataset.mediaLoaded = "1";
      markThumbState(imgEl, "loaded");
      return;
    }
    imgEl.dataset.mediaLoaded = "1";
    imgEl.onload = () => {
      if (renderGen !== undefined && renderGen !== state.mediaRenderGen) return;
      markThumbState(imgEl, "loaded");
      snapBottomIfAnchored();
    };
    imgEl.onerror = async () => {
      if (renderGen !== undefined && renderGen !== state.mediaRenderGen) return;
      // Bulletproof fallback: if a strict host CSP blocks blob: img-src, upgrade once to data: URL
      if (!imgEl.dataset.dataUrlFallback && entry.blob && entry.blob.size <= 10 * 1024 * 1024) {
        imgEl.dataset.dataUrlFallback = "1";
        try {
          if (!entry.dataUrl) {
            entry.dataUrl = await blobToDataUrl(entry.blob);
          }
          if (entry.dataUrl && imgEl.isConnected && (renderGen === undefined || renderGen === state.mediaRenderGen)) {
            imgEl.src = entry.dataUrl;
            return;
          }
        } catch (_) {}
      }
      imgEl.dataset.mediaLoaded = "0";
      markThumbState(imgEl, "error");
    };
    imgEl.src = targetUrl;
  }

  async function loadThumbImgViaAuthFetch(imgEl, renderGen, opts = {}) {
    const { priority = 0, allowRetry = true, forceReload = false, scope = "messages" } = opts || {};
    if (!imgEl || !imgEl.isConnected) return;
    if (renderGen !== undefined && renderGen !== state.mediaRenderGen) return;
    if (!forceReload && (imgEl.dataset.mediaLoaded === "1" || imgEl.dataset.mediaFetching === "1")) {
      return;
    }
    const apiPath = imgEl.dataset.mediaPath || "";
    const host = getActiveHost();
    if (!apiPath || !host) {
      markThumbState(imgEl, "error");
      return;
    }
    imgEl.dataset.mediaFetching = "1";
    markThumbState(imgEl, "loading");
    try {
      const entry = await fetchAuthMediaEntry(apiPath, host, { priority, forceReload, scope });
      if (!imgEl.isConnected || (renderGen !== undefined && renderGen !== state.mediaRenderGen)) {
        return;
      }
      applyMediaEntryToImg(imgEl, entry, renderGen);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (!imgEl.isConnected || (renderGen !== undefined && renderGen !== state.mediaRenderGen)) {
        return;
      }
      if (allowRetry) {
        setTimeout(() => {
          if (imgEl.isConnected && (renderGen === undefined || renderGen === state.mediaRenderGen)) {
            imgEl.dataset.mediaFetching = "0";
            loadThumbImgViaAuthFetch(imgEl, renderGen, { priority: 0, allowRetry: false, forceReload: true, scope });
          }
        }, 650);
      } else {
        markThumbState(imgEl, "error");
      }
    } finally {
      imgEl.dataset.mediaFetching = "0";
    }
  }

  function ensureMediaObserver() {
    if (mediaObserver || typeof IntersectionObserver !== "function") return mediaObserver;
    const scrollEl = $("chat-scroll");
    mediaObserver = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          const img = ent.target;
          mediaObserver.unobserve(img);
          const gen = Number(img.dataset.mediaGen || 0);
          if (gen === state.mediaRenderGen) {
            loadThumbImgViaAuthFetch(img, gen, { priority: 0 });
          }
        }
      },
      {
        root: scrollEl || null,
        rootMargin: "1000px 0px 1000px 0px",
        threshold: 0.01,
      }
    );
    return mediaObserver;
  }

  function hydrateMessageImages(container, renderGen) {
    if (!container) return;
    const imgs = Array.from(container.querySelectorAll("img[data-media-path]"));
    if (!imgs.length) return;
    const host = getActiveHost();
    if (!host) return;

    if (SIDECAR) {
      const obs = ensureMediaObserver();
      // Prioritize bottom 16 images immediately, then gently pre-hydrate up to bounded cache budget
      const eagerStartIdx = Math.max(0, imgs.length - 16);
      const bgStartIdx = Math.max(0, imgs.length - Math.max(16, MAX_AUTH_MEDIA_ENTRIES - 8));
      const eagerImgs = [];
      const bgImgs = [];
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        const apiPath = img.dataset.mediaPath || "";
        const cacheKey = makeMediaCacheKey(host, apiPath);
        img.dataset.mediaKey = cacheKey;
        img.dataset.mediaGen = String(renderGen);
        const cached = touchAuthMediaEntry(cacheKey);
        if (cached) {
          applyMediaEntryToImg(img, cached, renderGen);
          continue;
        }
        if (i >= eagerStartIdx) {
          eagerImgs.push(img);
        } else {
          if (obs) obs.observe(img);
          if (i >= bgStartIdx) bgImgs.push(img);
        }
      }
      for (let i = eagerImgs.length - 1; i >= 0; i--) {
        loadThumbImgViaAuthFetch(eagerImgs[i], renderGen, { priority: 1 });
      }
      for (let i = bgImgs.length - 1; i >= 0; i--) {
        loadThumbImgViaAuthFetch(bgImgs[i], renderGen, { priority: 2 });
      }
    } else {
      // Non-sidecar Mobile/Browser mode: attach onload anchor-snap & auth-fetch fallback on error
      for (const img of imgs) {
        img.dataset.mediaGen = String(renderGen);
        if (img.complete && img.naturalWidth > 0) {
          markThumbState(img, "loaded");
          continue;
        }
        img.addEventListener("load", () => {
          if (renderGen !== state.mediaRenderGen) return;
          markThumbState(img, "loaded");
          snapBottomIfAnchored();
        }, { once: true });
        img.addEventListener("error", () => {
          if (renderGen !== state.mediaRenderGen) return;
          if (!img.dataset.authFallbackTried) {
            img.dataset.authFallbackTried = "1";
            loadThumbImgViaAuthFetch(img, renderGen, { priority: 0, allowRetry: false });
          } else {
            markThumbState(img, "error");
          }
        }, { once: true });
      }
    }
  }

  // =========================================================================
  // 7.6 INSTANT BOTTOM-SNAP & BOTTOM-ANCHOR GUARD
  // =========================================================================
  function disarmBottomAnchor() {
    state.bottomAnchorActive = false;
    if (state.bottomAnchorTimer) {
      clearTimeout(state.bottomAnchorTimer);
      state.bottomAnchorTimer = null;
    }
  }

  function activateBottomAnchorGuard(durationMs = 3000) {
    disarmBottomAnchor();
    state.bottomAnchorActive = true;
    state.bottomAnchorTimer = setTimeout(() => {
      state.bottomAnchorActive = false;
      state.bottomAnchorTimer = null;
    }, durationMs);
  }

  function scrollToBottomInstant() {
    const el = $("chat-scroll");
    if (!el) return;
    state.programmaticScrollAt = Date.now();
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
    if (typeof el.scrollTo === "function") {
      try {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      } catch (_) {
        el.scrollTop = el.scrollHeight;
      }
    }
    $("btn-scroll-bottom")?.classList.add("hidden");
  }

  function snapBottomIfAnchored() {
    if (!state.bottomAnchorActive) return;
    scrollToBottomInstant();
    updateActiveTurnFromScroll();
  }

  function smoothScrollToPosition(el, targetTop) {
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const clampedTarget = Math.max(0, Math.min(maxScroll, Math.round(targetTop)));
    const delta = clampedTarget - el.scrollTop;
    const MAX_SMOOTH_HOP = 2200;
    const PRE_HOP_OFFSET = 460;
    if (Math.abs(delta) > MAX_SMOOTH_HOP) {
      // Pre-position instantaneously near destination so 80-turn jumps glide smoothly without multi-second blur
      el.style.scrollBehavior = "auto";
      el.scrollTop = delta > 0
        ? Math.max(0, clampedTarget - PRE_HOP_OFFSET)
        : Math.min(maxScroll, clampedTarget + PRE_HOP_OFFSET);
    }
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: clampedTarget, behavior: "smooth" });
    } else {
      el.scrollTop = clampedTarget;
    }
  }

  function scrollToBottom(force = false, opts = {}) {
    const { smooth = false } = opts || {};
    const el = $("chat-scroll");
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (!force && !nearBottom) return;
    if (smooth) {
      disarmBottomAnchor();
      smoothScrollToPosition(el, el.scrollHeight);
      return;
    }
    scrollToBottomInstant();
  }

  // =========================================================================
  // 7.7 CONVERSATION TURN GROUPING & EXPANDABLE TURN NAVIGATOR
  // =========================================================================
  const TURN_IMG_ICON_SVG = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;

  function fmtTurnTime(isoStr) {
    if (!isoStr) return "";
    try {
      const normalized = String(isoStr).trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");
      const d = new Date(normalized);
      if (isNaN(d.getTime())) return "";
      const now = new Date();
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (sameDay) return `${hh}:${mm}`;
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const da = String(d.getDate()).padStart(2, "0");
      return `${mo}-${da} ${hh}:${mm}`;
    } catch (_) {
      return "";
    }
  }

  function makeTurnPreviewText(msg, turnIndex) {
    const raw = String((msg && msg.text) || "")
      .replace(/```[\s\S]*?```/g, t("turnNav.codeStub"))
      .replace(/[#*_`>~]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const atts = Array.isArray(msg && msg.attachments) ? msg.attachments : [];
    const imageCount = atts.filter((a) => a && a.is_image).length;
    const fileCount = atts.filter((a) => a && !a.is_image).length;
    let preview = raw;
    if (!preview) {
      if (imageCount > 0 && fileCount > 0) {
        preview = t("turnNav.mediaBoth", { img: imageCount, file: fileCount });
      } else if (imageCount > 0) {
        preview = imageCount > 1 ? t("turnNav.mediaImgMany", { img: imageCount }) : t("turnNav.mediaImgOne");
      } else if (fileCount > 0) {
        preview = fileCount > 1 ? t("turnNav.mediaFileMany", { file: fileCount }) : t("turnNav.mediaFileOne");
      } else {
        preview = t("turnNav.turnFallback", { idx: turnIndex });
      }
    } else if (preview.length > 96) {
      preview = `${preview.slice(0, 96)}…`;
    }
    const attNames = atts.map((a) => (a && a.name ? String(a.name) : "")).join(" ");
    return {
      preview,
      imageCount,
      fileCount,
      searchText: `${turnIndex} #${turnIndex} 第${turnIndex}轮 turn ${turnIndex} ${raw} ${preview} ${attNames}`.toLowerCase(),
    };
  }

  function buildConversationTurns(messages) {
    const turns = [];
    const msgIndexToTurnIndex = new Map();
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const msg = list[i];
      if (!msg) continue;
      if (msg.role === "user" || turns.length === 0) {
        const turnIndex = turns.length + 1;
        const meta = makeTurnPreviewText(msg, turnIndex);
        turns.push({
          index: turnIndex,
          msgIndex: i,
          role: msg.role === "user" ? "user" : "assistant",
          preview: meta.preview,
          imageCount: meta.imageCount,
          fileCount: meta.fileCount,
          time: msg.time || "",
          timeLabel: fmtTurnTime(msg.time),
          searchText: meta.searchText,
        });
        msgIndexToTurnIndex.set(i, turnIndex);
      } else if (turns.length > 0 && !turns[turns.length - 1].time && msg.time) {
        turns[turns.length - 1].time = msg.time;
        turns[turns.length - 1].timeLabel = fmtTurnTime(msg.time);
      }
    }
    return { turns, msgIndexToTurnIndex };
  }

  function updateTurnTriggerUi() {
    const trigger = $("topbar-title-wrap");
    const badge = $("turn-nav-badge");
    const chevron = $("turn-nav-chevron");
    const total = state.turns.length;
    const enabled = total >= 1;

    if (trigger) {
      trigger.disabled = !enabled;
      trigger.classList.toggle("turn-nav-ready", enabled);
      trigger.classList.toggle("turn-nav-open", enabled && state.turnNavOpen);
      trigger.setAttribute("aria-expanded", enabled && state.turnNavOpen ? "true" : "false");
      trigger.title = enabled ? t("turnNav.triggerTitle", { total }) : "";
    }
    if (badge) {
      if (enabled) {
        const cur = Math.min(total, Math.max(1, state.activeTurnIndex || total));
        badge.textContent = t("turnNav.badge", { cur, total });
        badge.classList.remove("hidden");
      } else {
        badge.textContent = "";
        badge.classList.add("hidden");
      }
    }
    if (chevron) {
      chevron.classList.toggle("hidden", !enabled);
    }
  }

  function computeActiveTurnIndex() {
    const anchors = state.turnAnchorEls;
    const total = anchors.length;
    if (!total) return 0;
    const scrollEl = $("chat-scroll");
    if (!scrollEl) return total;
    const distToBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    if (distToBottom <= 24) return total;

    const anchorLineY = scrollEl.getBoundingClientRect().top + 84;
    let lo = 0;
    let hi = total - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const top = anchors[mid].getBoundingClientRect().top;
      if (top <= anchorLineY) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best + 1;
  }

  function updateActiveTurnFromScroll() {
    const total = state.turns.length;
    if (!total) return;
    const nextActive = computeActiveTurnIndex();
    if (nextActive && nextActive !== state.activeTurnIndex) {
      state.activeTurnIndex = nextActive;
      updateTurnTriggerUi();
      if (state.turnNavOpen) {
        syncTurnNavActiveHighlight();
      }
    }
  }

  function syncTurnNavActiveHighlight() {
    const listEl = $("turn-nav-list");
    if (!listEl) return;
    const activeIdx = String(state.activeTurnIndex || state.turns.length);
    listEl.querySelectorAll(".turn-nav-item").forEach((btn) => {
      const isAct = btn.dataset.turnIndex === activeIdx;
      btn.classList.toggle("active", isAct);
      if (isAct) btn.setAttribute("aria-current", "true");
      else btn.removeAttribute("aria-current");
    });
  }

  function renderTurnNavList() {
    const listEl = $("turn-nav-list");
    const headingEl = $("turn-nav-heading");
    const searchWrap = $("turn-nav-search-wrap");
    if (!listEl) return;

    const total = state.turns.length;
    if (headingEl) {
      headingEl.textContent = t("turnNav.headingCount", { total });
    }
    if (searchWrap) {
      searchWrap.classList.toggle("hidden", total < 8);
    }

    const q = String(state.turnNavFilter || "").trim().toLowerCase();
    const filtered = q ? state.turns.filter((t) => t.searchText.includes(q)) : state.turns;

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-placeholder">${escHtml(t("turnNav.empty"))}</div>`;
      return;
    }

    const activeIdx = state.activeTurnIndex || total;
    listEl.innerHTML = filtered
      .map((item) => {
        const isAct = item.index === activeIdx;
        const imgBadge = item.imageCount > 0
          ? `<span class="turn-nav-att-badge" title="${escHtml(t("turnNav.imgCountTitle", { count: item.imageCount }))}">${TURN_IMG_ICON_SVG}<span>${item.imageCount}</span></span>`
          : "";
        const fileBadge = item.fileCount > 0
          ? `<span class="turn-nav-att-badge" title="${escHtml(t("turnNav.fileCountTitle", { count: item.fileCount }))}">📎${item.fileCount}</span>`
          : "";
        const timeTag = item.timeLabel ? `<span class="turn-nav-time">${escHtml(item.timeLabel)}</span>` : "";
        return `
          <button class="turn-nav-item ${isAct ? "active" : ""}" type="button" role="listitem" data-turn-index="${item.index}"${isAct ? ' aria-current="true"' : ""}>
            <span class="turn-nav-dot" aria-hidden="true"></span>
            <span class="turn-nav-num">#${item.index}</span>
            <span class="turn-nav-preview">${escHtml(item.preview)}</span>
            <span class="turn-nav-meta">${imgBadge}${fileBadge}${timeTag}</span>
          </button>`;
      })
      .join("");
  }

  function openTurnNavigator() {
    if (state.turns.length < 1) return;
    haptic("light");
    closeContextPopover();
    closeSwarmDrawer();
    closeAllSheets();
    closeDrawer();
    state.turnNavOpen = true;
    state.turnNavFilter = "";
    const searchInp = $("turn-nav-search");
    if (searchInp) searchInp.value = "";
    state.activeTurnIndex = computeActiveTurnIndex() || state.turns.length;
    renderTurnNavList();
    $("topbar")?.classList.add("turn-nav-active");
    $("turn-nav-backdrop")?.classList.remove("hidden");
    $("turn-nav-panel")?.classList.remove("hidden");
    updateTurnTriggerUi();

    requestAnimationFrame(() => {
      const listEl = $("turn-nav-list");
      const activeItem = listEl && listEl.querySelector(".turn-nav-item.active");
      if (listEl && activeItem) {
        const targetTop = activeItem.offsetTop - Math.max(0, (listEl.clientHeight - activeItem.offsetHeight) / 2);
        listEl.scrollTop = Math.max(0, targetTop);
      }
    });
  }

  function closeTurnNavigator() {
    if (!state.turnNavOpen) return;
    state.turnNavOpen = false;
    state.turnNavFilter = "";
    $("topbar")?.classList.remove("turn-nav-active");
    $("turn-nav-backdrop")?.classList.add("hidden");
    $("turn-nav-panel")?.classList.add("hidden");
    updateTurnTriggerUi();
  }

  function toggleTurnNavigator() {
    if (state.turnNavOpen) {
      closeTurnNavigator();
    } else {
      openTurnNavigator();
    }
  }

  let _turnFlashTimer = null;
  let _turnFlashEl = null;

  function flashTurnElement(el) {
    if (!el) return;
    if (_turnFlashEl && _turnFlashEl !== el) {
      _turnFlashEl.classList.remove("turn-jump-flash");
    }
    clearTimeout(_turnFlashTimer);
    el.classList.remove("turn-jump-flash");
    void el.offsetWidth;
    el.classList.add("turn-jump-flash");
    _turnFlashEl = el;
    _turnFlashTimer = setTimeout(() => {
      el.classList.remove("turn-jump-flash");
      if (_turnFlashEl === el) _turnFlashEl = null;
    }, 1300);
  }

  function jumpToTurn(turnIndex, opts = {}) {
    const { smooth = true } = opts || {};
    const idx = Number(turnIndex);
    if (!Number.isFinite(idx) || idx < 1 || idx > state.turns.length) return;
    disarmBottomAnchor();
    closeTurnNavigator();
    haptic("light");

    const scrollEl = $("chat-scroll");
    const targetEl = state.turnAnchorEls[idx - 1]
      || document.querySelector(`#messages-list [data-turn-index="${idx}"]`);
    if (!scrollEl || !targetEl) return;

    const scRect = scrollEl.getBoundingClientRect();
    const elRect = targetEl.getBoundingClientRect();
    const topPadding = 14;
    const targetTop = Math.max(0, scrollEl.scrollTop + (elRect.top - scRect.top) - topPadding);
    if (smooth) {
      smoothScrollToPosition(scrollEl, targetTop);
    } else if (typeof scrollEl.scrollTo === "function") {
      scrollEl.scrollTo({ top: targetTop, behavior: "instant" });
    } else {
      scrollEl.scrollTop = targetTop;
    }

    state.activeTurnIndex = idx;
    updateTurnTriggerUi();
    flashTurnElement(targetEl);
  }

  function assistantMarkSvg() {
    return `<img src="./logo-mark.png" width="15" height="15" alt="" style="display:block;object-fit:contain;" />`;
  }

  const CHEVRON_SVG = `<svg class="m3-tool-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
  const CHECK_SVG = `<svg class="tool-done-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  const COPY_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  // =========================================================================
  // 7.8 PROMPT QUEUE TRAY, CUT-IN, INLINE EDIT & DELETE
  // =========================================================================
  function setCurrentQueue(nextQueue) {
    const list = Array.isArray(nextQueue) ? nextQueue.filter(Boolean) : [];
    state.currentQueue = list;
    if (state.editingQueueItemId && !list.some((it) => String(it.id) === state.editingQueueItemId)) {
      state.editingQueueItemId = "";
      state.editingQueueDraft = "";
    }
    renderQueueTray();
  }

  function renderQueueTray() {
    const tray = $("queue-tray");
    if (!tray) return;
    const queue = Array.isArray(state.currentQueue) ? state.currentQueue : [];
    if (!queue.length) {
      tray.classList.add("hidden");
      tray.innerHTML = "";
      return;
    }

    const activeEditEl = tray.querySelector(".queue-edit-input");
    const wasFocusedEdit = Boolean(activeEditEl && document.activeElement === activeEditEl);
    const prevSelStart = wasFocusedEdit ? activeEditEl.selectionStart : null;
    const prevSelEnd = wasFocusedEdit ? activeEditEl.selectionEnd : null;

    tray.classList.remove("hidden");
    const showResume = !state.streaming && queue.length > 0;
    const resumeBtnHtml = showResume
      ? `<button id="btn-queue-resume" class="queue-resume-btn" type="button" data-qact="resume" aria-label="${escHtml(t("queue.resumeAria"))}">▶ ${escHtml(t("queue.resume"))}</button>`
      : "";

    const cardsHtml = queue
      .map((item, idx) => {
        const qid = String(item.id || "");
        const num = idx + 1;
        const isUrgent = item.priority === "urgent";
        const atts = Array.isArray(item.attachments) ? item.attachments : [];

        if (state.editingQueueItemId && state.editingQueueItemId === qid) {
          return `
            <div class="queue-card editing" data-qid="${escHtml(qid)}">
              <div class="queue-edit-head">
                <span class="queue-index-badge ${isUrgent ? "urgent" : ""}">#${num}</span>
                <span class="queue-edit-label">${escHtml(t("queue.editingLabel"))}</span>
              </div>
              <textarea class="queue-edit-input" data-qid="${escHtml(qid)}" rows="2" placeholder="${escHtml(t("queue.editPlaceholder"))}">${escHtml(state.editingQueueDraft)}</textarea>
              <div class="queue-edit-actions">
                <button class="queue-act-btn" type="button" data-qact="cancel-edit" data-qid="${escHtml(qid)}">${escHtml(t("queue.cancel"))}</button>
                <button class="queue-act-btn save" type="button" data-qact="save-edit" data-qid="${escHtml(qid)}">${escHtml(t("queue.save"))}</button>
              </div>
            </div>`;
        }

        const tags = [];
        if (isUrgent) {
          tags.push(`<span class="queue-tag">${escHtml(t("queue.urgentTag"))}</span>`);
        }
        if (atts.length > 0) {
          tags.push(`<span class="queue-tag" title="${escHtml(t("queue.attCount", { count: atts.length }))}">📎 ${atts.length}</span>`);
        }
        if (item.model) {
          tags.push(`<span class="queue-tag">${escHtml(shortModelLabel(item.model))}</span>`);
        }
        if (item.swarm_mode) {
          tags.push(`<span class="queue-tag swarm">${escHtml(t("chat.swarm"))}</span>`);
        }
        const previewText = String(item.prompt || "").trim() || t("queue.attachOnly");

        return `
          <div class="queue-card" data-qid="${escHtml(qid)}">
            <div class="queue-card-main">
              <span class="queue-index-badge ${isUrgent ? "urgent" : ""}">#${num}</span>
              <div class="queue-card-text">${escHtml(previewText)}</div>
            </div>
            <div class="queue-card-foot">
              <div class="queue-card-tags">${tags.join("")}</div>
              <div class="queue-card-actions">
                <button class="queue-act-btn cutin" type="button" data-qact="cutin" data-qid="${escHtml(qid)}">⚡ ${escHtml(t("queue.cutin"))}</button>
                <button class="queue-act-btn edit" type="button" data-qact="edit" data-qid="${escHtml(qid)}">${escHtml(t("queue.edit"))}</button>
                <button class="queue-act-btn delete" type="button" data-qact="delete" data-qid="${escHtml(qid)}" aria-label="${escHtml(t("queue.deleteAria"))}" title="${escHtml(t("queue.deleteTitle"))}">✕</button>
              </div>
            </div>
          </div>`;
      })
      .join("");

    tray.innerHTML = `
      <div class="queue-tray-head">
        <div class="queue-tray-title">
          <span class="queue-tray-dot" aria-hidden="true"></span>
          <span>${escHtml(t("queue.headerCount", { count: queue.length }))}</span>
        </div>
        ${resumeBtnHtml}
      </div>
      <div class="queue-list">${cardsHtml}</div>`;

    if (wasFocusedEdit && state.editingQueueItemId) {
      const nextEditEl = tray.querySelector(".queue-edit-input");
      if (nextEditEl) {
        nextEditEl.focus();
        if (prevSelStart !== null && prevSelEnd !== null) {
          try { nextEditEl.setSelectionRange(prevSelStart, prevSelEnd); } catch (_) {}
        }
      }
    }
  }

  function startQueueInlineEdit(qid) {
    const item = state.currentQueue.find((it) => String(it.id) === String(qid));
    if (!item) return;
    haptic("light");
    state.editingQueueItemId = String(item.id);
    state.editingQueueDraft = String(item.prompt || "");
    renderQueueTray();
    const ta = $("queue-tray")?.querySelector(".queue-edit-input");
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      try { ta.setSelectionRange(len, len); } catch (_) {}
    }
  }

  function cancelQueueInlineEdit() {
    if (!state.editingQueueItemId) return;
    state.editingQueueItemId = "";
    state.editingQueueDraft = "";
    renderQueueTray();
  }

  async function saveQueueInlineEdit(qid) {
    const cid = state.currentCid;
    if (!cid || !qid) return;
    const item = state.currentQueue.find((it) => String(it.id) === String(qid));
    const ta = $("queue-tray")?.querySelector(`.queue-edit-input[data-qid="${CSS.escape ? CSS.escape(String(qid)) : String(qid)}"]`)
      || $("queue-tray")?.querySelector(".queue-edit-input");
    const nextPrompt = String(ta ? ta.value : state.editingQueueDraft).trim();
    const hasAtts = Boolean(item && Array.isArray(item.attachments) && item.attachments.length > 0);
    if (!nextPrompt && !hasAtts) {
      showToast(t("toast.queueEmptyEdit"));
      ta?.focus();
      return;
    }
    try {
      const res = await apiFetch(
        `/api/chat/queue/${encodeURIComponent(cid)}/${encodeURIComponent(qid)}`,
        {
          method: "PUT",
          body: JSON.stringify({ prompt: nextPrompt }),
        }
      );
      state.editingQueueItemId = "";
      state.editingQueueDraft = "";
      if (Array.isArray(res.queue)) {
        setCurrentQueue(res.queue);
      } else {
        setCurrentQueue(
          state.currentQueue.map((it) => (String(it.id) === String(qid) ? Object.assign({}, it, { prompt: nextPrompt }) : it))
        );
      }
      haptic("light");
      showToast(t("toast.queueSaved"));
    } catch (e) {
      showToast(t("toast.queueSaveFail", { err: e.message }));
    }
  }

  async function deleteQueueItem(qid) {
    const cid = state.currentCid;
    if (!cid || !qid) return;
    haptic("light");
    try {
      const res = await apiFetch(
        `/api/chat/queue/${encodeURIComponent(cid)}/${encodeURIComponent(qid)}`,
        { method: "DELETE" }
      );
      if (state.editingQueueItemId === String(qid)) {
        state.editingQueueItemId = "";
        state.editingQueueDraft = "";
      }
      if (Array.isArray(res.queue)) {
        setCurrentQueue(res.queue);
      } else {
        setCurrentQueue(state.currentQueue.filter((it) => String(it.id) !== String(qid)));
      }
      showToast(t("toast.queueDeleted"));
    } catch (e) {
      showToast(t("toast.queueDeleteFail", { err: e.message }));
    }
  }

  async function interruptQueueItem(qid) {
    const cid = state.currentCid;
    if (!cid || !qid) return;
    haptic("light");
    state.interruptPendingUntil = Date.now() + 4500;
    try {
      const res = await apiFetch(
        `/api/chat/queue/${encodeURIComponent(cid)}/${encodeURIComponent(qid)}/interrupt`,
        { method: "POST" }
      );
      if (state.editingQueueItemId === String(qid)) {
        state.editingQueueItemId = "";
        state.editingQueueDraft = "";
      }
      if (Array.isArray(res.queue)) {
        setCurrentQueue(res.queue);
      } else {
        setCurrentQueue(state.currentQueue.filter((it) => String(it.id) !== String(qid)));
      }
      state.streaming = true;
      state.streamBuffer = "";
      state.streamTools = [];
      updateSendButton();
      renderQueueTray();
      showToast(t("toast.cutinSent"));
    } catch (e) {
      state.interruptPendingUntil = 0;
      showToast(t("toast.cutinFail", { err: e.message }));
    }
  }

  async function resumeQueue() {
    const cid = state.currentCid;
    if (!cid || !state.currentQueue.length) return;
    haptic("light");
    try {
      const res = await apiFetch(`/api/chat/queue/${encodeURIComponent(cid)}/resume`, { method: "POST" });
      if (Array.isArray(res.queue)) {
        setCurrentQueue(res.queue);
      }
      showToast(t("toast.queueResumed"));
    } catch (e) {
      showToast(t("toast.queueResumeFail", { err: e.message }));
    }
  }

  // =========================================================================
  // 7.9 CONTEXT WINDOW RING PILL & ANTIGRAVITY-STYLE POPOVER
  // =========================================================================
  const CTX_MINI_CIRC = 2 * Math.PI * 7.5;
  const CTX_DONUT_CIRC = 2 * Math.PI * 40;
  const CTX_BD_COLORS = {
    system: "#818cf8",
    tools: "#38bdf8",
    rules: "#a78bfa",
    history: "#34d399",
    cache_read: "#34d399",
    uncached_input: "#38bdf8",
    thinking_output: "#f59e0b",
    response_output: "#a78bfa",
  };
  const CTX_BD_FALLBACK_PALETTE = ["#60a5fa", "#fb7185", "#2dd4bf", "#facc15", "#c084fc"];

  function fmtCompactTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1e9) return `${(v / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2).replace(/\.?0+$/, "")}M`;
    if (v >= 1e3) {
      if (v >= 1e5) return `${Math.round(v / 1e3)}K`;
      return `${Number((v / 1e3).toFixed(1))}K`;
    }
    return String(Math.round(v));
  }

  function resolveCtxStatusLevel(cw) {
    const raw = String((cw && cw.status_level) || "").toLowerCase();
    if (raw === "low" || raw === "mid" || raw === "high" || raw === "critical") {
      return raw;
    }
    const pct = Number(cw && cw.used_pct) || 0;
    if (pct >= 90) return "critical";
    if (pct >= 75) return "high";
    if (pct >= 50) return "mid";
    return "low";
  }

  function ctxBreakdownLabel(key, fallbackLabel) {
    const norm = String(key || "").trim().toLowerCase();
    const i18nKey = `ctx.bd.${norm}`;
    const localized = t(i18nKey);
    if (localized !== i18nKey) return localized;
    if (fallbackLabel) return String(fallbackLabel);
    return norm || t("ctx.bd.other");
  }

  function normalizeCtxBreakdown(cw) {
    if (!cw || typeof cw !== "object") return [];
    const pickSource = (src) => {
      if (!src) return null;
      if (Array.isArray(src)) return src.length ? src : null;
      if (typeof src === "object" && Object.keys(src).length) return src;
      return null;
    };
    const raw = pickSource(cw.breakdown) || pickSource(cw.usage_breakdown);
    if (!raw) return [];

    const items = [];
    if (Array.isArray(raw)) {
      raw.forEach((entry, idx) => {
        if (!entry || typeof entry !== "object") return;
        const key = String(entry.key || entry.id || entry.name || `item_${idx}`).toLowerCase();
        const tokens = Math.max(0, Number(entry.tokens ?? entry.value ?? entry.count ?? 0) || 0);
        const rawPct = entry.pct ?? entry.percent;
        const pct = rawPct !== undefined && rawPct !== null ? Math.max(0, Number(rawPct) || 0) : null;
        if (tokens <= 0 && (!pct || pct <= 0)) return;
        items.push({
          key,
          label: ctxBreakdownLabel(key, entry.label),
          tokens,
          pct,
          color: entry.color || CTX_BD_COLORS[key] || CTX_BD_FALLBACK_PALETTE[idx % CTX_BD_FALLBACK_PALETTE.length],
        });
      });
    } else {
      Object.entries(raw).forEach(([rawKey, val], idx) => {
        const key = String(rawKey || "").toLowerCase();
        let tokens = 0;
        let pct = null;
        let customLabel = "";
        let customColor = "";
        if (typeof val === "number") {
          tokens = Math.max(0, val);
        } else if (val && typeof val === "object") {
          tokens = Math.max(0, Number(val.tokens ?? val.value ?? val.count ?? 0) || 0);
          const rawPct = val.pct ?? val.percent;
          if (rawPct !== undefined && rawPct !== null) pct = Math.max(0, Number(rawPct) || 0);
          customLabel = val.label ? String(val.label) : "";
          customColor = val.color ? String(val.color) : "";
        }
        if (tokens <= 0 && (!pct || pct <= 0)) return;
        items.push({
          key,
          label: ctxBreakdownLabel(key, customLabel),
          tokens,
          pct,
          color: customColor || CTX_BD_COLORS[key] || CTX_BD_FALLBACK_PALETTE[idx % CTX_BD_FALLBACK_PALETTE.length],
        });
      });
    }

    const totalTok = items.reduce((acc, it) => acc + it.tokens, 0) || Number(cw.used_tokens) || 1;
    return items.map((it) => ({
      ...it,
      pct: it.pct !== null ? it.pct : (it.tokens / totalTok) * 100,
    }));
  }

  function setCurrentContext(cw) {
    state.currentContext = cw && typeof cw === "object" ? cw : null;
    updateContextPill();
    if (state.ctxPopoverOpen) {
      if (state.currentCid && state.currentContext && Number(state.currentContext.used_tokens) > 0) {
        renderContextPopover();
      } else {
        closeContextPopover();
      }
    }
  }

  function updateContextPill() {
    const btn = $("btn-ctx-window");
    const ring = $("ctx-mini-progress");
    const pctEl = $("ctx-pill-pct");
    if (!btn) return;

    const cw = state.currentContext;
    const hasValid = Boolean(state.currentCid && cw && Number(cw.used_tokens) > 0);
    if (!hasValid) {
      btn.classList.add("hidden");
      btn.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      if (state.ctxPopoverOpen) {
        closeContextPopover();
      }
      return;
    }

    const limit = Math.max(1, Number(cw.window_limit) || 512000);
    const rawPct = cw.used_pct !== undefined && cw.used_pct !== null
      ? Number(cw.used_pct)
      : (Number(cw.used_tokens) / limit) * 100;
    const pct = Math.max(0, Math.min(100, Number.isFinite(rawPct) ? rawPct : 0));
    const intPct = Math.round(pct);
    const level = resolveCtxStatusLevel(cw);
    const offset = CTX_MINI_CIRC * (1 - pct / 100);

    btn.dataset.level = level;
    btn.classList.remove("hidden");
    btn.classList.toggle("open", state.ctxPopoverOpen);
    btn.setAttribute("aria-expanded", state.ctxPopoverOpen ? "true" : "false");
    const pillAria = t("ctx.pillAria", { pct: intPct });
    btn.setAttribute("aria-label", pillAria);
    btn.title = pillAria;

    if (ring) {
      ring.setAttribute("stroke-dasharray", CTX_MINI_CIRC.toFixed(2));
      ring.setAttribute("stroke-dashoffset", offset.toFixed(2));
    }
    if (pctEl) {
      pctEl.textContent = `${intPct}%`;
    }
  }

  function renderContextPopover() {
    const panel = $("ctx-window-panel");
    const cw = state.currentContext;
    if (!panel || !cw || Number(cw.used_tokens) <= 0) return;

    const usedTokens = Math.max(0, Number(cw.used_tokens) || 0);
    const windowLimit = Math.max(1, Number(cw.window_limit) || 512000);
    const remainingTokens = cw.remaining_tokens !== undefined && cw.remaining_tokens !== null
      ? Math.max(0, Number(cw.remaining_tokens) || 0)
      : Math.max(0, windowLimit - usedTokens);
    const rawPct = cw.used_pct !== undefined && cw.used_pct !== null
      ? Number(cw.used_pct)
      : (usedTokens / windowLimit) * 100;
    const usedPct = Math.max(0, Math.min(100, Number.isFinite(rawPct) ? rawPct : 0));
    const usedPctText = usedPct >= 99.95 ? "100%" : `${usedPct.toFixed(1)}%`;
    const level = resolveCtxStatusLevel(cw);
    const statusText = level === "critical"
      ? t("ctx.statusCritical")
      : level === "high"
      ? t("ctx.statusHigh")
      : level === "mid"
      ? t("ctx.statusMid")
      : t("ctx.statusLow");

    const donutOffset = CTX_DONUT_CIRC * (1 - usedPct / 100);
    const limitLabel = cw.window_limit_label ? String(cw.window_limit_label) : fmtCompactTokens(windowLimit);
    const modelLabel = cw.model_label ? String(cw.model_label) : shortModelLabel(cw.model_id || state.selectedModel);

    const speed = Number(cw.speed_tps) || 0;
    const avgSpeed = Number(cw.avg_speed_tps) || 0;
    let speedText = "";
    if (speed > 0 && avgSpeed > 0) {
      speedText = t("ctx.speedVal", { speed: speed.toFixed(1), avg: avgSpeed.toFixed(1) });
    } else if (speed > 0) {
      speedText = t("ctx.speedSingle", { speed: speed.toFixed(1) });
    } else if (avgSpeed > 0) {
      speedText = t("ctx.speedAvgOnly", { avg: avgSpeed.toFixed(1) });
    } else {
      speedText = t("ctx.stepsTurns", {
        steps: Math.max(0, Number(cw.steps) || 0),
        turns: Math.max(0, Number(cw.turns) || state.turns.length || 0),
      });
    }

    const turnCachePct = (Number(cw.turn_cache_hit_pct) || 0).toFixed(1);
    const turnCacheTok = fmtCompactTokens(cw.turn_cache_tokens || 0);
    const sessCachePct = (Number(cw.session_cache_hit_pct) || 0).toFixed(1);
    const sessCacheTok = fmtCompactTokens(cw.session_cache_tokens || 0);

    const bdItems = normalizeCtxBreakdown(cw);
    let bdInnerHtml = "";
    if (bdItems.length) {
      const pctSum = bdItems.reduce((acc, it) => acc + Math.max(0, it.pct), 0) || 100;
      const barSegs = bdItems
        .map((it) => {
          const w = Math.max(1.5, (it.pct / pctSum) * 100);
          return `<span class="ctx-bd-seg" style="width:${w.toFixed(2)}%;background:${escHtml(it.color)}" title="${escHtml(it.label)}: ${escHtml(fmtCompactTokens(it.tokens))}"></span>`;
        })
        .join("");
      const rows = bdItems
        .map(
          (it) => `
            <div class="ctx-bd-row">
              <span class="ctx-bd-key">
                <span class="ctx-bd-dot" style="background:${escHtml(it.color)}"></span>
                <span>${escHtml(it.label)}</span>
              </span>
              <span class="ctx-bd-val">
                <span>${escHtml(fmtCompactTokens(it.tokens))}</span>
                <span class="ctx-bd-pct">${it.pct.toFixed(1)}%</span>
              </span>
            </div>`
        )
        .join("");
      bdInnerHtml = `<div class="ctx-bd-bar">${barSegs}</div><div class="ctx-bd-list">${rows}</div>`;
    } else {
      bdInnerHtml = `<div class="ctx-bd-empty">${escHtml(t("ctx.bdEmpty"))}</div>`;
    }

    const bdOpen = Boolean(state.ctxBreakdownOpen);
    panel.dataset.level = level;
    panel.innerHTML = `
      <div class="ctx-panel-head">
        <div class="ctx-panel-head-left">
          <span class="ctx-panel-title">${escHtml(t("ctx.title"))}</span>
          <button id="btn-ctx-breakdown" class="ctx-breakdown-toggle ${bdOpen ? "open" : ""}" type="button" aria-expanded="${bdOpen ? "true" : "false"}" aria-controls="ctx-breakdown-wrap" aria-label="${escHtml(t("ctx.breakdownAria"))}">
            <svg class="ctx-breakdown-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>${escHtml(t("ctx.breakdown"))}</span>
          </button>
        </div>
        <span class="ctx-status-pill lvl-${escHtml(level)}">${escHtml(statusText)}</span>
      </div>

      <div id="ctx-breakdown-wrap" class="ctx-breakdown-wrap ${bdOpen ? "" : "hidden"}">
        ${bdInnerHtml}
      </div>

      <div class="ctx-hero-row">
        <div class="ctx-donut-wrap">
          <svg class="ctx-donut-svg" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="ctx-donut-track" cx="50" cy="50" r="40" fill="none" stroke-width="8.5"></circle>
            <circle class="ctx-donut-arc" cx="50" cy="50" r="40" fill="none" stroke-width="8.5" stroke-linecap="round" stroke-dasharray="${CTX_DONUT_CIRC.toFixed(2)}" stroke-dashoffset="${donutOffset.toFixed(2)}" transform="rotate(-90 50 50)"></circle>
          </svg>
          <div class="ctx-donut-center">
            <span class="ctx-donut-pct">${escHtml(usedPctText)}</span>
            <span class="ctx-donut-sub">${escHtml(t("ctx.usedLabel"))}</span>
          </div>
        </div>
        <div class="ctx-hero-metrics">
          <div class="ctx-metric-row">
            <span class="ctx-metric-k">${escHtml(t("ctx.usedTokens"))}</span>
            <span class="ctx-metric-v">${escHtml(fmtCompactTokens(usedTokens))}</span>
          </div>
          <div class="ctx-metric-row">
            <span class="ctx-metric-k">${escHtml(t("ctx.remaining"))}</span>
            <span class="ctx-metric-v">${escHtml(fmtCompactTokens(remainingTokens))}</span>
          </div>
          <div class="ctx-metric-row">
            <span class="ctx-metric-k">${escHtml(t("ctx.windowLimit"))}</span>
            <span class="ctx-metric-v">${escHtml(limitLabel)}</span>
          </div>
        </div>
      </div>

      <div class="ctx-divider"></div>

      <div class="ctx-details">
        <div class="ctx-detail-row">
          <span class="ctx-detail-k">${escHtml(t("ctx.model"))}</span>
          <span class="ctx-detail-v">${escHtml(modelLabel)}</span>
        </div>
        <div class="ctx-detail-row">
          <span class="ctx-detail-k">${escHtml(t("ctx.speed"))}</span>
          <span class="ctx-detail-v">${escHtml(speedText)}</span>
        </div>
        <div class="ctx-detail-row">
          <span class="ctx-detail-k">${escHtml(t("ctx.turnCache"))}</span>
          <span class="ctx-detail-v">${escHtml(t("ctx.cacheVal", { pct: turnCachePct, tokens: turnCacheTok }))}</span>
        </div>
        <div class="ctx-detail-row">
          <span class="ctx-detail-k">${escHtml(t("ctx.sessionCache"))}</span>
          <span class="ctx-detail-v">${escHtml(t("ctx.cacheVal", { pct: sessCachePct, tokens: sessCacheTok }))}</span>
        </div>
      </div>`;
  }

  async function fetchCurrentContextWindow(cid) {
    if (!cid || String(cid).startsWith("pending-")) return;
    const seq = ++state.ctxFetchSeq;
    try {
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/context`);
      if (seq !== state.ctxFetchSeq || state.currentCid !== cid) return;
      if (data && data.context_window && typeof data.context_window === "object") {
        setCurrentContext(data.context_window);
      }
    } catch (_) {}
  }

  function openContextPopover() {
    if (!state.currentCid || !state.currentContext || Number(state.currentContext.used_tokens) <= 0) return;
    haptic("light");
    closeTurnNavigator();
    closeSwarmDrawer();
    closeAllSheets();
    closeDrawer();
    state.ctxPopoverOpen = true;
    renderContextPopover();
    $("composer-wrap")?.classList.add("ctx-open");
    $("ctx-window-backdrop")?.classList.remove("hidden");
    $("ctx-window-panel")?.classList.remove("hidden");
    updateContextPill();
    fetchCurrentContextWindow(state.currentCid);
  }

  function closeContextPopover() {
    if (!state.ctxPopoverOpen) return;
    state.ctxPopoverOpen = false;
    $("composer-wrap")?.classList.remove("ctx-open");
    $("ctx-window-backdrop")?.classList.add("hidden");
    $("ctx-window-panel")?.classList.add("hidden");
    updateContextPill();
  }

  function toggleContextPopover() {
    if (state.ctxPopoverOpen) {
      closeContextPopover();
    } else {
      openContextPopover();
    }
  }

  // =========================================================================
  // 7.10 PIXEL-BEE SWARM INDICATOR & COLLAPSIBLE RIGHT SWARM DRAWER
  // =========================================================================
  const SWARM_BEE_PALETTES = [
    { body: "#FBBF24", shade: "#D97706", stripe: "#1E1F22", crown: "#FDE047", wing: "#E0F2FE" }, // 0: Golden Queen
    { body: "#FB7185", shade: "#E11D48", stripe: "#1E1F22", crown: "#FDE047", wing: "#FFE4E6" }, // 1: Coral
    { body: "#F59E0B", shade: "#B45309", stripe: "#1E1F22", crown: "#FDE047", wing: "#FEF3C7" }, // 2: Amber
    { body: "#38BDF8", shade: "#0284C7", stripe: "#1E1F22", crown: "#FDE047", wing: "#E0F2FE" }, // 3: Sky
    { body: "#34D399", shade: "#059669", stripe: "#1E1F22", crown: "#FDE047", wing: "#D1FAE5" }, // 4: Mint
    { body: "#A78BFA", shade: "#7C3AED", stripe: "#1E1F22", crown: "#FDE047", wing: "#EDE9FE" }, // 5: Violet
  ];
  const SWARM_CHEV_SVG = `<svg class="swarm-sec-chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  function swarmMemberColorIdx(name, explicitIdx) {
    const cleanName = String(name || "").trim().toLowerCase();
    if (cleanName === "coordinator") return 0;
    if (explicitIdx !== undefined && explicitIdx !== null && Number.isFinite(Number(explicitIdx))) {
      const n = Number(explicitIdx);
      if (n === 0) return 0;
      return ((Math.abs(n) - 1) % 5) + 1;
    }
    let h = 0;
    for (let i = 0; i < cleanName.length; i++) {
      h = (h * 31 + cleanName.charCodeAt(i)) >>> 0;
    }
    return (h % 5) + 1;
  }

  function pixelBeeSvg(colorIdx = 0, opts = {}) {
    const { size = 16, crowned = false, live = false } = opts || {};
    const palIdx = crowned ? 0 : (colorIdx === 0 ? 0 : (((Math.abs(Number(colorIdx) || 1) - 1) % 5) + 1));
    const p = SWARM_BEE_PALETTES[palIdx] || SWARM_BEE_PALETTES[0];
    const crownRects = crowned
      ? `<rect x="4" y="1" width="1" height="2" fill="${p.crown}"/>` +
        `<rect x="6" y="0" width="1" height="3" fill="${p.crown}"/>` +
        `<rect x="8" y="1" width="1" height="2" fill="${p.crown}"/>` +
        `<rect x="4" y="2" width="5" height="1" fill="${p.shade}"/>`
      : `<rect x="3" y="3" width="1" height="2" fill="${p.stripe}"/>` +
        `<rect x="5" y="4" width="1" height="1" fill="${p.stripe}"/>`;

    return (
      `<svg class="pixel-bee-svg${live ? " bee-live" : ""}" viewBox="0 0 16 16" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true">` +
        `<g class="bee-wing">` +
          `<rect x="6" y="2" width="3" height="2" fill="${p.wing}"/>` +
          `<rect x="10" y="3" width="3" height="2" fill="${p.wing}" opacity="0.88"/>` +
        `</g>` +
        crownRects +
        `<rect x="3" y="5" width="9" height="1" fill="${p.stripe}"/>` +
        `<rect x="2" y="6" width="1" height="5" fill="${p.stripe}"/>` +
        `<rect x="12" y="6" width="1" height="5" fill="${p.stripe}"/>` +
        `<rect x="3" y="11" width="9" height="1" fill="${p.stripe}"/>` +
        `<rect x="3" y="6" width="3" height="5" fill="${p.body}"/>` +
        `<rect x="6" y="6" width="2" height="5" fill="${p.stripe}"/>` +
        `<rect x="8" y="6" width="2" height="5" fill="${p.body}"/>` +
        `<rect x="10" y="6" width="2" height="5" fill="${p.stripe}"/>` +
        `<rect x="3" y="10" width="3" height="1" fill="${p.shade}"/>` +
        `<rect x="8" y="10" width="2" height="1" fill="${p.shade}"/>` +
        `<rect x="4" y="7" width="1" height="2" fill="${p.stripe}"/>` +
        `<rect x="3" y="9" width="1" height="1" fill="#FFF1F2" opacity="0.85"/>` +
        `<rect x="13" y="8" width="2" height="1" fill="${p.stripe}"/>` +
      `</svg>`
    );
  }

  function swarmStateLabel(st) {
    const s = String(st || "").toLowerCase();
    if (s === "working") return t("swarm.stateWorking");
    if (s === "waiting") return t("swarm.stateWaiting");
    if (s === "in_review") return t("swarm.stateInReview");
    if (s === "killed") return t("swarm.stateKilled");
    return t("swarm.stateStopped");
  }

  function swarmThreadStatusLabel(st) {
    const s = String(st || "").toLowerCase();
    if (s === "moving") return t("swarm.threadMoving");
    if (s === "done") return t("swarm.threadDone");
    return t("swarm.threadWaiting");
  }

  function getSwarmEffectiveStats() {
    const full = state.currentSwarm;
    const sum = state.currentSwarmSummary;
    const hasSwarm = Boolean((full && full.has_swarm) || (sum && sum.has_swarm));
    const isLive = Boolean((full && full.is_live) || (sum && sum.is_live) || (state.streaming && state.swarmMode));
    const workingCount = Number(
      full && full.working_count !== undefined
        ? full.working_count
        : (sum && sum.working_count !== undefined ? sum.working_count : 0)
    ) || 0;
    const activeCount = Number(
      full && full.active_count !== undefined
        ? full.active_count
        : (sum && sum.active_count !== undefined ? sum.active_count : 0)
    ) || 0;
    const title = String((full && full.title) || (sum && sum.title) || "").trim();
    return { hasSwarm, isLive, workingCount, activeCount, title };
  }

  function updateSwarmTopbarPill() {
    const btn = $("btn-swarm-status");
    const beeEl = $("swarm-topbar-bee");
    const cntEl = $("swarm-topbar-count");
    if (!btn) return;

    const { hasSwarm, isLive, workingCount, activeCount } = getSwarmEffectiveStats();
    const visible = Boolean(state.currentCid ? (hasSwarm || state.swarmMode) : state.swarmMode);
    if (!visible) {
      btn.classList.add("hidden");
      btn.classList.remove("is-live");
      btn.setAttribute("aria-expanded", "false");
      return;
    }

    btn.classList.remove("hidden");
    btn.classList.toggle("is-live", isLive);
    btn.setAttribute("aria-expanded", state.swarmDrawerOpen ? "true" : "false");

    const displayCount = isLive ? (workingCount || activeCount) : workingCount;
    if (beeEl) {
      beeEl.innerHTML = pixelBeeSvg(0, { size: 16, crowned: true, live: isLive });
    }
    if (cntEl) {
      if (displayCount > 0) {
        cntEl.textContent = String(displayCount);
        cntEl.classList.remove("hidden");
      } else {
        cntEl.textContent = "";
        cntEl.classList.add("hidden");
      }
    }
    btn.title = isLive
      ? t("swarm.pillLiveTitle", { count: Math.max(1, displayCount) })
      : t("swarm.pillIdleTitle");
  }

  function stopSwarmPolling() {
    if (state.swarmPollTimer) {
      clearTimeout(state.swarmPollTimer);
      state.swarmPollTimer = null;
    }
  }

  function syncSwarmPolling() {
    stopSwarmPolling();
    if (document.visibilityState === "hidden") return;
    const cid = state.currentCid;
    if (!cid || String(cid).startsWith("pending-") || !getActiveHost()) return;

    const { isLive } = getSwarmEffectiveStats();
    let delayMs = 0;
    if (state.swarmDrawerOpen) {
      delayMs = 2500;
    } else if (isLive) {
      delayMs = 5000;
    }
    if (!delayMs) return;

    state.swarmPollTimer = setTimeout(async () => {
      state.swarmPollTimer = null;
      if (document.visibilityState === "hidden" || state.currentCid !== cid) return;
      await fetchSwarmStatus({ showLoading: false });
      syncSwarmPolling();
    }, delayMs);
  }

  async function fetchSwarmStatus(opts = {}) {
    const { showLoading = false } = opts || {};
    const cid = state.currentCid;
    if (!cid || String(cid).startsWith("pending-") || !getActiveHost()) {
      state.currentSwarm = null;
      state.swarmLoading = false;
      state.swarmLastError = "";
      updateSwarmTopbarPill();
      if (state.swarmDrawerOpen) renderSwarmDrawer({ force: true });
      return;
    }

    const seq = ++state.swarmFetchSeq;
    if (showLoading) {
      state.swarmLoading = true;
      state.swarmLastError = "";
      if (state.swarmDrawerOpen) renderSwarmDrawer({ force: true });
    }

    try {
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/swarm`);
      if (seq !== state.swarmFetchSeq || state.currentCid !== cid) return;
      const sw = data && data.swarm && typeof data.swarm === "object" ? data.swarm : null;
      state.currentSwarm = sw;
      state.swarmLoading = false;
      state.swarmLastError = "";
      if (sw) {
        state.currentSwarmSummary = {
          has_swarm: Boolean(sw.has_swarm),
          is_live: Boolean(sw.is_live),
          active_count: Number(sw.active_count || 0),
          working_count: Number(sw.working_count || 0),
          title: String(sw.title || ""),
        };
      }
      updateSwarmTopbarPill();
      if (state.swarmDrawerOpen) {
        renderSwarmDrawer();
      }
      if (state.streaming && $("streaming-row")) {
        updateStreamingRow();
      }
    } catch (err) {
      if (seq !== state.swarmFetchSeq || state.currentCid !== cid) return;
      state.swarmLoading = false;
      if (!state.currentSwarm) {
        state.swarmLastError = err && err.message ? err.message : t("err.unknown");
      }
      if (state.swarmDrawerOpen) {
        renderSwarmDrawer({ force: true });
      }
    }
  }

  function renderSwarmDrawer(opts = {}) {
    const { force = false } = opts || {};
    const drawer = $("swarm-drawer");
    const body = $("swarm-drawer-body");
    if (!drawer || !body) return;

    const sw = state.currentSwarm;
    const hasSwarm = Boolean(sw && sw.has_swarm);
    const isLive = Boolean((sw && sw.is_live) || (state.streaming && state.swarmMode));
    const members = Array.isArray(sw && sw.members) ? sw.members : [];
    const archived = Array.isArray(sw && sw.archived_members) ? sw.archived_members : [];
    const board = Array.isArray(sw && sw.board) ? sw.board : [];
    const threads = Array.isArray(sw && sw.threads) ? sw.threads : [];

    // Update header title, bee, status pill & tab labels
    const titleEl = $("swarm-drawer-title");
    const beeEl = $("swarm-drawer-bee");
    const statusPill = $("swarm-drawer-status-pill");
    const statusText = $("swarm-drawer-status-text");
    if (titleEl) {
      titleEl.textContent = (sw && sw.title) || t("swarm.defaultTitle");
    }
    if (beeEl) {
      beeEl.innerHTML = pixelBeeSvg(0, { size: 20, crowned: true, live: isLive });
    }
    if (statusPill && statusText) {
      const doneAll = hasSwarm && !isLive && Number(sw.tasks_total || 0) > 0 && Number(sw.tasks_done || 0) >= Number(sw.tasks_total || 0);
      const pillCls = isLive ? "live" : (doneAll ? "done" : "idle");
      statusPill.className = `swarm-status-pill ${pillCls}`;
      statusText.textContent = isLive ? t("swarm.statusLive") : (doneAll ? t("swarm.statusDone") : t("swarm.statusIdle"));
    }

    const tabOv = $("swarm-tab-overview");
    const tabBd = $("swarm-tab-board");
    const tabMb = $("swarm-tab-members");
    if (tabOv) tabOv.textContent = t("swarm.tabOverview");
    if (tabBd) {
      const bCnt = Number((sw && sw.board_count) || board.length || 0);
      tabBd.textContent = bCnt > 0 ? t("swarm.tabBoardCount", { count: bCnt }) : t("swarm.tabBoard");
    }
    if (tabMb) {
      const mCnt = Number((sw && sw.active_count) || members.length || 0);
      tabMb.textContent = mCnt > 0 ? t("swarm.tabMembersCount", { count: mCnt }) : t("swarm.tabMembers");
    }
    document.querySelectorAll("#swarm-tabs [data-swarm-tab]").forEach((btn) => {
      const act = btn.dataset.swarmTab === state.swarmTab;
      btn.classList.toggle("active", act);
      btn.setAttribute("aria-selected", act ? "true" : "false");
    });

    // Fingerprint guard so 2.5s polling never flickers or breaks user scroll
    const fp = JSON.stringify({
      lang: I18N.getLang(),
      tab: state.swarmTab,
      sel: state.swarmSelectedMember,
      newest: state.swarmBoardNewestFirst,
      loading: state.swarmLoading,
      err: state.swarmLastError,
      swarmMode: state.swarmMode,
      sw,
    });
    if (!force && fp === state.swarmLastRenderFp) {
      return;
    }
    state.swarmLastRenderFp = fp;

    const prevScrollTop = body.scrollTop;
    const isExp = (key, defOpen = false) =>
      state.swarmExpandedKeys.has(key) || (defOpen && !state.swarmExpandedKeys.has(`!${key}`));

    if (state.swarmLoading && !sw) {
      body.innerHTML = `<div class="empty-placeholder">${escHtml(t("swarm.loading"))}</div>`;
      return;
    }
    if (state.swarmLastError && !sw) {
      body.innerHTML = `<div class="m3-card"><p class="info-text">${escHtml(t("swarm.loadFail", { err: state.swarmLastError }))}</p></div>`;
      return;
    }
    if (!hasSwarm) {
      const ctaHtml = state.swarmMode
        ? `<span class="swarm-ready-pill">${escHtml(t("swarm.readyHint"))}</span>`
        : `<button id="btn-swarm-enable-composer" class="m3-btn filled sm" type="button">${escHtml(t("swarm.enableBtn"))}</button>`;
      body.innerHTML = `
        <div class="swarm-empty-card">
          <div class="swarm-empty-bee">${pixelBeeSvg(0, { size: 42, crowned: true, live: state.swarmMode })}</div>
          <div class="swarm-empty-title">${escHtml(t("swarm.emptyTitle"))}</div>
          <p class="swarm-empty-desc">${escHtml(t("swarm.emptyDesc"))}</p>
          ${ctaHtml}
        </div>`;
      return;
    }

    // Build member color lookup map for Board/Threads consistency
    const colorMap = new Map();
    [...members, ...archived].forEach((m) => {
      if (m && m.name) {
        colorMap.set(m.name, swarmMemberColorIdx(m.name, m.color_idx));
      }
    });
    const getColorFor = (name, explicitIdx) => {
      if (colorMap.has(name)) return colorMap.get(name);
      return swarmMemberColorIdx(name, explicitIdx);
    };

    if (state.swarmTab === "overview") {
      const sections = [];

      // 1. GOAL Card
      const goalTitle = (sw.goal && sw.goal.title) || sw.title || t("swarm.defaultTitle");
      const goalLine = (sw.goal && sw.goal.line) || "";
      sections.push(`
        <details class="swarm-section-card" data-skey="goal"${isExp("goal", true) ? " open" : ""}>
          <summary>
            <div class="swarm-sec-head-left">
              <span class="swarm-sec-kicker">${escHtml(t("swarm.goalLabel"))}</span>
              <span class="swarm-sec-title">${escHtml(goalTitle)}</span>
            </div>
            ${SWARM_CHEV_SVG}
          </summary>
          <div class="swarm-section-body">
            <div class="swarm-goal-title">${escHtml(goalTitle)}</div>
            ${goalLine ? `<div class="swarm-goal-line">${escHtml(goalLine)}</div>` : ""}
          </div>
        </details>`);

      // 2. Running / Active Tasks Card
      const activeWorkers = members.filter((m) => m && !m.killed);
      const taskMembers = activeWorkers.filter((m) => m.role !== "coordinator");
      const displayTaskMembers = taskMembers.length ? taskMembers : activeWorkers;
      if (displayTaskMembers.length) {
        const rowsHtml = displayTaskMembers
          .map((m) => {
            const st = String(m.state || "stopped").toLowerCase();
            const cIdx = getColorFor(m.name, m.color_idx);
            const isCrowned = m.role === "coordinator" || m.name === "coordinator";
            const indicator = st === "working"
              ? `<span class="swarm-task-spinner" aria-hidden="true"></span>`
              : `<span class="swarm-task-dot ${escHtml(st)}" aria-hidden="true"></span>`;
            const taskTitle = String(m.task || m.role || m.name);
            const nowAct = String(m.current_action || "").trim();
            return `
              <div class="swarm-task-row">
                <div class="swarm-task-top">
                  ${indicator}
                  <span class="swarm-task-name" title="${escHtml(taskTitle)}">${escHtml(taskTitle)}</span>
                </div>
                <div class="swarm-task-meta">
                  <span class="swarm-bee-pill">
                    ${pixelBeeSvg(cIdx, { size: 14, crowned: isCrowned, live: st === "working" })}
                    <span>@${escHtml(m.name)}</span>
                  </span>
                  <span class="swarm-state-badge ${escHtml(st)}">${escHtml(swarmStateLabel(st))}</span>
                </div>
                ${nowAct ? `<div class="swarm-now-line">${escHtml(t("swarm.nowPrefix", { action: nowAct }))}</div>` : ""}
              </div>`;
          })
          .join("");
        sections.push(`
          <details class="swarm-section-card" data-skey="running"${isExp("running", true) ? " open" : ""}>
            <summary>
              <div class="swarm-sec-head-left">
                <span class="swarm-sec-title">${escHtml(t("swarm.runningTitle", { count: displayTaskMembers.length }))}</span>
              </div>
              ${SWARM_CHEV_SVG}
            </summary>
            <div class="swarm-section-body">${rowsHtml}</div>
          </details>`);
      }

      // 3. Progress Summary Bar
      const tasksDone = Math.max(0, Number(sw.tasks_done || 0));
      const tasksTotal = Math.max(0, Number(sw.tasks_total || 0));
      const progPct = tasksTotal > 0 ? Math.min(100, Math.round((tasksDone / tasksTotal) * 100)) : 0;
      const progCirc = 2 * Math.PI * 8;
      const progOff = progCirc * (1 - progPct / 100);
      const movingThreads = threads.filter((th) => th && th.status === "moving").length;
      sections.push(`
        <details class="swarm-section-card" data-skey="progress"${isExp("progress", false) ? " open" : ""}>
          <summary>
            <div class="swarm-progress-summary">
              <svg class="swarm-prog-ring" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                <circle class="swarm-prog-track" cx="10" cy="10" r="8" fill="none" stroke-width="2.4"></circle>
                <circle class="swarm-prog-arc" cx="10" cy="10" r="8" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${progCirc.toFixed(2)}" stroke-dashoffset="${progOff.toFixed(2)}" transform="rotate(-90 10 10)"></circle>
              </svg>
              <span class="swarm-prog-text">${escHtml(t("swarm.tasksProgress", { done: tasksDone, total: tasksTotal }))}</span>
              ${movingThreads > 0 ? `<span class="swarm-prog-badge">${escHtml(t("swarm.activeThreads", { count: movingThreads }))}</span>` : ""}
            </div>
            ${SWARM_CHEV_SVG}
          </summary>
          <div class="swarm-section-body">
            <div class="swarm-mini-stats">
              <div class="swarm-mini-stat">
                <span class="swarm-mini-stat-v">${Number(sw.active_count || members.length)}</span>
                <span class="swarm-mini-stat-k">${escHtml(t("swarm.summaryActive"))}</span>
              </div>
              <div class="swarm-mini-stat">
                <span class="swarm-mini-stat-v">${Number(sw.working_count || 0)}</span>
                <span class="swarm-mini-stat-k">${escHtml(t("swarm.summaryWorking"))}</span>
              </div>
              <div class="swarm-mini-stat">
                <span class="swarm-mini-stat-v">${Number(sw.killed_count || archived.length)}</span>
                <span class="swarm-mini-stat-k">${escHtml(t("swarm.summaryArchived"))}</span>
              </div>
              <div class="swarm-mini-stat">
                <span class="swarm-mini-stat-v">${Number(sw.board_count || board.length)}</span>
                <span class="swarm-mini-stat-k">${escHtml(t("swarm.summaryBoard"))}</span>
              </div>
            </div>
          </div>
        </details>`);

      // 4. Threads List (collapsible <details> cards)
      if (threads.length) {
        const thHtml = threads
          .map((th, idx) => {
            const tid = String(th.id || `t${idx}`);
            const skey = `thread:${tid}`;
            const st = String(th.status || "waiting").toLowerCase();
            const dCnt = Math.max(0, Number(th.done_count || 0));
            const tCnt = Math.max(1, Number(th.total_count || 1));
            const barPct = Math.min(100, Math.round((dCnt / tCnt) * 100));
            const thMembers = Array.isArray(th.members) ? th.members : [];
            const thMemPills = thMembers
              .map((tm) => {
                const mc = getColorFor(tm.name, tm.color_idx);
                const mst = String(tm.state || "stopped").toLowerCase();
                return `
                  <span class="swarm-bee-pill">
                    ${pixelBeeSvg(mc, { size: 13, crowned: tm.name === "coordinator", live: mst === "working" })}
                    <span>@${escHtml(tm.name)}</span>
                  </span>`;
              })
              .join("");
            return `
              <details class="swarm-thread-card" data-skey="${escHtml(skey)}"${isExp(skey, st === "moving") ? " open" : ""}>
                <summary>
                  <span class="swarm-thread-dot ${escHtml(st)}" title="${escHtml(swarmThreadStatusLabel(st))}" aria-hidden="true"></span>
                  <span class="swarm-thread-title">${escHtml(th.title || tid)}</span>
                  <span class="swarm-thread-prog">
                    <span class="swarm-thread-bar"><span class="swarm-thread-bar-fill ${st === "done" ? "done" : ""}" style="width:${barPct}%"></span></span>
                    <span class="swarm-thread-ratio">${dCnt}/${tCnt}</span>
                  </span>
                  ${SWARM_CHEV_SVG}
                </summary>
                <div class="swarm-thread-body">
                  ${th.goal ? `<div class="swarm-thread-goal">${escHtml(th.goal)}</div>` : ""}
                  ${th.now_action ? `<div class="swarm-now-line">${escHtml(t("swarm.nowPrefix", { action: th.now_action }))}</div>` : ""}
                  ${thMemPills ? `<div class="swarm-thread-members">${thMemPills}</div>` : ""}
                </div>
              </details>`;
          })
          .join("");
        sections.push(`<div class="swarm-sub-heading">${escHtml(t("swarm.threadsHeading", { count: threads.length }))}</div><div class="swarm-threads-list">${thHtml}</div>`);
      }

      // 5. The Team Section (Coordinator Card + Interactive Bee Strip + Detail Card)
      const coordinator = members.find((m) => m && (m.role === "coordinator" || m.name === "coordinator"));
      const workers = members.filter((m) => m && m !== coordinator);
      if (state.swarmSelectedMember && !workers.some((w) => w.name === state.swarmSelectedMember)) {
        state.swarmSelectedMember = "";
      }
      const coordHtml = coordinator
        ? (() => {
            const cst = String(coordinator.state || "stopped").toLowerCase();
            const actTxt = String(coordinator.current_action || coordinator.last_post_preview || "").trim() || t("swarm.noActivity");
            return `
              <div class="swarm-coordinator-card">
                <div class="swarm-coord-avatar">${pixelBeeSvg(0, { size: 24, crowned: true, live: cst === "working" })}</div>
                <div class="swarm-coord-info">
                  <div class="swarm-coord-top">
                    <span class="swarm-coord-name">@${escHtml(coordinator.name)}</span>
                    <span class="swarm-coord-tag">${escHtml(t("swarm.coordinatorBadge"))}</span>
                    <span class="swarm-state-badge ${escHtml(cst)}">${escHtml(swarmStateLabel(cst))}</span>
                  </div>
                  <div class="swarm-coord-act">${escHtml(actTxt)}</div>
                </div>
              </div>`;
          })()
        : "";

      const allSelected = !state.swarmSelectedMember;
      const stripTiles = [
        `<button class="swarm-bee-tile ${allSelected ? "selected" : ""}" type="button" data-swarm-member="">
          ${pixelBeeSvg(0, { size: 24, crowned: true, live: isLive })}
          <span class="swarm-bee-tile-name">${escHtml(t("swarm.teamAll"))}</span>
        </button>`,
        ...workers.map((w) => {
          const wst = String(w.state || "stopped").toLowerCase();
          const cIdx = getColorFor(w.name, w.color_idx);
          const sel = state.swarmSelectedMember === w.name;
          const badge = wst === "working"
            ? `<span class="swarm-bee-live-dot" aria-hidden="true"></span>`
            : (wst === "waiting" ? `<span class="swarm-bee-zz" aria-hidden="true">zZ</span>` : "");
          return `
            <button class="swarm-bee-tile ${sel ? "selected" : ""}" type="button" data-swarm-member="${escHtml(w.name)}" title="@${escHtml(w.name)}">
              ${badge}
              ${pixelBeeSvg(cIdx, { size: 24, crowned: false, live: wst === "working" })}
              <span class="swarm-bee-tile-name">${escHtml(w.name)}</span>
            </button>`;
        }),
      ].join("");

      let teamDetailHtml = "";
      if (state.swarmSelectedMember) {
        const picked = workers.find((w) => w.name === state.swarmSelectedMember);
        if (picked) {
          const pst = String(picked.state || "stopped").toLowerCase();
          const pc = getColorFor(picked.name, picked.color_idx);
          const modelTxt = picked.model ? shortModelLabel(picked.model) : "";
          const nowTxt = String(picked.current_action || "").trim();
          const postTxt = String(picked.last_post_preview || "").trim();
          teamDetailHtml = `
            <div class="swarm-member-detail">
              <div class="swarm-member-detail-head">
                ${pixelBeeSvg(pc, { size: 18, crowned: false, live: pst === "working" })}
                <span class="swarm-member-detail-name">@${escHtml(picked.name)}</span>
                <span class="swarm-state-badge ${escHtml(pst)}">${escHtml(swarmStateLabel(pst))}</span>
                ${modelTxt ? `<span class="swarm-member-model-tag">${escHtml(modelTxt)}</span>` : ""}
              </div>
              <div class="swarm-member-detail-task">${escHtml(picked.task || t("swarm.noTaskDesc"))}</div>
              ${nowTxt ? `<div class="swarm-now-line">${escHtml(t("swarm.nowPrefix", { action: nowTxt }))}</div>` : ""}
              ${postTxt ? `<div class="swarm-coord-act">${picked.last_post_seq ? `#${picked.last_post_seq} · ` : ""}${escHtml(postTxt)}</div>` : ""}
            </div>`;
        }
      } else if (workers.length) {
        teamDetailHtml = `<div class="swarm-team-hint">${escHtml(t("swarm.teamTapHint"))}</div>`;
      }

      sections.push(`
        <div class="swarm-team-box">
          <div class="swarm-sub-heading">${escHtml(t("swarm.teamHeading"))}</div>
          ${coordHtml}
          ${workers.length ? `<div class="swarm-team-strip">${stripTiles}</div>` : ""}
          ${teamDetailHtml}
        </div>`);

      body.innerHTML = sections.join("");
    } else if (state.swarmTab === "board") {
      if (!board.length) {
        body.innerHTML = `<div class="empty-placeholder">${escHtml(t("swarm.boardEmpty"))}</div>`;
      } else {
        const ordered = state.swarmBoardNewestFirst
          ? [...board].sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0))
          : [...board].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
        const sortLbl = state.swarmBoardNewestFirst ? t("swarm.boardNewest") : t("swarm.boardOldest");
        const msgsHtml = ordered
          .map((msg) => {
            const seq = Number(msg.seq || 0);
            const agent = String(msg.agent || "agent");
            const cIdx = getColorFor(agent);
            const txt = String(msg.text || "");
            const isLong = txt.length > 260;
            const skey = `board:${seq}`;
            const timeLbl = fmtTurnTime(msg.time);
            const bodyHtml = isLong
              ? `<details class="swarm-board-fold" data-skey="${escHtml(skey)}"${isExp(skey, false) ? " open" : ""}>
                   <summary>
                     <div class="swarm-board-preview">${escHtml(txt)}</div>
                     <span class="swarm-board-expand-hint">${escHtml(t("swarm.boardExpand"))}</span>
                   </summary>
                   <div class="swarm-board-text">${escHtml(txt)}</div>
                 </details>`
              : `<div class="swarm-board-text">${escHtml(txt)}</div>`;
            return `
              <div class="swarm-board-msg">
                <div class="swarm-board-msg-head">
                  <span class="swarm-board-seq">#${seq}</span>
                  <span class="swarm-bee-pill">
                    ${pixelBeeSvg(cIdx, { size: 13, crowned: agent === "coordinator", live: false })}
                    <span>@${escHtml(agent)}</span>
                  </span>
                  ${timeLbl ? `<span class="swarm-board-time">${escHtml(timeLbl)}</span>` : ""}
                </div>
                ${bodyHtml}
              </div>`;
          })
          .join("");
        body.innerHTML = `
          <div class="swarm-board-toolbar">
            <span class="swarm-board-count">${escHtml(t("swarm.boardCount", { count: board.length }))}</span>
            <button id="btn-swarm-board-sort" class="swarm-board-sort-btn" type="button">${escHtml(sortLbl)}</button>
          </div>
          ${msgsHtml}`;
      }
    } else {
      // Members Tab
      const parts = [];
      if (members.length) {
        const activeHtml = members
          .map((m) => {
            const st = String(m.state || "stopped").toLowerCase();
            const isCrowned = m.role === "coordinator" || m.name === "coordinator";
            const cIdx = getColorFor(m.name, m.color_idx);
            const mLbl = m.model ? shortModelLabel(m.model) : "";
            const actTxt = String(m.current_action || "").trim();
            const seqTxt = m.last_post_seq ? t("swarm.lastPostSeq", { seq: m.last_post_seq }) : "";
            return `
              <div class="swarm-member-card">
                <div class="swarm-member-card-top">
                  ${pixelBeeSvg(cIdx, { size: 22, crowned: isCrowned, live: st === "working" })}
                  <div class="swarm-member-card-title">
                    <div class="swarm-member-card-name">@${escHtml(m.name)}</div>
                    <div class="swarm-member-card-sub">${escHtml([mLbl, seqTxt].filter(Boolean).join(" · ") || m.role || "")}</div>
                  </div>
                  <span class="swarm-state-badge ${escHtml(st)}">${escHtml(swarmStateLabel(st))}</span>
                </div>
                ${m.task ? `<div class="swarm-member-detail-task">${escHtml(m.task)}</div>` : ""}
                ${actTxt ? `<div class="swarm-now-line">${escHtml(t("swarm.nowPrefix", { action: actTxt }))}</div>` : ""}
              </div>`;
          })
          .join("");
        parts.push(`<div class="swarm-sub-heading">${escHtml(t("swarm.membersActiveHeading", { count: members.length }))}</div>${activeHtml}`);
      }
      if (archived.length) {
        const archHtml = archived
          .map((m) => {
            const cIdx = getColorFor(m.name, m.color_idx);
            const mLbl = m.model ? shortModelLabel(m.model) : "";
            const seqTxt = m.last_post_seq ? t("swarm.lastPostSeq", { seq: m.last_post_seq }) : "";
            return `
              <div class="swarm-member-card archived">
                <div class="swarm-member-card-top">
                  ${pixelBeeSvg(cIdx, { size: 18, crowned: m.role === "coordinator", live: false })}
                  <div class="swarm-member-card-title">
                    <div class="swarm-member-card-name">@${escHtml(m.name)}</div>
                    <div class="swarm-member-card-sub">${escHtml([mLbl, seqTxt].filter(Boolean).join(" · "))}</div>
                  </div>
                  <span class="swarm-state-badge killed">${escHtml(swarmStateLabel("killed"))}</span>
                </div>
                ${m.last_post_preview ? `<div class="swarm-coord-act">${escHtml(m.last_post_preview)}</div>` : ""}
              </div>`;
          })
          .join("");
        parts.push(`
          <details class="swarm-section-card" data-skey="archived"${isExp("archived", false) ? " open" : ""}>
            <summary>
              <div class="swarm-sec-head-left">
                <span class="swarm-sec-title">${escHtml(t("swarm.membersArchivedHeading", { count: archived.length }))}</span>
              </div>
              ${SWARM_CHEV_SVG}
            </summary>
            <div class="swarm-section-body">${archHtml}</div>
          </details>`);
      }
      body.innerHTML = parts.length ? parts.join("") : `<div class="empty-placeholder">${escHtml(t("swarm.membersEmpty"))}</div>`;
    }

    body.scrollTop = prevScrollTop;
  }

  function openSwarmDrawer() {
    haptic("light");
    closeTurnNavigator();
    closeContextPopover();
    closeAllSheets();
    closeDrawer();
    state.swarmDrawerOpen = true;
    $("swarm-backdrop")?.classList.remove("hidden");
    $("swarm-drawer")?.classList.add("open");
    updateSwarmTopbarPill();
    renderSwarmDrawer({ force: true });
    fetchSwarmStatus({ showLoading: !state.currentSwarm });
    syncSwarmPolling();
  }

  function closeSwarmDrawer() {
    if (!state.swarmDrawerOpen) return;
    state.swarmDrawerOpen = false;
    $("swarm-backdrop")?.classList.add("hidden");
    $("swarm-drawer")?.classList.remove("open");
    updateSwarmTopbarPill();
    syncSwarmPolling();
  }

  function toggleSwarmDrawer() {
    if (state.swarmDrawerOpen) {
      closeSwarmDrawer();
    } else {
      openSwarmDrawer();
    }
  }

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

    state.mediaRenderGen += 1;
    const renderGen = state.mediaRenderGen;
    abortPendingMediaQueue("messages");
    if (mediaObserver) {
      try {
        mediaObserver.disconnect();
      } catch (_) {}
    }

    if (!conv || (!conv.messages.length && !state.streaming)) {
      disarmBottomAnchor();
      closeTurnNavigator();
      state.turns = [];
      state.turnAnchorEls = [];
      state.activeTurnIndex = 0;
      state.lastRenderedConvFp = "";
      $("empty-state").classList.remove("hidden");
      list.innerHTML = "";
      $("deliverables-box").classList.add("hidden");
      $("conv-title").textContent = "Antigravity";
      updateTurnTriggerUi();
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
    const isInitialBottomSnap = !preserveScroll;

    if (isInitialBottomSnap && scrollEl) {
      scrollEl.classList.add("chat-initial-snap");
    }

    $("empty-state").classList.add("hidden");
    $("conv-title").textContent = conv.title || t("chat.newConvTitle");

    const host = getActiveHost();
    const { turns, msgIndexToTurnIndex } = buildConversationTurns(conv.messages);
    state.turns = turns;
    const anchorEls = new Array(turns.length);
    const totalMsgs = conv.messages.length;
    const eagerMsgThreshold = Math.max(0, totalMsgs - 8);
    const frag = document.createDocumentFragment();

    for (let idx = 0; idx < totalMsgs; idx++) {
      const msg = conv.messages[idx];
      const row = document.createElement("div");
      row.className = `msg-row ${msg.role}`;

      const turnNum = msgIndexToTurnIndex.get(idx);
      if (turnNum !== undefined) {
        row.dataset.turnIndex = String(turnNum);
        anchorEls[turnNum - 1] = row;
      }

      if (msg.role === "user") {
        const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
        let attsHtml = "";
        if (atts.length) {
          const imgs = atts.filter((a) => a && a.is_image && a.path);
          const files = atts.filter((a) => a && !a.is_image && a.path);
          const parts = [];
          if (imgs.length) {
            const imgCards = imgs
              .map((a) => {
                const apiPath = buildPreviewApiPath(a.preview_url, a.path);
                const cacheKey = makeMediaCacheKey(host, apiPath);
                const cached = host ? authMediaCache.get(cacheKey) : null;
                let imgAttr = "";
                let thumbStateCls = "img-loading";
                if (SIDECAR) {
                  if (cached) {
                    imgAttr = `src="${escHtml(cached.dataUrl || cached.blobUrl)}" data-media-loaded="1"`;
                    thumbStateCls = "img-loaded";
                  }
                } else {
                  const directUrl = buildDirectMediaUrl(host, apiPath);
                  const loadingAttr = idx >= eagerMsgThreshold ? "eager" : "lazy";
                  imgAttr = directUrl ? `src="${escHtml(directUrl)}" loading="${loadingAttr}"` : "";
                  thumbStateCls = directUrl ? "img-loading" : "img-error";
                }
                return `<button class="msg-img-thumb msg-att-btn ${thumbStateCls}" type="button" data-path="${escHtml(a.path)}" data-name="${escHtml(a.name || "image")}" data-media-path="${escHtml(apiPath)}" aria-label="${escHtml(a.name || "image")}">` +
                  `<img ${imgAttr} data-media-path="${escHtml(apiPath)}" data-media-key="${escHtml(cacheKey)}" alt="${escHtml(a.name || "")}" decoding="async" />` +
                  `<span class="msg-img-retry" aria-hidden="true">${t("chat.imgLoadFailed")}</span>` +
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
                    `<span>📎 ${escHtml(a.name || t("chat.fileFallback"))}</span>` +
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
              (tool) =>
                `<div class="tool-step">` +
                  `<span class="tool-step-status">✓</span>` +
                  `<span class="tool-step-name">${escHtml(tool.name)}</span>` +
                  `<span class="tool-step-target">${escHtml(tool.target || "")}</span>` +
                `</div>`
            )
            .join("");
          const thinkHtml = hasThinking
            ? `<div class="thinking-snippet">${escHtml(msg.thinking.trim())}</div>`
            : "";
          const summaryTitle = hasTools ? t("chat.toolsExecuted", { count: msg.tools.length }) : t("chat.viewThinking");
          toolsHtml = `
            <details class="m3-tool-card">
              <summary>
                ${CHECK_SVG}
                <span class="m3-tool-summary-text">${escHtml(summaryTitle)}</span>
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
                       ${COPY_SVG}<span>${escHtml(t("chat.copyFull"))}</span>
                     </button>
                   </div>`
                : ""
            }
          </div>`;
      }
      frag.appendChild(row);
    }

    list.innerHTML = "";
    list.appendChild(frag);
    state.turnAnchorEls = anchorEls.filter(Boolean);

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
      if (cntEl) cntEl.textContent = t("deliv.countTitle", { count: delivs.length });
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

    if (isInitialBottomSnap || wasNearBottom) {
      if (scrollEl) {
        void scrollEl.offsetHeight;
      }
      scrollToBottomInstant();
      if (isInitialBottomSnap && scrollEl) {
        scrollEl.classList.remove("chat-initial-snap");
      }
      state.activeTurnIndex = state.turns.length;
      updateTurnTriggerUi();
      activateBottomAnchorGuard(3000);
      requestAnimationFrame(() => {
        if (renderGen === state.mediaRenderGen) {
          snapBottomIfAnchored();
        }
      });
    } else if (scrollEl) {
      scrollEl.style.scrollBehavior = "auto";
      scrollEl.scrollTop = prevScrollTop;
      const away = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight > 220;
      $("btn-scroll-bottom")?.classList.toggle("hidden", !away);
      state.activeTurnIndex = computeActiveTurnIndex() || state.turns.length;
      updateTurnTriggerUi();
    }

    if (state.turnNavOpen) {
      renderTurnNavList();
    }

    // Hydrate images AFTER bottom-snap so IntersectionObserver sees the real final viewport immediately
    hydrateMessageImages(list, renderGen);
  }

  function updateStreamingRow() {
    const sRow = $("streaming-row");
    if (!sRow) return;
    const tools = state.streamTools || [];
    const items = tools
      .map(
        (tool) =>
          `<div class="tool-step">` +
            `<span class="tool-step-status ${tool.state === "ACTIVE" ? "active" : ""}">${tool.state === "ACTIVE" ? "●" : "✓"}</span>` +
            `<span class="tool-step-name">${escHtml(tool.name)}</span>` +
            `<span class="tool-step-target">${escHtml(tool.target || "")}</span>` +
          `</div>`
      )
      .join("");

    const summaryText = tools.length
      ? escHtml(t("chat.runningTool", { count: tools.length, name: tools[tools.length - 1].name }))
      : escHtml(t("chat.thinking"));

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

    const { isLive: swarmLive, workingCount: swarmWorking, activeCount: swarmActive } = getSwarmEffectiveStats();
    const showSwarmStrip = Boolean(state.streaming && (state.swarmMode || swarmLive));
    const swarmStripCount = swarmWorking || swarmActive;
    const swarmStripHtml = showSwarmStrip
      ? `<button class="swarm-live-strip" type="button" data-open-swarm="1">
           ${pixelBeeSvg(0, { size: 17, crowned: true, live: true })}
           <span class="swarm-live-strip-dot" aria-hidden="true"></span>
           <span class="swarm-live-strip-text">${escHtml(
             swarmStripCount > 0
               ? t("swarm.streamActiveCount", { count: swarmStripCount })
               : t("swarm.streamActiveGeneric")
           )}</span>
         </button>`
      : "";

    sRow.innerHTML = `
      <div class="assistant-flow">
        <div class="assistant-head">
          <span class="assistant-avatar">${assistantMarkSvg()}</span>
          <span>${escHtml(t("chat.liveOutput", { model: shortModelLabel(state.selectedModel) }))}</span>
        </div>
        ${swarmStripHtml}
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
        const isLoadedHostConv = Boolean(state.currentConv && state.currentConv.id === hostCid);
        const isFollowing = hasValidActiveCid && activeCid === hostCid && (isLoadedHostConv || state.streaming);
        const isSyncingHost = hasValidActiveCid && activeCid === hostCid && !isFollowing;
        followBtn.classList.toggle("following", isFollowing);
        followBtn.setAttribute("aria-disabled", isFollowing ? "true" : "false");
        if (followTxt) {
          followTxt.textContent = isFollowing
            ? t("topbar.following")
            : (isSyncingHost ? t("topbar.syncingHost") : t("topbar.returnHost"));
        }
        followBtn.title = isFollowing
          ? t("topbar.followingTip")
          : (isSyncingHost ? t("topbar.syncingHostTip") : t("topbar.returnHostTip"));
      }
    }

    if (openMainBtn) {
      const canToggle = typeof SIDECAR.toggleConversation === "function";
      const isDesktopBacked = hasValidActiveCid && isDesktopBackedConversation(activeCid, state.currentConv);
      openMainBtn.classList.toggle("hidden", !(canToggle && isDesktopBacked));
    }
  }

  function maybeAutoFollowSidecarConversation(opts = {}) {
    const { forceSwitch = false } = opts || {};
    if (!SIDECAR || state.sidecarUserPicked) return;
    if (state.streaming) return;
    if (!forceSwitch && (state.sidecarAutoFollowed || state.sidecarAutoFollowInFlight)) return;
    const hostCid = getSidecarConversationId();
    if (!hostCid) return;
    if (state.currentCid && state.currentCid !== hostCid) {
      if (!forceSwitch || String(state.currentCid).startsWith("pending-")) return;
    }
    if (state.currentConv && state.currentConv.id === hostCid && state.currentCid === hostCid) {
      state.sidecarAutoFollowed = true;
      updateSidecarHeaderActions();
      return;
    }
    state.sidecarAutoFollowed = false;
    state.sidecarAutoFollowInFlight = true;
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
      el.innerHTML = `<div class="empty-placeholder">${escHtml(t("drawer.noMatch"))}</div>`;
      return;
    }

    el.innerHTML = filtered
      .map((c) => {
        const act = c.id === state.currentCid ? "active" : "";
        let badge = "";
        if (c.status === "running") {
          badge = `<span class="ci-badge run">${escHtml(t("drawer.badgeRun"))}</span>`;
        } else if (c.source === "external") {
          badge = `<span class="ci-badge ext">${escHtml(t("drawer.badgeExt"))}</span>`;
        } else if (c.subSource === "qq_dm") {
          badge = `<span class="ci-badge qqdm">${escHtml(t("drawer.badgeQqdm"))}</span>`;
        } else if (c.source === "mobile") {
          badge = `<span class="ci-badge mob">${escHtml(t("drawer.badgeMob"))}</span>`;
        } else if (c.hasMobile && c.source === "desktop") {
          badge = `<span class="ci-badge sync">${escHtml(t("drawer.badgeSync"))}</span>`;
        }
        const draft = state.drafts[c.id];
        let prevHtml = escHtml(c.preview || c.shortId);
        if (hasDraftContent(draft)) {
          const dTxt = (draft.text || "").trim().replace(/\s+/g, " ");
          const dAtt = draft.attachments && draft.attachments.length ? t("drawer.draftAtt", { count: draft.attachments.length }) : "";
          prevHtml = `<span class="ci-draft-tag">${escHtml(t("drawer.draftTag"))}</span>${escHtml(dTxt || dAtt)}`;
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
      closeTurnNavigator();
      closeContextPopover();
      closeSwarmDrawer();
      stopSwarmPolling();
      saveCurrentDraft(prevKey);
      state.currentCid = cid;
      state.lastRenderedConvFp = "";
      state.currentQueue = [];
      state.editingQueueItemId = "";
      state.editingQueueDraft = "";
      state.currentContext = null;
      state.ctxBreakdownOpen = false;
      state.ctxFetchSeq += 1;
      state.currentSwarmSummary = null;
      state.currentSwarm = null;
      state.swarmSelectedMember = "";
      state.swarmLastRenderFp = "";
      state.swarmLastError = "";
      state.swarmFetchSeq += 1;
      renderQueueTray();
      updateContextPill();
      updateSwarmTopbarPill();
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
      if (autoFollow || (SIDECAR && cid === getSidecarConversationId())) {
        state.sidecarAutoFollowed = true;
      }
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

      setCurrentQueue(Array.isArray(nextConv && nextConv.queue) ? nextConv.queue : []);
      setCurrentContext((nextConv && nextConv.context_window) || null);
      if (nextConv && nextConv.swarm_summary && typeof nextConv.swarm_summary === "object") {
        state.currentSwarmSummary = nextConv.swarm_summary;
      } else if (switching) {
        state.currentSwarmSummary = null;
      }
      updateSwarmTopbarPill();
      syncSwarmPolling();

      if (!switching && nextFp && nextFp === state.lastRenderedConvFp) {
        if (nextRunning) {
          updateStreamingRow();
        }
        updateSidecarHeaderActions();
        updateSendButton();
        return;
      }

      renderConversation({ preserveScroll: silent && !switching });
      if (!silent || switching) {
        renderConvList();
      }
    } catch (e) {
      if (reqSeq !== state.openConvSeq) return;
      if (state.currentCid === cid && (autoFollow || (SIDECAR && cid === getSidecarConversationId()))) {
        if (!state.currentConv) {
          state.currentCid = "";
          state.sidecarAutoFollowed = false;
          restoreDraftFor(NEW_DRAFT_KEY);
        } else if (state.currentConv.id && state.currentConv.id !== cid) {
          state.currentCid = state.currentConv.id;
          state.sidecarAutoFollowed = false;
          restoreDraftFor(state.currentCid);
        }
        renderConvList();
        updateSidecarHeaderActions();
      }
      if (!silent) {
        showToast(t("toast.loadConvFail", { err: e.message }));
      }
    } finally {
      if (autoFollow && reqSeq === state.openConvSeq) {
        state.sidecarAutoFollowInFlight = false;
      }
    }
  }

  function startNewChat() {
    haptic("light");
    state.sidecarUserPicked = true;
    const prevKey = currentDraftKey();
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
    stopSwarmPolling();
    closeDrawer();
    if (prevKey !== NEW_DRAFT_KEY) {
      saveCurrentDraft(prevKey);
      state.openConvSeq += 1;
      state.lastRenderedConvFp = "";
      state.currentCid = "";
      state.currentConv = null;
      state.currentQueue = [];
      state.editingQueueItemId = "";
      state.editingQueueDraft = "";
      state.interruptPendingUntil = 0;
      state.currentContext = null;
      state.ctxBreakdownOpen = false;
      state.ctxFetchSeq += 1;
      state.currentSwarmSummary = null;
      state.currentSwarm = null;
      state.swarmSelectedMember = "";
      state.swarmLastRenderFp = "";
      state.swarmLastError = "";
      state.swarmFetchSeq += 1;
      state.streaming = false;
      state.streamBuffer = "";
      state.streamTools = [];
      renderQueueTray();
      updateContextPill();
      updateSwarmTopbarPill();
      restoreDraftFor(NEW_DRAFT_KEY);
      renderConversation();
      renderConvList();
    } else {
      state.currentQueue = [];
      state.editingQueueItemId = "";
      state.editingQueueDraft = "";
      state.currentContext = null;
      state.currentSwarmSummary = null;
      state.currentSwarm = null;
      state.swarmSelectedMember = "";
      state.swarmLastRenderFp = "";
      renderQueueTray();
      updateContextPill();
      updateSwarmTopbarPill();
      updateSidecarHeaderActions();
    }
    $("prompt-input").focus();
  }

  // =========================================================================
  // 10. SEND / QUEUE / CUT-IN / CANCEL & FILE UPLOADS
  // =========================================================================
  async function sendPromptWithMode(mode = "normal") {
    const normalizedMode = mode === "queue" || mode === "interrupt" ? mode : "normal";
    const inp = $("prompt-input");
    const rawText = inp ? inp.value : "";
    const text = rawText.trim();
    if (!text && !state.attachments.length) return;

    haptic("light");
    closeContextPopover();

    const sendDraftKey = currentDraftKey();
    const prevAttachments = state.attachments.slice();
    const attPaths = prevAttachments.map((a) => a.path);

    // Queue or Cut-in while streaming on an active conversation
    if (normalizedMode === "queue" || normalizedMode === "interrupt") {
      if (!state.currentCid) {
        return sendPromptWithMode("normal");
      }

      delete state.drafts[sendDraftKey];
      persistHostDrafts();
      if (inp) {
        inp.value = "";
        inp.style.height = "auto";
      }
      state.attachments = [];
      renderAttachTray();

      const targetCid = state.currentCid;
      if (normalizedMode === "interrupt") {
        state.interruptPendingUntil = Date.now() + 4500;
      }

      try {
        const res = await apiFetch("/api/chat/send", {
          method: "POST",
          body: JSON.stringify({
            conversation_id: targetCid,
            prompt: text,
            model: state.selectedModel,
            attachments: attPaths,
            swarm_mode: state.swarmMode,
            mode: normalizedMode,
            priority: normalizedMode === "interrupt" ? "urgent" : "normal",
          }),
        });

        if (state.currentCid === targetCid) {
          if (Array.isArray(res.queue)) {
            setCurrentQueue(res.queue);
          } else if (normalizedMode === "queue" && res.item) {
            setCurrentQueue([...state.currentQueue, res.item]);
          }
          if (normalizedMode === "queue") {
            if (res.queued === false) {
              // Active run ended right before queue request arrived; server started immediately
              if (state.currentConv) {
                const msgs = state.currentConv.messages || [];
                const last = msgs[msgs.length - 1];
                if (!(last && last.role === "user" && (last.text || "").trim() === text)) {
                  msgs.push({
                    role: "user",
                    text,
                    attachments: prevAttachments,
                    time: new Date().toISOString(),
                  });
                }
              }
              state.streaming = true;
              state.streamBuffer = "";
              state.streamTools = [];
              renderConversation();
            } else {
              showToast(t("toast.queuedPrompt"));
            }
          } else {
            state.streaming = true;
            state.streamBuffer = "";
            state.streamTools = [];
            updateSendButton();
            renderQueueTray();
            showToast(t("toast.cutinSent"));
          }
        }
        refreshConversationsThrottled(400);
      } catch (e) {
        if (normalizedMode === "interrupt") {
          state.interruptPendingUntil = 0;
        }
        if (currentDraftKey() === sendDraftKey) {
          if (inp) {
            inp.value = rawText;
            resizePromptInput();
          }
          state.attachments = prevAttachments;
          renderAttachTray();
          saveCurrentDraft(sendDraftKey);
        } else {
          state.drafts[sendDraftKey] = { text: rawText, attachments: prevAttachments };
          persistHostDrafts();
        }
        showToast(
          normalizedMode === "interrupt"
            ? t("toast.cutinFail", { err: e.message })
            : t("toast.queueFail", { err: e.message })
        );
      }
      return;
    }

    const createdNewConv = !state.currentConv;
    if (createdNewConv) {
      state.sidecarUserPicked = true;
      state.currentConv = {
        id: "",
        title: text.slice(0, 36) || (prevAttachments[0]?.name || t("chat.newConvTitle")),
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
    if (inp) {
      inp.value = "";
      inp.style.height = "auto";
    }
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
          mode: "normal",
          priority: "normal",
        }),
      });
      if (sendSeq === state.openConvSeq) {
        if (res.queued === true) {
          // Race condition: another device started streaming right before our normal send
          const msgIdx = targetConv.messages.lastIndexOf(optimisticMsg);
          if (msgIdx !== -1) {
            targetConv.messages.splice(msgIdx, 1);
          }
          if (Array.isArray(res.queue)) {
            setCurrentQueue(res.queue);
          } else if (res.item) {
            setCurrentQueue([...state.currentQueue, res.item]);
          }
          renderConversation({ preserveScroll: true });
          showToast(t("toast.queuedPrompt"));
          return;
        }
        const nextCid = res.conversation_id;
        if (
          nextCid &&
          !(String(nextCid).startsWith("pending-") && state.currentCid && !state.currentCid.startsWith("pending-"))
        ) {
          state.currentCid = nextCid;
          if (state.currentConv) state.currentConv.id = nextCid;
          updateSidecarHeaderActions();
        }
        if (Array.isArray(res.queue)) {
          setCurrentQueue(res.queue);
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
        if (inp) {
          inp.value = rawText;
          resizePromptInput();
        }
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
      showToast(t("toast.sendFail", { err: e.message }));
    }
  }

  async function handleSendOrStop() {
    haptic("light");
    if (state.streaming && state.currentCid) {
      try {
        await apiFetch(`/api/chat/cancel/${encodeURIComponent(state.currentCid)}`, { method: "POST" });
        state.interruptPendingUntil = 0;
        state.streaming = false;
        updateSendButton();
        renderQueueTray();
        showToast(t("toast.stoppedTask"));
      } catch (e) {
        showToast(t("toast.stopFail", { err: e.message }));
      }
      return;
    }
    return sendPromptWithMode("normal");
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
        let imgTag = "";
        if (a.is_image && host && (a.preview_url || a.path)) {
          const apiPath = buildPreviewApiPath(a.preview_url, a.path);
          const cacheKey = makeMediaCacheKey(host, apiPath);
          if (SIDECAR) {
            const cached = touchAuthMediaEntry(cacheKey);
            const srcAttr = cached ? `src="${escHtml(cached.dataUrl || cached.blobUrl)}" data-media-loaded="1"` : "";
            imgTag = `<img ${srcAttr} data-media-path="${escHtml(apiPath)}" data-media-key="${escHtml(cacheKey)}" alt="" />`;
          } else {
            const directUrl = buildDirectMediaUrl(host, apiPath);
            imgTag = directUrl ? `<img src="${escHtml(directUrl)}" data-media-path="${escHtml(apiPath)}" alt="" />` : "";
          }
        }
        return `
          <div class="attach-chip">
            ${imgTag}
            <span>${escHtml((a.name || t("chat.fileFallback")).slice(0, 18))}</span>
            <button type="button" data-rm="${idx}" aria-label="${escHtml(t("chat.removeAttachAria"))}">✕</button>
          </div>`;
      })
      .join("");
    if (SIDECAR && host) {
      tray.querySelectorAll("img[data-media-path]").forEach((img) => {
        if (img.dataset.mediaLoaded !== "1") {
          loadThumbImgViaAuthFetch(img, undefined, { priority: 0, scope: "standalone" });
        }
      });
    }
    updateSendButton();
  }

  async function uploadFiles(fileList) {
    const targetKey = currentDraftKey();
    for (const f of Array.from(fileList || [])) {
      showToast(t("toast.uploading", { name: f.name }));
      const fd = new FormData();
      fd.append("file", f, f.name);
      try {
        const res = await apiFetch("/api/upload", { method: "POST", body: fd });
        appendUploadedAttachment(res, targetKey);
        haptic("light");
        const kindTag = res.is_image ? t("toast.kindOrigImg") : t("toast.kindOrigFile");
        showToast(t("toast.uploaded", { kind: kindTag, name: f.name, size: formatSize(res.size) }));
      } catch (e) {
        showToast(t("toast.uploadFail", { err: e.message }));
      }
    }
  }

  function uploadNativeMediaPhoto(photo) {
    return new Promise((resolve, reject) => {
      const host = getActiveHost();
      if (!host || !host.url) {
        reject(new Error(t("err.noHost")));
        return;
      }
      if (!window.AndroidBridge?.uploadMediaImage) {
        reject(new Error(t("err.noNativeAlbum")));
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
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
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
        .join("") || `<div class="empty-placeholder">${escHtml(t("sheet.modelEmpty"))}</div>`;

    $("host-sheet").classList.add("hidden");
    $("attach-sheet")?.classList.add("hidden");
    $("sheet-backdrop").classList.remove("hidden");
    $("model-sheet").classList.remove("hidden");
  }

  function renderHostSheetList() {
    const el = $("host-sheet-list");
    if (!el) return;
    if (!state.hosts.length) {
      el.innerHTML = `<div class="empty-placeholder">${escHtml(t("sheet.hostEmpty"))}</div>`;
      return;
    }
    el.innerHTML = state.hosts
      .map((h) => {
        const isAct = h.id === state.activeHostId;
        return `
          <button class="host-sheet-item ${isAct ? "active" : ""}" type="button" data-hid="${escHtml(h.id)}">
            <span class="conn-dot ${isAct ? (state.wsConnected ? "online" : "connecting") : ""}"></span>
            <div class="host-sheet-meta">
              <div class="host-sheet-name">${escHtml(formatHostDisplayName(h.name))}</div>
              <div class="host-sheet-url">${escHtml(h.url)}</div>
            </div>
            ${isAct ? CHECK_SVG : ""}
          </button>`;
      })
      .join("");
  }

  function openHostSheet() {
    haptic("light");
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
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
      btn.textContent = cnt > 0 ? t("sheet.addCount", { count: cnt }) : t("sheet.add");
    }
  }

  function loadRecentPhotosInSheet(autoRequestPerm = false) {
    const strip = $("attach-photo-strip");
    if (!strip) return;

    if (!window.AndroidBridge?.getRecentPhotosJson) {
      strip.innerHTML = `
        <div class="photo-perm-card">
          <div class="photo-perm-title">${escHtml(t("sheet.photoQuickTitle"))}</div>
          <div class="photo-perm-desc">${escHtml(t("sheet.photoQuickDesc"))}</div>
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
          <div class="photo-perm-title">${escHtml(t("sheet.photoPermTitle"))}</div>
          <div class="photo-perm-desc">${escHtml(t("sheet.photoPermDesc"))}</div>
          <button id="btn-grant-media-perm" class="m3-btn tonal sm" type="button">${escHtml(t("sheet.photoGrantBtn"))}</button>
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
          <div class="photo-perm-title">${escHtml(t("sheet.photoEmptyTitle"))}</div>
          <div class="photo-perm-desc">${escHtml(t("sheet.photoEmptyDesc"))}</div>
          ${state.recentPhotosPartial ? `<button id="btn-grant-media-perm" class="m3-btn tonal sm" type="button">${escHtml(t("sheet.photoAddMore"))}</button>` : ""}
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
          <button class="photo-tile" type="button" data-pid="${Number(p.id)}" style="width:${cardW}px" aria-label="${escHtml(p.name || t("sheet.photoAlt"))}">
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
           <span>${t("sheet.photoManageMore")}</span>
         </button>`
      : "";

    strip.innerHTML = tilesHtml + manageTile;
    strip.scrollLeft = 0;
    updateAttachSelectionUi();
  }

  function openAttachSheet() {
    haptic("light");
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
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
      showToast(
        picked.length > 1
          ? t("toast.uploadingOrigMulti", { cur: i + 1, total: picked.length })
          : t("toast.uploadingOrigOne", { name: p.name })
      );
      try {
        const res = await uploadNativeMediaPhoto(p);
        appendUploadedAttachment(res, targetKey);
        succeeded += 1;
        lastSucceededName = p.name || "";
        haptic("light");
      } catch (err) {
        showToast(t("toast.uploadItemFail", { name: p.name, err: err.message }));
      }
    }
    if (succeeded > 1) {
      showToast(
        succeeded === picked.length
          ? t("toast.addedOrigAll", { ok: succeeded })
          : t("toast.addedOrigPart", { ok: succeeded, total: picked.length })
      );
    } else if (succeeded === 1) {
      showToast(
        picked.length === 1
          ? t("toast.addedOrigOne", { name: lastSucceededName })
          : t("toast.addedOrigOnePart", { total: picked.length })
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
    list.innerHTML = `<div class="empty-placeholder">${escHtml(t("files.reading"))}</div>`;
    try {
      const qs = dirPath ? `?dir=${encodeURIComponent(dirPath)}` : "";
      const data = await apiFetch(`/api/files${qs}`);
      state.currentDir = data.dir || "";
      $("files-path").textContent = data.dir || t("files.workspace");
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
                  <div class="file-meta">${it.is_dir ? escHtml(t("files.folder")) : formatSize(it.size)}</div>
                </div>
              </div>`;
          })
          .join("") || `<div class="empty-placeholder">${escHtml(t("files.emptyDir"))}</div>`;
    } catch (e) {
      list.innerHTML = `<div class="empty-placeholder">${escHtml(t("files.readError", { err: e.message }))}</div>`;
    }
  }

  let _previewLoadSeq = 0;
  let activePreviewZoom = null;

  function destroyPreviewZoom() {
    if (activePreviewZoom) {
      try {
        activePreviewZoom.destroy();
      } catch (_) {}
      activePreviewZoom = null;
    }
    const bodyEl = $("preview-body");
    if (bodyEl) {
      bodyEl.classList.remove("preview-img-stage", "is-zoomed", "is-dragging", "is-animating");
    }
  }

  function closePreviewModal() {
    const modal = $("preview-modal");
    if (modal) modal.classList.add("hidden");
    destroyPreviewZoom();
    state.previewFile = null;
  }

  function createPreviewImageZoomController(stageEl, imgEl, pillEl) {
    const MIN_SCALE = 1;
    const MAX_SCALE = 6;
    const DOUBLE_TAP_SCALE = 2.5;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let animTimer = null;

    let pinchActive = false;
    let pinchDist0 = 0;
    let pinchMidX0 = 0;
    let pinchMidY0 = 0;
    let pinchScale0 = 1;
    let pinchTx0 = 0;
    let pinchTy0 = 0;

    let touchDragActive = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragTx0 = 0;
    let dragTy0 = 0;
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    let mouseDragActive = false;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    const clampOffsets = (nx, ny, s) => {
      if (s <= 1.001) return { x: 0, y: 0 };
      const sw = stageEl.clientWidth || 1;
      const sh = stageEl.clientHeight || 1;
      const bw = imgEl.offsetWidth || imgEl.clientWidth || sw;
      const bh = imgEl.offsetHeight || imgEl.clientHeight || sh;
      const maxTx = Math.max(0, (bw * s - sw) / 2);
      const maxTy = Math.max(0, (bh * s - sh) / 2);
      return {
        x: clamp(nx, -maxTx, maxTx),
        y: clamp(ny, -maxTy, maxTy),
      };
    };

    const updatePill = () => {
      if (!pillEl) return;
      const isZoomed = scale > 1.005;
      pillEl.classList.toggle("hidden", !isZoomed);
      if (isZoomed) {
        pillEl.textContent = t("preview.zoomReset", { pct: Math.round(scale * 100) });
      }
      pillEl.setAttribute("aria-label", t("preview.zoomResetAria"));
    };

    const applyTransform = (animate = false) => {
      clearTimeout(animTimer);
      if (animate) {
        stageEl.classList.add("is-animating");
        animTimer = setTimeout(() => {
          stageEl.classList.remove("is-animating");
        }, 215);
      } else {
        stageEl.classList.remove("is-animating");
      }
      const isZoomed = scale > 1.005;
      stageEl.classList.toggle("is-zoomed", isZoomed);
      imgEl.dataset.zoomScale = scale.toFixed(2);
      imgEl.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
      updatePill();
    };

    const reset = (animate = true) => {
      scale = 1;
      tx = 0;
      ty = 0;
      applyTransform(animate);
    };

    const zoomAt = (nextScale, clientX, clientY, animate = false) => {
      const clampedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      if (clampedScale <= 1.005) {
        reset(animate);
        return;
      }
      const rect = stageEl.getBoundingClientRect();
      const ox = clientX - (rect.left + rect.width / 2);
      const oy = clientY - (rect.top + rect.height / 2);
      const ratio = clampedScale / scale;
      const rawTx = ox - (ox - tx) * ratio;
      const rawTy = oy - (oy - ty) * ratio;
      const clamped = clampOffsets(rawTx, rawTy, clampedScale);
      scale = clampedScale;
      tx = clamped.x;
      ty = clamped.y;
      applyTransform(animate);
    };

    const getPinchMetrics = (t0, t1) => {
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      return {
        dist: Math.hypot(dx, dy),
        midX: (t0.clientX + t1.clientX) / 2,
        midY: (t0.clientY + t1.clientY) / 2,
      };
    };

    const onTouchStart = (e) => {
      if (e.target && e.target.closest && e.target.closest("#preview-zoom-pill")) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        touchDragActive = false;
        lastTapAt = 0;
        const m = getPinchMetrics(e.touches[0], e.touches[1]);
        pinchActive = true;
        pinchDist0 = Math.max(1, m.dist);
        pinchMidX0 = m.midX;
        pinchMidY0 = m.midY;
        pinchScale0 = scale;
        pinchTx0 = tx;
        pinchTy0 = ty;
        stageEl.classList.remove("is-animating");
        return;
      }
      if (e.touches.length === 1) {
        const t0 = e.touches[0];
        const now = Date.now();
        if (now - lastTapAt < 300 && Math.hypot(t0.clientX - lastTapX, t0.clientY - lastTapY) < 36) {
          e.preventDefault();
          lastTapAt = 0;
          touchDragActive = false;
          if (scale > 1.05) {
            reset(true);
          } else {
            zoomAt(DOUBLE_TAP_SCALE, t0.clientX, t0.clientY, true);
          }
          return;
        }
        lastTapAt = now;
        lastTapX = t0.clientX;
        lastTapY = t0.clientY;
        if (scale > 1.005) {
          e.preventDefault();
          touchDragActive = true;
          dragStartX = t0.clientX;
          dragStartY = t0.clientY;
          dragTx0 = tx;
          dragTy0 = ty;
          stageEl.classList.remove("is-animating");
        }
      }
    };

    const onTouchMove = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const m = getPinchMetrics(e.touches[0], e.touches[1]);
        if (!pinchActive) {
          pinchActive = true;
          pinchDist0 = Math.max(1, m.dist);
          pinchMidX0 = m.midX;
          pinchMidY0 = m.midY;
          pinchScale0 = scale;
          pinchTx0 = tx;
          pinchTy0 = ty;
          return;
        }
        const nextScale = clamp(pinchScale0 * (m.dist / pinchDist0), MIN_SCALE, MAX_SCALE);
        const rect = stageEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const ox0 = pinchMidX0 - cx;
        const oy0 = pinchMidY0 - cy;
        const ox1 = m.midX - cx;
        const oy1 = m.midY - cy;
        const ratio = nextScale / pinchScale0;
        const rawTx = ox1 - (ox0 - pinchTx0) * ratio;
        const rawTy = oy1 - (oy0 - pinchTy0) * ratio;
        const clamped = clampOffsets(rawTx, rawTy, nextScale);
        scale = nextScale;
        tx = clamped.x;
        ty = clamped.y;
        applyTransform(false);
        return;
      }
      if (e.touches.length === 1 && touchDragActive && scale > 1.005) {
        e.preventDefault();
        const t0 = e.touches[0];
        const clamped = clampOffsets(dragTx0 + (t0.clientX - dragStartX), dragTy0 + (t0.clientY - dragStartY), scale);
        tx = clamped.x;
        ty = clamped.y;
        applyTransform(false);
      }
    };

    const onTouchEnd = (e) => {
      if (pinchActive && e.touches.length === 1) {
        pinchActive = false;
        if (scale > 1.005) {
          const t0 = e.touches[0];
          touchDragActive = true;
          dragStartX = t0.clientX;
          dragStartY = t0.clientY;
          dragTx0 = tx;
          dragTy0 = ty;
        }
        return;
      }
      if (e.touches.length === 0) {
        pinchActive = false;
        touchDragActive = false;
        if (scale < 1.02) {
          reset(true);
        }
      }
    };

    const onWheel = (e) => {
      e.preventDefault();
      const clampedDelta = clamp(e.deltaY, -160, 160);
      const factor = Math.exp(-clampedDelta * 0.0032);
      const nextScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
      zoomAt(nextScale, e.clientX, e.clientY, false);
    };

    const onMouseMove = (e) => {
      if (!mouseDragActive || scale <= 1.005) return;
      e.preventDefault();
      const clamped = clampOffsets(dragTx0 + (e.clientX - dragStartX), dragTy0 + (e.clientY - dragStartY), scale);
      tx = clamped.x;
      ty = clamped.y;
      applyTransform(false);
    };

    const onMouseUp = () => {
      if (!mouseDragActive) return;
      mouseDragActive = false;
      stageEl.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest("#preview-zoom-pill")) return;
      if (scale <= 1.005) return;
      e.preventDefault();
      mouseDragActive = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragTx0 = tx;
      dragTy0 = ty;
      stageEl.classList.add("is-dragging");
      stageEl.classList.remove("is-animating");
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    };

    const onDblClick = (e) => {
      if (e.target && e.target.closest && e.target.closest("#preview-zoom-pill")) return;
      e.preventDefault();
      if (scale > 1.05) {
        reset(true);
      } else {
        zoomAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY, true);
      }
    };

    const onPillClick = (e) => {
      e.stopPropagation();
      haptic("light");
      reset(true);
    };

    const onResize = () => {
      if (scale <= 1.005) return;
      const clamped = clampOffsets(tx, ty, scale);
      tx = clamped.x;
      ty = clamped.y;
      applyTransform(false);
    };

    stageEl.addEventListener("touchstart", onTouchStart, { passive: false });
    stageEl.addEventListener("touchmove", onTouchMove, { passive: false });
    stageEl.addEventListener("touchend", onTouchEnd, { passive: true });
    stageEl.addEventListener("touchcancel", onTouchEnd, { passive: true });
    stageEl.addEventListener("wheel", onWheel, { passive: false });
    stageEl.addEventListener("mousedown", onMouseDown);
    stageEl.addEventListener("dblclick", onDblClick);
    pillEl?.addEventListener("click", onPillClick);
    window.addEventListener("resize", onResize);

    applyTransform(false);

    return {
      reset,
      updateLabel: updatePill,
      getScale: () => scale,
      destroy() {
        clearTimeout(animTimer);
        mouseDragActive = false;
        stageEl.removeEventListener("touchstart", onTouchStart);
        stageEl.removeEventListener("touchmove", onTouchMove);
        stageEl.removeEventListener("touchend", onTouchEnd);
        stageEl.removeEventListener("touchcancel", onTouchEnd);
        stageEl.removeEventListener("wheel", onWheel);
        stageEl.removeEventListener("mousedown", onMouseDown);
        stageEl.removeEventListener("dblclick", onDblClick);
        pillEl?.removeEventListener("click", onPillClick);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("resize", onResize);
        stageEl.classList.remove("preview-img-stage", "is-zoomed", "is-dragging", "is-animating");
      },
    };
  }

  function mountZoomablePreviewImage(bodyEl, imgEl) {
    destroyPreviewZoom();
    bodyEl.innerHTML = "";
    bodyEl.classList.add("preview-img-stage");
    imgEl.draggable = false;
    const pill = document.createElement("button");
    pill.id = "preview-zoom-pill";
    pill.className = "preview-zoom-pill hidden";
    pill.type = "button";
    pill.setAttribute("aria-label", t("preview.zoomResetAria"));
    bodyEl.appendChild(imgEl);
    bodyEl.appendChild(pill);
    activePreviewZoom = createPreviewImageZoomController(bodyEl, imgEl, pill);
  }

  async function openFilePreview(path, name) {
    const host = getActiveHost();
    if (!host) return;
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
    destroyPreviewZoom();
    const previewSeq = ++_previewLoadSeq;
    state.previewFile = { path, name };
    $("preview-name").textContent = name || path.split("/").pop();
    $("preview-meta").textContent = path;
    const bodyEl = $("preview-body");
    bodyEl.innerHTML = `<div class="empty-placeholder">${escHtml(t("preview.loading"))}</div>`;
    $("preview-modal").classList.remove("hidden");

    const ext = (path.split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) {
      const apiPath = buildPreviewApiPath("", path);
      const renderPreviewError = (errMsg) => {
        if (previewSeq !== _previewLoadSeq) return;
        destroyPreviewZoom();
        const detail = errMsg ? (I18N.isEn() ? ` (${errMsg})` : `（${errMsg}）`) : "";
        bodyEl.innerHTML = `
          <div class="m3-card preview-img-error">
            <p class="info-text">${escHtml(t("preview.imgError", { detail }))}</p>
            <button id="btn-preview-retry" class="m3-btn tonal sm" type="button">${escHtml(t("preview.retryImg"))}</button>
          </div>`;
        $("btn-preview-retry")?.addEventListener("click", () => {
          openFilePreview(path, name);
        }, { once: true });
      };

      const mountBlobImage = async (forceReload = false) => {
        try {
          const entry = await fetchAuthMediaEntry(apiPath, host, { priority: 0, forceReload, scope: "standalone" });
          if (previewSeq !== _previewLoadSeq) return;
          const img = document.createElement("img");
          img.alt = name || "";
          img.decoding = "async";
          img.dataset.mediaKey = makeMediaCacheKey(host, apiPath);
          img.onerror = async () => {
            if (previewSeq !== _previewLoadSeq) return;
            if (!img.dataset.dataUrlFallback && entry.blob && entry.blob.size <= 10 * 1024 * 1024) {
              img.dataset.dataUrlFallback = "1";
              try {
                if (!entry.dataUrl) entry.dataUrl = await blobToDataUrl(entry.blob);
                if (entry.dataUrl && previewSeq === _previewLoadSeq) {
                  img.src = entry.dataUrl;
                  return;
                }
              } catch (_) {}
            }
            renderPreviewError(t("preview.decodeErr"));
          };
          img.src = entry.dataUrl || entry.blobUrl;
          mountZoomablePreviewImage(bodyEl, img);
        } catch (err) {
          if (previewSeq !== _previewLoadSeq || $("preview-modal")?.classList.contains("hidden")) return;
          renderPreviewError(err && err.name === "AbortError" ? t("preview.abortErr") : (err ? err.message : ""));
        }
      };

      if (SIDECAR) {
        await mountBlobImage(false);
        return;
      }

      const directUrl = buildDirectMediaUrl(host, apiPath);
      const img = document.createElement("img");
      img.alt = name || "";
      img.decoding = "async";
      img.onerror = () => {
        if (previewSeq !== _previewLoadSeq) return;
        if (!img.dataset.authFallbackTried) {
          img.dataset.authFallbackTried = "1";
          mountBlobImage(true);
        } else {
          renderPreviewError(t("preview.netErr"));
        }
      };
      img.src = directUrl;
      mountZoomablePreviewImage(bodyEl, img);
      return;
    }

    try {
      const data = await apiFetch(`/api/files/preview?path=${encodeURIComponent(path)}`);
      if (previewSeq !== _previewLoadSeq) return;
      if (typeof Response !== "undefined" && data instanceof Response) {
        const txt = await data.text();
        bodyEl.innerHTML = `<pre>${escHtml(txt.slice(0, 65536) || t("preview.emptyFile"))}</pre>`;
      } else if (data.binary) {
        bodyEl.innerHTML = `<div class="m3-card"><p class="info-text">${escHtml(t("preview.binaryMsg", { size: formatSize(data.size) }))}</p></div>`;
      } else {
        bodyEl.innerHTML = `<pre>${escHtml(data.content || t("preview.emptyFile"))}</pre>`;
      }
    } catch (e) {
      if (previewSeq !== _previewLoadSeq) return;
      bodyEl.innerHTML = `<div class="m3-card"><p class="info-text">${escHtml(t("preview.fail", { err: e.message }))}</p></div>`;
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
        hint.innerHTML = t("settings.dlHintAsk");
      } else {
        const pathTxt = sub ? `Download/${escHtml(sub)}/` : "Download/";
        hint.innerHTML = t("settings.dlHintSubdir", { path: pathTxt });
      }
    }
  }

  function triggerDownload(path, name) {
    const host = getActiveHost();
    if (!host) return;
    const filename = name || path.split("/").pop() || "download";
    const url = withSidecarToken(
      `${getApiBase(host)}/api/files/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(host.token)}`
    );
    const subdir = sanitizeSubdirInput(state.downloadSubdir);
    const ask = Boolean(state.downloadAskFolder);
    haptic("light");
    if (window.AndroidBridge?.downloadFileWithOptions) {
      try {
        window.AndroidBridge.downloadFileWithOptions(url, filename, subdir, ask);
        if (!ask) {
          const dest = subdir ? `Download/${subdir}/` : "Download/";
          showToast(t("toast.downloadStarted", { dest }));
        }
        return;
      } catch (_) {}
    }
    if (window.AndroidBridge?.downloadFile) {
      try {
        window.AndroidBridge.downloadFile(url, filename);
        showToast(t("toast.downloadDefault"));
        return;
      } catch (_) {}
    }
    if (SIDECAR) {
      const dlApiPath = `/api/files/download?path=${encodeURIComponent(path)}`;
      fetch(dlApiPath, {
        method: "GET",
        headers: host.token ? { Authorization: `Bearer ${host.token}` } : {},
      })
        .then((resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.blob();
        })
        .then((blob) => {
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = filename;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => {
            try { URL.revokeObjectURL(blobUrl); } catch (_) {}
          }, 60000);
        })
        .catch(() => {
          window.open(url, "_blank", "noopener");
        });
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function fmtTokens(n) {
    return I18N.fmtTokens(n);
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
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
    closeDrawer();
    $("settings-modal")?.classList.add("hidden");
    $("usage-modal")?.classList.remove("hidden");
    loadUsageData();
  }

  async function loadUsageData() {
    const body = $("usage-body");
    if (!body) return;
    body.innerHTML = `<div class="empty-placeholder">${escHtml(t("usage.loading"))}</div>`;
    try {
      const qs = state.currentCid ? `?cid=${encodeURIComponent(state.currentCid)}` : "";
      const data = await apiFetch(`/api/usage${qs}`);
      state.usageData = data;
      const sub = $("usage-subtitle");
      if (sub) {
        const cnt = Number(data.scanned_conversations || 0);
        const tStr = fmtLocalTime(data.generated_at);
        sub.textContent = t("usage.subScanned", { cnt, time: tStr || t("usage.justNow") });
      }
      renderUsageView();
    } catch (e) {
      body.innerHTML = `<div class="m3-card"><p class="info-text">${escHtml(t("usage.queryFail", { err: e.message || t("err.unknown") }))}</p></div>`;
    }
  }

  function fmtResetTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      const diffMs = d.getTime() - Date.now();
      const dtStr = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      if (diffMs > 0) {
        const hrs = Math.floor(diffMs / 3600000);
        const days = Math.floor(hrs / 24);
        const remH = hrs % 24;
        const left = I18N.fmtResetLeft(days, remH, hrs);
        return `${dtStr} (${left})`;
      }
      return dtStr;
    } catch (_) {
      return String(iso);
    }
  }

  function renderUsageView() {
    const body = $("usage-body");
    const data = state.usageData;
    if (!body || !data) return;

    const rawWin = state.usageWindow || "5h";
    const win = rawWin === "24h" ? "today" : rawWin;
    document.querySelectorAll("[data-usage-win]").forEach((btn) => {
      const active = btn.dataset.usageWin === win;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    const bucket =
      win === "5h"
        ? data.window_5h
        : win === "today"
        ? (data.window_today || data.window_24h)
        : win === "3d"
        ? data.window_3d
        : win === "7d"
        ? data.window_7d
        : data.current_conversation;

    const parts = [];
    const isEn = I18N.isEn();

    // Live Antigravity-ONLY Remaining Quota Card (from optional local bridge or AGY_QUOTA_API_URL)
    if (data.external_quota && Array.isArray(data.external_quota.pools) && data.external_quota.pools.length) {
      const planBadge = data.external_quota.plan
        ? `<span class="usage-plan-badge">${escHtml(data.external_quota.plan)}</span>`
        : "";
      const extRows = data.external_quota.pools
        .map((p) => {
          const hasH5 = p.h5_pct !== null && p.h5_pct !== undefined;
          const hasWk = p.weekly_pct !== null && p.weekly_pct !== undefined;
          const h5 = hasH5 ? Math.max(0, Math.min(100, Number(p.h5_pct))) : null;
          const wk = hasWk ? Math.max(0, Math.min(100, Number(p.weekly_pct))) : (p.remaining_pct !== null && p.remaining_pct !== undefined ? Math.max(0, Math.min(100, Number(p.remaining_pct))) : null);
          const barCls = (v) => (v === null ? "" : v <= 20 ? "low" : v <= 50 ? "warn" : "ok");
          const rst = p.reset_at ? escHtml(t("usage.resetPrefix", { time: fmtResetTime(p.reset_at) })) : "";

          if (h5 !== null && wk !== null) {
            return `
              <div class="usage-pool-row">
                <div class="usage-pool-top">
                  <span class="usage-pool-name">${escHtml(p.name || t("usage.poolFallback"))}</span>
                  <span class="usage-pool-meta">${rst || escHtml(p.note || "")}</span>
                </div>
                <div class="usage-quota-subbars">
                  <div>
                    <div class="usage-quota-mini-label"><span>${escHtml(t("usage.h5Remain"))}</span><strong>${h5.toFixed(1)}%</strong></div>
                    <div class="usage-bar-track"><div class="usage-bar-fill ${barCls(h5)}" style="width:${h5}%"></div></div>
                  </div>
                  <div>
                    <div class="usage-quota-mini-label"><span>${escHtml(t("usage.wkRemain"))}</span><strong>${wk.toFixed(1)}%</strong></div>
                    <div class="usage-bar-track"><div class="usage-bar-fill ${barCls(wk)}" style="width:${wk}%"></div></div>
                  </div>
                </div>
              </div>`;
          }
          const pct = wk;
          const pctTxt = pct !== null ? escHtml(t("usage.remainPct", { pct: pct.toFixed(1) })) : "--";
          const note = p.note ? ` · ${escHtml(p.note)}` : "";
          return `
            <div class="usage-pool-row">
              <div class="usage-pool-top">
                <span class="usage-pool-name">${escHtml(p.name || t("usage.poolFallback"))}</span>
                <span class="usage-pool-meta">${pctTxt}${rst ? ` · ${rst}` : ""}${note}</span>
              </div>
              <div class="usage-bar-track"><div class="usage-bar-fill ${barCls(pct)}" style="width:${pct !== null ? pct : 0}%"></div></div>
            </div>`;
        })
        .join("");
      const extHeading = isEn
        ? t("usage.extQuotaDefault")
        : (data.external_quota.source || t("usage.extQuotaDefault"));
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">${escHtml(extHeading)}${planBadge}</div>
          <div class="usage-pool-list">${extRows}</div>
        </div>`);
    }

    if (!bucket) {
      parts.push(`<div class="m3-card"><div class="empty-placeholder">${escHtml(win === "conv" ? t("usage.openConvFirst") : t("usage.noWindowData"))}</div></div>`);
      body.innerHTML = parts.join("");
      return;
    }

    const totalTok = Number(bucket.total_tokens || 0);
    const inTok = Number(bucket.input_tokens || 0);
    const caTok = Number(bucket.cache_read_tokens || 0);
    const outTok = Number(bucket.output_tokens || 0);
    const steps = Number(bucket.steps || 0);
    const hitPct = Number(bucket.cache_hit_pct || 0);
    const costCny = Number(bucket.cost_cny || 0);
    const costUsd = Number(bucket.cost_usd || 0);
    const quotaEst = Number(bucket.quota_used_est_pct || 0);
    const reliefTxt = win === "5h" && bucket.relief_at ? t("usage.reliefSuffix", { time: fmtLocalTime(bucket.relief_at) }) : "";
    const primaryCost = isEn ? `$${costUsd.toFixed(2)}` : `¥${costCny.toFixed(2)}`;
    const costSub = t("usage.statCostSub", {
      usd: costUsd.toFixed(2),
      cny: costCny.toFixed(2),
      pct: quotaEst.toFixed(1),
    });
    const stepsHeading = win === "conv" && bucket.turns ? t("usage.statStepsTurns") : t("usage.statSteps");
    const stepsVal = win === "conv" && bucket.turns
      ? t("usage.statStepsTurnsVal", { steps, turns: bucket.turns })
      : t("usage.statStepsVal", { steps });

    parts.push(`
      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-k">${escHtml(t("usage.statCostTitle"))}</div>
          <div class="stat-v" style="color:var(--md-primary)">${primaryCost}</div>
          <div class="stat-sub" style="font-size:11px;color:var(--md-text-secondary);margin-top:2px;">${escHtml(costSub)}</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">${escHtml(t("usage.statTokenTitle"))}</div>
          <div class="stat-v">${escHtml(fmtTokens(totalTok))}</div>
          <div class="stat-sub" style="font-size:11px;color:var(--md-success);margin-top:2px;">${escHtml(t("usage.statCacheHit", { pct: hitPct.toFixed(1) }))}</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">${escHtml(stepsHeading)}</div>
          <div class="stat-v">${escHtml(stepsVal)}</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">${escHtml(t("usage.statInOut"))}</div>
          <div class="stat-v" style="font-size:13.5px">${escHtml(fmtTokens(inTok))} / ${escHtml(fmtTokens(outTok))}</div>
        </div>
      </div>`);

    const pools = Array.isArray(bucket.pools) ? bucket.pools : [];
    if (pools.length) {
      const poolHtml = pools
        .map((p) => {
          const share = Math.max(2, Math.min(100, Number(p.share_pct || 0)));
          const pCny = Number(p.cost_cny || 0);
          const pUsd = Number(p.cost_usd || (pCny / 7.25));
          const pQ = Number(p.quota_used_est_pct || 0);
          const metaStr = t("usage.poolMeta", {
            cny: pCny.toFixed(2),
            usd: pUsd.toFixed(2),
            q: pQ.toFixed(1),
            tok: fmtTokens(p.total_tokens),
            steps: Number(p.steps || 0),
          });
          return `
            <div class="usage-pool-row">
              <div class="usage-pool-top">
                <span class="usage-pool-name">${escHtml(p.label || p.id)}</span>
                <span class="usage-pool-meta">${escHtml(metaStr)}</span>
              </div>
              <div class="usage-bar-track"><div class="usage-bar-fill" style="width:${share}%"></div></div>
            </div>`;
        })
        .join("");
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">${escHtml(t("usage.poolBreakdown"))}</div>
          <div class="usage-pool-list">${poolHtml}</div>
        </div>`);
    } else {
      parts.push(`<div class="m3-card"><div class="empty-placeholder">${escHtml(t("usage.noPoolRecords"))}</div></div>`);
    }

    if ((win === "3d" || win === "7d") && Array.isArray(bucket.daily) && bucket.daily.length) {
      const maxDay = Math.max(1, ...bucket.daily.map((d) => Number(d.total_tokens || 0)));
      const cols = bucket.daily
        .map((d) => {
          const v = Number(d.total_tokens || 0);
          const cny = Number(d.cost_cny || 0);
          const usd = Number(d.cost_usd || (cny / 7.25));
          const pct = v > 0 ? Math.max(6, Math.round((v * 100) / maxDay)) : 0;
          const colVal = isEn ? (usd > 0 ? `$${usd.toFixed(usd >= 10 ? 0 : 1)}` : "0") : (cny > 0 ? `¥${cny.toFixed(0)}` : "0");
          const colTitle = t("usage.dailyColTitle", {
            date: d.date,
            cny: cny.toFixed(2),
            usd: usd.toFixed(2),
            tok: fmtTokens(v),
            steps: Number(d.steps || 0),
          });
          return `
            <div class="usage-daily-col" title="${escHtml(colTitle)}">
              <span class="usage-daily-val">${colVal}</span>
              <div class="usage-daily-bar-wrap"><div class="usage-daily-bar" style="height:${pct}%"></div></div>
              <span class="usage-daily-lbl">${escHtml(d.date)}</span>
            </div>`;
        })
        .join("");
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">${escHtml(win === "3d" ? t("usage.trend3d") : t("usage.trend7d"))}</div>
          <div class="usage-daily-chart">${cols}</div>
        </div>`);
    }

    const models = Array.isArray(bucket.models) ? bucket.models : [];
    if (models.length) {
      const chips = models
        .map((m) => {
          const mCny = Number(m.cost_cny || 0);
          const mUsd = Number(m.cost_usd || (mCny / 7.25));
          const chipSub = t("usage.modelChipSub", {
            cny: mCny.toFixed(2),
            usd: mUsd.toFixed(2),
            tok: fmtTokens(m.total_tokens),
            steps: Number(m.steps || 0),
          });
          return `
          <span class="usage-model-chip">
            <strong>${escHtml(shortModelLabel(m.model))}</strong>
            <span class="m-sub">${escHtml(chipSub)}</span>
          </span>`;
        })
        .join("");
      parts.push(`
        <div class="m3-card">
          <div class="section-heading">${escHtml(t("usage.modelDist"))}</div>
          <div class="usage-model-chips">${chips}</div>
        </div>`);
    }

    parts.push(`
      <div class="m3-card tonal-info-card">
        <p class="info-text">${escHtml(t("usage.footnote", { cached: fmtTokens(caTok), relief: reliefTxt }))}</p>
      </div>`);

    body.innerHTML = parts.join("");
  }

  async function loadQqBotStatus() {
    const body = $("qqbot-body");
    body.innerHTML = `<div class="empty-placeholder">${escHtml(t("qqbot.loading"))}</div>`;
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
            <div class="stat-k">${escHtml(t("qqbot.bridge"))}</div>
            <div class="stat-v" style="color:${online ? "var(--md-success)" : "var(--md-error)"}">${escHtml(online ? t("qqbot.online") : t("qqbot.abnormal"))}</div>
          </div>
          <div class="stat-box">
            <div class="stat-k">${escHtml(t("qqbot.dsBalance"))}</div>
            <div class="stat-v">¥${escHtml(d.deepseek_cny ?? "--")}</div>
          </div>
          <div class="stat-box">
            <div class="stat-k">${escHtml(t("qqbot.groupModel"))}</div>
            <div class="stat-v" style="font-size:13.5px">${escHtml(d.group_chat_model || "--")}</div>
          </div>
          <div class="stat-box">
            <div class="stat-k">${escHtml(t("qqbot.totalCalls"))}</div>
            <div class="stat-v">${escHtml(t("qqbot.callsUnit", { count: d.total_calls ?? 0 }))}</div>
          </div>
        </div>
        <div class="m3-card">
          <div class="section-heading">${escHtml(t("qqbot.switchHeading"))}</div>
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
      body.innerHTML = `<div class="m3-card"><p class="info-text">${escHtml(t("qqbot.queryFail", { err: e.message }))}</p></div>`;
    }
  }

  function renderSettingsHosts() {
    const list = $("settings-hosts-list");
    const countEl = $("settings-host-count");
    if (countEl) countEl.textContent = t("settings.hostCount", { count: state.hosts.length });
    if (!list) return;

    if (!state.hosts.length) {
      list.innerHTML = `<div class="empty-placeholder">${escHtml(t("settings.noHosts"))}</div>`;
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
                  <span class="sh-name">${escHtml(formatHostDisplayName(h.name))}</span>
                  ${isAct ? `<span class="sh-active-pill">${escHtml(t("settings.activeHostPill"))}</span>` : ""}
                </div>
                <div class="sh-url">${escHtml(h.url)}</div>
              </div>
            </div>
            <div class="sh-actions">
              ${isAct ? "" : `<button class="m3-btn tonal sm host-switch-btn" type="button" data-hid="${escHtml(h.id)}">${escHtml(t("settings.switchHost"))}</button>`}
              <button class="m3-btn outlined sm host-test-btn" type="button" data-hid="${escHtml(h.id)}">${escHtml(t("settings.testConn"))}</button>
              <button class="m3-btn danger-tonal sm host-del-btn" type="button" data-hid="${escHtml(h.id)}">${escHtml(t("settings.delete"))}</button>
            </div>
          </div>`;
      })
      .join("");
  }

  function openSettingsModal() {
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
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
    closeTurnNavigator();
    closeContextPopover();
    closeSwarmDrawer();
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

    $("btn-welcome-lang")?.addEventListener("click", () => {
      haptic("light");
      applyLanguage(I18N.isEn() ? "zh" : "en", { persist: true, notify: true, rerender: true });
    });

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
      closeTurnNavigator();
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
        showToast(t("toast.openedInMain"));
      } catch (err) {
        showToast(t("toast.openMainFail", { err: err?.message || t("err.unknown") }));
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
      showToast(t("toast.switchedModel", { model: shortModelLabel(state.selectedModel) }));
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
        if (h) showToast(t("toast.switchedHost", { name: formatHostDisplayName(h.name) }));
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
        syncSwarmPolling();
      } else {
        stopSwarmPolling();
        if (SIDECAR) {
          pauseSidecarTransportForHidden();
        }
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
      updateSwarmTopbarPill();
      syncSwarmPolling();
      if (state.swarmDrawerOpen) {
        state.swarmLastRenderFp = "";
        renderSwarmDrawer({ force: true });
      }
      if (state.streaming && $("streaming-row")) {
        updateStreamingRow();
      }
      haptic("light");
      showToast(state.swarmMode ? t("toast.swarmOn") : t("toast.swarmOff"));
    });

    // --- Topbar Pixel-Bee Swarm Indicator & Right Collapsible Drawer Events ---
    $("btn-swarm-status")?.addEventListener("click", toggleSwarmDrawer);
    $("btn-close-swarm")?.addEventListener("click", closeSwarmDrawer);
    $("swarm-backdrop")?.addEventListener("click", closeSwarmDrawer);
    $("btn-swarm-refresh")?.addEventListener("click", () => {
      haptic("light");
      fetchSwarmStatus({ showLoading: false });
    });
    $("swarm-tabs")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-swarm-tab]");
      if (!btn || !btn.dataset.swarmTab) return;
      const nextTab = btn.dataset.swarmTab;
      if (nextTab === state.swarmTab) return;
      haptic("light");
      state.swarmTab = nextTab;
      state.swarmLastRenderFp = "";
      renderSwarmDrawer({ force: true });
    });
    $("swarm-drawer-body")?.addEventListener("click", (e) => {
      const beeTile = e.target.closest("[data-swarm-member]");
      if (beeTile) {
        haptic("light");
        const nextName = beeTile.dataset.swarmMember || "";
        state.swarmSelectedMember = state.swarmSelectedMember === nextName ? "" : nextName;
        state.swarmLastRenderFp = "";
        renderSwarmDrawer({ force: true });
        return;
      }
      if (e.target.closest("#btn-swarm-board-sort")) {
        haptic("light");
        state.swarmBoardNewestFirst = !state.swarmBoardNewestFirst;
        state.swarmLastRenderFp = "";
        renderSwarmDrawer({ force: true });
        return;
      }
      if (e.target.closest("#btn-swarm-enable-composer")) {
        if (!state.swarmMode) {
          $("btn-swarm")?.click();
        }
        closeSwarmDrawer();
        $("prompt-input")?.focus();
      }
    });
    $("swarm-drawer-body")?.addEventListener(
      "toggle",
      (e) => {
        const det = e.target;
        if (!det || det.tagName !== "DETAILS" || !det.dataset || !det.dataset.skey) return;
        const key = det.dataset.skey;
        if (det.open) {
          state.swarmExpandedKeys.add(key);
          state.swarmExpandedKeys.delete(`!${key}`);
        } else {
          state.swarmExpandedKeys.delete(key);
          state.swarmExpandedKeys.add(`!${key}`);
        }
      },
      true
    );

    // --- Bidirectional Horizontal Touch Swipe Gestures (Left Drawer <-> Right Swarm Drawer) ---
    let swipeState = null;
    const SWIPE_GUARD_SELECTOR =
      ".code-block pre, .md-table-wrap, .photo-strip, .usage-daily-chart, .m3-segmented, .composer-tools-left, .attach-tray, .swarm-team-strip, input, textarea, select, [contenteditable]";
    const isAnyBlockingOverlayOpen = () => {
      if (!$("welcome-view")?.classList.contains("hidden")) return true;
      if (!$("pair-confirm-dialog")?.classList.contains("hidden")) return true;
      for (const id of ["preview-modal", "pair-modal", "usage-modal", "files-modal", "qqbot-modal", "settings-modal"]) {
        if (!$(id)?.classList.contains("hidden")) return true;
      }
      if (
        !$("model-sheet")?.classList.contains("hidden") ||
        !$("host-sheet")?.classList.contains("hidden") ||
        !$("attach-sheet")?.classList.contains("hidden")
      ) {
        return true;
      }
      if (state.turnNavOpen || state.ctxPopoverOpen) return true;
      return false;
    };
    document.addEventListener(
      "touchstart",
      (e) => {
        if (!e.touches || e.touches.length !== 1) {
          swipeState = null;
          return;
        }
        if (isAnyBlockingOverlayOpen()) {
          swipeState = null;
          return;
        }
        const target = e.target;
        if (target && target.closest && target.closest(SWIPE_GUARD_SELECTOR)) {
          swipeState = null;
          return;
        }
        const t0 = e.touches[0];
        swipeState = {
          startX: t0.clientX,
          startY: t0.clientY,
          lastX: t0.clientX,
          lastY: t0.clientY,
          startedAt: Date.now(),
        };
      },
      { passive: true }
    );
    document.addEventListener(
      "touchmove",
      (e) => {
        if (!swipeState) return;
        if (!e.touches || e.touches.length !== 1) {
          swipeState = null;
          return;
        }
        swipeState.lastX = e.touches[0].clientX;
        swipeState.lastY = e.touches[0].clientY;
      },
      { passive: true }
    );
    document.addEventListener(
      "touchend",
      (e) => {
        if (!swipeState) return;
        const st = swipeState;
        swipeState = null;
        if (isAnyBlockingOverlayOpen()) return;
        const endTouch = e.changedTouches && e.changedTouches[0];
        const endX = endTouch ? endTouch.clientX : st.lastX;
        const endY = endTouch ? endTouch.clientY : st.lastY;
        const dx = endX - st.startX;
        const dy = endY - st.startY;
        if (Math.abs(dx) <= 48 || Math.abs(dx) <= Math.abs(dy) * 1.65) return;

        const leftDrawerOpen = Boolean($("drawer")?.classList.contains("open"));
        if (dx > 48) {
          // Swipe Left -> Right
          if (state.swarmDrawerOpen) {
            closeSwarmDrawer();
          } else if (!leftDrawerOpen) {
            openDrawer();
          }
        } else if (dx < -48) {
          // Swipe Right -> Left
          if (leftDrawerOpen) {
            closeDrawer();
          } else if (!state.swarmDrawerOpen) {
            openSwarmDrawer();
          }
        }
      },
      { passive: true }
    );
    document.addEventListener(
      "touchcancel",
      () => {
        swipeState = null;
      },
      { passive: true }
    );

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
      if (e.key !== "Enter" || e.isComposing) return;
      const isDesktopOrSidecar = window.innerWidth > 768 || Boolean(SIDECAR);
      const hasContent = Boolean((inp.value || "").trim() || state.attachments.length);
      if (state.streaming && hasContent) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          sendPromptWithMode("interrupt");
          return;
        }
        if (!e.shiftKey && isDesktopOrSidecar) {
          e.preventDefault();
          sendPromptWithMode("queue");
          return;
        }
      } else if (!state.streaming && !e.shiftKey && isDesktopOrSidecar) {
        e.preventDefault();
        handleSendOrStop();
      }
    });
    $("btn-send").addEventListener("click", handleSendOrStop);
    $("btn-cutin")?.addEventListener("click", () => sendPromptWithMode("interrupt"));
    $("btn-queue-send")?.addEventListener("click", () => sendPromptWithMode("queue"));

    // --- Prompt Queue Tray Events (Cut-in / Inline Edit / Delete / Resume) ---
    $("queue-tray")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-qact]");
      if (!btn) return;
      const act = btn.dataset.qact;
      const qid = btn.dataset.qid || "";
      if (act === "cutin") {
        interruptQueueItem(qid);
      } else if (act === "edit") {
        startQueueInlineEdit(qid);
      } else if (act === "delete") {
        deleteQueueItem(qid);
      } else if (act === "save-edit") {
        saveQueueInlineEdit(qid);
      } else if (act === "cancel-edit") {
        cancelQueueInlineEdit();
      } else if (act === "resume") {
        resumeQueue();
      }
    });
    $("queue-tray")?.addEventListener("input", (e) => {
      const ta = e.target.closest(".queue-edit-input");
      if (ta) {
        state.editingQueueDraft = ta.value;
      }
    });
    $("queue-tray")?.addEventListener("keydown", (e) => {
      const ta = e.target.closest(".queue-edit-input");
      if (!ta) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelQueueInlineEdit();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        saveQueueInlineEdit(ta.dataset.qid || state.editingQueueItemId);
      }
    });

    // --- Context Window Ring Pill & Popover Events ---
    $("btn-ctx-window")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleContextPopover();
    });
    $("ctx-window-backdrop")?.addEventListener("click", closeContextPopover);
    $("ctx-window-panel")?.addEventListener("click", (e) => {
      const bdBtn = e.target.closest("#btn-ctx-breakdown");
      if (bdBtn) {
        e.stopPropagation();
        haptic("light");
        state.ctxBreakdownOpen = !state.ctxBreakdownOpen;
        bdBtn.classList.toggle("open", state.ctxBreakdownOpen);
        bdBtn.setAttribute("aria-expanded", state.ctxBreakdownOpen ? "true" : "false");
        $("ctx-breakdown-wrap")?.classList.toggle("hidden", !state.ctxBreakdownOpen);
      }
    });
    document.addEventListener("click", (e) => {
      if (!state.ctxPopoverOpen) return;
      const tEl = e.target;
      if (tEl && tEl.closest && (tEl.closest("#ctx-window-panel") || tEl.closest("#btn-ctx-window"))) {
        return;
      }
      closeContextPopover();
    });
    document.addEventListener("gesturestart", (e) => {
      const tEl = e.target;
      if (!tEl || !tEl.closest || !tEl.closest("#preview-body.preview-img-stage")) {
        e.preventDefault();
      }
    }, { passive: false });

    // --- Message Actions (Copy code, Copy reply, Preview file:///, Open Swarm) ---
    $("messages-list").addEventListener("click", (e) => {
      const swarmStrip = e.target.closest(".swarm-live-strip[data-open-swarm]");
      if (swarmStrip) {
        openSwarmDrawer();
        return;
      }

      const cpCode = e.target.closest(".code-copy-btn");
      if (cpCode) {
        bridgeCopyText(decodeURIComponent(cpCode.dataset.copy || ""));
        haptic("light");
        cpCode.textContent = t("chat.copiedCode");
        setTimeout(() => {
          cpCode.textContent = t("chat.copyCode");
        }, 1400);
        return;
      }

      const cpMsg = e.target.closest(".copy-msg");
      if (cpMsg) {
        bridgeCopyText(decodeURIComponent(cpMsg.dataset.raw || ""));
        haptic("light");
        showToast(t("toast.copiedFull"));
        return;
      }

      const attBtn = e.target.closest(".msg-att-btn");
      if (attBtn) {
        if (attBtn.classList.contains("msg-img-thumb") && attBtn.classList.contains("img-error")) {
          const img = attBtn.querySelector("img[data-media-path]");
          if (img) {
            haptic("light");
            img.dataset.dataUrlFallback = "";
            img.dataset.mediaLoaded = "0";
            loadThumbImgViaAuthFetch(img, state.mediaRenderGen, { priority: 0, allowRetry: false, forceReload: true });
            return;
          }
        }
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

    // --- Expandable Turn Navigator Events ---
    $("topbar-title-wrap")?.addEventListener("click", () => {
      if (state.turns.length < 1) return;
      toggleTurnNavigator();
    });
    $("turn-nav-backdrop")?.addEventListener("click", closeTurnNavigator);
    $("btn-turn-first")?.addEventListener("click", () => {
      if (state.turns.length >= 1) jumpToTurn(1, { smooth: true });
    });
    $("btn-turn-latest")?.addEventListener("click", () => {
      if (state.turns.length < 1) return;
      disarmBottomAnchor();
      closeTurnNavigator();
      haptic("light");
      scrollToBottom(true, { smooth: true });
      state.activeTurnIndex = state.turns.length;
      updateTurnTriggerUi();
      const lastEl = state.turnAnchorEls[state.turnAnchorEls.length - 1];
      if (lastEl) flashTurnElement(lastEl);
    });
    $("turn-nav-search")?.addEventListener("input", (e) => {
      state.turnNavFilter = e.target.value || "";
      renderTurnNavList();
    });
    $("turn-nav-list")?.addEventListener("click", (e) => {
      const item = e.target.closest(".turn-nav-item[data-turn-index]");
      if (!item) return;
      const idx = Number(item.dataset.turnIndex);
      if (idx >= 1) jumpToTurn(idx, { smooth: true });
    });

    // --- Scroll State, Active Turn Tracking, Bottom-Anchor Guard & Scroll FAB ---
    const chatScrollEl = $("chat-scroll");
    let scrollRafId = 0;
    chatScrollEl.addEventListener("wheel", (e) => {
      if (e.deltaY < 0) disarmBottomAnchor();
    }, { passive: true });
    chatScrollEl.addEventListener("touchstart", () => {
      disarmBottomAnchor();
    }, { passive: true });
    chatScrollEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || e.pointerType === "touch") {
        disarmBottomAnchor();
      }
    }, { passive: true });
    chatScrollEl.addEventListener("scroll", () => {
      const distFromBottom = chatScrollEl.scrollHeight - chatScrollEl.scrollTop - chatScrollEl.clientHeight;
      if (state.bottomAnchorActive && distFromBottom > 100 && Date.now() - state.programmaticScrollAt > 90) {
        disarmBottomAnchor();
      }
      if (scrollRafId) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        $("topbar").classList.toggle("scrolled", chatScrollEl.scrollTop > 6);
        const away = chatScrollEl.scrollHeight - chatScrollEl.scrollTop - chatScrollEl.clientHeight > 220;
        $("btn-scroll-bottom").classList.toggle("hidden", !away);
        updateActiveTurnFromScroll();
      });
    }, { passive: true });
    $("btn-scroll-bottom").addEventListener("click", () => scrollToBottom(true, { smooth: true }));

    // Keep viewport pinned to bottom during initial-open async image/layout height growth
    if (typeof ResizeObserver === "function") {
      const msgListEl = $("messages-list");
      if (msgListEl) {
        new ResizeObserver(() => {
          snapBottomIfAnchored();
        }).observe(msgListEl);
      }
    }

    // --- Unified Drawer Settings Entry & In-App Desktop Phone Pairing ---
    function getPairUrl(withBust = true) {
      const suffix = withBust ? `/pair?_t=${Date.now()}` : "/pair";
      if (SIDECAR) return withSidecarToken(suffix);
      return withSidecarToken(`${location.origin}${suffix}`);
    }
    function openPairModal() {
      closeTurnNavigator();
      closeContextPopover();
      closeSwarmDrawer();
      closeDrawer();
      const modal = $("pair-modal");
      const iframe = $("pair-iframe");
      if (!modal || !iframe) {
        window.open(getPairUrl(false), "_blank", "noopener");
        return;
      }
      iframe.src = getPairUrl(true);
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
      if (iframe) iframe.src = getPairUrl(true);
    });
    $("btn-pair-external")?.addEventListener("click", () => {
      const extUrl = (SIDECAR && !/^https?:$/i.test(location.protocol))
        ? "http://127.0.0.1:18795/pair"
        : getPairUrl(false);
      window.open(extUrl, "_blank", "noopener");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
        const tag = (e.target && e.target.tagName) || "";
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          disarmBottomAnchor();
        }
      }
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
            if (mid === "preview-modal") {
              closePreviewModal();
            } else {
              el.classList.add("hidden");
            }
            e.preventDefault();
            return;
          }
        }
        if (state.ctxPopoverOpen) {
          closeContextPopover();
          e.preventDefault();
          return;
        }
        if (state.turnNavOpen) {
          closeTurnNavigator();
          e.preventDefault();
          return;
        }
        if (state.swarmDrawerOpen) {
          closeSwarmDrawer();
          e.preventDefault();
          return;
        }
        if (state.editingQueueItemId) {
          cancelQueueInlineEdit();
          e.preventDefault();
          return;
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
        showToast(state.downloadAskFolder ? t("toast.dlAskOn") : t("toast.dlFixedOn"));
      });
    });

    $("btn-save-dl-dir")?.addEventListener("click", () => {
      const inp = $("settings-dl-subdir");
      const clean = sanitizeSubdirInput(inp ? inp.value : "");
      state.downloadSubdir = clean;
      persistConfig();
      syncDownloadSettingsUi();
      haptic("success");
      showToast(t("toast.dlDirSaved", { path: clean ? `Download/${clean}/` : "Download/" }));
    });

    // --- Full-Screen Views Controls ---
    document.querySelectorAll(".close-modal").forEach((b) => {
      b.addEventListener("click", () => {
        if (b.dataset.target === "preview-modal") {
          closePreviewModal();
          return;
        }
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
        showToast(t("toast.qqModelSwitched", { model: shortModelLabel(btn.dataset.qmodel) }));
        loadQqBotStatus();
      } catch (err) {
        showToast(t("toast.switchFail", { err: err.message }));
      }
    });

    // --- Settings View ---
    document.querySelectorAll(".lang-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        haptic("light");
        applyLanguage(btn.dataset.langChoice, { persist: true, notify: true, rerender: true });
      });
    });

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
        showToast(nextShow ? t("toast.extCliOn") : t("toast.extCliOff"));
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
        if (h) showToast(t("toast.switchedHostShort", { name: formatHostDisplayName(h.name) }));
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
        showToast(t("toast.hostRemoved"));
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
        : (location.host ? `${location.protocol}//${location.host}` : "");
      const localUrl = normalizeServerUrl(rawOrigin) || (SIDECAR ? "same-origin" : "");
      const localName = data.hostname ? t("host.localSuffix", { name: data.hostname }) : t("host.localWorkbench");
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
    applyLanguage(state.langPref, { persist: false, notify: false, rerender: false });
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
        setConnState("offline", t("conn.localBootRetry"));
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
