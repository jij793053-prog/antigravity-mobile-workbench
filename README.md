# Antigravity Mobile & Desktop Sync Workbench

一套轻量、开源、零隐私硬编码的 **Antigravity 手机 App（Android 原生 APK） + 电脑宽屏同步工作台 + 通用伴侣服务端（Antigravity Link Server）**。

让你在 **手机** 与 **电脑同步工作台** 之间实现 **100% 实时逐字双向流式同步**：随时随地指挥电脑本机谷歌官方 Antigravity CLI（`agy`）、实时查看并续聊桌面 Antigravity IDE 历史会话、切换模型（含 Orchestrator 智能编排）、无损原图直传、在线浏览/预览/下载电脑工作区文件，并内置 **Cloudflare 免 VPN 公网加密隧道**（手机可一直挂着梯子/代理，校园网、公司网、Wi-Fi、5G 通吃）。

> [!IMPORTANT]
> **使用前必读（同步范围提前说明，避免误会）：**
> - **手机 App 发出的消息，不会显示在电脑「谷歌官方 Antigravity 客户端（IDE）」的聊天窗口里**：谷歌官方桌面端（`44.9.1+`）出于安全隔离已彻底封死外部程序写入接口，本项目仅调用合规的官方 `agy` CLI，不做任何客户端破解或进程注入。
> - **想在电脑上实时看到手机发出的对话并双向续聊，请直接使用本项目自带的「电脑同步工作台」窗口**（双击桌面图标或访问 `http://127.0.0.1:18795/`）：它与手机 App **100% 实时逐字双向同步**，并会按真实时间轴自动合并展示「官方桌面客户端历史 + 手机新对话 + 工作台对话」（续聊时还会自动增量同步官方桌面端的新上下文给 AI）；同时电脑硬盘上的代码/文件三端实时共享。

```text
  [Android 手机 App (~520 KB)]              [电脑同步工作台 (宽屏独立窗口)]
               │                                           │
   Cloudflare 免 VPN 隧道 / 局域网 / Tailscale     127.0.0.1 本机免配对直连
               └──────────────► [Antigravity Link Server] ◄┘
                                    (本机 :18795)
                                     │         │
                     驱动官方 agy CLI │         │ 实时只读镜像官方 IDE 历史
          (~/.gemini/antigravity-cli)│         │ (~/.gemini/antigravity/brain)
                                     ▼         ▼
                            共同读写电脑磁盘工作区文件
```

---

## 为什么需要「电脑同步工作台」？架构与同步边界说明

很多刚接触本项目的朋友会问：**“既然电脑上已经有官方 Antigravity IDE 了，为什么还需要一个「电脑同步工作台」？”**

原因非常透明——这是由官方客户端的底层存储隔离机制决定的：
- 谷歌官方 **Antigravity IDE** 的对话数据保存在 `~/.gemini/antigravity/brain`，由官方客户端独占管理，**禁止外部工具直接写入**。
- 本套件底层通过官方 **`agy` CLI** 执行对话与任务（CLI 对话记录保存在 `~/.gemini/antigravity-cli`），由本机伴侣服务端统一托管实时 WebSocket 流与文件操作。
- 为了让你在「电脑」与「手机」之间获得丝滑无缝的跨端协作体验，我们提供了与手机端共用同一套本机后端的 **电脑同步工作台**，同时对官方 IDE 的历史对话做实时只读镜像与增量上下文桥接：

| 同步方向 / 数据层 | 同步能力 | 详细说明 |
| --- | --- | --- |
| **手机 App ↔ 电脑同步工作台** | **100% 实时逐字双向流式同步** | 共用同一本机服务端与 WebSocket 广播通道：任一端发送消息、查看思考过程/工具调用、逐字流式输出、或点击中止任务，另一端毫秒级同步呈现。 |
| **官方 Antigravity IDE → 手机 App / 电脑工作台** | **实时只读镜像 + 按时间戳归并 + 增量上下文同步** | 服务端实时读取 `~/.gemini/antigravity/brain` 中的官方桌面对话，并按时间戳与你在手机/工作台的续聊记录归并在同一会话项下；当你从手机或工作台续聊该会话时，服务端会自动将最新的官方桌面增量上下文同步喂给 AI，做到无缝接力。 |
| **手机 App / 电脑工作台 → 官方 Antigravity IDE 聊天界面** | **不反写官方 IDE 聊天框** | 官方 IDE 禁止外部进程向其 `brain` 会话界面写入消息，因此手机/工作台的新对话不会反向出现在官方 IDE 聊天窗口里。日常需要跨端接力时，推荐在电脑上直接使用「电脑同步工作台」。 |
| **电脑磁盘代码 / 项目文件** | **三端 100% 实时共享** | 官方 IDE、电脑同步工作台与手机 App 操作的是同一台电脑的磁盘工作区；无论哪一端新建或修改了代码、脚本或图片，另两端立即可见。 |

