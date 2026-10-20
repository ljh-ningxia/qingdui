@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---- inject tool paths (git is bundled, gh installed to user dir) ----
set "PATH=%PATH%;C:\Users\Administrator\.local\bin"
set "PATH=%PATH%;D:\jiqishijue\WorkBuddy\resources\vendor\PortableGit\mingw64\bin"
set "PATH=%PATH%;D:\jiqishijue\WorkBuddy\resources\vendor\PortableGit\cmd"

echo.
echo ============================================
echo   QingDui - Publish to GitHub [PRIVATE]
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [!] git not found even after path injection. Contact assistant.
  pause
  exit /b 1
)
where gh >nul 2>nul
if errorlevel 1 (
  echo [!] gh not found at C:\Users\Administrator\.local\bin\gh.exe
  pause
  exit /b 1
)
echo   [OK] git and gh found
echo.

set "REPO=qingdui"
set /p "INPUT=Repo name (Enter = default qingdui): "
if not "!INPUT!"=="" set "REPO=!INPUT!"

set "OWNER="
for /f "delims=" %%i in ('git config user.name') do set "OWNER=%%i"
if "!OWNER!"=="" set "OWNER=xingxingdemi"

set "FULLNAME=!OWNER!/!REPO!"

echo.
echo   Will create: !FULLNAME!   [PRIVATE]
echo.
echo   A login window will open. Choose:
echo     GitHub.com  -^>  HTTPS  -^>  Login with a web browser
echo   Then type the one-time code shown, and click Authorize.
echo.
pause

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

:LOGINFAIL
echo.
echo [x] Login was not completed. Aborted.
pause
exit /b 1

:CREATEFAIL
echo.
echo [!] Repo creation failed - the name may already be taken,
echo     or the network blocked github.com.
echo     Retry, or pick another name.
pause
exit /b 1
