@echo off
rem Start DS_RESTAR, detached from the calling process tree.
rem WMI is used so the new process is not inside DSH's job object
rem (otherwise DSH being killed would take the watchdog with it).
setlocal
rem ---- resolve node.exe (portable) --------------------------------------
rem 1) %NODE_EXE%  2) node on PATH  3) DSH bundled node (Program Files / LocalAppData)
set "NODE=%NODE_EXE%"
if not "%NODE%"=="" if exist "%NODE%" goto :nodeok
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not "%NODE%"=="" goto :nodeok
set "NODE=%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE%" goto :nodeok
set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE%" goto :nodeok
echo node.exe not found. Set NODE_EXE to your node.exe and retry.
exit /b 1
:nodeok

cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-detached.ps1" "%NODE%" "%~dp0..\src\watchdog.mjs"
if errorlevel 1 (
  echo WMI launch failed, falling back to start
  start "DS_RESTAR" /min "%NODE%" "%~dp0..\src\watchdog.mjs"
)