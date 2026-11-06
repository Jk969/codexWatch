@echo off
rem 后台启动；如需前台排查，请运行 bridge\start-debug.bat
start "" wscript.exe "%~dp0codexwatch-bridge.vbs"
