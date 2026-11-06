@echo off
cd /d "%~dp0"
title CodexWatch Bridge - debug
node index.js --port 3599
pause
