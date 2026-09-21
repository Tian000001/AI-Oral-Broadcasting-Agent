@echo off
setlocal
REM =========================================================
REM  TTQ-Video - one-click launcher (backend + static UI)
REM  Double-click: frees port 8080 (kills any process holding it),
REM  starts the FastAPI backend with LIVE output in a new window,
REM  waits until the UI is reachable (HTTP 200), then opens the browser.
REM  Close the "MPT-Backend" window to stop the server.
REM  If startup fails, the error is shown live in that window.
REM =========================================================

cd /d "%~dp0"

REM add node to PATH
REM render-node.mjs offline _resolve_node node
REM  node
for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "PATH=%%d;%PATH%"

set "PY=python\python.exe"
if not exist "%PY%" (
  echo [ERROR] Cannot find %PY%. Make sure you run this from the project root folder.
  pause
  exit /b 1
)

REM Free port 8080 if another process is holding it (avoids leftover /
REM 10048 bind error / duplicate windows). This also kills any previous
REM MPT-Backend you forgot to close.
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8080 " ^| findstr "LISTENING"') do (
  echo [INFO] Port 8080 held by PID %%a - freeing it.
  taskkill /F /PID %%a >nul 2>nul
)
ping -n 2 127.0.0.1 >nul

REM Start backend with LIVE output in a new window. On crash the window
REM stays open (cmd /k) showing the traceback, so you can read the error.
start "MPT-Backend" cmd /k "%PY% main.py"

REM Wait until the port is listening (up to 40s).
"%PY%" app\wait_port.py 8080 40
if errorlevel 1 (
  echo [WARN] Backend did not become ready on port 8080 within 40 seconds.
  echo [WARN] Look at the "MPT-Backend" window for the error (red text / traceback).
  echo Press any key to open the browser anyway, or close this window (Ctrl+C) to abort.
  pause
)

REM Self-check: can a local client actually fetch the UI? (diagnostic)
"%PY%" -c "import urllib.request as u,sys; r=u.urlopen('http://127.0.0.1:8080/',timeout=5); sys.exit(0 if r.status==200 else 1)" 2>nul
if not errorlevel 1 (
  echo [OK] Server verified reachable from localhost (HTTP 200).
) else (
  echo [WARN] Server is listening but a local HTTP request failed.
  echo [WARN] If your browser also fails, a proxy/firewall is likely
  echo [WARN] intercepting localhost. Try http://localhost:8080/ instead.
)

echo [OK] Opening UI in your browser.
echo       If the browser cannot display it, try:
echo         1^) open  http://localhost:8080/  (instead of 127.0.0.1)
echo         2^) turn off any proxy for localhost, or try another browser
start "" "http://127.0.0.1:8080/"

exit /b
