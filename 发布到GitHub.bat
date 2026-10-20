@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================
echo   QingDui - Publish to GitHub [PRIVATE]
echo ============================================
echo.

set "REPO=qingdui"
set /p "INPUT=Repo name (Enter = default qingdui): "
if not "!INPUT!"=="" set "REPO=!INPUT!"

set "OWNER="
for /f "delims=" %%i in ('git config user.name') do set "OWNER=%%i"
if "!OWNER!"=="" set "OWNER=your-github-username"

set "FULLNAME=!OWNER!/!REPO!"

echo.
echo   Will create: !FULLNAME!   [PRIVATE]
echo.
echo   A login window will open. Choose:
echo     GitHub.com  -^>  HTTPS  -^>  Login with a web browser
echo   Then type the one-time code shown, and click Authorize.
echo.
pause

where gh >nul 2>nul
if errorlevel 1 goto NOGH

gh auth status >nul 2>nul
if errorlevel 1 (
  echo.
  echo Starting GitHub login...
  call gh auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 goto LOGINFAIL
)

echo.
echo Creating PRIVATE repo and pushing...
call gh repo create "!FULLNAME!" --private --source=. --remote=origin --push
if errorlevel 1 goto CREATEFAIL

echo.
echo Verifying visibility...
set "VIS="
for /f "delims=" %%v in ('gh repo view "!FULLNAME!" --json visibility --jq .visibility') do set "VIS=%%v"
if /i "!VIS!"=="PRIVATE" (
  echo   [OK] Confirmed PRIVATE
) else (
  echo   [!!] Visibility is !VIS! - forcing private...
  call gh repo edit "!FULLNAME!" --visibility private --accept-visibility-change-consequences
)

echo.
echo ============================================
echo   Done: https://github.com/!FULLNAME!
echo ============================================
echo.
start "" "https://github.com/!FULLNAME!"
pause
exit /b 0

:NOGH
echo.
echo [!] gh CLI not found.
echo     Plan B - create the repo by hand:
echo       1. Open https://github.com/new
echo       2. Repository name: !REPO!
echo       3. Select PRIVATE
echo       4. Do NOT tick "Add a README"
echo       5. Create, then run:
echo          git remote add origin https://github.com/!FULLNAME!.git
echo          git push -u origin main
echo.
pause
exit /b 1

:LOGINFAIL
echo.
echo [x] Login was not completed. Aborted.
pause
exit /b 1

:CREATEFAIL
echo.
echo [!] Repo creation failed - the name may already be taken.
echo     Pick another name, or create an empty repo manually then run:
echo       git remote add origin https://github.com/!FULLNAME!.git
echo       git push -u origin main
pause
exit /b 1
