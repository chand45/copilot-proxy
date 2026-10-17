@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage-Adapter.ps1" -Action Install
if errorlevel 1 (
  echo Installation did not complete. Read the error above.
  pause
  exit /b 1
)
echo Installation complete. Create a new phone chat on this Codex Remote host to verify.
pause