> [!TIP]
> 最佳实践：在电脑上用官方 IDE 写代码或查阅工程，需要和手机无缝接力对话时，双击桌面唯一的 **「Antigravity 同步工作台」** 图标即可——离开工位拿起手机就能紧接着上一秒的流式输出继续聊。

---

## 核心特性

### 1. 电脑同步工作台（Desktop Sync Workbench）
- **单图标秒开**：Windows 一键创建桌面唯一图标「Antigravity 同步工作台」，双击自动无窗拉起后台服务 + 公网隧道，并以 Edge/Chrome `--app` 独立无地址栏窗口打开（关掉窗口后后台服务与隧道保持常驻，手机不掉线）。
- **本机回环自动免配对**：电脑本机打开 `http://127.0.0.1:18795/` 自动同源回环静默登录，零手动输码。
- **内置「供手机扫码」配对弹窗**：顶栏与侧栏底部直接内置配对入口，同窗口直看公网/局域网二维码与 6 位数字配对码，不需要第二个图标或切换网页。
- **宽屏双栏布局**：宽度 `>= 960px` 自动展开左侧常驻会话列表 + 右侧宽屏阅读区，自带工作区文件浏览器与代码/图片预览。
- **拖图 / `Ctrl+V` 无损原图直传**：直接把电脑里的图片或文件拖入窗口，或截图后 `Ctrl+V` 粘贴，原文件二进制无损直传工作区。

### 2. Android 通用客户端（`v1.6.2`，仅 ~530 KB）
- **Material 3 现代界面**：Edge-to-Edge 沉浸式适配、浅色/深色主题自由切换、图片原图预览支持双指缩放。
- **额度与用量统计看板**：内置「额度与用量」仪表盘，基于本机官方桌面端与 CLI 完整对话日志实时核算 **近 5 小时 / 今日 24h / 近 7 天（含每日趋势柱图）/ 当前会话** 的 Token 消耗、缓存命中率与分模型池占比（亦支持通过 `AGY_QUOTA_API_URL` 可选对接自定义云端余量接口）。
- **内置离线扫码**：原生相机 + ZXing 离线解析二维码（支持手电筒、相册选码），同时支持 6 位数字配对码与多台电脑主机一键切换。
- **QQ 风格底部相册抽屉**：输入框一键唤起本地相册抽屉，极速加载缩略图、支持多选无损原图直传。
- **每会话独立草稿箱**：不同会话各自独立保存未发送草稿，来回切换对话绝不丢字。
- **自定义下载目录**：支持自定义手机端下载子目录（或系统文件选择器保存），随时下载电脑工作区产出文件。
- **零个人隐私硬编码**：通用安装包与仓库源码不含任何个人路径、IP、Token、账号或私钥，下载即用，也可放心分享给朋友自部署。

### 3. 侧栏会话分类与外部 CLI 开关
- 侧栏顶部默认提供 **`全部` / `移动` / `桌面`** 三个清爽分类栏位（在手机/工作台续聊过的桌面会话会带 `同步` 徽标，同时归入 `移动` 与 `桌面`）。
- 在右上角/侧栏 **「设置 → 侧栏会话过滤」** 中，可按需开启 **「显示外部 CLI / QQ 机器人会话」**（默认关闭），开启后自动解锁第 4 个 **`外部/QQ`** 栏位，方便查看在终端独立运行 `agy` 或外部机器人产生的 CLI 会话。

