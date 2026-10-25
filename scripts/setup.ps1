<#
============================================================================
 2Anh Zalo Bot — cài đặt native cho Windows 10/11 (x86_64)

 Dùng:
   powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 [tuỳ chọn]

   -HermesHome <đường-dẫn>   Thư mục Hermes Agent (mặc định: tự dò)
   -VieneuTts                Bật giọng Việt offline (tải model ~282 MB)
   -NoDashboard              Không cài dịch vụ dashboard
   -SkipPython               Bỏ qua kiểm tra thư viện Python của Hermes
   -Venv                     Dựng thêm .venv cục bộ để chạy test Python
   -Offline                  Chỉ dùng gói đã có (không gọi npm/pip)

 Vì sao .ps1 chứ không phải .bat: xử lý đường dẫn có dấu cách, Unicode tiếng
 Việt và mã thoát lỗi đều đúng hơn hẳn cmd.exe. setup.bat chỉ là lớp gọi lại
 tệp này với ExecutionPolicy Bypass.
============================================================================
#>
[CmdletBinding()]
param(
  [string]$HermesHome = '',
  [switch]$VieneuTts,
  [switch]$NoDashboard,
  [switch]$SkipPython,
  [switch]$Venv,
  [switch]$Offline,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- Đường dẫn gốc: luôn dựng từ vị trí tệp này, không đoán theo cwd ---------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$NodeModules = Join-Path $RepoRoot 'node_modules'
$EnvFile = Join-Path $RepoRoot '.env'
$EnvExample = Join-Path $RepoRoot '.env.example'
$DataDir = Join-Path $RepoRoot 'data'
$LogsDir = Join-Path $RepoRoot 'logs'
$VenvDir = Join-Path $RepoRoot '.venv'
$Requirements = Join-Path $RepoRoot 'requirements.txt'
$InstallScript = Join-Path $RepoRoot 'scripts\install-hermes.js'
$DoctorScript = Join-Path $RepoRoot 'scripts\doctor.js'
$CheckRuntime = Join-Path $RepoRoot 'scripts\native\check-runtime.js'

# --- Màu: chỉ bật khi console hỗ trợ ----------------------------------------
function Write-Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Write-Warn2($m) { Write-Host "  LƯU Ý $m" -ForegroundColor Yellow }
function Write-Bad($m)  { Write-Host "  LỖI  $m" -ForegroundColor Red }
function Write-Say($m)  { Write-Host $m }
function Write-Step($m) { Write-Host "`n> $m" -ForegroundColor DarkGray }
function Stop-Fail($m)  { Write-Bad $m; exit 1 }

if ($Help) {
  Get-Content $MyInvocation.MyCommand.Path |
    Select-Object -Skip 2 |
    Where-Object { $_ -match '^ [A-Za-zĐ]' -or $_ -match '^   -' -or $_ -match '^\s*$' } |
    Where-Object { $_ -notmatch '^=' } |
    ForEach-Object { $_ -replace '^\s', '' }
  exit 0
}

Write-Say ''
Write-Say '============================================================'
Write-Say '  2Anh Zalo Bot — cài đặt trên Windows'
Write-Say '============================================================'

# ---------------------------------------------------------------------------
Write-Step '1/6  Kiểm tra máy đích'
# ---------------------------------------------------------------------------
$NodeBin = $null
if (Get-Command node -ErrorAction SilentlyContinue) {
  $NodeBin = (Get-Command node).Source
} else {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:APPDATA 'nvm\current\node.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates) { $NodeBin = @($candidates)[0] }
}
if (-not $NodeBin) {
  Write-Bad 'Chưa có Node.js.'
  Write-Say '  -> winget install OpenJS.NodeJS.LTS'
  Write-Say '     hoặc tải installer: https://nodejs.org/en/download (chọn Windows 64-bit)'
  exit 1
}

$nodeVersion = (& $NodeBin -p 'process.versions.node').Trim()
$parts = $nodeVersion.Split('.')
$major = [int]$parts[0]; $minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  Write-Bad "Node.js quá cũ: v$nodeVersion — cần >= 22.5 (dự án dùng node:sqlite)."
  Write-Say '  -> winget install OpenJS.NodeJS.LTS'
  exit 1
}
Write-Ok "Node v$nodeVersion  ($NodeBin)"

