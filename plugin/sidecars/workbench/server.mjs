import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SIDECAR_VERSION = '1.7.5';
const BIND_HOST = '127.0.0.1';
const UPSTREAM_HOST = '127.0.0.1';
const SIDECAR_TOKEN = String(process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '').trim();
const PLUGIN_HOST_CONFIG_PATH = path.join(os.homedir(), '.gemini', 'antigravity-mobile', 'plugin_host.json');

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const SAFE_STATIC_PATHS = new Set([
  '/preload.js',
  '/sidecar-bridge.js',
  '/app.css',
  '/app.js',
  '/favicon.ico',
  '/manifest.json',
  '/logo-mark.png',
  '/logo-app.png',
]);

const HEADER_ONLY_AUTH_PATHS = new Set([
  '/api/local-auth',
  '/__sidecar/start-server',
  '/__sidecar/events',
  '/__sidecar/poll',
]);

const STRIP_REQ_HEADER_EXACT = new Set([
  'origin',
  'referer',
  'x-sidecar-token',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry',
  'true-client-ip',
  'x-real-ip',
  'host',
]);

function readPluginHostJson() {
  try {
    if (!fs.existsSync(PLUGIN_HOST_CONFIG_PATH)) return null;
    const raw = fs.readFileSync(PLUGIN_HOST_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseValidatedPort(raw, fallback, allowZero = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) return fallback;
  if (allowZero && n === 0) return 0;
  if (n >= 1 && n <= 65535) return n;
  return fallback;
}

const LISTEN_PORT = parseValidatedPort(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.AGY_SIDECAR_PORT,
  0,
  true
);

function getUpstreamPort() {
  if (process.env.AGY_MOBILE_PORT) {
    return parseValidatedPort(process.env.AGY_MOBILE_PORT, 18795, false);
  }
  const hostCfg = readPluginHostJson();
  if (hostCfg && hostCfg.port !== undefined) {
    return parseValidatedPort(hostCfg.port, 18795, false);
  }
  return 18795;
}

const UPSTREAM_PORT = getUpstreamPort();

function safeTokenEqual(provided, expected) {
  if (!expected) return true;
  if (typeof provided !== 'string' || !provided) return false;
  const hProvided = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const hExpected = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(hProvided, hExpected);
}

const ELECTRON_HOST_SCHEMES = new Set([
  'vscode-file:',
  'vscode-webview:',
  'app:',
  'file:',
  'antigravity:',
]);

function normalizeRawUrl(rawUrl) {
  const s = String(rawUrl || '/');
  const qIdx = s.indexOf('?');
  if (qIdx === -1) return s;
  const head = s.slice(0, qIdx + 1);
  const tail = s.slice(qIdx + 1).replace(/\?/g, '&');
  return head + tail;
}

function isLoopbackOrigin(originHeader) {
  if (!originHeader) return true;
  const trimmed = String(originHeader).trim();
  if (!trimmed) return true;
  if (trimmed.toLowerCase() === 'null') return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return false;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
    return true;
  } catch {
    return false;
  }
}

function isAllowedOrigin(originHeader, hasValidToken) {
  if (isLoopbackOrigin(originHeader)) return true;
  if (!hasValidToken) return false;
  const trimmed = String(originHeader || '').trim();
  if (trimmed.toLowerCase() === 'null') return true;
  try {
    const parsed = new URL(trimmed);
    return ELECTRON_HOST_SCHEMES.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

function logReject(statusCode, method, pathname, reason, req, urlObj) {
  const origin = req.headers.origin || '-';
  const sfs = req.headers['sec-fetch-site'] || '-';
  const sfd = req.headers['sec-fetch-dest'] || '-';
  const hasHdrTok = Boolean(req.headers['x-sidecar-token']);
  const hasQryTok = Boolean(urlObj && (urlObj.searchParams.get('token') || urlObj.searchParams.get('sidecar_token')));
  console.error(
    `[antigravity-sync] reject ${statusCode} ${method} ${pathname} reason=${reason} origin=${origin} sfs=${sfs} sfd=${sfd} hdrTok=${hasHdrTok} qryTok=${hasQryTok}`
  );
}

function hasUnsafePath(rawUrl, pathname) {
  const lowerRaw = String(rawUrl || '').toLowerCase();
  if (
    pathname.startsWith('//') ||
    pathname.startsWith('/\\') ||
    pathname.includes('\\') ||
    lowerRaw.includes('%5c') ||
    lowerRaw.includes('%2f%2f') ||
    pathname.split('/').includes('..')
  ) {
    return true;
  }
  return false;
}

function sanitizeUpstreamHeaders(incomingHeaders, extraHeaders = {}) {
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(incomingHeaders || {})) {
    const key = rawKey.toLowerCase();
    if (
      STRIP_REQ_HEADER_EXACT.has(key) ||
      key.startsWith('sec-fetch-') ||
      key.startsWith('x-forwarded-') ||
      key.startsWith('cf-')
    ) {
      continue;
    }
    if (rawVal !== undefined) {
      out[key] = rawVal;
    }
  }
  out.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  for (const [k, v] of Object.entries(extraHeaders)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function sanitizeResponseHeaders(upstreamHeaders, extraHeaders = {}) {
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(upstreamHeaders || {})) {
    const key = rawKey.toLowerCase();
    if (key.startsWith('access-control-')) continue;
    if (rawVal !== undefined) {
      out[key] = rawVal;
    }
  }
  out['x-content-type-options'] = 'nosniff';
  out['referrer-policy'] = 'no-referrer';
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v === undefined) {
      delete out[k.toLowerCase()];
    } else {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  };
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  const headers = {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  };
  res.writeHead(statusCode, headers);
  res.end(body);
}

function serveLocalFile(res, filePath, contentType, method = 'GET') {
  try {
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(buf.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(buf);
    }
  } catch {
    sendText(res, 500, 'Internal sidecar asset missing');
  }
}

function resolveServerLocation() {
  const hostCfg = readPluginHostJson();
  const candidates = [];

  if (process.env.AGY_MOBILE_SERVER_DIR && String(process.env.AGY_MOBILE_SERVER_DIR).trim()) {
    candidates.push({
      dir: path.resolve(String(process.env.AGY_MOBILE_SERVER_DIR).trim()),
      pythonBin: process.env.AGY_MOBILE_PYTHON || (hostCfg && hostCfg.pythonBin) || '',
      configured: true,
    });
  }

  if (hostCfg && typeof hostCfg.serverDir === 'string' && hostCfg.serverDir.trim()) {
    candidates.push({
      dir: path.resolve(hostCfg.serverDir.trim()),
      pythonBin: process.env.AGY_MOBILE_PYTHON || (typeof hostCfg.pythonBin === 'string' ? hostCfg.pythonBin.trim() : ''),
      configured: true,
    });
  }

  const repoFallback = path.resolve(__dirname, '../../..');
  candidates.push({
    dir: repoFallback,
    pythonBin: process.env.AGY_MOBILE_PYTHON || '',
    configured: false,
  });

  for (const cand of candidates) {
    const serverPy = path.join(cand.dir, 'agy_mobile_server.py');
    if (fs.existsSync(serverPy)) {
      return {
        canStartServer: true,
        serverDirConfigured: Boolean(cand.configured || (hostCfg && hostCfg.serverDir)),
        serverDir: cand.dir,
        serverPy,
        pythonBin: cand.pythonBin || '',
      };
    }
  }

  return {
    canStartServer: false,
    serverDirConfigured: Boolean(process.env.AGY_MOBILE_SERVER_DIR || (hostCfg && hostCfg.serverDir)),
    serverDir: '',
    serverPy: '',
    pythonBin: '',
  };
}

function pickPythonCommand(serverDir, configuredPythonBin) {
  const isWin = process.platform === 'win32';
  const explicitCandidates = [
    process.env.AGY_MOBILE_PYTHON,
    configuredPythonBin,
    isWin ? path.join(serverDir, '.venv', 'Scripts', 'python.exe') : path.join(serverDir, '.venv', 'bin', 'python'),
    isWin ? path.join(serverDir, 'venv', 'Scripts', 'python.exe') : path.join(serverDir, 'venv', 'bin', 'python'),
  ];

  for (const cand of explicitCandidates) {
    if (cand && typeof cand === 'string' && cand.trim() && fs.existsSync(cand.trim())) {
      return { bin: cand.trim(), preArgs: [] };
    }
  }

  if (isWin) {
    return { bin: 'python', preArgs: [] };
  }
  return { bin: 'python3', preArgs: [] };
}

function probeUpstreamHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const req = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
          accept: 'application/json',
        },
      },
      (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => {
          if (chunks.length < 16) chunks.push(c);
        });
        upRes.on('end', () => {
          if (upRes.statusCode !== 200) {
            done({ online: false });
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            done({ online: Boolean(parsed && parsed.ok), data: parsed });
          } catch {
            done({ online: false });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      done({ online: false });
    });
    req.on('error', () => {
      done({ online: false });
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let startServerPromise = null;

async function startLocalLinkServer() {
  const already = await probeUpstreamHealth(1200);
  if (already.online) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        started: false,
        upstreamOnline: true,
        message: 'Link Server is already running.',
      },
    };
  }

  if (startServerPromise) {
    return startServerPromise;
  }

  startServerPromise = (async () => {
    const loc = resolveServerLocation();
    if (!loc.canStartServer || !loc.serverPy) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          started: false,
          upstreamOnline: false,
          message: 'Could not locate agy_mobile_server.py. Run the plugin installer from the repository root or start the server manually.',
        },
      };
    }

    const py = pickPythonCommand(loc.serverDir, loc.pythonBin);
    let spawnErr = null;
    try {
      const child = spawn(py.bin, [...py.preArgs, loc.serverPy], {
        cwd: loc.serverDir,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
        env: {
          ...process.env,
          AGY_MOBILE_PORT: String(UPSTREAM_PORT),
        },
      });
      child.on('error', (err) => {
        spawnErr = err;
      });
      child.unref();
    } catch (err) {
      spawnErr = err;
    }

    if (spawnErr) {
      return {
        statusCode: 500,
        body: {
          ok: false,
          started: false,
          upstreamOnline: false,
          message: `Failed to launch Python process (${spawnErr.code || 'ERROR'}). Start the Link Server manually.`,
        },
      };
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (spawnErr) {
        return {
          statusCode: 500,
          body: {
            ok: false,
            started: false,
            upstreamOnline: false,
            message: `Python executable failed to start (${spawnErr.code || 'ERROR'}).`,
          },
        };
      }
      await sleep(500);
      const probe = await probeUpstreamHealth(1000);
      if (probe.online) {
        return {
          statusCode: 200,
          body: {
            ok: true,
            started: true,
            upstreamOnline: true,
            message: 'Link Server started and is now online.',
          },
        };
      }
    }

    return {
      statusCode: 202,
      body: {
        ok: false,
        started: true,
        upstreamOnline: false,
        message: 'Link Server process launched, still initializing. Waiting for automatic reconnect...',
      },
    };
  })();

  try {
    return await startServerPromise;
  } finally {
    startServerPromise = null;
  }
}

