#!/usr/bin/env python3
"""
Reproducible, zero-Gradle Android APK builder for Antigravity Mobile (M3 Edge-to-Edge).
Pipeline: Pillow M3 Adaptive Icons -> aapt2 compile/link -> javac --release 11 -> d8 -> zipalign -> apksigner.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

# Paths (relative to this script so the project stays portable)
ANDROID_DIR = Path(__file__).resolve().parent
PROJECT_DIR = ANDROID_DIR.parent
MAIN_DIR = ANDROID_DIR / "app" / "src" / "main"
RES_DIR = MAIN_DIR / "res"
JAVA_DIR = MAIN_DIR / "java"
MANIFEST_PATH = MAIN_DIR / "AndroidManifest.xml"
WWW_SRC_DIR = PROJECT_DIR / "www"
BUILD_DIR = ANDROID_DIR / "build"
DIST_DIR = PROJECT_DIR / "dist"
OUTPUT_APK = DIST_DIR / "Antigravity-Mobile-Universal-v1.5.apk"

KEYSTORE_PATH = Path(os.environ.get("AGY_KEYSTORE_PATH", str(ANDROID_DIR / "antigravity_mobile.jks")))
KEY_ALIAS = os.environ.get("AGY_KEY_ALIAS", "antigravity_mobile")
KEY_PASS = os.environ.get("AGY_KEYSTORE_PASS", "changeit-local-dev-key")
KEY_DNAME = "CN=Antigravity Mobile, OU=Antigravity, O=Antigravity, L=Universal, S=Universal, C=US"

SDK_ROOT = Path(
    os.environ.get("ANDROID_SDK_ROOT")
    or os.environ.get("ANDROID_HOME")
    or str(Path.home() / "AppData" / "Local" / "Android" / "Sdk")
)
BUILD_TOOLS_DIR = SDK_ROOT / "build-tools" / "34.0.0"
ANDROID_JAR = SDK_ROOT / "platforms" / "android-34" / "android.jar"
ZXING_JAR = Path(os.environ.get("ZXING_CORE_JAR", str(ANDROID_DIR / "libs" / "zxing-core-3.5.3.jar")))

MIN_SDK = "26"
TARGET_SDK = "34"
VERSION_CODE = "7"
VERSION_NAME = "1.5.1"


def find_tool(name: str, fallback_dir: Path | None = None) -> str:
    if fallback_dir is not None:
        for ext in ("", ".exe", ".bat", ".cmd"):
            candidate = fallback_dir / f"{name}{ext}"
            if candidate.is_file():
                return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    raise FileNotFoundError(f"Required tool not found: {name}")


def find_keytool() -> str:
    found = shutil.which("keytool")
    if found:
        return found
    # Resolve from java.home property
    proc = subprocess.run(
        ["java", "-XshowSettings:properties", "-version"],
        capture_output=True,
        check=False,
    )
    combined = (
        (proc.stdout or b"").decode("utf-8", errors="replace")
        + "\n"
        + (proc.stderr or b"").decode("utf-8", errors="replace")
    )
    match = re.search(r"java\.home\s*=\s*(.+)", combined)
    if match:
        raw_home = match.group(1).strip()
        if len(raw_home) == 2 and raw_home[1] == ":":
            raw_home = raw_home + "/"
        java_home = Path(raw_home)
        for candidate in (
            java_home / "bin" / "keytool.exe",
            java_home / "bin" / "keytool",
            java_home.parent / "bin" / "keytool.exe",
        ):
            if candidate.is_file():
                return str(candidate)
    raise FileNotFoundError("keytool not found in PATH or java.home")


def run_cmd(cmd: list[str], label: str) -> subprocess.CompletedProcess[str]:
    print(f"[build] {label}...")
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        print(f"[ERROR] {label} failed (exit {proc.returncode})")
        if proc.stdout.strip():
            print(proc.stdout.strip())
        if proc.stderr.strip():
            print(proc.stderr.strip())
        sys.exit(proc.returncode)
    return proc


# ---------------------------------------------------------------------------
# Material 3 Adaptive App Icon Generator (4x supersampled Google Prism 'A')
# ---------------------------------------------------------------------------

def _cubic_bezier(p0, p1, p2, p3, steps: int) -> list[tuple[float, float]]:
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = (mt**3) * p0[0] + 3 * (mt**2) * t * p1[0] + 3 * mt * (t**2) * p2[0] + (t**3) * p3[0]
        y = (mt**3) * p0[1] + 3 * (mt**2) * t * p1[1] + 3 * mt * (t**2) * p2[1] + (t**3) * p3[1]
        pts.append((x, y))
    return pts


def _quad_bezier(p0, p1, p2, steps: int) -> list[tuple[float, float]]:
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = (mt**2) * p0[0] + 2 * mt * t * p1[0] + (t**2) * p2[0]
        y = (mt**2) * p0[1] + 2 * mt * t * p1[1] + (t**2) * p2[1]
        pts.append((x, y))
    return pts


def _lerp_color(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return (
        int(round(c1[0] + (c2[0] - c1[0]) * t)),
        int(round(c1[1] + (c2[1] - c1[1]) * t)),
        int(round(c1[2] + (c2[2] - c1[2]) * t)),
    )


def _prism_gradient_color(nx: float, ny: float) -> tuple[int, int, int]:
    """
    Luminous Google 4-color prism progression mapped cleanly across the 'A' mark bounds:
    #9B6BFF (Prism Violet) -> #4285F4 (Google Blue) -> #34A853 (Google Green) -> #FBBC05 (Google Amber)
    """
    stops = [
        (0.00, (155, 107, 255)),  # #9B6BFF (upper-left / apex)
        (0.32, (66, 133, 244)),   # #4285F4 (left leg & upper arch)
        (0.68, (52, 168, 83)),    # #34A853 (right leg)
        (1.00, (251, 188, 5)),    # #FBBC05 (lower-right accent)
    ]
    # Normalize against actual mark extents: x in [0.16, 0.84], y in [0.14, 0.86]
    ux = max(0.0, min(1.0, (nx - 0.16) / 0.68))
    uy = max(0.0, min(1.0, (ny - 0.14) / 0.72))
    t = max(0.0, min(1.0, 0.68 * ux + 0.32 * uy))
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t <= t1:
            local = (t - t0) / max(1e-6, (t1 - t0))
            return _lerp_color(c0, c1, local)
    return stops[-1][1]


def _render_antigravity_mark(canvas_size: int, mark_scale: float, monochrome: bool = False) -> Image.Image:
    """
    Renders the sculptural geometric Antigravity prismatic 'A' mark onto a transparent canvas.
    """
    mask = Image.new("L", (canvas_size, canvas_size), 0)
    draw = ImageDraw.Draw(mask)

    box = canvas_size * mark_scale
    ox = (canvas_size - box) * 0.5
    oy = (canvas_size - box) * 0.5

    def to_px(pt: tuple[float, float]) -> tuple[float, float]:
        return (ox + pt[0] * box, oy + pt[1] * box)

    # Outer soaring arch with smooth horizontal-tangent rounded apex
    left_curve = _cubic_bezier(
        (0.18, 0.84),
        (0.28, 0.56),
        (0.41, 0.15),
        (0.50, 0.15),
        steps=160,
    )
    right_curve = _cubic_bezier(
        (0.50, 0.15),
        (0.59, 0.15),
        (0.72, 0.56),
        (0.82, 0.84),
        steps=160,
    )
    # Floating antigravity orbital bridge anchored seamlessly onto leg centerlines
    left_anchor = left_curve[42]
    right_anchor = right_curve[160 - 42]
    bridge_curve = _quad_bezier(
        left_anchor,
        (0.50, 0.53),
        right_anchor,
        steps=120,
    )

    main_r = box * 0.062
    bridge_r = box * 0.056

    for pt in left_curve + right_curve:
        x, y = to_px(pt)
        draw.ellipse((x - main_r, y - main_r, x + main_r, y + main_r), fill=255)

    for pt in bridge_curve:
        x, y = to_px(pt)
        draw.ellipse((x - bridge_r, y - bridge_r, x + bridge_r, y + bridge_r), fill=255)

    if monochrome:
        out = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 0))
        solid = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 255))
        out.paste(solid, (0, 0), mask)
        return out

    # Build smooth prism gradient over mark bounding box
    grad = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    px = grad.load()
    x0 = max(0, int(ox - main_r - 2))
    y0 = max(0, int(oy - main_r - 2))
    x1 = min(canvas_size, int(ox + box + main_r + 2))
    y1 = min(canvas_size, int(oy + box + main_r + 2))
    m_px = mask.load()

    for y in range(y0, y1):
        ny = (y - oy) / max(1.0, box)
        for x in range(x0, x1):
            a = m_px[x, y]
            if a:
                nx = (x - ox) / max(1.0, box)
                r, g, b = _prism_gradient_color(nx, ny)
                px[x, y] = (r, g, b, a)

    return grad


def _draw_squircle_mask(size: int, margin: int, power: float = 4.6) -> Image.Image:
    """Superellipse (squircle) alpha mask for Material 3 legacy launcher icon."""
    mask = Image.new("L", (size, size), 0)
    px = mask.load()
    cx = (size - 1) * 0.5
    cy = (size - 1) * 0.5
    radius = (size * 0.5) - margin
    inv_r = 1.0 / max(1.0, radius)

    for y in range(size):
        dy = abs(y - cy) * inv_r
        for x in range(size):
            dx = abs(x - cx) * inv_r
            dist = (dx**power + dy**power) ** (1.0 / power)
            if dist <= 1.0 - 1.5 * inv_r:
                px[x, y] = 255
            elif dist < 1.0 + 1.5 * inv_r:
                alpha = int(round(255 * (1.0 - (dist - (1.0 - 1.5 * inv_r)) / (3.0 * inv_r))))
                px[x, y] = max(0, min(255, alpha))
    return mask


def generate_icons() -> None:
    print("[build] Generating Material 3 adaptive & legacy launcher icons...")
    master_size = 512

    # 1. Adaptive foreground (safe zone: ~52% of 108dp canvas)
    fg_master = _render_antigravity_mark(master_size, mark_scale=0.52, monochrome=False)
    mono_master = _render_antigravity_mark(master_size, mark_scale=0.52, monochrome=True)

    # 2. Legacy squircle porcelain icon
    sq_outer = _draw_squircle_mask(master_size, margin=20)
    sq_inner = _draw_squircle_mask(master_size, margin=26)
    legacy_master = Image.new("RGBA", (master_size, master_size), (0, 0, 0, 0))
    border_layer = Image.new("RGBA", (master_size, master_size), (230, 234, 240, 255))
    white_layer = Image.new("RGBA", (master_size, master_size), (255, 255, 255, 255))
    legacy_master.paste(border_layer, (0, 0), sq_outer)
    legacy_master.paste(white_layer, (0, 0), sq_inner)
    mark_legacy = _render_antigravity_mark(master_size, mark_scale=0.62, monochrome=False)
    legacy_master.alpha_composite(mark_legacy)

    # 3. Round porcelain icon
    round_master = Image.new("RGBA", (master_size, master_size), (0, 0, 0, 0))
    r_draw = ImageDraw.Draw(round_master)
    r_draw.ellipse((20, 20, master_size - 20, master_size - 20), fill=(230, 234, 240, 255))
    r_draw.ellipse((26, 26, master_size - 26, master_size - 26), fill=(255, 255, 255, 255))
    round_master.alpha_composite(mark_legacy)

    densities = {
        "mipmap-mdpi": (48, 108),
        "mipmap-hdpi": (72, 162),
        "mipmap-xhdpi": (96, 216),
        "mipmap-xxhdpi": (144, 324),
        "mipmap-xxxhdpi": (192, 432),
    }

    for folder, (icon_px, fg_px) in densities.items():
        out_dir = RES_DIR / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        legacy_master.resize((icon_px, icon_px), Image.Resampling.LANCZOS).save(
            out_dir / "ic_launcher.png", optimize=True
        )
        round_master.resize((icon_px, icon_px), Image.Resampling.LANCZOS).save(
            out_dir / "ic_launcher_round.png", optimize=True
        )
        fg_master.resize((fg_px, fg_px), Image.Resampling.LANCZOS).save(
            out_dir / "ic_launcher_foreground.png", optimize=True
        )
        mono_master.resize((fg_px, fg_px), Image.Resampling.LANCZOS).save(
            out_dir / "ic_launcher_monochrome.png", optimize=True
        )


def ensure_keystore(keytool: str) -> None:
    if KEYSTORE_PATH.is_file():
        return
    run_cmd(
        [
            keytool,
            "-genkeypair",
            "-v",
            "-keystore",
            str(KEYSTORE_PATH),
            "-storetype",
            "PKCS12",
            "-alias",
            KEY_ALIAS,
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-validity",
            "10000",
            "-storepass",
            KEY_PASS,
            "-keypass",
            KEY_PASS,
            "-dname",
            KEY_DNAME,
        ],
        "Generating release signing keystore",
    )


def build_apk() -> None:
    t0 = time.perf_counter()

    if not ANDROID_JAR.is_file():
        raise FileNotFoundError(f"android.jar not found at {ANDROID_JAR}")
    if not ZXING_JAR.is_file():
        raise FileNotFoundError(f"zxing-core jar not found at {ZXING_JAR}")
    if not WWW_SRC_DIR.is_dir():
        raise FileNotFoundError(f"Web assets directory not found at {WWW_SRC_DIR}")

    aapt2 = find_tool("aapt2", BUILD_TOOLS_DIR)
    d8 = find_tool("d8", BUILD_TOOLS_DIR)
    zipalign = find_tool("zipalign", BUILD_TOOLS_DIR)
    apksigner = find_tool("apksigner", BUILD_TOOLS_DIR)
    javac = find_tool("javac")
    keytool = find_keytool()

    generate_icons()
    ensure_keystore(keytool)

    # Clean build scratch directory
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    assets_www_dir = BUILD_DIR / "assets" / "www"
    gen_dir = BUILD_DIR / "gen"
    classes_dir = BUILD_DIR / "classes"
    dex_dir = BUILD_DIR / "dex"
    for d in (assets_www_dir, gen_dir, classes_dir, dex_dir, DIST_DIR):
        d.mkdir(parents=True, exist_ok=True)

    # Copy web assets cleanly
    copied_files: list[str] = []
    for src in sorted(WWW_SRC_DIR.rglob("*")):
        if src.is_file():
            rel = src.relative_to(WWW_SRC_DIR)
            dst = assets_www_dir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied_files.append(f"assets/www/{rel.as_posix()}")
    print(f"[build] Staged {len(copied_files)} web asset(s): {', '.join(copied_files)}")

    res_zip = BUILD_DIR / "compiled_res.zip"
    unaligned_apk = BUILD_DIR / "app-unaligned.apk"
    aligned_apk = BUILD_DIR / "app-aligned.apk"

    # 1. Compile Android resources
    run_cmd(
        [aapt2, "compile", "--dir", str(RES_DIR), "-o", str(res_zip)],
        "aapt2 compile resources",
    )

    # 2. Link resources + manifest + assets -> base APK + R.java
    run_cmd(
        [
            aapt2,
            "link",
            "-I",
            str(ANDROID_JAR),
            "--manifest",
            str(MANIFEST_PATH),
            "-A",
            str(BUILD_DIR / "assets"),
            "--java",
            str(gen_dir),
            "--min-sdk-version",
            MIN_SDK,
            "--target-sdk-version",
            TARGET_SDK,
            "--version-code",
            VERSION_CODE,
            "--version-name",
            VERSION_NAME,
            "--auto-add-overlay",
            "-o",
            str(unaligned_apk),
            str(res_zip),
        ],
        "aapt2 link resources & assets",
    )

    # 3. Compile Java sources (Java 11 bytecode for Android DEX compatibility)
    java_sources = [str(p) for p in sorted(gen_dir.rglob("*.java"))] + [
        str(p) for p in sorted(JAVA_DIR.rglob("*.java"))
    ]
    javac_cp = os.pathsep.join([str(ANDROID_JAR), str(ZXING_JAR)])
    run_cmd(
        [
            javac,
            "--release",
            "11",
            "-encoding",
            "UTF-8",
            "-cp",
            javac_cp,
            "-d",
            str(classes_dir),
            *java_sources,
        ],
        "javac compile (--release 11)",
    )

    # 4. DEX compilation via d8 (includes bundled ZXing QR core)
    class_files = [str(p) for p in sorted(classes_dir.rglob("*.class"))]
    run_cmd(
        [
            d8,
            "--release",
            "--min-api",
            MIN_SDK,
            "--lib",
            str(ANDROID_JAR),
            "--output",
            str(dex_dir),
            *class_files,
            str(ZXING_JAR),
        ],
        "d8 dex compilation (app + zxing-core)",
    )

    dex_file = dex_dir / "classes.dex"
    if not dex_file.is_file():
        raise FileNotFoundError("d8 did not produce classes.dex")

    # 5. Merge classes.dex into APK
    print("[build] Merging classes.dex into APK...")
    with zipfile.ZipFile(unaligned_apk, "a", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(dex_file, arcname="classes.dex")

    # 6. Zipalign (4-byte alignment + page-align native libs if any)
    run_cmd(
        [zipalign, "-p", "-f", "4", str(unaligned_apk), str(aligned_apk)],
        "zipalign APK",
    )

    # 7. Sign APK (v1 + v2 + v3)
    run_cmd(
        [
            apksigner,
            "sign",
            "--ks",
            str(KEYSTORE_PATH),
            "--ks-key-alias",
            KEY_ALIAS,
            "--ks-pass",
            f"pass:{KEY_PASS}",
            "--key-pass",
            f"pass:{KEY_PASS}",
            "--v1-signing-enabled",
            "true",
            "--v2-signing-enabled",
            "true",
            "--v3-signing-enabled",
            "true",
            "--out",
            str(OUTPUT_APK),
            str(aligned_apk),
        ],
        "apksigner sign APK (v1+v2+v3)",
    )

    # 8. Verify signature & dump badging
    verify = run_cmd(
        [apksigner, "verify", "--verbose", "--print-certs", str(OUTPUT_APK)],
        "apksigner verify",
    )
    badging = run_cmd(
        [aapt2, "dump", "badging", str(OUTPUT_APK)],
        "aapt2 dump badging",
    )

    elapsed = time.perf_counter() - t0
    size_bytes = OUTPUT_APK.stat().st_size
    print(f"\n[OK] Built signed APK in {elapsed:.2f}s")
    print(f"[OK] Path: {OUTPUT_APK} ({size_bytes:,} bytes / {size_bytes / 1024:.1f} KB)")
    print("\n--- apksigner verify ---")
    print(verify.stdout.strip())
    print("\n--- aapt2 dump badging (summary) ---")
    for line in badging.stdout.splitlines():
        if line.startswith(("package:", "sdkVersion:", "targetSdkVersion:", "application-label:", "application-icon", "launchable-activity:")):
            print(line)


if __name__ == "__main__":
    build_apk()