$NpmBin = $null
$npmCmd = Join-Path (Split-Path -Parent $NodeBin) 'npm.cmd'
if (Test-Path $npmCmd) { $NpmBin = $npmCmd }
elseif (Get-Command npm -ErrorAction SilentlyContinue) { $NpmBin = (Get-Command npm).Source }
else { Stop-Fail 'Không tìm thấy npm cạnh Node — cài lại Node từ nodejs.org.' }
Write-Ok "npm $((& $NpmBin -v).Trim())"

if ($env:PROCESSOR_ARCHITECTURE -match 'AMD64|ARM64') {
  Write-Ok "Kiến trúc $env:PROCESSOR_ARCHITECTURE"
} else {
  Stop-Fail "Kiến trúc $env:PROCESSOR_ARCHITECTURE chưa được hỗ trợ (cần x86_64 hoặc ARM64)."
}

if ($HermesHome) { $env:HERMES_HOME = $HermesHome; Write-Ok "HERMES_HOME=$HermesHome (do bạn chỉ định)" }
elseif ($env:HERMES_HOME) { Write-Ok "HERMES_HOME=$env:HERMES_HOME (từ môi trường)" }

# Chạy bản kiểm tra dùng chung (cùng logic với macOS/Linux).
& $NodeBin $CheckRuntime
if ($LASTEXITCODE -ne 0) {
  Stop-Fail 'Máy chưa đủ điều kiện — sửa các mục THIẾU ở trên rồi chạy lại.'
}

# ---------------------------------------------------------------------------
Write-Step '2/6  Cài thư viện Node (npm ci)'
# ---------------------------------------------------------------------------
Push-Location $RepoRoot
try {
  if ($Offline -and (Test-Path $NodeModules)) {
    Write-Ok 'Chế độ offline: giữ nguyên node_modules hiện có'
  } elseif ((Test-Path $NodeModules) -and -not $Offline) {
    & $NpmBin ls --depth=0 *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Ok 'node_modules đã đủ, bỏ qua (xoá thư mục đó để cài lại từ đầu)'
    } else {
      Write-Warn2 'node_modules lệch với package-lock.json — cài lại'
      & $NpmBin ci
      if ($LASTEXITCODE -ne 0) { Stop-Fail 'npm ci thất bại — kiểm tra mạng rồi chạy lại.' }
      Write-Ok 'Đã cài lại node_modules'
    }
  } else {
    & $NpmBin ci
    if ($LASTEXITCODE -ne 0) { Stop-Fail 'npm ci thất bại — kiểm tra mạng rồi chạy lại.' }
    Write-Ok 'Đã cài node_modules'
  }
} finally {
  Pop-Location
}

# ---------------------------------------------------------------------------
Write-Step '3/6  Chuẩn bị tệp cấu hình (.env)'
# ---------------------------------------------------------------------------
function Get-EnvValue([string]$Key) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $line = Get-Content $EnvFile -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } |
    Select-Object -Last 1
  if (-not $line) { return '' }
  return ($line -replace "^\s*$([regex]::Escape($Key))\s*=\s*", '').Trim()
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path $EnvFile) { $lines = @(Get-Content $EnvFile -Encoding UTF8) }
  $found = $false
  $out = foreach ($l in $lines) {
    if ($l -match "^\s*$([regex]::Escape($Key))\s*=") {
      if (-not $found) { "$Key=$Value"; $found = $true }
    } else { $l }
  }
  if (-not $found) { $out = @($out) + "$Key=$Value" }
  # UTF8 không BOM: Python đọc .env của Hermes, BOM sẽ thành ký tự đầu khoá.
  [System.IO.File]::WriteAllLines($EnvFile, $out, (New-Object System.Text.UTF8Encoding($false)))
}

