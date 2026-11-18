@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title OCS DeepSeek Tiku Service

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "D:\New Folder\node.exe" set "NODE_EXE=D:\New Folder\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo [ERROR] Node.js not found.
  echo Please install Node.js 18+ from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" server.mjs %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" echo [INFO] Service exited, code %CODE%.
echo [INFO] Service stopped. This window can be closed.
pause
