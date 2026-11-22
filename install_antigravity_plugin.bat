@echo off
setlocal
chcp 65001 >nul 2>&1
title Install Antigravity Mobile Sync Plugin

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%install_antigravity_plugin.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] Cannot find install_antigravity_plugin.ps1 in "%SCRIPT_DIR%".
    if not defined AGY_NO_PAUSE pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set "RC=%errorlevel%"

if not defined AGY_NO_PAUSE (
    echo.
    pause
)
exit /b %RC%
