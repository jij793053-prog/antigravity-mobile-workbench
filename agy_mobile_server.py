#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Antigravity Link Server (Universal Companion Server, 0.0.0.0 : 18795)
Native companion backend for the universal Antigravity Mobile Android APK.
- 100% universal & privacy-safe: ZERO hardcoded personal paths, usernames, or IPs.
- Auto-discovers official `agy` / `agy.exe`, workspace root, LAN & Tailscale IPv4s.
- Effortless pairing via zero-dependency pure-Python SVG QR (`agylink://pair?...`)
  and 6-digit numeric PIN (`POST /api/pair/claim`, rate-limited 10/min).
- Unified view of Desktop Antigravity IDE conversations and Mobile/CLI conversations.
- Real-time WebSocket streaming (thinking/tools/text_delta/deliverables/cancel).
- Safe file upload, workspace file browser, preview/download, and optional QQ Bot bridge.
"""

from __future__ import annotations

import asyncio
import atexit
import collections
from datetime import datetime, timezone
import hashlib
import html as html_lib
import ipaddress
import json
import mimetypes
import os
import pathlib
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from aiohttp import WSMsgType, web

APP_NAME = "Antigravity Link Server"
APP_VERSION = "1.7.3"
APK_FILENAME = "Antigravity-Mobile-Universal-v1.7.apk"

PROJECT_DIR = pathlib.Path(__file__).resolve().parent
WWW_DIR = PROJECT_DIR / "www"
DIST_DIR = PROJECT_DIR / "dist"
CONFIG_FILE = PROJECT_DIR / "mobile_config.json"


def _resolve_workspace_root() -> pathlib.Path:
    env_ws = str(os.environ.get("AGY_MOBILE_WORKSPACE") or "").strip()
    if env_ws:
        p = pathlib.Path(env_ws).expanduser()
        if p.is_dir():
            return p.resolve()
    if PROJECT_DIR.parent.name.lower() == "projects" and PROJECT_DIR.parent.parent.is_dir():
        return PROJECT_DIR.parent.parent.resolve()
    return pathlib.Path.home().resolve()


def _resolve_upload_dir(ws_root: pathlib.Path) -> pathlib.Path:
    scratch_dir = ws_root / "scratch"
    if scratch_dir.is_dir():
        target = scratch_dir / "agy_mobile_uploads"
    else:
        target = PROJECT_DIR / "uploads"
    target.mkdir(parents=True, exist_ok=True)
    return target


HOME_DIR = pathlib.Path.home()
WORKSPACE_ROOT = _resolve_workspace_root()
UPLOAD_DIR = _resolve_upload_dir(WORKSPACE_ROOT)

DESKTOP_BRAIN = HOME_DIR / ".gemini" / "antigravity" / "brain"
DESKTOP_ANN = HOME_DIR / ".gemini" / "antigravity" / "annotations"
CLI_BRAIN = HOME_DIR / ".gemini" / "antigravity-cli" / "brain"
CLI_CONV = HOME_DIR / ".gemini" / "antigravity-cli" / "conversations"
CLI_ANN = HOME_DIR / ".gemini" / "antigravity-cli" / "annotations"

PORT = int(os.environ.get("AGY_MOBILE_PORT", "18795"))
HOST = os.environ.get("AGY_MOBILE_HOST", "0.0.0.0")

_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_STEP_IDX_RE = re.compile(r'"step_index"\s*:\s*(\d+)')
_CID_RE = re.compile(r"^[A-Za-z0-9_-]{6,80}$")
_QUEUE_ITEM_ID_RE = re.compile(r"^q_[0-9a-f]{6,24}$")
_SAFE_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_WIN_ABS_PATH_RE = re.compile(r"\b[A-Za-z]:[/\\][^\s\"'<>|()]+")
_UNIX_HOME_PATH_RE = re.compile(r"/(?:Users|home)/[^\s\"'<>|()]+")
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
_LOOPBACK_HOST_RE = re.compile(r"^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$", re.IGNORECASE)
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_SENSITIVE_NAMES = {
    "agy_env.json", "webui.json", "mobile_config.json",
    ".env", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "authorized_keys", "known_hosts",
    "credentials", "credentials.json", "secrets.json",
    "login data", "cookies", "history", "web data", "local state",
    "passwd", "shadow", "sam",
}
_SENSITIVE_SUFFIXES = (".pem", ".key", ".pfx", ".p12", ".kdbx", ".jks", ".keystore", ".ppk")
_SENSITIVE_SEGS = (
    "/.ssh/", "/.aws/", "/.gnupg/",
    "/.docker/config.json/", "/.kube/config/", "/.config/gh/hosts.yml/",
    "/appdata/roaming/", "/appdata/local/",
    "/etc/passwd/", "/etc/shadow/", "/proc/",
)

MODEL_GROUPS: list[dict[str, Any]] = [
    {
        "group": "Orchestrator 智能编排（搭配模式）",
        "tag": "自动路由",
        "models": [
            {"id": "gemini-pro-orchestrator-neon", "label": "Orchestrator · Neon", "desc": "编排 + 旗舰 Neon 深度搭配"},
            {"id": "gemini-pro-orchestrator", "label": "Orchestrator · Carbon", "desc": "编排 + 高智 Carbon 均衡搭配"},
            {"id": "gemini-pro-orchestrator-argon", "label": "Orchestrator · Argon", "desc": "编排 + 极速 Argon 省额搭配"},
        ],
    },
    {
        "group": "Gemini 4 Neon",
        "tag": "旗舰",
        "models": [
            {"id": "gemini-4-neon-xhigh", "label": "Neon XHigh", "desc": "最高深度推理"},
            {"id": "gemini-4-neon-high", "label": "Neon High", "desc": "高强工程/架构"},
            {"id": "gemini-4-neon-medium", "label": "Neon Medium", "desc": "均衡推荐"},
            {"id": "gemini-4-neon-low", "label": "Neon Low", "desc": "极速高智商"},
        ],
    },
    {
        "group": "Gemini 4 Hydrogen",
        "tag": "均衡",
        "models": [
            {"id": "gemini-4-hydrogen-xhigh", "label": "Hydrogen XHigh", "desc": "深度推理"},
            {"id": "gemini-4-hydrogen-high", "label": "Hydrogen High", "desc": "主力编程"},
            {"id": "gemini-4-hydrogen-medium", "label": "Hydrogen Medium", "desc": "日常任务"},
            {"id": "gemini-4-hydrogen-low", "label": "Hydrogen Low", "desc": "轻量快速"},
        ],
    },
    {
        "group": "Gemini 4 Carbon",
        "tag": "高智",
        "models": [
            {"id": "gemini-4-carbon-high", "label": "Carbon High", "desc": "强推理"},
            {"id": "gemini-4-carbon-medium", "label": "Carbon Medium", "desc": "均衡"},
            {"id": "gemini-4-carbon-low", "label": "Carbon Low", "desc": "轻快"},
        ],
    },
    {
        "group": "Gemini 4 Argon & 3.8 Flash",
        "tag": "极速",
        "models": [
            {"id": "gemini-4-argon-high", "label": "Argon High", "desc": "快速编码"},
            {"id": "gemini-4-argon-medium", "label": "Argon Medium", "desc": "标准"},
            {"id": "gemini-4-argon-low", "label": "Argon Low", "desc": "极速轻量"},
            {"id": "gemini-3.8-flash-high", "label": "3.8 Flash High", "desc": "闪电响应"},
            {"id": "gemini-3.8-flash-medium", "label": "3.8 Flash Medium", "desc": "省额日常"},
            {"id": "gemini-3.8-flash-low", "label": "3.8 Flash Low", "desc": "超轻极快"},
        ],
    },
    {
        "group": "Claude 5.5 & 开源",
        "tag": "精工",
        "models": [
            {"id": "claude-opus-5-5-high", "label": "Opus 5.5 High", "desc": "复杂架构"},
            {"id": "claude-opus-5-5-medium", "label": "Opus 5.5 Medium", "desc": "精致代码"},
            {"id": "claude-opus-5-5-low", "label": "Opus 5.5 Low", "desc": "轻快旗舰"},
            {"id": "claude-sonnet-5-5-high", "label": "Sonnet 5.5 High", "desc": "高效开发"},
            {"id": "claude-sonnet-5-5-medium", "label": "Sonnet 5.5 Medium", "desc": "日常首选"},
            {"id": "claude-sonnet-5-5-low", "label": "Sonnet 5.5 Low", "desc": "轻量快速"},
            {"id": "gpt-oss-120b-medium", "label": "GPT-OSS 120B", "desc": "开源大模型"},
        ],
    },
]

_KNOWN_MODEL_IDS: frozenset[str] = frozenset(
    str(m.get("id") or "")
    for g in MODEL_GROUPS
    for m in (g.get("models") or [])
    if m.get("id")
)

_CONFIG_LOCK = threading.Lock()
_ACTIVE_RUNS_LOCK = threading.Lock()
_ACTIVE_RUNS: dict[str, dict[str, Any]] = {}
_CONV_QUEUES_LOCK = threading.Lock()
_CONV_QUEUES: dict[str, list[dict[str, Any]]] = {}
_CONV_QUEUE_MAX = 20
_DRAINING_CIDS: set[str] = set()
_PENDING_SPAWNS: int = 0
_MAX_CONCURRENT_RUNS = 4
_WS_CLIENTS: set[web.WebSocketResponse] = set()
_MAX_WS_CLIENTS = 32
_LOOP: asyncio.AbstractEventLoop | None = None

_VALID_PERMISSION_MODES = ("auto", "ask", "bypass")
_MOBILE_ASK_PROFILE_NAME = "mobile_ask_profile"
_INTERACTION_ID_RE = re.compile(r"^int_[0-9a-f]{6,32}$")
_VALID_PERM_DECISIONS = ("allow_once", "allow_always", "reject_once", "reject_always", "cancel")
_PENDING_INTERACTIONS_LOCK = threading.Lock()
_PENDING_INTERACTIONS: dict[str, dict[str, Any]] = {}

_PAIR_PIN_LOCK = threading.Lock()
_RUNTIME_PAIR_PIN: str = ""
_RUNTIME_PAIR_PIN_CREATED_AT: float = 0.0
_PAIR_PIN_FAIL_COUNT: int = 0
_PAIR_PIN_TTL_SEC = 600.0
_PAIR_PIN_MAX_GLOBAL_FAILS = 15

_CLAIM_RATE_LOCK = threading.Lock()
_CLAIM_ATTEMPTS: collections.OrderedDict[str, collections.deque[float]] = collections.OrderedDict()
_CLAIM_LIMIT_PER_MIN = 10
_CLAIM_MAX_KEYS = 4096

_TUNNEL_LOCK = threading.Lock()
_TUNNEL_STOP_EVT = threading.Event()
_TUNNEL_GEN: int = 0
_TUNNEL_THREAD: threading.Thread | None = None
_TUNNEL_STATE: dict[str, Any] = {
    "enabled": True,
    "mode": "quick",
    "status": "disabled",
    "url": "",
    "error": "",
    "bin": "",
    "started_at": 0.0,
    "metrics_port": 0,
    "external_pid": 0,
    "ready_connections": 0,
    "last_healthy_at": 0.0,
    "unhealthy_streak": 0,
    "auto_heals": 0,
    "last_heal_at": 0.0,
    "proc": None,
}
_CF_QUICK_URL_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
_TAILSCALE_FUNNEL_CACHE_LOCK = threading.Lock()
_TAILSCALE_FUNNEL_CACHE: tuple[float, str] = (0.0, "")

_USAGE_CACHE_LOCK = threading.Lock()
_USAGE_FILE_CACHE: dict[str, tuple[int, int, list[tuple[float, str, int, int, int]], int]] = {}
_USAGE_CACHE_MAX = 4096
_USAGE_GLOBAL_CACHE_LOCK = threading.Lock()
_USAGE_GLOBAL_CACHE: tuple[float, dict[str, Any]] | None = None
_USAGE_GLOBAL_TTL_SEC = 15.0

_CTX_CACHE_LOCK = threading.Lock()
_CTX_FILE_CACHE: dict[str, tuple[int, int, dict[str, Any] | None]] = {}
_CTX_CACHE_MAX = 256

_LIVE_CTX_CACHE_LOCK = threading.Lock()
_LIVE_CTX_CACHE: dict[str, tuple[float, dict[str, Any] | None]] = {}
_LIVE_CTX_CACHE_TTL_SEC = 3.0
_LIVE_CTX_CACHE_MAX = 128

_SWARM_ACTION_CACHE_LOCK = threading.Lock()
_SWARM_ACTION_CACHE: dict[str, tuple[int, int, str]] = {}
_SWARM_ACTION_CACHE_MAX = 256


# ---------------------------------------------------------------------------
# Pure-Python ISO/IEC 18004 QR Code Encoder (Versions 1-10, Byte Mode) + SVG
# ---------------------------------------------------------------------------

_GF_EXP = [0] * 512
_GF_LOG = [0] * 256
_gf_x = 1
for _gf_i in range(255):
    _GF_EXP[_gf_i] = _gf_x
    _GF_LOG[_gf_x] = _gf_i
    _gf_x <<= 1
    if _gf_x & 0x100:
        _gf_x ^= 0x11D
for _gf_i in range(255, 512):
    _GF_EXP[_gf_i] = _GF_EXP[_gf_i - 255]

_QR_ALIGN_POS: dict[int, list[int]] = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
}

# (ecc_per_block, g1_blocks, g1_data_cw, g2_blocks, g2_data_cw)
_QR_RS_SPEC: dict[str, dict[int, tuple[int, int, int, int, int]]] = {
    "M": {
        1: (10, 1, 16, 0, 0),
        2: (16, 1, 28, 0, 0),
        3: (26, 1, 44, 0, 0),
        4: (18, 2, 32, 0, 0),
        5: (24, 2, 43, 0, 0),
        6: (16, 4, 27, 0, 0),
        7: (18, 4, 31, 0, 0),
        8: (22, 2, 38, 2, 39),
        9: (22, 3, 36, 2, 37),
        10: (26, 4, 43, 1, 44),
    },
    "L": {
        1: (7, 1, 19, 0, 0),
        2: (10, 1, 34, 0, 0),
        3: (15, 1, 55, 0, 0),
        4: (20, 1, 80, 0, 0),
        5: (26, 1, 108, 0, 0),
        6: (18, 2, 68, 0, 0),
        7: (20, 2, 78, 0, 0),
        8: (24, 2, 97, 0, 0),
        9: (30, 2, 116, 0, 0),
        10: (18, 2, 68, 2, 69),
    },
}

_QR_EC_FORMAT_BITS = {"L": 0b01, "M": 0b00, "Q": 0b11, "H": 0b10}


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator(degree: int) -> list[int]:
    poly = [1]
    for i in range(degree):
        root = _GF_EXP[i]
        nxt = [0] * (len(poly) + 1)
        for j, coef in enumerate(poly):
            nxt[j] ^= coef
            nxt[j + 1] ^= _gf_mul(coef, root)
        poly = nxt
    return poly


def _rs_remainder(data: list[int], degree: int) -> list[int]:
    gen = _rs_generator(degree)
    rem = [0] * degree
    for b in data:
        factor = b ^ rem[0]
        rem = rem[1:] + [0]
        if factor:
            for j in range(degree):
                rem[j] ^= _gf_mul(gen[j + 1], factor)
    return rem


def _qr_format_bits(ec_level: str, mask_id: int) -> int:
    data = (_QR_EC_FORMAT_BITS[ec_level] << 3) | mask_id
    rem = data << 10
    for i in range(4, -1, -1):
        if (rem >> (i + 10)) & 1:
            rem ^= 0x537 << i
    return ((data << 10) | rem) ^ 0x5412


def _qr_version_bits(version: int) -> int:
    rem = version << 12
    for i in range(5, -1, -1):
        if (rem >> (i + 12)) & 1:
            rem ^= 0x1F25 << i
    return (version << 12) | rem


def _qr_mask_cond(mask_id: int, r: int, c: int) -> bool:
    if mask_id == 0:
        return (r + c) % 2 == 0
    if mask_id == 1:
        return r % 2 == 0
    if mask_id == 2:
        return c % 3 == 0
    if mask_id == 3:
        return (r + c) % 3 == 0
    if mask_id == 4:
        return (r // 2 + c // 3) % 2 == 0
    if mask_id == 5:
        return ((r * c) % 2 + (r * c) % 3) == 0
    if mask_id == 6:
        return (((r * c) % 2 + (r * c) % 3) % 2) == 0
    return (((r + c) % 2 + (r * c) % 3) % 2) == 0


def _qr_penalty(mat: list[list[int]]) -> int:
    n = len(mat)
    score = 0
    # Rule 1: 5+ consecutive same-color modules in rows and columns
    for r in range(n):
        run_c = mat[r][0]
        run_len = 1
        for c in range(1, n):
            if mat[r][c] == run_c:
                run_len += 1
            else:
                if run_len >= 5:
                    score += 3 + (run_len - 5)
                run_c = mat[r][c]
                run_len = 1
        if run_len >= 5:
            score += 3 + (run_len - 5)
    for c in range(n):
        run_c = mat[0][c]
        run_len = 1
        for r in range(1, n):
            if mat[r][c] == run_c:
                run_len += 1
            else:
                if run_len >= 5:
                    score += 3 + (run_len - 5)
                run_c = mat[r][c]
                run_len = 1
        if run_len >= 5:
            score += 3 + (run_len - 5)
    # Rule 2: 2x2 same-color blocks
    for r in range(n - 1):
        row0 = mat[r]
        row1 = mat[r + 1]
        for c in range(n - 1):
            v = row0[c]
            if v == row0[c + 1] == row1[c] == row1[c + 1]:
                score += 3
    # Rule 3: finder-like 1:1:3:1:1 patterns with 4-module light guard
    p1 = (1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0)
    p2 = (0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1)
    for r in range(n):
        row = mat[r]
        for c in range(n - 10):
            seg = tuple(row[c : c + 11])
            if seg == p1 or seg == p2:
                score += 40
    for c in range(n):
        col = [mat[r][c] for r in range(n)]
        for r in range(n - 10):
            seg = tuple(col[r : r + 11])
            if seg == p1 or seg == p2:
                score += 40
    # Rule 4: dark module ratio deviation from 50%
    dark = sum(sum(row) for row in mat)
    total = n * n
    k = abs(dark * 20 - total * 10) // total
    score += k * 10
    return score


def _write_format_bits(mat: list[list[int]], ec_level: str, mask_id: int) -> None:
    n = len(mat)
    bits = _qr_format_bits(ec_level, mask_id)
    # Copy 1 around top-left finder: bit 14 -> bit 0
    c1_coords = [
        (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
        (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8),
    ]
    for idx, (r, c) in enumerate(c1_coords):
        mat[r][c] = (bits >> (14 - idx)) & 1
    # Copy 2: bottom-left vertical (bits 14..8) + top-right horizontal (bits 7..0)
    for idx in range(7):
        mat[n - 1 - idx][8] = (bits >> (14 - idx)) & 1
    for idx in range(8):
        mat[8][n - 8 + idx] = (bits >> (7 - idx)) & 1


def encode_qr_matrix(text: str) -> list[list[int]]:
    """Encode UTF-8 string into an ISO/IEC 18004 QR boolean matrix (0=light, 1=dark)."""
    payload = text.encode("utf-8")
    chosen_v = 0
    chosen_ec = "M"
    for ec_level in ("M", "L"):
        for v in range(1, 11):
            _, g1, d1, g2, d2 = _QR_RS_SPEC[ec_level][v]
            total_data_cw = g1 * d1 + g2 * d2
            cc_bits = 8 if v <= 9 else 16
            max_bytes = (total_data_cw * 8 - 4 - cc_bits) // 8
            if len(payload) <= max_bytes:
                chosen_v = v
                chosen_ec = ec_level
                break
        if chosen_v:
            break
    if not chosen_v:
        raise ValueError(f"QR payload too long ({len(payload)} bytes, max 271)")

    ecc_len, g1, d1, g2, d2 = _QR_RS_SPEC[chosen_ec][chosen_v]
    total_data_cw = g1 * d1 + g2 * d2
    cc_bits = 8 if chosen_v <= 9 else 16

    bits: list[int] = []

    def _append_bits(val: int, width: int) -> None:
        for shift in range(width - 1, -1, -1):
            bits.append((val >> shift) & 1)

    _append_bits(0b0100, 4)  # Byte mode indicator
    _append_bits(len(payload), cc_bits)
    for b in payload:
        _append_bits(b, 8)
    term_len = min(4, total_data_cw * 8 - len(bits))
    _append_bits(0, term_len)
    if len(bits) % 8:
        _append_bits(0, 8 - (len(bits) % 8))

    data_cw: list[int] = []
    for i in range(0, len(bits), 8):
        byte_val = 0
        for b in bits[i : i + 8]:
            byte_val = (byte_val << 1) | b
        data_cw.append(byte_val)
    pad_bytes = (0xEC, 0x11)
    pad_idx = 0
    while len(data_cw) < total_data_cw:
        data_cw.append(pad_bytes[pad_idx & 1])
        pad_idx += 1

    # Split into RS blocks & compute ECC
    data_blocks: list[list[int]] = []
    ecc_blocks: list[list[int]] = []
    offset = 0
    for count, dlen in ((g1, d1), (g2, d2)):
        for _ in range(count):
            blk = data_cw[offset : offset + dlen]
            offset += dlen
            data_blocks.append(blk)
            ecc_blocks.append(_rs_remainder(blk, ecc_len))

    # Interleave data & ECC codewords
    interleaved: list[int] = []
    max_d = max(len(b) for b in data_blocks)
    for i in range(max_d):
        for blk in data_blocks:
            if i < len(blk):
                interleaved.append(blk[i])
    for i in range(ecc_len):
        for eblk in ecc_blocks:
            interleaved.append(eblk[i])

    # Assemble base matrix with function patterns
    n = 17 + 4 * chosen_v
    base = [[0] * n for _ in range(n)]
    is_func = [[False] * n for _ in range(n)]

    def _set_func(r: int, c: int, val: int) -> None:
        base[r][c] = 1 if val else 0
        is_func[r][c] = True

    # 3 finder patterns + 1-module white separators
    for fr, fc in ((0, 0), (0, n - 7), (n - 7, 0)):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                rr, cc = fr + dr, fc + dc
                if 0 <= rr < n and 0 <= cc < n:
                    if 0 <= dr <= 6 and 0 <= dc <= 6:
                        dark = (dr in (0, 6)) or (dc in (0, 6)) or (2 <= dr <= 4 and 2 <= dc <= 4)
                        _set_func(rr, cc, 1 if dark else 0)
                    else:
                        _set_func(rr, cc, 0)

    # Timing patterns
    for i in range(8, n - 8):
        _set_func(6, i, 1 if i % 2 == 0 else 0)
        _set_func(i, 6, 1 if i % 2 == 0 else 0)

    # Alignment patterns
    coords = _QR_ALIGN_POS[chosen_v]
    for r0 in coords:
        for c0 in coords:
            if (r0 < 9 and c0 < 9) or (r0 < 9 and c0 > n - 10) or (r0 > n - 10 and c0 < 9):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    _set_func(r0 + dr, c0 + dc, 1 if max(abs(dr), abs(dc)) != 1 else 0)

    # Reserve format info modules & fixed dark module
    _set_func(n - 8, 8, 1)
    for i in range(9):
        if i != 6:
            _set_func(8, i, 0)
            _set_func(i, 8, 0)
    for i in range(n - 7, n):
        _set_func(i, 8, 0)
    for i in range(n - 8, n):
        _set_func(8, i, 0)

    # Version information blocks (V7+)
    if chosen_v >= 7:
        vbits = _qr_version_bits(chosen_v)
        for k in range(18):
            bit = (vbits >> k) & 1
            a = k // 3
            b = n - 11 + (k % 3)
            _set_func(a, b, bit)
            _set_func(b, a, bit)

    # Zigzag place data bits
    data_bits: list[int] = []
    for cw in interleaved:
        for shift in range(7, -1, -1):
            data_bits.append((cw >> shift) & 1)
    bit_pos = 0
    upward = True
    col = n - 1
    while col > 0:
        if col == 6:
            col -= 1
        row_iter = range(n - 1, -1, -1) if upward else range(n)
        for row in row_iter:
            for dc in (0, -1):
                cc = col + dc
                if not is_func[row][cc]:
                    base[row][cc] = data_bits[bit_pos] if bit_pos < len(data_bits) else 0
                    bit_pos += 1
        upward = not upward
        col -= 2

    # Evaluate all 8 masks & pick lowest penalty
    best_mat: list[list[int]] = base
    best_score = 10**9
    for mask_id in range(8):
        cand = [row[:] for row in base]
        for r in range(n):
            for c in range(n):
                if not is_func[r][c] and _qr_mask_cond(mask_id, r, c):
                    cand[r][c] ^= 1
        _write_format_bits(cand, chosen_ec, mask_id)
        sc = _qr_penalty(cand)
        if sc < best_score:
            best_score = sc
            best_mat = cand
    return best_mat


def render_qr_svg(text: str, dark_color: str = "#1F1F1F", light_color: str = "#FFFFFF", border: int = 4) -> str:
    """Render scannable QR SVG using `qrcode` if installed, else zero-dependency pure-Python ISO 18004 encoder."""
    matrix: list[list[int]] | None = None
    try:
        import qrcode  # type: ignore

        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=1,
            border=0,
        )
        qr.add_data(text)
        qr.make(fit=True)
        matrix = [[1 if cell else 0 for cell in row] for row in qr.get_matrix()]
    except Exception:
        matrix = encode_qr_matrix(text)

    n = len(matrix)
    dim = n + 2 * border
    parts: list[str] = []
    for r, row in enumerate(matrix):
        y = r + border
        c = 0
        while c < n:
            if row[c]:
                start = c
                while c < n and row[c]:
                    c += 1
                w = c - start
                parts.append(f"M{start + border} {y}h{w}v1h-{w}z")
            else:
                c += 1
    path_d = "".join(parts)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" '
        f'width="240" height="240" shape-rendering="crispEdges" role="img" '
        f'aria-label="Antigravity Pairing QR Code">'
        f'<rect width="{dim}" height="{dim}" fill="{light_color}"/>'
        f'<path d="{path_d}" fill="{dark_color}"/>'
        f"</svg>"
    )


# ---------------------------------------------------------------------------
# Config, Pairing PIN & Rate Limiter
# ---------------------------------------------------------------------------

def _load_config_unlocked() -> dict[str, Any]:
    cfg: dict[str, Any] = {}
    if CONFIG_FILE.is_file():
        try:
            raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8", errors="replace"))
            if isinstance(raw, dict):
                cfg = raw
        except Exception:
            cfg = {}
    changed = False
    if not str(cfg.get("token") or "").strip():
        cfg["token"] = "agymob_" + secrets.token_hex(24)
        changed = True
    if not cfg.get("default_model"):
        cfg["default_model"] = "gemini-4-neon-medium"
        changed = True
    if not isinstance(cfg.get("desktop_to_cli_alias"), dict):
        cfg["desktop_to_cli_alias"] = {}
        changed = True
    if not isinstance(cfg.get("desktop_bridge_watermark"), dict):
        cfg["desktop_bridge_watermark"] = {}
        changed = True
    if not isinstance(cfg.get("mobile_own_cids"), list):
        cfg["mobile_own_cids"] = []
        changed = True
    if not isinstance(cfg.get("conv_reverts"), dict):
        cfg["conv_reverts"] = {}
        changed = True
    if str(cfg.get("permission_mode") or "").strip().lower() not in _VALID_PERMISSION_MODES:
        cfg["permission_mode"] = "auto"
        changed = True
    if changed:
        _save_config_unlocked(cfg)
    return cfg


def get_permission_mode() -> str:
    cfg = load_or_create_config()
    mode = str(cfg.get("permission_mode") or "").strip().lower()
    return mode if mode in _VALID_PERMISSION_MODES else "auto"


def _ensure_mobile_ask_profile() -> str:
    """Create isolated strict CLI profile directory (settings.json only; shares brain/conversations)."""
    prof_dir = CLI_BRAIN.parent / _MOBILE_ASK_PROFILE_NAME
    prof_dir.mkdir(parents=True, exist_ok=True)
    settings_path = prof_dir / "settings.json"
    desired = json.dumps({"toolPermission": "strict", "agentMode": ""}, indent=2) + "\n"
    try:
        cur = settings_path.read_text(encoding="utf-8", errors="replace") if settings_path.is_file() else ""
        if cur != desired:
            settings_path.write_text(desired, encoding="utf-8")
    except Exception:
        pass
    return _MOBILE_ASK_PROFILE_NAME


def _save_config_unlocked(cfg: dict[str, Any]) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.name != "nt":
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
    os.replace(tmp, CONFIG_FILE)


def load_or_create_config() -> dict[str, Any]:
    with _CONFIG_LOCK:
        return _load_config_unlocked()


def _update_config(mutator) -> dict[str, Any]:
    with _CONFIG_LOCK:
        cfg = _load_config_unlocked()
        mutator(cfg)
        _save_config_unlocked(cfg)
        return cfg


def init_or_rotate_pair_pin() -> str:
    """Generate a fresh 6-digit numeric pairing PIN with a 10-minute TTL and sync to mobile_config.json."""
    global _RUNTIME_PAIR_PIN, _RUNTIME_PAIR_PIN_CREATED_AT, _PAIR_PIN_FAIL_COUNT
    new_pin = f"{secrets.randbelow(1000000):06d}"
    with _PAIR_PIN_LOCK:
        _RUNTIME_PAIR_PIN = new_pin
        _RUNTIME_PAIR_PIN_CREATED_AT = time.monotonic()
        _PAIR_PIN_FAIL_COUNT = 0
    _update_config(lambda cfg: cfg.__setitem__("pair_pin", new_pin))
    return new_pin


def get_pair_pin() -> str:
    with _PAIR_PIN_LOCK:
        if _RUNTIME_PAIR_PIN and (time.monotonic() - _RUNTIME_PAIR_PIN_CREATED_AT) < _PAIR_PIN_TTL_SEC:
            return _RUNTIME_PAIR_PIN
    return init_or_rotate_pair_pin()


def _record_pair_pin_failure() -> bool:
    """Increment global bad-PIN counter and auto-rotate PIN once limit is reached."""
    global _PAIR_PIN_FAIL_COUNT
    should_rotate = False
    with _PAIR_PIN_LOCK:
        _PAIR_PIN_FAIL_COUNT += 1
        if _PAIR_PIN_FAIL_COUNT >= _PAIR_PIN_MAX_GLOBAL_FAILS:
            _PAIR_PIN_FAIL_COUNT = 0
            should_rotate = True
    if should_rotate:
        init_or_rotate_pair_pin()
    return should_rotate


def _check_claim_rate_limit(client_ip: str) -> tuple[bool, int]:
    now = time.monotonic()
    key = client_ip or "unknown"
    with _CLAIM_RATE_LOCK:
        if key in _CLAIM_ATTEMPTS:
            _CLAIM_ATTEMPTS.move_to_end(key)
            dq = _CLAIM_ATTEMPTS[key]
        else:
            while len(_CLAIM_ATTEMPTS) >= _CLAIM_MAX_KEYS:
                _CLAIM_ATTEMPTS.popitem(last=False)
            dq = collections.deque()
            _CLAIM_ATTEMPTS[key] = dq
        cutoff = now - 60.0
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= _CLAIM_LIMIT_PER_MIN:
            retry_after = max(1, int(60.0 - (now - dq[0])))
            return False, retry_after
        dq.append(now)
        return True, 0


def set_desktop_cli_alias(desktop_cid: str, cli_cid: str) -> None:
    if not desktop_cid or not cli_cid or desktop_cid == cli_cid:
        return
    _update_config(lambda cfg: cfg.setdefault("desktop_to_cli_alias", {}).__setitem__(desktop_cid, cli_cid))


def get_desktop_cli_alias(desktop_cid: str) -> str:
    cfg = load_or_create_config()
    return str((cfg.get("desktop_to_cli_alias") or {}).get(desktop_cid) or "").strip()


def get_desktop_parent_for_cli(cli_cid: str) -> str:
    if not cli_cid:
        return ""
    cfg = load_or_create_config()
    aliases = cfg.get("desktop_to_cli_alias") or {}
    for desk_id, mapped_cli in aliases.items():
        if str(mapped_cli or "").strip() == cli_cid:
            return str(desk_id).strip()
    return ""


def get_desktop_bridge_watermark(cli_cid: str) -> str:
    if not cli_cid:
        return ""
    cfg = load_or_create_config()
    return str((cfg.get("desktop_bridge_watermark") or {}).get(cli_cid) or "").strip()


def set_desktop_bridge_watermark(cli_cid: str, iso_time: str) -> None:
    if not cli_cid or not iso_time:
        return
    iso_clean = str(iso_time).strip()
    if not iso_clean:
        return

    def _mut(cfg: dict[str, Any]) -> None:
        wm = cfg.setdefault("desktop_bridge_watermark", {})
        if not isinstance(wm, dict):
            wm = {}
            cfg["desktop_bridge_watermark"] = wm
        wm[cli_cid] = iso_clean
        if len(wm) > 500:
            for k in list(wm.keys())[:-500]:
                wm.pop(k, None)

    _update_config(_mut)


def _msg_text_sha16(text: str) -> str:
    return hashlib.sha1(str(text or "").encode("utf-8", errors="replace")).hexdigest()[:16]


def _msg_sig(msg: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(msg.get("role") or ""),
        str(msg.get("time") or ""),
        _msg_text_sha16(str(msg.get("text") or "")),
    )


def get_conv_revert_cutoff(cid: str) -> dict[str, Any]:
    if not cid:
        return {}
    canon, _ = _resolve_queue_canonical_cid(cid)
    cfg = load_or_create_config()
    revs = cfg.get("conv_reverts")
    if not isinstance(revs, dict):
        return {}
    entry = revs.get(canon or cid) or revs.get(cid)
    return dict(entry) if isinstance(entry, dict) else {}


def _filter_reverted_messages(msgs: list[dict[str, Any]], rev_info: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not msgs or not isinstance(rev_info, dict):
        return msgs
    raw_sigs = rev_info.get("desktop_reverted_sigs") or []
    sig_counts: dict[tuple[str, str, str], int] = {}
    for item in raw_sigs:
        if isinstance(item, (list, tuple)) and len(item) >= 3:
            key = (str(item[0] or ""), str(item[1] or ""), str(item[2] or ""))
            sig_counts[key] = sig_counts.get(key, 0) + 1
    if not sig_counts:
        return msgs
    filtered: list[dict[str, Any]] = []
    for m in msgs:
        if str(m.get("_src") or "desktop") == "desktop":
            sig = _msg_sig(m)
            cnt = sig_counts.get(sig, 0)
            if cnt > 0:
                sig_counts[sig] = cnt - 1
                continue
        filtered.append(m)
    return filtered


def _truncate_cli_transcript_from(
    cli_cid: str,
    cut_user_msg: dict[str, Any] | None,
    cut_after_iso: str = "",
    truncate_all: bool = False,
) -> tuple[bool, int]:
    """Safely back up and truncate a CLI conversation's transcript JSONL files from a target turn."""
    if not _is_valid_cid(cli_cid):
        return False, 0
    cli_t = CLI_BRAIN / cli_cid / ".system_generated" / "logs" / "transcript.jsonl"
    if not cli_t.is_file():
        return False, 0
    try:
        raw_lines = [ln for ln in cli_t.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
    except Exception:
        return False, 0
    if not raw_lines:
        return False, 0

    cut_line_idx: int | None = 0 if truncate_all else None
    if cut_line_idx is None:
        parsed: list[dict[str, Any]] = []
        needed_full: set[int] = set()
        for ln in raw_lines:
            try:
                o = json.loads(ln)
            except Exception:
                o = {}
            parsed.append(o if isinstance(o, dict) else {})
            if isinstance(o, dict) and o.get("type") == "USER_INPUT" and "content" in (o.get("truncated_fields") or []):
                si = o.get("step_index")
                if isinstance(si, int):
                    needed_full.add(si)
        full_map = _load_full_steps(cli_t, needed_full) if needed_full else {}
        target_time = str((cut_user_msg or {}).get("time") or "").strip()
        target_sha = _msg_text_sha16(str((cut_user_msg or {}).get("text") or ""))

        def _norm_user_step_text(step: dict[str, Any]) -> str:
            si = step.get("step_index")
            src_step = full_map.get(si, step) if isinstance(si, int) else step
            raw_u = str(src_step.get("content") or "")
            atts = _extract_user_attachments(raw_u, src_step.get("media"))
            return _clean_user_text(raw_u, strip_att_note=bool(atts))

        for i in range(len(parsed) - 1, -1, -1):
            st = parsed[i]
            if st.get("type") == "USER_INPUT" and st.get("source") == "USER_EXPLICIT":
                st_time = str(st.get("created_at") or "").strip()
                if target_time and st_time == target_time and _msg_text_sha16(_norm_user_step_text(st)) == target_sha:
                    cut_line_idx = i
                    break
        if cut_line_idx is None and cut_user_msg is not None:
            for i in range(len(parsed) - 1, -1, -1):
                st = parsed[i]
                if st.get("type") == "USER_INPUT" and st.get("source") == "USER_EXPLICIT":
                    if _msg_text_sha16(_norm_user_step_text(st)) == target_sha:
                        cut_line_idx = i
                        break
        if cut_line_idx is None and cut_after_iso:
            cut_ts = _parse_iso_ts(cut_after_iso)
            if cut_ts > 0.0:
                for i, st in enumerate(parsed):
                    st_ts = _parse_iso_ts(str(st.get("created_at") or "").strip())
                    if st_ts >= cut_ts:
                        cut_line_idx = i
                        break
        if cut_line_idx is None:
            return False, 0

    keep_lines = raw_lines[:cut_line_idx]
    removed_count = len(raw_lines) - len(keep_lines)
    if removed_count <= 0:
        return False, 0

    ts_tag = int(time.time())
    try:
        bak = cli_t.with_name(f"transcript.jsonl.bak.{ts_tag}")
        bak.write_bytes(cli_t.read_bytes())
        tmp = cli_t.with_name(f".transcript.jsonl.tmp.{ts_tag}")
        tmp.write_text(("\n".join(keep_lines) + "\n") if keep_lines else "", encoding="utf-8")
        os.replace(tmp, cli_t)
    except Exception:
        return False, 0

    cli_full = cli_t.with_name("transcript_full.jsonl")
    if cli_full.is_file():
        try:
            full_raw = [ln for ln in cli_full.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
            cut_step_indices: set[int] = set()
            for ln in raw_lines[cut_line_idx:]:
                try:
                    o = json.loads(ln)
                    if isinstance(o, dict) and isinstance(o.get("step_index"), int):
                        cut_step_indices.add(int(o["step_index"]))
                except Exception:
                    continue
            if truncate_all:
                keep_full: list[str] = []
            else:
                keep_full = []
                for ln in full_raw:
                    try:
                        o = json.loads(ln)
                        si = o.get("step_index") if isinstance(o, dict) else None
                        if isinstance(si, int) and si in cut_step_indices:
                            continue
                    except Exception:
                        pass
                    keep_full.append(ln)
            cli_full.with_name(f"transcript_full.jsonl.bak.{ts_tag}").write_bytes(cli_full.read_bytes())
            tmp_full = cli_full.with_name(f".transcript_full.jsonl.tmp.{ts_tag}")
            tmp_full.write_text(("\n".join(keep_full) + "\n") if keep_full else "", encoding="utf-8")
            os.replace(tmp_full, cli_full)
        except Exception:
            pass

    return True, removed_count


def _revert_conversation_sync(
    cid: str,
    msg_index: int | None = None,
    msg_time: str = "",
    text_sha16: str = "",
    user_index: int | None = None,
) -> dict[str, Any]:
    if not _is_valid_cid(cid):
        return {"ok": False, "error": "invalid cid", "status": 400}
    if _find_active_run(cid) is not None:
        return {"ok": False, "error": "对话正在运行中，请先停止后再撤回", "status": 409}

    canon, aliased_cli = _resolve_queue_canonical_cid(cid)
    canon = canon or cid
    detail = load_conversation_detail(cid, _keep_internal_src=True)
    msgs = detail.get("messages") or []
    if not msgs:
        return {"ok": False, "error": "会话没有可撤回的消息", "status": 404}

    target_idx: int | None = None
    if isinstance(msg_index, int) and 0 <= msg_index < len(msgs) and msgs[msg_index].get("role") == "user":
        cand = msgs[msg_index]
        cand_sha = _msg_text_sha16(str(cand.get("text") or ""))
        if (not text_sha16 or cand_sha == text_sha16) and (not msg_time or str(cand.get("time") or "") == msg_time):
            target_idx = msg_index

    if target_idx is None and text_sha16:
        user_matches = [
            i for i, m in enumerate(msgs)
            if m.get("role") == "user" and _msg_text_sha16(str(m.get("text") or "")) == text_sha16
        ]
        if msg_time:
            exact = [i for i in user_matches if str(msgs[i].get("time") or "") == msg_time]
            if exact:
                user_matches = exact
        if user_matches:
            if isinstance(msg_index, int):
                target_idx = min(user_matches, key=lambda idx: abs(idx - msg_index))
            else:
                target_idx = user_matches[-1]

    if target_idx is None and isinstance(user_index, int) and user_index >= 0:
        user_positions = [i for i, m in enumerate(msgs) if m.get("role") == "user"]
        if user_index < len(user_positions):
            target_idx = user_positions[user_index]

    if target_idx is None:
        return {"ok": False, "error": "未找到目标用户消息，可能已被撤回或刷新", "status": 404}

    target_msg = msgs[target_idx]
    restored_prompt = str(target_msg.get("text") or "")
    tail_msgs = msgs[target_idx:]
    reverted_count = len(tail_msgs)
    desk_sigs = [list(_msg_sig(m)) for m in tail_msgs if str(m.get("_src") or "desktop") == "desktop"]
    cli_tail = [m for m in tail_msgs if str(m.get("_src") or "") == "cli"]
    prior_cli = [m for m in msgs[:target_idx] if str(m.get("_src") or "") == "cli"]
    prior_desk = [m for m in msgs[:target_idx] if str(m.get("_src") or "") == "desktop"]

    cli_cid_to_cut = ""
    if str(detail.get("source") or "") == "mobile":
        cli_cid_to_cut = cid
    elif aliased_cli:
        cli_cid_to_cut = aliased_cli

    cli_truncated = False
    drop_alias = False
    if cli_cid_to_cut and (cli_tail or str(target_msg.get("_src") or "") == "cli"):
        cut_all = len(prior_cli) == 0
        cut_user = next((m for m in cli_tail if m.get("role") == "user"), None)
        cli_truncated, _ = _truncate_cli_transcript_from(
            cli_cid_to_cut,
            cut_user_msg=cut_user,
            cut_after_iso=str(target_msg.get("time") or ""),
            truncate_all=cut_all,
        )
        if cut_all and aliased_cli:
            drop_alias = True

    def _mut(cfg: dict[str, Any]) -> None:
        if desk_sigs:
            revs = cfg.setdefault("conv_reverts", {})
            if not isinstance(revs, dict):
                revs = {}
                cfg["conv_reverts"] = revs
            cur = revs.get(canon)
            if not isinstance(cur, dict):
                cur = {}
            sigs = list(cur.get("desktop_reverted_sigs") or [])
            sigs.extend(desk_sigs)
            if len(sigs) > 1000:
                sigs = sigs[-1000:]
            revs[canon] = {
                "desktop_reverted_sigs": sigs,
                "reverted_at_ts": time.time(),
                "cutoff_turn": target_idx,
            }
            if len(revs) > 500:
                for k in list(revs.keys())[:-500]:
                    revs.pop(k, None)
        if drop_alias:
            aliases = cfg.get("desktop_to_cli_alias")
            if isinstance(aliases, dict):
                aliases.pop(canon, None)
            wm = cfg.get("desktop_bridge_watermark")
            if isinstance(wm, dict):
                wm.pop(cli_cid_to_cut, None)
        elif cli_cid_to_cut and cli_truncated and aliased_cli:
            wm = cfg.get("desktop_bridge_watermark")
            if isinstance(wm, dict):
                last_d_ts = ""
                for dm in reversed(prior_desk):
                    if dm.get("time"):
                        last_d_ts = str(dm["time"])
                        break
                if last_d_ts:
                    wm[cli_cid_to_cut] = last_d_ts
                else:
                    wm.pop(cli_cid_to_cut, None)

    _update_config(_mut)

    # Clear pending revert-invalidated failure state cleanly and refresh snapshot
    after_detail = load_conversation_detail(canon if drop_alias else cid)
    return {
        "ok": True,
        "conversation_id": cid,
        "canonical_cid": canon,
        "reverted_count": reverted_count,
        "restored_prompt": restored_prompt,
        "cli_truncated": cli_truncated,
        "desktop_masked": len(desk_sigs),
        "conversation": after_detail,
    }


_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _sanitize_error_text(raw: str) -> str:
    txt = _ANSI_ESCAPE_RE.sub("", str(raw or ""))
    txt = re.sub(r"[A-Za-z]:\\(?:[^\s\"'<>]+)", "<path>", txt)
    txt = re.sub(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9-.]+", "<email>", txt)
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt[:400]


def _classify_run_error(err_text: str) -> str:
    low = str(err_text or "").lower()
    if not low:
        return "unknown"
    if any(k in low for k in ("quota", "exhausted", "resource_exhausted", "insufficient", "limit exceeded", "额度", "配额", "积分")):
        return "quota"
    if any(k in low for k in ("rate limit", "too many requests", "429", "rpm", "tpm", "频率限制")):
        return "rate_limit"
    if any(k in low for k in ("unauthorized", "unauthenticated", "401", "403", "permission denied", "token expired", "api key", "登录", "认证", "鉴权")):
        return "auth"
    if any(k in low for k in ("timeout", "timed out", "deadline exceeded", "超时")):
        return "timeout"
    if any(k in low for k in ("econnrefused", "connection refused", "connection reset", "fetch failed", "socket", "dns", "ssl", "tls", "unreachable", "network", "broken pipe", "offline", "网络", "连接")):
        return "network"
    if any(k in low for k in ("model not found", "unsupported model", "invalid model", "model", "模型")):
        return "model"
    if any(k in low for k in ("cancelled", "aborted", "interrupted", "sigterm", "已取消", "停止")):
        return "cancelled"
    return "unknown"


def register_mobile_own_cid(cid: str) -> None:
    if not cid or cid.startswith("pending-"):
        return
    def _mut(cfg: dict[str, Any]) -> None:
        arr = cfg.setdefault("mobile_own_cids", [])
        if not isinstance(arr, list):
            arr = []
            cfg["mobile_own_cids"] = arr
        if cid not in arr:
            arr.append(cid)
            if len(arr) > 200:
                del arr[:-200]
    _update_config(_mut)


def get_mobile_own_cids() -> set[str]:
    cfg = load_or_create_config()
    arr = cfg.get("mobile_own_cids") or []
    return {str(x).strip() for x in arr if str(x).strip()}


# ---------------------------------------------------------------------------
# Environment, Network & Capability Detection
# ---------------------------------------------------------------------------

def _is_valid_cid(cid: str) -> bool:
    return bool(cid and _CID_RE.match(cid))


def _is_valid_model_id(model: str) -> bool:
    return bool(model and (model in _KNOWN_MODEL_IDS or _MODEL_ID_RE.match(model)))


def _has_unsafe_raw_path(raw: str, *, allow_absolute: bool = False) -> bool:
    """Reject UNC paths, drive tricks, traversal segments, and control chars BEFORE calling .resolve()."""
    if not raw or "\x00" in raw or any(ord(ch) < 32 for ch in raw):
        return True
    s = raw.strip()
    if not s:
        return True
    # Reject UNC / Windows device paths immediately (prevents outbound SMB on Windows .resolve())
    if s.startswith(("\\\\", "//", "\\/", "/\\")):
        return True
    segs = re.split(r"[/\\]+", s)
    if any(seg == ".." for seg in segs):
        return True
    if not allow_absolute:
        if s.startswith(("/", "\\")) or "\\" in s or ":" in s:
            return True
    else:
        # Reject NTFS ADS or stray colons (only allow drive letter at index 1 on Windows, e.g. C:/...)
        if ":" in s:
            if not (len(s) >= 3 and s[0].isalpha() and s[1] == ":" and s[2] in ("/", "\\") and ":" not in s[2:]):
                return True
        if s.startswith("\\"):
            return True
    return False


def _get_allowed_file_roots() -> tuple[pathlib.Path, ...]:
    roots: list[pathlib.Path] = []
    for r in (WORKSPACE_ROOT, UPLOAD_DIR, DESKTOP_BRAIN, CLI_BRAIN):
        try:
            roots.append(r.resolve())
        except Exception:
            roots.append(r)
    return tuple(roots)


def _is_within_allowed_roots(rp: pathlib.Path, roots: tuple[pathlib.Path, ...] | None = None) -> bool:
    check_roots = roots if roots is not None else _get_allowed_file_roots()
    for root in check_roots:
        try:
            if rp.is_relative_to(root):
                return True
        except Exception:
            continue
    return False


def _is_sensitive_path(p: pathlib.Path) -> bool:
    try:
        rp = p.resolve()
    except Exception:
        rp = p
    name_low = rp.name.rstrip(" .").lower()
    if (
        name_low in _SENSITIVE_NAMES
        or name_low == ".env"
        or name_low.startswith(".env.")
        or name_low.endswith(_SENSITIVE_SUFFIXES)
    ):
        return True
    posix_low = "/" + rp.as_posix().lstrip("/").lower() + "/"
    return any(seg in posix_low for seg in _SENSITIVE_SEGS)


def _is_valid_agy_bin(p: pathlib.Path) -> bool:
    try:
        if not p.is_file():
            return False
        if os.name == "nt":
            # Strictly accept .exe on Windows; reject .cmd/.bat/extensionless shims
            return p.suffix.lower() == ".exe"
        return os.access(p, os.X_OK)
    except OSError:
        return False


def _find_agy_bin() -> str:
    env_bin = str(os.environ.get("AGY_CLI_BIN") or "").strip()
    if env_bin:
        ep = pathlib.Path(env_bin).expanduser()
        if _is_valid_agy_bin(ep):
            return str(ep)

    candidates: list[pathlib.Path] = []
    if os.name == "nt":
        candidates.extend([
            PROJECT_DIR / "bin" / "agy.exe",
            WORKSPACE_ROOT / "bin" / "agy.exe",
            HOME_DIR / ".agy" / "bin" / "agy.exe",
            HOME_DIR / ".antigravity" / "bin" / "agy.exe",
            HOME_DIR / ".local" / "bin" / "agy.exe",
        ])
        local_app = str(os.environ.get("LOCALAPPDATA") or "").strip()
        if local_app:
            la = pathlib.Path(local_app)
            candidates.extend([
                la / "agy" / "bin" / "agy.exe",
                la / "Programs" / "antigravity" / "bin" / "agy.exe",
            ])
    else:
        candidates.extend([
            PROJECT_DIR / "bin" / "agy",
            WORKSPACE_ROOT / "bin" / "agy",
            HOME_DIR / ".local" / "bin" / "agy",
            HOME_DIR / ".agy" / "bin" / "agy",
            HOME_DIR / ".antigravity" / "bin" / "agy",
            pathlib.Path("/opt/homebrew/bin/agy"),
            pathlib.Path("/usr/local/bin/agy"),
        ])

    for cand in candidates:
        if _is_valid_agy_bin(cand):
            return str(cand)

    if os.name == "nt":
        for name in ("agy.exe", "agy"):
            found = shutil.which(name)
            if found and _is_valid_agy_bin(pathlib.Path(found)):
                return str(found)
        return ""

    found = shutil.which("agy")
    if found and _is_valid_agy_bin(pathlib.Path(found)):
        return str(found)
    return ""


def _build_cli_env() -> dict[str, str]:
    env = dict(os.environ)
    has_proxy = any(env.get(k) for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"))
    if not has_proxy:
        for port in (7890, 7897, 10809):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.05):
                    px = f"http://127.0.0.1:{port}"
                    env["HTTP_PROXY"] = px
                    env["HTTPS_PROXY"] = px
                    env["ALL_PROXY"] = px
                    env["http_proxy"] = px
                    env["https_proxy"] = px
                    env["all_proxy"] = px
                    break
            except OSError:
                continue
    env["NO_PROXY"] = "127.0.0.1,localhost,::1"
    return env


_LOCAL_BRIDGE_CACHE_LOCK = threading.Lock()
_LOCAL_BRIDGE_CACHE: dict[str, Any] = {"ts": 0.0, "data": None, "last_good_ts": 0.0, "last_good": None}


def _fetch_local_bridge_status(force: bool = False, timeout_sec: float = 0.8, allow_stale: bool = True) -> dict[str, Any] | None:
    """Optional loopback query to a local bridge status API (127.0.0.1:8788/api/status), cached for 15s with stale-while-slow fallback."""
    now = time.time()
    if not force:
        with _LOCAL_BRIDGE_CACHE_LOCK:
            cached = _LOCAL_BRIDGE_CACHE.get("data")
            age = now - float(_LOCAL_BRIDGE_CACHE.get("ts") or 0.0)
            if isinstance(cached, dict) and age < 15.0:
                return dict(cached)
            # Short negative cache (3s) only when port refused, NOT when caller asks for a longer quota timeout
            if cached is None and age < 3.0 and timeout_sec <= 1.0:
                if allow_stale:
                    lg = _LOCAL_BRIDGE_CACHE.get("last_good")
                    if isinstance(lg, dict) and (now - float(_LOCAL_BRIDGE_CACHE.get("last_good_ts") or 0.0)) < 600.0:
                        return dict(lg)
                return None
    result: dict[str, Any] | None = None
    try:
        with _DIRECT_OPENER.open("http://127.0.0.1:8788/api/status", timeout=timeout_sec) as r:
            if getattr(r, "status", 200) == 200:
                data = json.loads(r.read(524288).decode("utf-8", errors="replace"))
                if isinstance(data, dict) and any(
                    k in data for k in ("bridge_online", "gateway_online", "active_model", "quotas", "ai_usage", "dm_cascade_ids")
                ):
                    result = data
    except Exception:
        result = None
    with _LOCAL_BRIDGE_CACHE_LOCK:
        _LOCAL_BRIDGE_CACHE["ts"] = now
        _LOCAL_BRIDGE_CACHE["data"] = result
        if isinstance(result, dict):
            _LOCAL_BRIDGE_CACHE["last_good"] = result
            _LOCAL_BRIDGE_CACHE["last_good_ts"] = now
            return dict(result)
        if allow_stale:
            lg = _LOCAL_BRIDGE_CACHE.get("last_good")
            if isinstance(lg, dict) and (now - float(_LOCAL_BRIDGE_CACHE.get("last_good_ts") or 0.0)) < 600.0:
                return dict(lg)
    return None


def check_qqbot_available() -> bool:
    """Verify actual HTTP JSON status response from local optional QQ Bot API (127.0.0.1:8788)."""
    return _fetch_local_bridge_status() is not None


def get_qq_dm_cids() -> set[str]:
    """Return private-chat (DM only, never group-chat) cascade IDs synced from optional local bridge + local config."""
    cfg = load_or_create_config()
    saved_list = [str(x).strip() for x in (cfg.get("qq_dm_conv_ids") or []) if _is_valid_cid(str(x).strip())]
    out_set = set(saved_list)
    st = _fetch_local_bridge_status()
    if isinstance(st, dict):
        live_dms = st.get("dm_cascade_ids")
        if isinstance(live_dms, list):
            changed = False
            for raw in live_dms:
                cid = str(raw or "").strip()
                if cid and _is_valid_cid(cid) and cid not in out_set:
                    out_set.add(cid)
                    saved_list.insert(0, cid)
                    changed = True
            if changed:
                def _merge_dm(cfg_fresh: dict[str, Any]) -> None:
                    cur = [str(x).strip() for x in (cfg_fresh.get("qq_dm_conv_ids") or []) if _is_valid_cid(str(x).strip())]
                    cur_set = set(cur)
                    for cid in reversed(saved_list):
                        if cid not in cur_set:
                            cur.insert(0, cid)
                            cur_set.add(cid)
                    cfg_fresh["qq_dm_conv_ids"] = cur[:200]
                _update_config(_merge_dm)
    return out_set


_VIRTUAL_NIC_KEYWORDS = (
    "vethernet", "wsl", "hyper-v", "virtualbox", "vbox", "vmware", "vmnet",
    "docker", "veth", "br-", "loopback", "virbr", "podman", "teredo", "isatap", "npcap",
)


def _classify_ipv4(ip: str, iface: str) -> tuple[int, str] | None:
    try:
        addr = ipaddress.IPv4Address(ip)
    except ValueError:
        return None
    if addr.is_loopback or addr.is_link_local or addr.is_unspecified or addr.is_multicast:
        return None
    # Exclude Clash / fake-IP TUN benchmark range 198.18.0.0/15
    if addr in ipaddress.IPv4Network("198.18.0.0/15"):
        return None

    iface_low = iface.lower()
    if any(k in iface_low for k in _VIRTUAL_NIC_KEYWORDS):
        return None

    is_tailscale = ("tailscale" in iface_low) or (addr in ipaddress.IPv4Network("100.64.0.0/10"))
    is_lan_nic = any(k in iface_low for k in ("wlan", "wi-fi", "wifi", "无线", "以太网", "ethernet", "en0", "en1", "eth0", "eth1", "wlp", "enp", "local area", "primary lan"))
    is_rfc1918 = addr.is_private

    if is_lan_nic and is_rfc1918:
        return (0, "lan")
    if is_lan_nic:
        return (1, "lan")
    if is_tailscale:
        return (2, "tailscale")
    if any(k in iface_low for k in ("vpn", "wireguard", "zerotier", "radmin", "wg", "tun", "tap")):
        return (3, "vpn")
    if is_rfc1918:
        return (4, "lan")
    return (5, "other")


def _ip_tiebreak(ip_str: str) -> tuple[int, str]:
    if ip_str.startswith("192.168."):
        return (0, ip_str)
    if ip_str.startswith("10."):
        return (1, ip_str)
    return (2, ip_str)


def _decode_cmd_bytes(raw: bytes) -> str:
    for enc in ("utf-8", "mbcs" if os.name == "nt" else "utf-8", "gbk", "cp437"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", errors="replace")


def detect_lan_addresses() -> list[dict[str, str]]:
    found: dict[str, tuple[int, dict[str, str]]] = {}

    def _add(ip: str, iface: str) -> None:
        cls = _classify_ipv4(ip, iface)
        if cls is None:
            return
        prio, kind = cls
        prev = found.get(ip)
        if prev is None or prio < prev[0]:
            found[ip] = (prio, {"iface": iface or "LAN", "ip": ip, "url": f"http://{ip}:{PORT}", "kind": kind})

    if os.name == "nt":
        try:
            ps = subprocess.run(
                [
                    "powershell", "-NoProfile", "-Command",
                    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
                    "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
                    "Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '127.*' "
                    "-and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '198.18.*' "
                    "-and $_.IPAddress -notlike '198.19.*' } | "
                    "Select-Object InterfaceAlias, IPAddress | ConvertTo-Json -Compress",
                ],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=4, creationflags=_NO_WINDOW,
            )
            raw = (ps.stdout or "").strip()
            if raw:
                items = json.loads(raw)
                if isinstance(items, dict):
                    items = [items]
                for it in items:
                    ip = str(it.get("IPAddress") or "").strip()
                    iface = str(it.get("InterfaceAlias") or "").strip()
                    if ip:
                        _add(ip, iface)
        except Exception:
            pass

        if not found:
            try:
                ipc = subprocess.run(["ipconfig"], capture_output=True, timeout=4, creationflags=_NO_WINDOW)
                txt = _decode_cmd_bytes(ipc.stdout or b"")
                cur_iface = "LAN"
                for ln in txt.splitlines():
                    if ln and not ln[0].isspace() and ":" in ln:
                        cur_iface = ln.rstrip(":\r\n ").strip()
                    else:
                        m = re.search(r"IPv4[^:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})", ln, re.IGNORECASE)
                        if m:
                            _add(m.group(1), cur_iface)
            except Exception:
                pass
    else:
        # macOS / Linux: prefer `ip -4 addr` or `ifconfig` before UDP/hostname fallback
        ip_bin = shutil.which("ip")
        if ip_bin:
            try:
                res = subprocess.run(
                    [ip_bin, "-4", "-o", "addr", "show", "scope", "global"],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3,
                )
                for ln in (res.stdout or "").splitlines():
                    m = re.match(r"^\d+:\s+([^\s:]+)\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})/", ln.strip())
                    if m:
                        _add(m.group(2), m.group(1))
            except Exception:
                pass
        if not found:
            ifc_bin = shutil.which("ifconfig")
            if ifc_bin:
                try:
                    res = subprocess.run(
                        [ifc_bin],
                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3,
                    )
                    cur_iface = "LAN"
                    for ln in (res.stdout or "").splitlines():
                        hdr = re.match(r"^([A-Za-z0-9_.:-]+):", ln)
                        if hdr:
                            cur_iface = hdr.group(1)
                            continue
                        m = re.search(r"\binet\s+(?:addr:)?(\d{1,3}(?:\.\d{1,3}){3})\b", ln)
                        if m:
                            _add(m.group(1), cur_iface)
                except Exception:
                    pass

    # Cross-platform socket fallback
    if not found:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                ip = s.getsockname()[0]
                if ip:
                    _add(ip, "Primary LAN")
        except OSError:
            pass
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = str(info[4][0])
                _add(ip, "Network")
        except OSError:
            pass

    ordered = sorted(found.values(), key=lambda x: (x[0], _ip_tiebreak(x[1]["ip"])))
    return [entry for _, entry in ordered]


def build_pair_uri(
    base_url: str,
    token: str,
    hostname: str,
    alt_urls: list[str] | None = None,
) -> str:
    params: dict[str, str] = {"u": base_url, "t": token, "n": hostname}
    if alt_urls:
        seen = {str(base_url or "").strip().rstrip("/").lower()}
        clean_alts: list[str] = []
        for raw in alt_urls:
            u = str(raw or "").strip().rstrip("/")
            if not u or not u.startswith(("http://", "https://")):
                continue
            low = u.lower()
            if low in seen:
                continue
            seen.add(low)
            clean_alts.append(u)
            if len(clean_alts) >= 2:
                break
        if clean_alts:
            params["a"] = ",".join(clean_alts)
    q = urllib.parse.urlencode(params)
    return f"agylink://pair?{q}"


# ---------------------------------------------------------------------------
# Cloudflare Tunnel (Zero-VPN Public HTTPS/WSS Access)
# ---------------------------------------------------------------------------

def _find_cloudflared_bin() -> str:
    env_bin = str(os.environ.get("AGY_CLOUDFLARED_BIN") or "").strip()
    if env_bin:
        ep = pathlib.Path(env_bin).expanduser()
        if ep.is_file():
            return str(ep)
    candidates = [
        PROJECT_DIR / "bin" / "cloudflared.exe",
        PROJECT_DIR / "bin" / "cloudflared",
        WORKSPACE_ROOT / "bin" / "cloudflared.exe",
        WORKSPACE_ROOT / "bin" / "cloudflared",
    ]
    for cand in candidates:
        try:
            if cand.is_file():
                return str(cand)
        except OSError:
            continue
    return str(shutil.which("cloudflared") or shutil.which("cloudflared.exe") or "")


def _pick_free_loopback_port() -> int:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return int(s.getsockname()[1])
    except Exception:
        return 0


def _discover_running_cloudflared() -> tuple[int, int]:
    """Find an already-running cloudflared process targeting 127.0.0.1:{PORT} -> (pid, metrics_port)."""
    try:
        entries: list[tuple[int, str]] = []
        if os.name == "nt":
            ps = subprocess.run(
                [
                    "powershell", "-NoProfile", "-Command",
                    "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'cloudflared*' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
                ],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=4, creationflags=_NO_WINDOW,
            )
            raw = (ps.stdout or "").strip()
            if raw:
                parsed = json.loads(raw)
                items = parsed if isinstance(parsed, list) else [parsed]
                for it in items:
                    if isinstance(it, dict) and it.get("ProcessId"):
                        entries.append((int(it["ProcessId"]), str(it.get("CommandLine") or "")))
        else:
            res = subprocess.run(
                ["ps", "-eo", "pid,args"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3,
            )
            for ln in (res.stdout or "").splitlines():
                m = re.match(r"^\s*(\d+)\s+(.*)$", ln)
                if m and "cloudflared" in m.group(2):
                    entries.append((int(m.group(1)), m.group(2)))
        port_tag = f"127.0.0.1:{PORT}"
        fallback: tuple[int, int] = (0, 0)
        for pid, cmdline in entries:
            m_met = re.search(r"--metrics\s+127\.0\.0\.1:(\d+)", cmdline)
            mport = int(m_met.group(1)) if m_met else 0
            if port_tag in cmdline or f"localhost:{PORT}" in cmdline:
                return pid, mport
            if fallback == (0, 0):
                fallback = (pid, mport)
        return fallback
    except Exception:
        return 0, 0


def _kill_pid(pid: int) -> None:
    if pid <= 0:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/PID", str(pid)],
                capture_output=True, timeout=4, creationflags=_NO_WINDOW,
            )
        else:
            os.kill(pid, 15)
    except Exception:
        pass


def _detect_tailscale_funnel_url() -> str:
    """Detect whether Tailscale Funnel is already configured to expose this local port permanently."""
    global _TAILSCALE_FUNNEL_CACHE
    now = time.time()
    with _TAILSCALE_FUNNEL_CACHE_LOCK:
        ts_c, url_c = _TAILSCALE_FUNNEL_CACHE
        if (now - ts_c) < 30.0:
            return url_c
    found = ""
    ts_bin = shutil.which("tailscale") or shutil.which("tailscale.exe")
    if ts_bin:
        try:
            kw = {"creationflags": _NO_WINDOW} if os.name == "nt" else {}
            res = subprocess.run(
                [ts_bin, "funnel", "status", "--json"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=2.5, **kw
            )
            raw = (res.stdout or "").strip()
            if res.returncode == 0 and raw.startswith("{"):
                data = json.loads(raw)
                allow_fn = data.get("AllowFunnel") if isinstance(data.get("AllowFunnel"), dict) else {}
                web_map = data.get("Web") if isinstance(data.get("Web"), dict) else {}
                target_pat = re.compile(rf"(?:127\.0\.0\.1|localhost):{PORT}\b")
                for host_port, cfg in web_map.items():
                    if not allow_fn.get(host_port, False):
                        continue
                    handlers = cfg.get("Handlers") if isinstance(cfg, dict) else None
                    if not isinstance(handlers, dict):
                        continue
                    for h in handlers.values():
                        if isinstance(h, dict) and target_pat.search(str(h.get("Proxy") or "")):
                            hp = str(host_port).strip()
                            if hp.endswith(":443"):
                                hp = hp[:-4]
                            if hp:
                                found = f"https://{hp}"
                                break
                    if found:
                        break
        except Exception:
            found = ""
    with _TAILSCALE_FUNNEL_CACHE_LOCK:
        _TAILSCALE_FUNNEL_CACHE = (now, found)
    return found


def _probe_cloudflared_ready(metrics_port: int) -> tuple[bool, int]:
    """Query cloudflared's documented local --metrics /ready endpoint (never via proxy)."""
    if metrics_port <= 0:
        return False, 0
    url = f"http://127.0.0.1:{metrics_port}/ready"
    try:
        req = urllib.request.Request(url, method="GET")
        with _DIRECT_OPENER.open(req, timeout=2.0) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw.strip().startswith("{") else {}
            cnt = int(data.get("readyConnections") or 0)
            return (resp.status == 200 and cnt >= 1), cnt
    except urllib.error.HTTPError as he:
        try:
            raw = he.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw.strip().startswith("{") else {}
            return False, int(data.get("readyConnections") or 0)
        except Exception:
            return False, 0
    except Exception:
        return False, 0


def _probe_tunnel_public_health(tunnel_url: str, metrics_port: int = 0) -> tuple[bool, str]:
    """End-to-end probe of <tunnel_url>/health to catch Cloudflare 530/1033 zombie routes
    where local /ready still reports readyConnections >= 1.
    Returns (True, "") if healthy or locally inconclusive; (False, reason) on definitive edge/TLS errors."""
    base = str(tunnel_url or "").strip().rstrip("/")
    if not base.startswith(("https://", "http://")):
        return True, ""
    url = f"{base}/health"
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": f"AntigravityLink/{APP_VERSION}"})
    openers = [urllib.request.build_opener(), _DIRECT_OPENER]
    last_http_err = ""
    fatal_conn_errs = 0
    for opener in openers:
        try:
            with opener.open(req, timeout=5.0) as resp:
                raw = resp.read(512).decode("utf-8", errors="replace")
                if resp.status == 200 and '"ok"' in raw:
                    return True, ""
                if resp.status in (530, 502, 503, 504):
                    last_http_err = f"HTTP {resp.status}"
                    continue
                return True, ""
        except urllib.error.HTTPError as he:
            if he.code in (530, 502, 503, 504):
                body = ""
                try:
                    body = he.read(120).decode("utf-8", errors="replace").strip()
                except Exception:
                    pass
                last_http_err = f"HTTP {he.code}" + (f" ({body[:40]})" if body else "")
                continue
            return True, ""
        except Exception as exc:
            err_s = f"{type(exc).__name__}: {exc}".lower()
            if any(k in err_s for k in ("unexpected_eof", "ssleoferror", "connectionreset", "remote end closed")):
                fatal_conn_errs += 1
            continue
    if last_http_err:
        return False, last_http_err
    if metrics_port <= 0 and fatal_conn_errs >= len(openers):
        return False, "TLS/连接中断"
    return True, ""


def get_tunnel_snapshot() -> dict[str, Any]:
    with _TUNNEL_LOCK:
        return {
            "enabled": bool(_TUNNEL_STATE.get("enabled")),
            "mode": str(_TUNNEL_STATE.get("mode") or "quick"),
            "status": str(_TUNNEL_STATE.get("status") or "disabled"),
            "url": str(_TUNNEL_STATE.get("url") or ""),
            "error": str(_TUNNEL_STATE.get("error") or ""),
            "bin": str(_TUNNEL_STATE.get("bin") or ""),
            "started_at": float(_TUNNEL_STATE.get("started_at") or 0.0),
            "ready_connections": int(_TUNNEL_STATE.get("ready_connections") or 0),
            "last_healthy_at": float(_TUNNEL_STATE.get("last_healthy_at") or 0.0),
            "auto_heals": int(_TUNNEL_STATE.get("auto_heals") or 0),
        }


def _stop_cloudflared_tunnel() -> None:
    global _TUNNEL_STOP_EVT
    proc = None
    with _TUNNEL_LOCK:
        _TUNNEL_STOP_EVT.set()
        proc = _TUNNEL_STATE.get("proc")
        _TUNNEL_STATE["proc"] = None
        if _TUNNEL_STATE.get("status") in ("starting", "online"):
            _TUNNEL_STATE["status"] = "disabled"
        _TUNNEL_STATE["url"] = ""
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=3.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


atexit.register(_stop_cloudflared_tunnel)


def start_cloudflared_tunnel(wait_sec: float = 0.0, allow_reuse: bool = True) -> dict[str, Any]:
    global _TUNNEL_THREAD, _TUNNEL_STOP_EVT, _TUNNEL_GEN
    reuse_url = str(os.environ.get("AGY_REUSE_TUNNEL_URL") or "").strip().rstrip("/") if allow_reuse else ""
    if reuse_url:
        ext_pid, ext_mport = _discover_running_cloudflared()
        ready_ok, ready_cnt = _probe_cloudflared_ready(ext_mport) if ext_mport > 0 else (False, 0)
        with _TUNNEL_LOCK:
            _TUNNEL_STATE.update({
                "enabled": True,
                "mode": "quick",
                "status": "online",
                "url": reuse_url,
                "error": "",
                "bin": _find_cloudflared_bin(),
                "started_at": time.time() - 30.0,
                "metrics_port": ext_mport,
                "external_pid": ext_pid,
                "ready_connections": ready_cnt,
                "last_healthy_at": time.time() if ready_ok else 0.0,
                "unhealthy_streak": 0,
                "proc": None,
            })
        print(f"[{APP_NAME}] Reusing Public Tunnel: {reuse_url} (pid={ext_pid}, metrics={ext_mport}, ready={ready_cnt})", flush=True)
        return get_tunnel_snapshot()

    os.environ.pop("AGY_REUSE_TUNNEL_URL", None)
    cfg = load_or_create_config()
    env_off = str(os.environ.get("AGY_DISABLE_TUNNEL") or "").strip().lower() in ("1", "true", "yes")
    enabled = (not env_off) and bool(cfg.get("tunnel_enabled", True))
    cf_bin = _find_cloudflared_bin()

    if not enabled:
        _stop_cloudflared_tunnel()
        with _TUNNEL_LOCK:
            _TUNNEL_STATE.update({"enabled": False, "mode": "disabled", "status": "disabled", "url": "", "error": "", "bin": cf_bin, "external_pid": 0})
        return get_tunnel_snapshot()

    if not cf_bin:
        _stop_cloudflared_tunnel()
        with _TUNNEL_LOCK:
            _TUNNEL_STATE.update({"enabled": True, "mode": "quick", "status": "missing", "url": "", "error": "未找到 cloudflared 可执行文件（请将其放入 bin/ 目录或系统 PATH）", "bin": "", "external_pid": 0})
        return get_tunnel_snapshot()

    named_token = str(cfg.get("cloudflare_tunnel_token") or os.environ.get("AGY_CLOUDFLARE_TUNNEL_TOKEN") or "").strip()
    named_url = str(cfg.get("cloudflare_public_url") or os.environ.get("AGY_CLOUDFLARE_PUBLIC_URL") or "").strip().rstrip("/")
    mode = "named" if named_token else "quick"

    _stop_cloudflared_tunnel()

    if mode == "named" and not named_url:
        with _TUNNEL_LOCK:
            _TUNNEL_STATE.update({
                "enabled": True,
                "mode": "named",
                "status": "error",
                "url": "",
                "error": "已配置 cloudflare_tunnel_token，但缺少 cloudflare_public_url（请在 mobile_config.json 补充固定域名）",
                "bin": cf_bin,
                "started_at": time.time(),
                "external_pid": 0,
                "proc": None,
            })
        return get_tunnel_snapshot()

    gen_stop_evt = threading.Event()
    ready_evt = threading.Event()

    with _TUNNEL_LOCK:
        _TUNNEL_GEN += 1
        my_gen = _TUNNEL_GEN
        _TUNNEL_STOP_EVT = gen_stop_evt
        _TUNNEL_STATE.update({
            "enabled": True,
            "mode": mode,
            "status": "starting",
            "url": named_url if mode == "named" else "",
            "error": "",
            "bin": cf_bin,
            "started_at": time.time(),
            "external_pid": 0,
            "proc": None,
        })

    def _runner(my_stop_evt: threading.Event, gen_id: int) -> None:
        while not my_stop_evt.is_set():
            proc_env = dict(os.environ)
            metrics_port = _pick_free_loopback_port()
            metrics_args = ["--metrics", f"127.0.0.1:{metrics_port}"] if metrics_port > 0 else []
            if mode == "named":
                # Pass secret via TUNNEL_TOKEN env var instead of --token CLI argv
                proc_env["TUNNEL_TOKEN"] = named_token
                cmd = [cf_bin, "tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", *metrics_args, "run"]
            else:
                proc_env.pop("TUNNEL_TOKEN", None)
                cmd = [cf_bin, "tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", *metrics_args, "--url", f"http://127.0.0.1:{PORT}"]
            last_lines: collections.deque[str] = collections.deque(maxlen=8)
            proc = None
            try:
                proc = subprocess.Popen(
                    cmd,
                    env=proc_env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=_NO_WINDOW,
                )
                with _TUNNEL_LOCK:
                    if my_stop_evt.is_set() or _TUNNEL_GEN != gen_id:
                        try:
                            proc.terminate()
                        except Exception:
                            pass
                        break
                    _TUNNEL_STATE["proc"] = proc
                    _TUNNEL_STATE["metrics_port"] = metrics_port
                    _TUNNEL_STATE["ready_connections"] = 0
                    _TUNNEL_STATE["unhealthy_streak"] = 0
                    _TUNNEL_STATE["started_at"] = time.time()
                    if mode != "named":
                        _TUNNEL_STATE["status"] = "starting"
                        _TUNNEL_STATE["url"] = ""
                    _TUNNEL_STATE["error"] = ""

                assert proc.stdout is not None
                for raw_ln in proc.stdout:
                    if my_stop_evt.is_set():
                        break
                    ln = raw_ln.strip()
                    if not ln:
                        continue
                    last_lines.append(ln)
                    if mode == "quick":
                        m = _CF_QUICK_URL_RE.search(ln)
                        if m:
                            found_url = m.group(0).rstrip("/")
                            with _TUNNEL_LOCK:
                                if _TUNNEL_GEN == gen_id and not my_stop_evt.is_set():
                                    _TUNNEL_STATE["url"] = found_url
                                    _TUNNEL_STATE["status"] = "online"
                                    _TUNNEL_STATE["error"] = ""
                            print(f"[{APP_NAME}] Public Tunnel : {found_url}", flush=True)
                            ready_evt.set()
                    if "Registered tunnel connection" in ln:
                        with _TUNNEL_LOCK:
                            if _TUNNEL_GEN == gen_id and not my_stop_evt.is_set():
                                if mode == "named" and named_url:
                                    _TUNNEL_STATE["url"] = named_url
                                _TUNNEL_STATE["ready_connections"] = max(1, int(_TUNNEL_STATE.get("ready_connections") or 0))
                                _TUNNEL_STATE["unhealthy_streak"] = 0
                                _TUNNEL_STATE["last_healthy_at"] = time.time()
                                if _TUNNEL_STATE.get("url"):
                                    _TUNNEL_STATE["status"] = "online"
                                    _TUNNEL_STATE["error"] = ""
                        ready_evt.set()
                    elif "Unregistered tunnel connection" in ln:
                        with _TUNNEL_LOCK:
                            if _TUNNEL_GEN == gen_id and not my_stop_evt.is_set():
                                cur_c = int(_TUNNEL_STATE.get("ready_connections") or 0)
                                _TUNNEL_STATE["ready_connections"] = max(0, cur_c - 1)
                proc.wait(timeout=5.0)
            except Exception as exc:
                last_lines.append(str(exc))
            finally:
                if proc is not None and proc.poll() is None:
                    try:
                        proc.terminate()
                        proc.wait(timeout=2.0)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                with _TUNNEL_LOCK:
                    if _TUNNEL_STATE.get("proc") is proc:
                        _TUNNEL_STATE["proc"] = None
                    if _TUNNEL_GEN == gen_id and not my_stop_evt.is_set():
                        _TUNNEL_STATE["status"] = "error"
                        _TUNNEL_STATE["url"] = named_url if mode == "named" else ""
                        _TUNNEL_STATE["error"] = " | ".join(list(last_lines)[-2:])[:240] or "cloudflared 进程已退出，正在重连..."
            if my_stop_evt.wait(5.0):
                break

    t = threading.Thread(target=_runner, args=(gen_stop_evt, my_gen), name=f"cloudflared-tunnel-{my_gen}", daemon=True)
    _TUNNEL_THREAD = t
    t.start()
    if wait_sec > 0:
        ready_evt.wait(timeout=wait_sec)
    return get_tunnel_snapshot()


def detect_connect_endpoints() -> list[dict[str, str]]:
    """Return all reachable endpoints, prioritizing permanent HTTPS & active public tunnels."""
    endpoints: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    funnel_url = _detect_tailscale_funnel_url()
    if funnel_url:
        endpoints.append({
            "iface": "Tailscale Funnel 永久公网",
            "ip": "funnel",
            "url": funnel_url,
            "kind": "permanent",
        })
        seen_urls.add(funnel_url.lower())
    tun = get_tunnel_snapshot()
    if tun.get("status") == "online" and tun.get("url"):
        tun_url = str(tun["url"]).strip().rstrip("/")
        if tun_url and tun_url.lower() not in seen_urls:
            is_named = tun.get("mode") == "named"
            endpoints.append({
                "iface": "Cloudflare 固定公网域名" if is_named else "Cloudflare 公网免VPN",
                "ip": "tunnel",
                "url": tun_url,
                "kind": "permanent" if is_named else "tunnel",
            })
            seen_urls.add(tun_url.lower())
    for ep in detect_lan_addresses():
        u = str(ep.get("url") or "").strip().rstrip("/")
        if u and u.lower() not in seen_urls:
            endpoints.append(ep)
            seen_urls.add(u.lower())
    return endpoints


def _is_loopback_ip(remote: str | None) -> bool:
    s = str(remote or "").strip()
    if not s:
        return False
    try:
        addr = ipaddress.ip_address(s)
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
            return addr.ipv4_mapped.is_loopback
        return addr.is_loopback
    except ValueError:
        return False


def _is_via_public_tunnel(request: web.Request) -> bool:
    """Detect requests arriving via Cloudflare Tunnel or any reverse proxy so local-only routes stay protected."""
    for hdr in (
        "CF-Connecting-IP", "CF-Ray", "CF-Visitor",
        "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Forwarded",
    ):
        if request.headers.get(hdr):
            return True
    host_hdr = str(request.headers.get("Host") or "").strip().lower()
    try:
        host_only = str(urllib.parse.urlparse(f"http://{host_hdr}").hostname or "").lower()
    except Exception:
        host_only = host_hdr.split(":")[0]
    if host_only.endswith(".trycloudflare.com"):
        return True
    tun_url = str(get_tunnel_snapshot().get("url") or "")
    if tun_url:
        try:
            tun_host = (urllib.parse.urlparse(tun_url).hostname or "").lower()
            if tun_host and host_only == tun_host:
                return True
        except Exception:
            pass
    return False


def _client_ip_for_rate_limit(request: web.Request) -> str:
    """Trust CF-Connecting-IP ONLY when arriving from local cloudflared loopback with CF-Ray; ignore X-Forwarded-For."""
    cf_ip = str(request.headers.get("CF-Connecting-IP") or "").strip()
    if cf_ip and request.headers.get("CF-Ray") and _is_loopback_ip(request.remote):
        return cf_ip
    return str(request.remote or "unknown")


def _mask_token(token: str) -> str:
    if len(token) <= 14:
        return token[:4] + "..." if len(token) > 4 else "***"
    return f"{token[:10]}...{token[-4:]}"


# ---------------------------------------------------------------------------
# Transcripts & Conversations
# ---------------------------------------------------------------------------

def _read_pbtxt_title(cid: str) -> str:
    if not _is_valid_cid(cid):
        return ""
    for ann_dir in (CLI_ANN, DESKTOP_ANN):
        p = ann_dir / f"{cid}.pbtxt"
        if p.is_file():
            try:
                raw = p.read_text(encoding="utf-8", errors="replace")
                m = re.search(r'title:\s*"((?:[^"\\]|\\.)*)"', raw)
                if m:
                    t = m.group(1).replace('\\"', '"').replace("\\\\", "\\").replace("\\n", " ").strip()
                    if t:
                        return t[:64]
            except Exception:
                pass
    return ""


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def _extract_user_attachments(raw: str, media_list: list[Any] | None = None) -> list[dict[str, Any]]:
    """Extract clickable structured attachments (mobile uploads + Desktop media) for a user message."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    allowed_roots = _get_allowed_file_roots()

    def _add_path(raw_path: str, mime_hint: str = "") -> None:
        s = str(raw_path or "").strip()
        if not s:
            return
        if s.startswith("file:///"):
            s = urllib.parse.unquote(s[8:])
        elif s.startswith("file://"):
            s = urllib.parse.unquote(s[7:])
        if re.match(r"^/[A-Za-z]:/", s):
            s = s[1:]
        if _has_unsafe_raw_path(s, allow_absolute=True):
            return
        try:
            p = pathlib.Path(s).resolve()
        except Exception:
            return
        if not p.is_file() or not _is_within_allowed_roots(p, allowed_roots) or _is_sensitive_path(p):
            return
        ps = p.as_posix()
        if ps in seen:
            return
        seen.add(ps)
        pretty_name = re.sub(r"^\d{13}_", "", p.name)
        ext = p.suffix.lower()
        mime_low = str(mime_hint or "").lower()
        is_img = (ext in _IMAGE_EXTS) or (mime_low.startswith("image/") and "svg" not in mime_low)
        out.append({
            "name": pretty_name,
            "path": ps,
            "is_image": is_img,
            "preview_url": f"/api/files/preview?path={urllib.parse.quote(ps)}",
        })

    txt = str(raw or "")
    for att_block in re.finditer(
        r"【用户从手机上传的(?:无损原始文件/原图|本地文件/图片路径)[^】]*】\n((?:- [^\n]+\n?)+)",
        txt,
    ):
        for ln in att_block.group(1).splitlines():
            p_str = ln.lstrip("- ").strip()
            if p_str:
                _add_path(p_str)

    if isinstance(media_list, list):
        for item in media_list:
            if isinstance(item, dict) and item.get("uri"):
                _add_path(str(item.get("uri")), str(item.get("mime_type") or ""))

    return out


_DELTA_BRIDGE_BLOCK_RE = re.compile(
    r"^(?:/swarm\s+)?【同步电脑桌面端最新增量对话[^】]*】[\s\S]*\n【同步结束，请直接回复用户的最新指令】[ \t]*(?:\n+|$)"
)
_DELTA_BRIDGE_INLINE_RE = re.compile(
    r"^(?:/swarm\s+)?【同步电脑桌面端最新增量对话[^】]*】[\s\S]*【同步结束，请直接回复用户的最新指令】\s*"
)
_ISO_FRAC_RE = re.compile(r"(\.\d{6})\d+")


def _clean_user_text(raw: str, strip_att_note: bool = False) -> str:
    txt = str(raw or "").strip()
    if not txt:
        return ""
    m = re.search(r"<USER_REQUEST>\s*([\s\S]*?)\s*</USER_REQUEST>", txt)
    if m:
        txt = m.group(1).strip()
    else:
        txt = re.sub(r"<ADDITIONAL_METADATA>[\s\S]*?</ADDITIONAL_METADATA>", "", txt).strip()
        txt = re.sub(r"<CONTEXT_SUMMARY>[\s\S]*?</CONTEXT_SUMMARY>", "", txt).strip()

    # Strip incremental Desktop->CLI delta context bridge block cleanly before checking other markers
    if re.match(r"^(?:/swarm\s+)?【同步电脑桌面端最新增量对话", txt):
        stripped = _DELTA_BRIDGE_BLOCK_RE.sub("", txt, count=1).strip()
        if stripped != txt:
            txt = stripped
        elif "【同步结束，请直接回复用户的最新指令】" in txt:
            txt = _DELTA_BRIDGE_INLINE_RE.sub("", txt, count=1).strip()
    elif txt.startswith("【同步结束，请直接回复用户的最新指令】"):
        txt = txt.split("【同步结束，请直接回复用户的最新指令】", 1)[1].strip()

    # Strip desktop-to-CLI initial context bridge prefix so old assistant/user history never merges into user bubble
    if re.match(r"^(?:/swarm\s+)?【衔接电脑桌面端", txt) and "【用户在 Antigravity Mobile 手机端针对以上会话的最新指令】" in txt:
        txt = txt.rsplit("【用户在 Antigravity Mobile 手机端针对以上会话的最新指令】", 1)[1].strip()

    bridge_markers = (
        "【用户在 Antigravity Mobile 手机端针对以上会话的最新指令】",
        "【当前用户指令与要求】",
    )
    for marker in bridge_markers:
        if marker in txt:
            txt = txt.split(marker, 1)[1].strip()
            if "\n- 请基于当前 Swarm 会话" in txt:
                txt = txt.split("\n- 请基于当前 Swarm 会话", 1)[0].strip()

    # Strip internal swarm helper boilerplate & leading /swarm prefix
    txt = re.sub(r"^【多智能体协作模式】[^\n]*\n*", "", txt).strip()

    # Handle raw upload instruction block
    att_block = re.search(
        r"【用户从手机上传的(?:无损原始文件/原图|本地文件/图片路径)[^】]*】\n((?:- [^\n]+\n?)+)",
        txt,
    )
    if att_block:
        raw_paths = [ln.lstrip("- ").strip() for ln in att_block.group(1).splitlines() if ln.strip()]
        names = [pathlib.Path(p).name for p in raw_paths if p]
        pretty = [re.sub(r"^\d{13}_", "", n) for n in names]
        body_after = (txt[: att_block.start()] + "\n" + txt[att_block.end() :]).strip()
        if strip_att_note:
            txt = body_after
        else:
            att_note = f"[附件: {', '.join(pretty)}]" if pretty else ""
            txt = f"{body_after}\n{att_note}".strip() if body_after else att_note

    return txt


def _clean_assistant_text(raw: str) -> str:
    txt = str(raw or "").strip()
    if not txt:
        return ""
    lines = [
        ln for ln in txt.splitlines()
        if not ln.strip().startswith(("[防长对话漂移锚点]", "> [路由：", "[路由："))
    ]
    return "\n".join(lines).strip() or txt


def _locate_transcript(cid: str) -> tuple[pathlib.Path | None, str]:
    if not _is_valid_cid(cid):
        return None, "mobile"
    cli_t = CLI_BRAIN / cid / ".system_generated" / "logs" / "transcript.jsonl"
    if cli_t.is_file():
        return cli_t, "mobile"
    desk_t = DESKTOP_BRAIN / cid / ".system_generated" / "logs" / "transcript.jsonl"
    if desk_t.is_file():
        return desk_t, "desktop"
    return None, "mobile"


def _parse_jsonl(p: pathlib.Path) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    try:
        with p.open("r", encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                s = ln.strip()
                if not s:
                    continue
                try:
                    o = json.loads(s)
                    if isinstance(o, dict):
                        steps.append(o)
                except Exception:
                    continue
    except Exception:
        pass
    return steps


def _load_full_steps(tf: pathlib.Path, needed: set[int]) -> dict[int, dict[str, Any]]:
    if not needed:
        return {}
    tfull = tf.with_name("transcript_full.jsonl")
    if not tfull.is_file():
        return {}
    out: dict[int, dict[str, Any]] = {}
    rem = set(needed)
    try:
        with tfull.open("r", encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                if not rem:
                    break
                m = _STEP_IDX_RE.search(ln[:120])
                if m and int(m.group(1)) not in rem:
                    continue
                try:
                    o = json.loads(ln)
                    si = o.get("step_index")
                    if isinstance(si, int) and si in rem:
                        out[si] = o
                        rem.discard(si)
                except Exception:
                    continue
    except Exception:
        pass
    return out


def _is_swarm_worker_quick(steps: list[dict[str, Any]]) -> bool:
    for s in steps:
        if s.get("type") == "USER_INPUT" and s.get("source") == "USER_EXPLICIT":
            return False
    return True


def _is_swarm_worker_file(tf: pathlib.Path) -> bool:
    """Fast check whether a transcript belongs to an internal swarm worker (no USER_EXPLICIT USER_INPUT)."""
    try:
        with tf.open("r", encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                if "USER_EXPLICIT" in ln and "USER_INPUT" in ln:
                    try:
                        o = json.loads(ln)
                        if isinstance(o, dict) and o.get("type") == "USER_INPUT" and o.get("source") == "USER_EXPLICIT":
                            return False
                    except Exception:
                        continue
        return True
    except OSError:
        return False


def _parse_iso_ts(val: Any) -> float:
    """Safely parse ISO-8601 timestamp string (Z or offset) to UTC epoch seconds; returns 0.0 on failure."""
    if isinstance(val, (int, float)):
        return float(val) if val > 0 else 0.0
    s = str(val or "").strip()
    if not s:
        return 0.0
    try:
        if s.endswith("Z") or s.endswith("z"):
            s = s[:-1] + "+00:00"
        s = _ISO_FRAC_RE.sub(r"\1", s)
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:
        return 0.0


def _merge_messages_chronologically(*streams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stably interleave one or more message lists in ascending chronological order (ts, orig_order)."""
    tagged: list[tuple[float, int, dict[str, Any]]] = []
    seq = 0
    for stream in streams:
        prev_ts = 0.0
        for m in stream:
            ts = _parse_iso_ts(m.get("time"))
            if ts > 0.0:
                prev_ts = ts
            else:
                ts = prev_ts
            tagged.append((ts, seq, m))
            seq += 1
    tagged.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in tagged]


def _get_cli_first_step_time(cli_cid: str) -> str:
    """Read the earliest step `created_at` from a CLI transcript (fallback watermark for pre-existing aliases)."""
    if not cli_cid:
        return ""
    tf = CLI_BRAIN / cli_cid / ".system_generated" / "logs" / "transcript.jsonl"
    if not tf.is_file():
        return ""
    try:
        with tf.open("r", encoding="utf-8", errors="replace") as fh:
            for idx, ln in enumerate(fh):
                if idx >= 10:
                    break
                s = ln.strip()
                if not s:
                    continue
                try:
                    o = json.loads(s)
                    if isinstance(o, dict) and o.get("created_at"):
                        return str(o["created_at"]).strip()
                except Exception:
                    continue
    except Exception:
        pass
    return ""


_RECOMMENDED_TAG_RE = re.compile(
    r"^\s*(?:\(\s*Recommended\s*\)|\[\s*Recommended\s*\]|（\s*推荐\s*）|【\s*推荐\s*】)\s*",
    re.IGNORECASE,
)
_USER_CHOICE_PREFIX_RE = re.compile(
    r"^(?:我选择|已选择|选择|选|Selected|Choice)\s*[:：]\s*",
    re.IGNORECASE,
)


def _strip_recommended_tag(text: str) -> str:
    return _RECOMMENDED_TAG_RE.sub("", str(text or "").strip()).strip()


def _parse_ask_question_args(args: Any) -> list[dict[str, Any]]:
    if not isinstance(args, dict):
        return []
    raw_qs = args.get("questions")
    if isinstance(raw_qs, str):
        try:
            raw_qs = json.loads(raw_qs)
        except Exception:
            return []
    if not isinstance(raw_qs, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw_qs:
        if not isinstance(item, dict):
            continue
        q_txt = str(item.get("question") or "").strip()
        raw_opts = item.get("options")
        if isinstance(raw_opts, str):
            try:
                raw_opts = json.loads(raw_opts)
            except Exception:
                raw_opts = []
        opts: list[str] = []
        if isinstance(raw_opts, list):
            for o in raw_opts:
                s_o = str(o if not isinstance(o, dict) else (o.get("label") or o.get("text") or o.get("value") or "")).strip()
                if s_o:
                    opts.append(s_o)
        if not q_txt and not opts:
            continue
        out.append({
            "question": q_txt,
            "is_multi_select": bool(item.get("is_multi_select", False)),
            "options": opts,
        })
    return out


def _strip_generic_timestamps(raw_content: str) -> tuple[str, str]:
    lines = str(raw_content or "").replace("\r\n", "\n").split("\n")
    idx = 0
    completed_at = ""
    while idx < len(lines):
        ln = lines[idx].strip()
        if ln.startswith("Created At:"):
            idx += 1
        elif ln.startswith("Completed At:"):
            completed_at = ln.split(":", 1)[1].strip()
            idx += 1
        else:
            break
    body = "\n".join(lines[idx:]).strip()
    return body, completed_at


def _match_answer_to_options(ans_text: str, options: list[str], is_multi: bool) -> tuple[list[int], str]:
    cleaned = _USER_CHOICE_PREFIX_RE.sub("", str(ans_text or "").strip()).strip()
    if not cleaned:
        return [], ""
    low_clean = cleaned.lower()
    stripped_clean = _strip_recommended_tag(cleaned).lower()
    if not options:
        return [], cleaned

    # Direct full-string match first
    for idx, opt in enumerate(options):
        o_str = str(opt or "").strip()
        o_stripped = _strip_recommended_tag(o_str)
        if low_clean == o_str.lower() or stripped_clean == o_stripped.lower():
            return [idx], ""

    if is_multi:
        selected: list[int] = []
        remaining = cleaned
        # Greedy match longer options first so substrings don't shadow full options
        indexed_opts = sorted(enumerate(options), key=lambda kv: len(str(kv[1] or "")), reverse=True)
        for idx, opt in indexed_opts:
            o_str = str(opt or "").strip()
            o_stripped = _strip_recommended_tag(o_str)
            matched = False
            for cand in (o_str, o_stripped):
                if cand and cand.lower() in remaining.lower():
                    pos = remaining.lower().find(cand.lower())
                    remaining = (remaining[:pos] + " " + remaining[pos + len(cand):]).strip()
                    matched = True
                    break
            if matched:
                selected.append(idx)
        selected.sort()
        leftover = re.sub(r"^[,;、\s\n]+|[,;、\s\n]+$", "", remaining).strip()
        if selected:
            return selected, leftover
        # Fallback token split
        parts = [p.strip() for p in re.split(r"[\n,;；、]+", cleaned) if p.strip()]
        custom_parts: list[str] = []
        for p in parts:
            p_low = _strip_recommended_tag(p).lower()
            hit = next(
                (i for i, o in enumerate(options) if _strip_recommended_tag(str(o or "")).lower() == p_low or str(o or "").strip().lower() == p.lower()),
                None,
            )
            if hit is not None:
                if hit not in selected:
                    selected.append(hit)
            else:
                custom_parts.append(p)
        selected.sort()
        return selected, "; ".join(custom_parts)

    # Numbered single choice fallback (e.g. "1" or "选1" or prefix match)
    m_num = re.match(r"^(?:第\s*)?(\d+)(?:\s*(?:个|项|号))?$", cleaned)
    if m_num:
        n_idx = int(m_num.group(1)) - 1
        if 0 <= n_idx < len(options):
            return [n_idx], ""
    if len(stripped_clean) >= 4:
        for idx, opt in enumerate(options):
            o_stripped = _strip_recommended_tag(str(opt or "")).lower()
            if o_stripped and o_stripped.startswith(stripped_clean):
                return [idx], ""
    return [], cleaned


def _parse_ask_question_answers(body: str, questions: list[dict[str, Any]]) -> tuple[list[str], list[list[int]], list[str]]:
    text = str(body or "").replace("\r\n", "\n").strip()
    n_qs = len(questions)
    answers = [""] * n_qs
    sel_indices: list[list[int]] = [[] for _ in range(n_qs)]
    custom_answers = [""] * n_qs
    if not text or n_qs == 0:
        return answers, sel_indices, custom_answers

    markers = list(re.finditer(r"(?:^|\n)A(\d+)\s*[:：]\s*", text))
    if markers:
        for pos, m in enumerate(markers):
            q_num = int(m.group(1))
            q_idx = q_num - 1
            if not (0 <= q_idx < n_qs):
                continue
            start = m.end()
            end = markers[pos + 1].start() if (pos + 1 < len(markers)) else len(text)
            ans_raw = text[start:end].strip()
            answers[q_idx] = ans_raw
            q_obj = questions[q_idx]
            idxs, cust = _match_answer_to_options(ans_raw, q_obj.get("options") or [], bool(q_obj.get("is_multi_select", False)))
            sel_indices[q_idx] = idxs
            custom_answers[q_idx] = cust
    else:
        q0 = questions[0]
        cleaned = _USER_CHOICE_PREFIX_RE.sub("", text).strip()
        answers[0] = cleaned
        idxs, cust = _match_answer_to_options(cleaned, q0.get("options") or [], bool(q0.get("is_multi_select", False)))
        sel_indices[0] = idxs
        custom_answers[0] = cust
    return answers, sel_indices, custom_answers


def _extract_plan_feedback_meta(tc: dict[str, Any]) -> dict[str, Any] | None:
    targs = tc.get("args") if isinstance(tc.get("args"), dict) else {}
    am = targs.get("ArtifactMetadata")
    if isinstance(am, str):
        try:
            am = json.loads(am)
        except Exception:
            am = None
    if not isinstance(am, dict):
        return None
    if not (bool(am.get("RequestFeedback")) and bool(am.get("UserFacing"))):
        return None
    fp = str(targs.get("Path") or targs.get("TargetFile") or "").strip().strip('"')
    return {
        "summary": str(am.get("Summary") or "").strip(),
        "path": fp,
    }


def _summarize_tool(tc: dict[str, Any]) -> dict[str, str]:
    name = str(tc.get("name") or "")
    args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
    target = ""
    if name == "ask_question":
        qs = _parse_ask_question_args(args)
        if qs and qs[0].get("question"):
            target = str(qs[0]["question"]).strip().splitlines()[0][:80]
    if not target:
        for k in ("Path", "TargetFile", "CommandLine", "toolSummary", "query", "Url", "path", "Role"):
            val = args.get(k)
            if val:
                target = str(val).strip().splitlines()[0][:80]
                break
    return {"name": name, "target": target}


_CONV_META_CACHE_LOCK = threading.Lock()
# (source, cid) -> (mtime_ns, size, meta_dict_or_None)
_CONV_META_CACHE: dict[tuple[str, str], tuple[int, int, dict[str, Any] | None]] = {}


def _extract_conv_meta(cid: str, tf: pathlib.Path, source: str, mtime: float, mtime_ns: int, size: int, is_active: bool) -> dict[str, Any] | None:
    cache_key = (source, cid)
    if not is_active:
        with _CONV_META_CACHE_LOCK:
            cached = _CONV_META_CACHE.get(cache_key)
            if cached is not None and cached[0] == mtime_ns and cached[1] == size:
                return dict(cached[2]) if cached[2] is not None else None
        if _is_swarm_worker_file(tf):
            with _CONV_META_CACHE_LOCK:
                if len(_CONV_META_CACHE) > 2000:
                    _CONV_META_CACHE.clear()
                _CONV_META_CACHE[cache_key] = (mtime_ns, size, None)
            return None

    steps = _parse_jsonl(tf)
    if not steps:
        if not is_active:
            with _CONV_META_CACHE_LOCK:
                _CONV_META_CACHE[cache_key] = (mtime_ns, size, None)
        return None

    if not is_active and _is_swarm_worker_quick(steps):
        with _CONV_META_CACHE_LOCK:
            _CONV_META_CACHE[cache_key] = (mtime_ns, size, None)
        return None

    title = _read_pbtxt_title(cid)
    first_u = ""
    last_preview = ""
    model_id = ""
    tail_step = None
    for s in steps:
        st_t = str(s.get("type") or "")
        if st_t == "USER_INPUT" and s.get("source") == "USER_EXPLICIT" and not first_u:
            first_u = _clean_user_text(str(s.get("content") or ""))
        if st_t == "PLANNER_RESPONSE":
            if s.get("model"):
                model_id = str(s["model"])
            c_txt = _clean_assistant_text(str(s.get("content") or ""))
            if c_txt:
                last_preview = re.sub(r"\s+", " ", c_txt)[:90]
        if st_t not in ("EPHEMERAL_MESSAGE", "CHECKPOINT"):
            tail_step = s

    if not title:
        parent_desk = get_desktop_parent_for_cli(cid) if source == "mobile" else ""
        if parent_desk:
            title = _read_pbtxt_title(parent_desk)
        if not title:
            for ln in first_u.splitlines():
                ln_c = ln.strip()
                if ln_c and not ln_c.startswith(("【", "<", "[用户]", "[助手]")):
                    title = ln_c[:42]
                    break
        title = title or first_u[:42] or f"对话 {cid[:8]}"

    tail_looks_running = False
    tail_looks_waiting = False
    if tail_step is not None:
        tt = str(tail_step.get("type") or "")
        st_u = str(tail_step.get("status") or "").upper()
        tcs_tail = tail_step.get("tool_calls") or []
        if tt == "PLANNER_RESPONSE" and st_u == "DONE" and tcs_tail and all(
            isinstance(tc, dict) and str(tc.get("name") or "") == "ask_question" for tc in tcs_tail
        ):
            tail_looks_waiting = True
        elif tt != "PLANNER_RESPONSE" or st_u != "DONE" or bool(tcs_tail):
            tail_looks_running = True

    meta: dict[str, Any] = {
        "id": cid,
        "shortId": cid[:8],
        "title": title,
        "source": source,
        "model": model_id or "gemini-4-neon-medium",
        "preview": last_preview or first_u[:80],
        "updatedAt": mtime,
        "stepCount": len(steps),
        "_tailRunning": tail_looks_running,
        "_tailWaiting": tail_looks_waiting,
    }
    if not is_active:
        with _CONV_META_CACHE_LOCK:
            if len(_CONV_META_CACHE) > 2000:
                _CONV_META_CACHE.clear()
            _CONV_META_CACHE[cache_key] = (mtime_ns, size, dict(meta))
    return meta


def _scan_source_conversations(
    root: pathlib.Path,
    source: str,
    limit: int,
    active_ids: set[str],
    exclude_ids: set[str],
) -> list[dict[str, Any]]:
    if not root.is_dir() or limit <= 0:
        return []
    raw_entries: list[tuple[float, int, int, str, pathlib.Path]] = []
    try:
        with os.scandir(root) as it:
            for entry in it:
                if not entry.is_dir(follow_symlinks=False) or len(entry.name) < 16 or entry.name in exclude_ids:
                    continue
                tf = pathlib.Path(entry.path) / ".system_generated" / "logs" / "transcript.jsonl"
                try:
                    st = tf.stat()
                    if st.st_size > 0:
                        raw_entries.append((st.st_mtime, st.st_mtime_ns, st.st_size, entry.name, tf))
                except OSError:
                    continue
    except Exception:
        return []

    raw_entries.sort(key=lambda x: x[0], reverse=True)
    bucket: list[dict[str, Any]] = []
    now_ts = time.time()
    # Scan past swarm workers without artificially capping before reaching `limit` valid items
    for mtime, mtime_ns, size, cid, tf in raw_entries[: max(600, limit * 8)]:
        if len(bucket) >= limit:
            break
        is_act = cid in active_ids
        meta = _extract_conv_meta(cid, tf, source, mtime, mtime_ns, size, is_act)
        if meta is None:
            continue
        tail_running = bool(meta.pop("_tailRunning", False))
        tail_waiting = bool(meta.pop("_tailWaiting", False))
        is_running = is_act or (tail_running and (now_ts - mtime < 180.0))
        meta["status"] = "running" if is_running else "idle"
        if tail_waiting and not is_running:
            meta["waitingInteraction"] = True
        bucket.append(meta)
    return bucket


def list_all_conversations(
    limit: int = 80,
    source_filter: str = "all",
    include_external_cli: bool = False,
) -> list[dict[str, Any]]:
    if source_filter not in ("all", "mobile", "desktop", "external"):
        source_filter = "all"
    if source_filter == "external" and not include_external_cli:
        return []

    active_ids: set[str] = set()
    with _ACTIVE_RUNS_LOCK:
        for k, v in _ACTIVE_RUNS.items():
            if v.get("running"):
                active_ids.add(k)

    cfg = load_or_create_config()
    aliases = cfg.get("desktop_to_cli_alias") or {}
    aliased_cli_set = {str(v).strip() for v in aliases.values() if str(v).strip()}
    mobile_own = get_mobile_own_cids()
    qq_dm_cids = get_qq_dm_cids()
    all_mobile_cids = mobile_own | qq_dm_cids

    seen: set[str] = set()
    now_ts = time.time()

    # 1. Scan Desktop Antigravity conversations (100% aligned with PC IDE left sidebar)
    desktop_items: list[dict[str, Any]] = []
    if source_filter != "external":
        desktop_items = _scan_source_conversations(DESKTOP_BRAIN, "desktop", limit, active_ids, seen)
        seen.update(it["id"] for it in desktop_items)

        # Ensure Desktop conversations with linked mobile continuations are included even if Desktop mtime is older
        for d_cid_raw, aliased_raw in aliases.items():
            d_cid = str(d_cid_raw or "").strip()
            if not d_cid or d_cid in seen or not str(aliased_raw or "").strip() or not _is_valid_cid(d_cid):
                continue
            d_tf = DESKTOP_BRAIN / d_cid / ".system_generated" / "logs" / "transcript.jsonl"
            try:
                st = d_tf.stat()
                if st.st_size <= 0:
                    continue
                d_meta = _extract_conv_meta(d_cid, d_tf, "desktop", st.st_mtime, st.st_mtime_ns, st.st_size, d_cid in active_ids)
                if d_meta is None:
                    continue
                tr = bool(d_meta.pop("_tailRunning", False))
                tw = bool(d_meta.pop("_tailWaiting", False))
                d_meta["status"] = "running" if (d_cid in active_ids or (tr and now_ts - st.st_mtime < 180.0)) else "idle"
                if tw and d_meta["status"] != "running":
                    d_meta["waitingInteraction"] = True
                desktop_items.append(d_meta)
                seen.add(d_cid)
            except OSError:
                continue

        # Reflect any linked mobile continuation activity onto its unified Desktop row (no duplicate rows)
        for d_item in desktop_items:
            aliased_cli = str(aliases.get(d_item["id"]) or "").strip()
            if not aliased_cli:
                d_item["hasMobile"] = False
                continue
            d_item["hasMobile"] = True
            c_tf = CLI_BRAIN / aliased_cli / ".system_generated" / "logs" / "transcript.jsonl"
            c_item = None
            try:
                c_st = c_tf.stat()
                if c_st.st_size > 0:
                    c_meta = _extract_conv_meta(
                        aliased_cli, c_tf, "mobile", c_st.st_mtime, c_st.st_mtime_ns, c_st.st_size, aliased_cli in active_ids
                    )
                    if c_meta is not None:
                        tr = bool(c_meta.pop("_tailRunning", False))
                        tw = bool(c_meta.pop("_tailWaiting", False))
                        c_meta["status"] = "running" if (aliased_cli in active_ids or (tr and now_ts - c_st.st_mtime < 180.0)) else "idle"
                        if tw and c_meta["status"] != "running":
                            c_meta["waitingInteraction"] = True
                        c_item = c_meta
            except OSError:
                c_item = None
            if c_item:
                d_item["stepCount"] = int(d_item.get("stepCount") or 0) + int(c_item.get("stepCount") or 0)
                if float(c_item.get("updatedAt") or 0) > float(d_item.get("updatedAt") or 0):
                    d_item["updatedAt"] = c_item["updatedAt"]
                    if c_item.get("preview"):
                        d_item["preview"] = c_item["preview"]
                    if c_item.get("model"):
                        d_item["model"] = c_item["model"]
                    if c_item.get("waitingInteraction"):
                        d_item["waitingInteraction"] = True
                    elif d_item.get("waitingInteraction"):
                        d_item.pop("waitingInteraction", None)
                if c_item.get("status") == "running" or aliased_cli in active_ids or d_item["id"] in active_ids:
                    d_item["status"] = "running"

    # 2. Include standalone chats created by Antigravity Mobile / Workbench AND optional QQ Bot private chats (DM only, never group chats)
    own_mobile_items: list[dict[str, Any]] = []
    if source_filter in ("all", "mobile"):
        for m_cid in all_mobile_cids:
            if not m_cid or m_cid in seen or m_cid in aliased_cli_set or not _is_valid_cid(m_cid):
                continue
            m_tf = CLI_BRAIN / m_cid / ".system_generated" / "logs" / "transcript.jsonl"
            try:
                st = m_tf.stat()
                if st.st_size <= 0:
                    continue
                meta = _extract_conv_meta(m_cid, m_tf, "mobile", st.st_mtime, st.st_mtime_ns, st.st_size, m_cid in active_ids)
                if meta is None:
                    continue
                tr = bool(meta.pop("_tailRunning", False))
                tw = bool(meta.pop("_tailWaiting", False))
                meta["status"] = "running" if (m_cid in active_ids or (tr and now_ts - st.st_mtime < 180.0)) else "idle"
                if tw and meta["status"] != "running":
                    meta["waitingInteraction"] = True
                if m_cid in qq_dm_cids and m_cid not in mobile_own:
                    meta["subSource"] = "qq_dm"
                own_mobile_items.append(meta)
                seen.add(m_cid)
            except OSError:
                continue

    # 3. Optional External CLI / QQ Bot group standalone sessions (ONLY when explicitly enabled)
    external_items: list[dict[str, Any]] = []
    if include_external_cli and source_filter in ("all", "external"):
        exclude_ext = seen | all_mobile_cids | aliased_cli_set | {str(k).strip() for k in aliases.keys() if str(k).strip()}
        external_items = _scan_source_conversations(CLI_BRAIN, "external", limit, active_ids, exclude_ext)

    if source_filter == "desktop":
        result = list(desktop_items)
    elif source_filter == "mobile":
        result = [d for d in desktop_items if d.get("hasMobile")] + own_mobile_items
    elif source_filter == "external":
        result = list(external_items)
    else:
        result = desktop_items + own_mobile_items + (external_items if include_external_cli else [])

    result.sort(key=lambda x: float(x.get("updatedAt") or 0), reverse=True)

    if source_filter in ("all", "mobile"):
        existing_ids = {r["id"] for r in result}
        seen_runs: set[int] = set()
        with _ACTIVE_RUNS_LOCK:
            for cid, run in _ACTIVE_RUNS.items():
                if not run.get("running") or id(run) in seen_runs:
                    continue
                seen_runs.add(id(run))
                run_cid = str(run.get("cid") or "")
                disp_cid = str(run.get("display_cid") or run_cid or cid)
                if disp_cid in existing_ids or run_cid in existing_ids or cid in existing_ids or run_cid in aliased_cli_set:
                    continue
                existing_ids.add(disp_cid)
                result.insert(0, {
                    "id": disp_cid,
                    "shortId": disp_cid[:8],
                    "title": str(run.get("prompt") or "新对话")[:42],
                    "source": "mobile",
                    "status": "running",
                    "model": str(run.get("model") or "gemini-4-neon-medium"),
                    "preview": "正在思考与执行...",
                    "updatedAt": float(run.get("started_at") or time.time()),
                    "stepCount": 1,
                })

    waiting_cids = _get_waiting_interaction_cids()
    if waiting_cids:
        for r in result:
            rcid = str(r.get("id") or "")
            ralias = str(aliases.get(rcid) or "")
            if rcid in waiting_cids or (ralias and ralias in waiting_cids):
                r["waitingInteraction"] = True

    return result[:limit]


def load_conversation_detail(
    cid: str,
    _include_parent: bool = True,
    _include_cli_alias: bool = True,
    _keep_internal_src: bool = False,
    _apply_revert_filter: bool = True,
) -> dict[str, Any]:
    tf, source = _locate_transcript(cid)
    title = _read_pbtxt_title(cid)
    steps = _parse_jsonl(tf) if tf is not None else []

    if tf is not None and steps:
        needed: set[int] = set()
        watch_generic_until = -1
        for s_idx, s in enumerate(steps):
            tfs = s.get("truncated_fields") or []
            si = s.get("step_index")
            st_t = str(s.get("type") or "")
            has_interesting_tc = False
            if st_t == "PLANNER_RESPONSE":
                tcs_c = s.get("tool_calls") or []
                for tc in tcs_c:
                    if isinstance(tc, dict) and tc.get("name") in ("ask_question", "write_file", "edit_file", "write_to_file"):
                        has_interesting_tc = True
                        if tc.get("name") == "ask_question":
                            watch_generic_until = s_idx + 8
                        break
            if isinstance(si, int) and tfs:
                if st_t in ("PLANNER_RESPONSE", "USER_INPUT") and "content" in tfs:
                    needed.add(si)
                elif st_t == "PLANNER_RESPONSE" and "tool_calls" in tfs and has_interesting_tc:
                    needed.add(si)
                elif st_t == "GENERIC" and "content" in tfs and s_idx <= watch_generic_until:
                    needed.add(si)
        if needed:
            full_map = _load_full_steps(tf, needed)
            if full_map:
                steps = [full_map.get(s.get("step_index"), s) if isinstance(s.get("step_index"), int) else s for s in steps]

    parent_msgs: list[dict[str, Any]] = []
    # If this mobile CLI session branched off a Desktop conversation, load pure Desktop-only history
    if _include_parent and source == "mobile":
        parent_desk = get_desktop_parent_for_cli(cid)
        if parent_desk and parent_desk != cid:
            parent_detail = load_conversation_detail(
                parent_desk,
                _include_parent=False,
                _include_cli_alias=False,
                _keep_internal_src=True,
                _apply_revert_filter=False,
            )
            p_msgs = parent_detail.get("messages") or []
            if p_msgs:
                parent_msgs = list(p_msgs)
            if not title and parent_detail.get("title"):
                title = str(parent_detail["title"])

    own_src = "desktop" if source == "desktop" else "cli"
    own_messages: list[dict[str, Any]] = []
    deliverable_cands: list[str] = []
    last_model = ""
    pending_tools: list[dict[str, str]] = []
    pending_thinking: list[str] = []
    last_step_time = ""
    pending_tool_time = ""

    n_steps = len(steps)
    for s_idx, s in enumerate(steps):
        step_time = str(s.get("created_at") or "").strip()
        if step_time:
            last_step_time = step_time
        st_t = str(s.get("type") or "")
        if st_t in ("EPHEMERAL_MESSAGE", "CHECKPOINT"):
            continue
        if st_t == "USER_INPUT" and s.get("source") == "USER_EXPLICIT":
            msg_time = step_time or last_step_time
            if pending_tools:
                own_messages.append({
                    "role": "assistant",
                    "text": "",
                    "tools": list(pending_tools),
                    "thinking": "\n".join(pending_thinking)[-1200:],
                    "model": last_model,
                    "time": pending_tool_time or msg_time or last_step_time,
                    "_src": own_src,
                })
                pending_tools.clear()
                pending_thinking.clear()
                pending_tool_time = ""
            raw_u_content = str(s.get("content") or "")
            u_atts = _extract_user_attachments(raw_u_content, s.get("media"))
            u_txt = _clean_user_text(raw_u_content, strip_att_note=bool(u_atts))
            if not title and u_txt:
                for ln in u_txt.splitlines():
                    if ln.strip() and not ln.strip().startswith(("【", "<")):
                        title = ln.strip()[:48]
                        break
            u_msg: dict[str, Any] = {
                "role": "user",
                "text": u_txt,
                "time": msg_time,
                "_src": own_src,
            }
            if u_atts:
                u_msg["attachments"] = u_atts
            own_messages.append(u_msg)
        elif st_t == "PLANNER_RESPONSE":
            msg_time = step_time or last_step_time
            if s.get("model"):
                last_model = str(s["model"])
            th = str(s.get("thinking") or "").strip()
            if th:
                pending_thinking.append(th)
            tcs = s.get("tool_calls") or []

            # Inspect immediate tool results & next user turn so ask_question / permission / plan cards stay structured
            generic_steps: list[dict[str, Any]] = []
            next_user_step: dict[str, Any] | None = None
            has_later_turn = False
            collecting_generic = True
            for j in range(s_idx + 1, n_steps):
                sj = steps[j]
                sj_t = str(sj.get("type") or "")
                if sj_t in ("EPHEMERAL_MESSAGE", "CHECKPOINT"):
                    continue
                if collecting_generic and sj_t == "GENERIC":
                    generic_steps.append(sj)
                    continue
                collecting_generic = False
                if sj_t in ("PLANNER_RESPONSE", "USER_INPUT"):
                    has_later_turn = True
                    if sj_t == "USER_INPUT" and sj.get("source") == "USER_EXPLICIT" and next_user_step is None:
                        next_user_step = sj
                    break

            step_interactions: list[dict[str, Any]] = []
            for tc_pos, tc in enumerate(tcs):
                if not isinstance(tc, dict) or not tc.get("name"):
                    continue
                t_sum = _summarize_tool(tc)
                g_match = generic_steps[tc_pos] if tc_pos < len(generic_steps) else None
                if isinstance(g_match, dict):
                    g_st = str(g_match.get("status") or "").upper()
                    g_body, _ = _strip_generic_timestamps(str(g_match.get("content") or ""))
                    if g_st in ("REJECTED", "CANCELED", "CANCELLED") or g_body.lower().startswith(
                        ("rejected", "user rejected", "denied", "permission denied")
                    ):
                        t_sum["state"] = "REJECTED"
                pending_tools.append(t_sum)
                if msg_time:
                    pending_tool_time = msg_time
                tname = str(tc["name"])
                targs = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                if tname in ("write_file", "edit_file", "write_to_file", "replace_file_content"):
                    fp = str(targs.get("Path") or targs.get("TargetFile") or "").strip().strip('"')
                    if fp:
                        deliverable_cands.append(fp)

                if tname == "ask_question":
                    q_list = _parse_ask_question_args(targs)
                    if q_list:
                        g_q = g_match
                        if g_q is None or not (
                            re.search(r"(?:^|\n)A1\s*[:：]", str(g_q.get("content") or ""))
                            or str(g_q.get("status") or "").upper() in ("WAITING", "RUNNING", "PENDING", "CANCELED", "CANCELLED", "REJECTED")
                        ):
                            for gc in generic_steps:
                                gc_body = str(gc.get("content") or "")
                                gc_st = str(gc.get("status") or "").upper()
                                if re.search(r"(?:^|\n)A1\s*[:：]", gc_body) or gc_st in ("WAITING", "RUNNING", "PENDING", "CANCELED", "CANCELLED", "REJECTED"):
                                    g_q = gc
                                    break
                        answers = [""] * len(q_list)
                        sel_indices: list[list[int]] = [[] for _ in range(len(q_list))]
                        custom_answers = [""] * len(q_list)
                        answered_at = ""
                        ix_status = "pending" if not has_later_turn else "answered"

                        if isinstance(g_q, dict):
                            g_st = str(g_q.get("status") or "").upper()
                            g_body, comp_at = _strip_generic_timestamps(str(g_q.get("content") or ""))
                            answered_at = comp_at or str(g_q.get("created_at") or "").strip()
                            g_low = g_body.strip().lower()
                            if g_st in ("WAITING", "RUNNING", "PENDING"):
                                ix_status = "pending"
                            elif g_st in ("CANCELED", "CANCELLED", "REJECTED", "ERROR") or g_low.startswith(
                                ("user skip", "user cancel", "cancelled", "canceled", "dismissed", "skipped")
                            ):
                                ix_status = "cancelled"
                            else:
                                answers, sel_indices, custom_answers = _parse_ask_question_answers(g_body, q_list)
                                ix_status = "answered" if (any(answers) or has_later_turn) else "pending"
                        elif next_user_step is not None:
                            u_ans_raw = str(next_user_step.get("content") or "")
                            u_ans_atts = _extract_user_attachments(u_ans_raw, next_user_step.get("media"))
                            u_ans_clean = _clean_user_text(u_ans_raw, strip_att_note=bool(u_ans_atts))
                            answers, sel_indices, custom_answers = _parse_ask_question_answers(u_ans_clean, q_list)
                            ix_status = "answered"
                            answered_at = str(next_user_step.get("created_at") or "").strip()
                        elif has_later_turn:
                            ix_status = "answered"

                        step_interactions.append({
                            "id": f"hist_q_{s.get('step_index', s_idx)}_{tc_pos}",
                            "kind": "ask_question",
                            "source": own_src,
                            "live": False,
                            "status": ix_status,
                            "questions": q_list,
                            "answers": answers,
                            "selectedIndices": sel_indices,
                            "customAnswers": custom_answers,
                            "answeredAt": answered_at,
                        })
                elif tname in ("write_file", "edit_file", "write_to_file"):
                    pf_meta = _extract_plan_feedback_meta(tc)
                    if pf_meta is not None:
                        pf_status = "pending" if not has_later_turn else "answered"
                        if isinstance(g_match, dict):
                            gst = str(g_match.get("status") or "").upper()
                            if gst in ("WAITING", "RUNNING", "PENDING"):
                                pf_status = "pending"
                            elif gst in ("CANCELED", "CANCELLED", "REJECTED"):
                                pf_status = "cancelled"
                        step_interactions.append({
                            "id": f"hist_p_{s.get('step_index', s_idx)}_{tc_pos}",
                            "kind": "plan_feedback",
                            "source": own_src,
                            "live": False,
                            "status": pf_status,
                            "summary": pf_meta["summary"],
                            "path": pf_meta["path"],
                        })

            a_txt = _clean_assistant_text(str(s.get("content") or ""))
            if a_txt or step_interactions:
                if a_txt:
                    for mf in re.finditer(r"file:///([^)\s\"#>]+)", a_txt):
                        u_dec = urllib.parse.unquote(mf.group(1)).split("#")[0].strip()
                        if re.match(r"^/[A-Za-z]:/", u_dec):
                            u_dec = u_dec[1:]
                        deliverable_cands.append(u_dec)
                a_msg: dict[str, Any] = {
                    "role": "assistant",
                    "text": a_txt,
                    "tools": list(pending_tools),
                    "thinking": "\n".join(pending_thinking)[-2000:],
                    "model": last_model,
                    "time": msg_time,
                    "isFinal": (not bool(tcs)) and (not step_interactions),
                    "_src": own_src,
                }
                if step_interactions:
                    a_msg["interactions"] = step_interactions
                own_messages.append(a_msg)
                pending_tools.clear()
                pending_thinking.clear()
                pending_tool_time = ""

    if pending_tools:
        own_messages.append({
            "role": "assistant",
            "text": "",
            "tools": list(pending_tools),
            "thinking": "\n".join(pending_thinking)[-1200:],
            "model": last_model,
            "time": pending_tool_time or last_step_time,
            "isFinal": False,
            "_src": own_src,
        })

    # If opening a Desktop conversation that also has mobile CLI continuation turns, merge them chronologically
    child_msgs: list[dict[str, Any]] = []
    aliased_cli = get_desktop_cli_alias(cid) if (_include_cli_alias and source == "desktop") else ""
    if aliased_cli and aliased_cli != cid:
        child_detail = load_conversation_detail(
            aliased_cli,
            _include_parent=False,
            _include_cli_alias=False,
            _keep_internal_src=True,
            _apply_revert_filter=False,
        )
        c_msgs = child_detail.get("messages") or []
        if c_msgs:
            child_msgs = list(c_msgs)
        for cd in reversed(child_detail.get("deliverables") or []):
            if cd.get("path"):
                deliverable_cands.append(str(cd["path"]))

    if parent_msgs and child_msgs:
        messages = _merge_messages_chronologically(parent_msgs, own_messages, child_msgs)
    elif parent_msgs:
        messages = _merge_messages_chronologically(parent_msgs, own_messages)
    elif child_msgs:
        messages = _merge_messages_chronologically(own_messages, child_msgs)
    else:
        messages = own_messages

    if _apply_revert_filter:
        messages = _filter_reverted_messages(messages, get_conv_revert_cutoff(cid))

    last_model = ""
    for m in reversed(messages):
        if m.get("model"):
            last_model = str(m["model"])
            break

    deliverables: list[dict[str, Any]] = []
    seen_p: set[str] = set()
    allowed_roots = _get_allowed_file_roots()
    for cand in reversed(deliverable_cands):
        try:
            if _has_unsafe_raw_path(cand, allow_absolute=True):
                continue
            p = pathlib.Path(cand).resolve()
            ps = p.as_posix()
            if ps in seen_p or not p.is_file() or not _is_within_allowed_roots(p, allowed_roots) or _is_sensitive_path(p):
                continue
            if ".system_generated" in ps or ".user_uploaded" in ps:
                continue
            seen_p.add(ps)
            deliverables.append({
                "name": p.name,
                "path": ps,
                "size": p.stat().st_size,
                "ext": p.suffix.lower(),
            })
            if len(deliverables) >= 16:
                break
        except Exception:
            continue

    live_pending_ix = get_pending_interactions_for_cid(cid, aliased_cli)
    active_run_snap = None
    with _ACTIVE_RUNS_LOCK:
        ar = _ACTIVE_RUNS.get(cid) or (aliased_cli and _ACTIVE_RUNS.get(aliased_cli)) or None
        if ar and ar.get("running"):
            active_run_snap = {
                "running": True,
                "model": ar.get("model"),
                "tools": list(ar.get("tools") or []),
                "streamText": "".join(ar.get("chunks") or []),
                "startedAt": ar.get("started_at"),
                "pendingInteractions": live_pending_ix,
            }

    out_slice = messages[-120:] if _apply_revert_filter else messages
    out_msgs = out_slice if _keep_internal_src else [{k: v for k, v in m.items() if k != "_src"} for m in out_slice]

    detail_out: dict[str, Any] = {
        "id": cid,
        "title": title or f"对话 {cid[:8]}",
        "source": source,
        "model": last_model or load_or_create_config().get("default_model", "gemini-4-neon-medium"),
        "status": "running" if active_run_snap else "idle",
        "messages": out_msgs,
        "deliverables": deliverables,
        "activeRun": active_run_snap,
        "pendingInteractions": live_pending_ix,
    }
    if _include_parent or _include_cli_alias:
        detail_out["queue"] = get_conv_queue_snapshot(cid)
        detail_out["context_window"] = compute_conversation_context_window(cid)
        detail_out["swarm_summary"] = load_conversation_swarm_summary(cid)
    return detail_out


def _format_bridge_msg_line(m: dict[str, Any], max_chars: int = 1600) -> str:
    role = "用户" if m.get("role") == "user" else "助手"
    parts: list[str] = []
    txt = str(m.get("text") or "").strip()
    if txt:
        parts.append(txt)
    for ix in (m.get("interactions") or []):
        if isinstance(ix, dict) and ix.get("kind") == "ask_question":
            qs = ix.get("questions") or []
            ans_list = ix.get("answers") or []
            for qi, q in enumerate(qs):
                qt = str((q or {}).get("question") or "").strip()
                ans = str(ans_list[qi] if qi < len(ans_list) else "").strip()
                if qt:
                    parts.append(f"[询问选项] {qt}" + (f" -> [已选] {ans}" if ans else ""))
    joined = "\n".join(parts).strip()
    if not joined:
        return ""
    if len(joined) > max_chars:
        joined = joined[: max_chars - 1] + "…"
    return f"[{role}] {joined}"


def _build_desktop_initial_bridge(desktop_cid: str) -> tuple[str, str]:
    """Build initial Desktop->CLI context bridge from pure Desktop-only turns and return (text, latest_iso)."""
    detail = load_conversation_detail(desktop_cid, _include_parent=False, _include_cli_alias=False)
    msgs = detail.get("messages") or []
    if not msgs:
        return "", ""
    recent = [m for m in msgs if str(m.get("text") or "").strip() or (m.get("interactions") or [])][-6:]
    if not recent:
        return "", ""
    latest_iso = ""
    latest_ts = 0.0
    for m in recent:
        mt = str(m.get("time") or "").strip()
        mts = _parse_iso_ts(mt)
        if mt and mts >= latest_ts:
            latest_ts = mts
            latest_iso = mt
    title = str(detail.get("title") or desktop_cid[:8])
    header = f"【衔接电脑桌面端 Antigravity 原会话（标题：{title}，ID：{desktop_cid[:8]}）】"
    budget = max(200, 5500 - len(header) - 2)
    body_lines: list[str] = []
    used = 0
    for m in reversed(recent):
        line = _format_bridge_msg_line(m, 1600)
        if not line:
            continue
        add_len = len(line) + (1 if body_lines else 0)
        if used + add_len > budget:
            if not body_lines:
                body_lines.append(line[: max(80, budget - 1)] + "…")
            break
        body_lines.append(line)
        used += add_len
    body_lines.reverse()
    return f"{header}\n" + "\n".join(body_lines), latest_iso


def _extract_desktop_bridge_context(desktop_cid: str) -> str:
    ctx, _ = _build_desktop_initial_bridge(desktop_cid)
    return ctx


def _extract_desktop_delta_context(
    desktop_cid: str,
    watermark_iso: str = "",
    max_turns: int = 8,
    max_msg_chars: int = 1400,
    max_total_chars: int = 5000,
) -> tuple[str, str]:
    """Extract pure Desktop-only turns strictly newer than `watermark_iso` for incremental CLI sync.

    Returns `(formatted_delta_block, latest_desktop_iso_time)` or `("", "")` if no newer turns exist.
    """
    detail = load_conversation_detail(desktop_cid, _include_parent=False, _include_cli_alias=False)
    msgs = detail.get("messages") or []
    if not msgs:
        return "", ""

    wm_ts = _parse_iso_ts(watermark_iso)
    delta_msgs: list[dict[str, Any]] = []
    for m in msgs:
        has_content = bool(str(m.get("text") or "").strip() or (m.get("interactions") or []))
        if not has_content:
            continue
        m_time = str(m.get("time") or "").strip()
        m_ts = _parse_iso_ts(m_time)
        if wm_ts > 0.0 and m_ts <= wm_ts:
            continue
        delta_msgs.append(m)

    if not delta_msgs:
        return "", ""

    selected = delta_msgs[-max_turns:]
    latest_iso = ""
    latest_ts = 0.0
    for m in selected:
        mt = str(m.get("time") or "").strip()
        mts = _parse_iso_ts(mt)
        if mt and mts >= latest_ts:
            latest_ts = mts
            latest_iso = mt

    title = str(detail.get("title") or desktop_cid[:8])
    header = f"【同步电脑桌面端最新增量对话（标题：{title}，ID：{desktop_cid[:8]}）】"
    footer = "【同步结束，请直接回复用户的最新指令】"
    budget = max(200, max_total_chars - len(header) - len(footer) - 4)
    body_lines: list[str] = []
    used = 0
    for m in reversed(selected):
        line = _format_bridge_msg_line(m, max_msg_chars)
        if not line:
            continue
        add_len = len(line) + (1 if body_lines else 0)
        if used + add_len > budget:
            if not body_lines:
                body_lines.append(line[: max(80, budget - 1)] + "…")
            break
        body_lines.append(line)
        used += add_len
    body_lines.reverse()
    block = f"{header}\n" + "\n".join(body_lines) + f"\n{footer}"
    return block, latest_iso


def _broadcast_ws(payload: dict[str, Any]) -> None:
    if _LOOP is None or not _WS_CLIENTS:
        return
    raw = json.dumps(payload, ensure_ascii=False)

    async def _send_all() -> None:
        dead: list[web.WebSocketResponse] = []
        for ws in list(_WS_CLIENTS):
            if ws.closed:
                dead.append(ws)
                continue
            try:
                await ws.send_str(raw)
            except Exception:
                dead.append(ws)
        for d in dead:
            _WS_CLIENTS.discard(d)

    try:
        asyncio.run_coroutine_threadsafe(_send_all(), _LOOP)
    except Exception:
        pass


def _resolve_queue_canonical_cid(cid: str) -> tuple[str, str]:
    """Resolve (canonical_cid, aliased_cid) across desktop_to_cli_alias and pending-<run_id>."""
    c = str(cid or "").strip()
    if not c or c == "__new__":
        return "", ""
    if c.startswith("pending-"):
        with _ACTIVE_RUNS_LOCK:
            rec = _ACTIVE_RUNS.get(c)
            if rec:
                real = str(rec.get("display_cid") or rec.get("cid") or "").strip()
                if real and not real.startswith("pending-"):
                    c = real
    parent_desk = get_desktop_parent_for_cli(c)
    if parent_desk and parent_desk != c:
        return parent_desk, c
    cli_alias = get_desktop_cli_alias(c)
    if cli_alias and cli_alias != c:
        return c, cli_alias
    return c, ""


def _get_cid_alias_candidates(cid: str) -> tuple[str, str, list[str]]:
    canon, alias = _resolve_queue_canonical_cid(cid)
    cands: list[str] = []
    for k in (cid, canon, alias):
        if k and k not in cands:
            cands.append(k)
    return canon, alias, cands


def _find_active_run(cid: str) -> dict[str, Any] | None:
    if not cid or cid == "__new__":
        return None
    _, _, cands = _get_cid_alias_candidates(cid)
    with _ACTIVE_RUNS_LOCK:
        for k in cands:
            rec = _ACTIVE_RUNS.get(k)
            if rec and rec.get("running"):
                return rec
    return None


def _clone_queue_item(item: dict[str, Any]) -> dict[str, Any]:
    pm = str(item.get("permission_mode") or "").strip().lower()
    return {
        "id": str(item.get("id") or ""),
        "prompt": str(item.get("prompt") or ""),
        "model": str(item.get("model") or ""),
        "attachments": list(item.get("attachments") or []),
        "swarm_mode": bool(item.get("swarm_mode", False)),
        "priority": "urgent" if str(item.get("priority") or "") == "urgent" else "normal",
        "permission_mode": pm if pm in _VALID_PERMISSION_MODES else "",
        "created_at": str(item.get("created_at") or ""),
    }


def _consolidate_queue_unlocked(canon: str, cands: list[str]) -> list[dict[str, Any]]:
    """Merge any queue entries stored under alternate keys (pending-*/cli alias) into `canon`."""
    if not canon:
        return []
    target = _CONV_QUEUES.get(canon)
    seen_ids = {str(it.get("id") or "") for it in (target or [])}
    for k in cands:
        if not k or k == canon:
            continue
        other = _CONV_QUEUES.pop(k, None)
        if not other:
            continue
        if target is None:
            target = []
            _CONV_QUEUES[canon] = target
        for it in other:
            it_id = str(it.get("id") or "")
            if it_id and it_id in seen_ids:
                continue
            if len(target) >= _CONV_QUEUE_MAX:
                break
            target.append(it)
            if it_id:
                seen_ids.add(it_id)
    if target is not None and not target:
        _CONV_QUEUES.pop(canon, None)
        return []
    return target if target is not None else []


def _migrate_conv_queue(old_cid: str, new_cid: str) -> list[dict[str, Any]] | None:
    """Move queued items from `old_cid` (e.g. pending-<run_id> or CLI alias) to `new_cid`."""
    o = str(old_cid or "").strip()
    n = str(new_cid or "").strip()
    if not o or not n or o == n:
        return None
    canon, _ = _resolve_queue_canonical_cid(n)
    dest = canon or n
    if dest == o:
        return None
    migrated = False
    snap: list[dict[str, Any]] = []
    with _CONV_QUEUES_LOCK:
        old_items = _CONV_QUEUES.pop(o, None)
        if old_items:
            migrated = True
            dst_list = _CONV_QUEUES.setdefault(dest, [])
            seen_ids = {str(it.get("id") or "") for it in dst_list}
            for it in old_items:
                it_id = str(it.get("id") or "")
                if it_id and it_id in seen_ids:
                    continue
                if len(dst_list) >= _CONV_QUEUE_MAX:
                    break
                dst_list.append(it)
                if it_id:
                    seen_ids.add(it_id)
            snap = [_clone_queue_item(it) for it in dst_list]
    if migrated:
        _broadcast_queue_updated(dest, snap)
        return snap
    return None


def get_conv_queue_snapshot(cid: str) -> list[dict[str, Any]]:
    c = str(cid or "").strip()
    if not c or c == "__new__":
        return []
    canon, _, cands = _get_cid_alias_candidates(c)
    if not canon:
        return []
    with _CONV_QUEUES_LOCK:
        items = _consolidate_queue_unlocked(canon, cands)
        return [_clone_queue_item(it) for it in items]


def _broadcast_queue_updated(cid: str, queue_snap: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    canon, alias = _resolve_queue_canonical_cid(cid)
    target_cid = canon or str(cid or "").strip()
    snap = queue_snap if queue_snap is not None else get_conv_queue_snapshot(target_cid)
    payload: dict[str, Any] = {
        "type": "queue_updated",
        "conversation_id": target_cid,
        "queue": snap,
    }
    if alias and alias != target_cid:
        payload["aliased_cid"] = alias
    _broadcast_ws(payload)
    return snap


def _serialize_interaction(rec: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(rec.get("id") or ""),
        "kind": str(rec.get("kind") or "permission"),
        "run_id": str(rec.get("run_id") or ""),
        "conversation_id": str(rec.get("conversation_id") or ""),
        "live": bool(rec.get("live", True)),
        "status": str(rec.get("status") or "pending"),
        "created_at": str(rec.get("created_at") or ""),
        "tool_name": str(rec.get("tool_name") or ""),
        "tool_kind": str(rec.get("tool_kind") or "other"),
        "title": str(rec.get("title") or ""),
        "command": str(rec.get("command") or ""),
        "description": str(rec.get("description") or ""),
        "options": [dict(o) for o in (rec.get("options") or []) if isinstance(o, dict)],
        "questions": [dict(q) for q in (rec.get("questions") or []) if isinstance(q, dict)],
        "decision": str(rec.get("decision") or ""),
        "option_id": str(rec.get("option_id") or ""),
        "answered_at": str(rec.get("answered_at") or ""),
    }


def get_pending_interactions_for_cid(cid: str, aliased_cli: str = "") -> list[dict[str, Any]]:
    targets = {k for k in (str(cid or "").strip(), str(aliased_cli or "").strip()) if k}
    if not targets:
        return []
    canon, alias, extra = _get_cid_alias_candidates(next(iter(targets)))
    targets.update(k for k in (canon, alias, *extra) if k)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    with _PENDING_INTERACTIONS_LOCK:
        for rec in _PENDING_INTERACTIONS.values():
            if rec.get("status") != "pending":
                continue
            r_cids = {str(rec.get("conversation_id") or ""), str(rec.get("cli_cid") or ""), str(rec.get("desktop_cid") or "")}
            if not (targets & r_cids):
                continue
            ix_id = str(rec.get("id") or "")
            if ix_id and ix_id not in seen:
                seen.add(ix_id)
                out.append(_serialize_interaction(rec))
    out.sort(key=lambda x: str(x.get("created_at") or ""))
    return out


def _get_waiting_interaction_cids() -> set[str]:
    out: set[str] = set()
    with _PENDING_INTERACTIONS_LOCK:
        for rec in _PENDING_INTERACTIONS.values():
            if rec.get("status") != "pending":
                continue
            for k in (rec.get("conversation_id"), rec.get("cli_cid"), rec.get("desktop_cid")):
                s = str(k or "").strip()
                if s:
                    out.add(s)
    return out


def _cancel_pending_interactions_for_run(run_id: str, reason: str = "cancelled") -> None:
    if not run_id:
        return
    resolved_payloads: list[dict[str, Any]] = []
    with _PENDING_INTERACTIONS_LOCK:
        for ix_id, rec in list(_PENDING_INTERACTIONS.items()):
            if str(rec.get("run_id") or "") != run_id:
                continue
            if rec.get("status") == "pending":
                rec["status"] = "cancelled"
                rec["decision"] = reason
                rec["answered_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                rec["_resolution"] = {"cancelled": True, "reason": reason}
                evt = rec.get("_event")
                if isinstance(evt, threading.Event):
                    evt.set()
                resolved_payloads.append({
                    "type": "run_interaction_resolved",
                    "conversation_id": str(rec.get("conversation_id") or ""),
                    "run_id": run_id,
                    "interaction_id": ix_id,
                    "kind": str(rec.get("kind") or "permission"),
                    "status": "cancelled",
                    "decision": reason,
                    "option_id": "",
                })
            _PENDING_INTERACTIONS.pop(ix_id, None)
    for pl in resolved_payloads:
        _broadcast_ws(pl)


def _terminate_proc_safely(proc: subprocess.Popen[Any] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except Exception:
        pass
    if os.name != "nt":
        def _kill_if_stuck(p: subprocess.Popen[Any]) -> None:
            try:
                p.wait(timeout=3.0)
            except Exception:
                try:
                    if p.poll() is None:
                        p.kill()
                except Exception:
                    pass
        threading.Thread(target=_kill_if_stuck, args=(proc,), daemon=True).start()


def _validate_chat_attachments(attachments: list[Any] | None) -> tuple[list[pathlib.Path] | None, str]:
    att_roots: tuple[pathlib.Path, ...] = tuple(r.resolve() for r in (UPLOAD_DIR, WORKSPACE_ROOT))
    valid_att_paths: list[pathlib.Path] = []
    for raw_a in (attachments or []):
        s_a = str(raw_a or "").strip()
        if not s_a:
            continue
        if _has_unsafe_raw_path(s_a, allow_absolute=True):
            return None, "附件路径格式无效"
        try:
            ap = pathlib.Path(s_a).resolve()
        except Exception:
            return None, "附件路径解析失败"
        if not ap.is_file() or not _is_within_allowed_roots(ap, att_roots) or _is_sensitive_path(ap):
            return None, "附件不存在或超出允许目录范围"
        valid_att_paths.append(ap)
    return valid_att_paths, ""


def _build_queue_item(
    prompt: str,
    model: str,
    attachments: list[str],
    swarm_mode: bool = False,
    priority: str = "normal",
    permission_mode: str = "",
) -> dict[str, Any]:
    pm = str(permission_mode or "").strip().lower()
    return {
        "id": f"q_{secrets.token_hex(5)}",
        "prompt": str(prompt or "").strip(),
        "model": str(model or "").strip(),
        "attachments": list(attachments),
        "swarm_mode": bool(swarm_mode),
        "priority": "urgent" if priority == "urgent" else "normal",
        "permission_mode": pm if pm in _VALID_PERMISSION_MODES else "",
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _drain_next_queued_run(cid: str) -> dict[str, Any] | None:
    """Atomically pop queue[0] for `cid` when idle and launch the next CLI chat run."""
    canon, _, cands = _get_cid_alias_candidates(cid)
    if not canon:
        return None
    with _CONV_QUEUES_LOCK:
        if canon in _DRAINING_CIDS:
            return None
        _DRAINING_CIDS.add(canon)
    try:
        if _find_active_run(canon) is not None:
            return None
        with _CONV_QUEUES_LOCK:
            q = _consolidate_queue_unlocked(canon, cands)
            if not q:
                return None
            item = q.pop(0)
            if not q:
                _CONV_QUEUES.pop(canon, None)
            snap = [_clone_queue_item(x) for x in q]
        _broadcast_queue_updated(canon, snap)
        res = start_cli_chat_run(
            canon,
            str(item.get("prompt") or ""),
            str(item.get("model") or ""),
            list(item.get("attachments") or []),
            bool(item.get("swarm_mode", False)),
            permission_mode=str(item.get("permission_mode") or "") or None,
        )
        if not res.get("ok"):
            # Re-insert at index 0 so the user's queued message is never silently lost
            with _CONV_QUEUES_LOCK:
                q_re = _CONV_QUEUES.setdefault(canon, [])
                if len(q_re) < _CONV_QUEUE_MAX:
                    q_re.insert(0, item)
                re_snap = [_clone_queue_item(x) for x in q_re]
            _broadcast_queue_updated(canon, re_snap)
            err_clean = _sanitize_error_text(str(res.get("error") or "队列任务启动失败"))
            err_cat = _classify_run_error(err_clean)
            _broadcast_ws({
                "type": "run_error",
                "conversation_id": canon,
                "run_id": "",
                "error": err_clean,
                "error_category": err_cat,
                "prompt": str(item.get("prompt") or ""),
                "attachments": list(item.get("attachments") or []),
                "model": str(item.get("model") or ""),
                "swarm_mode": bool(item.get("swarm_mode", False)),
            })
        return res
    finally:
        with _CONV_QUEUES_LOCK:
            _DRAINING_CIDS.discard(canon)


_ACP_MODEL_ALIASES: dict[str, str] = {
    "gemini-pro-orchestrator-g1-pro": "gemini-pro-orchestrator",
    "claude-opus-5-5-thinking": "claude-opus-5-5-high",
    "claude-sonnet-5-5-thinking": "claude-sonnet-5-5-high",
}


def _resolve_acp_model_id(requested_model: str, available_ids: set[str]) -> str:
    req = str(requested_model or "").strip()
    if not req:
        return "gemini-4-neon-medium"
    if not available_ids or req in available_ids:
        return req
    mapped = _ACP_MODEL_ALIASES.get(req)
    if mapped and mapped in available_ids:
        return mapped
    return req


def _extract_acp_perm_details(tc: dict[str, Any], params: dict[str, Any]) -> tuple[str, str, str, str, str]:
    tname = str(tc.get("name") or params.get("toolName") or "").strip() or "tool"
    tkind = str(tc.get("kind") or "other").strip().lower() or "other"
    title = str(tc.get("title") or tname).strip()
    raw_args = tc.get("args") if isinstance(tc.get("args"), dict) else (tc.get("rawInput") if isinstance(tc.get("rawInput"), dict) else {})
    cmd_preview = ""
    for k in ("CommandLine", "command", "Path", "TargetFile", "path", "Url", "query", "SearchPath", "PackageName"):
        v = raw_args.get(k)
        if v:
            cmd_preview = str(v).strip()
            break
    if not cmd_preview and title and title != tname:
        cmd_preview = title
    desc = str(raw_args.get("toolSummary") or raw_args.get("Description") or "").strip()
    content_items = tc.get("content") if isinstance(tc.get("content"), list) else []
    for ci in content_items:
        if isinstance(ci, dict) and ci.get("type") == "diff" and ci.get("path"):
            diff_hdr = str(ci.get("path") or "").strip()
            if not cmd_preview:
                cmd_preview = diff_hdr
            if not desc:
                desc = f"Diff: {diff_hdr}"
            break
    return tname, tkind, title[:160], cmd_preview[:1500], desc[:400]


def _start_acp_chat_run(
    agy_bin: str,
    eff_model: str,
    eff_perm_mode: str,
    prompt: str,
    full_prompt: str,
    att_metas: list[dict[str, Any]],
    resume_cli_cid: str,
    source_desktop_cid: str,
    pending_watermark: str,
    is_new: bool,
    swarm_mode: bool,
) -> dict[str, Any] | None:
    """Launch a live interactive ACP session supporting real-time tool permissions and ask_question turns.

    Returns result dict on successful handshake+dispatch, or None if ACP init/resume fails (caller falls back to -p).
    """
    import queue as _q

    acp_cmd = [agy_bin, "acp"]
    if eff_perm_mode == "bypass":
        acp_cmd.append("--dangerously-skip-permissions")
    elif eff_perm_mode == "ask":
        acp_cmd.extend(["--cli_dir_name", _ensure_mobile_ask_profile()])

    try:
        proc = subprocess.Popen(
            acp_cmd,
            cwd=str(WORKSPACE_ROOT),
            env=_build_cli_env(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=_NO_WINDOW,
        )
    except Exception:
        return None

    write_lock = threading.Lock()
    rpc_lock = threading.Lock()
    rpc_seq = 0
    rpc_pending: dict[int, _q.Queue[dict[str, Any]]] = {}
    run_id = uuid.uuid4().hex[:10]
    pending_key = f"pending-{run_id}"
    canonical_disp = source_desktop_cid or resume_cli_cid
    stderr_lines: collections.deque[str] = collections.deque(maxlen=40)
    tool_idx_by_id: dict[str, int] = {}

    run_rec: dict[str, Any] = {
        "run_id": run_id,
        "cid": resume_cli_cid,
        "display_cid": canonical_disp,
        "proc": proc,
        "prompt": prompt,
        "attachments": att_metas,
        "model": eff_model,
        "permission_mode": eff_perm_mode,
        "swarm_mode": bool(swarm_mode),
        "tools": [],
        "chunks": [],
        "running": True,
        "canceled": False,
        "cancel_reason": "",
        "started_at": time.time(),
        "stderr": "",
        "ended_with_question": False,
        "acp": True,
    }

    def _acp_send_raw(payload: dict[str, Any]) -> bool:
        if proc.poll() is not None or proc.stdin is None:
            return False
        raw_ln = json.dumps(payload, ensure_ascii=False) + "\n"
        try:
            with write_lock:
                proc.stdin.write(raw_ln)
                proc.stdin.flush()
            return True
        except Exception:
            return False

    def _acp_rpc(method: str, params: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
        nonlocal rpc_seq
        with rpc_lock:
            rpc_seq += 1
            rid = rpc_seq
            q: _q.Queue[dict[str, Any]] = _q.Queue(maxsize=4)
            rpc_pending[rid] = q
        try:
            if not _acp_send_raw({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}):
                return {"error": {"code": -32000, "message": "failed to write ACP stdin"}}
            try:
                return q.get(timeout=timeout)
            except _q.Empty:
                return {"error": {"code": -32001, "message": f"ACP timeout after {timeout:.0f}s ({method})"}}
        finally:
            rpc_pending.pop(rid, None)

    def _acp_cancel() -> None:
        _cancel_pending_interactions_for_run(run_id, reason="cancelled")
        sid_cur = str(run_rec.get("cid") or "").strip()
        if sid_cur:
            _acp_send_raw({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": sid_cur}})

    run_rec["acp_cancel"] = _acp_cancel

    def _wait_perm_and_reply(raw_req_id: Any, ix_rec: dict[str, Any]) -> None:
        ix_id = str(ix_rec.get("id") or "")
        evt: threading.Event = ix_rec["_event"]
        timed_out = not evt.wait(timeout=600.0)
        res = ix_rec.get("_resolution") if isinstance(ix_rec.get("_resolution"), dict) else None
        with _PENDING_INTERACTIONS_LOCK:
            _PENDING_INTERACTIONS.pop(ix_id, None)
            if timed_out and ix_rec.get("status") == "pending":
                ix_rec["status"] = "cancelled"
                ix_rec["decision"] = "timeout"
        if timed_out:
            _broadcast_ws({
                "type": "run_interaction_resolved",
                "conversation_id": str(ix_rec.get("conversation_id") or ""),
                "run_id": run_id,
                "interaction_id": ix_id,
                "kind": "permission",
                "status": "cancelled",
                "decision": "timeout",
                "option_id": "",
            })
        if res and not res.get("cancelled") and res.get("option_id"):
            _acp_send_raw({
                "jsonrpc": "2.0",
                "id": raw_req_id,
                "result": {"outcome": {"outcome": "selected", "optionId": str(res["option_id"])}},
            })
        else:
            _acp_send_raw({
                "jsonrpc": "2.0",
                "id": raw_req_id,
                "result": {"outcome": {"outcome": "cancelled"}},
            })

    def _handle_server_request(msg: dict[str, Any]) -> None:
        # IMPORTANT: Preserve exact JSON-RPC `id` type (ACP sends string ids like "1").
        raw_req_id = msg.get("id")
        method = str(msg.get("method") or "")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if "permission" in method.lower():
            tc = params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
            raw_opts = params.get("options") if isinstance(params.get("options"), list) else []
            norm_opts: list[dict[str, str]] = []
            for o in raw_opts:
                if isinstance(o, dict) and o.get("optionId"):
                    norm_opts.append({
                        "option_id": str(o.get("optionId") or ""),
                        "name": str(o.get("name") or o.get("optionId") or ""),
                        "kind": str(o.get("kind") or "allow_once"),
                    })
            if not norm_opts:
                norm_opts = [
                    {"option_id": "allow", "name": "Allow", "kind": "allow_once"},
                    {"option_id": "deny", "name": "Deny", "kind": "reject_once"},
                ]
            tname, tkind, title, cmd_preview, desc = _extract_acp_perm_details(tc, params)
            cur_disp = str(run_rec.get("display_cid") or run_rec.get("cid") or canonical_disp or pending_key)
            ix_id = f"int_{secrets.token_hex(6)}"
            ix_rec: dict[str, Any] = {
                "id": ix_id,
                "kind": "permission",
                "run_id": run_id,
                "conversation_id": cur_disp,
                "cli_cid": str(run_rec.get("cid") or ""),
                "desktop_cid": source_desktop_cid,
                "live": True,
                "status": "pending",
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "tool_name": tname,
                "tool_kind": tkind,
                "title": title,
                "command": cmd_preview,
                "description": desc,
                "options": norm_opts,
                "questions": [],
                "decision": "",
                "option_id": "",
                "answered_at": "",
                "_event": threading.Event(),
                "_resolution": None,
            }
            with _PENDING_INTERACTIONS_LOCK:
                _PENDING_INTERACTIONS[ix_id] = ix_rec
            _broadcast_ws({
                "type": "run_interaction",
                "conversation_id": cur_disp,
                "run_id": run_id,
                "interaction": _serialize_interaction(ix_rec),
            })
            threading.Thread(
                target=_wait_perm_and_reply,
                args=(raw_req_id, ix_rec),
                name=f"acp-perm-{ix_id}",
                daemon=True,
            ).start()
            return
        _acp_send_raw({
            "jsonrpc": "2.0",
            "id": raw_req_id,
            "error": {"code": -32601, "message": f"Unsupported method {method}"},
        })

    def _stderr_reader() -> None:
        try:
            if proc.stderr is not None:
                for ln in proc.stderr:
                    s = ln.strip()
                    if s:
                        stderr_lines.append(s[:300])
        except Exception:
            pass

    def _stdout_reader() -> None:
        try:
            if proc.stdout is None:
                return
            for raw_ln in proc.stdout:
                s_ln = raw_ln.strip()
                if not s_ln:
                    continue
                try:
                    msg = json.loads(s_ln)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                if "method" in msg and "id" in msg:
                    _handle_server_request(msg)
                    continue
                if "id" in msg and msg["id"] is not None:
                    try:
                        rid_i = int(msg["id"])
                    except Exception:
                        rid_i = -1
                    q = rpc_pending.get(rid_i)
                    if q is not None:
                        try:
                            q.put_nowait(msg)
                        except Exception:
                            pass
                    continue
                if msg.get("method") == "session/update":
                    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
                    upd = params.get("update") if isinstance(params.get("update"), dict) else {}
                    ukind = str(upd.get("sessionUpdate") or "")
                    cur_disp = str(run_rec.get("display_cid") or run_rec.get("cid") or canonical_disp or pending_key)
                    if ukind == "agent_message_chunk":
                        content = upd.get("content") if isinstance(upd.get("content"), dict) else {}
                        delta = str(content.get("text") or "")
                        if delta:
                            run_rec["chunks"].append(delta)
                            _broadcast_ws({
                                "type": "run_delta",
                                "conversation_id": cur_disp,
                                "run_id": run_id,
                                "delta": delta,
                            })
                    elif ukind in ("tool_call", "tool_call_update"):
                        tname = str(upd.get("name") or "").strip()
                        raw_st = str(upd.get("status") or "").lower()
                        if raw_st == "completed":
                            tstate = "DONE"
                        elif raw_st in ("failed", "cancelled", "rejected", "error"):
                            tstate = "REJECTED" if raw_st == "rejected" else "DONE"
                        else:
                            tstate = "ACTIVE"
                        targs = upd.get("args") if isinstance(upd.get("args"), dict) else (upd.get("rawInput") if isinstance(upd.get("rawInput"), dict) else {})
                        if tname == "ask_question" and raw_st in ("in_progress", "pending"):
                            run_rec["ended_with_question"] = True
                        target = ""
                        if tname == "ask_question":
                            qs = _parse_ask_question_args(targs)
                            if qs and qs[0].get("question"):
                                target = str(qs[0]["question"]).strip().splitlines()[0][:80]
                        if not target and isinstance(targs, dict):
                            for tk in ("Path", "TargetFile", "CommandLine", "toolSummary", "query", "Url", "path", "Role"):
                                if targs.get(tk):
                                    target = str(targs[tk]).strip().splitlines()[0][:80]
                                    break
                        if not target and upd.get("title"):
                            target = str(upd["title"]).strip().splitlines()[0][:80]
                        if tname:
                            tool_item = {"name": tname, "target": target, "state": tstate}
                            tc_id = str(upd.get("toolCallId") or "").strip()
                            if tc_id and tc_id in tool_idx_by_id:
                                run_rec["tools"][tool_idx_by_id[tc_id]] = tool_item
                            else:
                                if tstate != "ACTIVE" and run_rec["tools"] and run_rec["tools"][-1]["name"] == tname and run_rec["tools"][-1].get("state") == "ACTIVE":
                                    idx_t = len(run_rec["tools"]) - 1
                                    run_rec["tools"][idx_t] = tool_item
                                else:
                                    idx_t = len(run_rec["tools"])
                                    run_rec["tools"].append(tool_item)
                                if tc_id:
                                    tool_idx_by_id[tc_id] = idx_t
                            _broadcast_ws({
                                "type": "run_tool",
                                "conversation_id": cur_disp,
                                "run_id": run_id,
                                "tool": tool_item,
                            })
        except Exception:
            pass
        finally:
            run_rec["stderr"] = "\n".join(stderr_lines)
            for q in list(rpc_pending.values()):
                try:
                    q.put_nowait({"error": {"code": -32000, "message": "ACP process exited unexpectedly"}})
                except Exception:
                    pass

    threading.Thread(target=_stderr_reader, name=f"acp-err-{run_id}", daemon=True).start()
    threading.Thread(target=_stdout_reader, name=f"acp-out-{run_id}", daemon=True).start()

    init_resp = _acp_rpc(
        "initialize",
        {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {"name": "antigravity-mobile", "version": APP_VERSION},
        },
        timeout=25.0,
    )
    if not isinstance(init_resp, dict) or "error" in init_resp:
        _terminate_proc_safely(proc)
        return None

    sess_params = {"cwd": str(WORKSPACE_ROOT), "mcpServers": []}
    if resume_cli_cid:
        sess_resp = _acp_rpc(
            "session/resume",
            {"sessionId": resume_cli_cid, **sess_params},
            timeout=20.0,
        )
    else:
        sess_resp = _acp_rpc("session/new", sess_params, timeout=20.0)

    if not isinstance(sess_resp, dict) or "error" in sess_resp or not isinstance(sess_resp.get("result"), dict):
        _terminate_proc_safely(proc)
        return None

    s_res = sess_resp["result"]
    bound_cid = str(s_res.get("sessionId") or resume_cli_cid).strip()
    if not bound_cid:
        _terminate_proc_safely(proc)
        return None

    disp_cid = source_desktop_cid or bound_cid
    run_rec["cid"] = bound_cid
    run_rec["display_cid"] = disp_cid

    avail_model_ids = {
        str(m.get("modelId") or "").strip()
        for m in ((s_res.get("models") or {}).get("availableModels") or [])
        if isinstance(m, dict) and m.get("modelId")
    }
    acp_model = _resolve_acp_model_id(eff_model, avail_model_ids)
    _acp_rpc("session/set_model", {"sessionId": bound_cid, "modelId": acp_model}, timeout=12.0)

    avail_modes = [
        str(m.get("id") or "").strip()
        for m in ((s_res.get("modes") or {}).get("availableModes") or [])
        if isinstance(m, dict) and m.get("id")
    ]
    target_mode = ""
    if eff_perm_mode == "ask":
        if "default" in avail_modes:
            target_mode = "default"
    else:
        for cand_m in ("auto", "accept-edits", "default"):
            if cand_m in avail_modes:
                target_mode = cand_m
                break
    if target_mode:
        _acp_rpc("session/set_mode", {"sessionId": bound_cid, "modeId": target_mode}, timeout=10.0)

    if source_desktop_cid and source_desktop_cid != bound_cid:
        set_desktop_cli_alias(source_desktop_cid, bound_cid)
        _migrate_conv_queue(bound_cid, source_desktop_cid)
        if pending_watermark:
            set_desktop_bridge_watermark(bound_cid, pending_watermark)
    elif is_new or not source_desktop_cid:
        register_mobile_own_cid(bound_cid)

    with _ACTIVE_RUNS_LOCK:
        _ACTIVE_RUNS[bound_cid] = run_rec
        _ACTIVE_RUNS[disp_cid] = run_rec
    _migrate_conv_queue(pending_key, disp_cid)

    _broadcast_ws({
        "type": "run_init" if is_new else "run_start",
        "conversation_id": disp_cid,
        "run_id": run_id,
        "prompt": prompt,
        "attachments": att_metas,
        "model": eff_model,
    })

    def _acp_prompt_worker() -> None:
        final_resp = ""
        usage: dict[str, Any] = {}
        prompt_err = ""
        try:
            pr = _acp_rpc(
                "session/prompt",
                {"sessionId": bound_cid, "prompt": [{"type": "text", "text": full_prompt}]},
                timeout=1800.0,
            )
            if isinstance(pr, dict) and "error" in pr:
                err_o = pr.get("error") if isinstance(pr.get("error"), dict) else {}
                prompt_err = str(err_o.get("message") or pr["error"] or "ACP execution error")
            elif isinstance(pr, dict) and isinstance(pr.get("result"), dict):
                raw_u = pr["result"].get("usage")
                if isinstance(raw_u, dict):
                    usage = dict(raw_u)
                if str(pr["result"].get("stopReason") or "").lower() == "cancelled" and not run_rec.get("canceled"):
                    run_rec["canceled"] = True
                    run_rec["cancel_reason"] = "user"
        except Exception as exc:
            prompt_err = str(exc)
        finally:
            _cancel_pending_interactions_for_run(run_id, reason="ended")
            if not run_rec.get("canceled") and proc.poll() is None:
                try:
                    _acp_rpc("session/close", {"sessionId": bound_cid}, timeout=4.0)
                except Exception:
                    pass
            _terminate_proc_safely(proc)
            try:
                proc.wait(timeout=3.0)
            except Exception:
                pass
            run_rec["running"] = False
            if not final_resp and run_rec["chunks"]:
                final_resp = _clean_assistant_text("".join(run_rec["chunks"]))
            cid_end = disp_cid or bound_cid or pending_key
            if cid_end != pending_key:
                _migrate_conv_queue(pending_key, cid_end)
            if bound_cid and bound_cid != cid_end:
                _migrate_conv_queue(bound_cid, cid_end)
            with _ACTIVE_RUNS_LOCK:
                for k_rm in (pending_key, cid_end, bound_cid, run_rec.get("display_cid") or "", run_rec.get("cid") or ""):
                    if k_rm and _ACTIVE_RUNS.get(k_rm) is run_rec:
                        _ACTIVE_RUNS.pop(k_rm, None)

            cancel_reason = str(run_rec.get("cancel_reason") or ("user" if run_rec.get("canceled") else ""))
            should_drain = False
            if run_rec.get("canceled"):
                _broadcast_ws({
                    "type": "run_canceled",
                    "conversation_id": cid_end,
                    "run_id": run_id,
                    "reason": cancel_reason or "user",
                })
                if cancel_reason == "interrupt":
                    should_drain = True
            elif (prompt_err or (proc.returncode not in (0, None))) and not final_resp and not run_rec.get("ended_with_question"):
                err_src = prompt_err or "\n".join(stderr_lines) or f"exit code {proc.returncode}"
                err_clean = _sanitize_error_text(err_src)
                err_cat = _classify_run_error(err_clean)
                _broadcast_ws({
                    "type": "run_error",
                    "conversation_id": cid_end,
                    "run_id": run_id,
                    "error": err_clean,
                    "error_category": err_cat,
                    "prompt": str(run_rec.get("prompt") or ""),
                    "attachments": [
                        str(a.get("path") or "")
                        for a in (run_rec.get("attachments") or [])
                        if isinstance(a, dict) and a.get("path")
                    ],
                    "model": eff_model,
                    "swarm_mode": bool(run_rec.get("swarm_mode", False)),
                })
                should_drain = err_cat not in ("quota", "rate_limit", "auth")
            else:
                cw = compute_conversation_context_window(cid_end)
                _broadcast_ws({
                    "type": "run_done",
                    "conversation_id": cid_end,
                    "run_id": run_id,
                    "response": final_resp,
                    "tools": run_rec["tools"],
                    "usage": usage,
                    "model": eff_model,
                    "context_window": cw,
                    "has_pending_question": bool(run_rec.get("ended_with_question")),
                })
                should_drain = True

            if should_drain and get_conv_queue_snapshot(cid_end):
                threading.Thread(
                    target=_drain_next_queued_run,
                    args=(cid_end,),
                    name=f"queue-drain-{cid_end[:8]}",
                    daemon=True,
                ).start()

    threading.Thread(target=_acp_prompt_worker, name=f"acp-turn-{run_id}", daemon=True).start()
    return {
        "ok": True,
        "conversation_id": disp_cid,
        "run_id": run_id,
        "created_new": bool(is_new),
        "model": eff_model,
        "permission_mode": eff_perm_mode,
    }


def start_cli_chat_run(
    requested_cid: str,
    prompt: str,
    model: str,
    attachments: list[str] | None = None,
    swarm_mode: bool = False,
    permission_mode: str | None = None,
) -> dict[str, Any]:
    global _PENDING_SPAWNS
    agy_bin = _find_agy_bin()
    if not agy_bin:
        return {"ok": False, "error": "未找到官方 agy CLI（请安装 Antigravity CLI 或设置环境变量 AGY_CLI_BIN）"}

    req_cid = str(requested_cid or "").strip()
    is_new = (not req_cid) or req_cid == "__new__" or req_cid.startswith("pending-")
    if not is_new and not _is_valid_cid(req_cid):
        return {"ok": False, "error": "无效的会话 ID"}

    eff_model = str(model or "").strip() or str(load_or_create_config().get("default_model") or "gemini-4-neon-medium").strip()
    if not _is_valid_model_id(eff_model):
        return {"ok": False, "error": "无效的模型名称"}
    raw_pm = str(permission_mode or "").strip().lower()
    eff_perm_mode = raw_pm if raw_pm in _VALID_PERMISSION_MODES else get_permission_mode()

    # Validate attachments strictly against UPLOAD_DIR / WORKSPACE_ROOT before building prompt
    valid_att_paths, att_err = _validate_chat_attachments(attachments)
    if valid_att_paths is None:
        return {"ok": False, "error": att_err}

    resume_cli_cid = ""
    source_desktop_cid = ""
    desktop_ctx = ""
    delta_ctx = ""
    pending_watermark = ""

    if not is_new:
        if (CLI_CONV / f"{req_cid}.db").is_file():
            resume_cli_cid = req_cid
            parent_d = get_desktop_parent_for_cli(req_cid)
            if parent_d:
                source_desktop_cid = parent_d
        else:
            aliased = get_desktop_cli_alias(req_cid)
            if aliased and _is_valid_cid(aliased) and (CLI_CONV / f"{aliased}.db").is_file():
                resume_cli_cid = aliased
                source_desktop_cid = req_cid
            elif (DESKTOP_BRAIN / req_cid / ".system_generated" / "logs" / "transcript.jsonl").is_file():
                source_desktop_cid = req_cid
                desktop_ctx, pending_watermark = _build_desktop_initial_bridge(req_cid)

    # Incremental Desktop->CLI Delta Context Bridge on EVERY resumed CLI run linked to a Desktop parent
    if resume_cli_cid and source_desktop_cid and not desktop_ctx:
        wm_iso = get_desktop_bridge_watermark(resume_cli_cid)
        if not wm_iso:
            wm_iso = _get_cli_first_step_time(resume_cli_cid)
        delta_ctx, pending_watermark = _extract_desktop_delta_context(source_desktop_cid, wm_iso)

    parts: list[str] = []
    if desktop_ctx:
        parts.append(desktop_ctx)
        parts.append("【用户在 Antigravity Mobile 手机端针对以上会话的最新指令】")
    elif delta_ctx:
        parts.append(delta_ctx)
    if valid_att_paths:
        att_txt = "\n".join(f"- {ap.as_posix()}" for ap in valid_att_paths)
        if att_txt:
            parts.append(f"【用户从手机上传的无损原始文件/原图（未经压缩，请直接调用 read_file 查看原文件）】\n{att_txt}")
    clean_p = prompt.strip()
    if clean_p:
        parts.append(clean_p)
    full_prompt = "\n\n".join(parts).strip()
    if not full_prompt:
        return {"ok": False, "error": "消息内容不能为空"}
    if swarm_mode and not full_prompt.startswith("/swarm"):
        full_prompt = "/swarm " + full_prompt
    if len(full_prompt) > 24000:
        full_prompt = full_prompt[-24000:]

    att_metas_acp: list[dict[str, Any]] = []
    for ap in valid_att_paths:
        ext = ap.suffix.lower()
        is_img = ext in _IMAGE_EXTS
        norm_p = ap.as_posix()
        att_metas_acp.append({
            "name": ap.name,
            "path": norm_p,
            "is_image": is_img,
            "preview_url": f"/api/files/preview?path={urllib.parse.quote(norm_p)}",
        })

    # For standard interactive chat (non-swarm), prefer live ACP driver (real permissions & ask_question)
    if not swarm_mode:
        with _ACTIVE_RUNS_LOCK:
            active_cnt = len({id(v) for v in _ACTIVE_RUNS.values() if v.get("running")}) + _PENDING_SPAWNS
            if active_cnt >= _MAX_CONCURRENT_RUNS:
                return {"ok": False, "error": f"当前并发任务数已达上限（{_MAX_CONCURRENT_RUNS}），请等待任务完成或停止后再试"}
            _PENDING_SPAWNS += 1
        try:
            acp_res = _start_acp_chat_run(
                agy_bin=agy_bin,
                eff_model=eff_model,
                eff_perm_mode=eff_perm_mode,
                prompt=prompt,
                full_prompt=full_prompt,
                att_metas=att_metas_acp,
                resume_cli_cid=resume_cli_cid,
                source_desktop_cid=source_desktop_cid,
                pending_watermark=pending_watermark,
                is_new=is_new,
                swarm_mode=swarm_mode,
            )
            if acp_res is not None:
                return acp_res
        finally:
            with _ACTIVE_RUNS_LOCK:
                _PENDING_SPAWNS = max(0, _PENDING_SPAWNS - 1)

    cmd = [
        agy_bin,
        "-p", full_prompt,
        "--model", eff_model,
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
    ]
    if resume_cli_cid:
        cmd.extend(["--conversation", resume_cli_cid])

    with _ACTIVE_RUNS_LOCK:
        active_cnt = len({id(v) for v in _ACTIVE_RUNS.values() if v.get("running")}) + _PENDING_SPAWNS
        if active_cnt >= _MAX_CONCURRENT_RUNS:
            return {"ok": False, "error": f"当前并发任务数已达上限（{_MAX_CONCURRENT_RUNS}），请等待任务完成或停止后再试"}
        _PENDING_SPAWNS += 1

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(WORKSPACE_ROOT),
            env=_build_cli_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_NO_WINDOW,
        )
    except Exception as exc:
        with _ACTIVE_RUNS_LOCK:
            _PENDING_SPAWNS = max(0, _PENDING_SPAWNS - 1)
        return {"ok": False, "error": f"启动 agy CLI 失败: {exc}"}

    watermark_saved = False
    if resume_cli_cid and pending_watermark:
        set_desktop_bridge_watermark(resume_cli_cid, pending_watermark)
        watermark_saved = True

    run_id = uuid.uuid4().hex[:10]
    pending_key = f"pending-{run_id}"
    init_evt = threading.Event()
    canonical_disp = source_desktop_cid or resume_cli_cid
    att_metas: list[dict[str, Any]] = []
    for ap in valid_att_paths:
        ext = ap.suffix.lower()
        is_img = ext in _IMAGE_EXTS
        norm_p = ap.as_posix()
        att_metas.append({
            "name": ap.name,
            "path": norm_p,
            "is_image": is_img,
            "preview_url": f"/api/files/preview?path={urllib.parse.quote(norm_p)}",
        })
    run_rec: dict[str, Any] = {
        "run_id": run_id,
        "cid": resume_cli_cid,
        "display_cid": canonical_disp,
        "proc": proc,
        "prompt": prompt,
        "attachments": att_metas,
        "model": eff_model,
        "swarm_mode": bool(swarm_mode),
        "tools": [],
        "chunks": [],
        "running": True,
        "canceled": False,
        "cancel_reason": "",
        "started_at": time.time(),
        "stderr": "",
    }
    with _ACTIVE_RUNS_LOCK:
        _PENDING_SPAWNS = max(0, _PENDING_SPAWNS - 1)
        _ACTIVE_RUNS[pending_key] = run_rec
        if resume_cli_cid:
            _ACTIVE_RUNS[resume_cli_cid] = run_rec
        if canonical_disp:
            _ACTIVE_RUNS[canonical_disp] = run_rec
    if canonical_disp:
        _broadcast_ws({
            "type": "run_start",
            "conversation_id": canonical_disp,
            "run_id": run_id,
            "prompt": prompt,
            "attachments": att_metas,
            "model": eff_model,
        })

    def _drain_stderr() -> None:
        try:
            if proc.stderr is not None:
                run_rec["stderr"] = proc.stderr.read()
        except Exception:
            pass

    def _stream_worker() -> None:
        t_err = threading.Thread(target=_drain_stderr, daemon=True)
        t_err.start()
        bound_cid = resume_cli_cid
        disp_cid = source_desktop_cid or resume_cli_cid
        wm_persisted = watermark_saved
        final_resp = ""
        usage: dict[str, Any] = {}

        def _persist_binding(cli_id: str) -> None:
            nonlocal wm_persisted
            if not cli_id:
                return
            if source_desktop_cid and source_desktop_cid != cli_id:
                set_desktop_cli_alias(source_desktop_cid, cli_id)
                _migrate_conv_queue(cli_id, source_desktop_cid)
                if pending_watermark and not wm_persisted:
                    set_desktop_bridge_watermark(cli_id, pending_watermark)
                    wm_persisted = True
            elif is_new or not source_desktop_cid:
                register_mobile_own_cid(cli_id)

        try:
            if proc.stdout is not None:
                for raw_ln in proc.stdout:
                    s_ln = raw_ln.strip()
                    if not s_ln:
                        continue
                    try:
                        ev = json.loads(s_ln)
                    except Exception:
                        continue
                    if not isinstance(ev, dict):
                        continue
                    ev_t = str(ev.get("event") or "")
                    if ev_t == "init":
                        cid_i = str(ev.get("conversation_id") or "").strip()
                        if cid_i:
                            bound_cid = cid_i
                            disp_cid = source_desktop_cid or cid_i
                            run_rec["cid"] = cid_i
                            run_rec["display_cid"] = disp_cid
                            with _ACTIVE_RUNS_LOCK:
                                _ACTIVE_RUNS[cid_i] = run_rec
                                _ACTIVE_RUNS[disp_cid] = run_rec
                            _persist_binding(cid_i)
                            _migrate_conv_queue(pending_key, disp_cid)
                            _broadcast_ws({
                                "type": "run_init",
                                "conversation_id": disp_cid,
                                "run_id": run_id,
                                "prompt": prompt,
                                "attachments": att_metas,
                                "model": eff_model,
                            })
                            init_evt.set()
                    elif ev_t == "step_update":
                        su = ev.get("step_update") if isinstance(ev.get("step_update"), dict) else {}
                        if not bound_cid and su.get("conversation_id"):
                            bound_cid = str(su["conversation_id"]).strip()
                            disp_cid = source_desktop_cid or bound_cid
                            run_rec["cid"] = bound_cid
                            run_rec["display_cid"] = disp_cid
                            with _ACTIVE_RUNS_LOCK:
                                _ACTIVE_RUNS[bound_cid] = run_rec
                                _ACTIVE_RUNS[disp_cid] = run_rec
                            _persist_binding(bound_cid)
                            _migrate_conv_queue(pending_key, disp_cid)
                            init_evt.set()
                        st_type = str(su.get("step_type") or "")
                        if st_type == "tool":
                            tname = str(su.get("tool_name") or (su.get("tool_info") or {}).get("name") or "").strip()
                            tstate = str(su.get("state") or "").upper()
                            tparams = (su.get("tool_info") or {}).get("parameters") or {}
                            target = ""
                            if isinstance(tparams, dict):
                                for tk in ("Path", "TargetFile", "CommandLine", "toolSummary", "query", "path"):
                                    if tparams.get(tk):
                                        target = str(tparams[tk]).strip().splitlines()[0][:80]
                                        break
                            if tname:
                                tool_item = {"name": tname, "target": target, "state": tstate}
                                if tstate == "DONE" and run_rec["tools"] and run_rec["tools"][-1]["name"] == tname:
                                    run_rec["tools"][-1] = tool_item
                                else:
                                    run_rec["tools"].append(tool_item)
                                _broadcast_ws({
                                    "type": "run_tool",
                                    "conversation_id": disp_cid or bound_cid or pending_key,
                                    "run_id": run_id,
                                    "tool": tool_item,
                                })
                        elif st_type == "agent_response":
                            delta = str(su.get("text_delta") or "")
                            if delta:
                                run_rec["chunks"].append(delta)
                                _broadcast_ws({
                                    "type": "run_delta",
                                    "conversation_id": disp_cid or bound_cid or pending_key,
                                    "run_id": run_id,
                                    "delta": delta,
                                })
                    elif ev_t == "result":
                        ro = ev.get("result") if isinstance(ev.get("result"), dict) else {}
                        if ro.get("conversation_id") and not bound_cid:
                            bound_cid = str(ro["conversation_id"]).strip()
                            disp_cid = source_desktop_cid or bound_cid
                            run_rec["cid"] = bound_cid
                            run_rec["display_cid"] = disp_cid
                            _persist_binding(bound_cid)
                            _migrate_conv_queue(pending_key, disp_cid)
                            init_evt.set()
                        final_resp = _clean_assistant_text(str(ro.get("response") or ""))
                        if isinstance(ro.get("usage"), dict):
                            usage = dict(ro["usage"])
            proc.wait(timeout=1800)
            t_err.join(timeout=2.0)
        except Exception as exc:
            run_rec["stderr"] = (run_rec.get("stderr") or "") + f"\n{exc}"
        finally:
            run_rec["running"] = False
            if not final_resp and run_rec["chunks"]:
                final_resp = _clean_assistant_text("".join(run_rec["chunks"]))
            cid_end = disp_cid or bound_cid or run_rec.get("display_cid") or run_rec.get("cid") or pending_key
            if cid_end != pending_key:
                _migrate_conv_queue(pending_key, cid_end)
            if bound_cid and bound_cid != cid_end:
                _migrate_conv_queue(bound_cid, cid_end)
            with _ACTIVE_RUNS_LOCK:
                for k_rm in (pending_key, cid_end, bound_cid, run_rec.get("display_cid") or "", run_rec.get("cid") or ""):
                    if k_rm and _ACTIVE_RUNS.get(k_rm) is run_rec:
                        _ACTIVE_RUNS.pop(k_rm, None)
            init_evt.set()
            cancel_reason = str(run_rec.get("cancel_reason") or ("user" if run_rec.get("canceled") else ""))
            should_drain = False
            if run_rec.get("canceled"):
                _broadcast_ws({
                    "type": "run_canceled",
                    "conversation_id": cid_end,
                    "run_id": run_id,
                    "reason": cancel_reason or "user",
                })
                if cancel_reason == "interrupt":
                    should_drain = True
            elif proc.returncode not in (0, None) and not final_resp:
                err_clean = _sanitize_error_text(run_rec.get("stderr") or f"exit code {proc.returncode}")
                err_cat = _classify_run_error(err_clean)
                _broadcast_ws({
                    "type": "run_error",
                    "conversation_id": cid_end,
                    "run_id": run_id,
                    "error": err_clean,
                    "error_category": err_cat,
                    "prompt": str(run_rec.get("prompt") or ""),
                    "attachments": [
                        str(a.get("path") or "")
                        for a in (run_rec.get("attachments") or [])
                        if isinstance(a, dict) and a.get("path")
                    ],
                    "model": eff_model,
                    "swarm_mode": bool(run_rec.get("swarm_mode", False)),
                })
                should_drain = err_cat not in ("quota", "rate_limit", "auth")
            else:
                _broadcast_ws({
                    "type": "run_done",
                    "conversation_id": cid_end,
                    "run_id": run_id,
                    "response": final_resp,
                    "tools": run_rec["tools"],
                    "usage": usage,
                    "model": eff_model,
                })
                should_drain = True

            if should_drain and get_conv_queue_snapshot(cid_end):
                threading.Thread(
                    target=_drain_next_queued_run,
                    args=(cid_end,),
                    name=f"queue-drain-{cid_end[:8]}",
                    daemon=True,
                ).start()

    threading.Thread(target=_stream_worker, daemon=True).start()
    if not run_rec["display_cid"]:
        init_evt.wait(timeout=8.0)

    final_cid = str(run_rec.get("display_cid") or run_rec.get("cid") or resume_cli_cid or pending_key)
    if (not run_rec["running"]) and (not run_rec.get("canceled")) and (proc.returncode not in (0, None)) and (not run_rec.get("chunks")):
        err_sync = _sanitize_error_text(run_rec.get("stderr") or f"agy CLI 执行失败 (exit code {proc.returncode})")
        return {
            "ok": False,
            "error": err_sync,
            "error_category": _classify_run_error(err_sync),
            "conversation_id": final_cid,
            "run_id": run_id,
        }
    return {
        "ok": True,
        "conversation_id": final_cid,
        "run_id": run_id,
        "created_new": bool(is_new),
        "model": eff_model,
    }


# ---------------------------------------------------------------------------
# Auth & CORS Middleware
# ---------------------------------------------------------------------------

def _check_auth(request: web.Request) -> bool:
    cfg = load_or_create_config()
    expected = str(cfg.get("token") or "").strip()
    if not expected:
        return False
    auth_h = str(request.headers.get("Authorization") or "").strip()
    if auth_h.startswith("Bearer ") and secrets.compare_digest(auth_h[7:].strip(), expected):
        return True
    q_tok = str(request.query.get("token") or "").strip()
    if q_tok and secrets.compare_digest(q_tok, expected):
        return True
    return False


_PUBLIC_API_PATHS = {"/api/pair/claim", "/api/local-auth"}
_NO_CORS_PATHS = {"/api/local-auth", "/pair"}
_PREVIEW_IMAGE_MIMES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}
_MAX_IMAGE_PREVIEW_BYTES = 25 * 1024 * 1024


def _is_strict_loopback_request(request: web.Request, *, allow_same_origin_iframe: bool = False) -> bool:
    """Only allow direct localhost/127.0.0.1 same-origin requests (never via proxy/tunnel/LAN/cross-site)."""
    if _is_via_public_tunnel(request):
        return False
    if not _is_loopback_ip(request.remote):
        return False
    host_hdr = str(request.headers.get("Host") or "").strip()
    m_host = _LOOPBACK_HOST_RE.match(host_hdr)
    if not m_host:
        return False
    host_port = int(m_host.group(1)) if m_host.group(1) else 80
    if host_port != PORT:
        return False
    sfs = str(request.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if sfs and sfs not in ("same-origin", "none"):
        return False
    sfd = str(request.headers.get("Sec-Fetch-Dest") or "").strip().lower()
    if sfd in ("iframe", "frame", "object", "embed"):
        if not (allow_same_origin_iframe and sfd == "iframe" and sfs == "same-origin"):
            return False
    origin = str(request.headers.get("Origin") or "").strip()
    if origin:
        if origin.lower() == "null":
            return False
        try:
            po = urllib.parse.urlparse(origin)
            if (
                po.scheme != "http"
                or (po.hostname or "").lower() not in ("127.0.0.1", "localhost", "::1")
                or (po.port or 80) != PORT
                or po.path not in ("", "/")
            ):
                return False
        except Exception:
            return False
    return True


def _apply_common_sec_headers(resp: web.StreamResponse) -> None:
    if not resp.prepared:
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")


@web.middleware
async def cors_and_auth_middleware(request: web.Request, handler):
    norm_path = request.path.rstrip("/") or "/"
    is_no_cors = norm_path in _NO_CORS_PATHS
    if request.method == "OPTIONS":
        if is_no_cors:
            return web.Response(
                status=403,
                headers={"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"},
            )
        return web.Response(
            status=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
                "Access-Control-Max-Age": "86400",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
            },
        )
    path = request.path
    if (path.startswith("/api/") and path not in _PUBLIC_API_PATHS) or path == "/ws":
        if not _check_auth(request):
            err_headers = {
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
            }
            if not is_no_cors:
                err_headers["Access-Control-Allow-Origin"] = "*"
            return web.json_response(
                {"ok": False, "error": "Unauthorized: invalid or missing token"},
                status=401,
                headers=err_headers,
            )
    try:
        resp = await handler(request)
    except web.HTTPException as ex:
        resp = ex
    _apply_common_sec_headers(resp)
    if not resp.prepared and not is_no_cors:
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Requested-With"
    return resp


async def handle_local_auth(request: web.Request) -> web.Response:
    """Zero-input auto-login exclusively for local desktop workbench opened on 127.0.0.1 / localhost."""
    sec_headers = {"Cache-Control": "no-store", "Vary": "Origin", "X-Frame-Options": "DENY"}
    if not _is_strict_loopback_request(request):
        return web.json_response(
            {"ok": False, "error": f"本机自动登录仅允许在电脑本机 http://127.0.0.1:{PORT} 访问"},
            status=403,
            headers=sec_headers,
        )
    cfg = load_or_create_config()
    host_hdr = str(request.headers.get("Host") or f"127.0.0.1:{PORT}").strip()
    return web.json_response(
        {
            "ok": True,
            "local": True,
            "url": f"http://{host_hdr}",
            "token": str(cfg.get("token") or ""),
            "hostname": socket.gethostname(),
            "default_model": cfg.get("default_model", "gemini-4-neon-medium"),
            "port": PORT,
        },
        headers=sec_headers,
    )


# ---------------------------------------------------------------------------
# HTTP & WebSocket Handlers
# ---------------------------------------------------------------------------

async def handle_health(request: web.Request) -> web.Response:
    payload: dict[str, Any] = {
        "ok": True,
        "app": APP_NAME,
        "version": APP_VERSION,
        "port": PORT,
    }
    if not _is_via_public_tunnel(request):
        payload["hostname"] = socket.gethostname()
    return web.json_response(payload)


async def handle_server_info(_request: web.Request) -> web.Response:
    cfg = load_or_create_config()
    lans, qqbot_ok = await asyncio.gather(
        asyncio.to_thread(detect_connect_endpoints),
        asyncio.to_thread(check_qqbot_available),
    )
    tun = get_tunnel_snapshot()
    apk_p = DIST_DIR / APK_FILENAME
    with _ACTIVE_RUNS_LOCK:
        running_cnt = len({id(v) for v in _ACTIVE_RUNS.values() if v.get("running")})
    return web.json_response({
        "ok": True,
        "app": APP_NAME,
        "version": APP_VERSION,
        "hostname": socket.gethostname(),
        "port": PORT,
        "workspace_root": WORKSPACE_ROOT.as_posix(),
        "lan_urls": lans,
        "tunnel_url": tun.get("url", ""),
        "tunnel_status": tun.get("status", "disabled"),
        "tunnel_mode": tun.get("mode", "quick"),
        "tunnel_ready_connections": int(tun.get("ready_connections") or 0),
        "tunnel_auto_heals": int(tun.get("auto_heals") or 0),
        "agy_cli_ready": bool(_find_agy_bin()),
        "qqbot_available": bool(qqbot_ok),
        "default_model": cfg.get("default_model", "gemini-4-neon-medium"),
        "permission_mode": get_permission_mode(),
        "running_tasks": running_cnt,
        "apk_name": APK_FILENAME,
        "apk_ready": apk_p.is_file(),
        "apk_size": apk_p.stat().st_size if apk_p.is_file() else 0,
    })


async def handle_set_permission_mode(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid payload"}, status=400)
    raw = str(body.get("permission_mode") or body.get("mode") or "").strip().lower()
    if raw not in _VALID_PERMISSION_MODES:
        return web.json_response(
            {"ok": False, "error": f"invalid permission_mode: {raw}"},
            status=400,
        )
    _update_config(lambda cfg: cfg.__setitem__("permission_mode", raw))
    _broadcast_ws({"type": "settings_updated", "permission_mode": raw})
    return web.json_response({"ok": True, "permission_mode": raw})


async def handle_chat_interaction_respond(request: web.Request) -> web.Response:
    ix_id = str(request.match_info.get("interaction_id") or "").strip()
    if not _INTERACTION_ID_RE.match(ix_id):
        return web.json_response({"ok": False, "error": "invalid interaction_id"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid payload"}, status=400)

    decision = str(body.get("decision") or "").strip().lower()
    option_id = str(body.get("option_id") or body.get("optionId") or "").strip()
    if decision and decision not in _VALID_PERM_DECISIONS:
        return web.json_response({"ok": False, "error": "invalid decision"}, status=400)
    if not decision and not option_id:
        return web.json_response({"ok": False, "error": "decision or option_id required"}, status=400)

    serialized: dict[str, Any] | None = None
    with _PENDING_INTERACTIONS_LOCK:
        rec = _PENDING_INTERACTIONS.get(ix_id)
        if rec is None:
            return web.json_response({"ok": False, "error": "交互请求不存在或已失效"}, status=404)
        if rec.get("status") != "pending":
            return web.json_response({"ok": False, "error": "该交互请求已处理"}, status=409)

        opts = [o for o in (rec.get("options") or []) if isinstance(o, dict)]
        cancelled = decision == "cancel"
        resolved_opt_id = ""
        final_decision = decision

        if not cancelled:
            matched: dict[str, Any] | None = None
            if option_id:
                for o in opts:
                    if str(o.get("option_id") or "") == option_id:
                        matched = o
                        break
                if matched is None:
                    return web.json_response({"ok": False, "error": "invalid option_id"}, status=400)
            elif decision:
                for o in opts:
                    if str(o.get("kind") or "").lower() == decision:
                        matched = o
                        break
                if matched is None and decision.startswith("allow"):
                    for o in opts:
                        if str(o.get("kind") or "").lower().startswith("allow"):
                            matched = o
                            break
                elif matched is None and decision.startswith("reject"):
                    for o in opts:
                        k = str(o.get("kind") or "").lower()
                        if k.startswith("reject") or k == "deny":
                            matched = o
                            break
                if matched is None:
                    if decision.startswith("reject"):
                        cancelled = True
                    elif opts:
                        matched = opts[0]
            if matched is not None:
                resolved_opt_id = str(matched.get("option_id") or "")
                if not final_decision:
                    final_decision = str(matched.get("kind") or "selected").lower()
            elif not cancelled:
                return web.json_response({"ok": False, "error": "no matching option"}, status=400)

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        rec["status"] = "cancelled" if cancelled else "resolved"
        rec["decision"] = final_decision or ("cancel" if cancelled else "selected")
        rec["option_id"] = resolved_opt_id
        rec["answered_at"] = now_iso
        rec["_resolution"] = (
            {"cancelled": True, "reason": "user"}
            if cancelled
            else {"cancelled": False, "option_id": resolved_opt_id, "decision": rec["decision"]}
        )
        evt = rec.get("_event")
        if isinstance(evt, threading.Event):
            evt.set()
        _PENDING_INTERACTIONS.pop(ix_id, None)
        serialized = _serialize_interaction(rec)

    if serialized:
        _broadcast_ws({
            "type": "run_interaction_resolved",
            "conversation_id": serialized["conversation_id"],
            "run_id": serialized["run_id"],
            "interaction_id": ix_id,
            "kind": serialized["kind"],
            "status": serialized["status"],
            "decision": serialized["decision"],
            "option_id": serialized["option_id"],
        })
    return web.json_response({"ok": True, "interaction": serialized})


async def handle_pair_claim(request: web.Request) -> web.Response:
    allowed, retry_after = _check_claim_rate_limit(_client_ip_for_rate_limit(request))
    if not allowed:
        return web.json_response(
            {"ok": False, "error": f"配对尝试过于频繁，请 {retry_after} 秒后再试"},
            status=429,
            headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
        )
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求格式错误，需传入 JSON {\"pin\": \"123456\"}"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid payload"}, status=400)

    raw_pin = re.sub(r"[\s-]+", "", str(body.get("pin") or "").strip())
    expected_pin = get_pair_pin()
    if not raw_pin or not secrets.compare_digest(raw_pin, expected_pin):
        rotated = _record_pair_pin_failure()
        await asyncio.sleep(0.25)
        msg = "配对码错误次数过多，电脑端已自动刷新为新 6 位配对码，请重新核对" if rotated else "配对码错误，请核对电脑端 /pair 页面显示的 6 位数字"
        return web.json_response(
            {"ok": False, "error": msg},
            status=403,
            headers={"Cache-Control": "no-store"},
        )

    # Rotate PIN immediately after successful claim (single-use PIN)
    init_or_rotate_pair_pin()

    cfg = load_or_create_config()
    lans, qqbot_ok = await asyncio.gather(
        asyncio.to_thread(detect_connect_endpoints),
        asyncio.to_thread(check_qqbot_available),
    )
    return web.json_response(
        {
            "ok": True,
            "token": str(cfg.get("token") or ""),
            "hostname": socket.gethostname(),
            "default_model": cfg.get("default_model", "gemini-4-neon-medium"),
            "port": PORT,
            "lan_urls": lans,
            "tunnel_url": get_tunnel_snapshot().get("url", ""),
            "qqbot_available": bool(qqbot_ok),
        },
        headers={"Cache-Control": "no-store"},
    )


async def handle_pair_rotate(_request: web.Request) -> web.Response:
    new_pin = init_or_rotate_pair_pin()
    return web.json_response({"ok": True, "pin": new_pin, "pair_pin": new_pin}, headers={"Cache-Control": "no-store"})


async def handle_tunnel_restart(_request: web.Request) -> web.Response:
    snap = await asyncio.to_thread(start_cloudflared_tunnel, 12.0, False)
    return web.json_response({"ok": True, "tunnel": snap})


async def handle_pair_info(_request: web.Request) -> web.Response:
    cfg = load_or_create_config()
    lans = await asyncio.to_thread(detect_connect_endpoints)
    tun = get_tunnel_snapshot()
    hostname = socket.gethostname()
    token = str(cfg.get("token") or "")
    main_url = lans[0]["url"] if lans else f"http://127.0.0.1:{PORT}"
    alt_urls = [str(ep.get("url") or "") for ep in lans if ep.get("url") and str(ep.get("url")) != main_url]
    pin = get_pair_pin()
    return web.json_response(
        {
            "ok": True,
            "hostname": hostname,
            "lan_urls": lans,
            "tunnel": tun,
            "pin": pin,
            "pair_uri": build_pair_uri(main_url, token, hostname, alt_urls=alt_urls),
            "token_preview": _mask_token(token),
        },
        headers={"Cache-Control": "no-store"},
    )


async def handle_models(_request: web.Request) -> web.Response:
    cfg = load_or_create_config()
    return web.json_response({
        "ok": True,
        "default_model": cfg.get("default_model", "gemini-4-neon-medium"),
        "groups": MODEL_GROUPS,
    })


async def handle_conversations(request: web.Request) -> web.Response:
    try:
        limit = min(200, max(10, int(request.query.get("limit") or 80)))
    except ValueError:
        limit = 80
    source_filter = str(request.query.get("source") or "all").strip().lower()
    if source_filter not in ("all", "desktop", "mobile", "external"):
        source_filter = "all"
    inc_ext_raw = str(request.query.get("include_external_cli") or "").strip().lower()
    include_external_cli = inc_ext_raw in ("1", "true", "yes", "on")
    items = await asyncio.to_thread(list_all_conversations, limit, source_filter, include_external_cli)
    return web.json_response({"ok": True, "conversations": items})


async def handle_conversation_detail(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    detail = await asyncio.to_thread(load_conversation_detail, cid)
    return web.json_response({"ok": True, "conversation": detail})


async def handle_conversation_context(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    cw = await asyncio.to_thread(compute_conversation_context_window, cid)
    return web.json_response({"ok": True, "conversation_id": cid, "context_window": cw})


async def handle_conversation_swarm(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    swarm = await asyncio.to_thread(load_conversation_swarm_status, cid, include_details=True)
    return web.json_response({"ok": True, "conversation_id": cid, "swarm": swarm})


async def handle_conversation_revert(request: web.Request) -> web.Response:
    global _USAGE_GLOBAL_CACHE
    cid = str(request.match_info.get("cid") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid payload"}, status=400)
    msg_index = body.get("msg_index")
    if isinstance(msg_index, bool) or not isinstance(msg_index, int):
        msg_index = None
    user_index = body.get("user_index")
    if isinstance(user_index, bool) or not isinstance(user_index, int):
        user_index = None
    msg_time = str(body.get("time") or "").strip()
    text_sha16 = str(body.get("text_sha16") or "").strip()
    if not text_sha16 and isinstance(body.get("text"), str) and body.get("text"):
        text_sha16 = _msg_text_sha16(body["text"])
    res = await asyncio.to_thread(
        _revert_conversation_sync,
        cid,
        msg_index,
        msg_time,
        text_sha16,
        user_index,
    )
    if not res.get("ok"):
        status = int(res.pop("status", 400))
        return web.json_response(res, status=status)
    if res.get("cli_truncated"):
        with _USAGE_GLOBAL_CACHE_LOCK:
            _USAGE_GLOBAL_CACHE = None
    _broadcast_ws({
        "type": "conversation_reverted",
        "conversation_id": cid,
        "canonical_cid": str(res.get("canonical_cid") or cid),
        "reverted_count": int(res.get("reverted_count") or 0),
    })
    return web.json_response(res)


async def handle_chat_send(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid payload"}, status=400)
    cid = str(body.get("conversation_id") or "").strip()
    if cid and cid != "__new__" and not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid conversation_id"}, status=400)
    prompt = str(body.get("prompt") or "")
    model = str(body.get("model") or "").strip()
    if model and not _is_valid_model_id(model):
        return web.json_response({"ok": False, "error": "invalid model"}, status=400)
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    swarm_mode = bool(body.get("swarm_mode", False))
    mode = str(body.get("mode") or "normal").strip().lower()
    if mode not in ("normal", "queue", "interrupt"):
        return web.json_response({"ok": False, "error": "invalid mode"}, status=400)
    priority = "urgent" if str(body.get("priority") or "").strip().lower() == "urgent" else "normal"
    raw_pm = str(body.get("permission_mode") or "").strip().lower()
    if raw_pm and raw_pm not in _VALID_PERMISSION_MODES:
        return web.json_response({"ok": False, "error": "invalid permission_mode"}, status=400)

    valid_att_paths, att_err = await asyncio.to_thread(_validate_chat_attachments, attachments)
    if valid_att_paths is None:
        return web.json_response({"ok": False, "error": att_err}, status=400)
    norm_atts = [ap.as_posix() for ap in valid_att_paths]
    if not prompt.strip() and not norm_atts:
        return web.json_response({"ok": False, "error": "消息内容不能为空"}, status=400)

    if model:
        _update_config(lambda cfg: cfg.__setitem__("default_model", model))
    eff_model = model or str(load_or_create_config().get("default_model") or "gemini-4-neon-medium").strip()

    is_new = (not cid) or cid == "__new__"
    canon = ""
    cands: list[str] = []
    active_rec: dict[str, Any] | None = None
    if not is_new:
        canon, _, cands = _get_cid_alias_candidates(cid)
        active_rec = _find_active_run(canon or cid)

    # Idle conversation (or new chat): execute immediately
    if active_rec is None:
        res = await asyncio.to_thread(
            start_cli_chat_run,
            canon or cid,
            prompt,
            eff_model,
            norm_atts,
            swarm_mode,
            raw_pm or None,
        )
        if res.get("ok"):
            res["queued"] = False
        return web.json_response(res, status=200 if res.get("ok") else 400)

    target_cid = canon or cid
    item_priority = "urgent" if (mode == "interrupt" or priority == "urgent") else "normal"
    item = _build_queue_item(
        prompt,
        eff_model,
        norm_atts,
        swarm_mode=swarm_mode,
        priority=item_priority,
        permission_mode=raw_pm,
    )
    with _CONV_QUEUES_LOCK:
        q = _consolidate_queue_unlocked(target_cid, cands)
        if len(q) >= _CONV_QUEUE_MAX:
            return web.json_response(
                {"ok": False, "error": f"当前会话排队消息已达上限（{_CONV_QUEUE_MAX} 条），请先等待或删减后再试"},
                status=400,
            )
        if target_cid not in _CONV_QUEUES:
            _CONV_QUEUES[target_cid] = q
        if item_priority == "urgent":
            q.insert(0, item)
        else:
            q.append(item)
        snap = [_clone_queue_item(x) for x in q]

    item_snap = _clone_queue_item(item)

    if mode == "interrupt":
        proc = None
        acp_cancel = None
        still_running = False
        with _ACTIVE_RUNS_LOCK:
            for k in cands:
                cur_rec = _ACTIVE_RUNS.get(k)
                if cur_rec and cur_rec.get("running"):
                    cur_rec["canceled"] = True
                    cur_rec["cancel_reason"] = "interrupt"
                    proc = cur_rec.get("proc")
                    acp_cancel = cur_rec.get("acp_cancel")
                    still_running = True
                    break
        _broadcast_queue_updated(target_cid, snap)
        if callable(acp_cancel):
            try:
                acp_cancel()
            except Exception:
                pass
        if proc is not None:
            _terminate_proc_safely(proc)
        elif not still_running:
            threading.Thread(
                target=_drain_next_queued_run,
                args=(target_cid,),
                name=f"queue-drain-{target_cid[:8]}",
                daemon=True,
            ).start()
        return web.json_response({
            "ok": True,
            "queued": True,
            "interrupting": True,
            "conversation_id": target_cid,
            "item": item_snap,
            "queue": snap,
        })

    _broadcast_queue_updated(target_cid, snap)
    # Race guard: if the active run finished just before enqueue landed (and wasn't user-canceled), drain now
    if (
        not active_rec.get("running")
        and str(active_rec.get("cancel_reason") or "") != "user"
        and _find_active_run(target_cid) is None
    ):
        threading.Thread(
            target=_drain_next_queued_run,
            args=(target_cid,),
            name=f"queue-drain-{target_cid[:8]}",
            daemon=True,
        ).start()
    return web.json_response({
        "ok": True,
        "queued": True,
        "conversation_id": target_cid,
        "item": item_snap,
        "queue": snap,
    })


async def handle_chat_queue_get(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    canon, _ = _resolve_queue_canonical_cid(cid)
    target_cid = canon or cid
    snap = get_conv_queue_snapshot(target_cid)
    return web.json_response({"ok": True, "conversation_id": target_cid, "queue": snap})


async def handle_chat_queue_update(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    item_id = str(request.match_info.get("item_id") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    if not item_id or not _QUEUE_ITEM_ID_RE.match(item_id):
        return web.json_response({"ok": False, "error": "invalid item_id"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid payload"}, status=400)

    has_model = "model" in body
    new_model = ""
    if has_model:
        new_model = str(body.get("model") or "").strip()
        if new_model and not _is_valid_model_id(new_model):
            return web.json_response({"ok": False, "error": "invalid model"}, status=400)

    has_atts = "attachments" in body
    norm_atts: list[str] | None = None
    if has_atts:
        if not isinstance(body.get("attachments"), list):
            return web.json_response({"ok": False, "error": "invalid attachments"}, status=400)
        valid_att_paths, att_err = await asyncio.to_thread(_validate_chat_attachments, body.get("attachments"))
        if valid_att_paths is None:
            return web.json_response({"ok": False, "error": att_err}, status=400)
        norm_atts = [ap.as_posix() for ap in valid_att_paths]

    has_prompt = "prompt" in body
    new_prompt = str(body.get("prompt") or "").strip() if has_prompt else ""
    has_swarm = "swarm_mode" in body
    new_swarm = bool(body.get("swarm_mode")) if has_swarm else False
    has_priority = "priority" in body
    new_priority = str(body.get("priority") or "").strip().lower() if has_priority else ""
    if has_priority and new_priority not in ("normal", "urgent"):
        return web.json_response({"ok": False, "error": "invalid priority"}, status=400)
    move_to_front = bool(body.get("move_to_front", False))

    canon, _, cands = _get_cid_alias_candidates(cid)
    target_cid = canon or cid
    item_snap: dict[str, Any] | None = None
    snap: list[dict[str, Any]] = []
    empty_err = False
    with _CONV_QUEUES_LOCK:
        q = _consolidate_queue_unlocked(target_cid, cands)
        idx = -1
        for i, it in enumerate(q):
            if str(it.get("id") or "") == item_id:
                idx = i
                break
        if idx >= 0:
            it = q[idx]
            eff_prompt = new_prompt if has_prompt else str(it.get("prompt") or "").strip()
            eff_atts = norm_atts if (has_atts and norm_atts is not None) else list(it.get("attachments") or [])
            if not eff_prompt and not eff_atts:
                empty_err = True
            else:
                if has_prompt:
                    it["prompt"] = eff_prompt
                if has_atts and norm_atts is not None:
                    it["attachments"] = list(norm_atts)
                if has_model and new_model:
                    it["model"] = new_model
                if has_swarm:
                    it["swarm_mode"] = new_swarm
                if has_priority:
                    it["priority"] = new_priority
                if move_to_front:
                    q.pop(idx)
                    if not has_priority:
                        it["priority"] = "urgent"
                    q.insert(0, it)
                item_snap = _clone_queue_item(it)
                snap = [_clone_queue_item(x) for x in q]
    if empty_err:
        return web.json_response({"ok": False, "error": "消息内容不能为空"}, status=400)
    if item_snap is None:
        return web.json_response({"ok": False, "error": "排队消息不存在或已开始执行"}, status=404)
    _broadcast_queue_updated(target_cid, snap)
    return web.json_response({"ok": True, "conversation_id": target_cid, "item": item_snap, "queue": snap})


async def handle_chat_queue_delete(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    item_id = str(request.match_info.get("item_id") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    if not item_id or not _QUEUE_ITEM_ID_RE.match(item_id):
        return web.json_response({"ok": False, "error": "invalid item_id"}, status=400)
    canon, _, cands = _get_cid_alias_candidates(cid)
    target_cid = canon or cid
    found = False
    snap: list[dict[str, Any]] = []
    with _CONV_QUEUES_LOCK:
        q = _consolidate_queue_unlocked(target_cid, cands)
        for i, it in enumerate(q):
            if str(it.get("id") or "") == item_id:
                q.pop(i)
                found = True
                break
        if found:
            if not q:
                _CONV_QUEUES.pop(target_cid, None)
            snap = [_clone_queue_item(x) for x in q]
    if not found:
        return web.json_response({"ok": False, "error": "排队消息不存在或已开始执行"}, status=404)
    _broadcast_queue_updated(target_cid, snap)
    return web.json_response({"ok": True, "conversation_id": target_cid, "deleted": True, "queue": snap})


async def handle_chat_queue_interrupt(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    item_id = str(request.match_info.get("item_id") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    if not item_id or not _QUEUE_ITEM_ID_RE.match(item_id):
        return web.json_response({"ok": False, "error": "invalid item_id"}, status=400)
    canon, _, cands = _get_cid_alias_candidates(cid)
    target_cid = canon or cid
    found = False
    snap: list[dict[str, Any]] = []
    with _CONV_QUEUES_LOCK:
        q = _consolidate_queue_unlocked(target_cid, cands)
        for i, it in enumerate(q):
            if str(it.get("id") or "") == item_id:
                moved = q.pop(i)
                moved["priority"] = "urgent"
                q.insert(0, moved)
                found = True
                break
        if found:
            snap = [_clone_queue_item(x) for x in q]
    if not found:
        return web.json_response({"ok": False, "error": "排队消息不存在或已开始执行"}, status=404)

    proc = None
    acp_cancel = None
    still_running = False
    with _ACTIVE_RUNS_LOCK:
        for k in cands:
            cur_rec = _ACTIVE_RUNS.get(k)
            if cur_rec and cur_rec.get("running"):
                cur_rec["canceled"] = True
                cur_rec["cancel_reason"] = "interrupt"
                proc = cur_rec.get("proc")
                acp_cancel = cur_rec.get("acp_cancel")
                still_running = True
                break

    if still_running:
        _broadcast_queue_updated(target_cid, snap)
        if callable(acp_cancel):
            try:
                acp_cancel()
            except Exception:
                pass
        if proc is not None:
            _terminate_proc_safely(proc)
        return web.json_response({
            "ok": True,
            "conversation_id": target_cid,
            "interrupting": True,
            "queue": snap,
        })

    # Conversation is idle: pop index 0 and launch immediately
    res = await asyncio.to_thread(_drain_next_queued_run, target_cid)
    after_snap = get_conv_queue_snapshot(target_cid)
    if res is not None and not res.get("ok"):
        return web.json_response(
            {
                "ok": False,
                "error": str(res.get("error") or "插队启动失败"),
                "conversation_id": target_cid,
                "interrupting": False,
                "queue": after_snap,
            },
            status=400,
        )
    return web.json_response({
        "ok": True,
        "conversation_id": target_cid,
        "interrupting": True,
        "started": bool(res and res.get("ok")),
        "run_id": str((res or {}).get("run_id") or ""),
        "queue": after_snap,
    })


async def handle_chat_queue_resume(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    canon, _ = _resolve_queue_canonical_cid(cid)
    target_cid = canon or cid
    if _find_active_run(target_cid) is not None:
        return web.json_response({
            "ok": True,
            "conversation_id": target_cid,
            "started": False,
            "queue": get_conv_queue_snapshot(target_cid),
        })
    if not get_conv_queue_snapshot(target_cid):
        return web.json_response({
            "ok": True,
            "conversation_id": target_cid,
            "started": False,
            "queue": [],
        })
    res = await asyncio.to_thread(_drain_next_queued_run, target_cid)
    after_snap = get_conv_queue_snapshot(target_cid)
    if res is not None and not res.get("ok"):
        return web.json_response(
            {
                "ok": False,
                "error": str(res.get("error") or "继续执行队列失败"),
                "conversation_id": target_cid,
                "started": False,
                "queue": after_snap,
            },
            status=400,
        )
    return web.json_response({
        "ok": True,
        "conversation_id": target_cid,
        "started": bool(res and res.get("ok")),
        "run_id": str((res or {}).get("run_id") or ""),
        "queue": after_snap,
    })


async def handle_chat_cancel(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    if not _is_valid_cid(cid):
        return web.json_response({"ok": False, "error": "invalid cid"}, status=400)
    canon, _, cands = _get_cid_alias_candidates(cid)
    target_cid = canon or cid
    proc = None
    acp_cancel = None
    with _ACTIVE_RUNS_LOCK:
        for k in cands:
            rec = _ACTIVE_RUNS.get(k)
            if rec and rec.get("running"):
                rec["canceled"] = True
                rec["cancel_reason"] = "user"
                proc = rec.get("proc")
                acp_cancel = rec.get("acp_cancel")
                break
    did_cancel = False
    if callable(acp_cancel):
        try:
            acp_cancel()
            did_cancel = True
        except Exception:
            pass
    q_snap = get_conv_queue_snapshot(target_cid)
    if proc is not None and proc.poll() is None:
        _terminate_proc_safely(proc)
        did_cancel = True
    if did_cancel:
        return web.json_response({"ok": True, "conversation_id": target_cid, "canceled": True, "queue": q_snap})
    return web.json_response({"ok": True, "conversation_id": target_cid, "canceled": False, "note": "无正在运行的手机端任务", "queue": q_snap})


async def handle_upload(request: web.Request) -> web.Response:
    try:
        reader = await request.multipart()
        field = await reader.next()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid multipart request"}, status=400)
    if field is None:
        return web.json_response({"ok": False, "error": "no file"}, status=400)
    orig_name = pathlib.Path(field.filename or "upload.bin").name
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", orig_name).strip(" ._") or "upload.bin"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / f"{int(time.time() * 1000)}_{safe_name[:100]}"
    size = 0
    max_bytes = 50 * 1024 * 1024
    with dest.open("wb") as fh:
        while True:
            chunk = await field.read_chunk(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                fh.close()
                dest.unlink(missing_ok=True)
                return web.json_response({"ok": False, "error": "文件超过 50MB 限制"}, status=413)
            fh.write(chunk)
    ext = dest.suffix.lower()
    is_img = ext in _IMAGE_EXTS
    return web.json_response({
        "ok": True,
        "name": orig_name,
        "path": dest.resolve().as_posix(),
        "size": size,
        "is_image": is_img,
        "preview_url": f"/api/files/preview?path={urllib.parse.quote(dest.resolve().as_posix())}",
    })


async def handle_files_list(request: web.Request) -> web.Response:
    raw_dir = str(request.query.get("dir") or "").strip()
    allowed_roots = _get_allowed_file_roots()
    if not raw_dir:
        target = WORKSPACE_ROOT.resolve()
    else:
        if _has_unsafe_raw_path(raw_dir, allow_absolute=True):
            return web.json_response({"ok": False, "error": "非法目录路径"}, status=403)
        try:
            target = pathlib.Path(raw_dir).resolve()
        except Exception:
            return web.json_response({"ok": False, "error": "目录路径无效"}, status=400)
        if not _is_within_allowed_roots(target, allowed_roots) or _is_sensitive_path(target):
            return web.json_response({"ok": False, "error": "禁止访问工作区之外或受保护的目录"}, status=403)
        if not target.is_dir():
            return web.json_response({"ok": False, "error": "目录不存在"}, status=404)

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    try:
        with os.scandir(target) as it:
            for e in it:
                p = pathlib.Path(e.path)
                if e.name.startswith(".") or e.name in ("__pycache__", "node_modules", ".venv", "venv"):
                    continue
                try:
                    rp = p.resolve()
                except Exception:
                    continue
                if not _is_within_allowed_roots(rp, allowed_roots) or _is_sensitive_path(rp):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                if e.is_dir():
                    dirs.append({"name": e.name, "path": rp.as_posix(), "is_dir": True, "mtime": st.st_mtime})
                else:
                    files.append({
                        "name": e.name,
                        "path": rp.as_posix(),
                        "is_dir": False,
                        "size": st.st_size,
                        "ext": rp.suffix.lower(),
                        "mtime": st.st_mtime,
                    })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    dirs.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: -float(x["mtime"]))
    parent = ""
    if target.parent != target:
        try:
            p_res = target.parent.resolve()
            if _is_within_allowed_roots(p_res, allowed_roots) and not _is_sensitive_path(p_res):
                parent = p_res.as_posix()
        except Exception:
            parent = ""
    return web.json_response({
        "ok": True,
        "dir": target.as_posix(),
        "parent": parent,
        "items": (dirs[:60] + files[:100]),
    })


async def handle_file_preview(request: web.Request) -> web.StreamResponse:
    raw_p = str(request.query.get("path") or "").strip()
    if not raw_p:
        return web.json_response({"ok": False, "error": "missing path"}, status=400)
    if _has_unsafe_raw_path(raw_p, allow_absolute=True):
        return web.json_response({"ok": False, "error": "非法文件路径"}, status=403)
    try:
        p = pathlib.Path(raw_p).resolve()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid path"}, status=400)
    if not _is_within_allowed_roots(p) or _is_sensitive_path(p):
        return web.json_response({"ok": False, "error": "禁止访问工作区之外或受保护的文件"}, status=403)
    if not p.is_file():
        return web.json_response({"ok": False, "error": "文件不存在"}, status=404)

    try:
        fsize = p.stat().st_size
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    ext = p.suffix.lower()
    # Never serve .svg inline as image/svg+xml (falls through to safe UTF-8 text preview JSON below)
    if ext in _PREVIEW_IMAGE_MIMES:
        if fsize > _MAX_IMAGE_PREVIEW_BYTES:
            return web.json_response({"ok": False, "error": "图片文件超过 25MB 预览限制，请直接下载"}, status=413)
        resp = web.FileResponse(p)
        resp.headers["Content-Type"] = _PREVIEW_IMAGE_MIMES[ext]
        resp.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp
    try:
        with p.open("rb") as fh:
            raw_b = fh.read(65536)
        sandbox_hdrs = {
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        }
        if b"\x00" in raw_b[:512]:
            return web.json_response(
                {"ok": True, "binary": True, "name": p.name, "size": fsize, "content": ""},
                headers=sandbox_hdrs,
            )
        return web.json_response(
            {
                "ok": True,
                "binary": False,
                "name": p.name,
                "size": fsize,
                "truncated": fsize > 65536,
                "content": raw_b.decode("utf-8", errors="replace"),
            },
            headers=sandbox_hdrs,
        )
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_file_download(request: web.Request) -> web.StreamResponse:
    raw_p = str(request.query.get("path") or "").strip()
    if not raw_p:
        return web.Response(status=400, text="missing path")
    if _has_unsafe_raw_path(raw_p, allow_absolute=True):
        return web.Response(status=403, text="forbidden")
    try:
        p = pathlib.Path(raw_p).resolve()
    except Exception:
        return web.Response(status=400, text="invalid path")
    if not _is_within_allowed_roots(p) or _is_sensitive_path(p):
        return web.Response(status=403, text="forbidden")
    if not p.is_file():
        return web.Response(status=404, text="not found")
    resp = web.FileResponse(p)
    qname = urllib.parse.quote(p.name)
    resp.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{qname}"
    resp.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


async def handle_qqbot_status(_request: web.Request) -> web.Response:
    def _fetch() -> dict[str, Any]:
        if not check_qqbot_available():
            return {"ok": False, "qqbot_available": False, "error": "本机未启用 QQ Bot 服务"}
        try:
            with _DIRECT_OPENER.open("http://127.0.0.1:8788/api/status", timeout=5.0) as r:
                d = json.loads(r.read().decode("utf-8", errors="replace"))
            q = d.get("quotas") or {}
            pools = q.get("pools") or {}
            all_t = (((d.get("ai_usage") or {}).get("periods") or {}).get("allTime") or {})
            return {
                "ok": True,
                "qqbot_available": True,
                "bridge_online": bool(d.get("bridge_online")),
                "gateway_online": bool(d.get("gateway_online")),
                "active_model": d.get("active_model"),
                "group_chat_model": d.get("group_chat_model"),
                "deepseek_cny": (pools.get("deepseek") or {}).get("remaining_cny"),
                "total_calls": all_t.get("calls", 0),
                "total_tokens": all_t.get("total_tokens", 0),
                "account": (q.get("account") or {}).get("email", ""),
            }
        except Exception as exc:
            return {"ok": False, "qqbot_available": False, "error": str(exc)}

    return web.json_response(await asyncio.to_thread(_fetch))


async def handle_qqbot_switch(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid payload"}, status=400)
    model = str(body.get("model") or "").strip()
    if not _is_valid_model_id(model):
        return web.json_response({"ok": False, "error": "invalid model"}, status=400)
    target = str(body.get("target") or "group").strip()
    if target not in ("group", "private", "all", "default", "active"):
        return web.json_response({"ok": False, "error": "invalid target"}, status=400)

    if not await asyncio.to_thread(check_qqbot_available):
        return web.json_response({"ok": False, "qqbot_available": False, "error": "本机未启用 QQ Bot 服务"}, status=503)

    def _post() -> dict[str, Any]:
        req = urllib.request.Request(
            "http://127.0.0.1:8788/api/switch-model",
            data=json.dumps({"model": model, "target": target}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with _DIRECT_OPENER.open(req, timeout=5.0) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))

    try:
        return web.json_response(await asyncio.to_thread(_post))
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


_USD_TO_CNY = 7.25

# Antigravity-only equivalent API pricing & estimated 5h-window quota weight (ported from AI Usage logic).
# Strictly excludes third-party APIs such as DeepSeek / AI Studio.
_AGY_MODEL_PRICING: dict[str, tuple[float, float, float]] = {
    # model_id -> (input_usd_per_1m, output_usd_per_1m, quota_pct_per_10k_net_tokens)
    "gemini-4-neon-xhigh": (1.50, 6.00, 0.16),
    "gemini-4-neon-high": (1.00, 4.00, 0.12),
    "gemini-4-neon-medium": (0.60, 2.40, 0.09),
    "gemini-4-neon-low": (0.35, 1.40, 0.06),
    "gemini-4-neon-thinking": (1.00, 4.00, 0.12),
    "gemini-4-neon": (0.60, 2.40, 0.09),
    "gemini-pro-orchestrator-neon": (1.50, 6.00, 0.16),
    "gemini-pro-orchestrator-argon": (2.00, 8.00, 0.18),
    "gemini-pro-orchestrator": (2.00, 8.00, 0.20),
    "gemini-4-hydrogen-xhigh": (1.50, 6.00, 0.16),
    "gemini-4-hydrogen-high": (1.00, 4.00, 0.12),
    "gemini-4-hydrogen-medium": (0.60, 2.40, 0.09),
    "gemini-4-hydrogen-low": (0.35, 1.40, 0.06),
    "gemini-4-hydrogen-thinking": (1.00, 4.00, 0.12),
    "gemini-4-hydrogen": (0.60, 2.40, 0.09),
    "gemini-4-carbon-high": (2.50, 10.00, 0.24),
    "gemini-4-carbon-medium": (2.00, 8.00, 0.20),
    "gemini-4-carbon-low": (1.25, 5.00, 0.14),
    "gemini-4-carbon-thinking": (2.50, 10.00, 0.24),
    "gemini-4-carbon": (2.00, 8.00, 0.20),
    "gemini-4-argon-high": (2.50, 10.00, 0.22),
    "gemini-4-argon-medium": (2.00, 8.00, 0.18),
    "gemini-4-argon-low": (1.25, 5.00, 0.13),
    "gemini-4-argon-thinking": (2.50, 10.00, 0.22),
    "gemini-4-argon": (2.00, 8.00, 0.20),
    "gemini-3.8-flash-high": (0.30, 1.20, 0.06),
    "gemini-3.8-flash-medium": (0.20, 0.80, 0.06),
    "gemini-3.8-flash-low": (0.15, 0.60, 0.05),
    "gemini-3.8-flash-thinking": (0.30, 1.20, 0.06),
    "gemini-3.8-flash": (0.15, 0.60, 0.06),
    "claude-opus-5-5-thinking": (15.00, 75.00, 0.45),
    "claude-opus-5-5": (15.00, 75.00, 0.45),
    "claude-sonnet-5-5-thinking": (3.00, 15.00, 0.25),
    "claude-sonnet-5-5": (3.00, 15.00, 0.25),
    "gpt-oss-120b-medium": (0.40, 1.60, 0.06),
}


def _is_antigravity_usage_model(model_id: str) -> bool:
    """Include ONLY Antigravity platform models (exclude third-party DeepSeek / AI Studio APIs)."""
    m = str(model_id or "").strip().lower()
    if not m:
        return False
    if m.startswith(("deepseek", "aistudio", "openai/", "qwen", "doubao", "glm")):
        return False
    return True


def _lookup_agy_pricing(model_id: str) -> tuple[float, float, float]:
    m = str(model_id or "").strip().lower()
    if m in _AGY_MODEL_PRICING:
        return _AGY_MODEL_PRICING[m]
    if "opus" in m:
        return (15.00, 75.00, 0.45)
    if "sonnet" in m or "claude" in m:
        return (3.00, 15.00, 0.25)
    if "carbon" in m:
        return (2.00, 8.00, 0.20)
    if "argon" in m:
        return (2.00, 8.00, 0.18)
    if "flash" in m:
        return (0.15, 0.60, 0.06)
    if "neon" in m or "hydrogen" in m or "orchestrator" in m:
        if "xhigh" in m:
            return (1.50, 6.00, 0.16)
        if "high" in m:
            return (1.00, 4.00, 0.12)
        if "low" in m:
            return (0.35, 1.40, 0.06)
        return (0.60, 2.40, 0.09)
    return (0.60, 2.40, 0.09)


def _calc_step_cost_and_quota(model_id: str, in_t: int, ca_t: int, out_t: int) -> tuple[float, float]:
    in_p, out_p, q_per_10k = _lookup_agy_pricing(model_id)
    # Prompt cache reads billed at 10% of base input token rate
    cost_usd = (in_t * in_p + ca_t * (in_p * 0.10) + out_t * out_p) / 1_000_000.0
    # Quota weight uses net (uncached input + output) + 5% weight for cached context
    eff_toks = in_t + out_t + (ca_t * 0.05)
    quota_pct = (eff_toks / 10_000.0) * q_per_10k
    return cost_usd, quota_pct


def _classify_usage_pool(model_id: str) -> tuple[str, str]:
    m = str(model_id or "").strip().lower()
    if "orchestrator" in m:
        return ("orchestrator", "Orchestrator 智能编排")
    if "neon" in m:
        return ("neon", "Gemini 4 Neon")
    if "hydrogen" in m:
        return ("hydrogen", "Gemini 4 Hydrogen")
    if "carbon" in m:
        return ("carbon", "Gemini 4 Carbon")
    if "argon" in m or "flash" in m:
        return ("argon_flash", "Gemini 4 Argon & Flash")
    if "claude" in m or "opus" in m or "sonnet" in m:
        return ("claude", "Claude 5.5")
    if "gpt" in m:
        return ("oss", "GPT-OSS / 开源")
    return ("other", "其他 Antigravity 模型")


# ---------------------------------------------------------------------------
# Antigravity Context Window Engine (100% Standalone + Optional Live Enrich)
# ---------------------------------------------------------------------------

_MODEL_DISPLAY_OVERRIDES: dict[str, str] = {
    "gemini-pro-orchestrator-neon": "Orchestrator · Neon",
    "gemini-pro-orchestrator": "Orchestrator · Carbon",
    "gemini-pro-orchestrator-argon": "Orchestrator · Argon",
    "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
    "gpt-oss-120b": "GPT-OSS 120B",
}
_MODEL_EFFORT_LABELS: dict[str, str] = {
    "xhigh": "XHigh",
    "high": "High",
    "medium": "Medium",
    "low": "Low",
    "thinking": "Thinking",
}


def _lookup_model_context_limit(model_id: str) -> int:
    m = str(model_id or "").strip().lower()
    if not m:
        return 512000
    if m.startswith((
        "gemini-4-neon",
        "gemini-4-carbon",
        "gemini-4-hydrogen",
        "gemini-4-argon",
        "gemini-pro-orchestrator",
    )):
        return 512000
    if m.startswith((
        "gemini-3.8-flash",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
    )):
        return 256000
    if m.startswith((
        "claude-opus-4",
        "claude-sonnet-4",
        "claude-3.",
        "claude-3-",
    )):
        return 200000
    if m.startswith((
        "gemini-3-flash",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-2.5-",
        "deepseek-",
    )):
        return 128000
    if m.startswith("gpt-oss-120b"):
        return 80000
    if "orchestrator" in m or any(k in m for k in ("neon", "carbon", "hydrogen", "argon")):
        return 512000
    if "opus-5" in m or "sonnet-5" in m or "3.8-flash" in m:
        return 256000
    if "claude" in m:
        return 200000
    if "gpt-oss" in m:
        return 80000
    return 512000


def _format_window_limit_label(limit: int) -> str:
    n = max(0, int(limit or 0))
    if n in (1_000_000, 1_048_576):
        return "1M"
    if n in (2_000_000, 2_097_152):
        return "2M"
    if n >= 1_000_000:
        lbl = f"{n / 1_000_000:.1f}M"
        return lbl[:-3] + "M" if lbl.endswith(".0M") else lbl
    if n >= 1000:
        return f"{round(n / 1000)}K"
    return str(n)


def _format_model_display_label(model_id: str) -> str:
    raw = str(model_id or "").strip()
    if not raw:
        return "Unknown"
    low = raw.lower()
    if low in _MODEL_DISPLAY_OVERRIDES:
        return _MODEL_DISPLAY_OVERRIDES[low]
    m_cl = re.match(r"^claude-([a-z]+)-(\d+)[-.](\d+)(?:-(xhigh|high|medium|low|thinking))?$", low)
    if m_cl:
        fam = m_cl.group(1).capitalize()
        ver = f"{m_cl.group(2)}.{m_cl.group(3)}"
        eff = _MODEL_EFFORT_LABELS.get(m_cl.group(4) or "", "")
        return f"Claude {fam} {ver}" + (f" ({eff})" if eff else "")
    m_gm = re.match(r"^gemini-([0-9.]+)-([a-z0-9-]+?)(?:-(xhigh|high|medium|low|thinking))?$", low)
    if m_gm:
        ver = m_gm.group(1)
        fam = " ".join(p.capitalize() for p in m_gm.group(2).split("-") if p)
        eff = _MODEL_EFFORT_LABELS.get(m_gm.group(3) or "", "")
        return f"Gemini {ver} {fam}" + (f" ({eff})" if eff else "")
    parts = [p for p in re.split(r"[-_]+", raw) if p]
    if parts and parts[-1].lower() in _MODEL_EFFORT_LABELS and len(parts) > 1:
        eff = _MODEL_EFFORT_LABELS[parts[-1].lower()]
        base = " ".join(p.upper() if p.lower() in ("gpt", "oss") else p.capitalize() for p in parts[:-1])
        return f"{base} ({eff})"
    return " ".join(p.upper() if p.lower() in ("gpt", "oss") else p.capitalize() for p in parts)


def _calc_context_status_level(used_pct: float) -> str:
    if used_pct < 50.0:
        return "low"
    if used_pct < 75.0:
        return "mid"
    if used_pct < 90.0:
        return "high"
    return "critical"


def _parse_transcript_context_file(tf: pathlib.Path) -> dict[str, Any] | None:
    """mtime+size cached standalone extraction of context-window metrics from transcript.jsonl."""
    try:
        st = tf.stat()
    except OSError:
        return None
    if st.st_size <= 0:
        return None
    key = tf.as_posix()
    with _CTX_CACHE_LOCK:
        cached = _CTX_FILE_CACHE.get(key)
        if cached is not None and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return dict(cached[2]) if cached[2] is not None else None

    turns = 0
    steps = 0
    has_explicit_user = False
    sess_in = 0
    sess_ca = 0
    turn_in = 0
    turn_ca = 0
    last_in = 0
    last_ca = 0
    last_out = 0
    last_think_out = 0
    last_resp_out = 0
    last_model = ""
    prev_step_ts = 0.0
    last_speed_tps: float | None = None
    speed_out_sum = 0
    speed_dt_sum = 0.0

    try:
        with tf.open("r", encoding="utf-8", errors="ignore") as fh:
            for ln in fh:
                s = ln.strip()
                if not s:
                    continue
                if '"PLANNER_RESPONSE"' not in s and '"USER_INPUT"' not in s:
                    if '"created_at"' in s:
                        try:
                            o_ts = json.loads(s)
                            if isinstance(o_ts, dict):
                                ts_any = _parse_iso_ts(o_ts.get("created_at"))
                                if ts_any > 0.0:
                                    prev_step_ts = ts_any
                        except Exception:
                            pass
                    continue
                try:
                    obj = json.loads(s)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                st_t = str(obj.get("type") or "")
                ts = _parse_iso_ts(obj.get("created_at"))
                if st_t == "USER_INPUT":
                    if obj.get("source") == "USER_EXPLICIT":
                        has_explicit_user = True
                        turns += 1
                        turn_in = 0
                        turn_ca = 0
                    elif not has_explicit_user:
                        turn_in = 0
                        turn_ca = 0
                elif st_t == "PLANNER_RESPONSE":
                    mod = str(obj.get("model") or "").strip()
                    if mod:
                        last_model = mod
                    in_t = max(0, int(obj.get("input_tokens") or 0))
                    ca_t = max(0, int(obj.get("cache_read_tokens") or 0))
                    out_t = max(0, int(obj.get("output_tokens") or 0))
                    if in_t > 0 or ca_t > 0 or out_t > 0:
                        steps += 1
                        sess_in += in_t
                        sess_ca += ca_t
                        turn_in += in_t
                        turn_ca += ca_t
                        last_in = in_t
                        last_ca = ca_t
                        last_out = out_t
                        if prev_step_ts > 0.0 and ts > prev_step_ts:
                            dt = ts - prev_step_ts
                            if 0.4 <= dt <= 120.0 and out_t >= 16:
                                last_speed_tps = out_t / dt
                                speed_out_sum += out_t
                                speed_dt_sum += dt
                        raw_think_tok = obj.get("thinking_tokens")
                        if isinstance(raw_think_tok, int) and raw_think_tok >= 0:
                            last_think_out = min(out_t, raw_think_tok)
                            last_resp_out = max(0, out_t - last_think_out)
                        elif out_t <= 0:
                            last_think_out = 0
                            last_resp_out = 0
                        else:
                            th_len = len(str(obj.get("thinking") or ""))
                            ct_len = len(str(obj.get("content") or ""))
                            tcs = obj.get("tool_calls")
                            tc_len = len(json.dumps(tcs, ensure_ascii=False)) if tcs else 0
                            resp_len = ct_len + tc_len
                            if th_len > 0 and resp_len > 0:
                                last_think_out = round(out_t * th_len / (th_len + resp_len))
                                last_resp_out = max(0, out_t - last_think_out)
                            elif th_len > 0:
                                last_think_out = out_t
                                last_resp_out = 0
                            else:
                                last_think_out = 0
                                last_resp_out = out_t
                if ts > 0.0:
                    prev_step_ts = ts
    except OSError:
        return None

    result: dict[str, Any] | None = None
    if steps > 0:
        used_tokens = last_in + last_ca + last_out
        window_limit = _lookup_model_context_limit(last_model)
        remaining_tokens = max(0, window_limit - used_tokens)
        used_pct = round((used_tokens * 100.0 / window_limit), 1) if window_limit > 0 else 0.0
        turn_prompt = turn_in + turn_ca
        sess_prompt = sess_in + sess_ca
        denom = used_tokens if used_tokens > 0 else 1
        usage_breakdown = [
            {"key": "cache_read", "label": "缓存读取", "tokens": last_ca, "pct": round(last_ca * 100.0 / denom, 1), "color": "#34d399"},
            {"key": "uncached_input", "label": "新增输入", "tokens": last_in, "pct": round(last_in * 100.0 / denom, 1), "color": "#38bdf8"},
            {"key": "thinking_output", "label": "思考推理", "tokens": last_think_out, "pct": round(last_think_out * 100.0 / denom, 1), "color": "#a78bfa"},
            {"key": "response_output", "label": "正文回复", "tokens": last_resp_out, "pct": round(last_resp_out * 100.0 / denom, 1), "color": "#f59e0b"},
        ]
        result = {
            "used_tokens": used_tokens,
            "window_limit": window_limit,
            "window_limit_label": _format_window_limit_label(window_limit),
            "remaining_tokens": remaining_tokens,
            "used_pct": used_pct,
            "status_level": _calc_context_status_level(used_pct),
            "model_id": last_model,
            "model_label": _format_model_display_label(last_model),
            "turn_cache_hit_pct": round((turn_ca * 100.0 / turn_prompt), 1) if turn_prompt > 0 else 0.0,
            "turn_cache_tokens": turn_ca,
            "session_cache_hit_pct": round((sess_ca * 100.0 / sess_prompt), 1) if sess_prompt > 0 else 0.0,
            "session_cache_tokens": sess_ca,
            "speed_tps": round(last_speed_tps, 1) if last_speed_tps is not None else None,
            "avg_speed_tps": round(speed_out_sum / speed_dt_sum, 1) if speed_dt_sum > 0.0 else None,
            "breakdown": None,
            "usage_breakdown": usage_breakdown,
            "turns": turns if turns > 0 else 1,
            "steps": steps,
            "source": "transcript",
            "is_live": False,
            "is_generating": False,
        }

    with _CTX_CACHE_LOCK:
        if len(_CTX_FILE_CACHE) >= _CTX_CACHE_MAX:
            for drop_k in list(_CTX_FILE_CACHE.keys())[: _CTX_CACHE_MAX // 4]:
                _CTX_FILE_CACHE.pop(drop_k, None)
        _CTX_FILE_CACHE[key] = (st.st_mtime_ns, st.st_size, dict(result) if result is not None else None)
    return result


def _sanitize_breakdown_list(raw_list: Any) -> list[dict[str, Any]] | None:
    if not isinstance(raw_list, list) or not raw_list:
        return None
    out: list[dict[str, Any]] = []
    for item in raw_list[:12]:
        if not isinstance(item, dict):
            continue
        k = str(item.get("key") or "").strip()[:32]
        if not k:
            continue
        color_raw = str(item.get("color") or "#38bdf8").strip()
        color = color_raw if _SAFE_HEX_COLOR_RE.match(color_raw) else "#38bdf8"
        try:
            tok = max(0, int(item.get("tokens") or 0))
        except (TypeError, ValueError):
            tok = 0
        try:
            pct = round(max(0.0, float(item.get("pct") or 0.0)), 1)
        except (TypeError, ValueError):
            pct = 0.0
        entry: dict[str, Any] = {
            "key": k,
            "tokens": tok,
            "pct": pct,
            "color": color,
        }
        lbl = str(item.get("label") or "").strip()[:48]
        if lbl:
            entry["label"] = lbl
        out.append(entry)
    return out or None


def _fetch_optional_live_context_window(cid: str) -> dict[str, Any] | None:
    """Strictly fail-silent optional live context-window enrichment (env URL or loopback :18492), 3s cached."""
    if not _is_valid_cid(cid):
        return None
    now = time.time()
    with _LIVE_CTX_CACHE_LOCK:
        cached = _LIVE_CTX_CACHE.get(cid)
        if cached is not None and (now - cached[0]) < _LIVE_CTX_CACHE_TTL_SEC:
            return dict(cached[1]) if cached[1] is not None else None

    env_url = str(os.environ.get("AGY_CONTEXT_WINDOW_API_URL") or "").strip()
    target_url = ""
    use_direct = True
    if env_url:
        try:
            if "{cid}" in env_url:
                cand_url = env_url.replace("{cid}", urllib.parse.quote(cid))
            else:
                sep = "&" if "?" in env_url else "?"
                cand_url = f"{env_url}{sep}sid={urllib.parse.quote(cid)}"
            pu = urllib.parse.urlparse(cand_url)
            host_lc = (pu.hostname or "").lower()
            is_local = pu.scheme == "http" and host_lc in ("127.0.0.1", "localhost", "::1")
            is_https = pu.scheme == "https" and bool(host_lc)
            if is_local or is_https:
                target_url = cand_url
                use_direct = is_local
        except Exception:
            target_url = ""
    else:
        target_url = f"http://127.0.0.1:18492/context-window?sid={urllib.parse.quote(cid)}"
        use_direct = True

    sanitized: dict[str, Any] | None = None
    if target_url:
        try:
            req = urllib.request.Request(target_url, headers={"Accept": "application/json"}, method="GET")
            opener = _DIRECT_OPENER if use_direct else urllib.request.build_opener()
            with opener.open(req, timeout=0.55) as resp:
                if getattr(resp, "status", 200) == 200:
                    raw = json.loads(resp.read(262144).decode("utf-8", errors="replace"))
                    cw = raw.get("context_window") if isinstance(raw, dict) and isinstance(raw.get("context_window"), dict) else (raw if isinstance(raw, dict) else None)
                    if isinstance(cw, dict):
                        out: dict[str, Any] = {}
                        for ik in ("used_tokens", "remaining_tokens", "window_limit", "turn_cache_tokens", "session_cache_tokens", "turns", "turn_count", "steps"):
                            if cw.get(ik) is not None:
                                try:
                                    out[ik] = max(0, int(cw[ik]))
                                except (TypeError, ValueError):
                                    pass
                        for fk in ("used_pct", "speed_tps", "avg_speed_tps", "turn_cache_hit_pct", "session_cache_hit_pct"):
                            if cw.get(fk) is not None:
                                try:
                                    out[fk] = round(float(cw[fk]), 1)
                                except (TypeError, ValueError):
                                    pass
                        for sk in ("window_limit_label", "model_id", "model_label", "source"):
                            if cw.get(sk):
                                out[sk] = str(cw[sk]).strip()[:64]
                        if "is_live" in cw:
                            out["is_live"] = bool(cw["is_live"])
                        if "is_generating" in cw:
                            out["is_generating"] = bool(cw["is_generating"])
                        bd = _sanitize_breakdown_list(cw.get("breakdown"))
                        if bd:
                            out["breakdown"] = bd
                        ubd = _sanitize_breakdown_list(cw.get("usage_breakdown"))
                        if ubd:
                            out["usage_breakdown"] = ubd
                        if out:
                            sanitized = out
        except Exception:
            sanitized = None

    with _LIVE_CTX_CACHE_LOCK:
        if len(_LIVE_CTX_CACHE) >= _LIVE_CTX_CACHE_MAX:
            for drop_k in list(_LIVE_CTX_CACHE.keys())[: _LIVE_CTX_CACHE_MAX // 4]:
                _LIVE_CTX_CACHE.pop(drop_k, None)
        _LIVE_CTX_CACHE[cid] = (now, dict(sanitized) if sanitized is not None else None)
    return sanitized


def compute_conversation_context_window(cid: str) -> dict[str, Any]:
    """Compute standalone Antigravity context-window metrics from transcript.jsonl, with optional live enrichment."""
    default_model = str(load_or_create_config().get("default_model") or "gemini-4-neon-medium").strip()
    default_limit = _lookup_model_context_limit(default_model)
    is_local_active = _find_active_run(cid) is not None

    base: dict[str, Any] = {
        "used_tokens": 0,
        "window_limit": default_limit,
        "window_limit_label": _format_window_limit_label(default_limit),
        "remaining_tokens": default_limit,
        "used_pct": 0.0,
        "status_level": "low",
        "model_id": default_model,
        "model_label": _format_model_display_label(default_model),
        "turn_cache_hit_pct": 0.0,
        "turn_cache_tokens": 0,
        "session_cache_hit_pct": 0.0,
        "session_cache_tokens": 0,
        "speed_tps": None,
        "avg_speed_tps": None,
        "breakdown": None,
        "usage_breakdown": [
            {"key": "cache_read", "label": "缓存读取", "tokens": 0, "pct": 0.0, "color": "#34d399"},
            {"key": "uncached_input", "label": "新增输入", "tokens": 0, "pct": 0.0, "color": "#38bdf8"},
            {"key": "thinking_output", "label": "思考推理", "tokens": 0, "pct": 0.0, "color": "#a78bfa"},
            {"key": "response_output", "label": "正文回复", "tokens": 0, "pct": 0.0, "color": "#f59e0b"},
        ],
        "turns": 0,
        "steps": 0,
        "source": "transcript",
        "is_live": False,
        "is_generating": is_local_active,
    }

    if not _is_valid_cid(cid):
        return base

    # Gather candidate transcripts (primary + desktop/cli alias) and pick the freshest one with token data
    tf_cands: list[tuple[float, pathlib.Path, str]] = []
    seen_p: set[str] = set()

    def _add_tf(p: pathlib.Path | None, probe_cid: str) -> None:
        if p is None:
            return
        ps = p.as_posix()
        if ps in seen_p:
            return
        try:
            st = p.stat()
            if st.st_size > 0:
                seen_p.add(ps)
                tf_cands.append((st.st_mtime, p, probe_cid))
        except OSError:
            pass

    tf_main, src_main = _locate_transcript(cid)
    _add_tf(tf_main, cid)
    if src_main == "desktop":
        aliased = get_desktop_cli_alias(cid)
        if aliased and aliased != cid:
            _add_tf(CLI_BRAIN / aliased / ".system_generated" / "logs" / "transcript.jsonl", aliased)
    elif src_main == "mobile":
        parent_d = get_desktop_parent_for_cli(cid)
        if parent_d and parent_d != cid:
            _add_tf(DESKTOP_BRAIN / parent_d / ".system_generated" / "logs" / "transcript.jsonl", parent_d)

    tf_cands.sort(key=lambda item: item[0], reverse=True)
    live_probe_cid = cid
    for _, tf_path, p_cid in tf_cands:
        parsed = _parse_transcript_context_file(tf_path)
        if parsed is not None:
            base = dict(parsed)
            base["is_generating"] = is_local_active
            live_probe_cid = p_cid
            break

    # Optional fail-silent live enrichment (zero personal data hardcoded)
    live = _fetch_optional_live_context_window(live_probe_cid)
    if live is None and live_probe_cid != cid:
        live = _fetch_optional_live_context_window(cid)

    if isinstance(live, dict) and int(live.get("used_tokens") or 0) > 0:
        used_tokens = int(live["used_tokens"])
        window_limit = int(live.get("window_limit") or base.get("window_limit") or default_limit)
        if window_limit <= 0:
            window_limit = default_limit
        base["used_tokens"] = used_tokens
        base["window_limit"] = window_limit
        base["window_limit_label"] = str(live.get("window_limit_label") or _format_window_limit_label(window_limit))[:16]
        if live.get("remaining_tokens") is not None:
            base["remaining_tokens"] = max(0, int(live["remaining_tokens"]))
        else:
            base["remaining_tokens"] = max(0, window_limit - used_tokens)
        if live.get("used_pct") is not None:
            base["used_pct"] = round(max(0.0, float(live["used_pct"])), 1)
        else:
            base["used_pct"] = round((used_tokens * 100.0 / window_limit), 1) if window_limit > 0 else 0.0
        if live.get("model_id"):
            base["model_id"] = str(live["model_id"])
            base["model_label"] = str(live.get("model_label") or _format_model_display_label(base["model_id"]))
        elif live.get("model_label"):
            base["model_label"] = str(live["model_label"])
        for opt_k in ("speed_tps", "avg_speed_tps", "turn_cache_hit_pct", "turn_cache_tokens", "session_cache_hit_pct", "session_cache_tokens"):
            if live.get(opt_k) is not None:
                base[opt_k] = live[opt_k]
        if live.get("breakdown"):
            base["breakdown"] = live["breakdown"]
        if live.get("usage_breakdown"):
            base["usage_breakdown"] = live["usage_breakdown"]
        live_turns = live.get("turns") if live.get("turns") is not None else live.get("turn_count")
        if live_turns is not None:
            base["turns"] = max(int(base.get("turns") or 0), int(live_turns))
        if live.get("steps") is not None:
            base["steps"] = max(int(base.get("steps") or 0), int(live["steps"]))
        base["is_live"] = bool(live.get("is_live", True))
        base["is_generating"] = bool(live.get("is_generating", False)) or is_local_active
        base["source"] = str(live.get("source") or "live")[:32]
        # Always normalize status_level to canonical contract: low / mid / high / critical
        base["status_level"] = _calc_context_status_level(float(base["used_pct"]))

    return base


# ---------------------------------------------------------------------------
# Live Swarm Status Engine (100% Read-Only, Privacy-Safe)
# ---------------------------------------------------------------------------

def _sanitize_swarm_snippet(raw: str, max_len: int = 90) -> str:
    """Collapse whitespace, redact emails, and replace absolute host paths with basenames only."""
    s = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not s:
        return ""
    s = _EMAIL_RE.sub("[redacted]", s)

    def _to_basename(m: re.Match[str]) -> str:
        tok = m.group(0).rstrip(".,;:!?`'\"])}")
        parts = [p for p in re.split(r"[/\\]+", tok) if p]
        return parts[-1] if parts else ""

    s = _WIN_ABS_PATH_RE.sub(_to_basename, s)
    s = _UNIX_HOME_PATH_RE.sub(_to_basename, s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > max_len:
        return s[: max_len - 1].rstrip() + "…"
    return s


def _locate_swarm_dir(cid: str) -> tuple[pathlib.Path | None, pathlib.Path]:
    """Locate .system_generated/swarm across DESKTOP_BRAIN & CLI_BRAIN (and desktop_to_cli_alias)."""
    if not _is_valid_cid(cid):
        return None, DESKTOP_BRAIN
    cands: list[str] = [cid]
    cli_alias = get_desktop_cli_alias(cid)
    if cli_alias and _is_valid_cid(cli_alias) and cli_alias not in cands:
        cands.append(cli_alias)
    parent_d = get_desktop_parent_for_cli(cid)
    if parent_d and _is_valid_cid(parent_d) and parent_d not in cands:
        cands.append(parent_d)

    found: list[tuple[float, pathlib.Path, pathlib.Path]] = []
    for c in cands:
        for root in (DESKTOP_BRAIN, CLI_BRAIN):
            sdir = root / c / ".system_generated" / "swarm"
            if not sdir.is_dir():
                continue
            mt = 0.0
            for fname in ("members.json", "board.jsonl", "plan.json", "swarm.json"):
                fp = sdir / fname
                try:
                    st = fp.stat()
                    if st.st_mtime > mt:
                        mt = st.st_mtime
                except OSError:
                    continue
            found.append((mt, sdir, root))
    if not found:
        return None, DESKTOP_BRAIN
    found.sort(key=lambda item: item[0], reverse=True)
    return found[0][1], found[0][2]


def _read_member_current_action(member_cid: str, primary_root: pathlib.Path) -> str:
    """Fast 16KB tail-read (mtime+size cached) of a member's transcript.jsonl for a privacy-safe action summary."""
    mcid = str(member_cid or "").strip()
    if not _is_valid_cid(mcid):
        return ""
    roots = (primary_root, CLI_BRAIN if primary_root == DESKTOP_BRAIN else DESKTOP_BRAIN)
    tf: pathlib.Path | None = None
    st = None
    for root in roots:
        cand = root / mcid / ".system_generated" / "logs" / "transcript.jsonl"
        try:
            cand_st = cand.stat()
            if cand_st.st_size > 0:
                tf = cand
                st = cand_st
                break
        except OSError:
            continue
    if tf is None or st is None:
        return ""

    cache_key = tf.as_posix()
    with _SWARM_ACTION_CACHE_LOCK:
        cached = _SWARM_ACTION_CACHE.get(cache_key)
        if cached is not None and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return cached[2]

    action = ""
    try:
        tail_bytes = 16384
        with tf.open("rb") as fh:
            if st.st_size > tail_bytes:
                fh.seek(st.st_size - tail_bytes)
                raw = fh.read(tail_bytes)
                nl_idx = raw.find(b"\n")
                if nl_idx >= 0:
                    raw = raw[nl_idx + 1 :]
            else:
                raw = fh.read()
        lines = raw.decode("utf-8", errors="ignore").splitlines()
        for ln in reversed(lines):
            s = ln.strip()
            if not s or '"PLANNER_RESPONSE"' not in s:
                continue
            try:
                obj = json.loads(s)
            except Exception:
                continue
            if not isinstance(obj, dict) or obj.get("type") != "PLANNER_RESPONSE":
                continue
            tcs = obj.get("tool_calls") or []
            if isinstance(tcs, list) and tcs:
                def _unquote_arg(v: Any) -> str:
                    s_v = str(v or "").strip()
                    if len(s_v) >= 2 and s_v[0] == '"' and s_v[-1] == '"':
                        try:
                            dec = json.loads(s_v)
                            if isinstance(dec, str):
                                return dec.strip()
                        except Exception:
                            return s_v.strip('"').strip()
                    return s_v

                tc = tcs[-1] if isinstance(tcs[-1], dict) else {}
                tname = str(tc.get("name") or "").strip()
                targs = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                summary = _unquote_arg(targs.get("toolSummary"))
                if summary:
                    action = _sanitize_swarm_snippet(summary, 90)
                elif tname in ("read_file", "edit_file", "write_file", "write_to_file", "replace_file_content"):
                    raw_fp = _unquote_arg(targs.get("Path") or targs.get("TargetFile") or targs.get("path"))
                    fname = pathlib.Path(raw_fp).name if raw_fp else ""
                    action = _sanitize_swarm_snippet(f"{tname} {fname}".strip(), 90)
                elif tname == "run_command":
                    cmd_s = _unquote_arg(targs.get("CommandLine")).splitlines()[0] if targs.get("CommandLine") else ""
                    action = _sanitize_swarm_snippet(f"run: {cmd_s}" if cmd_s else "run_command", 90)
                elif tname == "swarm":
                    act = _unquote_arg(targs.get("action"))
                    nm = _unquote_arg(targs.get("name"))
                    action = _sanitize_swarm_snippet(f"swarm {act} {nm}".strip(), 90)
                elif tname == "post_message":
                    msg_s = _unquote_arg(targs.get("text")).splitlines()[0] if targs.get("text") else ""
                    action = _sanitize_swarm_snippet(f"post: {msg_s}" if msg_s else "post_message", 90)
                elif tname:
                    target = ""
                    for tk in ("query", "Url", "Role", "Action"):
                        if targs.get(tk):
                            target = _unquote_arg(targs.get(tk)).splitlines()[0]
                            break
                    action = _sanitize_swarm_snippet(f"{tname} {target}".strip(), 90)
            if not action:
                c_txt = _clean_assistant_text(str(obj.get("content") or ""))
                if c_txt:
                    action = _sanitize_swarm_snippet(c_txt, 90)
            if not action:
                th_txt = str(obj.get("thinking") or "").strip()
                if th_txt:
                    action = _sanitize_swarm_snippet(th_txt, 90)
            if action:
                break
    except OSError:
        action = ""

    with _SWARM_ACTION_CACHE_LOCK:
        if len(_SWARM_ACTION_CACHE) >= _SWARM_ACTION_CACHE_MAX:
            for drop_k in list(_SWARM_ACTION_CACHE.keys())[: _SWARM_ACTION_CACHE_MAX // 4]:
                _SWARM_ACTION_CACHE.pop(drop_k, None)
        _SWARM_ACTION_CACHE[cache_key] = (st.st_mtime_ns, st.st_size, action)
    return action


def _classify_swarm_member_state(m_raw: dict[str, Any]) -> tuple[str, bool]:
    killed = bool(m_raw.get("killed")) or str(m_raw.get("phase") or "").upper() == "KILLED"
    if killed:
        return "killed", True
    phase = str(m_raw.get("phase") or "").upper()
    wake_mode = str(m_raw.get("wake_mode") or "").lower()
    if phase == "RUNNING" and wake_mode == "working":
        return "working", False
    if phase == "RUNNING":
        return "waiting", False
    return "stopped", False


def _is_active_swarm_cli_run(cid: str) -> dict[str, Any] | None:
    rec = _find_active_run(cid)
    if rec and rec.get("running") and bool(rec.get("swarm_mode")):
        return rec
    return None


def _read_json_file_safe(p: pathlib.Path) -> dict[str, Any]:
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_conversation_swarm_summary(cid: str) -> dict[str, Any]:
    """Fast compact swarm summary for conversation detail (no board/transcript scan)."""
    active_swarm_rec = _is_active_swarm_cli_run(cid)
    sdir, _ = _locate_swarm_dir(cid)
    if sdir is None:
        if active_swarm_rec is not None:
            return {
                "has_swarm": True,
                "is_live": True,
                "active_count": 1,
                "working_count": 1,
                "title": _sanitize_swarm_snippet(str(active_swarm_rec.get("prompt") or "Swarm"), 64),
            }
        return {
            "has_swarm": False,
            "is_live": False,
            "active_count": 0,
            "working_count": 0,
            "title": "",
        }

    m_doc = _read_json_file_safe(sdir / "members.json")
    raw_members = m_doc.get("members") if isinstance(m_doc.get("members"), dict) else {}
    title = str(m_doc.get("title") or "").strip()
    if not title:
        p_doc = _read_json_file_safe(sdir / "plan.json")
        g_obj = p_doc.get("goal") if isinstance(p_doc.get("goal"), dict) else {}
        title = str(g_obj.get("title") or "").strip()

    active_count = 0
    worker_working = 0
    for nm, m_raw in raw_members.items():
        if not isinstance(m_raw, dict):
            continue
        st_str, killed = _classify_swarm_member_state(m_raw)
        if not killed:
            active_count += 1
            role = str(m_raw.get("role") or ("coordinator" if nm == "coordinator" else "worker")).strip().lower()
            if st_str == "working" and role != "coordinator" and str(nm).strip().lower() != "monitor":
                worker_working += 1

    is_live = (worker_working > 0) or (active_swarm_rec is not None)
    working_count = max(worker_working, 1 if active_swarm_rec is not None else 0)
    return {
        "has_swarm": True,
        "is_live": is_live,
        "active_count": active_count,
        "working_count": working_count,
        "title": _sanitize_swarm_snippet(title, 80),
    }


def load_conversation_swarm_status(cid: str, *, include_details: bool = True) -> dict[str, Any]:
    """Read-only full Swarm status payload (members, plan/threads, board tail, live worker actions)."""
    active_swarm_rec = _is_active_swarm_cli_run(cid)
    sdir, brain_root = _locate_swarm_dir(cid)

    if sdir is None:
        if active_swarm_rec is not None:
            title = _sanitize_swarm_snippet(str(active_swarm_rec.get("prompt") or "Swarm"), 64)
            mod = str(active_swarm_rec.get("model") or "").strip()
            return {
                "has_swarm": True,
                "is_live": True,
                "title": title,
                "goal": {"title": title, "line": ""},
                "active_count": 1,
                "working_count": 1,
                "total_members": 1,
                "killed_count": 0,
                "board_count": 0,
                "tasks_done": 0,
                "tasks_total": 1,
                "threads": [],
                "members": [{
                    "name": "coordinator",
                    "role": "coordinator",
                    "model": mod,
                    "state": "working",
                    "killed": False,
                    "last_post_seq": 0,
                    "last_post_preview": "",
                    "last_post_time": "",
                    "current_action": "正在启动蜂群协同...",
                    "task": "",
                    "color_idx": 0,
                }],
                "archived_members": [],
                "board": [],
            }
        return {
            "has_swarm": False,
            "is_live": False,
            "active_count": 0,
            "working_count": 0,
            "threads": [],
            "members": [],
            "archived_members": [],
            "board": [],
        }

    m_doc = _read_json_file_safe(sdir / "members.json")
    p_doc = _read_json_file_safe(sdir / "plan.json")
    raw_members = m_doc.get("members") if isinstance(m_doc.get("members"), dict) else {}
    plan_goal_raw = p_doc.get("goal") if isinstance(p_doc.get("goal"), dict) else {}
    plan_tasks_raw = p_doc.get("tasks") if isinstance(p_doc.get("tasks"), dict) else {}
    plan_threads_raw = p_doc.get("threads") if isinstance(p_doc.get("threads"), list) else []

    plan_tasks: dict[str, str] = {
        str(k).strip(): _sanitize_swarm_snippet(str(v or ""), 160)
        for k, v in plan_tasks_raw.items()
        if str(k).strip()
    }
    title = _sanitize_swarm_snippet(str(plan_goal_raw.get("title") or m_doc.get("title") or ""), 100)
    goal = {
        "title": title,
        "line": _sanitize_swarm_snippet(str(plan_goal_raw.get("line") or ""), 240),
    }

    # Parse board.jsonl (track total count, latest post per agent, and last 60 entries)
    board_count = 0
    board_tail_dq: collections.deque[dict[str, Any]] = collections.deque(maxlen=60)
    agent_last_post: dict[str, dict[str, Any]] = {}
    board_file = sdir / "board.jsonl"
    if include_details and board_file.is_file():
        try:
            with board_file.open("r", encoding="utf-8", errors="replace") as fh:
                for ln in fh:
                    s = ln.strip()
                    if not s:
                        continue
                    try:
                        row = json.loads(s)
                    except Exception:
                        continue
                    if not isinstance(row, dict):
                        continue
                    board_count += 1
                    seq_val = int(row.get("seq") or board_count)
                    agent_nm = str(row.get("agent") or "").strip()
                    raw_txt = str(row.get("text") or "")
                    clean_txt = _EMAIL_RE.sub("[redacted]", raw_txt)
                    if len(clean_txt) > 1200:
                        clean_txt = clean_txt[:1199] + "…"
                    t_str = str(row.get("time") or "").strip()[:32]
                    entry = {
                        "seq": seq_val,
                        "agent": agent_nm,
                        "text": clean_txt,
                        "time": t_str,
                    }
                    board_tail_dq.append(entry)
                    if agent_nm:
                        agent_last_post[agent_nm] = {
                            "seq": seq_val,
                            "preview": _sanitize_swarm_snippet(raw_txt, 90),
                            "time": t_str,
                            "has_done": "[done]" in raw_txt[:140].lower(),
                        }
        except OSError:
            pass

    # Deterministic bee palette indices: coordinator=0, active workers=1..5 sequentially, archived=hashed 1..5
    active_non_coord_names = sorted(
        nm for nm, m_raw in raw_members.items()
        if isinstance(m_raw, dict)
        and not _classify_swarm_member_state(m_raw)[1]
        and str(m_raw.get("role") or ("coordinator" if nm == "coordinator" else "worker")).lower() != "coordinator"
    )
    color_map: dict[str, int] = {"coordinator": 0}
    for idx, nm in enumerate(active_non_coord_names):
        color_map[nm] = 1 + (idx % 5)

    def _get_color_idx(nm: str, role: str) -> int:
        if role == "coordinator" or nm == "coordinator":
            return 0
        if nm in color_map:
            return color_map[nm]
        c_idx = 1 + (sum((i + 1) * ord(ch) for i, ch in enumerate(nm)) % 5)
        color_map[nm] = c_idx
        return c_idx

    all_member_map: dict[str, dict[str, Any]] = {}
    active_members: list[dict[str, Any]] = []
    archived_members: list[dict[str, Any]] = []
    worker_working = 0

    for nm, m_raw in raw_members.items():
        if not isinstance(m_raw, dict):
            continue
        name = str(nm).strip()
        if not name:
            continue
        role = str(m_raw.get("role") or ("coordinator" if name == "coordinator" else "worker")).strip().lower()
        state, killed = _classify_swarm_member_state(m_raw)
        model_id = str(m_raw.get("applied_model") or m_raw.get("model") or m_raw.get("desired_model") or "").strip()
        lp = agent_last_post.get(name) or {}
        cur_action = ""
        if include_details and not killed:
            cur_action = _read_member_current_action(str(m_raw.get("conversation_id") or ""), brain_root)
        item = {
            "name": name,
            "role": role,
            "model": model_id,
            "state": state,
            "killed": killed,
            "last_post_seq": int(lp.get("seq") or 0),
            "last_post_preview": str(lp.get("preview") or ""),
            "last_post_time": str(lp.get("time") or ""),
            "current_action": cur_action,
            "task": plan_tasks.get(name, ""),
            "color_idx": _get_color_idx(name, role),
        }
        all_member_map[name] = item
        if killed:
            archived_members.append(item)
        else:
            active_members.append(item)
            if state == "working" and role != "coordinator" and name.lower() != "monitor":
                worker_working += 1

    # Order active members: coordinator first, then working workers, then waiting/stopped workers, monitor last
    def _active_sort_key(it: dict[str, Any]) -> tuple[int, int, str]:
        if it["role"] == "coordinator" or it["name"] == "coordinator":
            return (0, 0, it["name"])
        if it["name"].lower() == "monitor":
            return (3, 0, it["name"])
        st_rank = 0 if it["state"] == "working" else (1 if it["state"] == "waiting" else 2)
        return (1, st_rank, it["name"])

    active_members.sort(key=_active_sort_key)
    archived_members.sort(key=lambda it: (-int(it["last_post_seq"]), it["name"]))

    def _is_member_done(name: str) -> bool:
        m_it = all_member_map.get(name)
        if m_it is None:
            return False
        if m_it["killed"]:
            return True
        lp = agent_last_post.get(name) or {}
        return m_it["state"] in ("waiting", "stopped") and bool(lp.get("has_done"))

    # Build threads list from plan.json
    threads_out: list[dict[str, Any]] = []
    for t_raw in plan_threads_raw:
        if not isinstance(t_raw, dict):
            continue
        tid = str(t_raw.get("id") or "").strip()[:48]
        t_title = _sanitize_swarm_snippet(str(t_raw.get("title") or tid), 100)
        t_goal = _sanitize_swarm_snippet(str(t_raw.get("goal") or ""), 220)
        t_task_names = [str(x).strip() for x in (t_raw.get("tasks") or []) if str(x).strip()]
        t_members: list[dict[str, Any]] = []
        done_cnt = 0
        any_working = False
        now_action = ""
        fallback_action = ""
        for m_name in t_task_names:
            m_it = all_member_map.get(m_name)
            m_state = str(m_it["state"]) if m_it else "waiting"
            m_cidx = int(m_it["color_idx"]) if m_it else _get_color_idx(m_name, "worker")
            m_task = (m_it.get("task") if m_it else "") or plan_tasks.get(m_name, "")
            t_members.append({
                "name": m_name,
                "state": m_state,
                "task": m_task,
                "color_idx": m_cidx,
            })
            if _is_member_done(m_name):
                done_cnt += 1
            if m_state == "working":
                any_working = True
                if not now_action and m_it and m_it.get("current_action"):
                    now_action = str(m_it["current_action"])
            if not fallback_action and m_it:
                fallback_action = str(m_it.get("current_action") or m_it.get("last_post_preview") or "")
        total_cnt = len(t_task_names)
        if total_cnt > 0 and done_cnt >= total_cnt:
            t_status = "done"
        elif any_working:
            t_status = "moving"
        else:
            t_status = "waiting"
        threads_out.append({
            "id": tid or f"thread-{len(threads_out) + 1}",
            "title": t_title,
            "goal": t_goal,
            "status": t_status,
            "done_count": done_cnt,
            "total_count": total_cnt,
            "now_action": now_action or fallback_action,
            "members": t_members,
        })

    all_task_names = {
        nm for nm, m_it in all_member_map.items()
        if m_it["role"] != "coordinator" and nm.lower() != "monitor"
    } | set(plan_tasks.keys())
    tasks_total = len(all_task_names)
    tasks_done = sum(1 for nm in all_task_names if _is_member_done(nm))

    is_live = (worker_working > 0) or (active_swarm_rec is not None)
    working_count = max(worker_working, 1 if active_swarm_rec is not None else 0)

    return {
        "has_swarm": True,
        "is_live": is_live,
        "title": title,
        "goal": goal,
        "active_count": len(active_members),
        "working_count": working_count,
        "total_members": len(all_member_map),
        "killed_count": len(archived_members),
        "board_count": board_count,
        "tasks_done": tasks_done,
        "tasks_total": tasks_total,
        "threads": threads_out,
        "members": active_members,
        "archived_members": archived_members,
        "board": list(board_tail_dq),
    }


def _parse_transcript_usage_file(tf: pathlib.Path) -> tuple[list[tuple[float, str, int, int, int]], int]:
    """Read-only mtime-cached extraction of (ts, model, input_tok, cache_tok, output_tok) + explicit user turns."""
    try:
        st = tf.stat()
    except OSError:
        return ([], 0)
    if st.st_size <= 0:
        return ([], 0)
    key = tf.as_posix()
    with _USAGE_CACHE_LOCK:
        cached = _USAGE_FILE_CACHE.get(key)
        if cached is not None and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return (cached[2], cached[3])

    records: list[tuple[float, str, int, int, int]] = []
    turns = 0
    try:
        with tf.open("r", encoding="utf-8", errors="ignore") as fh:
            for ln in fh:
                if '"PLANNER_RESPONSE"' in ln:
                    try:
                        obj = json.loads(ln)
                    except Exception:
                        continue
                    if obj.get("type") != "PLANNER_RESPONSE":
                        continue
                    in_t = int(obj.get("input_tokens") or 0)
                    ca_t = int(obj.get("cache_read_tokens") or 0)
                    out_t = int(obj.get("output_tokens") or 0)
                    if in_t <= 0 and ca_t <= 0 and out_t <= 0:
                        continue
                    ts = _parse_iso_ts(str(obj.get("created_at") or ""))
                    if ts <= 0.0:
                        ts = float(st.st_mtime)
                    mod = str(obj.get("model") or "unknown").strip()
                    records.append((ts, mod, max(0, in_t), max(0, ca_t), max(0, out_t)))
                elif '"USER_INPUT"' in ln and '"USER_EXPLICIT"' in ln:
                    turns += 1
    except OSError:
        return ([], 0)

    with _USAGE_CACHE_LOCK:
        if len(_USAGE_FILE_CACHE) >= _USAGE_CACHE_MAX:
            # Drop oldest inserted quarter
            for drop_k in list(_USAGE_FILE_CACHE.keys())[: _USAGE_CACHE_MAX // 4]:
                _USAGE_FILE_CACHE.pop(drop_k, None)
        _USAGE_FILE_CACHE[key] = (st.st_mtime_ns, st.st_size, records, turns)
    return (records, turns)


def _aggregate_usage_bucket(
    records: list[tuple[float, str, int, int, int]],
    turns: int = 0,
    *,
    window_sec: float | None = None,
    daily_days: int = 0,
) -> dict[str, Any]:
    total_in = 0
    total_cache = 0
    total_out = 0
    total_cost_usd = 0.0
    total_quota_pct = 0.0
    steps = 0
    oldest_ts = 0.0
    pools_acc: dict[str, dict[str, Any]] = {}
    models_acc: dict[str, dict[str, Any]] = {}
    daily_acc: dict[str, dict[str, Any]] = {}

    for ts, mod, in_t, ca_t, out_t in records:
        if not _is_antigravity_usage_model(mod):
            continue
        steps += 1
        total_in += in_t
        total_cache += ca_t
        total_out += out_t
        tot = in_t + ca_t + out_t
        step_usd, step_qpct = _calc_step_cost_and_quota(mod, in_t, ca_t, out_t)
        total_cost_usd += step_usd
        total_quota_pct += step_qpct
        if ts > 0.0 and (oldest_ts == 0.0 or ts < oldest_ts):
            oldest_ts = ts

        pid, plabel = _classify_usage_pool(mod)
        pa = pools_acc.get(pid)
        if pa is None:
            pa = {
                "id": pid, "label": plabel, "steps": 0,
                "input_tokens": 0, "cache_read_tokens": 0, "output_tokens": 0, "total_tokens": 0,
                "cost_usd": 0.0, "quota_used_est_pct": 0.0,
            }
            pools_acc[pid] = pa
        pa["steps"] += 1
        pa["input_tokens"] += in_t
        pa["cache_read_tokens"] += ca_t
        pa["output_tokens"] += out_t
        pa["total_tokens"] += tot
        pa["cost_usd"] += step_usd
        pa["quota_used_est_pct"] += step_qpct

        ma = models_acc.get(mod)
        if ma is None:
            ma = {
                "model": mod, "steps": 0,
                "input_tokens": 0, "cache_read_tokens": 0, "output_tokens": 0, "total_tokens": 0,
                "cost_usd": 0.0, "quota_used_est_pct": 0.0,
            }
            models_acc[mod] = ma
        ma["steps"] += 1
        ma["input_tokens"] += in_t
        ma["cache_read_tokens"] += ca_t
        ma["output_tokens"] += out_t
        ma["total_tokens"] += tot
        ma["cost_usd"] += step_usd
        ma["quota_used_est_pct"] += step_qpct

        if daily_days > 0 and ts > 0.0:
            day_key = datetime.fromtimestamp(ts).strftime("%m-%d")
            da = daily_acc.get(day_key)
            if da is None:
                da = {"date": day_key, "steps": 0, "total_tokens": 0, "input_tokens": 0, "output_tokens": 0, "cost_cny": 0.0}
                daily_acc[day_key] = da
            da["steps"] += 1
            da["total_tokens"] += tot
            da["input_tokens"] += in_t
            da["output_tokens"] += out_t
            da["cost_cny"] += step_usd * _USD_TO_CNY

    total_all = total_in + total_cache + total_out
    prompt_total = total_in + total_cache
    cache_hit_pct = round((total_cache * 100.0 / prompt_total), 1) if prompt_total > 0 else 0.0

    pools_list = sorted(pools_acc.values(), key=lambda x: x["total_tokens"], reverse=True)
    for p_item in pools_list:
        p_in_ca = p_item["input_tokens"] + p_item["cache_read_tokens"]
        p_item["cache_hit_pct"] = round((p_item["cache_read_tokens"] * 100.0 / p_in_ca), 1) if p_in_ca > 0 else 0.0
        p_item["share_pct"] = round((p_item["total_tokens"] * 100.0 / total_all), 1) if total_all > 0 else 0.0
        p_item["cost_usd"] = round(p_item["cost_usd"], 4)
        p_item["cost_cny"] = round(p_item["cost_usd"] * _USD_TO_CNY, 2)
        p_item["quota_used_est_pct"] = round(p_item["quota_used_est_pct"], 2)

    models_list = sorted(models_acc.values(), key=lambda x: x["total_tokens"], reverse=True)[:12]
    for m_item in models_list:
        m_item["cost_usd"] = round(m_item["cost_usd"], 4)
        m_item["cost_cny"] = round(m_item["cost_usd"] * _USD_TO_CNY, 2)
        m_item["quota_used_est_pct"] = round(m_item["quota_used_est_pct"], 2)

    out_dict: dict[str, Any] = {
        "steps": steps,
        "turns": turns,
        "input_tokens": total_in,
        "cache_read_tokens": total_cache,
        "output_tokens": total_out,
        "total_tokens": total_all,
        "cache_hit_pct": cache_hit_pct,
        "cost_usd": round(total_cost_usd, 4),
        "cost_cny": round(total_cost_usd * _USD_TO_CNY, 2),
        "quota_used_est_pct": round(total_quota_pct, 2),
        "pools": pools_list,
        "models": models_list,
    }
    if window_sec is not None and oldest_ts > 0.0:
        relief_ts = oldest_ts + window_sec
        out_dict["oldest_ts"] = oldest_ts
        out_dict["relief_at"] = datetime.fromtimestamp(relief_ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if daily_days > 0:
        now_dt = datetime.now()
        daily_series: list[dict[str, Any]] = []
        for off in range(daily_days - 1, -1, -1):
            d_key = datetime.fromtimestamp(now_dt.timestamp() - off * 86400.0).strftime("%m-%d")
            item = daily_acc.get(d_key, {"date": d_key, "steps": 0, "total_tokens": 0, "input_tokens": 0, "output_tokens": 0, "cost_cny": 0.0})
            item = dict(item)
            item["cost_cny"] = round(float(item.get("cost_cny") or 0.0), 2)
            daily_series.append(item)
        out_dict["daily"] = daily_series
    return out_dict


def _fetch_optional_external_quota() -> dict[str, Any] | None:
    """Fetch Antigravity-ONLY live remaining quota from either user-configured AGY_QUOTA_API_URL
    or optional local bridge (127.0.0.1:8788/api/status). Never exposes personal emails or third-party APIs."""
    cfg = load_or_create_config()
    raw_url = str(os.environ.get("AGY_QUOTA_API_URL") or cfg.get("quota_api_url") or "").strip()
    if raw_url:
        try:
            pu = urllib.parse.urlparse(raw_url)
            host_lc = (pu.hostname or "").lower()
            is_local = pu.scheme == "http" and host_lc in ("127.0.0.1", "localhost", "::1")
            is_https = pu.scheme == "https" and bool(host_lc)
            if is_local or is_https:
                req = urllib.request.Request(raw_url, headers={"Accept": "application/json"}, method="GET")
                opener = _DIRECT_OPENER if is_local else urllib.request.build_opener()
                with opener.open(req, timeout=3.0) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read(262144).decode("utf-8", errors="replace"))
                        if isinstance(data, dict) and isinstance(data.get("pools"), list):
                            clean_pools: list[dict[str, Any]] = []
                            for p in data["pools"][:16]:
                                if not isinstance(p, dict):
                                    continue
                                clean_pools.append({
                                    "name": str(p.get("name") or p.get("label") or "")[:56],
                                    "remaining_pct": float(p["remaining_pct"]) if p.get("remaining_pct") is not None else None,
                                    "h5_pct": float(p["h5_pct"]) if p.get("h5_pct") is not None else None,
                                    "weekly_pct": float(p["weekly_pct"]) if p.get("weekly_pct") is not None else None,
                                    "reset_at": str(p.get("reset_at") or p.get("reset_time") or "")[:48],
                                    "h5_reset_at": str(p.get("h5_reset_at") or p.get("h5_reset_time") or "")[:48],
                                    "weekly_reset_at": str(p.get("weekly_reset_at") or p.get("weekly_reset_time") or "")[:48],
                                    "note": str(p.get("note") or "")[:80],
                                })
                            return {"source": str(data.get("source") or "custom")[:48], "plan": str(data.get("plan") or "")[:48], "pools": clean_pools}
        except Exception:
            pass

    # Automatic fallback: optional local companion bridge on 127.0.0.1:8788 (Antigravity pools ONLY, generous 3.5s timeout + stale cache)
    bridge = _fetch_local_bridge_status(force=False, timeout_sec=3.5, allow_stale=True)
    if not isinstance(bridge, dict):
        return None
    quotas = bridge.get("quotas")
    if not isinstance(quotas, dict):
        return None
    raw_pools = quotas.get("pools")
    if not isinstance(raw_pools, dict):
        return None

    acct = quotas.get("account") if isinstance(quotas.get("account"), dict) else {}
    plan = str(acct.get("plan") or "").strip()[:48]
    agy_pool_specs = [
        ("gemini", "Gemini 4 共享池 (Neon / Hydrogen / Carbon / Flash)"),
        ("opus", "Claude 5.5 池 (Opus 5.5 / Sonnet 5.5)"),
        ("argon", "Gemini 4 Argon 独立池"),
    ]
    out_pools: list[dict[str, Any]] = []
    for key, default_label in agy_pool_specs:
        p = raw_pools.get(key)
        if not isinstance(p, dict):
            continue
        rem = p.get("remaining_pct")
        h5 = p.get("h5_pct")
        wk = p.get("weekly_pct")
        if rem is None and h5 is None and wk is None:
            continue
        out_pools.append({
            "id": key,
            "name": str(p.get("name") or default_label)[:64],
            "remaining_pct": round(float(rem), 1) if rem is not None else None,
            "h5_pct": round(float(h5), 1) if h5 is not None else None,
            "weekly_pct": round(float(wk), 1) if wk is not None else None,
            "reset_at": str(p.get("reset_time") or p.get("reset_at") or "")[:48],
            "h5_reset_at": str(p.get("h5_reset_time") or p.get("h5_reset_at") or "")[:48],
            "weekly_reset_at": str(p.get("weekly_reset_time") or p.get("weekly_reset_at") or "")[:48],
            "note": str(p.get("remaining_text") or "")[:80],
        })
    if not out_pools:
        return None
    return {
        "source": "Antigravity 实时额度",
        "plan": plan,
        "live": bool(quotas.get("ls_quota_live", True)),
        "pools": out_pools,
    }


def _compute_global_usage_buckets(now: float) -> dict[str, Any]:
    local_now = datetime.now()
    today_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    cut_7d = now - 7.0 * 86400.0
    cut_3d = now - 3.0 * 86400.0
    cut_24h = now - 86400.0
    cut_5h = now - 5.0 * 3600.0

    rec_5h: list[tuple[float, str, int, int, int]] = []
    rec_today: list[tuple[float, str, int, int, int]] = []
    rec_24h: list[tuple[float, str, int, int, int]] = []
    rec_3d: list[tuple[float, str, int, int, int]] = []
    rec_7d: list[tuple[float, str, int, int, int]] = []
    rec_all: list[tuple[float, str, int, int, int]] = []
    daily_map: dict[str, dict[str, Any]] = {}
    daily_conv_sets: dict[str, set[str]] = {}
    scanned_convs = 0
    seen_paths: set[str] = set()

    for root in (DESKTOP_BRAIN, CLI_BRAIN):
        if not root.is_dir():
            continue
        try:
            with os.scandir(root) as it:
                for e in it:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    tf = pathlib.Path(e.path) / ".system_generated" / "logs" / "transcript.jsonl"
                    try:
                        st = tf.stat()
                    except OSError:
                        continue
                    if st.st_size <= 0:
                        continue
                    norm_p = tf.as_posix()
                    if norm_p in seen_paths:
                        continue
                    seen_paths.add(norm_p)
                    recs, _ = _parse_transcript_usage_file(tf)
                    if not recs:
                        continue
                    conv_has_agy = False
                    for r in recs:
                        ts, mod, in_t, ca_t, out_t = r
                        if not _is_antigravity_usage_model(mod):
                            continue
                        conv_has_agy = True
                        rec_all.append(r)
                        if ts >= cut_7d:
                            rec_7d.append(r)
                            if ts >= cut_3d:
                                rec_3d.append(r)
                            if ts >= cut_24h:
                                rec_24h.append(r)
                            if ts >= today_midnight:
                                rec_today.append(r)
                            if ts >= cut_5h:
                                rec_5h.append(r)
                        if ts > 0.0:
                            day_iso = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
                            d_rec = daily_map.get(day_iso)
                            if d_rec is None:
                                d_rec = {
                                    "date": day_iso,
                                    "steps": 0,
                                    "input_tokens": 0,
                                    "cache_read_tokens": 0,
                                    "output_tokens": 0,
                                    "total_tokens": 0,
                                    "cost_usd": 0.0,
                                    "cost_cny": 0.0,
                                    "quota_used_est_pct": 0.0,
                                }
                                daily_map[day_iso] = d_rec
                            step_usd, step_qpct = _calc_step_cost_and_quota(mod, in_t, ca_t, out_t)
                            d_rec["steps"] += 1
                            d_rec["input_tokens"] += in_t
                            d_rec["cache_read_tokens"] += ca_t
                            d_rec["output_tokens"] += out_t
                            d_rec["total_tokens"] += in_t + ca_t + out_t
                            d_rec["cost_usd"] += step_usd
                            d_rec["cost_cny"] += step_usd * _USD_TO_CNY
                            d_rec["quota_used_est_pct"] += step_qpct
                            daily_conv_sets.setdefault(day_iso, set()).add(norm_p)
                    if conv_has_agy:
                        scanned_convs += 1
        except OSError:
            continue

    daily_calendar: list[dict[str, Any]] = []
    for day_iso in sorted(daily_map.keys()):
        d_item = dict(daily_map[day_iso])
        p_tot = d_item["input_tokens"] + d_item["cache_read_tokens"]
        d_item["cache_hit_pct"] = round((d_item["cache_read_tokens"] * 100.0 / p_tot), 1) if p_tot > 0 else 0.0
        d_item["cost_usd"] = round(float(d_item["cost_usd"]), 4)
        d_item["cost_cny"] = round(float(d_item["cost_cny"]), 2)
        d_item["quota_used_est_pct"] = round(float(d_item["quota_used_est_pct"]), 2)
        d_item["conversations"] = len(daily_conv_sets.get(day_iso) or ())
        daily_calendar.append(d_item)

    window_all = _aggregate_usage_bucket(rec_all)
    window_all["first_date"] = daily_calendar[0]["date"] if daily_calendar else ""
    window_all["last_date"] = daily_calendar[-1]["date"] if daily_calendar else ""
    window_all["active_days"] = len(daily_calendar)
    window_all["total_conversations"] = scanned_convs

    return {
        "scanned_conversations": scanned_convs,
        "total_conversations": scanned_convs,
        "window_5h": _aggregate_usage_bucket(rec_5h, window_sec=5.0 * 3600.0),
        "window_today": _aggregate_usage_bucket(rec_today, window_sec=86400.0),
        "window_24h": _aggregate_usage_bucket(rec_24h, window_sec=86400.0),
        "window_3d": _aggregate_usage_bucket(rec_3d, window_sec=3.0 * 86400.0, daily_days=3),
        "window_7d": _aggregate_usage_bucket(rec_7d, window_sec=7.0 * 86400.0, daily_days=7),
        "window_all": window_all,
        "daily_calendar": daily_calendar,
    }


def compute_usage_summary(current_cid: str = "", force: bool = False) -> dict[str, Any]:
    global _USAGE_GLOBAL_CACHE
    now = time.time()
    cached_global: dict[str, Any] | None = None
    if not force:
        with _USAGE_GLOBAL_CACHE_LOCK:
            if _USAGE_GLOBAL_CACHE is not None and (now - _USAGE_GLOBAL_CACHE[0]) < _USAGE_GLOBAL_TTL_SEC:
                cached_global = _USAGE_GLOBAL_CACHE[1]
    if cached_global is None:
        cached_global = _compute_global_usage_buckets(now)
        with _USAGE_GLOBAL_CACHE_LOCK:
            _USAGE_GLOBAL_CACHE = (now, cached_global)

    conv_usage: dict[str, Any] | None = None
    if current_cid and _is_valid_cid(current_cid):
        conv_recs: list[tuple[float, str, int, int, int]] = []
        conv_turns = 0
        conv_files: list[pathlib.Path] = []
        tf_main, src_main = _locate_transcript(current_cid)
        if tf_main is not None:
            conv_files.append(tf_main)
        if src_main == "desktop":
            aliased = get_desktop_cli_alias(current_cid)
            if aliased and aliased != current_cid:
                tf_cli = CLI_BRAIN / aliased / ".system_generated" / "logs" / "transcript.jsonl"
                if tf_cli.is_file():
                    conv_files.append(tf_cli)
        elif src_main == "mobile":
            parent_d = get_desktop_parent_for_cli(current_cid)
            if parent_d and parent_d != current_cid:
                tf_d = DESKTOP_BRAIN / parent_d / ".system_generated" / "logs" / "transcript.jsonl"
                if tf_d.is_file():
                    conv_files.append(tf_d)
        for cf in conv_files:
            r_list, t_cnt = _parse_transcript_usage_file(cf)
            conv_recs.extend(r_list)
            conv_turns += t_cnt
        conv_usage = _aggregate_usage_bucket(conv_recs, turns=conv_turns)
        conv_usage["conversation_id"] = current_cid

    return {
        "ok": True,
        "generated_at": datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scanned_conversations": cached_global["scanned_conversations"],
        "total_conversations": cached_global["total_conversations"],
        "window_5h": cached_global["window_5h"],
        "window_today": cached_global["window_today"],
        "window_24h": cached_global["window_24h"],
        "window_3d": cached_global["window_3d"],
        "window_7d": cached_global["window_7d"],
        "window_all": cached_global["window_all"],
        "daily_calendar": cached_global["daily_calendar"],
        "current_conversation": conv_usage,
        "external_quota": _fetch_optional_external_quota(),
    }


async def handle_usage(request: web.Request) -> web.Response:
    cid = str(request.query.get("cid") or "").strip()
    if cid and not _is_valid_cid(cid):
        cid = ""
    force = str(request.query.get("force") or "").strip().lower() in ("1", "true", "yes")
    summary = await asyncio.to_thread(compute_usage_summary, cid, force)
    return web.json_response(summary)


async def handle_ws(request: web.Request) -> web.StreamResponse:
    for w in list(_WS_CLIENTS):
        if w.closed:
            _WS_CLIENTS.discard(w)
    if len(_WS_CLIENTS) >= _MAX_WS_CLIENTS:
        return web.json_response({"ok": False, "error": "WebSocket 连接数已达上限"}, status=503)
    ws = web.WebSocketResponse(heartbeat=25.0)
    await ws.prepare(request)
    _WS_CLIENTS.add(ws)
    try:
        await ws.send_str(json.dumps({"type": "hello", "ts": time.time()}))
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    if isinstance(data, dict) and data.get("type") == "ping":
                        await ws.send_str(json.dumps({"type": "pong", "ts": time.time()}))
                except Exception:
                    pass
    finally:
        _WS_CLIENTS.discard(ws)
    return ws


async def handle_download_apk(_request: web.Request) -> web.StreamResponse:
    apk_p = DIST_DIR / APK_FILENAME
    if not apk_p.is_file():
        return web.Response(status=404, text=f"{APK_FILENAME} not built yet")
    resp = web.FileResponse(apk_p)
    resp.headers["Content-Type"] = "application/vnd.android.package-archive"
    resp.headers["Content-Disposition"] = f'attachment; filename="{APK_FILENAME}"'
    return resp


def _js_lit(val: Any) -> str:
    """Safely serialize a Python value into an inline <script> JS literal."""
    return (
        json.dumps(val, ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


async def handle_pair_page(request: web.Request) -> web.Response:
    if not _is_strict_loopback_request(request, allow_same_origin_iframe=True):
        return web.Response(
            status=403,
            text=f"为保护您的访问令牌安全，/pair 配对页面仅允许在电脑本机打开，请在电脑浏览器访问 http://127.0.0.1:{PORT}/pair",
            content_type="text/plain",
            headers={"Cache-Control": "no-store", "Vary": "Origin", "X-Frame-Options": "DENY"},
        )
    cfg = load_or_create_config()
    lans = await asyncio.to_thread(detect_connect_endpoints)
    tun = get_tunnel_snapshot()
    hostname = socket.gethostname()
    token = str(cfg.get("token") or "")
    pin = get_pair_pin()

    selected_ip = str(request.query.get("ip") or "").strip()
    active_entry = None
    if selected_ip:
        for item in lans:
            if item["ip"] == selected_ip:
                active_entry = item
                break
    if active_entry is None:
        active_entry = lans[0] if lans else {"iface": "Localhost", "ip": "127.0.0.1", "url": f"http://127.0.0.1:{PORT}", "kind": "lan"}

    active_url = active_entry["url"]
    alt_urls = [str(ep.get("url") or "") for ep in lans if ep.get("url") and str(ep.get("url")) != active_url]
    pair_uri = build_pair_uri(active_url, token, hostname, alt_urls=alt_urls)
    qr_svg = await asyncio.to_thread(render_qr_svg, pair_uri, "#131314", "#EAECEF")

    apk_p = DIST_DIR / APK_FILENAME
    if apk_p.is_file():
        apk_mb = apk_p.stat().st_size / (1024 * 1024)
        apk_badge = f"已就绪 · {apk_mb:.2f} MB"
        apk_btn_cls = "m3-btn-filled"
        apk_btn_label = f"下载 {APK_FILENAME}"
    else:
        apk_badge = "等待构建中"
        apk_btn_cls = "m3-btn-tonal"
        apk_btn_label = f"下载 {APK_FILENAME}（构建完成后可用）"

    kind_labels = {
        "permanent": "永久固定公网域名（重启/断网重连不变，强烈推荐）",
        "tunnel": "Cloudflare 加密公网直连（推荐：免 Tailscale，手机可同时挂 v2rayNG / 校园网 / 5G）",
        "lan": "同 Wi-Fi 局域网（家里直连可选；校园网若隔离请用公网隧道）",
        "tailscale": "Tailscale 内网穿透（需手机端切 Tailscale）",
        "vpn": "电脑 VPN 网卡（手机通常不可直连）",
        "other": "网络接口",
    }
    tun_status = str(tun.get("status") or "disabled")
    tun_error = str(tun.get("error") or "").strip()
    tun_ready_cnt = int(tun.get("ready_connections") or 0)
    tun_hint_html = ""
    if tun_status == "online" and tun.get("url"):
        ready_lbl = f" · {tun_ready_cnt} 通道" if tun_ready_cnt > 0 else ""
        tun_pill_html = f'<span class="pill pill-green"><span class="dot"></span>公网隧道在线（免VPN{ready_lbl}）</span>'
    elif tun_status == "reconnecting":
        tun_pill_html = '<span class="pill pill-warn">公网隧道断连 · 自动自愈中…</span>'
        tun_hint_html = (
            '<div class="tun-hint">检测到 Cloudflare 边缘连接已断开（常见于电脑休眠醒来或代理切换），'
            '后台守护正在自动自愈重连，页面将在数秒后自动刷新出新二维码；也可直接点右上角「重连隧道」立即刷新。</div>'
        )
    elif tun_status == "starting":
        tun_pill_html = '<span class="pill pill-host">公网隧道建连中…</span>'
    elif tun_status == "missing":
        tun_pill_html = '<span class="pill pill-warn">未安装 cloudflared · 仅局域网</span>'
        tun_hint_html = (
            '<div class="tun-hint">未检测到 <code>cloudflared</code>，当前已自动回退为同 Wi-Fi 局域网配对。'
            '如需 5G / 校园网免 VPN 公网直连，请将 <code>cloudflared.exe</code>（或 macOS/Linux 二进制）'
            '放入项目 <code>bin/</code> 目录或系统 PATH 后点击右上角「重连隧道」。</div>'
        )
    elif tun_status == "disabled":
        tun_pill_html = '<span class="pill pill-host">公网隧道已关闭 · 局域网模式</span>'
        tun_hint_html = (
            '<div class="tun-hint">公网隧道当前已通过配置或环境变量关闭，请确保手机与电脑处于同一局域网后扫码或输入 6 位配对码。</div>'
        )
    else:
        tun_pill_html = '<span class="pill pill-warn">公网隧道未就绪</span>'
        err_desc = html_lib.escape(tun_error) if tun_error else "连接 Cloudflare 边缘节点失败"
        tun_hint_html = (
            f'<div class="tun-hint">公网隧道暂不可用：{err_desc}。可先使用下方局域网地址扫码，或点击右上角「重连隧道」重试。</div>'
        )
    chips_html_parts: list[str] = []
    addrs_html_parts: list[str] = []
    for item in lans:
        is_active = item["ip"] == active_entry["ip"]
        k_txt = kind_labels.get(item.get("kind", "lan"), "网络")
        esc_iface = html_lib.escape(item["iface"])
        esc_ip = html_lib.escape(item["ip"])
        esc_url = html_lib.escape(item["url"])
        cls = "iface-chip active" if is_active else "iface-chip"
        chip_lbl = f'{esc_iface} ★' if item.get("kind") in ("tunnel", "permanent") else f'{esc_iface} · {esc_ip}'
        chips_html_parts.append(
            f'<a class="{cls}" href="/pair?ip={urllib.parse.quote(item["ip"])}">'
            f'{chip_lbl}</a>'
        )
        addrs_html_parts.append(
            f'<div class="addr-row">'
            f'<div class="addr-meta"><span class="addr-iface">{esc_iface}</span>'
            f'<span class="addr-kind">{html_lib.escape(k_txt)}</span></div>'
            f'<div class="addr-right"><code class="addr-url">{esc_url}</code>'
            f'<button class="copy-mini" type="button" data-copy="{esc_url}">复制</button></div>'
            f"</div>"
        )
    if not addrs_html_parts:
        fallback_u = html_lib.escape(f"http://127.0.0.1:{PORT}")
        addrs_html_parts.append(
            f'<div class="addr-row"><div class="addr-meta"><span class="addr-iface">本机回环</span>'
            f'<span class="addr-kind">未检测到局域网 IP</span></div>'
            f'<div class="addr-right"><code class="addr-url">{fallback_u}</code>'
            f'<button class="copy-mini" type="button" data-copy="{fallback_u}">复制</button></div></div>'
        )

    pin_digits_html = "".join(
        f'<span class="pin-box">{html_lib.escape(ch)}</span>' for ch in pin
    )
    esc_host = html_lib.escape(hostname)
    esc_uri = html_lib.escape(pair_uri)
    esc_active_url = html_lib.escape(active_url)
    esc_token = html_lib.escape(token)
    esc_apk_name = html_lib.escape(APK_FILENAME)
    js_token = _js_lit(token)
    js_tun_status = _js_lit(tun_status)

    page_html = f"""<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="/favicon.ico">
<title>配对设备 · {APP_NAME}</title>
<script>
try {{
  var saved = localStorage.getItem('agylink_pair_theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
}} catch (_) {{}}
</script>
<style>
:root, [data-theme="dark"] {{
  --bg: #131314;
  --surface: #1E1F20;
  --surface-container: #282A2C;
  --surface-high: #333537;
  --primary: #A8C7FA;
  --primary-hover: #8AB4F8;
  --on-primary: #062E6F;
  --primary-container: #0842A0;
  --primary-container-hover: #0B57D0;
  --on-primary-container: #D3E3FD;
  --text: #E3E3E3;
  --text-2: #B8BCBA;
  --outline: #3C4043;
  --green-bg: #143622;
  --green-fg: #81C995;
  --dot: #81C995;
  --qr-bg: #EAECEF;
  --toast-bg: #E3E3E3;
  --toast-fg: #131314;
  --ease: cubic-bezier(0.2, 0, 0, 1);
}}
[data-theme="light"] {{
  --bg: #F8F9FA;
  --surface: #FFFFFF;
  --surface-container: #F0F4F9;
  --surface-high: #E9EEF6;
  --primary: #0B57D0;
  --primary-hover: #0842A0;
  --on-primary: #FFFFFF;
  --primary-container: #D3E3FD;
  --primary-container-hover: #C2D7FC;
  --on-primary-container: #041E49;
  --text: #1F1F1F;
  --text-2: #444746;
  --outline: #DFE3EB;
  --green-bg: #E6F4EA;
  --green-fg: #137333;
  --dot: #1E8E3E;
  --qr-bg: #FFFFFF;
  --toast-bg: #303030;
  --toast-fg: #FFFFFF;
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}}
.prism-bar {{
  height: 3px;
  width: 100%;
  background: linear-gradient(90deg, #4285F4 0%, #9B6BFF 34%, #34A853 68%, #FBBC05 100%);
}}
.wrap {{
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 20px 56px;
}}
.header {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 24px;
}}
.brand {{
  display: flex;
  align-items: center;
  gap: 14px;
}}
.logo {{
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--outline);
  display: grid;
  place-items: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}}
.title-group h1 {{
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}}
.title-group p {{
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--text-2);
}}
.status-row {{
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}}
.pill {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
}}
.pill-green {{ background: var(--green-bg); color: var(--green-fg); }}
.pill-host {{ background: var(--surface-container); color: var(--text); }}
.pill-warn {{ background: rgba(251, 188, 5, 0.16); color: #F5B400; border: 1px solid rgba(251, 188, 5, 0.35); }}
[data-theme="light"] .pill-warn {{ background: #FEF7E0; color: #B06000; border-color: #F6D88C; }}
.tun-hint {{
  margin: 0 0 18px;
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--surface-container);
  border: 1px solid var(--outline);
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.55;
}}
.tun-hint code {{
  background: var(--surface);
  padding: 1px 6px;
  border-radius: 6px;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
}}
.theme-toggle {{
  background: var(--surface-container);
  color: var(--text);
  border: 1px solid var(--outline);
  cursor: pointer;
  font-family: inherit;
  transition: background 0.18s var(--ease);
}}
.theme-toggle:hover {{ background: var(--surface-high); }}
.dot {{ width: 8px; height: 8px; border-radius: 50%; background: var(--dot); }}

.grid {{
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  gap: 20px;
  align-items: start;
}}
@media (max-width: 780px) {{
  .grid {{ grid-template-columns: 1fr; }}
}}
.stack {{ display: flex; flex-direction: column; gap: 20px; }}
.card {{
  background: var(--surface);
  border: 1px solid var(--outline);
  border-radius: 28px;
  padding: 24px;
}}
.card-eyebrow {{
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
  background: var(--primary-container);
  color: var(--on-primary-container);
  padding: 4px 12px;
  border-radius: 999px;
  margin-bottom: 10px;
}}
.card h2 {{
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
}}
.card .sub {{
  margin: 0 0 18px;
  font-size: 13.5px;
  color: var(--text-2);
}}
.qr-stage {{
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--surface-container);
  border-radius: 24px;
  padding: 22px 18px 18px;
  margin-bottom: 16px;
}}
.qr-frame {{
  background: var(--qr-bg);
  padding: 12px;
  border-radius: 20px;
  border: 1px solid var(--outline);
  line-height: 0;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.22);
}}
.qr-frame svg {{
  width: 224px;
  height: 224px;
  max-width: 100%;
  height: auto;
  display: block;
}}
.qr-target {{
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--text-2);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}}
.iface-chips {{
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}}
.iface-chip {{
  text-decoration: none;
  font-size: 12.5px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--surface-container);
  color: var(--text-2);
  border: 1px solid transparent;
  transition: all 0.18s var(--ease);
}}
.iface-chip:hover {{ background: var(--surface-high); color: var(--text); }}
.iface-chip.active {{
  background: var(--primary-container);
  color: var(--on-primary-container);
  font-weight: 600;
}}
.actions-row {{
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}}
.m3-btn-filled, .m3-btn-tonal, .m3-btn-outline {{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 11px 20px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  border: none;
  transition: background 0.18s var(--ease), transform 0.12s var(--ease);
}}
.m3-btn-filled {{
  background: var(--primary);
  color: var(--on-primary);
  width: 100%;
}}
.m3-btn-filled:hover {{ background: var(--primary-hover); }}
.m3-btn-tonal {{
  background: var(--primary-container);
  color: var(--on-primary-container);
  flex: 1;
}}
.m3-btn-tonal:hover {{ background: var(--primary-container-hover); }}
.m3-btn-outline {{
  background: var(--surface);
  color: var(--primary);
  border: 1px solid var(--outline);
}}
.m3-btn-outline:hover {{ background: var(--surface-container); }}

.pin-row {{
  display: flex;
  gap: 8px;
  justify-content: space-between;
  margin: 14px 0 16px;
}}
.pin-box {{
  flex: 1;
  height: 54px;
  display: grid;
  place-items: center;
  background: var(--surface-container);
  border-radius: 16px;
  font-size: 26px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}}
.addr-list {{
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}}
.addr-row {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  background: var(--surface-container);
  border-radius: 16px;
  flex-wrap: wrap;
}}
.addr-meta {{ display: flex; flex-direction: column; }}
.addr-iface {{ font-size: 13px; font-weight: 600; color: var(--text); }}
.addr-kind {{ font-size: 11.5px; color: var(--text-2); }}
.addr-right {{ display: flex; align-items: center; gap: 8px; }}
.addr-url {{
  font-size: 12.5px;
  color: var(--primary);
  background: var(--surface);
  padding: 4px 10px;
  border-radius: 10px;
  border: 1px solid var(--outline);
}}
.copy-mini {{
  border: none;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--outline);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}}
.copy-mini:hover {{ background: var(--primary-container); color: var(--on-primary-container); border-color: transparent; }}

.apk-meta {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--surface-container);
  padding: 12px 16px;
  border-radius: 16px;
  margin-bottom: 14px;
  font-size: 13px;
}}
.apk-name {{ font-weight: 600; word-break: break-all; }}
.apk-badge {{ color: var(--green-fg); font-weight: 600; white-space: nowrap; margin-left: 10px; }}

details.adv {{
  margin-top: 18px;
  background: var(--surface);
  border: 1px solid var(--outline);
  border-radius: 20px;
  padding: 14px 20px;
}}
details.adv summary {{
  cursor: pointer;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-2);
  list-style: none;
}}
.adv-body {{
  margin-top: 12px;
  font-size: 13px;
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}}
.adv-code {{
  display: block;
  background: var(--surface-container);
  padding: 10px 12px;
  border-radius: 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  color: var(--text);
  word-break: break-all;
}}
.footer-links {{
  margin-top: 22px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 13px;
  color: var(--text-2);
}}
.footer-links a {{ color: var(--primary); text-decoration: none; font-weight: 500; }}
.footer-links a:hover {{ text-decoration: underline; }}

.toast {{
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%) translateY(20px);
  background: var(--toast-bg);
  color: var(--toast-fg);
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 13px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}}
.toast.show {{ opacity: 1; transform: translateX(-50%) translateY(0); }}
</style>
</head>
<body>
<div class="prism-bar"></div>
<div class="wrap">
  <header class="header">
    <div class="brand">
      <div class="logo" aria-hidden="true">
        <img src="/logo-mark.png" alt="Antigravity" width="30" height="30" style="display:block;object-fit:contain;">
      </div>
      <div class="title-group">
        <h1>{APP_NAME}</h1>
        <p>通用手机伴侣服务端 · 扫码或输入 6 位配对码即可安全连接你的电脑</p>
      </div>
    </div>
    <div class="status-row">
      <span class="pill pill-green"><span class="dot"></span>在线 · 端口 {PORT}</span>
      {tun_pill_html}
      <span class="pill pill-host">主机：{esc_host}</span>
      <button class="pill theme-toggle" type="button" id="restartTunnelBtn" title="重新连接 Cloudflare 公网隧道">重连隧道</button>
      <button class="pill theme-toggle" type="button" id="themeToggleBtn" aria-label="切换深浅色主题">深色</button>
    </div>
  </header>

  {tun_hint_html}

  <main class="grid">
    <section class="card">
      <span class="card-eyebrow">方式一 · 推荐</span>
      <h2>扫码一键配对</h2>
      <p class="sub">用手机系统相机扫描下方二维码，将直接唤起 Antigravity App 并自动填入地址与令牌。</p>

      {('<div class="iface-chips">' + ''.join(chips_html_parts) + '</div>') if len(lans) > 1 else ''}

      <div class="qr-stage">
        <div class="qr-frame">{qr_svg}</div>
        <div class="qr-target">{esc_active_url}</div>
      </div>

      <div class="actions-row">
        <button class="m3-btn-tonal" type="button" data-copy="{esc_uri}">复制配对链接 (agylink://)</button>
        <a class="m3-btn-outline" href="{esc_uri}">直接唤起 App</a>
      </div>
    </section>

    <div class="stack">
      <section class="card">
        <span class="card-eyebrow">方式二 · 局域网快连</span>
        <h2>6 位数字配对码</h2>
        <p class="sub">在手机 App 输入任一服务器地址与下方 6 位数字即可自动换取访问令牌（每分钟限流 10 次）。</p>

        <div class="pin-row" aria-label="6 位配对码">{pin_digits_html}</div>

        <div class="actions-row">
          <button class="m3-btn-tonal" type="button" id="copyPinBtn" data-copy="{html_lib.escape(pin)}">复制 6 位配对码</button>
          <button class="m3-btn-outline" type="button" id="rotatePinBtn">刷新配对码</button>
        </div>

        <div class="addr-list">
          {''.join(addrs_html_parts)}
        </div>
      </section>

      <section class="card">
        <span class="card-eyebrow">通用安装包 · 可安全分享</span>
        <h2>安装 Android 客户端</h2>
        <p class="sub">安装包零个人隐私硬编码，可随时分享给好友，在各自电脑启动本服务即可独立配对。</p>
        <div class="apk-meta">
          <span class="apk-name">{esc_apk_name}</span>
          <span class="apk-badge">{html_lib.escape(apk_badge)}</span>
        </div>
        <a class="{apk_btn_cls}" href="/download-apk">{html_lib.escape(apk_btn_label)}</a>
      </section>
    </div>
  </main>

  <details class="adv">
    <summary>手动配置参数（高级 / 复制 Token 或配对 URI）</summary>
    <div class="adv-body">
      <div>访问令牌 Token（保存在本机 <code>mobile_config.json</code>）：</div>
      <code class="adv-code">{esc_token}</code>
      <div>完整 Deep-Link 配对 URI：</div>
      <code class="adv-code">{esc_uri}</code>
    </div>
  </details>

  <footer class="footer-links">
    <span>工作区：{html_lib.escape(WORKSPACE_ROOT.as_posix())}</span>
    <a href="/" target="_top">在浏览器打开 Web 工作台 →</a>
  </footer>
</div>
<div class="toast" id="toast">已复制</div>
<script>
const AUTH_TOKEN = {js_token};
const TUN_STATUS = {js_tun_status};
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {{
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}}
const themeBtn = document.getElementById('themeToggleBtn');
function syncThemeBtn() {{
  if (!themeBtn) return;
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  themeBtn.textContent = cur === 'dark' ? '☾ 深色' : '☀ 浅色';
}}
syncThemeBtn();
if (themeBtn) {{
  themeBtn.addEventListener('click', () => {{
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {{ localStorage.setItem('agylink_pair_theme', next); }} catch (_) {{}}
    syncThemeBtn();
  }});
}}
document.querySelectorAll('[data-copy]').forEach(btn => {{
  btn.addEventListener('click', async () => {{
    const val = btn.getAttribute('data-copy') || '';
    try {{
      await navigator.clipboard.writeText(val);
      showToast('已复制到剪贴板');
    }} catch (_) {{
      const ta = document.createElement('textarea');
      ta.value = val;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('已复制到剪贴板');
    }}
  }});
}});
const rotateBtn = document.getElementById('rotatePinBtn');
if (rotateBtn) {{
  rotateBtn.addEventListener('click', async () => {{
    rotateBtn.disabled = true;
    try {{
      const res = await fetch('/api/pair/rotate', {{
        method: 'POST',
        headers: {{ 'Authorization': 'Bearer ' + AUTH_TOKEN }}
      }});
      const data = await res.json();
      if (data && data.ok && data.pin) {{
        const boxes = document.querySelectorAll('.pin-box');
        data.pin.split('').forEach((ch, idx) => {{ if (boxes[idx]) boxes[idx].textContent = ch; }});
        const copyBtn = document.getElementById('copyPinBtn');
        if (copyBtn) copyBtn.setAttribute('data-copy', data.pin);
        showToast('已刷新为新配对码：' + data.pin);
      }} else {{
        showToast('刷新失败');
      }}
    }} catch (_) {{
      showToast('网络错误');
    }} finally {{
      rotateBtn.disabled = false;
    }}
  }});
}}
const restartTunnelBtn = document.getElementById('restartTunnelBtn');
if (restartTunnelBtn) {{
  restartTunnelBtn.addEventListener('click', async () => {{
    restartTunnelBtn.disabled = true;
    restartTunnelBtn.textContent = '隧道重连中…';
    try {{
      const res = await fetch('/api/tunnel/restart', {{
        method: 'POST',
        headers: {{ 'Authorization': 'Bearer ' + AUTH_TOKEN }}
      }});
      const data = await res.json();
      const tun = data && data.tunnel ? data.tunnel : null;
      if (data && data.ok && tun && tun.url && tun.status === 'online') {{
        showToast('公网隧道已就绪，正在刷新二维码…');
        setTimeout(() => location.replace('/pair?ip=tunnel'), 400);
      }} else if (tun && tun.error) {{
        showToast(tun.error);
        restartTunnelBtn.disabled = false;
        restartTunnelBtn.textContent = '重连隧道';
      }} else if (tun && tun.status === 'disabled') {{
        showToast('公网隧道已关闭，请在 mobile_config.json 开启 tunnel_enabled');
        restartTunnelBtn.disabled = false;
        restartTunnelBtn.textContent = '重连隧道';
      }} else {{
        showToast('隧道重连中，请稍候刷新');
        restartTunnelBtn.disabled = false;
        restartTunnelBtn.textContent = '重连隧道';
      }}
    }} catch (_) {{
      showToast('请求失败');
      restartTunnelBtn.disabled = false;
      restartTunnelBtn.textContent = '重连隧道';
    }}
  }});
}}
if (TUN_STATUS === 'starting' || TUN_STATUS === 'reconnecting') {{
  setTimeout(() => location.reload(), 3500);
}}
</script>
</body>
</html>"""
    return web.Response(
        text=page_html,
        content_type="text/html",
        headers={
            "Cache-Control": "no-store",
            "Vary": "Origin",
            "X-Frame-Options": "SAMEORIGIN",
            "Content-Security-Policy": "frame-ancestors 'self'",
        },
    )


async def handle_static_www(request: web.Request) -> web.StreamResponse:
    raw_path = str(request.path or "")
    raw_url_path = str(request.raw_path or "")
    # Reject UNC/backslash/traversal/drive tricks BEFORE joining with WWW_DIR or calling .resolve()
    if (
        raw_path.startswith(("//", "/\\"))
        or "\\" in raw_path
        or "%5c" in raw_url_path.lower()
        or "%2f%2f" in raw_url_path.lower()
    ):
        return web.Response(status=400, text="bad path")
    name = raw_path.lstrip("/") or "index.html"
    if _has_unsafe_raw_path(name, allow_absolute=False):
        return web.Response(status=400, text="bad path")
    www_root = WWW_DIR.resolve()
    p = (www_root / name).resolve()
    if not p.is_file() or not p.is_relative_to(www_root):
        return web.Response(status=404, text="not found")
    resp = web.FileResponse(p)
    if p.name.lower() == "manifest.json":
        resp.headers["Content-Type"] = "application/manifest+json; charset=utf-8"
    if p.suffix.lower() in (".html", ".css", ".js", ".json"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


async def _desktop_transcript_push_loop(_app: web.Application) -> None:
    """Broadcast real-time update pings whenever any desktop transcript changes."""
    last_sigs: dict[str, tuple[int, int]] = {}
    known_real_chats: set[str] = set()

    def _seed_initial_sigs() -> None:
        if not DESKTOP_BRAIN.is_dir():
            return
        try:
            with os.scandir(DESKTOP_BRAIN) as it:
                for e in it:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    tf = pathlib.Path(e.path) / ".system_generated" / "logs" / "transcript.jsonl"
                    try:
                        st = tf.stat()
                        if st.st_size > 0:
                            last_sigs[e.name] = (st.st_mtime_ns, st.st_size)
                    except OSError:
                        continue
        except Exception:
            pass

    def _scan_changes(now_ts: float) -> list[tuple[int, str]]:
        changed: list[tuple[int, str]] = []
        if not DESKTOP_BRAIN.is_dir():
            return changed
        try:
            with os.scandir(DESKTOP_BRAIN) as it:
                for e in it:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    tf = pathlib.Path(e.path) / ".system_generated" / "logs" / "transcript.jsonl"
                    try:
                        st = tf.stat()
                    except OSError:
                        continue
                    if st.st_size <= 0 or (now_ts - st.st_mtime > 300.0):
                        continue
                    sig = (st.st_mtime_ns, st.st_size)
                    prev = last_sigs.get(e.name)
                    if prev == sig:
                        continue
                    last_sigs[e.name] = sig
                    # Ignore internal swarm worker / subagent transcripts so user chats are never starved
                    if e.name not in known_real_chats:
                        if _is_swarm_worker_file(tf):
                            continue
                        known_real_chats.add(e.name)
                    changed.append((st.st_mtime_ns, e.name))
        except Exception:
            pass
        changed.sort(key=lambda item: item[0], reverse=True)
        return changed

    await asyncio.to_thread(_seed_initial_sigs)

    while True:
        await asyncio.sleep(2.0)
        if not _WS_CLIENTS or not DESKTOP_BRAIN.is_dir():
            continue
        try:
            now = time.time()
            changed_cids = await asyncio.to_thread(_scan_changes, now)
            if not changed_cids:
                continue
            cfg = load_or_create_config()
            aliases = cfg.get("desktop_to_cli_alias") or {}
            for _, c in changed_cids[:8]:
                payload: dict[str, Any] = {
                    "type": "desktop_update",
                    "conversation_id": c,
                    "ts": now,
                }
                aliased_cid = str(aliases.get(c) or "").strip()
                if aliased_cid:
                    payload["aliased_cid"] = aliased_cid
                _broadcast_ws(payload)
        except Exception:
            pass


async def _tunnel_health_watchdog_loop(_app: web.Application) -> None:
    """Detect zombie cloudflared processes (owned or reused, readyConnections==0, 530/1033, sleep/wake) and auto-heal."""
    tick = 0
    last_wall_ts = time.time()
    while True:
        await asyncio.sleep(15.0)
        tick += 1
        try:
            now = time.time()
            wake_jump = (now - last_wall_ts) > 45.0
            last_wall_ts = now
            if wake_jump:
                await asyncio.sleep(3.0)
                now = time.time()

            with _TUNNEL_LOCK:
                enabled = bool(_TUNNEL_STATE.get("enabled"))
                status = str(_TUNNEL_STATE.get("status") or "disabled")
                proc = _TUNNEL_STATE.get("proc")
                ext_pid = int(_TUNNEL_STATE.get("external_pid") or 0)
                m_port = int(_TUNNEL_STATE.get("metrics_port") or 0)
                cur_url = str(_TUNNEL_STATE.get("url") or "")
                started_at = float(_TUNNEL_STATE.get("started_at") or 0.0)
                last_heal_at = float(_TUNNEL_STATE.get("last_heal_at") or 0.0)
            if not enabled or status in ("disabled", "missing"):
                continue
            if proc is not None and proc.poll() is not None:
                continue
            if proc is None and not cur_url and ext_pid <= 0:
                continue
            if proc is None and m_port <= 0:
                d_pid, d_mport = await asyncio.to_thread(_discover_running_cloudflared)
                if d_pid > 0 or d_mport > 0:
                    with _TUNNEL_LOCK:
                        if _TUNNEL_STATE.get("proc") is None:
                            if d_pid > 0:
                                _TUNNEL_STATE["external_pid"] = d_pid
                                ext_pid = d_pid
                            if d_mport > 0:
                                _TUNNEL_STATE["metrics_port"] = d_mport
                                m_port = d_mport

            # Startup grace period so fresh cloudflared has time to establish edge HTTP/2 connections
            if proc is not None and (now - started_at) < 25.0 and not wake_jump:
                continue

            if m_port > 0:
                ok, ready_cnt = await asyncio.to_thread(_probe_cloudflared_ready, m_port)
            else:
                ok, ready_cnt = (True, 0)
            fail_reason = ""
            if m_port > 0 and not ok:
                fail_reason = "readyConnections=0"
            elif cur_url and (wake_jump or (now - started_at) >= 35.0) and (wake_jump or tick % 2 == 0 or status == "reconnecting" or m_port <= 0):
                pub_ok, pub_reason = await asyncio.to_thread(_probe_tunnel_public_health, cur_url, m_port)
                if not pub_ok:
                    ok = False
                    fail_reason = pub_reason or "公网边缘 530/1033"

            need_heal_proc = None
            need_heal_ext_pid = 0
            need_restart_owned = False
            broadcast_snap = False
            with _TUNNEL_LOCK:
                if _TUNNEL_STATE.get("proc") is not proc:
                    continue
                if ok:
                    prev_status = str(_TUNNEL_STATE.get("status") or "")
                    if m_port > 0:
                        _TUNNEL_STATE["ready_connections"] = ready_cnt
                    _TUNNEL_STATE["unhealthy_streak"] = 0
                    _TUNNEL_STATE["last_healthy_at"] = now
                    if prev_status == "reconnecting" and _TUNNEL_STATE.get("url"):
                        _TUNNEL_STATE["status"] = "online"
                        _TUNNEL_STATE["error"] = ""
                        broadcast_snap = True
                else:
                    streak = int(_TUNNEL_STATE.get("unhealthy_streak") or 0) + 1
                    _TUNNEL_STATE["unhealthy_streak"] = streak
                    if fail_reason == "readyConnections=0":
                        _TUNNEL_STATE["ready_connections"] = 0
                    heal_threshold = 1 if (wake_jump or fail_reason == "TLS/连接中断") else (2 if fail_reason.startswith("HTTP 530") else 3)
                    if streak == 1 and _TUNNEL_STATE.get("status") == "online" and heal_threshold > 1:
                        _TUNNEL_STATE["status"] = "reconnecting"
                        _TUNNEL_STATE["error"] = f"检测到公网隧道异常（{fail_reason}），正在自愈重连…"
                        broadcast_snap = True
                    elif streak >= heal_threshold and (wake_jump or (now - last_heal_at) >= 60.0):
                        _TUNNEL_STATE["unhealthy_streak"] = 0
                        _TUNNEL_STATE["last_heal_at"] = now
                        _TUNNEL_STATE["auto_heals"] = int(_TUNNEL_STATE.get("auto_heals") or 0) + 1
                        _TUNNEL_STATE["status"] = "reconnecting"
                        _TUNNEL_STATE["error"] = f"僵尸隧道（{fail_reason}）已触发自动自愈，正在重新建连…"
                        if proc is not None:
                            need_heal_proc = proc
                        else:
                            need_heal_ext_pid = ext_pid
                            need_restart_owned = True
                        broadcast_snap = True

            if need_heal_proc is not None:
                print(f"[{APP_NAME}] Zombie cloudflared detected ({fail_reason}, wake={wake_jump}), auto-healing...", flush=True)
                try:
                    need_heal_proc.terminate()
                except Exception:
                    pass
            elif need_restart_owned:
                print(f"[{APP_NAME}] Zombie reused cloudflared (pid={need_heal_ext_pid}, reason={fail_reason}, wake={wake_jump}), taking ownership & restarting...", flush=True)
                if need_heal_ext_pid > 0:
                    await asyncio.to_thread(_kill_pid, need_heal_ext_pid)
                await asyncio.to_thread(start_cloudflared_tunnel, 10.0, False)
                broadcast_snap = True
            if broadcast_snap:
                _broadcast_ws({"type": "tunnel_status", "tunnel": get_tunnel_snapshot(), "ts": now})
        except asyncio.CancelledError:
            raise
        except Exception:
            pass


async def _on_startup(app: web.Application) -> None:
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    get_pair_pin()
    app["desktop_watch_task"] = asyncio.create_task(_desktop_transcript_push_loop(app))
    app["tunnel_watchdog_task"] = asyncio.create_task(_tunnel_health_watchdog_loop(app))


async def _on_cleanup(app: web.Application) -> None:
    _stop_cloudflared_tunnel()
    for key in ("desktop_watch_task", "tunnel_watchdog_task"):
        t = app.get(key)
        if t:
            t.cancel()
    with _ACTIVE_RUNS_LOCK:
        for rec in list(_ACTIVE_RUNS.values()):
            p = rec.get("proc")
            if p is not None and p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass


def create_app() -> web.Application:
    app = web.Application(middlewares=[cors_and_auth_middleware], client_max_size=64 * 1024 * 1024)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)

    app.router.add_get("/health", handle_health)
    app.router.add_get("/pair", handle_pair_page)
    app.router.add_get("/download-apk", handle_download_apk)
    app.router.add_get("/ws", handle_ws)

    app.router.add_post("/api/pair/claim", handle_pair_claim)
    app.router.add_post("/api/pair/rotate", handle_pair_rotate)
    app.router.add_post("/api/tunnel/restart", handle_tunnel_restart)
    app.router.add_get("/api/pair-info", handle_pair_info)
    app.router.add_get("/api/local-auth", handle_local_auth)

    app.router.add_get("/api/server-info", handle_server_info)
    app.router.add_post("/api/settings/permission-mode", handle_set_permission_mode)
    app.router.add_get("/api/models", handle_models)
    app.router.add_get("/api/conversations", handle_conversations)
    app.router.add_get("/api/conversations/{cid}", handle_conversation_detail)
    app.router.add_get("/api/conversations/{cid}/context", handle_conversation_context)
    app.router.add_get("/api/conversations/{cid}/swarm", handle_conversation_swarm)
    app.router.add_post("/api/conversations/{cid}/revert", handle_conversation_revert)
    app.router.add_post("/api/chat/send", handle_chat_send)
    app.router.add_post("/api/chat/interaction/{interaction_id}/respond", handle_chat_interaction_respond)
    app.router.add_get("/api/chat/queue/{cid}", handle_chat_queue_get)
    app.router.add_post("/api/chat/queue/{cid}/resume", handle_chat_queue_resume)
    app.router.add_put("/api/chat/queue/{cid}/{item_id}", handle_chat_queue_update)
    app.router.add_patch("/api/chat/queue/{cid}/{item_id}", handle_chat_queue_update)
    app.router.add_delete("/api/chat/queue/{cid}/{item_id}", handle_chat_queue_delete)
    app.router.add_post("/api/chat/queue/{cid}/{item_id}/interrupt", handle_chat_queue_interrupt)
    app.router.add_post("/api/chat/cancel/{cid}", handle_chat_cancel)
    app.router.add_post("/api/upload", handle_upload)
    app.router.add_get("/api/files", handle_files_list)
    app.router.add_get("/api/files/preview", handle_file_preview)
    app.router.add_get("/api/files/download", handle_file_download)
    app.router.add_get("/api/usage", handle_usage)
    app.router.add_get("/api/qqbot/status", handle_qqbot_status)
    app.router.add_post("/api/qqbot/switch-model", handle_qqbot_switch)

    app.router.add_get("/", handle_static_www)
    app.router.add_get("/{tail:.*}", handle_static_www)
    return app


if __name__ == "__main__":
    cfg = load_or_create_config()
    pin = init_or_rotate_pair_pin()
    tun_snap = start_cloudflared_tunnel(wait_sec=10.0)
    lans = detect_connect_endpoints()
    lan_only = [ep for ep in lans if ep.get("kind") != "tunnel"]
    lan_url = lan_only[0]["url"] if lan_only else f"http://127.0.0.1:{PORT}"
    pair_url = f"http://127.0.0.1:{PORT}/pair"
    print(f"[{APP_NAME}] Listening on http://{HOST}:{PORT}", flush=True)
    print(f"[{APP_NAME}] Workspace : {WORKSPACE_ROOT.as_posix()}", flush=True)
    print(f"[{APP_NAME}] agy CLI   : {_find_agy_bin() or 'NOT FOUND'}", flush=True)
    if tun_snap.get("url"):
        print(f"[{APP_NAME}] Public URL: {tun_snap['url']} (Zero-VPN Cloudflare Tunnel)", flush=True)
    else:
        print(f"[{APP_NAME}] Tunnel    : {tun_snap.get('status')} {tun_snap.get('error', '')}", flush=True)
    print(f"[{APP_NAME}] LAN URL   : {lan_url}", flush=True)
    print(f"[{APP_NAME}] Pair URL  : {pair_url} (Localhost only)", flush=True)
    print(f"[{APP_NAME}] Pair PIN  : {pin}", flush=True)
    print(f"[{APP_NAME}] Token     : {_mask_token(str(cfg.get('token') or ''))}", flush=True)
    web.run_app(create_app(), host=HOST, port=PORT, print=None)
