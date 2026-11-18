@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo ==============================================
echo   OCS DeepSeek Tiku - restart
echo ==============================================
echo.

echo [1/3] Stopping the old service on port 8787 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/3] Looking for Node.js ...
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "D:\New Folder\node.exe" set "NODE_EXE=D:\New Folder\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

if not defined NODE_EXE (
    echo.
    echo [ERROR] Node.js was not found.
    echo Please install Node.js 18 or newer from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
echo       Node: %NODE_EXE%

echo [3/3] Starting the service (keep this window open) ...
echo.
start "" "http://127.0.0.1:8787/"
"%NODE_EXE%" server.mjs %*

echo.
echo Service exited. If there is an error above, take a screenshot and send it back.
pause
