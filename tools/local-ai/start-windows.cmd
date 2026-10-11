@echo off
setlocal
cd /d "%~dp0"

rem Models, venv and temp files are large (8-12 GB). Set VIDEO_STUDIO_AI_HOME to a roomy drive, e.g.
rem   setx VIDEO_STUDIO_AI_HOME D:\video-studio-ai
if not defined VIDEO_STUDIO_AI_HOME set "VIDEO_STUDIO_AI_HOME=%~dp0.ai-home"
set "VENV=%VIDEO_STUDIO_AI_HOME%\venv"
set "PY=%VENV%\Scripts\python.exe"
set "HF_HOME=%VIDEO_STUDIO_AI_HOME%\models\huggingface"
set "PIP_CACHE_DIR=%VIDEO_STUDIO_AI_HOME%\pip-cache"
set "TMP=%VIDEO_STUDIO_AI_HOME%\work"
set "TEMP=%VIDEO_STUDIO_AI_HOME%\work"
if not exist "%TMP%" mkdir "%TMP%"

set "DEVICE=cpu"
set "TORCH_INDEX=https://download.pytorch.org/whl/cpu"
where nvidia-smi >nul 2>nul && (
  set "DEVICE=cuda"
  set "TORCH_INDEX=https://download.pytorch.org/whl/cu128"
)

if not exist "%PY%" (
  py -3.12 -m venv "%VENV%" || py -3.11 -m venv "%VENV%" || goto fail
)

rem Reinstall only when the dependency lists or the device change.
set "WANTED=%VIDEO_STUDIO_AI_HOME%\wanted.txt"
set "STAMP=%VIDEO_STUDIO_AI_HOME%\installed.txt"
(type requirements.txt & type requirements-karaoke.txt & type constraints.txt & echo device=%DEVICE%) > "%WANTED%"
fc /b "%WANTED%" "%STAMP%" >nul 2>nul && goto run

echo Installing AI packages for %DEVICE% into %VENV% ...
"%PY%" -m pip install --upgrade pip || goto fail
"%PY%" -m pip install -c constraints.txt torch torchvision torchaudio --index-url %TORCH_INDEX% || goto fail
"%PY%" -m pip install -c constraints.txt -r requirements.txt -r requirements-karaoke.txt || goto fail
if "%DEVICE%"=="cuda" (
  rem faster-whisper pulls the CPU onnxruntime; both packages ship the same module, keep only the GPU build.
  "%PY%" -m pip uninstall -y onnxruntime
  "%PY%" -m pip install --force-reinstall --no-deps onnxruntime-gpu==1.31.0 || goto fail
)
copy /y "%WANTED%" "%STAMP%" >nul

:run
"%PY%" server.py --device %DEVICE% %*
pause
exit /b

:fail
echo Setup failed. Install Python 3.12 (python.org, tick "Add to PATH"), check the network, then run this file again.
pause
exit /b 1
