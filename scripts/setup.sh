#!/usr/bin/env bash
# ============================================================================
#  2Anh Zalo Bot — cài đặt native (macOS Intel/Apple Silicon · Linux x86_64/arm64)
# ============================================================================
#  Dùng:  ./scripts/setup.sh [tuỳ chọn]
#
#    --hermes-home <đường-dẫn>   Thư mục Hermes Agent (mặc định: tự dò)
#    --vieneu-tts                Bật giọng Việt offline (tải model ~282 MB)
#    --no-dashboard              Không cài dịch vụ dashboard
#    --skip-python               Bỏ qua kiểm tra thư viện Python của Hermes
#    --venv                      Dựng thêm .venv cục bộ để chạy test Python
#    --offline                   Chỉ dùng gói đã tải sẵn (không gọi npm/pip)
#    -h | --help                 Hiện trợ giúp
#
#  Script KHÔNG cần quyền root. Không sửa tệp ngoài repo và <HERMES_HOME>.
# ============================================================================
set -eu

# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

HERMES_HOME_ARG=''
VIENEU=0
NO_DASHBOARD=0
SKIP_PYTHON=0
MAKE_VENV=0
OFFLINE=0

usage() {
  # In khối "Dùng:" giữa hai dòng kẻ đầu tệp (fence 1 mở, fence 2 đóng — awk
  # đếm tới 2 ngay ở dòng fence đóng nên phải nhận cả `n == 1` lẫn `n == 2`).
  # Không dùng `next`: BSD awk của macOS bỏ qua nó trong điều kiện lồng.
  awk '
    BEGIN { n = 0 }
    $0 ~ /^# =====/ { n += 1 }
    (n == 1 || n == 2) && $0 !~ /^# =====/ { sub(/^# ?/, ""); print }
  ' "${BASH_SOURCE[0]}"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --hermes-home) [ $# -ge 2 ] || die '--hermes-home cần một đường dẫn'; HERMES_HOME_ARG="$2"; shift 2 ;;
    --hermes-home=*) HERMES_HOME_ARG="${1#*=}"; shift ;;
    --vieneu-tts) VIENEU=1; shift ;;
    --no-dashboard) NO_DASHBOARD=1; shift ;;
    --skip-python) SKIP_PYTHON=1; shift ;;
    --venv) MAKE_VENV=1; shift ;;
    --offline) OFFLINE=1; shift ;;
    -h|--help) usage ;;
    *) die "Tham số lạ: $1  (xem --help)" ;;
  esac
done

say ''
say '============================================================'
say '  2Anh Zalo Bot — cài đặt native'
say '============================================================'

# ---------------------------------------------------------------------------
step '1/6  Kiểm tra máy đích'
# ---------------------------------------------------------------------------
require_node || exit 1
resolve_npm || die "Không tìm thấy npm cạnh $NODE_BIN — cài lại Node từ nodejs.org."
ok "npm $("$NPM_BIN" -v)"

case "$(cpu_arch)" in
  x64|arm64) ok "Kiến trúc $(cpu_arch) trên $(os_name)" ;;
  *) die "Kiến trúc $(uname -m) chưa được hỗ trợ (chỉ x64 và arm64)." ;;
esac

if [ -n "$HERMES_HOME_ARG" ]; then
  export HERMES_HOME="$HERMES_HOME_ARG"
  ok "HERMES_HOME=$HERMES_HOME (do bạn chỉ định)"
elif [ -n "${HERMES_HOME:-}" ]; then
  ok "HERMES_HOME=$HERMES_HOME (từ môi trường)"
fi

PYTHON_BIN="$(find_python || true)"

# ---------------------------------------------------------------------------
step '2/6  Cài thư viện Node (npm ci — tất định, theo package-lock.json)'
# ---------------------------------------------------------------------------
cd "$REPO_ROOT"
if [ "$OFFLINE" -eq 1 ] && [ -d "$(path_join "$REPO_ROOT" 'node_modules')" ]; then
  ok 'Chế độ offline: giữ nguyên node_modules hiện có'
else
  if [ -d "$(path_join "$REPO_ROOT" 'node_modules')" ] && [ "$OFFLINE" -eq 0 ]; then
    # `npm ci` xoá node_modules rồi cài lại — chỉ chạy lại khi cần.
    if "$NPM_BIN" ls --depth=0 >/dev/null 2>&1; then
      ok 'node_modules đã đủ, bỏ qua (xoá thư mục đó để cài lại từ đầu)'
    else
      warn 'node_modules lệch với package-lock.json — cài lại'
      "$NPM_BIN" ci || die 'npm ci thất bại — xem thông báo ở trên.'
      ok 'Đã cài lại node_modules'
    fi
  else
    "$NPM_BIN" ci || die 'npm ci thất bại — kiểm tra mạng rồi chạy lại.'
    ok 'Đã cài node_modules'
  fi
fi

# ---------------------------------------------------------------------------
step '3/6  Chuẩn bị tệp cấu hình (.env)'
# ---------------------------------------------------------------------------
ENV_FILE="$(path_join "$REPO_ROOT" '.env')"
if [ -f "$ENV_FILE" ]; then
  ok ".env đã có — giữ nguyên"
