@echo off
echo Starting MechAnim...
cd /d "%~dp0"
start http://localhost:3000
npm run dev
