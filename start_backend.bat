@echo off
title Gungnir Backend
echo ============================================
echo   GUNGNIR - Backend (FastAPI/Uvicorn)
echo ============================================
echo.
cd /d "%~dp0"
python -m uvicorn backend.core.main:app --host 127.0.0.1 --port 8000 --reload
pause
