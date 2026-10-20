@echo off
cd /d "%~dp0"
title 轻队 QingDui

set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" set "NODE=node"

echo.
echo   ==================================================
echo        轻队 QingDui  ·  小组任务管理
echo   ==================================================
echo.

rem ---------- 1. 检查 Node ----------
"%NODE%" -v >nul 2>&1
if errorlevel 1 (
  echo   [错误] 找不到 Node.js
  echo.
  echo   请确认这个路径存在：
  echo   %NODE%
  echo.
  pause
  exit /b 1
)

rem ---------- 2. 已经在跑就直接开浏览器 ----------
netstat -ano | findstr /C:"127.0.0.1:3001" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   服务已经在运行，正在打开浏览器...
  start "" http://127.0.0.1:3001
  timeout /t 2 >nul
  exit /b 0
)

rem ---------- 3. 启动 ----------
echo   正在启动，3 秒后自动打开浏览器
echo.
echo   --------------------------------------------------
echo    ^! 这个窗口不要关，关掉服务就停了
echo   ^! 用完直接关这个窗口即可
echo   --------------------------------------------------
echo.

start "" /b cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:3001"

"%NODE%" src\server\index.js 3001

echo.
echo   服务已停止。如果上面有红色报错，把内容截图给我。
pause
