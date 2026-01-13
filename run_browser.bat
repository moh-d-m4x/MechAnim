@echo off
echo ============================================
echo   MechAnim - Character Motion Designer
echo   with BootsTAPIR Point Tracking
echo ============================================
echo.
cd /d "%~dp0"

echo [1/5] Checking for model directory...
if not exist "backend\models" (
    echo Creating models directory...
    mkdir "backend\models"
)

echo [2/5] Checking for TAPIR model checkpoint...
if not exist "backend\models\bootstapir_checkpoint_v2.pt" (
    echo.
    echo ================================================
    echo   TAPIR model not found!
    echo   The model will be downloaded when you first
    echo   use Auto tracking mode in the app.
    echo   Or download manually from:
    echo   https://storage.googleapis.com/dm-tapnet/bootstap/bootstapir_checkpoint_v2.pt
    echo ================================================
    echo.
)

echo [3/5] Checking for existing server on port 8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    echo Killing existing process %%a
    taskkill /F /PID %%a 2>nul
)

echo [4/5] Starting Python Backend Server (PyTorch + TAPIR)...
start "MechAnim Backend" cmd /k "cd /d %~dp0backend && C:\Users\hp\miniconda3\python.exe server.py"

echo Waiting for backend to start...
timeout /t 5 /nobreak > nul

echo [5/5] Checking for existing frontend on port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    echo Killing existing process %%a
    taskkill /F /PID %%a 2>nul
)

echo Starting Frontend Dev Server...
echo.
echo ============================================
echo   Opening http://localhost:3000
echo   Backend API: http://localhost:8000
echo ============================================
echo.
start http://localhost:3000
call npm run dev
