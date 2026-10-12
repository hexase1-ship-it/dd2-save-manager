@echo off
rem Runs the server in a visible console (shows its log). The exe is the normal way to start.
chcp 65001 >nul
title DD2 Save Manager
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node src\server.js
if errorlevel 1 pause