else
  cp "$(path_join "$REPO_ROOT" '.env.example')" "$ENV_FILE" || die 'Không chép được .env.example → .env'
  TOKEN="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
  env_set "$ENV_FILE" 'ZALO_BRIDGE_TOKEN' "$TOKEN"
  ok 'Đã tạo .env và sinh ZALO_BRIDGE_TOKEN'
fi

# Token rỗng = bridge không xác thực được; sinh bù chứ không ghi đè token đang dùng.
if [ -z "$(env_get "$ENV_FILE" 'ZALO_BRIDGE_TOKEN')" ]; then
  TOKEN="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
  env_set "$ENV_FILE" 'ZALO_BRIDGE_TOKEN' "$TOKEN"
  ok 'ZALO_BRIDGE_TOKEN trống → đã sinh mới'
fi

ensure_dir "$(path_join "$REPO_ROOT" 'data')"
ensure_dir "$(path_join "$REPO_ROOT" 'logs')"
ok 'Đã có thư mục data/ và logs/'

# ---------------------------------------------------------------------------
step '4/6  Cài plugin vào Hermes Agent'
# ---------------------------------------------------------------------------
# Truyền tham số qua mảng bash (bash 3.2 vẫn hỗ trợ), không dùng eval để tránh
# đường dẫn có dấu cách bị tách từ.
set --
[ -n "$HERMES_HOME_ARG" ] && set -- "$@" --hermes-home "$HERMES_HOME_ARG"
[ "$VIENEU" -eq 1 ] && set -- "$@" --vieneu-tts
[ "$NO_DASHBOARD" -eq 1 ] && set -- "$@" --no-dashboard
[ "$SKIP_PYTHON" -eq 1 ] && set -- "$@" --skip-python

if "$NODE_BIN" "$(path_join "$REPO_ROOT" 'scripts' 'install-hermes.js')" "$@"; then
  ok 'Plugin + config.yaml của Hermes đã cập nhật'
else
  bad 'Bộ cài Hermes báo lỗi — đọc các dòng [FAIL] ở trên.'
  say '  Khắc phục thường gặp:'
  say '    • Chưa cài Hermes Agent  → https://github.com/NousResearch/hermes-agent'
  say '    • Hermes ở chỗ khác       → chạy lại với --hermes-home <đường-dẫn>'
  exit 1
fi

# ---------------------------------------------------------------------------
step '5/6  Môi trường Python cục bộ (tuỳ chọn, cho test plugin)'
# ---------------------------------------------------------------------------
if [ "$MAKE_VENV" -eq 1 ]; then
  if [ -z "$PYTHON_BIN" ]; then
    warn 'Không có python3 — bỏ qua .venv (chỉ ảnh hưởng `npm run test:py`)'
  elif ! python_ok "$PYTHON_BIN"; then
    warn "python3 quá cũ ($("$PYTHON_BIN" -V 2>&1)) — cần >= 3.10, bỏ qua .venv"
  else
    if [ ! -d "$(venv_dir)" ]; then
      "$PYTHON_BIN" -m venv "$(venv_dir)" || die 'Không tạo được .venv'
      ok "Đã tạo .venv ($("$PYTHON_BIN" -V 2>&1))"
    else
      ok '.venv đã có'
    fi
    VPY="$(venv_python)"
    if [ -n "$VPY" ]; then
      "$VPY" -m pip install --upgrade pip >/dev/null 2>&1 || warn 'Không nâng được pip (bỏ qua)'
      # requirements.txt không ghim bản macOS-only: pip tự chọn wheel đúng OS + kiến trúc.
      if "$VPY" -m pip install -r "$(path_join "$REPO_ROOT" 'requirements.txt')"; then
        ok 'Đã cài thư viện Python vào .venv'
      else
        warn 'Cài requirements.txt lỗi một phần — chỉ ảnh hưởng `npm run test:py`, bot vẫn chạy.'
      fi
    fi
  fi
else
  ok 'Bỏ qua .venv (thêm --venv nếu muốn chạy test Python cục bộ)'
fi

# ---------------------------------------------------------------------------
step '6/6  Chạy bản chẩn đoán'
# ---------------------------------------------------------------------------
if "$NODE_BIN" "$(path_join "$REPO_ROOT" 'scripts' 'doctor.js')" ${HERMES_HOME_ARG:+--hermes-home "$HERMES_HOME_ARG"}; then
  ok 'Bản chẩn đoán không có lỗi'
else
  warn 'doctor báo còn mục chưa đạt — xem các dòng [FAIL] ở trên.'
fi

say ''
say '============================================================'
say "  ${C_OK}Cài đặt xong.${C_OFF}"
say '============================================================'
say ''
say '  Bước tiếp theo:'
say '    1. Chạy bot:            ./scripts/run.sh'
say '    2. Mở dashboard:        http://127.0.0.1:3880'
say '    3. Mục "Tài khoản Zalo" → tạo QR → quét bằng Zalo phụ'
say '    4. Nhắn riêng /sethome cho tài khoản vừa quét → nhận UID'
say '    5. Thêm ZALO_ALLOWED_USERS=<UID> vào .env của Hermes'
say '    6. Khởi động lại gateway Hermes'
say ''
