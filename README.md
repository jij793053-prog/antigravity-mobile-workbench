# Antigravity Mobile & Desktop Sync Workbench

一套轻量、开源、零隐私硬编码的 **Antigravity 手机 App + 电脑宽屏同步工作台 + 通用伴侣服务端（Antigravity Link Server）**。

让你在 **手机（Android 原生 APK）** 与 **电脑宽屏独立窗口** 之间实现 **100% 实时双向流式同步**，随时操控电脑本机 Antigravity CLI（`agy`）与历史桌面会话、切换模型（含 Orchestrator / Swarm 蜂群模式）、无损原图拖传/粘贴、浏览预览下载工作区文件，并内置 **Cloudflare 免 VPN 公网加密隧道**（手机可同时开着 v2rayNG / 梯子，校园网与 5G 通吃）。

---

## 核心特性

- **电脑宽屏同步工作台（v1.6 新增）**
  - **免配对本机自动静默登录**：在电脑打开 `http://127.0.0.1:18795/` 自动同源回环鉴权秒进工作台，零手动输入（同时严格校验回环来源与同源头，杜绝跨站与公网窃取）。
  - **宽屏双栏布局（`>= 960px`）**：左侧 300px 对话列表常驻展开，右侧居中宽屏阅读区，支持一键跳转手机扫码配对页。
  - **拖图 / 粘贴无损原图**：支持直接将电脑里的图片/文件拖进窗口，或截图后 `Ctrl+V` 粘贴，二进制原文件直传不压画质。
  - **独立应用窗口秒开**：附带 [launch_desktop_workbench.bat](launch_desktop_workbench.bat) 与一键桌面快捷方式脚本 [create_desktop_shortcuts.ps1](create_desktop_shortcuts.ps1)，双击即以 Edge/Chrome `--app` 原生无地址栏窗口启动。
- **跨端真·实时双向流式同步**
  - 手机 App 与电脑同步工作台共用同一套本机后端与 WebSocket 实时广播通道：手机派发指令、电脑大屏实时同步呈现思考工具步与逐字流式输出；电脑端发送同理秒级同步到手机。
  - 自动镜像读取桌面端 Antigravity IDE 会话历史，手机/网页续聊时自动合并在同一会话项下，不分裂重复记录。
- **内置 Cloudflare 免 VPN 公网加密隧道**
  - 服务端内置 `cloudflared`（HTTP/2 + WSS）自动守护，支持免费零配置 Quick Tunnel 与自定义固定域名 Named Tunnel。
  - 彻底摆脱手机端 Tailscale 霸占唯一 VPN 槽位的痛点：**手机可 24 小时照常挂着 v2rayNG / 代理用谷歌软件**，校园网、Wi-Fi、5G 全场景直接加密连回电脑，且无需放行 Windows 入站防火墙。
- **Android 原生客户端（Material 3 Expressive，仅 ~515 KB）**
  - 内置原生相机 + ZXing 离线扫码（支持手电筒、相册选码）、6 位数字配对码（每分钟限流 10 次）、多主机切换。
  - QQ 风格底部相册抽屉（无损原图直传）、每个会话独立草稿箱、图片缩略图与无损原图预览、自定义手机下载目录。
  - **零个人隐私硬编码**：通用 APK 与源码不含任何个人路径、IP、Token、账号或私钥，可直接分享给好友自部署。

---

## 一、快速上手（电脑端）

### 1. 环境准备
- 已安装官方 Antigravity CLI（`agy` / `agy.exe`）
- Python 3.10+ 并安装 `aiohttp`：
  ```bash
  pip install aiohttp
  ```