### 4. Cloudflare 免 VPN 公网加密隧道（带僵尸断连自动自愈）
- 服务端内置 `cloudflared`（HTTP/2 + WSS）自动守护，支持免费零配置 Quick Tunnel 与永久固定域名 Named Tunnel。
- **僵尸隧道自动检测与自愈**：服务端每 15 秒通过 `cloudflared` 官方 `--metrics /ready` 接口巡检 `readyConnections`；当电脑休眠醒来或代理切换导致隧道出站归零超过 45 秒时，自动标记状态并终止重拉新通道（配对页同步提示并自动刷新二维码），不再假绿灯。
- 彻底摆脱手机端 Tailscale / WireGuard 霸占 Android 唯一 VPN 槽位的限制：**手机可以 24 小时一直开着梯子/代理软件**，在校园网、公司内网、Wi-Fi、5G 下都能直接加密连回家里电脑，且无需公网 IP 或开放入站防火墙端口。

---

## 部署步骤（Windows / macOS / Linux）

### 第一步：前置条件与安装依赖

1. **克隆本仓库**：
   ```bash
   git clone https://github.com/jij793053-prog/antigravity-mobile-workbench.git
   cd antigravity-mobile-workbench
   ```

2. **确认已安装并登录谷歌官方 Antigravity CLI（`agy`）**：
   ```bash
   agy --version
   agy login
   ```
   > [!IMPORTANT]
   > 首次部署务必先在终端完成 `agy login` 授权并确认 `agy --version` 正常输出；服务端通过调用本机 `agy` 可执行文件来驱动对话。

3. **安装 Python 3.10+ 运行依赖**（服务端仅需 `aiohttp`）：
   ```bash
   pip install -r requirements.txt
   ```
   *(可选：推荐在项目目录创建虚拟环境 `python -m venv .venv` 后安装依赖，项目自带的启动脚本会自动探测项目内的 `.venv/` 或 `venv/`。)*

---

### 第二步：（可选，强烈推荐）配置免 VPN 公网隧道 `cloudflared`