if (Test-Path $EnvFile) {
  Write-Ok '.env đã có — giữ nguyên'
} else {
  Copy-Item $EnvExample $EnvFile
  $token = (& $NodeBin -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))').Trim()
  Set-EnvValue 'ZALO_BRIDGE_TOKEN' $token
  Write-Ok 'Đã tạo .env và sinh ZALO_BRIDGE_TOKEN'
}
if (-not (Get-EnvValue 'ZALO_BRIDGE_TOKEN')) {
  $token = (& $NodeBin -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))').Trim()
  Set-EnvValue 'ZALO_BRIDGE_TOKEN' $token
  Write-Ok 'ZALO_BRIDGE_TOKEN trống → đã sinh mới'
}
foreach ($d in @($DataDir, $LogsDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
}
Write-Ok 'Đã có thư mục data\ và logs\'

# ---------------------------------------------------------------------------
Write-Step '4/6  Cài plugin vào Hermes Agent'
# ---------------------------------------------------------------------------
$installArgs = @()
if ($HermesHome) { $installArgs += @('--hermes-home', $HermesHome) }
if ($VieneuTts) { $installArgs += '--vieneu-tts' }
if ($NoDashboard) { $installArgs += '--no-dashboard' }
if ($SkipPython) { $installArgs += '--skip-python' }

& $NodeBin $InstallScript @installArgs
if ($LASTEXITCODE -ne 0) {
  Write-Bad 'Bộ cài Hermes báo lỗi — đọc các dòng [FAIL] ở trên.'
  Write-Say '  Khắc phục thường gặp:'
  Write-Say '    - Chưa cài Hermes Agent  -> https://github.com/NousResearch/hermes-agent'
  Write-Say '    - Hermes ở chỗ khác       -> chạy lại với -HermesHome <đường-dẫn>'
  exit 1
}
Write-Ok 'Plugin + config.yaml của Hermes đã cập nhật'

# ---------------------------------------------------------------------------
Write-Step '5/6  Môi trường Python cục bộ (tuỳ chọn, cho test plugin)'
# ---------------------------------------------------------------------------
if ($Venv) {
  $PyLauncher = $null
  foreach ($c in @('python', 'py')) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $PyLauncher = $c; break }
  }
  if (-not $PyLauncher) {
    Write-Warn2 'Không có Python — bỏ qua .venv (chỉ ảnh hưởng npm run test:py)'
  } else {
    if (-not (Test-Path $VenvDir)) {
      & $PyLauncher -m venv $VenvDir
      if ($LASTEXITCODE -ne 0) { Stop-Fail 'Không tạo được .venv' }
      Write-Ok 'Đã tạo .venv'
    } else { Write-Ok '.venv đã có' }
    $VenvPy = Join-Path $VenvDir 'Scripts\python.exe'
    if (Test-Path $VenvPy) {
      & $VenvPy -m pip install --upgrade pip *> $null
      & $VenvPy -m pip install -r $Requirements
      if ($LASTEXITCODE -eq 0) { Write-Ok 'Đã cài thư viện Python vào .venv' }
      else { Write-Warn2 'Cài requirements.txt lỗi một phần — chỉ ảnh hưởng npm run test:py, bot vẫn chạy.' }
    }
  }
} else {
  Write-Ok 'Bỏ qua .venv (thêm -Venv nếu muốn chạy test Python cục bộ)'
}

# ---------------------------------------------------------------------------
Write-Step '6/6  Chạy bản chẩn đoán'
# ---------------------------------------------------------------------------
$doctorArgs = @()
if ($HermesHome) { $doctorArgs += @('--hermes-home', $HermesHome) }
& $NodeBin $DoctorScript @doctorArgs
if ($LASTEXITCODE -ne 0) { Write-Warn2 'doctor báo còn mục chưa đạt — xem các dòng [FAIL] ở trên.' }
else { Write-Ok 'Bản chẩn đoán không có lỗi' }

Write-Say ''
Write-Say '============================================================'
Write-Say '  Cài đặt xong.'
Write-Say '============================================================'
Write-Say ''
Write-Say '  Bước tiếp theo:'
Write-Say '    1. Chạy bot:            .\scripts\run.bat'
Write-Say '    2. Mở dashboard:        http://127.0.0.1:3880'
Write-Say '    3. Mục "Tài khoản Zalo" -> tạo QR -> quét bằng Zalo phụ'
Write-Say '    4. Nhắn riêng /sethome cho tài khoản vừa quét -> nhận UID'
Write-Say '    5. Thêm ZALO_ALLOWED_USERS=<UID> vào .env của Hermes'
Write-Say '    6. Khởi động lại gateway Hermes'
Write-Say ''
