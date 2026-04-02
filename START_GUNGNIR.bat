@echo off
title Gungnir Launcher
echo ============================================
echo   GUNGNIR - Full Stack Launcher
echo ============================================
echo.
echo Starting Backend...
start "Gungnir Backend" cmd /k "cd /d "%~dp0" && python -m uvicorn backend.core.main:app --host 127.0.0.1 --port 8000 --reload"

echo Waiting for backend to start...
timeout /t 3 /nobreak > nul

echo Starting Frontend...
start "Gungnir Frontend" cmd /k "cd /d "%~dp0\frontend" && npm run dev"

echo.
echo ============================================
echo   Backend: http://127.0.0.1:8000
echo   Frontend: http://localhost:5173
echo ============================================
echo.
echo Both servers are starting in separate windows.
echo Close this window when done.
pause
