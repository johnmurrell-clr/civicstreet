@echo off
title CivicStreet Server
color 0A

echo.
echo ============================================
echo   CivicStreet by CLR Mapping Solutions
echo ============================================
echo.
echo   Management portal: http://localhost:3000/manage
echo   Dev tenant test:   http://localhost:3000/tenant/waller
echo.
echo   Press Ctrl+C to stop.
echo.

start "" "http://localhost:3000/manage"
node server.js
pause