如果希望手机在外出 5G、校园网或一直挂着代理软件时免 VPN 直连电脑，请从官方页面下载对应系统的 [`cloudflared` 最新版本](https://github.com/cloudflare/cloudflared/releases/latest)（免费 Quick Tunnel 无需注册任何账号）：

| 操作系统 | 推荐放置路径（项目根目录内） | 备选方式 |
| --- | --- | --- |
| **Windows** | `bin/cloudflared.exe` | 放入系统 `PATH`，或设置 `AGY_CLOUDFLARED_BIN` |
| **macOS** | `bin/cloudflared`（执行 `chmod +x bin/cloudflared`） | `brew install cloudflared` |
| **Linux** | `bin/cloudflared`（执行 `chmod +x bin/cloudflared`） | 放入 `/usr/local/bin/cloudflared` 或设置 `AGY_CLOUDFLARED_BIN` |

放好后无需任何额外配置，启动服务端时会自动建立 Cloudflare 加密公网隧道并在配对弹窗中生成专属二维码。

---

### 第三步：启动服务（按平台选择）

#### Windows（推荐：一键生成桌面单图标）

在项目目录打开 PowerShell 运行一次：

```powershell
powershell -ExecutionPolicy Bypass -File .\create_desktop_shortcuts.ps1
```

桌面会生成唯一一个四色 A 标的 **「Antigravity 同步工作台」** 快捷方式：
- **双击图标**：自动在后台无窗启动 `agy_mobile_server.py` 与 `cloudflared` 公网隧道，随后以 Edge/Chrome `--app` 独立宽屏窗口打开工作台；关闭窗口后后台服务与隧道保持常驻，手机不会断连。
- **前台查看日志启动**：如需在命令行窗口观察实时日志，可直接运行 [`start_link_server.bat`](start_link_server.bat)。
- **快捷直达配对弹窗**：也可运行 [`launch_desktop_pair.bat`](launch_desktop_pair.bat) 直接打开工作台并弹出手机配对二维码窗口。

#### macOS / Linux

```bash
# 方式 1：使用启动脚本（仓库默认已带可执行权限）
chmod +x ./start_link_server.sh
./start_link_server.sh

# 方式 2：直接用 Python 启动
python3 agy_mobile_server.py

# 如需后台常驻（也可使用 tmux / screen / systemd / launchd）
nohup ./start_link_server.sh > agy_server.log 2>&1 &
```

启动完成后，在电脑本机浏览器打开：
- 电脑同步工作台：`http://127.0.0.1:18795/`（本机回环免配对秒进）
- 独立配对二维码页：`http://127.0.0.1:18795/pair`（仅限电脑本机访问）

#### 不使用 `cloudflared`：纯局域网 Wi-Fi / Tailscale 用法

如果你不打算使用 Cloudflare 公网隧道（未放置 `cloudflared`，或设置环境变量 `AGY_DISABLE_TUNNEL=1`），服务端会自动扫描电脑的真实局域网 IP（自动过滤 WSL / Hyper-V / Docker / VirtualBox / VMware 等虚拟网卡）以及 Tailscale `100.x` 地址：

- **Windows 局域网直连**：
  1. 双击运行项目根目录的 [`allow_firewall_port.bat`](allow_firewall_port.bat)（会自动请求管理员 UAC 提权），仅在 **专用网络（Private）** 放行入站 TCP `18795` 端口（兼容自定义 `AGY_MOBILE_PORT`，不会对公共 Wi-Fi 开放端口）。
  2. 双击 [`start_link_server.bat`](start_link_server.bat) 或桌面「Antigravity 同步工作台」图标启动服务，确保手机与电脑连接同一局域网 Wi-Fi（或均开启 Tailscale）即可扫码配对。
- **macOS / Linux 局域网直连**：
  1. 若开启了本机防火墙（如 `ufw` / `firewalld`），请在可信局域网段放行 `18795/tcp`。
  2. 运行 [`./start_link_server.sh`](start_link_server.sh) 启动服务后，打开 `http://127.0.0.1:18795/` 点「手机配对」选择局域网或 Tailscale 二维码扫码即可。

---

### 第四步：查看、重启与关闭后台常驻服务

修改 `mobile_config.json`（例如配置永久固定域名）或需要释放端口时，可按以下方式管理后台服务：

**Windows (PowerShell)**：
```powershell
# 1. 查看服务健康状态（或直接浏览器访问 http://127.0.0.1:18795/health）
curl.exe --noproxy "*" http://127.0.0.1:18795/health

# 2. 查看正在运行的后台服务端与隧道进程
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*agy_mobile_server.py*" -or $_.CommandLine -like "*cloudflared*"
} | Select-Object ProcessId, Name, CommandLine

# 3. 停止后台服务与本套件拉起的 cloudflared 进程（若本机另跑有其它 cloudflared 隧道，请改按上面查出的 PID 精准停止）
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*agy_mobile_server.py*" -or $_.CommandLine -like "*cloudflared*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 4. 重启：停止后重新双击桌面「Antigravity 同步工作台」图标或运行 .\start_link_server.bat 即可
```

**macOS / Linux (Bash)**：
```bash
# 查看状态与进程
curl --noproxy "*" http://127.0.0.1:18795/health
ps aux | grep -E "agy_mobile_server\.py|cloudflared"

# 停止服务（前台运行直接按 Ctrl+C；后台常驻执行 pkill）
pkill -f agy_mobile_server.py

# 重启服务
./start_link_server.sh
```

---

## 日常使用指南

### 1. 电脑端工作台使用
1. 双击桌面 **「Antigravity 同步工作台」** 图标（macOS/Linux 浏览器访问 `http://127.0.0.1:18795/`），自动静默鉴权进入工作台。
2. **管理会话**：侧栏支持关键词搜索与 **`全部` / `移动` / `桌面`** 分类切换；如需查看终端直接执行 `agy` 或外部机器人产生的独立会话，点击 **设置 → 侧栏会话过滤** 开启 **「显示外部 CLI / QQ 机器人会话」** 即可解锁 **`外部/QQ`** 栏位。
3. **发图与文件操作**：直接将图片/文件拖入输入框或截图后 `Ctrl+V` 无损粘贴；顶部可实时切换模型（支持 Orchestrator 编排模式）；左侧/顶栏可打开工作区文件浏览器预览代码、查看图片或下载文件。
4. **随时给手机扫码**：点击顶栏或侧栏底部的 **「手机配对」** 按钮即可直接在当前窗口弹出二维码与 6 位数字配对码。

### 2. 手机端安装与配对
1. **下载并安装 Android APK**：
   - 直接安装本仓库内的 [`dist/Antigravity-Mobile-Universal-v1.6.apk`](dist/Antigravity-Mobile-Universal-v1.6.apk)（Android 8.0+ / API 26+，~520 KB，`v1.6.1`）。
   - 后续正式版本亦可在 GitHub [Releases](../../releases) 页面下载；服务端运行中时，手机也可通过配对页提供的链接下载同款 APK。
2. **与电脑配对（任选其一）**：
   - **扫码一键配对（推荐）**：
     1. 在电脑工作台点击 **「手机配对」**（或本机打开 `http://127.0.0.1:18795/pair`）。
     2. 有公网隧道时默认展示 **「Cloudflare 公网免 VPN ★」** 二维码；无隧道时可切换到局域网 Wi-Fi 或 Tailscale 标签页。
     3. 打开手机 App 点击 **「扫码一键配对」**，扫描二维码后在弹出的**主机导入确认弹窗**中核对名称与地址，点确认即可秒连。
   - **6 位数字配对码**：
     - 在手机 App 中选择手动配对，输入电脑地址（例如 `https://xxx.trycloudflare.com`、你的固定域名、局域网 `http://192.168.1.10:18795` 或 Tailscale `http://100.x.x.x:18795`）以及电脑配对页显示的 6 位数字配对码，系统会自动换取随机访问令牌并建立连接。
3. **手机端日常技巧**：
   - 点击输入框旁 `+` 唤起 **QQ 风格相册抽屉**，支持勾选多张图片无损原图直传。
   - 每个对话的草稿箱独立存储；在设置页可自定义文件下载子目录、切换浅色/深色主题以及管理多台已配对电脑。

### 3. 进阶：配置永久固定公网域名（Cloudflare Named Tunnel）

默认启用的 Cloudflare Quick Tunnel 零配置免费即用，但每次重启服务端会分配新的随机 `*.trycloudflare.com` 域名（重启后手机需重扫一次二维码）。如果你有托管在 Cloudflare 的个人域名，可按以下 5 步免费配置永久固定地址，重启电脑后手机零重配：

1. 登录 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/) → 左侧进入 **Networks** → **Tunnels** → 点击 **Create a tunnel**，隧道类型选择 **Cloudflared**。
2. 给隧道起一个名字（如 `antigravity-pc`），在安装指引页复制生成的 **Tunnel Token**。
3. 切换到该隧道的 **Public Hostname** 页面，点击 **Add a public hostname**，将你的域名指向本机 `http://127.0.0.1:18795`：
   - **Subdomain / Domain**：填写你的自定义域名，例如 `agy.example.com`
   - **Service Type**：选择 `HTTP`
   - **URL**：填写 `127.0.0.1:18795`（若修改了 `AGY_MOBILE_PORT` 请填写对应端口）
   - 保存路由配置。
