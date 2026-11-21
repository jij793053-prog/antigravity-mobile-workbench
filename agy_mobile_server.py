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
import urllib.parse
import urllib.request
import uuid
from typing import Any

from aiohttp import WSMsgType, web

APP_NAME = "Antigravity Link Server"
APP_VERSION = "1.6.0"
APK_FILENAME = "Antigravity-Mobile-Universal-v1.5.apk"

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
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_SENSITIVE_NAMES = {
    "agy_env.json", "onebot.json", "webui.json", "mobile_config.json",
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "authorized_keys", "known_hosts",
}
_SENSITIVE_SUFFIXES = (".pem", ".key", ".pfx", ".p12", ".kdbx", ".jks", ".keystore")
_SENSITIVE_SEGS = (
    "/.ssh/", "/.aws/", "/.gnupg/",
    "/qq_env/snowluma/config/", "/qq_env/qqnt_data/", "/nt_qq/", "/appdata/roaming/",
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

_CONFIG_LOCK = threading.Lock()
_ACTIVE_RUNS_LOCK = threading.Lock()
_ACTIVE_RUNS: dict[str, dict[str, Any]] = {}
_WS_CLIENTS: set[web.WebSocketResponse] = set()
_LOOP: asyncio.AbstractEventLoop | None = None

_PAIR_PIN_LOCK = threading.Lock()
_RUNTIME_PAIR_PIN: str = ""
_CLAIM_RATE_LOCK = threading.Lock()
_CLAIM_ATTEMPTS: dict[str, collections.deque[float]] = {}
_CLAIM_LIMIT_PER_MIN = 10

_TUNNEL_LOCK = threading.Lock()
_TUNNEL_STOP_EVT = threading.Event()
_TUNNEL_THREAD: threading.Thread | None = None
_TUNNEL_STATE: dict[str, Any] = {
    "enabled": True,
    "mode": "quick",
    "status": "disabled",
    "url": "",
    "error": "",
    "bin": "",
    "started_at": 0.0,
    "proc": None,
}
_CF_QUICK_URL_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")


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
        cfg["token"] = "agymob_" + secrets.token_hex(12)
        changed = True
    if not cfg.get("default_model"):
        cfg["default_model"] = "gemini-4-neon-medium"
        changed = True
    if not isinstance(cfg.get("desktop_to_cli_alias"), dict):
        cfg["desktop_to_cli_alias"] = {}
        changed = True
    if not isinstance(cfg.get("mobile_own_cids"), list):
        cfg["mobile_own_cids"] = []
        changed = True
    if changed:
        _save_config_unlocked(cfg)
    return cfg


def _save_config_unlocked(cfg: dict[str, Any]) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
    """Generate a fresh 6-digit numeric pairing PIN for this server run and sync to mobile_config.json."""
    global _RUNTIME_PAIR_PIN
    new_pin = f"{secrets.randbelow(1000000):06d}"
    with _PAIR_PIN_LOCK:
        _RUNTIME_PAIR_PIN = new_pin
    _update_config(lambda cfg: cfg.__setitem__("pair_pin", new_pin))
    return new_pin


def get_pair_pin() -> str:
    with _PAIR_PIN_LOCK:
        if _RUNTIME_PAIR_PIN:
            return _RUNTIME_PAIR_PIN
    return init_or_rotate_pair_pin()


def _check_claim_rate_limit(client_ip: str) -> tuple[bool, int]:
    now = time.monotonic()
    key = client_ip or "unknown"
    with _CLAIM_RATE_LOCK:
        dq = _CLAIM_ATTEMPTS.setdefault(key, collections.deque())
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

def _is_sensitive_path(p: pathlib.Path) -> bool:
    try:
        rp = p.resolve()
    except Exception:
        rp = p
    name_low = rp.name.rstrip(" .").lower()
    if name_low in _SENSITIVE_NAMES or name_low.endswith(_SENSITIVE_SUFFIXES):
        return True
    posix_low = "/" + rp.as_posix().lstrip("/").lower() + "/"
    return any(seg in posix_low for seg in _SENSITIVE_SEGS)


def _find_agy_bin() -> str:
    env_bin = str(os.environ.get("AGY_CLI_BIN") or "").strip()
    if env_bin:
        ep = pathlib.Path(env_bin).expanduser()
        if ep.is_file():
            return str(ep)

    candidates: list[pathlib.Path] = [
        WORKSPACE_ROOT / "bin" / "agy.exe",
        WORKSPACE_ROOT / "bin" / "agy",
    ]
    local_app = str(os.environ.get("LOCALAPPDATA") or "").strip()
    if local_app:
        la = pathlib.Path(local_app)
        candidates.extend([
            la / "agy" / "bin" / "agy.exe",
            la / "Programs" / "antigravity" / "bin" / "agy.exe",
        ])
    candidates.extend([
        HOME_DIR / ".local" / "bin" / "agy",
        HOME_DIR / ".agy" / "bin" / "agy",
    ])
    for cand in candidates:
        try:
            if cand.is_file():
                return str(cand)
        except OSError:
            continue
    return str(shutil.which("agy") or shutil.which("agy.exe") or "")


def _build_cli_env() -> dict[str, str]:
    env = dict(os.environ)
    has_proxy = any(env.get(k) for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"))
    if not has_proxy:
        for port in (7890, 7897, 10809, 10808):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.15):
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


def check_qqbot_available() -> bool:
    """Quick 0.2s TCP probe on local QQ Bot API (127.0.0.1:8788)."""
    try:
        with socket.create_connection(("127.0.0.1", 8788), timeout=0.2):
            return True
    except OSError:
        return False


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
    is_lan_nic = any(k in iface_low for k in ("wlan", "wi-fi", "wifi", "以太网", "ethernet", "en0", "eth0", "local area"))
    is_tailscale = ("tailscale" in iface_low) or (addr in ipaddress.IPv4Network("100.64.0.0/10"))
    is_rfc1918 = addr.is_private

    if is_lan_nic and is_rfc1918:
        return (0, "lan")
    if is_lan_nic:
        return (1, "lan")
    if is_tailscale:
        return (2, "tailscale")
    if any(k in iface_low for k in ("vpn", "wireguard", "zerotier", "radmin", "wg")):
        return (3, "vpn")
    if is_rfc1918:
        return (4, "lan")
    return (5, "other")


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
                    "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
                    "Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '127.*' "
                    "-and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '198.18.*' "
                    "-and $_.IPAddress -notlike '198.19.*' } | "
                    "Select-Object InterfaceAlias, IPAddress | ConvertTo-Json -Compress",
                ],
                capture_output=True, text=True, timeout=4, creationflags=_NO_WINDOW,
            )
            raw = ps.stdout.strip()
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

    # Cross-platform socket fallback (macOS / Linux / if PowerShell unavailable)
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

    ordered = sorted(found.values(), key=lambda x: (x[0], x[1]["ip"]))
    return [entry for _, entry in ordered]


