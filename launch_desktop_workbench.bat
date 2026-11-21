@echo off
chcp 65001 >nul
setlocal
set "PROJ_DIR=%~dp0"
set "SERVER_PY=%PROJ_DIR%agy_mobile_server.py"
set "PORT_NUM=18795"
if defined AGY_MOBILE_PORT set "PORT_NUM=%AGY_MOBILE_PORT%"
set "TARGET_URL=http://127.0.0.1:%PORT_NUM%/"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT_NUM%/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 (
    set "PY_EXE="
    if defined AGY_MOBILE_PYTHON if exist "%AGY_MOBILE_PYTHON%" set "PY_EXE=%AGY_MOBILE_PYTHON%"
    if not defined PY_EXE if exist "%PROJ_DIR%.venv\Scripts\python.exe" set "PY_EXE=%PROJ_DIR%.venv\Scripts\python.exe"
    if not defined PY_EXE if exist "%PROJ_DIR%venv\Scripts\python.exe" set "PY_EXE=%PROJ_DIR%venv\Scripts\python.exe"
    if not defined PY_EXE if defined LOCALAPPDATA (
        for /d %%D in ("%LOCALAPPDATA%\hermes\installs\*") do (
            for /d %%E in ("%%D\environments\*") do (
                if not defined PY_EXE if exist "%%E\venv\Scripts\python.exe" set "PY_EXE=%%E\venv\Scripts\python.exe"
            )
        )
    )
    if not defined PY_EXE set "PY_EXE=python"
    powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '\"%PY_EXE%\" \"%SERVER_PY%\"'; CurrentDirectory = '%PROJ_DIR%' } | Out-Null"
    for /L %%i in (1,1,20) do (
        powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT_NUM%/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" && goto :open_app
        ping -n 2 127.0.0.1 >nul
    )
)

:open_app
set "BROWSER_EXE="
for %%B in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do (
    if not defined BROWSER_EXE if exist %%B set "BROWSER_EXE=%%~B"
)

if defined BROWSER_EXE (
    start "" "%BROWSER_EXE%" --app="%TARGET_URL%" --window-size=1280,860
) else (
    start "" "%TARGET_URL%"
)
exit /b 0
