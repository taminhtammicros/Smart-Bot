@echo off
REM ===========================================================================
REM  2Anh Zalo Bot — cài đặt trên Windows 10/11 (x86_64)
REM  Lớp gọi mỏng: mọi việc thật nằm ở scripts\setup.ps1.
REM  Nhấp đúp tệp này cũng chạy được (Windows sẽ mở cmd rồi gọi PowerShell).
REM ===========================================================================
setlocal

where powershell >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay PowerShell - Windows 10/11 luon co san; kiem tra PATH.
  pause
  exit /b 1
)

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [LOI] Cai dat that bai - ma thoat %EXITCODE%. Doc thong bao o tren.
)
REM Giữ cửa sổ khi người dùng nhấp đúp, không giữ khi gọi từ script khác.
echo %CMDCMDLINE% | find /i "%~nx0" >nul && (
  if not defined CI pause
)
exit /b %EXITCODE%
