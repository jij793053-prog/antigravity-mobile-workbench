@echo off
chcp 65001 >nul 2>&1
rem Merged into unified launcher: launches backend + Cloudflare tunnel + opens Desktop Workbench directly on QR Pairing view
call "%~dp0launch_desktop_workbench.bat" "?open=pair"
exit /b %errorlevel%
