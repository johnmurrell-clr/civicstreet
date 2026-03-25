@echo off
title CivicStreet Setup
color 0A

echo.
echo ============================================
echo   CivicStreet - First Time Setup
echo ============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  ERROR: Node.js not found.
    echo  Download from: https://nodejs.org (LTS version)
    pause
    exit /b 1
)

echo  [1/2] Node.js found:
node --version
echo.

echo  [2/2] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    color 0C
    echo  ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete! Starting CivicStreet...
echo ============================================
echo.
echo   Management portal: http://localhost:3000/manage
echo   Super admin login: clradmin / CLRmapping2024!
echo.
echo   IMPORTANT: Change your password in server.js before going live!
echo.

start "" "http://localhost:3000/manage"
node server.js
pause
