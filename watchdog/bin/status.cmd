@echo off
chcp 65001 >nul
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
"%NODE%" "%~dp0status.mjs" %*