4. 编辑项目目录下首次启动后自动生成的 `mobile_config.json`（已在 `.gitignore` 中被忽略，切勿提交到仓库），添加或修改以下两项：
   ```json
   {
     "cloudflare_tunnel_token": "你的_Cloudflare_Tunnel_Token",
     "cloudflare_public_url": "https://agy.example.com"
   }
   ```
   *(两项需同时配置完整；服务端运行 `cloudflared` 时会通过环境变量 `TUNNEL_TOKEN` 传入，不会在系统进程命令行参数中泄露 Token。)*
5. **重启后台服务端**（参考上文「查看、重启与关闭后台常驻服务」停止后重新启动），重新打开「手机配对」即可使用你的永久固定域名扫码连接。

---

## 环境变量配置参考

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGY_MOBILE_PORT` | `18795` | 服务端监听端口 |
| `AGY_MOBILE_HOST` | `0.0.0.0` | 监听地址（若只用本机工作台 + Cloudflare 隧道且不需要局域网直连，建议设为 `127.0.0.1`） |
| `AGY_MOBILE_WORKSPACE` | 自动探测 | 文件浏览器与 `agy` CLI 默认运行的工作区根目录 |
| `AGY_MOBILE_PYTHON` | 自动探测 | 显式指定已安装 `aiohttp` 的 Python 解释器路径 |
| `AGY_CLI_BIN` | 自动探测 | 显式指定官方 `agy` / `agy.exe` 可执行文件路径 |
| `AGY_CLOUDFLARED_BIN` | 自动探测 | 显式指定 `cloudflared` 可执行文件路径 |
| `AGY_DISABLE_TUNNEL` | `0` | 设为 `1` 关闭自动 Cloudflare 公网隧道（纯局域网/本机模式） |
| `AGY_QUOTA_API_URL` | 空（关闭） | 可选：自定义外部额度余量 JSON 接口（仅限 `127.0.0.1` 或 `https://`，默认空不探测） |

---

## 安全架构与透明声明

