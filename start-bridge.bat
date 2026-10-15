@echo off
rem CodexWatch Bridge 启动器(前台窗口,关闭窗口即停止守护)
cd /d "%~dp0bridge"
title CodexWatch Bridge
node index.js --port 3599
pause
