#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PY="$SCRIPT_DIR/agy_mobile_server.py"
PORT_NUM="${AGY_MOBILE_PORT:-18795}"

find_python() {
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

if ! PY_EXE="$(find_python)"; then
  echo "[ERROR] 未找到已安装 aiohttp 的 Python 3 环境。" >&2
  echo "请执行: pip install -r requirements.txt" >&2
  exit 1
fi

echo "============================================================"
echo "  Antigravity Link Server & Desktop Sync Workbench"
echo "============================================================"
echo "  Python     : $PY_EXE"
echo "  Workbench  : http://127.0.0.1:$PORT_NUM/"
echo "  Pair Page  : http://127.0.0.1:$PORT_NUM/pair"
echo "============================================================"
exec "$PY_EXE" "$SERVER_PY"
