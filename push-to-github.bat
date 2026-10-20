@echo off
setlocal enabledelayedexpansion
title QingDui - Push to GitHub
cd /d "%~dp0"

echo.
echo ============================================================
echo   QingDui  -  Push to your GitHub  [PRIVATE repo]
echo ============================================================
echo.

rem ---------- Step 0: check git ----------
where git >nul 2>nul
if errorlevel 1 goto NOGIT
echo   [OK] git found: 
git --version
echo.

rem ---------- Step 1: restore repository ----------
echo   Step 1/4  Preparing repository...
if exist ".git" goto HASGIT

if not exist "qingdui-repo.bundle" goto NOBUNDLE

echo             Restoring from qingdui-repo.bundle ...
git clone qingdui-repo.bundle qingdui_repo
if errorlevel 1 goto CLONEFAIL
cd qingdui_repo
goto REPOOK

:HASGIT
echo             Using existing .git in this folder.

:REPOOK
echo.
echo             Repository ready. Branch and commits:
git log --oneline -3
echo.

rem ---------- Step 2: username ----------
echo   Step 2/4  GitHub username
echo             Your account: ljh-ningxia
set "OWNER=ljh-ningxia"
set /p "OWNER_IN=            Press Enter to use [ljh-ningxia], or type another name: "
if not "!OWNER_IN!"=="" set "OWNER=!OWNER_IN!"

set "REPO=qingdui"
set /p "REPO_IN=            Repo name [qingdui]: "
if not "!REPO_IN!"=="" set "REPO=!REPO_IN!"

echo.
echo             Target: https://github.com/!OWNER!/!REPO!
echo.

rem ---------- Step 3: create repo ----------
echo   Step 3/4  Create the repository on GitHub
echo.
echo             A browser page will open. Do this:
echo               1. Repository name : !REPO!
echo               2. Visibility      : Private
echo               3. Add a README    : DO NOT CHECK IT
echo               4. Click "Create repository"
echo.
echo             Then come back here and press any key.
echo.
start "" "https://github.com/new"
pause

rem ---------- Step 4: push ----------
echo.
echo   Step 4/4  Pushing...
git remote remove origin >nul 2>nul
git remote add origin https://github.com/!OWNER!/!REPO!.git
git branch -M main

echo.
echo             You may be asked to sign in to GitHub.
echo             Choose "Sign in with your browser" if prompted.
echo.
git push -u origin main
if errorlevel 1 goto PUSHFAIL

echo.
echo ============================================================
echo   SUCCESS
echo   https://github.com/!OWNER!/!REPO!
echo ============================================================
echo.
start "" "https://github.com/!OWNER!/!REPO!"
pause
exit /b 0

:NOGIT
echo   [X] git is not installed.
echo.
echo       Please install Git for Windows first:
echo       https://git-scm.com/download/win
echo.
pause
exit /b 1

:NOBUNDLE
echo   [X] qingdui-repo.bundle not found in this folder.
echo.
echo       Make sure you extracted the whole zip,
echo       and that the .bat and the .bundle are in the SAME folder.
echo.
dir /b
echo.
pause
exit /b 1

:CLONEFAIL
echo   [X] Failed to restore the repository from the bundle.
echo       (see the git error above)
echo.
pause
exit /b 1

:PUSHFAIL
echo.
echo ============================================================
echo   [X] PUSH FAILED
echo.
echo   Check these, in order:
echo.
echo   1. Did you actually click "Create repository" in the browser?
echo      If the page is still open, go create it, then run this
echo      script again.
echo.
echo   2. Is the repo name spelled the same as what you typed here?
echo.
echo   3. If you were asked to sign in but cancelled it, run:
echo         git config --global credential.helper manager
echo      then run this script again.
echo.
echo   4. If the repo already exists and has commits, run:
echo         git push -u origin main --force
echo      WARNING: --force overwrites remote history.
echo ============================================================
echo.
pause
exit /b 1
