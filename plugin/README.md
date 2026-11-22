# Mobile Sync (`antigravity-sync`)

Official Antigravity Side-Pane & Sidebar UI plugin for **Antigravity Mobile Workbench**.

Bring your live two-way **Mobile ↔ Desktop Sync Workbench** directly inside Antigravity's right auxiliary pane and left sidebar — without modifying Antigravity binaries or ASAR archives, and resilient across Antigravity updates.

## Features

- **Dual Native Views**:
  - **Right Side Pane (`AUX_PANE`)**: Compact single-column layout with collapsible conversation drawer that automatically follows your active Antigravity conversation.
  - **Left Sidebar (`SIDEBAR`)**: Spacious full-page two-column workbench layout.
- **Unified Timeline & Real-Time Streaming**: Read and continue Mobile + Desktop merged conversations with live WebSocket token streaming, model & `/swarm` toggles, and workspace file previews.
- **Built-In Phone QR Pairing & Usage Dashboard**: Show the local pairing QR code / 6-digit PIN right inside the panel and inspect 5h / daily / 7d token usage.
- **Native Light & Dark Theme Sync**: Automatically inherits Antigravity host theme tokens (`--background`, `--foreground`, `--primary`, `--border`).
- **One-Click Local Server Launch**: If the local Link Server (`127.0.0.1:18795`) is offline, the panel displays an offline screen with one-click startup and automatic 3-second reconnection.

## Requirements

- **Node.js 18+** (for the zero-dependency sidecar bridge)
- **Antigravity Link Server** running locally on `127.0.0.1:18795` (Python 3.10+ with `requirements.txt` installed)

## Installation

From the repository root:

- **Windows**: Double-click `install_antigravity_plugin.bat` (or run `powershell -ExecutionPolicy Bypass -File .\install_antigravity_plugin.ps1`)
- **macOS / Linux**: Run `./install_antigravity_plugin.sh`
- **Manual**: Copy the `plugin/` directory to `~/.gemini/config/plugins/antigravity-sync/`

## Opening in Antigravity

1. Open the **`+`** menu in Antigravity's right auxiliary pane and choose **Mobile Sync**, or
2. Open **Mobile Sync** from the left sidebar, or
3. Manage the plugin under **Customizations > Installed**.

## Security Model

The sidecar server (`sidecars/workbench/server.mjs`) is pure Node.js with zero third-party dependencies:

- Binds strictly to `127.0.0.1` and proxies exclusively to `127.0.0.1:<AGY_MOBILE_PORT>`.
- Emits zero `Access-Control-Allow-Origin` headers and rejects `OPTIONS`, cross-site requests, and non-loopback `Origin` headers.
- Enforces constant-time `X-Sidecar-Token` authentication (`crypto.timingSafeEqual`) on sensitive HTTP routes and WebSocket upgrades.