### 核心安全设计
1. **本机回环鉴权严格隔离**：
   - `/api/local-auth` 与 `/pair` 配对页严格限定仅接受来自电脑本机回环地址（`127.0.0.1` / `::1`）的同源请求，**完全禁用通配 CORS（`OPTIONS /pair` 直接返回 `403`）**。
   - 服务端会拦截所有经由公网隧道或反向代理头（`CF-Ray`、`X-Forwarded-For`、`X-Forwarded-Host`、`X-Real-IP`、`Forwarded` 等）以及局域网发起的 `/pair` 与 `/api/local-auth` 请求（统一返回 `403 Forbidden`），防止恶意网页跨站窃取或外网/同局域网设备直接读取访问令牌。
   - 通过公网隧道访问 `/health` 健康检查时会自动隐藏本机主机名。
2. **6 位数字配对码防爆破与自动轮换**：
   - `POST /api/pair/claim` 对客户端来源实施严格限流（仅在本机可信 Cloudflare 代理链路下采信 `CF-Connecting-IP`，忽略客户端伪造的 `X-Forwarded-For`），失败时增加延迟，并具备 **10 分钟有效期（过期自动轮换）**、**全局累计失败阈值自动轮换** 以及 **单次配对成功后立即轮换** 机制。
   - 手机端通过二维码、深链接（`agylink://pair`）或链接参数导入新主机时，强制弹出人工二次确认框，杜绝恶意链接静默劫持主机。
3. **文件浏览器工作区沙箱限制**：
   - 文件列表、在线预览与下载接口在路径解析后严格校验目标必须位于允许的工作区根目录 / 上传目录 / 会话目录内，在路径解析前直接拦截 Windows UNC 路径（`\\server\share`）与路径穿越，并对会话 ID 实施严格正则校验。
   - 内置敏感文件黑名单，自动拒绝读取 `.ssh`、`.env*`、`.netrc`、`.npmrc`、`.git-credentials`、`.pem`、`.key`、`.jks`、`mobile_config.json` 等凭据文件；`.svg` 禁止作为可执行内联图形渲染，防止同源 XSS。
4. **Android WebView `AndroidBridge` 严格隔离**：
   - 本地应用资源通过虚拟本地源加载，彻底禁用 `file://` 通用跨域访问与不安全混合内容，并设置 `android:allowBackup="false"` 防止云端/ADB 备份提取已保存的令牌。
   - 官方网页模式运行在完全独立且**未挂载任何 `AndroidBridge`** 的 WebView 中；主 WebView 中点击任意外部链接均强制交由系统浏览器打开，且媒体上传接口严格校验上传目标属于用户已配对保存的主机源。
5. **全接口随机令牌鉴权**：
   - 除 `/health`、`/download-apk`、限流配对接口与严格本机 `/api/local-auth` 外，所有 `/api/*` 与 `/ws` 连接均强制校验服务端自动生成的随机 Bearer Token（持久化在本地被 `.gitignore` 忽略的 `mobile_config.json` 中）。

> [!WARNING]
> **权限透明披露（`--dangerously-skip-permissions`）**
>
> 为了让手机远程下达指令时无需守在电脑前逐次点击权限弹窗，服务端在调用本机官方 `agy` CLI 时会在工作区目录下启用 **`--dangerously-skip-permissions`** 参数。这意味着：**任何获得你服务端 Bearer Token 或完成配对的设备，都等同于拥有在当前电脑用户权限下驱动 AI 读写工作区文件与执行终端命令的能力。**
>
> 请务必做到：
> - **绝不泄露** `mobile_config.json`、配对页二维码截图或 6 位配对码。
> - 若使用 Cloudflare 隧道且不需要同 Wi-Fi 局域网直连，建议设置 `AGY_MOBILE_HOST=127.0.0.1`，彻底关闭局域网监听；使用局域网直连时仅在可信私人网络放行防火墙。
> - 建议通过 `AGY_MOBILE_WORKSPACE` 将工作区限定在专用工程目录中。
> - 若怀疑令牌泄露，立即删除 `mobile_config.json` 中的 `token` 字段（或删除整个 `mobile_config.json`）并重启服务端，旧令牌会立刻失效。

---

## 从源码自行构建 Android APK（免 Gradle）

本项目提供零 Gradle 极速构建脚本 [`android/build_apk.py`](android/build_apk.py)（基于 `aapt2` + `javac --release 11` + `d8` + `zipalign` + `apksigner`），数秒即可生成对齐并完成 v1+v2+v3 签名的通用安装包 `dist/Antigravity-Mobile-Universal-v1.6.apk`。

