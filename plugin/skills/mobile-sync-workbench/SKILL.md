---
name: mobile-sync-workbench
description: Open and troubleshoot the Mobile Sync side-pane workbench inside Antigravity, check local Link Server health on 127.0.0.1:18795, and guide Android phone QR or 6-digit PIN pairing.
---

# Mobile Sync Workbench

Use this skill when the user wants to open the **Mobile Sync** panel inside Antigravity, inspect whether the local **Antigravity Link Server** (`127.0.0.1:18795`) is healthy, or pair an Android phone with the workbench.

## 1. Open the Side-Pane Workbench

When the `antigravity-sync` plugin is enabled and running, offer a single clickable pill to toggle the right auxiliary side pane:

[Mobile Sync](sidecar://antigravity-sync/workbench/)

- **Right Auxiliary Pane (`/`)**: Compact view with a collapsible conversation drawer that automatically follows the active Antigravity conversation.
- **Left Sidebar (`/?view=sidebar`)**: Wide two-column workbench accessible directly from Antigravity's left sidebar.
- Only emit the `sidecar://` pill once per reply and only when the plugin is enabled/running.

## 2. Check Local Link Server Health

Verify that the local Link Server is reachable on loopback:

```bash
curl -sS http://127.0.0.1:18795/health
```

Expected response when online: JSON containing `"ok": true` and the active `"port"` (default `18795`, or `$AGY_MOBILE_PORT` if customized).

If `127.0.0.1:18795` is unreachable:

1. Open [Mobile Sync](sidecar://antigravity-sync/workbench/) — the panel automatically displays its offline screen with a one-click **Start Local Link Server** button (when installed via the repository installer) and auto-reconnects every 3 seconds.
2. Or start the Link Server manually from the repository root:
   - **Windows**: `start_link_server.bat`
   - **macOS / Linux**: `./start_link_server.sh`
   - **Direct Python**: `python agy_mobile_server.py`

## 3. Guide Android Phone Pairing

Once the Link Server is online:

1. Inside the **Mobile Sync** panel, click **供手机扫码** in the top bar (or open `http://127.0.0.1:18795/pair` in a local browser on the host machine).
2. Choose either pairing method in the Android app:
   - **QR Code (Recommended)**: Scan the displayed QR code to import the server URL (LAN, Tailscale, or Cloudflare Tunnel) and access token automatically.
   - **6-Digit PIN**: Enter the host address (`IP:18795`) and the 6-digit pairing PIN shown on `/pair`.
3. Never share `/pair` or the access token over untrusted channels; `/pair` and `/api/local-auth` are strictly restricted to loopback on the host machine.
