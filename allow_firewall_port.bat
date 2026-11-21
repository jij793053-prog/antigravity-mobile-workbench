@echo off
setlocal
chcp 65001 >nul 2>&1
set "PORT_NUM=18795"
if defined AGY_MOBILE_PORT set "PORT_NUM=%AGY_MOBILE_PORT%"
if not "%~1"=="" set "PORT_NUM=%~1"

powershell -NoProfile -Command "$p = 0; if (-not [int]::TryParse($env:PORT_NUM, [ref]$p) -or $p -lt 1 -or $p -gt 65535) { exit 1 }"
if not %errorlevel%==0 (
    echo [ERROR] 无效端口号: %PORT_NUM%
    pause
    exit /b 1
)

net session >nul 2>&1
if not %errorlevel%==0 (
    echo 正在请求管理员权限以放行专用网络 TCP %PORT_NUM% 端口...
    set "AGY_FW_SCRIPT=%~f0"
    powershell -NoProfile -Command "Start-Process -FilePath $env:AGY_FW_SCRIPT -ArgumentList @($env:PORT_NUM) -Verb RunAs"
    exit /b %errorlevel%
)

echo 正在添加 Windows 防火墙入站放行规则（TCP %PORT_NUM%，仅限专用网络 Private）...
powershell -NoProfile -Command "$port = [int]$env:PORT_NUM; $name = 'Antigravity Link Server ' + $port; if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName $name }; New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port -Profile Private -Action Allow | Select-Object DisplayName, Enabled, Action, Profile | Format-Table -AutoSize"
echo.
echo 完成！已仅对专用网络（家庭/办公局域网）放行 TCP %PORT_NUM%，公共 Wi-Fi 保持拦截。
pause
exit /b 0