function injectScriptsBeforeHead(html, scriptsMarkup) {
  const re = /<\/head>/i;
  if (re.test(html)) {
    return html.replace(re, `  ${scriptsMarkup}\n</head>`);
  }
  return `${scriptsMarkup}\n${html}`;
}

function proxyHtmlWithInjection(req, res, upstreamPath, options) {
  const {
    scriptsMarkup,
    fallbackOffline = false,
    preserveFrameHeaders = false,
    transformHtml = null,
  } = options;

  const cleanHeaders = sanitizeUpstreamHeaders(req.headers, {
    'accept-encoding': 'identity',
  });
  delete cleanHeaders['if-none-match'];
  delete cleanHeaders['if-modified-since'];

  const upReq = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      path: upstreamPath,
      headers: cleanHeaders,
      timeout: 4000,
    },
    (upRes) => {
      const contentType = String(upRes.headers['content-type'] || '');
      const status = upRes.statusCode || 502;

      if (req.method === 'HEAD' || status !== 200 || !contentType.toLowerCase().includes('text/html')) {
        const extra = { 'cache-control': 'no-store', etag: undefined, 'last-modified': undefined };
        if (!preserveFrameHeaders) {
          extra['x-frame-options'] = undefined;
        }
        res.writeHead(status, sanitizeResponseHeaders(upRes.headers, extra));
        upRes.pipe(res);
        return;
      }

      const chunks = [];
      upRes.on('data', (chunk) => chunks.push(chunk));
      upRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        html = injectScriptsBeforeHead(html, scriptsMarkup);
        if (typeof transformHtml === 'function') {
          html = transformHtml(html);
        }
        const outBuf = Buffer.from(html, 'utf8');
        const extra = {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(outBuf.length),
          'content-encoding': undefined,
          'transfer-encoding': undefined,
          'cache-control': 'no-store',
          etag: undefined,
          'last-modified': undefined,
        };
        if (preserveFrameHeaders) {
          extra['x-frame-options'] = upRes.headers['x-frame-options'] || 'SAMEORIGIN';
          extra['content-security-policy'] = upRes.headers['content-security-policy'] || "frame-ancestors 'self'";
        } else {
          extra['x-frame-options'] = undefined;
          extra['content-security-policy'] = undefined;
        }
        res.writeHead(200, sanitizeResponseHeaders(upRes.headers, extra));
        res.end(outBuf);
      });
    }
  );

  const handleFailure = () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (fallbackOffline) {
      serveLocalFile(res, path.join(__dirname, 'offline.html'), 'text/html; charset=utf-8', req.method);
    } else {
      sendText(res, 502, 'Upstream Link Server unavailable on loopback');
    }
  };

  upReq.on('timeout', () => {
    upReq.destroy();
    handleFailure();
  });
  upReq.on('error', handleFailure);
  res.on('close', () => {
    if (!res.writableEnded && !upReq.destroyed) {
      upReq.destroy();
    }
  });
  upReq.end();
}

