# Create Desktop shortcuts for Antigravity Desktop Workbench & Mobile Pairing
$ErrorActionPreference = "Stop"

$projDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath("Desktop")
$icoPath = Join-Path $projDir "assets\antigravity_mobile.ico"

$wsh = New-Object -ComObject WScript.Shell

$shortcuts = @(
    @{
        Name = "Antigravity 同步工作台.lnk"
        Target = Join-Path $projDir "launch_desktop_workbench.bat"
        Desc = "双击秒开 Antigravity 电脑宽屏同步工作台（免配对、与手机实时双向同步）"
    },
    @{
        Name = "Antigravity 手机配对.lnk"
        Target = Join-Path $projDir "launch_desktop_pair.bat"
        Desc = "打开 Antigravity 手机扫码配对与公网免VPN隧道页面"
    }
)

foreach ($sc in $shortcuts) {
    if (-not (Test-Path $sc.Target)) { continue }
    $lnkPath = Join-Path $desktop $sc.Name
    $shortcut = $wsh.CreateShortcut($lnkPath)
    $shortcut.TargetPath = $sc.Target
    $shortcut.WorkingDirectory = $projDir
    $shortcut.WindowStyle = 7
    $shortcut.Description = $sc.Desc
    if (Test-Path $icoPath) {
        $shortcut.IconLocation = "$icoPath,0"
    }
    $shortcut.Save()
    Write-Output "Created: $lnkPath"
}
