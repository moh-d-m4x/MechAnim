@echo off
echo Starting MechAnim with Backend Server...
cd /d "%~dp0"

echo.
echo Checking for existing server on port 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    echo Killing existing process %%a
    taskkill /F /PID %%a 2>nul
)

echo.
echo Starting Python Backend Server...
start "MechAnim Backend" cmd /k "cd /d %~dp0backend && C:\Users\hp\miniconda3\python.exe server.py"

echo Waiting for backend to start...
timeout /t 4 /nobreak > nul

echo.
echo Starting Frontend Dev Server...
start http://localhost:3000
call npm run dev
