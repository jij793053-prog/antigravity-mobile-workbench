# Install the official Antigravity Side-Pane & Sidebar UI Plugin (antigravity-sync / Mobile Sync)
$ErrorActionPreference = "Stop"

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginSrc = Join-Path $repoDir "plugin"
$manifestPath = Join-Path $pluginSrc "plugin.json"
$serverPy = Join-Path $repoDir "agy_mobile_server.py"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Missing plugin manifest: $manifestPath"
}
if (-not (Test-Path -LiteralPath $serverPy)) {
    throw "Missing Link Server script: $serverPy"
}

# 1. Verify Node.js >= 18
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "Node.js 18+ is required to run the Mobile Sync sidecar plugin, but 'node' was not found in PATH. Install Node.js LTS from https://nodejs.org/ and retry."
}
$nodeVerRaw = (& $nodeCmd.Source -v 2>$null | Out-String).Trim()
if ($nodeVerRaw -notmatch '^v(\d+)\.') {
    throw "Unable to parse Node.js version from '$nodeVerRaw'. Node.js 18+ is required."
}
$nodeMajor = [int]$Matches[1]
if ($nodeMajor -lt 18) {
    throw "Node.js 18+ is required, found $nodeVerRaw. Please upgrade Node.js and retry."
}

# 2. Detect Python environment with aiohttp installed (best-effort)
function Test-PythonAiohttp {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
    if (-not (Test-Path -LiteralPath $Candidate)) { return $false }
    try {
        & $Candidate -c "import aiohttp" *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

$detectedPy = ""
$pyCandidates = New-Object System.Collections.Generic.List[string]
if ($env:AGY_MOBILE_PYTHON) { $pyCandidates.Add($env:AGY_MOBILE_PYTHON) }
$pyCandidates.Add((Join-Path $repoDir ".venv\Scripts\python.exe"))
$pyCandidates.Add((Join-Path $repoDir "venv\Scripts\python.exe"))

if ($env:LOCALAPPDATA) {
    $hermesRoot = Join-Path $env:LOCALAPPDATA "hermes\installs"
    if (Test-Path -LiteralPath $hermesRoot) {
        Get-ChildItem -LiteralPath $hermesRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $envRoot = Join-Path $_.FullName "environments"
            if (Test-Path -LiteralPath $envRoot) {
                Get-ChildItem -LiteralPath $envRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                    $pyCandidates.Add((Join-Path $_.FullName "venv\Scripts\python.exe"))
                }
            }
        }
    }
}

foreach ($cmd in (Get-Command python -All -ErrorAction SilentlyContinue)) {
    if ($cmd.Source) { $pyCandidates.Add($cmd.Source) }
}

foreach ($cand in $pyCandidates) {
    if (Test-PythonAiohttp -Candidate $cand) {
        $detectedPy = $cand
        break
    }
}

if (-not $detectedPy) {
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        try {
            & $pyLauncher.Source -3 -c "import aiohttp" *> $null
            if ($LASTEXITCODE -eq 0) {
                $resolved = (& $pyLauncher.Source -3 -c "import sys; print(sys.executable)" 2>$null | Out-String).Trim()
                if ($resolved -and (Test-Path -LiteralPath $resolved)) {
                    $detectedPy = $resolved
                }
            }
        } catch {}
    }
}

# 3. Validate port (default 18795)
$portNum = 18795
if ($env:AGY_MOBILE_PORT) {
    $parsedPort = 0
    if ([int]::TryParse($env:AGY_MOBILE_PORT.Trim(), [ref]$parsedPort) -and $parsedPort -ge 1 -and $parsedPort -le 65535) {
        $portNum = $parsedPort
    }
}

# 4. Sync plugin/ into ~/.gemini/config/plugins/antigravity-sync/ in-place (NEVER touch config.json)
# In-place sync avoids failing on locked CWD handles when Antigravity's sidecar is already running.
$userHome = [Environment]::GetFolderPath("UserProfile")
if ([string]::IsNullOrWhiteSpace($userHome)) {
    $userHome = $HOME
}
$pluginsRoot = Join-Path $userHome ".gemini\config\plugins"
$destPluginDir = Join-Path $pluginsRoot "antigravity-sync"

New-Item -ItemType Directory -Path $destPluginDir -Force | Out-Null

$srcRootFull = [System.IO.Path]::GetFullPath($pluginSrc).TrimEnd('\', '/')
$expectedRelFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

Get-ChildItem -LiteralPath $srcRootFull -Recurse -Force | ForEach-Object {
    $rel = $_.FullName.Substring($srcRootFull.Length).TrimStart('\', '/')
    $targetPath = Join-Path $destPluginDir $rel
    if ($_.PSIsContainer) {
        if (-not (Test-Path -LiteralPath $targetPath)) {
            New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        }
    } else {
        $parentDir = Split-Path -Parent $targetPath
        if (-not (Test-Path -LiteralPath $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Force
        [void]$expectedRelFiles.Add($rel)
    }
}

$destRootFull = [System.IO.Path]::GetFullPath($destPluginDir).TrimEnd('\', '/')
Get-ChildItem -LiteralPath $destRootFull -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($destRootFull.Length).TrimStart('\', '/')
    if (-not $expectedRelFiles.Contains($rel)) {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
}

# 5. Write ~/.gemini/antigravity-mobile/plugin_host.json (UTF-8 without BOM)
$hostCfgDir = Join-Path $userHome ".gemini\antigravity-mobile"
$hostCfgPath = Join-Path $hostCfgDir "plugin_host.json"
New-Item -ItemType Directory -Path $hostCfgDir -Force | Out-Null

$hostCfg = [ordered]@{
    serverDir = $repoDir
    pythonBin = $detectedPy
    port      = [int]$portNum
}
$jsonContent = ($hostCfg | ConvertTo-Json -Depth 4) + "`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($hostCfgPath, $jsonContent, $utf8NoBom)

Write-Output "============================================================"
Write-Output "  Antigravity Mobile Sync Plugin Installed (v1.7.0)"
Write-Output "============================================================"
Write-Output "  Plugin Dir  : $destPluginDir"
Write-Output "  Host Config : $hostCfgPath"
Write-Output "  Node.js     : $nodeVerRaw (OK)"
if ($detectedPy) {
    Write-Output "  Python Bin  : $detectedPy"
} else {
    Write-Output "  Python Bin  : (not detected with aiohttp yet; run 'pip install -r requirements.txt')"
}
Write-Output "  Target Port : 127.0.0.1:$portNum"
Write-Output "  Note        : ~/.gemini/config/config.json was NOT modified."
Write-Output "------------------------------------------------------------"
Write-Output "  Next Steps / 下一步:"
Write-Output "  1. 打开或重启 Antigravity（支持自动发现 ~/.gemini/config/plugins/antigravity-sync）。"
Write-Output "  2. 在右侧辅助栏点击 '+' 选择 'Mobile Sync'，或从左侧边栏直接打开 'Mobile Sync'。"
Write-Output "  3. 如需启用/停用，可前往 Antigravity 的 Customizations > Installed 管理。"
Write-Output "  4. 若本地 Link Server 未运行，可在面板内一键启动或运行 start_link_server.bat。"
Write-Output "============================================================"