def build_pair_uri(base_url: str, token: str, hostname: str) -> str:
    q = urllib.parse.urlencode({"u": base_url, "t": token, "n": hostname})
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
        }


def _stop_cloudflared_tunnel() -> None:
    _TUNNEL_STOP_EVT.set()
    proc = None
    with _TUNNEL_LOCK:
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
    global _TUNNEL_THREAD
    reuse_url = str(os.environ.get("AGY_REUSE_TUNNEL_URL") or "").strip().rstrip("/") if allow_reuse else ""
    if reuse_url:
        with _TUNNEL_LOCK:
            _TUNNEL_STATE.update({
                "enabled": True,
                "mode": "quick",
                "status": "online",
                "url": reuse_url,
                "error": "",
                "bin": _find_cloudflared_bin(),
                "started_at": time.time(),
                "proc": None,
            })
        print(f"[{APP_NAME}] Reusing Public Tunnel: {reuse_url}", flush=True)
        return get_tunnel_snapshot()

    os.environ.pop("AGY_REUSE_TUNNEL_URL", None)
    cfg = load_or_create_config()
    env_off = str(os.environ.get("AGY_DISABLE_TUNNEL") or "").strip().lower() in ("1", "true", "yes")
    enabled = (not env_off) and bool(cfg.get("tunnel_enabled", True))
    cf_bin = _find_cloudflared_bin()

    if not enabled:
        with _TUNNEL_LOCK:
            _TUNNEL_STATE.update({"enabled": False, "mode": "disabled", "status": "disabled", "url": "", "error": "", "bin": cf_bin})
        return get_tunnel_snapshot()

    if not cf_bin:
        with _TUNNEL_LOCK:
            _TUNNEL_STATE.update({"enabled": True, "mode": "quick", "status": "missing", "url": "", "error": "未找到 cloudflared 可执行文件", "bin": ""})
        return get_tunnel_snapshot()

    named_token = str(cfg.get("cloudflare_tunnel_token") or os.environ.get("AGY_CLOUDFLARE_TUNNEL_TOKEN") or "").strip()
    named_url = str(cfg.get("cloudflare_public_url") or os.environ.get("AGY_CLOUDFLARE_PUBLIC_URL") or "").strip().rstrip("/")
    mode = "named" if named_token else "quick"

    _stop_cloudflared_tunnel()
    _TUNNEL_STOP_EVT.clear()
    ready_evt = threading.Event()

    with _TUNNEL_LOCK:
        _TUNNEL_STATE.update({
            "enabled": True,
            "mode": mode,
            "status": "starting",
            "url": named_url if mode == "named" else "",
            "error": "",
            "bin": cf_bin,
            "started_at": time.time(),
            "proc": None,
        })

    def _runner() -> None:
        while not _TUNNEL_STOP_EVT.is_set():
            if mode == "named":
                cmd = [cf_bin, "tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "run", "--token", named_token]
            else:
                cmd = [cf_bin, "tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "--url", f"http://127.0.0.1:{PORT}"]
            last_lines: collections.deque[str] = collections.deque(maxlen=8)
            proc = None
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=_NO_WINDOW,
                )
                with _TUNNEL_LOCK:
                    _TUNNEL_STATE["proc"] = proc
                    if mode != "named":
                        _TUNNEL_STATE["status"] = "starting"
                        _TUNNEL_STATE["url"] = ""
                    _TUNNEL_STATE["error"] = ""

                assert proc.stdout is not None
                for raw_ln in proc.stdout:
                    if _TUNNEL_STOP_EVT.is_set():
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
                                _TUNNEL_STATE["url"] = found_url
                                _TUNNEL_STATE["status"] = "online"
                                _TUNNEL_STATE["error"] = ""
                            print(f"[{APP_NAME}] Public Tunnel : {found_url}", flush=True)
                            ready_evt.set()
                    if "Registered tunnel connection" in ln:
                        with _TUNNEL_LOCK:
                            if mode == "named" and named_url:
                                _TUNNEL_STATE["url"] = named_url
                            if _TUNNEL_STATE.get("url"):
                                _TUNNEL_STATE["status"] = "online"
                                _TUNNEL_STATE["error"] = ""
                        ready_evt.set()
                proc.wait(timeout=5.0)
            except Exception as exc:
                last_lines.append(str(exc))
            finally:
                if proc is not None and proc.poll() is None:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                with _TUNNEL_LOCK:
                    if _TUNNEL_STATE.get("proc") is proc:
                        _TUNNEL_STATE["proc"] = None
                    if not _TUNNEL_STOP_EVT.is_set():
                        _TUNNEL_STATE["status"] = "error"
                        _TUNNEL_STATE["url"] = named_url if mode == "named" else ""
                        _TUNNEL_STATE["error"] = " | ".join(list(last_lines)[-2:])[:240] or "cloudflared 进程已退出，正在重连..."
            if _TUNNEL_STOP_EVT.wait(5.0):
                break

    t = threading.Thread(target=_runner, name="cloudflared-tunnel", daemon=True)
    _TUNNEL_THREAD = t
    t.start()
    if wait_sec > 0:
        ready_evt.wait(timeout=wait_sec)
    return get_tunnel_snapshot()


def detect_connect_endpoints() -> list[dict[str, str]]:
    """Return all reachable endpoints, prioritizing the active Cloudflare public tunnel."""
    endpoints: list[dict[str, str]] = []
    tun = get_tunnel_snapshot()
    if tun.get("status") == "online" and tun.get("url"):
        endpoints.append({
            "iface": "Cloudflare 公网免VPN",
            "ip": "tunnel",
            "url": tun["url"],
            "kind": "tunnel",
        })
    endpoints.extend(detect_lan_addresses())
    return endpoints


def _is_via_public_tunnel(request: web.Request) -> bool:
    """Detect requests arriving via Cloudflare Tunnel so sensitive /pair pages stay local-only."""
    if request.headers.get("CF-Connecting-IP") or request.headers.get("CF-Ray") or request.headers.get("CF-Visitor"):
        return True
    host_hdr = str(request.headers.get("Host") or "").strip().lower().split(":")[0]
    if host_hdr.endswith(".trycloudflare.com"):
        return True
    tun_url = str(get_tunnel_snapshot().get("url") or "")
    if tun_url:
        try:
            tun_host = (urllib.parse.urlparse(tun_url).hostname or "").lower()
            if tun_host and host_hdr == tun_host:
                return True
        except Exception:
            pass
    return False


def _client_ip_for_rate_limit(request: web.Request) -> str:
    cf_ip = str(request.headers.get("CF-Connecting-IP") or "").strip()
    if cf_ip:
        return cf_ip
    xff = str(request.headers.get("X-Forwarded-For") or "").strip()
    if xff:
        return xff.split(",")[0].strip()
    return str(request.remote or "unknown")


def _mask_token(token: str) -> str:
    if len(token) <= 14:
        return token[:4] + "..." if len(token) > 4 else "***"
    return f"{token[:10]}...{token[-4:]}"


# ---------------------------------------------------------------------------
# Transcripts & Conversations
# ---------------------------------------------------------------------------

def _read_pbtxt_title(cid: str) -> str:
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


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"}


def _extract_user_attachments(raw: str, media_list: list[Any] | None = None) -> list[dict[str, Any]]:
    """Extract clickable structured attachments (mobile uploads + Desktop media) for a user message."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

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
        try:
            p = pathlib.Path(s).resolve()
        except Exception:
            return
        if not p.is_file() or _is_sensitive_path(p):
            return
        ps = p.as_posix()
        if ps in seen:
            return
        seen.add(ps)
        pretty_name = re.sub(r"^\d{13}_", "", p.name)
        ext = p.suffix.lower()
        is_img = (ext in _IMAGE_EXTS) or str(mime_hint or "").lower().startswith("image/")
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

    # Strip desktop-to-CLI context bridge prefix so old assistant/user history never merges into user bubble
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


def _summarize_tool(tc: dict[str, Any]) -> dict[str, str]:
    name = str(tc.get("name") or "")
    args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
    target = ""
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
    if tail_step is not None:
        tt = str(tail_step.get("type") or "")
        if tt != "PLANNER_RESPONSE" or str(tail_step.get("status") or "").upper() != "DONE" or bool(tail_step.get("tool_calls")):
            tail_looks_running = True

    meta = {
        "id": cid,
        "shortId": cid[:8],
        "title": title,
        "source": source,
        "model": model_id or "gemini-4-neon-medium",
        "preview": last_preview or first_u[:80],
        "updatedAt": mtime,
        "stepCount": len(steps),
        "_tailRunning": tail_looks_running,
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
        is_running = is_act or (tail_running and (now_ts - mtime < 180.0))
        meta["status"] = "running" if is_running else "idle"
        bucket.append(meta)
    return bucket


def list_all_conversations(limit: int = 80, source_filter: str = "all") -> list[dict[str, Any]]:
    active_ids: set[str] = set()
    with _ACTIVE_RUNS_LOCK:
        for k, v in _ACTIVE_RUNS.items():
            if v.get("running"):
                active_ids.add(k)

    cfg = load_or_create_config()
    aliases = cfg.get("desktop_to_cli_alias") or {}
    aliased_cli_set = {str(v).strip() for v in aliases.values() if str(v).strip()}
    mobile_own = get_mobile_own_cids()

    seen: set[str] = set()
    # 1. Scan Desktop Antigravity conversations (100% aligned with PC IDE left sidebar)
    desktop_items = _scan_source_conversations(DESKTOP_BRAIN, "desktop", limit, active_ids, seen)
    seen.update(it["id"] for it in desktop_items)

    # Reflect any linked mobile continuation activity onto its unified Desktop row (no duplicate rows)
    for d_item in desktop_items:
        aliased_cli = str(aliases.get(d_item["id"]) or "").strip()
        if not aliased_cli:
            continue
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
                    c_meta["status"] = "running" if (aliased_cli in active_ids or (tr and time.time() - c_st.st_mtime < 180.0)) else "idle"
                    c_item = c_meta
        except OSError:
            c_item = None
        if c_item:
            if float(c_item.get("updatedAt") or 0) > float(d_item.get("updatedAt") or 0):
                d_item["updatedAt"] = c_item["updatedAt"]
                if c_item.get("preview"):
                    d_item["preview"] = c_item["preview"]
                if c_item.get("model"):
                    d_item["model"] = c_item["model"]
            if c_item.get("status") == "running" or aliased_cli in active_ids or d_item["id"] in active_ids:
                d_item["status"] = "running"

    # 2. Include ONLY standalone chats created explicitly by Antigravity Mobile (never QQ Bot / Hermes CLI chats)
    own_mobile_items: list[dict[str, Any]] = []
    now_ts = time.time()
    for m_cid in mobile_own:
        if not m_cid or m_cid in seen or m_cid in aliased_cli_set:
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
            meta["status"] = "running" if (m_cid in active_ids or (tr and now_ts - st.st_mtime < 180.0)) else "idle"
            own_mobile_items.append(meta)
            seen.add(m_cid)
        except OSError:
            continue

    result = desktop_items + own_mobile_items
    result.sort(key=lambda x: float(x.get("updatedAt") or 0), reverse=True)

    existing_ids = {r["id"] for r in result}
    with _ACTIVE_RUNS_LOCK:
        for cid, run in _ACTIVE_RUNS.items():
            if not run.get("running"):
                continue
            disp_cid = str(run.get("display_cid") or cid)
            if disp_cid in existing_ids or cid in existing_ids or cid in aliased_cli_set:
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
    return result[:limit]


def load_conversation_detail(cid: str, _include_parent: bool = True) -> dict[str, Any]:
    tf, source = _locate_transcript(cid)
    title = _read_pbtxt_title(cid)
    steps = _parse_jsonl(tf) if tf is not None else []

    if tf is not None and steps:
        needed: set[int] = set()
        for s in steps:
            tfs = s.get("truncated_fields") or []
            si = s.get("step_index")
            if isinstance(si, int) and tfs:
                if s.get("type") in ("PLANNER_RESPONSE", "USER_INPUT") and "content" in tfs:
                    needed.add(si)
        if needed:
            full_map = _load_full_steps(tf, needed)
            if full_map:
                steps = [full_map.get(s.get("step_index"), s) if isinstance(s.get("step_index"), int) else s for s in steps]

    messages: list[dict[str, Any]] = []
    # If this mobile CLI session branched off a Desktop conversation, prepend clean Desktop history
    if _include_parent and source == "mobile":
        parent_desk = get_desktop_parent_for_cli(cid)
        if parent_desk and parent_desk != cid:
            parent_detail = load_conversation_detail(parent_desk, _include_parent=False)
            p_msgs = parent_detail.get("messages") or []
            if p_msgs:
                messages.extend(p_msgs[-24:])
            if not title and parent_detail.get("title"):
                title = str(parent_detail["title"])
    deliverable_cands: list[str] = []
    last_model = ""
    pending_tools: list[dict[str, str]] = []
    pending_thinking: list[str] = []

    for s in steps:
        st_t = str(s.get("type") or "")
        if st_t in ("EPHEMERAL_MESSAGE", "CHECKPOINT"):
            continue
        if st_t == "USER_INPUT" and s.get("source") == "USER_EXPLICIT":
            if pending_tools:
                messages.append({
                    "role": "assistant",
                    "text": "",
                    "tools": list(pending_tools),
                    "thinking": "\n".join(pending_thinking)[-1200:],
                    "model": last_model,
                    "time": str(s.get("created_at") or ""),
                })
                pending_tools.clear()
                pending_thinking.clear()
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
                "time": str(s.get("created_at") or ""),
            }
            if u_atts:
                u_msg["attachments"] = u_atts
            messages.append(u_msg)
        elif st_t == "PLANNER_RESPONSE":
            if s.get("model"):
                last_model = str(s["model"])
            th = str(s.get("thinking") or "").strip()
            if th:
                pending_thinking.append(th)
            tcs = s.get("tool_calls") or []
            for tc in tcs:
                if isinstance(tc, dict) and tc.get("name"):
                    pending_tools.append(_summarize_tool(tc))
                    tname = str(tc["name"])
                    targs = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                    if tname in ("write_file", "edit_file", "write_to_file", "replace_file_content"):
                        fp = str(targs.get("Path") or targs.get("TargetFile") or "").strip()
                        if fp:
                            deliverable_cands.append(fp)
            a_txt = _clean_assistant_text(str(s.get("content") or ""))
            if a_txt:
                for mf in re.finditer(r"file:///([^)\s\"#>]+)", a_txt):
                    u_dec = urllib.parse.unquote(mf.group(1)).split("#")[0].strip()
                    if re.match(r"^/[A-Za-z]:/", u_dec):
                        u_dec = u_dec[1:]
                    deliverable_cands.append(u_dec)
                messages.append({
                    "role": "assistant",
                    "text": a_txt,
                    "tools": list(pending_tools),
                    "thinking": "\n".join(pending_thinking)[-2000:],
                    "model": last_model,
                    "time": str(s.get("created_at") or ""),
                    "isFinal": not bool(tcs),
                })
                pending_tools.clear()
                pending_thinking.clear()

    if pending_tools:
        messages.append({
            "role": "assistant",
            "text": "",
            "tools": list(pending_tools),
            "thinking": "\n".join(pending_thinking)[-1200:],
            "model": last_model,
            "time": "",
            "isFinal": False,
        })

    # If opening a Desktop conversation that also has mobile CLI continuation turns, append them seamlessly!
    aliased_cli = get_desktop_cli_alias(cid) if (_include_parent and source == "desktop") else ""
    if aliased_cli and aliased_cli != cid:
        child_detail = load_conversation_detail(aliased_cli, _include_parent=False)
        c_msgs = child_detail.get("messages") or []
        if c_msgs:
            messages.extend(c_msgs)
        if child_detail.get("model"):
            last_model = str(child_detail["model"])
        for cd in child_detail.get("deliverables") or []:
            if cd.get("path"):
                deliverable_cands.append(str(cd["path"]))

    deliverables: list[dict[str, Any]] = []
    seen_p: set[str] = set()
    for cand in reversed(deliverable_cands):
        try:
            p = pathlib.Path(cand).resolve()
            ps = p.as_posix()
            if ps in seen_p or not p.is_file() or _is_sensitive_path(p):
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
            }

    # If a desktop conversation was continued from Mobile, append its aliased CLI turns cleanly
    if _include_parent and source == "desktop":
        aliased_cli = get_desktop_cli_alias(cid)
        if aliased_cli and aliased_cli != cid:
            child_detail = load_conversation_detail(aliased_cli, _include_parent=False)
            c_msgs = child_detail.get("messages") or []
            if c_msgs:
                messages.extend(c_msgs)
            c_delivs = child_detail.get("deliverables") or []
            if c_delivs:
                seen_dp = {d["path"] for d in deliverables}
                merged_d = list(c_delivs) + [d for d in deliverables if d["path"] not in {x["path"] for x in c_delivs}]
                deliverables = merged_d[:16]
            if child_detail.get("activeRun") and not active_run_snap:
                active_run_snap = child_detail["activeRun"]
            if child_detail.get("model"):
                last_model = str(child_detail["model"])

    return {
        "id": cid,
        "title": title or f"对话 {cid[:8]}",
        "source": source,
        "model": last_model or load_or_create_config().get("default_model", "gemini-4-neon-medium"),
        "status": "running" if active_run_snap else "idle",
        "messages": messages[-80:],
        "deliverables": deliverables,
        "activeRun": active_run_snap,
    }


def _extract_desktop_bridge_context(desktop_cid: str) -> str:
    detail = load_conversation_detail(desktop_cid)
    msgs = detail.get("messages") or []
    if not msgs:
        return ""
    lines = [f"【衔接电脑桌面端 Antigravity 原会话（标题：{detail.get('title')}，ID：{desktop_cid[:8]}）】"]
    for m in msgs[-6:]:
        role = "用户" if m.get("role") == "user" else "助手"
        txt = str(m.get("text") or "").strip()
        if txt:
            lines.append(f"[{role}] {txt[:1600]}")
    ctx = "\n".join(lines)
    return ctx[-5500:]


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


def start_cli_chat_run(
    requested_cid: str,
    prompt: str,
    model: str,
    attachments: list[str] | None = None,
    swarm_mode: bool = False,
) -> dict[str, Any]:
    agy_bin = _find_agy_bin()
    if not agy_bin:
        return {"ok": False, "error": "未找到官方 agy CLI（请安装 Antigravity CLI 或设置环境变量 AGY_CLI_BIN）"}

    req_cid = str(requested_cid or "").strip()
    is_new = (not req_cid) or req_cid == "__new__"
    resume_cli_cid = ""
    source_desktop_cid = ""
    desktop_ctx = ""

    if not is_new:
        if (CLI_CONV / f"{req_cid}.db").is_file():
            resume_cli_cid = req_cid
            parent_d = get_desktop_parent_for_cli(req_cid)
            if parent_d:
                source_desktop_cid = parent_d
        else:
            aliased = get_desktop_cli_alias(req_cid)
            if aliased and (CLI_CONV / f"{aliased}.db").is_file():
                resume_cli_cid = aliased
                source_desktop_cid = req_cid
            elif (DESKTOP_BRAIN / req_cid / ".system_generated" / "logs" / "transcript.jsonl").is_file():
                source_desktop_cid = req_cid
                desktop_ctx = _extract_desktop_bridge_context(req_cid)

    eff_model = str(model or "").strip() or load_or_create_config().get("default_model", "gemini-4-neon-medium")
    parts: list[str] = []
    if desktop_ctx:
        parts.append(desktop_ctx)
        parts.append("【用户在 Antigravity Mobile 手机端针对以上会话的最新指令】")
    if attachments:
        att_txt = "\n".join(f"- {a}" for a in attachments if a)
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

    cmd = [
        agy_bin,
        "-p", full_prompt,
        "--model", eff_model,
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
    ]
    if resume_cli_cid:
        cmd.extend(["--conversation", resume_cli_cid])

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
        return {"ok": False, "error": f"启动 agy CLI 失败: {exc}"}

    run_id = uuid.uuid4().hex[:10]
    init_evt = threading.Event()
    canonical_disp = source_desktop_cid or resume_cli_cid
    att_metas: list[dict[str, Any]] = []
    for raw_a in (attachments or []):
        if not raw_a:
            continue
        ap = pathlib.Path(raw_a)
        ext = ap.suffix.lower()
        is_img = ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
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
        "tools": [],
        "chunks": [],
        "running": True,
        "canceled": False,
        "started_at": time.time(),
        "stderr": "",
    }
    with _ACTIVE_RUNS_LOCK:
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
        final_resp = ""
        usage: dict[str, Any] = {}
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
                            if source_desktop_cid and source_desktop_cid != cid_i:
                                set_desktop_cli_alias(source_desktop_cid, cid_i)
                            elif is_new or not source_desktop_cid:
                                register_mobile_own_cid(cid_i)
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
                            if not source_desktop_cid:
                                register_mobile_own_cid(bound_cid)
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
                                    "conversation_id": disp_cid or bound_cid,
                                    "run_id": run_id,
                                    "tool": tool_item,
                                })
                        elif st_type == "agent_response":
                            delta = str(su.get("text_delta") or "")
                            if delta:
                                run_rec["chunks"].append(delta)
                                _broadcast_ws({
                                    "type": "run_delta",
                                    "conversation_id": disp_cid or bound_cid,
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
            cid_end = disp_cid or bound_cid or run_rec.get("display_cid") or run_rec.get("cid") or ""
            with _ACTIVE_RUNS_LOCK:
                for k_rm in (cid_end, bound_cid, run_rec.get("cid") or ""):
                    if k_rm and _ACTIVE_RUNS.get(k_rm) is run_rec:
                        _ACTIVE_RUNS.pop(k_rm, None)
            init_evt.set()
            if run_rec.get("canceled"):
                _broadcast_ws({"type": "run_canceled", "conversation_id": cid_end, "run_id": run_id})
            elif proc.returncode not in (0, None) and not final_resp:
                _broadcast_ws({
                    "type": "run_error",
                    "conversation_id": cid_end,
                    "run_id": run_id,
                    "error": (run_rec.get("stderr") or f"exit code {proc.returncode}")[:400],
                })
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

    threading.Thread(target=_stream_worker, daemon=True).start()
    if not run_rec["display_cid"]:
        init_evt.wait(timeout=8.0)

    final_cid = str(run_rec.get("display_cid") or run_rec.get("cid") or resume_cli_cid or f"pending-{run_id}")
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
        return True
    auth_h = str(request.headers.get("Authorization") or "").strip()
    if auth_h.startswith("Bearer ") and secrets.compare_digest(auth_h[7:].strip(), expected):
        return True
    q_tok = str(request.query.get("token") or "").strip()
    if q_tok and secrets.compare_digest(q_tok, expected):
        return True
    return False


_PUBLIC_API_PATHS = {"/api/pair/claim", "/api/local-auth"}


def _is_strict_loopback_request(request: web.Request) -> bool:
    """Only allow direct localhost/127.0.0.1 same-origin requests (never via proxy/tunnel/cross-site)."""
    if _is_via_public_tunnel(request):
        return False
    for proxy_hdr in ("X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Forwarded"):
        if request.headers.get(proxy_hdr):
            return False
    remote = str(request.remote or "").strip()
    try:
        if not ipaddress.ip_address(remote).is_loopback:
            return False
    except ValueError:
        return False
    host_hdr = str(request.headers.get("Host") or "").strip().lower()
    try:
        host_only = str(urllib.parse.urlparse(f"http://{host_hdr}").hostname or "").lower()
    except Exception:
        return False
    if host_only not in ("127.0.0.1", "localhost", "::1"):
        return False
    sfd = str(request.headers.get("Sec-Fetch-Dest") or "").strip().lower()
    if sfd in ("iframe", "frame", "object", "embed"):
        return False
    sfs = str(request.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if sfs and sfs not in ("same-origin", "none"):
        return False
    origin = str(request.headers.get("Origin") or "").strip().lower()
    if origin:
        try:
            po = urllib.parse.urlparse(origin)
            if po.hostname not in ("127.0.0.1", "localhost", "::1") or (po.port or 80) != PORT:
                return False
        except Exception:
            return False
    return True


@web.middleware
async def cors_and_auth_middleware(request: web.Request, handler):
    is_local_auth = request.path == "/api/local-auth"
    if request.method == "OPTIONS":
        if is_local_auth:
            return web.Response(status=403)
        return web.Response(
            status=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
                "Access-Control-Max-Age": "86400",
            },
        )
    path = request.path
    if (path.startswith("/api/") and path not in _PUBLIC_API_PATHS) or path == "/ws":
        if not _check_auth(request):
            return web.json_response(
                {"ok": False, "error": "Unauthorized: invalid or missing token"},
                status=401,
                headers={"Access-Control-Allow-Origin": "*"},
            )
    try:
        resp = await handler(request)
    except web.HTTPException as ex:
        resp = ex
    if not resp.prepared and not is_local_auth:
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Requested-With"
    return resp


async def handle_local_auth(request: web.Request) -> web.Response:
    """Zero-input auto-login exclusively for local desktop workbench opened on 127.0.0.1 / localhost."""
    sec_headers = {"Cache-Control": "no-store", "Vary": "Origin", "X-Frame-Options": "DENY"}
    if not _is_strict_loopback_request(request):
        return web.json_response(
            {"ok": False, "error": "本机自动登录仅允许在电脑本机 http://127.0.0.1 访问"},
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

async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({
        "ok": True,
        "app": APP_NAME,
        "version": APP_VERSION,
        "port": PORT,
        "hostname": socket.gethostname(),
    })


async def handle_server_info(_request: web.Request) -> web.Response:
    cfg = load_or_create_config()
    lans, qqbot_ok = await asyncio.gather(
        asyncio.to_thread(detect_connect_endpoints),
        asyncio.to_thread(check_qqbot_available),
    )
    tun = get_tunnel_snapshot()
    apk_p = DIST_DIR / APK_FILENAME
    with _ACTIVE_RUNS_LOCK:
        running_cnt = sum(1 for v in _ACTIVE_RUNS.values() if v.get("running"))
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
        "agy_cli_ready": bool(_find_agy_bin()),
        "qqbot_available": bool(qqbot_ok),
        "default_model": cfg.get("default_model", "gemini-4-neon-medium"),
        "running_tasks": running_cnt,
        "apk_name": APK_FILENAME,
        "apk_ready": apk_p.is_file(),
        "apk_size": apk_p.stat().st_size if apk_p.is_file() else 0,
    })


async def handle_pair_claim(request: web.Request) -> web.Response:
    allowed, retry_after = _check_claim_rate_limit(_client_ip_for_rate_limit(request))
    if not allowed:
        return web.json_response(
            {"ok": False, "error": f"配对尝试过于频繁，请 {retry_after} 秒后再试"},
            status=429,
            headers={"Retry-After": str(retry_after)},
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
        return web.json_response(
            {"ok": False, "error": "配对码错误，请核对电脑端 /pair 页面显示的 6 位数字"},
            status=403,
        )

    cfg = load_or_create_config()
    lans, qqbot_ok = await asyncio.gather(
        asyncio.to_thread(detect_connect_endpoints),
        asyncio.to_thread(check_qqbot_available),
    )
    return web.json_response({
        "ok": True,
        "token": str(cfg.get("token") or ""),
        "hostname": socket.gethostname(),
        "default_model": cfg.get("default_model", "gemini-4-neon-medium"),
        "port": PORT,
        "lan_urls": lans,
        "tunnel_url": get_tunnel_snapshot().get("url", ""),
        "qqbot_available": bool(qqbot_ok),
    })


async def handle_pair_rotate(_request: web.Request) -> web.Response:
    new_pin = init_or_rotate_pair_pin()
    return web.json_response({"ok": True, "pin": new_pin, "pair_pin": new_pin})


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
    pin = get_pair_pin()
    return web.json_response({
        "ok": True,
        "hostname": hostname,
        "lan_urls": lans,
        "tunnel": tun,
        "pin": pin,
        "pair_uri": build_pair_uri(main_url, token, hostname),
        "token_preview": _mask_token(token),
    })


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
    if source_filter not in ("all", "desktop", "mobile"):
        source_filter = "all"
    items = await asyncio.to_thread(list_all_conversations, limit, source_filter)
    return web.json_response({"ok": True, "conversations": items})


async def handle_conversation_detail(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    if not cid:
        return web.json_response({"ok": False, "error": "missing cid"}, status=400)
    detail = await asyncio.to_thread(load_conversation_detail, cid)
    return web.json_response({"ok": True, "conversation": detail})


async def handle_chat_send(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    cid = str(body.get("conversation_id") or "").strip()
    prompt = str(body.get("prompt") or "")
    model = str(body.get("model") or "").strip()
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    swarm_mode = bool(body.get("swarm_mode", False))
    if model:
        _update_config(lambda cfg: cfg.__setitem__("default_model", model))
    res = await asyncio.to_thread(start_cli_chat_run, cid, prompt, model, attachments, swarm_mode)
    return web.json_response(res, status=200 if res.get("ok") else 400)


async def handle_chat_cancel(request: web.Request) -> web.Response:
    cid = str(request.match_info.get("cid") or "").strip()
    proc = None
    with _ACTIVE_RUNS_LOCK:
        rec = _ACTIVE_RUNS.get(cid)
        if rec:
            rec["canceled"] = True
            proc = rec.get("proc")
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
        return web.json_response({"ok": True, "conversation_id": cid, "canceled": True})
    return web.json_response({"ok": True, "conversation_id": cid, "canceled": False, "note": "无正在运行的手机端任务"})


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
    is_img = ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
    return web.json_response({
        "ok": True,
        "name": orig_name,
        "path": dest.resolve().as_posix(),
        "size": size,
        "is_image": is_img,
        "preview_url": f"/api/files/preview?path={urllib.parse.quote(dest.resolve().as_posix())}",
    })


async def handle_files_list(request: web.Request) -> web.Response:
    raw_dir = str(request.query.get("dir") or WORKSPACE_ROOT.as_posix()).strip()
    try:
        target = pathlib.Path(raw_dir).resolve()
        if not target.is_dir():
            target = WORKSPACE_ROOT.resolve()
        if _is_sensitive_path(target):
            return web.json_response({"ok": False, "error": "禁止访问敏感目录"}, status=403)
    except Exception:
        target = WORKSPACE_ROOT.resolve()

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    try:
        with os.scandir(target) as it:
            for e in it:
                p = pathlib.Path(e.path)
                if e.name.startswith(".") or e.name in ("__pycache__", "node_modules", "qq_env", "qq_appdata", "qq_data", "qq_local", "qq_roaming"):
                    continue
                if _is_sensitive_path(p):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                if e.is_dir():
                    dirs.append({"name": e.name, "path": p.resolve().as_posix(), "is_dir": True, "mtime": st.st_mtime})
                else:
                    files.append({
                        "name": e.name,
                        "path": p.resolve().as_posix(),
                        "is_dir": False,
                        "size": st.st_size,
                        "ext": p.suffix.lower(),
                        "mtime": st.st_mtime,
                    })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    dirs.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: -float(x["mtime"]))
    parent = target.parent.resolve().as_posix() if target.parent != target else ""
    return web.json_response({
        "ok": True,
        "dir": target.as_posix(),
        "parent": parent,
        "items": (dirs[:60] + files[:100]),
    })


async def handle_file_preview(request: web.Request) -> web.Response:
    raw_p = str(request.query.get("path") or "").strip()
    if not raw_p:
        return web.json_response({"ok": False, "error": "missing path"}, status=400)
    try:
        p = pathlib.Path(raw_p).resolve()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid path"}, status=400)
    if not p.is_file() or _is_sensitive_path(p):
        return web.json_response({"ok": False, "error": "文件不存在或受保护"}, status=404)
    ext = p.suffix.lower()
    if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"):
        mime, _ = mimetypes.guess_type(p.name)
        return web.Response(body=p.read_bytes(), content_type=mime or "image/png")
    try:
        raw_b = p.read_bytes()[:65536]
        if b"\x00" in raw_b[:512]:
            return web.json_response({"ok": True, "binary": True, "name": p.name, "size": p.stat().st_size, "content": ""})
        return web.json_response({
            "ok": True,
            "binary": False,
            "name": p.name,
            "size": p.stat().st_size,
            "truncated": p.stat().st_size > 65536,
            "content": raw_b.decode("utf-8", errors="replace"),
        })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_file_download(request: web.Request) -> web.Response:
    raw_p = str(request.query.get("path") or "").strip()
    if not raw_p:
        return web.Response(status=400, text="missing path")
    try:
        p = pathlib.Path(raw_p).resolve()
    except Exception:
        return web.Response(status=400, text="invalid path")
    if not p.is_file() or _is_sensitive_path(p):
        return web.Response(status=404, text="not found")
    resp = web.FileResponse(p)
    qname = urllib.parse.quote(p.name)
    resp.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{qname}"
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
    model = str(body.get("model") or "").strip()
    target = str(body.get("target") or "group").strip()

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


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=25.0)
    await ws.prepare(request)
    _WS_CLIENTS.add(ws)
    try:
        await ws.send_str(json.dumps({"type": "hello", "ts": time.time()}))
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    if data.get("type") == "ping":
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


async def handle_pair_page(request: web.Request) -> web.Response:
    if _is_via_public_tunnel(request):
        return web.Response(
            status=403,
            text="为保护您的访问令牌安全，/pair 配对页面仅允许在电脑本机或局域网打开，请在电脑浏览器访问 http://127.0.0.1:18795/pair",
            content_type="text/plain",
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
    pair_uri = build_pair_uri(active_url, token, hostname)
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
        "tunnel": "Cloudflare 加密公网直连（推荐：免 Tailscale，手机可同时挂 v2rayNG / 校园网 / 5G）",
        "lan": "同 Wi-Fi 局域网（家里直连可选；校园网若隔离请用公网隧道）",
        "tailscale": "Tailscale 内网穿透（需手机端切 Tailscale）",
        "vpn": "电脑 VPN 网卡（手机通常不可直连）",
        "other": "网络接口",
    }
    tun_status = tun.get("status", "disabled")
    if tun_status == "online" and tun.get("url"):
        tun_pill_html = '<span class="pill pill-green"><span class="dot"></span>公网隧道在线（免VPN）</span>'
    elif tun_status == "starting":
        tun_pill_html = '<span class="pill pill-host">公网隧道建连中…</span>'
    elif tun_status == "error":
        tun_pill_html = '<span class="pill pill-host">公网隧道重连中…</span>'
    else:
        tun_pill_html = ''
    chips_html_parts: list[str] = []
    addrs_html_parts: list[str] = []
    for item in lans:
        is_active = item["ip"] == active_entry["ip"]
        k_txt = kind_labels.get(item.get("kind", "lan"), "网络")
        esc_iface = html_lib.escape(item["iface"])
        esc_ip = html_lib.escape(item["ip"])
        esc_url = html_lib.escape(item["url"])
        cls = "iface-chip active" if is_active else "iface-chip"
        chip_lbl = f'{esc_iface} ★' if item.get("kind") == "tunnel" else f'{esc_iface} · {esc_ip}'
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
    <a href="/">在浏览器打开 Web 工作台 →</a>
  </footer>
</div>
<div class="toast" id="toast">已复制</div>
<script>
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {{
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
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
        headers: {{ 'Authorization': 'Bearer {esc_token}' }}
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
        headers: {{ 'Authorization': 'Bearer {esc_token}' }}
      }});
      const data = await res.json();
      if (data && data.ok && data.tunnel && data.tunnel.url) {{
        showToast('公网隧道已就绪，正在刷新二维码…');
        setTimeout(() => location.replace('/pair?ip=tunnel'), 400);
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
if ('{tun_status}' === 'starting') {{
  setTimeout(() => location.reload(), 3500);
}}
</script>
</body>
</html>"""
    return web.Response(text=page_html, content_type="text/html", headers={"Cache-Control": "no-store"})


async def handle_static_www(request: web.Request) -> web.StreamResponse:
    name = request.path.lstrip("/") or "index.html"
    if ".." in name:
        return web.Response(status=400, text="bad path")
    p = (WWW_DIR / name).resolve()
    if not p.is_file() or not p.is_relative_to(WWW_DIR.resolve()):
        return web.Response(status=404, text="not found")
    resp = web.FileResponse(p)
    if p.name.lower() == "manifest.json":
        resp.headers["Content-Type"] = "application/manifest+json; charset=utf-8"
    if p.suffix.lower() in (".html", ".css", ".js", ".json"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


async def _desktop_transcript_push_loop(_app: web.Application) -> None:
    """Broadcast real-time update pings whenever any recent desktop transcript changes."""
    last_sigs: dict[str, tuple[int, int]] = {}
    while True:
        await asyncio.sleep(2.0)
        if not _WS_CLIENTS or not DESKTOP_BRAIN.is_dir():
            continue
        try:
            now = time.time()
            changed_cids: list[str] = []
            with os.scandir(DESKTOP_BRAIN) as it:
                for e in it:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    tf = pathlib.Path(e.path) / ".system_generated" / "logs" / "transcript.jsonl"
                    try:
                        st = tf.stat()
                    except OSError:
                        continue
                    if now - st.st_mtime > 300.0:
                        continue
                    sig = (st.st_mtime_ns, st.st_size)
                    prev = last_sigs.get(e.name)
                    last_sigs[e.name] = sig
                    if prev is not None and prev != sig:
                        changed_cids.append(e.name)
            for c in changed_cids[:4]:
                _broadcast_ws({"type": "desktop_update", "conversation_id": c, "ts": now})
        except Exception:
            pass


async def _on_startup(app: web.Application) -> None:
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    get_pair_pin()
    app["desktop_watch_task"] = asyncio.create_task(_desktop_transcript_push_loop(app))


async def _on_cleanup(app: web.Application) -> None:
    _stop_cloudflared_tunnel()
    t = app.get("desktop_watch_task")
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
    app.router.add_get("/api/models", handle_models)
    app.router.add_get("/api/conversations", handle_conversations)
    app.router.add_get("/api/conversations/{cid}", handle_conversation_detail)
    app.router.add_post("/api/chat/send", handle_chat_send)
    app.router.add_post("/api/chat/cancel/{cid}", handle_chat_cancel)
    app.router.add_post("/api/upload", handle_upload)
    app.router.add_get("/api/files", handle_files_list)
    app.router.add_get("/api/files/preview", handle_file_preview)
    app.router.add_get("/api/files/download", handle_file_download)
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
    pair_url = f"{lans[0]['url']}/pair" if lans else f"http://127.0.0.1:{PORT}/pair"
    print(f"[{APP_NAME}] Listening on http://{HOST}:{PORT}", flush=True)
    print(f"[{APP_NAME}] Workspace : {WORKSPACE_ROOT.as_posix()}", flush=True)
    print(f"[{APP_NAME}] agy CLI   : {_find_agy_bin() or 'NOT FOUND'}", flush=True)
    if tun_snap.get("url"):
        print(f"[{APP_NAME}] Public URL: {tun_snap['url']} (Zero-VPN Cloudflare Tunnel)", flush=True)
    else:
        print(f"[{APP_NAME}] Tunnel    : {tun_snap.get('status')} {tun_snap.get('error', '')}", flush=True)
    print(f"[{APP_NAME}] Pair URL  : {pair_url}", flush=True)
    print(f"[{APP_NAME}] Local Pair: http://127.0.0.1:{PORT}/pair", flush=True)
    print(f"[{APP_NAME}] Pair PIN  : {pin}", flush=True)
    print(f"[{APP_NAME}] Token     : {_mask_token(str(cfg.get('token') or ''))}", flush=True)
    web.run_app(create_app(), host=HOST, port=PORT, print=None)
