@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Push ocs-tiku to GitHub

echo =============================================================
echo   Push this project to your GitHub repository
echo =============================================================
echo.
start "" "https://github.com/new"
echo   Step 1. A browser page for creating a repo should have opened.
echo           Create an EMPTY repo named ocs-deepseek-tiku (public or private).
echo           (repository name example: ocs-deepseek-tiku)
echo           Do NOT tick "Add a README file", .gitignore or license.
echo   Step 2. Copy the repo URL:
echo           https://github.com/YOUR_NAME/ocs-deepseek-tiku.git
echo   Step 3. Paste it below, press Enter, then sign in to GitHub
echo           in the window that pops up (only once).
echo.
if "%~1"=="" (
  set /p "REPO=Repo URL: "
) else (
  set "REPO=%~1"
)

if "%REPO%"=="" (
  echo [ERROR] No URL given.
  pause
  exit /b 1
)

git remote remove origin >nul 2>nul
git remote add origin "%REPO%"
echo.
echo [INFO] remote origin = %REPO%
echo [INFO] pushing branch main ...
git push -u origin main
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (
  echo [ERROR] push failed, exit code %CODE%.
  echo   - 404: repo does not exist yet, or the URL is wrong.
  echo   - 403: signed in but no write permission on that repo.
  echo   - auth window closed: just run this file again.
) else (
  echo [OK] Done. Open your repo page and refresh:
  echo      %REPO%
)
echo.
pause
