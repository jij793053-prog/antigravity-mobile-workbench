#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$SCRIPT_DIR/plugin"
MANIFEST_PATH="$PLUGIN_SRC/plugin.json"
SERVER_PY="$SCRIPT_DIR/agy_mobile_server.py"

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "[ERROR] Missing plugin manifest: $MANIFEST_PATH" >&2
  exit 1
fi
if [[ ! -f "$SERVER_PY" ]]; then
  echo "[ERROR] Missing Link Server script: $SERVER_PY" >&2
  exit 1
fi

# 1. Verify Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js 18+ is required to run the Mobile Sync sidecar plugin, but 'node' was not found in PATH." >&2
  echo "Install Node.js 18+ from https://nodejs.org/ and retry." >&2
  exit 1
fi

NODE_VER="$(node -v)"
NODE_MAJOR="$(node -p "parseInt(process.versions.node.split('.')[0], 10)")"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 18 ]]; then
  echo "[ERROR] Node.js 18+ is required, found $NODE_VER. Please upgrade Node.js and retry." >&2
  exit 1
fi

# 2. Detect Python environment with aiohttp installed (best-effort)
detect_python() {
  local cand
  for cand in \
    "${AGY_MOBILE_PYTHON:-}" \
    "$SCRIPT_DIR/.venv/bin/python" \
    "$SCRIPT_DIR/venv/bin/python" \
    "$(command -v python3 2>/dev/null || true)" \
    "$(command -v python 2>/dev/null || true)"; do
    if [[ -n "$cand" && -x "$cand" ]] && "$cand" -c "import aiohttp" >/dev/null 2>&1; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

DETECTED_PY=""
if PY_FOUND="$(detect_python)"; then
  DETECTED_PY="$PY_FOUND"
fi

# 3. Validate port (default 18795)
PORT_NUM=18795
if [[ -n "${AGY_MOBILE_PORT:-}" && "${AGY_MOBILE_PORT}" =~ ^[0-9]+$ ]]; then
  if (( AGY_MOBILE_PORT >= 1 && AGY_MOBILE_PORT <= 65535 )); then
    PORT_NUM="$AGY_MOBILE_PORT"
  fi
fi

# 4. Sync plugin/ into ~/.gemini/config/plugins/antigravity-sync/ in-place (NEVER touch config.json)
PLUGINS_ROOT="$HOME/.gemini/config/plugins"
DEST_PLUGIN_DIR="$PLUGINS_ROOT/antigravity-sync"
mkdir -p "$DEST_PLUGIN_DIR"
cp -R "$PLUGIN_SRC/." "$DEST_PLUGIN_DIR/"

node -e '
const fs = require("node:fs");
const path = require("node:path");
const [srcRoot, destRoot] = process.argv.slice(1);
const expected = new Set();
function walk(dir, base, cb) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full);
    if (ent.isDirectory()) walk(full, base, cb);
    else if (ent.isFile()) cb(full, rel);
  }
}
walk(srcRoot, srcRoot, (_full, rel) => expected.add(rel));
walk(destRoot, destRoot, (full, rel) => {
  if (!expected.has(rel)) {
    try { fs.unlinkSync(full); } catch {}
  }
});
' "$PLUGIN_SRC" "$DEST_PLUGIN_DIR"

# 5. Write ~/.gemini/antigravity-mobile/plugin_host.json safely via Node.js
HOST_CFG_DIR="$HOME/.gemini/antigravity-mobile"
HOST_CFG_PATH="$HOST_CFG_DIR/plugin_host.json"
mkdir -p "$HOST_CFG_DIR"

node -e '
const fs = require("node:fs");
const [cfgPath, serverDir, pythonBin, portStr] = process.argv.slice(1);
const payload = {
  serverDir,
  pythonBin,
  port: Number(portStr)
};
fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
' "$HOST_CFG_PATH" "$SCRIPT_DIR" "$DETECTED_PY" "$PORT_NUM"

echo "============================================================"
echo "  Antigravity Mobile Sync Plugin Installed (v1.7.0)"
echo "============================================================"
echo "  Plugin Dir  : $DEST_PLUGIN_DIR"
echo "  Host Config : $HOST_CFG_PATH"
echo "  Node.js     : $NODE_VER (OK)"
if [[ -n "$DETECTED_PY" ]]; then
  echo "  Python Bin  : $DETECTED_PY"
else
  echo "  Python Bin  : (not detected with aiohttp yet; run 'pip install -r requirements.txt')"
fi
echo "  Target Port : 127.0.0.1:$PORT_NUM"
echo "  Note        : ~/.gemini/config/config.json was NOT modified."
echo "------------------------------------------------------------"
echo "  Next Steps / 下一步:"
echo "  1. Open or restart Antigravity (auto-discovers ~/.gemini/config/plugins/antigravity-sync)."
echo "  2. Open '+' in the right auxiliary pane -> 'Mobile Sync', or select 'Mobile Sync' in the left sidebar."
echo "  3. Manage enable/disable anytime under Customizations > Installed."
echo "  4. If the local Link Server is offline, launch it with one click inside the panel or run ./start_link_server.sh."
echo "============================================================"
