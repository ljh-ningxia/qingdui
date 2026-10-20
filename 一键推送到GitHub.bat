@echo off
setlocal enabledelayedexpansion
title QingDui - Push to GitHub
cd /d "%~dp0"

echo.
echo ============================================================
echo   QingDui  -  Push to your GitHub  [PRIVATE repo]
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo   [!] git not found. Install Git for Windows first:
  echo       https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo   Step 1/4  Checking the bundled repository...
if exist ".git" (
  echo             .git folder found, using it directly.
) else (
  echo             Restoring git history from the bundle...
  git clone qingdui-完整仓库.bundle qingdui_repo
  if errorlevel 1 (
    echo   [x] Failed to restore. Make sure qingdui-完整仓库.bundle is in this folder.
    pause
    exit /b 1
  )
  cd qingdui_repo
)
echo.

echo   Step 2/4  GitHub account name
echo             (find it at https://github.com - top right avatar)
set "OWNER="
set /p "OWNER=            Your GitHub username: "
if "!OWNER!"=="" (
  echo   [x] Username is required.
  pause
  exit /b 1
)

set "REPO=qingdui"
set /p "INPUT=            Repo name (Enter = qingdui): "
if not "!INPUT!"=="" set "REPO=!INPUT!"

echo.
echo   Step 3/4  Create the PRIVATE repository on GitHub
echo.
echo             Opening https://github.com/new ...
echo             Fill in:
echo               Repository name : !REPO!
echo               Visibility      : Private        ^<-- important
echo               Add a README    : leave UNCHECKED
echo             Then click "Create repository".
echo.
start "" "https://github.com/new"
pause

echo.
echo   Step 4/4  Pushing...
git remote remove origin >nul 2>nul
git remote add origin https://github.com/!OWNER!/!REPO!.git
git branch -M main
git push -u origin main

if errorlevel 1 (
  echo.
  echo ============================================================
  echo   [x] Push failed.
  echo.
  echo   Most likely causes:
  echo     - The repo was not created on GitHub yet
  echo     - Username or repo name is wrong
  echo     - You cancelled the login window that just popped up
  echo.
  echo   A browser window should have appeared asking you to sign in.
  echo   If it did not, the usual fix is to run this once:
  echo       git config --global credential.helper manager
  echo   then run this script again.
  echo ============================================================
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Done.
echo   https://github.com/!OWNER!/!REPO!
echo ============================================================
echo.
start "" "https://github.com/!OWNER!/!REPO!"
pause
