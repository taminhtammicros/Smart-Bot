<#
============================================================================
 2Anh Zalo Bot — chạy sidecar trên Windows 10/11 (x86_64)

 Dùng:
   powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1 [tuỳ chọn]

   -Background      Chạy nền, ghi log vào logs\sidecar.out, in PID
   -Stop            Dừng tiến trình đang chạy nền
   -Status          Xem tiến trình nền có đang chạy không
   -Dashboard       Chạy dashboard thay vì sidecar
   -Port <số>       Ghi đè ZCA_PORT (cổng sidecar, mặc định 3872)
   -NoChecks        Bỏ qua kiểm tra Node và tệp .env

 Script này KHÔNG cài đặt gì. Chạy .\scripts\setup.bat trước.
============================================================================
#>
[CmdletBinding()]
param(
  [switch]$Background,
  [switch]$Stop,
  [switch]$Status,
  [switch]$Dashboard,
  [int]$Port = 0,
  [switch]$NoChecks
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$EnvFile = Join-Path $RepoRoot '.env'
$LogsDir = Join-Path $RepoRoot 'logs'
$LogFile = Join-Path $LogsDir 'sidecar.out'
$PidFile = Join-Path $LogsDir 'sidecar.pid'

function Write-Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Write-Warn2($m) { Write-Host "  LƯU Ý $m" -ForegroundColor Yellow }
function Write-Bad($m)  { Write-Host "  LỖI  $m" -ForegroundColor Red }
function Write-Say($m)  { Write-Host $m }

function Get-RunningPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -Raw).Trim()
  if (-not $raw) { return $null }
  $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
  if ($proc) { return [int]$raw }
  return $null
}

function Get-EnvValue([string]$Key) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $line = Get-Content $EnvFile -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } |
    Select-Object -Last 1
  if (-not $line) { return '' }
  return ($line -replace "^\s*$([regex]::Escape($Key))\s*=\s*", '').Trim()
}

# --- Dừng ------------------------------------------------------------------
if ($Stop) {
  $running = Get-RunningPid
  if ($running) {
    Write-Say "Đang dừng sidecar (PID $running)…"
    Stop-Process -Id $running -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $running -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 300
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Ok 'Đã dừng'
  } else {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Warn2 'Không có tiến trình nền nào đang chạy'
  }
  exit 0
}

# --- Trạng thái -------------------------------------------------------------
if ($Status) {
  $running = Get-RunningPid
  if ($running) {
    Write-Ok "Đang chạy (PID $running) — log: $LogFile"
    exit 0
  }
  Write-Warn2 'Không chạy'
  exit 1
}

# --- Node -------------------------------------------------------------------
$NodeBin = $null
if (Get-Command node -ErrorAction SilentlyContinue) { $NodeBin = (Get-Command node).Source }
else {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates) { $NodeBin = @($candidates)[0] }
}
if (-not $NodeBin) {
  Write-Bad 'Chưa có Node.js — cài bằng: winget install OpenJS.NodeJS.LTS'
  exit 1
}

if (-not $NoChecks) {
  $nodeVersion = (& $NodeBin -p 'process.versions.node').Trim()
  $parts = $nodeVersion.Split('.')
  if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 5)) {
    Write-Bad "Node v$nodeVersion quá cũ — cần >= 22.5"
    exit 1
  }
  Write-Ok "Node v$nodeVersion"
  if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Bad 'Chưa cài thư viện Node — chạy .\scripts\setup.bat trước.'
    exit 1
  }
  if (-not (Test-Path $EnvFile)) {
    Write-Bad 'Thiếu .env — chạy .\scripts\setup.bat trước (script đó sinh token cho bạn).'
    exit 1
  }
}

# --- Cổng và biến môi trường ------------------------------------------------
if ($Port -gt 0) {
  $env:ZCA_PORT = [string]$Port
  Write-Ok "Cổng sidecar: $Port (ghi đè)"
}

if (-not $env:HERMES_HOME) {
  $hermesFromEnv = Get-EnvValue 'HERMES_HOME'
  if ($hermesFromEnv) { $env:HERMES_HOME = $hermesFromEnv }
}

if ($Dashboard) {
  $Entry = Join-Path $RepoRoot 'dashboard\server.js'
  $Label = 'dashboard'
} else {
  $Entry = Join-Path $RepoRoot 'server.js'
  $Label = 'sidecar'
}
if (-not (Test-Path $Entry)) {
  Write-Bad "Không thấy $Entry — mã nguồn chưa đầy đủ."
  exit 1
}

Push-Location $RepoRoot
try {
  # --- Chạy nền -------------------------------------------------------------
  if ($Background) {
    $running = Get-RunningPid
    if ($running) {
      Write-Bad "Đã có $Label đang chạy (PID $running). Dừng bằng -Stop trước."
      exit 1
    }
    if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }
    $proc = Start-Process -FilePath $NodeBin -ArgumentList @($Entry) `
      -WorkingDirectory $RepoRoot -RedirectStandardOutput $LogFile `
      -RedirectStandardError (Join-Path $LogsDir 'sidecar.err') `
      -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII
    Start-Sleep -Seconds 1
    if (-not $proc.HasExited) {
      Write-Ok "$Label chạy nền (PID $($proc.Id))"
      Write-Say "  Log: $LogFile"
      Write-Say '  Dừng: .\scripts\run.bat -Stop'
      Write-Say ''
      Write-Say '  Dashboard: http://127.0.0.1:3880'
      exit 0
    }
    Write-Bad "$Label thoát ngay sau khi khởi động. 20 dòng cuối của log:"
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 | ForEach-Object { Write-Say "    $_" } }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    exit 1
  }

  # --- Chạy tiền cảnh -------------------------------------------------------
  Write-Say "Chạy $Label…  (Ctrl+C để dừng)"
  Write-Say 'Dashboard: http://127.0.0.1:3880'
  Write-Say ''
  & $NodeBin $Entry
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