- *(可选，强烈推荐免 VPN 公网直连)* 下载官方 [cloudflared](https://github.com/cloudflare/cloudflared/releases/latest) 放到本项目的 `bin/cloudflared.exe`（或加入系统 `PATH`），服务端启动时将自动建立加密公网隧道。

### 2. 启动服务端 / 打开电脑同步工作台
- **方式 A（推荐，一键桌面图标）**：在 Windows PowerShell 中运行一次：
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\create_desktop_shortcuts.ps1
  ```
  桌面会生成带统一四色 A 标的 **「Antigravity 同步工作台」**（双击免配对宽屏秒开）和 **「Antigravity 手机配对」**（双击打开二维码页）。
- **方式 B（命令行启动）**：
  ```bash
  python agy_mobile_server.py
  ```
  启动后：
  - 电脑宽屏同步工作台：`http://127.0.0.1:18795/`（本机免配对自动进入）
  - 手机配对与二维码页：`http://127.0.0.1:18795/pair`

---

## 二、手机端安装与配对

1. 从本仓库的 [Releases](../../releases)（或 `dist/Antigravity-Mobile-Universal-v1.5.apk`）下载并安装 Android APK。
2. 在电脑打开 `http://127.0.0.1:18795/pair`（或双击桌面「Antigravity 手机配对」）：
   - **扫码一键配对（推荐）**：打开手机 App 点「扫码一键配对」，对准电脑上的 **「Cloudflare 公网免VPN ★」** 二维码即可秒连。
   - **6 位数字配对码**：在手机 App 输入电脑地址（公网隧道地址 / 局域网 IP / Tailscale `100.x`）与页面上的 6 位配对码即可。

---

## 三、永久固定公网域名（可选 Named Tunnel）

默认启用 Cloudflare 免费 Quick Tunnel（零配置即开即用，重启服务端时会生成新的 `trycloudflare.com` 域名）。  
若希望重启电脑后地址也永久不变，可在 Cloudflare Zero Trust 免费创建一个 Tunnel，然后在本地自动生成的 `mobile_config.json` 中填入：

```json
{
  "cloudflare_tunnel_token": "你的_Tunnel_Token",
  "cloudflare_public_url": "https://agy.你的域名.com"
}
```

---

## 四、环境变量与安全机制

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGY_MOBILE_PORT` | `18795` | 监听端口 |
| `AGY_MOBILE_HOST` | `0.0.0.0` | 监听地址（仅限本机访问可设为 `127.0.0.1`） |
| `AGY_MOBILE_WORKSPACE` | 自动探测 | 默认文件浏览器与 CLI 工作区根目录 |
| `AGY_CLI_BIN` | 自动探测 | 指定官方 `agy` / `agy.exe` 路径 |
| `AGY_CLOUDFLARED_BIN` | 自动探测 | 指定 `cloudflared` 路径 |
| `AGY_DISABLE_TUNNEL` | `0` | 设为 `1` 可关闭自动公网隧道 |

**零信任安全设计**：
- **本地自动登录严格隔离**：`/api/local-auth` 校验非公网隧道、无转发代理头、严格回环来源（`127.0.0.1`/`::1`）、同源 `Sec-Fetch-Site` 与 `Origin`，且禁止通配 CORS，防止任何跨站网页或外网读取本机 Token。
- **公网防泄露**：通过 Cloudflare 公网访问 `/pair` 配对页直接返回 `403 Forbidden`，绝不在公网暴露访问令牌或二维码。
- **全接口令牌鉴权**：除 `/health`、`/download-apk`、限流 10 次/分的 `POST /api/pair/claim` 与严格本机 `/api/local-auth` 外，全部 `/api/*` 与 `/ws` 均强制校验随机 Bearer Token。
- **敏感文件屏蔽**：文件浏览、预览与下载自动拒绝 `.ssh`、`.pem`、`.key`、`.jks`、`mobile_config.json` 等敏感文件。

---

## 五、从源码自行构建 Android APK（免 Gradle）

本项目提供零 Gradle 极速构建脚本 [android/build_apk.py](android/build_apk.py)（基于 `aapt2` + `javac 11` + `d8` + `zipalign` + `apksigner`）：

```bash
# 配置 Android SDK 与 ZXing Jar 路径后运行
set ANDROID_SDK_ROOT=path/to/android-sdk
set ZXING_CORE_JAR=path/to/zxing-core-3.5.3.jar
set AGY_KEYSTORE_PASS=your-signing-password
python android/build_apk.py
```

---

## License

[MIT License](LICENSE)