function proxyStreamingHttp(req, res, upstreamPath) {
  const cleanHeaders = sanitizeUpstreamHeaders(req.headers);
  const isLongOp =
    upstreamPath.startsWith('/api/upload') ||
    upstreamPath.startsWith('/api/chat/send') ||
    upstreamPath.startsWith('/api/files/download') ||
    upstreamPath.startsWith('/download-apk');
  const reqTimeoutMs = isLongOp ? 180000 : 30000;

  const upReq = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: upstreamPath,
      headers: cleanHeaders,
      timeout: reqTimeoutMs,
    },
    (upRes) => {
      const respHeaders = sanitizeResponseHeaders(upRes.headers, { 'keep-alive': undefined });
      res.writeHead(upRes.statusCode || 502, respHeaders);
      upRes.pipe(res);
    }
  );

  upReq.on('timeout', () => {
    upReq.destroy();
    if (!res.headersSent) {
      sendJson(res, 504, { ok: false, error: 'Upstream Link Server request timed out' });
    } else {
      res.destroy();
    }
  });

  upReq.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: 'Upstream Link Server unavailable' });
    } else {
      res.destroy();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded && !upReq.destroyed) {
      upReq.destroy();
    }
  });

  req.pipe(upReq);
}

function buildMaskedClientWsFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, masked]);
}

