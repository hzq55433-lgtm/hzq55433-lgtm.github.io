@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "SITE_NODE_EXE="
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "SITE_NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined SITE_NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "SITE_NODE_EXE=node"
)
if not defined SITE_NODE_EXE (
  echo 请先安装 Node.js 24 或更高版本，再重新打开这个文件。
  pause
  exit /b 1
)
echo 启动后，在浏览器打开 http://127.0.0.1:4317
set "SITE_MODE=local"
set "NODE_ENV=development"
set "HOST=127.0.0.1"
set "PORT=4317"
set "PUBLIC_ORIGIN="
set "DATA_FILE=%~dp0data\site.sqlite"
"%SITE_NODE_EXE%" "%~dp0server.mjs"
pause
