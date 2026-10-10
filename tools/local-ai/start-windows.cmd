@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
  if errorlevel 1 goto fail
)
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto fail
.venv\Scripts\python.exe server.py %*
pause
exit /b
:fail
echo Setup failed. Install Python 3.11 or 3.12, then run this file again.
pause
exit /b 1
