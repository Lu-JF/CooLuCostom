@echo off
REM Start the Coo desktop pet (this dev instance of Coopanion).
REM If something is already serving the console port, do nothing.
setlocal
set PORT=17788

curl -s -m 2 -o NUL http://127.0.0.1:%PORT%/api/status >NUL 2>&1
if not errorlevel 1 (
  echo.
  echo Coo is already running.   Console: http://127.0.0.1:%PORT%/
  echo This window closes by itself in a few seconds.
  if exist "%SystemRoot%\System32\timeout.exe" "%SystemRoot%\System32\timeout.exe" /t 5 /nobreak >NUL 2>&1
  exit /b 0
)

cd /d "%~dp0..\upstream\coopanion"
echo Starting Coo ...  console: http://127.0.0.1:%PORT%/   (quit from the tray icon)
echo Close this window to stop the pet.
call pnpm run dev
if errorlevel 1 (
  echo.
  echo Failed to start - see the messages above.
  pause
)
endlocal
