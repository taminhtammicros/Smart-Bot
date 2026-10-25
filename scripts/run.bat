@echo off
REM ===========================================================================
REM  2Anh Zalo Bot — chạy sidecar trên Windows 10/11 (x86_64)
REM  Lớp gọi mỏng: mọi việc thật nằm ở scripts\run.ps1.
REM
REM  Vi du:
REM    scripts\run.bat                 chay tien canh (Ctrl+C de dung)
REM    scripts\run.bat -Background     chay nen
REM    scripts\run.bat -Stop           dung tien trinh nen
REM    scripts\run.bat -Status         xem trang thai
REM    scripts\run.bat -Dashboard      chay dashboard
REM ===========================================================================
setlocal

where powershell >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay PowerShell - Windows 10/11 luon co san; kiem tra PATH.
  pause
  exit /b 1
)

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" if not "%1"=="-Status" (
  echo.
  echo [LOI] Lenh that bai - ma thoat %EXITCODE%.
)
exit /b %EXITCODE%
