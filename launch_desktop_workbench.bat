@echo off
chcp 65001 >nul 2>&1
setlocal
set "PROJ_DIR=%~dp0"
set "SERVER_PY=%PROJ_DIR%agy_mobile_server.py"
set "PORT_NUM=18795"
if defined AGY_MOBILE_PORT set "PORT_NUM=%AGY_MOBILE_PORT%"
set "TARGET_URL=http://127.0.0.1:%PORT_NUM%/%~1"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT_NUM%/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 (
    set "PY_EXE="
    if defined AGY_MOBILE_PYTHON call :check_py "%AGY_MOBILE_PYTHON%"
    if not defined PY_EXE call :check_py "%PROJ_DIR%.venv\Scripts\python.exe"
    if not defined PY_EXE call :check_py "%PROJ_DIR%venv\Scripts\python.exe"
    if not defined PY_EXE if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\hermes\installs" (
        for /d %%D in ("%LOCALAPPDATA%\hermes\installs\*") do (
            if not defined PY_EXE if exist "%%~D\environments" (
                for /d %%E in ("%%~D\environments\*") do (
                    if not defined PY_EXE call :check_py "%%~E\venv\Scripts\python.exe"
                )
            )
        )
    )
    if not defined PY_EXE (
        for /f "delims=" %%P in ('where python 2^>nul') do (
            if not defined PY_EXE call :check_py "%%~P"
        )
    )
    if not defined PY_EXE (
        py -3 -c "import aiohttp" >nul 2>&1
        if %errorlevel%==0 (
            for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do (
                if not defined PY_EXE set "PY_EXE=%%~P"
            )
        )
    )
    if not defined PY_EXE (
        powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('未找到已安装 aiohttp 的 Python 环境。请在项目目录执行：pip install -r requirements.txt 后重试。', 'Antigravity 同步工作台', 'OK', 'Error') | Out-Null"
        exit /b 1
    )

    set "AGY_LAUNCH_PY=%PY_EXE%"
    set "AGY_LAUNCH_SERVER=%SERVER_PY%"
    set "AGY_LAUNCH_CWD=%PROJ_DIR%"
    powershell -NoProfile -Command "$q = [char]34; $cmd = $q + $env:AGY_LAUNCH_PY + $q + ' ' + $q + $env:AGY_LAUNCH_SERVER + $q; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $env:AGY_LAUNCH_CWD } | Out-Null"
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

:check_py
set "CAND=%~1"
if "%CAND%"=="" exit /b 0
if not exist "%CAND%" exit /b 0
"%CAND%" -c "import aiohttp" >nul 2>&1
if %errorlevel%==0 set "PY_EXE=%CAND%"
exit /b 0