const MAX_HUB_EVENTS = 500;
const MAX_SSE_SUBSCRIBERS = 2;
const SSE_MAX_LIFETIME_MS = 45000;
const HUB_IDLE_DISCONNECT_MS = 120000;

const upstreamHub = {
  socket: null,
  connected: false,
  token: '',
  epoch: `hub_${Date.now().toString(36)}_0`,
  epochSeq: 0,
  seq: 0,
  events: [],
  sseSubscribers: new Set(),
  connectingPromise: null,
  connectingToken: '',
  lastActivityAt: 0,
  idleTimer: null,
};

function closeAllSseSubscribers() {
  for (const sub of Array.from(upstreamHub.sseSubscribers)) {
    try {
      sub.close();
    } catch {}
  }
  upstreamHub.sseSubscribers.clear();
}

function disconnectUpstreamHub(notifySubscribers = false) {
  if (upstreamHub.idleTimer) {
    clearInterval(upstreamHub.idleTimer);
    upstreamHub.idleTimer = null;
  }
  const sock = upstreamHub.socket;
  upstreamHub.socket = null;
  upstreamHub.connected = false;
  if (sock && !sock.destroyed) {
    try {
      sock.destroy();
    } catch {}
  }
  if (notifySubscribers) {
    closeAllSseSubscribers();
  }
}

function pushHubEvent(text) {
  const singleLine = String(text || '').replace(/\r?\n/g, ' ');
  if (!singleLine) return;
  upstreamHub.seq += 1;
  upstreamHub.events.push({ seq: upstreamHub.seq, text: singleLine });
  if (upstreamHub.events.length > MAX_HUB_EVENTS) {
    upstreamHub.events.splice(0, upstreamHub.events.length - MAX_HUB_EVENTS);
  }
  for (const sub of Array.from(upstreamHub.sseSubscribers)) {
    try {
      sub.emit(singleLine);
    } catch {
      try {
        sub.close();
      } catch {}
    }
  }
}

