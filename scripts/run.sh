#!/usr/bin/env bash
# ============================================================================
#  2Anh Zalo Bot — chạy sidecar (macOS Intel/Apple Silicon · Linux x86_64/arm64)
# ============================================================================
#  Dùng:  ./scripts/run.sh [tuỳ chọn] [-- tham số của server.js]
#
#    --background        Chạy nền, ghi log vào logs/sidecar.out, in PID
#    --stop              Dừng tiến trình đang chạy nền
#    --status            Xem tiến trình nền có đang chạy không
#    --dashboard         Chạy dashboard thay vì sidecar
#    --port <số>         Ghi đè ZCA_PORT (cổng sidecar, mặc định 3872)
#    --no-checks         Bỏ qua kiểm tra Node và tệp .env
#    -h | --help         Hiện trợ giúp
#
#  Script này KHÔNG cài đặt gì. Chạy `./scripts/setup.sh` trước.
# ============================================================================
set -eu

# shellcheck source=lib/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MODE='server'
MODE_ARG=''
BACKGROUND=0
DO_STOP=0
DO_STATUS=0
DO_CHECKS=1
PORT_OVERRIDE=''

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
    --background) BACKGROUND=1; shift ;;
    --stop) DO_STOP=1; shift ;;
    --status) DO_STATUS=1; shift ;;
    --dashboard) MODE_ARG='dashboard'; shift ;;
    --port) [ $# -ge 2 ] || die '--port cần một số'; PORT_OVERRIDE="$2"; shift 2 ;;
    --port=*) PORT_OVERRIDE="${1#*=}"; shift ;;
    --no-checks) DO_CHECKS=0; shift ;;
    -h|--help) usage ;;
    --) shift; break ;;
    *) die "Tham số lạ: $1  (xem --help)" ;;
  esac
done

PID_FILE="$(path_join "$REPO_ROOT" 'logs' 'sidecar.pid')"
LOG_FILE="$(path_join "$REPO_ROOT" 'logs' 'sidecar.out')"

# --- Đọc PID còn sống trong pidfile ----------------------------------------
running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  if kill -0 "$pid" 2>/dev/null; then printf '%s' "$pid"; return 0; fi
  return 1
}

# --- Dừng tiến trình nền ---------------------------------------------------
if [ "$DO_STOP" -eq 1 ]; then
  if PID="$(running_pid)"; then
    say "Đang dừng sidecar (PID $PID)…"
    kill "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$PID" 2>/dev/null; then
      warn 'Chưa thoát sau 10 giây — gửi SIGKILL'
      kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    ok 'Đã dừng'
  else
    rm -f "$PID_FILE"
    warn 'Không có tiến trình nền nào đang chạy'
  fi
  exit 0
fi

# --- Xem trạng thái --------------------------------------------------------
if [ "$DO_STATUS" -eq 1 ]; then
  if PID="$(running_pid)"; then
    ok "Đang chạy (PID $PID) — log: $LOG_FILE"
    exit 0
  fi
  warn 'Không chạy'
  exit 1
fi

# --- Kiểm tra trước khi chạy -----------------------------------------------
if [ "$DO_CHECKS" -eq 1 ]; then
  require_node || exit 1
  [ -d "$(path_join "$REPO_ROOT" 'node_modules')" ] \
    || die 'Chưa cài thư viện Node — chạy ./scripts/setup.sh trước.'
  [ -f "$(path_join "$REPO_ROOT" '.env')" ] \
    || die 'Thiếu .env — chạy ./scripts/setup.sh trước (script đó sinh token cho bạn).'
else
  NODE_BIN="$(find_node || true)"
  [ -n "$NODE_BIN" ] || die 'Không tìm thấy Node.js.'
fi

cd "$REPO_ROOT"

# --- Cổng và biến môi trường ----------------------------------------------
if [ -n "$PORT_OVERRIDE" ]; then
  case "$PORT_OVERRIDE" in
    ''|*[!0-9]*) die "--port phải là số: $PORT_OVERRIDE" ;;
  esac
  ZCA_PORT="$PORT_OVERRIDE"
  export ZCA_PORT
  ok "Cổng sidecar: $ZCA_PORT (ghi đè)"
fi

# Hermes nằm ngoài vị trí mặc định: .env của repo có thể đã ghi HERMES_HOME.
if [ -z "${HERMES_HOME:-}" ]; then
  HERMES_FROM_ENV="$(env_get "$(path_join "$REPO_ROOT" '.env')" 'HERMES_HOME')"
  [ -n "$HERMES_FROM_ENV" ] && export HERMES_HOME="$HERMES_FROM_ENV"
fi

if [ "$MODE_ARG" = 'dashboard' ]; then
  ENTRY="$(path_join "$REPO_ROOT" 'dashboard' 'server.js')"
  LABEL='dashboard'
else
  ENTRY="$(path_join "$REPO_ROOT" 'server.js')"
  LABEL='sidecar'
fi

[ -f "$ENTRY" ] || die "Không thấy $ENTRY — mã nguồn chưa đầy đủ."

# --- Chạy nền --------------------------------------------------------------
if [ "$BACKGROUND" -eq 1 ]; then
  if PID="$(running_pid)"; then
    die "Đã có $LABEL đang chạy (PID $PID). Dừng bằng --stop trước."
  fi
  ensure_dir "$(dirname "$LOG_FILE")"
  # setsid nếu có (Linux) để tiến trình không chết theo terminal; macOS dùng & trực tiếp.
  if have setsid; then
    setsid "$NODE_BIN" "$ENTRY" "$@" >>"$LOG_FILE" 2>&1 &
  else
    nohup "$NODE_BIN" "$ENTRY" "$@" >>"$LOG_FILE" 2>&1 &
  fi
  NEW_PID=$!
  printf '%s\n' "$NEW_PID" > "$PID_FILE"
  sleep 1
  if kill -0 "$NEW_PID" 2>/dev/null; then
    ok "$LABEL chạy nền (PID $NEW_PID)"
    say "  Log: $LOG_FILE"
    say "  Dừng: ./scripts/run.sh --stop"
    say ''
    say '  Dashboard: http://127.0.0.1:3880'
  else
    bad "$LABEL thoát ngay sau khi khởi động. 20 dòng cuối của log:"
    tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/    /' || true
    rm -f "$PID_FILE"
    exit 1
  fi
  exit 0
fi

# --- Chạy tiền cảnh --------------------------------------------------------
say "Chạy ${LABEL}…  (Ctrl+C để dừng)"
say "Dashboard: http://127.0.0.1:3880"
say ''
exec "$NODE_BIN" "$ENTRY" "$@"
