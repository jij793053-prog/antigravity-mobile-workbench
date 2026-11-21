# Create a single unified Desktop shortcut for Antigravity Workbench (built-in Phone QR Pairing + auto-starts backend & tunnel)
$ErrorActionPreference = "Stop"

$projDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath("Desktop")
$icoPath = Join-Path $projDir "assets\antigravity_mobile.ico"

# Remove legacy duplicate pairing shortcut if present (now integrated directly inside the Workbench)
$legacyPairLnk = Join-Path $desktop "Antigravity 手机配对.lnk"
if (Test-Path $legacyPairLnk) {
    Remove-Item -Force $legacyPairLnk
    Write-Output "Removed redundant shortcut: $legacyPairLnk"
}

$wsh = New-Object -ComObject WScript.Shell
$target = Join-Path $projDir "launch_desktop_workbench.bat"
if (-not (Test-Path $target)) {
    throw "Missing launcher: $target"
}

$lnkPath = Join-Path $desktop "Antigravity 同步工作台.lnk"
$shortcut = $wsh.CreateShortcut($lnkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $projDir
$shortcut.WindowStyle = 7
$shortcut.Description = "一键启动后台服务与公网隧道，打开电脑宽屏同步工作台（内置手机扫码配对）"
if (Test-Path $icoPath) {
    $shortcut.IconLocation = "$icoPath,0"
}
$shortcut.Save()
Write-Output "Created unified shortcut: $lnkPath"
