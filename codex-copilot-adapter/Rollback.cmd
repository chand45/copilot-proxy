@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage-Adapter.ps1" -Action Rollback
if errorlevel 1 (
  echo Rollback did not complete. Read the error above.
  pause
  exit /b 1
)
echo Routing restored and adapter startup disabled. Installed files are kept for inspection.
pause
