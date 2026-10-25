#!/usr/bin/env bash
# ============================================================================
#  CÀI ĐẶT MỘT CHẠM — 2Anh Zalo Bot
# ============================================================================
#  macOS:  nhấp đúp tệp này (Finder)
#  Linux:  ./install.command   (hoặc  bash install.command)
#
#  Tệp này KHÔNG chứa logic cài đặt: nó kiểm tra môi trường tối thiểu, rồi
#  gọi scripts/setup.sh — nơi có toàn bộ logic. Sửa cách cài thì sửa ở đó.
#
#  Chạy không cần tham số. Muốn tuỳ chọn (--vieneu-tts, --hermes-home …) thì
#  gọi thẳng:  ./scripts/setup.sh --help
# ============================================================================
set -eu

# --- Tự chuyển vào thư mục chứa tệp này -------------------------------------
# Finder chạy tệp với cwd là $HOME, không phải thư mục dự án. Không cd thì mọi
# đường dẫn tương đối đều sai.
SELF="${BASH_SOURCE[0]}"
# Theo symlink (nếu người dùng tạo lối tắt) để tìm đúng thư mục thật.
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  case "$TARGET" in
    /*) SELF="$TARGET" ;;
    *)  SELF="$(dirname "$SELF")/$TARGET" ;;
  esac
done
HERE="$(cd "$(dirname "$SELF")" && pwd)"
cd "$HERE"

SETUP="$HERE/scripts/setup.sh"

printf '\n'
printf '============================================================\n'
printf '  2Anh Zalo Bot — cài đặt\n'
printf '============================================================\n'
printf '  Thư mục: %s\n' "$HERE"

# --- Kiểm tra tối thiểu trước khi giao cho setup.sh ------------------------
if [ ! -f "$SETUP" ]; then
  printf '\n  LỖI: không thấy scripts/setup.sh\n'
  printf '  Tệp này phải nằm ngay trong thư mục dự án (cạnh package.json).\n'
  printf '  Nếu bạn chỉ chép mỗi tệp này ra Desktop thì hãy chép cả thư mục.\n\n'
  printf 'Nhấn Enter để đóng…'
  read -r _ || true
  exit 1
fi

if [ ! -x "$SETUP" ]; then
  chmod +x "$SETUP" 2>/dev/null || true
fi

if ! command -v bash >/dev/null 2>&1; then
  printf '\n  LỖI: không có bash. macOS/Linux luôn có sẵn — kiểm tra PATH.\n\n'
  printf 'Nhấn Enter để đóng…'
  read -r _ || true
  exit 1
fi

# --- Chạy cài đặt -----------------------------------------------------------
printf '\n'
if bash "$SETUP" "$@"; then
  STATUS=0
else
  STATUS=$?
fi

# --- Giữ cửa sổ khi nhấp đúp, để người dùng đọc được thông báo -------------
printf '\n'
if [ "$STATUS" -eq 0 ]; then
  printf '  Xong. Chạy bot bằng: ./scripts/run.sh\n'
else
  printf '  Cài đặt DỪNG với mã lỗi %s — đọc thông báo phía trên.\n' "$STATUS"
fi
printf '\nNhấn Enter để đóng…'
read -r _ || true
exit "$STATUS"
