(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search || '');
  const token = params.get('token') || params.get('sidecar_token') || '';
  const initialConvId = params.get('conversationId')
    || params.get('conversation_id')
    || (window.sidecar && typeof window.sidecar.conversationId === 'string' ? window.sidecar.conversationId : '')
    || '';
  const rawView = params.get('view')
    || (window.sidecar && typeof window.sidecar.view === 'string' ? window.sidecar.view : '')
    || '';
  const view = rawView === 'sidebar' ? 'sidebar' : 'auxpane';

  // Strip ?token=... from address bar while preserving conversationId, view, and hash.
  // Keep sidecar_token only on /pair so its internal reload timer keeps auth inside the iframe.
  try {
    const cleanUrl = new URL(window.location.href);
    let dirty = false;
    if (cleanUrl.searchParams.has('token')) {
      cleanUrl.searchParams.delete('token');
      dirty = true;
    }
    if (cleanUrl.pathname !== '/pair' && cleanUrl.searchParams.has('sidecar_token')) {
      cleanUrl.searchParams.delete('sidecar_token');
      dirty = true;
    }
    if (dirty && window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
    }
  } catch (_) {}

  function isSameOriginHttp(urlObj) {
    return (urlObj.protocol === 'http:' || urlObj.protocol === 'https:')
      && urlObj.origin === window.location.origin;
  }

  function isSameOriginWs(urlObj) {
    const expectedProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return (urlObj.protocol === expectedProto || urlObj.protocol === 'ws:' || urlObj.protocol === 'wss:')
      && urlObj.host === window.location.host;
  }

  function withToken(urlStr) {
    if (!token || typeof urlStr !== 'string') return urlStr;
    const trimmed = urlStr.trim();
    if (!trimmed) return urlStr;
    if (/^(?:data|blob|javascript|mailto|tel|agylink):/i.test(trimmed)) return urlStr;
    try {
      const isRelative = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('//');
      const parsed = new URL(trimmed, window.location.href);
      if (!isSameOriginHttp(parsed) && !isSameOriginWs(parsed)) {
        return urlStr;
      }
      parsed.searchParams.set('sidecar_token', token);
      if (isRelative) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
      return parsed.toString();
    } catch (_) {
      return urlStr;
    }
  }

  // Wrap window.fetch to inject X-Sidecar-Token for same-origin requests without altering FormData/Blob/headers.
  if (typeof window.fetch === 'function' && !window.fetch.__agySidecarWrapped) {
    const origFetch = window.fetch.bind(window);
    const wrappedFetch = function sidecarFetch(input, init) {
      if (!token) {
        return origFetch(input, init);
      }
      const targetUrl = typeof input === 'string'
        ? input
        : (input instanceof URL ? input.toString() : (input && typeof input.url === 'string' ? input.url : ''));
      if (!targetUrl) {
        return origFetch(input, init);
      }
      let sameOrigin = false;
      try {
        sameOrigin = isSameOriginHttp(new URL(targetUrl, window.location.href));
      } catch (_) {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        return origFetch(input, init);
      }

      if (typeof Request !== 'undefined' && input instanceof Request) {
        const headers = new Headers(input.headers);
        if (init && init.headers) {
          new Headers(init.headers).forEach((v, k) => headers.set(k, v));
        }
        headers.set('X-Sidecar-Token', token);
        const nextInit = init ? { ...init, headers } : { headers };
        return origFetch(new Request(input, nextInit));
      }

      const nextInit = init ? { ...init } : {};
      const headers = new Headers(nextInit.headers || undefined);
      headers.set('X-Sidecar-Token', token);
      nextInit.headers = headers;
      return origFetch(input, nextInit);
    };
    wrappedFetch.__agySidecarWrapped = true;
    window.fetch = wrappedFetch;
  }

  // Wrap window.WebSocket to append sidecar_token on same-origin /ws connections.
  if (typeof window.WebSocket === 'function' && !window.WebSocket.__agySidecarWrapped) {
    const OrigWebSocket = window.WebSocket;
    class SidecarWebSocket extends OrigWebSocket {
      constructor(url, protocols) {
        let finalUrl = url;
        if (token && (typeof url === 'string' || url instanceof URL)) {
          try {
            const parsed = new URL(String(url), window.location.href);
            if (isSameOriginWs(parsed) && parsed.pathname === '/ws') {
              parsed.searchParams.set('sidecar_token', token);
              finalUrl = parsed.toString();
            }
          } catch (_) {}
        }
        if (protocols !== undefined) {
          super(finalUrl, protocols);
        } else {
          super(finalUrl);
        }
      }
    }
    Object.defineProperty(SidecarWebSocket, '__agySidecarWrapped', {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    window.WebSocket = SidecarWebSocket;
  }

  // On /pair iframe, keep sidecar_token attached when clicking network chips or APK download link.
  if (token && window.location.pathname === '/pair') {
    document.addEventListener('click', (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!href || /^(?:agylink|mailto|tel|javascript):/i.test(href)) return;
      try {
        const parsed = new URL(href, window.location.href);
        if (!isSameOriginHttp(parsed)) return;
        if (parsed.pathname === '/pair' || parsed.pathname === '/download-apk' || parsed.pathname === '/') {
          parsed.searchParams.set('sidecar_token', token);
          anchor.setAttribute('href', parsed.pathname + parsed.search + parsed.hash);
        }
      } catch (_) {}
    }, true);
  }

  function getTheme() {
    const t = document.documentElement && document.documentElement.dataset
      ? document.documentElement.dataset.agyTheme
      : '';
    if (t === 'dark' || t === 'light') return t;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch (_) {}
    return 'light';
  }

  async function startLocalServer() {
    const resp = await window.fetch('/__sidecar/start-server', {
      method: 'POST',
      cache: 'no-store',
    });
    const data = await resp.json().catch(() => ({
      ok: false,
      started: false,
      upstreamOnline: false,
      message: 'Unexpected response from sidecar.',
    }));
    return { status: resp.status, ...data };
  }

  function reloadWithToken() {
    try {
      const target = new URL(window.location.href);
      if (token) {
        target.searchParams.set('token', token);
      }
      window.location.replace(target.toString());
    } catch (_) {
      window.location.reload();
    }
  }

  window.__AGY_SIDECAR__ = {
    active: true,
    token,
    get conversationId() {
      if (window.sidecar && typeof window.sidecar.conversationId === 'string' && window.sidecar.conversationId) {
        return window.sidecar.conversationId;
      }
      return initialConvId;
    },
    view,
    withToken,
    toggleConversation(cid) {
      if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleConversation === 'function') {
        window.sidecar.ui.toggleConversation(cid);
        return true;
      }
      return false;
    },
    toggleAuxPane(req) {
      if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleAuxPane === 'function') {
        window.sidecar.ui.toggleAuxPane(req);
        return true;
      }
      return false;
    },
    getTheme,
    startLocalServer,
    reloadWithToken,
  };
})();
