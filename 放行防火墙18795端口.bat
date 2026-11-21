@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 正在请求管理员权限以放行 18795 端口...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
echo 正在添加 Windows 防火墙入站放行规则（TCP 18795，全部网络）...
powershell -NoProfile -Command "if (Get-NetFirewallRule -DisplayName 'Antigravity Link Server 18795' -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName 'Antigravity Link Server 18795' }; New-NetFirewallRule -DisplayName 'Antigravity Link Server 18795' -Direction Inbound -Protocol TCP -LocalPort 18795 -Profile Any -Action Allow | Select-Object DisplayName, Enabled, Action, Profile | Format-Table -AutoSize"
echo.
echo 完成！现在回到手机 Antigravity App，几秒内就会自动变绿灯连上。
pause
