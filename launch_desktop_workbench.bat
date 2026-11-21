@echo off
setlocal
set "PROJ_DIR=%~dp0"
set "SERVER_PY=%PROJ_DIR%agy_mobile_server.py"
set "PORT_NUM=18795"
if defined AGY_MOBILE_PORT set "PORT_NUM=%AGY_MOBILE_PORT%"
set "TARGET_URL=http://127.0.0.1:%PORT_NUM%/%~1"
set "HEALTH_URL=http://127.0.0.1:%PORT_NUM%/health"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri $env:HEALTH_URL -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel%==0 goto :open_app

set "PY_EXE="
if defined AGY_MOBILE_PYTHON call :check_py "%AGY_MOBILE_PYTHON%"
if defined PY_EXE goto :start_server

call :check_py "%PROJ_DIR%.venv\Scripts\python.exe"
if defined PY_EXE goto :start_server

call :check_py "%PROJ_DIR%venv\Scripts\python.exe"
if defined PY_EXE goto :start_server

if not defined LOCALAPPDATA goto :try_path_py
if not exist "%LOCALAPPDATA%\hermes\installs" goto :try_path_py
for /d %%D in ("%LOCALAPPDATA%\hermes\installs\*") do call :scan_hermes "%%~D"
if defined PY_EXE goto :start_server

:try_path_py
for /f "delims=" %%P in ('where python 2^>nul') do call :check_py "%%~P"
if defined PY_EXE goto :start_server

py -3 -c "import aiohttp" >nul 2>&1
if not %errorlevel%==0 goto :no_python
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do if not defined PY_EXE set "PY_EXE=%%~P"
if defined PY_EXE goto :start_server

:no_python
powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Python with aiohttp not found. Run: pip install -r requirements.txt', 'Antigravity Workbench', 'OK', 'Error') | Out-Null"
exit /b 1

:start_server
set "AGY_LAUNCH_PY=%PY_EXE%"
set "AGY_LAUNCH_SERVER=%SERVER_PY%"
set "AGY_LAUNCH_CWD=%PROJ_DIR%"
powershell -NoProfile -Command "$q = [char]34; $cmd = $q + $env:AGY_LAUNCH_PY + $q + ' ' + $q + $env:AGY_LAUNCH_SERVER + $q; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $env:AGY_LAUNCH_CWD } | Out-Null"

set /a WAIT_TRY=0
:wait_health
set /a WAIT_TRY+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri $env:HEALTH_URL -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel%==0 goto :open_app
if %WAIT_TRY% GEQ 20 goto :open_app
ping -n 2 127.0.0.1 >nul
goto :wait_health

:open_app
set "BROWSER_EXE="
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if defined BROWSER_EXE (
    start "" "%BROWSER_EXE%" --app="%TARGET_URL%" --window-size=1280,860
) else (
    start "" "%TARGET_URL%"
)
exit /b 0

:scan_hermes
if defined PY_EXE exit /b 0
if not exist "%~1\environments" exit /b 0
for /d %%E in ("%~1\environments\*") do call :check_py "%%~E\venv\Scripts\python.exe"
exit /b 0

:check_py
if defined PY_EXE exit /b 0
set "CAND=%~1"
if "%CAND%"=="" exit /b 0
if not exist "%CAND%" exit /b 0
"%CAND%" -c "import aiohttp" >nul 2>&1
if %errorlevel%==0 set "PY_EXE=%CAND%"
exit /b 0
