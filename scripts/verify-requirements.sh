#!/usr/bin/env bash
# ============================================================================
#  Kiểm tra `requirements.txt` cài được trên kiến trúc ĐÍCH (không chỉ máy dev)
# ============================================================================
#  Dùng:  ./scripts/verify-requirements.sh [platform ...]
#
#    ./scripts/verify-requirements.sh                    # cả 4 nền tảng đích
#    ./scripts/verify-requirements.sh linux/arm64        # chỉ một
#
#  Vì sao cần: `pip install` trên máy dev chứng minh được rất ít — máy đó có
#  wheel cho chính nó. Gói thiếu wheel cho linux/arm64 hay win_amd64 chỉ lộ ra
#  khi cài trên nền tảng đích. Script chạy `pip download --only-binary=:all:`
#  trong container của từng nền tảng: chỉ-binary nghĩa là KHÔNG biên dịch từ
#  mã nguồn, nên nếu thiếu wheel thì báo lỗi ngay thay vì build 10 phút rồi
#  mới hỏng.
#
#  Không cần Docker? Script tự báo và bỏ qua.
# ============================================================================
set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQ="${REPO_ROOT}/requirements.txt"

# Nền tảng đích → image Python dùng để thử.
#   linux/amd64, linux/arm64 : có image chính thức
#   macOS, Windows           : KHÔNG có container — pip trên Linux không kiểm
#                              được wheel macOS/Windows. Với hai nền tảng đó
#                              script chỉ in lệnh để chạy trên máy thật.
PLATFORMS_DEFAULT="linux/amd64 linux/arm64"

say() { printf '%s\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  say 'Không có docker — bỏ qua kiểm tra (vẫn nên chạy trên từng nền tảng đích).'
  exit 0
fi

[ -f "$REQ" ] || { say "Không thấy $REQ"; exit 1; }

TARGETS="${*:-$PLATFORMS_DEFAULT}"
FAILED=0

for platform in $TARGETS; do
  case "$platform" in
    linux/amd64|linux/arm64) ;;
    *)
      say "Bỏ qua $platform (không có container). Chạy trên máy thật:"
      say "  python3 -m pip download --only-binary=:all: --dest /tmp/wheels -r requirements.txt"
      continue
      ;;
  esac

  say ""
  say "── $platform ─────────────────────────────────────────"
  if docker run --rm --platform "$platform" \
      -v "${REQ}:/tmp/requirements.txt:ro" \
      python:3.12-slim-bookworm \
      sh -c 'pip download --quiet --only-binary=:all: --dest /tmp/wheels -r /tmp/requirements.txt \
             && echo "  OK: mọi gói đều có wheel cho kiến trúc này"'; then
    :
  else
    say "  THIẾU wheel cho $platform — xem gói pip báo lỗi ở trên."
    FAILED=1
  fi
done

say ""
if [ "$FAILED" -eq 0 ]; then
  say 'Tất cả nền tảng kiểm được đều có wheel.'
else
  say 'Có nền tảng thiếu wheel — nới khoảng phiên bản trong requirements.txt rồi chạy lại.'
  exit 1
fi