function probeUpstreamBearer(bearerToken, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const req = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: '/api/server-info',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
          authorization: `Bearer ${bearerToken}`,
          accept: 'application/json',
        },
      },
      (upRes) => {
        upRes.resume();
        done(upRes.statusCode === 200);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

function startHubConnection(bearerToken, timeoutMs = 2500) {
  disconnectUpstreamHub(false);
  const promise = new Promise((resolve) => {
    const wsKey = crypto.randomBytes(16).toString('base64');
    const upstreamPath = `/ws?token=${encodeURIComponent(bearerToken)}`;
    const handshake =
      `GET ${upstreamPath} HTTP/1.1\r\n` +
      `Host: ${UPSTREAM_HOST}:${UPSTREAM_PORT}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;

    const sock = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
    upstreamHub.socket = sock;
    let settled = false;
    let handshakeDone = false;
    let rxBuf = Buffer.alloc(0);
    let fragOpcode = 0;
    let fragChunks = [];

    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        if (upstreamHub.connectingPromise === promise) {
          upstreamHub.connectingPromise = null;
          upstreamHub.connectingToken = '';
        }
        resolve(result);
      }
    };

    const failAndClose = (status, error) => {
      if (upstreamHub.socket === sock) {
        disconnectUpstreamHub(handshakeDone);
      } else if (!sock.destroyed) {
        try {
          sock.destroy();
        } catch {}
      }
      finish({ ok: false, status, error });
    };

    const connectTimer = setTimeout(() => {
      failAndClose(502, 'Upstream WS handshake timed out');
    }, timeoutMs);

    const drainWsFrames = () => {
      while (upstreamHub.socket === sock && !sock.destroyed && rxBuf.length >= 2) {
        const b0 = rxBuf[0];
        const b1 = rxBuf[1];
        const fin = Boolean(b0 & 0x80);
        const opcode = b0 & 0x0f;
        const masked = Boolean(b1 & 0x80);
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (rxBuf.length < 4) return;
          payloadLen = rxBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (rxBuf.length < 10) return;
          const bigLen = rxBuf.readBigUInt64BE(2);
          if (bigLen > 16n * 1024n * 1024n) {
            failAndClose(502, 'Upstream WS frame too large');
            return;
          }
          payloadLen = Number(bigLen);
          offset = 10;
        }

        const maskLen = masked ? 4 : 0;
        if (rxBuf.length < offset + maskLen + payloadLen) return;

        let payload = rxBuf.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const maskKey = rxBuf.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i += 1) {
            unmasked[i] = payload[i] ^ maskKey[i & 3];
          }
          payload = unmasked;
        } else {
          payload = Buffer.from(payload);
        }

        rxBuf = rxBuf.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x8) {
          failAndClose(502, 'Upstream WS closed');
          return;
        }
        if (opcode === 0x9) {
          try {
            sock.write(buildMaskedClientWsFrame(0xA, payload));
          } catch {
            failAndClose(502, 'Upstream WS pong write failed');
            return;
          }
          continue;
        }
        if (opcode === 0xA) {
          continue;
        }

        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            if (opcode === 0x1) pushHubEvent(payload.toString('utf8'));
          } else {
            fragOpcode = opcode;
            fragChunks = [payload];
          }
        } else if (opcode === 0x0 && fragOpcode) {
          fragChunks.push(payload);
          if (fin) {
            if (fragOpcode === 0x1) {
              pushHubEvent(Buffer.concat(fragChunks).toString('utf8'));
            }
            fragOpcode = 0;
            fragChunks = [];
          }
        }
      }
    };

    sock.on('connect', () => {
      if (upstreamHub.socket !== sock) {
        sock.destroy();
        return;
      }
      sock.write(handshake);
    });

    sock.on('data', (chunk) => {
      if (upstreamHub.socket !== sock) return;
      rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : Buffer.from(chunk);
      if (!handshakeDone) {
        const sepIdx = rxBuf.indexOf('\r\n\r\n');
        if (sepIdx === -1) {
          if (rxBuf.length > 16384) {
            failAndClose(502, 'Malformed upstream WS handshake');
          }
          return;
        }
        const headText = rxBuf.subarray(0, sepIdx).toString('latin1');
        const statusLine = headText.split('\r\n')[0] || '';
        const statusMatch = /^HTTP\/1\.\d\s+(\d{3})/.exec(statusLine);
        const upStatus = statusMatch ? Number(statusMatch[1]) : 502;
        rxBuf = rxBuf.subarray(sepIdx + 4);
        handshakeDone = true;

        if (upStatus !== 101) {
          failAndClose(upStatus === 401 ? 401 : 502, `Upstream WS rejected (${upStatus})`);
          return;
        }

        upstreamHub.connected = true;
        upstreamHub.token = bearerToken;
        upstreamHub.epochSeq += 1;
        upstreamHub.epoch = `hub_${Date.now().toString(36)}_${upstreamHub.epochSeq}`;
        upstreamHub.lastActivityAt = Date.now();
        if (upstreamHub.idleTimer) clearInterval(upstreamHub.idleTimer);
        upstreamHub.idleTimer = setInterval(() => {
          if (
            upstreamHub.connected &&
            upstreamHub.sseSubscribers.size === 0 &&
            Date.now() - upstreamHub.lastActivityAt > HUB_IDLE_DISCONNECT_MS
          ) {
            disconnectUpstreamHub(false);
          }
        }, 30000);
        if (typeof upstreamHub.idleTimer.unref === 'function') {
          upstreamHub.idleTimer.unref();
        }
        finish({ ok: true, status: 200 });
      }
      drainWsFrames();
    });

    sock.on('error', () => {
      failAndClose(502, 'Upstream Link Server WS unavailable');
    });
    sock.on('close', () => {
      failAndClose(502, 'Upstream Link Server WS closed');
    });
  });

  upstreamHub.connectingPromise = promise;
  upstreamHub.connectingToken = bearerToken;
  return promise;
}

async function ensureUpstreamHub(bearerToken, timeoutMs = 2500) {
  upstreamHub.lastActivityAt = Date.now();
  if (upstreamHub.connected && upstreamHub.socket && !upstreamHub.socket.destroyed) {
    if (safeTokenEqual(bearerToken, upstreamHub.token)) {
      return { ok: true, status: 200 };
    }
    const valid = await probeUpstreamBearer(bearerToken, 2000);
    if (!valid) {
      return { ok: false, status: 401, error: 'Upstream WS rejected (401)' };
    }
    return startHubConnection(bearerToken, timeoutMs);
  }

  if (upstreamHub.connectingPromise) {
    if (safeTokenEqual(bearerToken, upstreamHub.connectingToken)) {
      return upstreamHub.connectingPromise;
    }
    await upstreamHub.connectingPromise;
    if (upstreamHub.connected && upstreamHub.socket && !upstreamHub.socket.destroyed) {
      if (safeTokenEqual(bearerToken, upstreamHub.token)) {
        return { ok: true, status: 200 };
      }
      const valid = await probeUpstreamBearer(bearerToken, 2000);
      if (!valid) {
        return { ok: false, status: 401, error: 'Upstream WS rejected (401)' };
      }
    }
  }

  return startHubConnection(bearerToken, timeoutMs);
}

async function handleSidecarPoll(req, res, urlObj) {
  const authHdr = String(req.headers.authorization || '').trim();
  const bearerToken = authHdr.toLowerCase().startsWith('bearer ') ? authHdr.slice(7).trim() : '';
  if (!bearerToken) {
    sendJson(res, 401, { ok: false, error: 'Missing upstream bearer token' });
    return;
  }

  const conn = await ensureUpstreamHub(bearerToken, 2500);
  if (!conn.ok) {
    if (conn.status === 401) {
      sendJson(res, 401, { ok: false, error: conn.error || 'Unauthorized' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      connected: false,
      epoch: upstreamHub.epoch,
      seq: upstreamHub.seq,
      reset: false,
      events: [],
    });
    return;
  }

  const sinceRaw = urlObj.searchParams.get('since');
  let since = -1;
  if (sinceRaw !== null && sinceRaw !== '') {
    const parsed = Number.parseInt(sinceRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      since = parsed;
    }
  }

  let events = [];
  let reset = false;
  if (since >= 0) {
    const oldestSeq = upstreamHub.events.length ? upstreamHub.events[0].seq : upstreamHub.seq + 1;
    if (since > upstreamHub.seq || (upstreamHub.events.length > 0 && since < oldestSeq - 1)) {
      events = upstreamHub.events.map((e) => e.text);
      reset = true;
    } else if (since < upstreamHub.seq) {
      events = upstreamHub.events.filter((e) => e.seq > since).map((e) => e.text);
    }
  }

  sendJson(res, 200, {
    ok: true,
    connected: true,
    epoch: upstreamHub.epoch,
    seq: upstreamHub.seq,
    reset,
    events,
  });
}

async function bridgeUpstreamWsToSse(req, res, urlObj) {
  const authHdr = String(req.headers.authorization || '').trim();
  const bearerFromHdr = authHdr.toLowerCase().startsWith('bearer ') ? authHdr.slice(7).trim() : '';
  const bearerToken = bearerFromHdr || String(urlObj.searchParams.get('token') || '').trim();
  if (!bearerToken) {
    sendJson(res, 401, { ok: false, error: 'Missing upstream bearer token' });
    return;
  }

  const conn = await ensureUpstreamHub(bearerToken, 3000);
  if (res.writableEnded || res.destroyed) return;
  if (!conn.ok) {
    sendJson(res, conn.status === 401 ? 401 : 502, {
      ok: false,
      error: conn.error || 'Upstream Link Server WS unavailable',
    });
    return;
  }

  // Cap active SSE streams so legacy/cached clients can NEVER exhaust Chromium's 6-connection HTTP/1.1 pool.
  while (upstreamHub.sseSubscribers.size >= MAX_SSE_SUBSCRIBERS) {
    const oldest = upstreamHub.sseSubscribers.values().next().value;
    if (!oldest) break;
    oldest.close();
  }

  let closed = false;
  let keepaliveTimer = null;
  let maxLifeTimer = null;

  const sub = {
    emit(singleLine) {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${singleLine}\n\n`);
      } catch {
        sub.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      upstreamHub.sseSubscribers.delete(sub);
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (maxLifeTimer) {
        clearTimeout(maxLifeTimer);
        maxLifeTimer = null;
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {}
      }
    },
  };

  upstreamHub.sseSubscribers.add(sub);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'connection': 'close',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  try {
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() / 1000 })}\n\n`);
  } catch {
    sub.close();
    return;
  }

  keepaliveTimer = setInterval(() => {
    if (!closed && !res.writableEnded) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        sub.close();
      }
    }
  }, 15000);
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();

  maxLifeTimer = setTimeout(() => {
    sub.close();
  }, SSE_MAX_LIFETIME_MS);
  if (typeof maxLifeTimer.unref === 'function') maxLifeTimer.unref();

  req.on('aborted', () => sub.close());
  res.on('close', () => sub.close());
  res.on('error', () => sub.close());
}

function buildUpstreamPath(urlObj, stripAllQuery = false) {
  if (stripAllQuery) {
    return urlObj.pathname;
  }
  const cloned = new URLSearchParams(urlObj.searchParams);
  cloned.delete('sidecar_token');
  const qs = cloned.toString();
  return qs ? `${urlObj.pathname}?${qs}` : urlObj.pathname;
}

function checkRequestAuth(req, urlObj, pathname) {
  if (!SIDECAR_TOKEN) return true;

  const headerToken = String(req.headers['x-sidecar-token'] || '').trim();
  const querySidecarToken = urlObj.searchParams.get('sidecar_token') || '';
  const queryToken = urlObj.searchParams.get('token') || '';

  if ((req.method === 'GET' || req.method === 'HEAD') && SAFE_STATIC_PATHS.has(pathname)) {
    return true;
  }

  if (HEADER_ONLY_AUTH_PATHS.has(pathname)) {
    return safeTokenEqual(headerToken, SIDECAR_TOKEN);
  }

  if (pathname === '/' || pathname === '/index.html' || pathname === '/sidebar') {
    return safeTokenEqual(headerToken, SIDECAR_TOKEN)
      || safeTokenEqual(queryToken, SIDECAR_TOKEN)
      || safeTokenEqual(querySidecarToken, SIDECAR_TOKEN);
  }

  return safeTokenEqual(headerToken, SIDECAR_TOKEN)
    || safeTokenEqual(querySidecarToken, SIDECAR_TOKEN)
    || safeTokenEqual(queryToken, SIDECAR_TOKEN);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      logReject(403, req.method, req.url || '/', 'options_blocked', req, null);
      sendText(res, 403, 'Forbidden');
      return;
    }

    let urlObj;
    const rawUrl = normalizeRawUrl(req.url || '/');
    try {
      urlObj = new URL(rawUrl, `http://${BIND_HOST}`);
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }

    const pathname = urlObj.pathname || '/';
    if (hasUnsafePath(rawUrl, pathname)) {
      logReject(400, req.method, pathname, 'unsafe_path', req, urlObj);
      sendText(res, 400, 'Bad Path');
      return;
    }

    const isSafeStatic = (req.method === 'GET' || req.method === 'HEAD') && SAFE_STATIC_PATHS.has(pathname);
    const authPassed = checkRequestAuth(req, urlObj, pathname);
    const hasExplicitToken = Boolean(SIDECAR_TOKEN) && !isSafeStatic && authPassed;

    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, hasExplicitToken)) {
      logReject(403, req.method, pathname, 'forbidden_origin', req, urlObj);
      sendText(res, 403, 'Forbidden Origin');
      return;
    }

    const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
    if (secFetchSite === 'cross-site') {
      const allowCrossSite = isSafeStatic || hasExplicitToken;
      if (!allowCrossSite) {
        logReject(403, req.method, pathname, 'cross_site_unauthenticated', req, urlObj);
        sendText(res, 403, 'Forbidden Cross-Site Request');
        return;
      }
    }

    if (!authPassed) {
      logReject(401, req.method, pathname, 'unauthorized', req, urlObj);
      if (pathname.startsWith('/api/') || pathname.startsWith('/__sidecar/')) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized: invalid or missing sidecar token' });
      } else {
        sendText(res, 401, 'Unauthorized: invalid or missing sidecar token');
      }
      return;
    }

    // Local sidecar bridge scripts
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/preload.js') {
      serveLocalFile(res, path.join(__dirname, 'preload.js'), 'application/javascript; charset=utf-8', req.method);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/sidecar-bridge.js') {
      serveLocalFile(res, path.join(__dirname, 'sidecar-bridge.js'), 'application/javascript; charset=utf-8', req.method);
      return;
    }

    // Local sidecar control routes
    if (pathname === '/__sidecar/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        return;
      }
      const [probe, loc] = await Promise.all([
        probeUpstreamHealth(1500),
        Promise.resolve(resolveServerLocation()),
      ]);
      sendJson(res, 200, {
        sidecar: 'ok',
        version: SIDECAR_VERSION,
        upstreamOnline: probe.online,
        upstreamPort: UPSTREAM_PORT,
        canStartServer: loc.canStartServer,
        serverDirConfigured: loc.serverDirConfigured,
      });
      return;
    }

    if (pathname === '/__sidecar/start-server') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        return;
      }
      const result = await startLocalLinkServer();
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (pathname === '/__sidecar/poll') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        return;
      }
      await handleSidecarPoll(req, res, urlObj);
      return;
    }

    if (pathname === '/__sidecar/events') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        return;
      }
      await bridgeUpstreamWsToSse(req, res, urlObj);
      return;
    }

    // Root Workbench HTML (aux pane / and sidebar /sidebar) with preload + sidecar-bridge injection and offline fallback
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html' || pathname === '/sidebar')) {
      proxyHtmlWithInjection(req, res, '/', {
        scriptsMarkup: `<script src="/preload.js?v=${SIDECAR_VERSION}"></script>\n  <script src="/sidecar-bridge.js?v=${SIDECAR_VERSION}"></script>`,
        fallbackOffline: true,
        preserveFrameHeaders: false,
      });
      return;
    }

    // Local /pair iframe page with bridge injection.
    // Inside Antigravity Electron, #pair-iframe is a nested iframe whose top-level ancestor is the
    // Antigravity host app (not 127.0.0.1:<sidecarPort>). Chromium enforces X-Frame-Options: SAMEORIGIN
    // and CSP frame-ancestors 'self' across the ENTIRE ancestor chain, which would black-screen #pair-iframe.
    // Because SIDECAR_TOKEN has already been verified above (constant-time), stripping frame-blocking
    // headers ONLY when SIDECAR_TOKEN is active keeps external unauthenticated sites blocked (401) while
    // allowing Antigravity's authenticated side pane to render the QR pairing sheet cleanly.
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/pair') {
      const upstreamPath = buildUpstreamPath(urlObj, false);
      proxyHtmlWithInjection(req, res, upstreamPath, {
        scriptsMarkup: `<script src="/sidecar-bridge.js?v=${SIDECAR_VERSION}"></script>`,
        fallbackOffline: false,
        preserveFrameHeaders: !SIDECAR_TOKEN,
        transformHtml: (html) =>
          html.replace(
            "location.replace('/pair?ip=tunnel')",
            "location.replace(window.__AGY_SIDECAR__ ? window.__AGY_SIDECAR__.withToken('/pair?ip=tunnel') : '/pair?ip=tunnel')"
          ),
      });
      return;
    }

    // All other /api/*, /download-apk, /health, and static assets: binary-safe streaming proxy
    const upstreamPath = buildUpstreamPath(urlObj, false);
    proxyStreamingHttp(req, res, upstreamPath);
  } catch {
    if (!res.headersSent) {
      sendText(res, 500, 'Internal Sidecar Error');
    } else {
      res.destroy();
    }
  }
});

