@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Antigravity Link Server

set "SCRIPT_DIR=%~dp0"
set "SERVER_PY=%SCRIPT_DIR%agy_mobile_server.py"
set "PY_EXE="

if not exist "%SERVER_PY%" (
    echo [ERROR] Cannot find agy_mobile_server.py in "%SCRIPT_DIR%".
    pause
    exit /b 1
)

rem 1. Explicit override via AGY_MOBILE_PYTHON
if defined AGY_MOBILE_PYTHON (
    call :check_py "%AGY_MOBILE_PYTHON%"
    if defined PY_EXE goto :found_py
)

rem 2. Local virtual environment inside project folder
for %%V in ("%SCRIPT_DIR%.venv\Scripts\python.exe" "%SCRIPT_DIR%venv\Scripts\python.exe") do (
    if not defined PY_EXE (
        call :check_py "%%~V"
    )
)
if defined PY_EXE goto :found_py

rem 3. Auto-discover Hermes venv under %LOCALAPPDATA%\hermes\installs\*\environments\*\venv
if defined LOCALAPPDATA (
    if exist "%LOCALAPPDATA%\hermes\installs" (
        for /d %%I in ("%LOCALAPPDATA%\hermes\installs\*") do (
            if not defined PY_EXE if exist "%%~I\environments" (
                for /d %%E in ("%%~I\environments\*") do (
                    if not defined PY_EXE (
                        call :check_py "%%~E\venv\Scripts\python.exe"
                    )
                )
            )
        )
    )
)
if defined PY_EXE goto :found_py

rem 4. System python executables in PATH
for /f "delims=" %%P in ('where python 2^>nul') do (
    if not defined PY_EXE (
        call :check_py "%%~P"
    )
)
if defined PY_EXE goto :found_py

rem 5. Python Launcher (py -3)
py -3 -c "import aiohttp" >nul 2>&1
if %errorlevel%==0 (
    for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do (
        if not defined PY_EXE set "PY_EXE=%%~P"
    )
)
if defined PY_EXE goto :found_py

echo.
echo [ERROR] 未找到已安装 aiohttp 的 Python 环境。
echo 请任选一种方式安装依赖后重新双击运行：
echo   pip install aiohttp
echo 或手动设置环境变量 AGY_MOBILE_PYTHON 指向包含 aiohttp 的 python.exe。
echo.
pause
exit /b 1

:found_py
set "PORT_NUM=18795"
if defined AGY_MOBILE_PORT set "PORT_NUM=%AGY_MOBILE_PORT%"

echo ============================================================
echo   Antigravity Link Server (Universal Companion)
echo ============================================================
echo   Python     : %PY_EXE%
echo   Local Pair : http://127.0.0.1:%PORT_NUM%/pair
echo   Tip        : 电脑浏览器打开上方配对页，扫码或输入 6 位配对码即可连接
echo ============================================================
echo.

"%PY_EXE%" "%SERVER_PY%"
set "RC=%errorlevel%"
if not "%RC%"=="0" (
    echo.
    echo [Antigravity Link Server] Exited with code %RC%.
    pause
)
exit /b %RC%

:check_py
set "CAND=%~1"
if "%CAND%"=="" exit /b 0
if not exist "%CAND%" exit /b 0
"%CAND%" -c "import aiohttp" >nul 2>&1
if %errorlevel%==0 (
    set "PY_EXE=%CAND%"
)
exit /b 0
