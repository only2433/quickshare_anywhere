@echo off
setlocal
cd /d "%~dp0"
title QuickShare

echo.
echo   ==================================================
echo     QuickShare
echo   ==================================================
echo.

REM --- Node 확인 ---
where node >nul 2>nul
if errorlevel 1 (
  echo   [오류] Node.js 가 설치되어 있지 않습니다.
  echo          https://nodejs.org 에서 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

REM --- 이미 떠 있으면 브라우저만 연다 ---
netstat -an | findstr ":4000" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   이미 실행 중입니다. 브라우저만 엽니다.
  echo.
  start "" "http://localhost:4000"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

REM --- 처음 실행이면 패키지 설치 ---
if not exist "node_modules\qrcode" (
  echo   처음 실행이라 필요한 패키지를 내려받습니다...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [오류] 패키지 설치에 실패했습니다. 인터넷 연결을 확인하세요.
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo   브라우저가 곧 열립니다. 그 화면의 QR 을 폰이나 태블릿으로 찍으세요.
echo   이 창을 닫거나 Ctrl+C 를 누르면 종료됩니다.
echo.

REM --- 서버가 뜰 때쯤 브라우저를 띄운다 ---
start /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4000'"

REM --- 여기부터는 node 의 UTF-8 출력이 깨지지 않도록 코드페이지를 바꾼다.
REM     이 줄 아래로는 한글을 쓰지 않는다 (배치 파일은 CP949 로 저장되어 있다).
chcp 65001 >nul
node server.js

echo.
echo   Server stopped. Press any key to close.
pause >nul
