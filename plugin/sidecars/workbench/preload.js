(() => {
  'use strict';

  const normalizedSearch = String(window.location.search || '').replace(/^\?/, '').replace(/\?/g, '&');
  const params = new URLSearchParams(normalizedSearch);
  const initialToken = params.get('token') || params.get('sidecar_token') || '';
  let currentConversationId = params.get('conversationId') || params.get('conversation_id') || '';
  const initialView = (window.location.pathname === '/sidebar' || params.get('view') === 'sidebar') ? 'sidebar' : 'auxpane';
  let currentTheme = '';
  let applyingHostVars = false;

  const origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  function parseCssColorRgb(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;

    const hexMatch = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (hexMatch) {
      let h = hexMatch[1];
      if (h.length === 3 || h.length === 4) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      }
      const r = parseInt(h.slice(0, 2), 16) / 255;
      const g = parseInt(h.slice(2, 4), 16) / 255;
      const b = parseInt(h.slice(4, 6), 16) / 255;
      return [r, g, b];
    }

    const rgbMatch = /^rgba?\(\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)/i.exec(s);
    if (rgbMatch) {
      const r = parseFloat(rgbMatch[1]) / (rgbMatch[2] ? 100 : 255);
      const g = parseFloat(rgbMatch[3]) / (rgbMatch[4] ? 100 : 255);
      const b = parseFloat(rgbMatch[5]) / (rgbMatch[6] ? 100 : 255);
      return [r, g, b];
    }

    const srgbMatch = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(s);
    if (srgbMatch) {
      return [parseFloat(srgbMatch[1]), parseFloat(srgbMatch[2]), parseFloat(srgbMatch[3])];
    }

    return null;
  }

  function resolveBackgroundRgb(explicitBg) {
    const direct = parseCssColorRgb(explicitBg);
    if (direct) return direct;

    try {
      const inlineBg = document.documentElement.style.getPropertyValue('--background');
      const parsedInline = parseCssColorRgb(inlineBg);
      if (parsedInline) return parsedInline;
    } catch (_) {}

    try {
      if (document.documentElement) {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:var(--background);';
        document.documentElement.appendChild(probe);
        const computed = window.getComputedStyle(probe).color;
        probe.remove();
        const parsedComputed = parseCssColorRgb(computed);
        if (parsedComputed) return parsedComputed;
      }
    } catch (_) {}

    return null;
  }

  function detectThemeFromBackground(explicitBg) {
    const rgb = resolveBackgroundRgb(explicitBg);
    if (rgb && rgb.every((v) => Number.isFinite(v))) {
      const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      return lum < 0.5 ? 'dark' : 'light';
    }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch (_) {}
    return 'light';
  }

  function emitThemeUpdate(theme, vars) {
    const nextTheme = theme === 'dark' ? 'dark' : 'light';
    currentTheme = nextTheme;
    if (document.documentElement) {
      document.documentElement.dataset.agyTheme = nextTheme;
    }
    try {
      window.dispatchEvent(new CustomEvent('agy-sidecar-theme', {
        detail: { theme: nextTheme, vars: vars || {} },
      }));
    } catch (_) {}
  }

  function applyHostCssVariables(cssVars) {
    if (!cssVars || typeof cssVars !== 'object') return;
    const applied = {};
    applyingHostVars = true;
    try {
      const rootStyle = document.documentElement && document.documentElement.style;
      if (rootStyle) {
        for (const [key, val] of Object.entries(cssVars)) {
          if (typeof key !== 'string' || !key.startsWith('--')) continue;
          if (val === null || val === undefined) continue;
          const strVal = String(val).trim();
          if (!strVal) continue;
          rootStyle.setProperty(key, strVal);
          applied[key] = strVal;
        }
      }
    } finally {
      applyingHostVars = false;
    }
    const theme = detectThemeFromBackground(applied['--background']);
    emitThemeUpdate(theme, applied);
  }

  function isSameOriginUrl(urlStr) {
    try {
      const parsed = new URL(String(urlStr), window.location.href);
      return parsed.origin === window.location.origin;
    } catch (_) {
      return false;
    }
  }

  function secureFetch(input, init) {
    if (!origFetch) {
      return Promise.reject(new Error('fetch is not available'));
    }
    const targetUrl = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.toString() : (input && typeof input.url === 'string' ? input.url : ''));

    if (!initialToken || !targetUrl || !isSameOriginUrl(targetUrl)) {
      return origFetch(input, init);
    }

    if (typeof Request !== 'undefined' && input instanceof Request) {
      const headers = new Headers(input.headers);
      if (init && init.headers) {
        new Headers(init.headers).forEach((v, k) => headers.set(k, v));
      }
      headers.set('X-Sidecar-Token', initialToken);
      const nextInit = init ? { ...init, headers } : { headers };
      return origFetch(new Request(input, nextInit));
    }

    const nextInit = init ? { ...init } : {};
    const headers = new Headers(nextInit.headers || undefined);
    headers.set('X-Sidecar-Token', initialToken);
    nextInit.headers = headers;
    return origFetch(input, nextInit);
  }

  // Initialize theme attribute immediately before first paint
  emitThemeUpdate(detectThemeFromBackground(''), {});

  // Listen for Antigravity host postMessage updates
  window.addEventListener('message', (event) => {
    if (window.parent && window.parent !== window && event.source !== window.parent) {
      return;
    }
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'theme-change') {
      const cssVariables = (data.payload && data.payload.cssVariables) || data.cssVariables;
      if (cssVariables && typeof cssVariables === 'object') {
        applyHostCssVariables(cssVariables);
      } else if (data.payload && (data.payload.theme === 'dark' || data.payload.theme === 'light')) {
        emitThemeUpdate(data.payload.theme, {});
      }
      return;
    }

    if (data.type === 'conversation-change' || data.type === 'context-change') {
      const nextCid = (data.payload && (data.payload.conversationId || data.payload.conversation_id))
        || data.conversationId
        || '';
      if (typeof nextCid === 'string' && nextCid && nextCid !== currentConversationId) {
        currentConversationId = nextCid;
        try {
          window.dispatchEvent(new CustomEvent('agy-sidecar-conversation', {
            detail: { conversationId: currentConversationId },
          }));
        } catch (_) {}
      }
    }
  });

  // Also react if host mutates :root inline style tokens directly
  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(() => {
      if (applyingHostVars) return;
      const inlineBg = document.documentElement.style.getPropertyValue('--background');
      if (!inlineBg) return;
      const nextTheme = detectThemeFromBackground(inlineBg);
      if (nextTheme !== currentTheme) {
        emitThemeUpdate(nextTheme, { '--background': inlineBg.trim() });
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }

  const existingSidecar = window.sidecar && typeof window.sidecar === 'object' ? window.sidecar : null;
  const existingUi = existingSidecar && existingSidecar.ui && typeof existingSidecar.ui === 'object'
    ? existingSidecar.ui
    : null;

  const ui = {
    toggleAuxPane(req) {
      if (existingUi && typeof existingUi.toggleAuxPane === 'function') {
        return existingUi.toggleAuxPane(req);
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'toggle-aux-pane', payload: req || {} }, '*');
      }
    },
    toggleConversation(convId) {
      if (!convId || typeof convId !== 'string') return;
      if (existingUi && typeof existingUi.toggleConversation === 'function') {
        return existingUi.toggleConversation(convId);
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'toggle-conversation', payload: { conversationId: convId } }, '*');
      }
    },
  };

  window.sidecar = {
    get conversationId() {
      if (existingSidecar && typeof existingSidecar.conversationId === 'string' && existingSidecar.conversationId) {
        return existingSidecar.conversationId;
      }
      return currentConversationId;
    },
    view: initialView,
    fetch: secureFetch,
    ui,
  };
})();