### 构建前置依赖
1. **JDK 11+**（确保 `javac` 与 `keytool` 在 `PATH` 中）
2. **Android SDK**，至少安装以下两个组件（脚本也支持自动探测已安装的相近版本）：
   - `build-tools;34.0.0`
   - `platforms;android-34`
   *(可通过 Android Studio 的 SDK Manager 或命令行 `sdkmanager "build-tools;34.0.0" "platforms;android-34"` 安装。)*
3. **Python 3.10+ 与 Pillow**（用于生成 Material 3 自适应图标）：
   ```bash
   pip install Pillow
   ```
4. **ZXing Core 3.5.3（离线扫码库）**：从 Maven Central 官方源下载：
   - 官方下载地址：`https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar`
   - 保存为 `android/libs/zxing-core-3.5.3.jar`（或通过环境变量 `ZXING_CORE_JAR` 指定路径）。
5. **签名密码环境变量 `AGY_KEYSTORE_PASS`**：
   - 构建脚本通过环境变量 `AGY_KEYSTORE_PASS` 自动创建或使用签名密钥库（默认位于 `android/antigravity_mobile.jks`，已被 `.gitignore` 忽略），并以 `env:AGY_KEYSTORE_PASS` 方式传给 `apksigner`，不会在命令行参数中暴露明文密码。
   - 如需自定义密钥库位置或别名，可额外设置 `AGY_KEYSTORE_PATH` 与 `AGY_KEY_ALIAS`。

### Windows (PowerShell) 构建命令

```powershell
# 1. 下载 ZXing 离线扫码库（首次执行即可）
New-Item -ItemType Directory -Force android/libs | Out-Null
Invoke-WebRequest `
  -Uri "https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar" `
  -OutFile "android/libs/zxing-core-3.5.3.jar"

# 2. 安装图标生成依赖
pip install Pillow

# 3. 设置环境变量并执行构建
$env:ANDROID_SDK_ROOT  = "$env:LOCALAPPDATA\Android\Sdk"
$env:ZXING_CORE_JAR    = (Resolve-Path "android/libs/zxing-core-3.5.3.jar").Path
$env:AGY_KEYSTORE_PASS = "请替换为你的自定义签名密码"
python android/build_apk.py
```

### macOS / Linux (Bash) 构建命令

```bash
# 1. 下载 ZXing 离线扫码库（首次执行即可）
mkdir -p android/libs
curl -L "https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar" \
  -o android/libs/zxing-core-3.5.3.jar

# 2. 安装图标生成依赖
pip install Pillow

# 3. 设置环境变量并执行构建
# macOS 默认 SDK 路径通常为 "$HOME/Library/Android/sdk"，Linux 通常为 "$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
export ZXING_CORE_JAR="$(pwd)/android/libs/zxing-core-3.5.3.jar"
export AGY_KEYSTORE_PASS="请替换为你的自定义签名密码"
python3 android/build_apk.py
```

构建完成后，已签名 APK 将输出至 `dist/Antigravity-Mobile-Universal-v1.6.apk`。

---

## 项目目录速览

```text
.
├── agy_mobile_server.py                 # 伴侣服务端核心（API / WebSocket / 桌面镜像 / 隧道守护）
├── www/                                 # 电脑同步工作台 & 手机端共用前端界面（Material 3）
├── android/                             # Android 原生壳源码与零 Gradle 构建脚本（build_apk.py）
├── dist/Antigravity-Mobile-Universal-v1.6.apk  # 预构建通用签名 Android 安装包
├── assets/antigravity_mobile.ico        # Windows 桌面快捷方式四色 A 图标
├── create_desktop_shortcuts.ps1         # Windows 一键创建「Antigravity 同步工作台」桌面单图标
├── launch_desktop_workbench.bat         # Windows 无窗后台拉起服务并打开宽屏独立应用窗口
├── launch_desktop_pair.bat              # Windows 快捷打开工作台并弹出手机配对弹窗
├── start_link_server.bat                # Windows 前台终端启动脚本（便于查看实时日志）
├── start_link_server.sh                 # macOS / Linux 启动脚本
├── allow_firewall_port.bat              # Windows 专用网络（Private）防火墙端口放行助手
├── requirements.txt                     # Python 依赖清单
└── LICENSE                              # MIT 开源许可证
```

---

## License

[MIT License](LICENSE)