function writeRawUpgradeError(socket, statusCode, reason) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'X-Content-Type-Options: nosniff\r\n' +
      'Referrer-Policy: no-referrer\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n\r\n'
    );
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});

  let urlObj;
  const rawUrl = normalizeRawUrl(req.url || '/');
  try {
    urlObj = new URL(rawUrl, `http://${BIND_HOST}`);
  } catch {
    writeRawUpgradeError(socket, 400, 'Bad Request');
    return;
  }

  const pathname = urlObj.pathname || '/';
  if (pathname !== '/ws' || hasUnsafePath(rawUrl, pathname)) {
    logReject(404, 'UPGRADE', pathname, 'bad_ws_path', req, urlObj);
    writeRawUpgradeError(socket, 404, 'Not Found');
    return;
  }

  const headerToken = String(req.headers['x-sidecar-token'] || '').trim();
  const querySidecarToken = urlObj.searchParams.get('sidecar_token') || '';
  const wsAuthPassed = !SIDECAR_TOKEN
    || safeTokenEqual(headerToken, SIDECAR_TOKEN)
    || safeTokenEqual(querySidecarToken, SIDECAR_TOKEN);
  const hasExplicitWsToken = Boolean(SIDECAR_TOKEN) && wsAuthPassed;

  if (!isAllowedOrigin(req.headers.origin, hasExplicitWsToken)) {
    logReject(403, 'UPGRADE', pathname, 'ws_forbidden_origin', req, urlObj);
    writeRawUpgradeError(socket, 403, 'Forbidden');
    return;
  }

  const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (secFetchSite === 'cross-site' && !hasExplicitWsToken) {
    logReject(403, 'UPGRADE', pathname, 'ws_cross_site_unauth', req, urlObj);
    writeRawUpgradeError(socket, 403, 'Forbidden');
    return;
  }

  if (!wsAuthPassed) {
    logReject(401, 'UPGRADE', pathname, 'ws_unauthorized', req, urlObj);
    writeRawUpgradeError(socket, 401, 'Unauthorized');
    return;
  }

  const upstreamPath = buildUpstreamPath(urlObj, false);
  if (/[\r\n]/.test(upstreamPath)) {
    writeRawUpgradeError(socket, 400, 'Bad Request');
    return;
  }

  const cleanHeaders = sanitizeUpstreamHeaders(req.headers);
  const headerLines = [`GET ${upstreamPath} HTTP/1.1`];
  for (const [key, value] of Object.entries(cleanHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const s = String(item);
        if (!/[\r\n]/.test(key) && !/[\r\n]/.test(s)) {
          headerLines.push(`${key}: ${s}`);
        }
      }
    } else if (value !== undefined) {
      const s = String(value);
      if (!/[\r\n]/.test(key) && !/[\r\n]/.test(s)) {
        headerLines.push(`${key}: ${s}`);
      }
    }
  }
  const upgradePayload = `${headerLines.join('\r\n')}\r\n\r\n`;

  const upstream = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
  let connected = false;

  const cleanup = () => {
    if (!upstream.destroyed) upstream.destroy();
    if (!socket.destroyed) socket.destroy();
  };

  upstream.on('connect', () => {
    connected = true;
    upstream.write(upgradePayload);
    if (head && head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', () => {
    if (!connected && !socket.destroyed) {
      writeRawUpgradeError(socket, 502, 'Bad Gateway');
    } else {
      cleanup();
    }
  });

  upstream.on('close', cleanup);
  socket.on('close', cleanup);
});

server.listen(LISTEN_PORT, BIND_HOST, () => {
  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : LISTEN_PORT;
  console.log(`[antigravity-sync] workbench sidecar v${SIDECAR_VERSION} listening on http://${BIND_HOST}:${actualPort} -> http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});

function shutdown() {
  disconnectUpstreamHub(true);
  server.close(() => process.exit(0));
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
