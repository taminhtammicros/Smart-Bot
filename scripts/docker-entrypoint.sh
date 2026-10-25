#!/bin/sh
# ============================================================================
#  Entrypoint của image — chạy CẢ HAI tiến trình như bản native:
#    • node server.js            sidecar (cầu nối Zalo, cổng ZCA_PORT=3872)
#    • node dashboard/server.js  dashboard quản trị (cổng 3880)
#
#  Vì sao cần cả hai: sidecar mở cổng 3872 nhưng gốc "/" chỉ trả 302 sang
#  dashboard. Người dùng mở dashboard để quét QR và quản trị — thiếu nó thì
#  container "healthy" mà không dùng được gì.
#
#  Không dùng supervisord: chỉ hai tiến trình, và `wait -n` của POSIX sh (busybox
#  của Debian slim) chưa đủ tin cậy. Dùng vòng poll + trap là đủ, không thêm
#  ~30 MB Python chỉ để giám sát hai process.
#
#  Nếu một tiến trình chết, dừng cả hai và thoát khác 0 để Docker restart
#  (`restart: unless-stopped`) hoặc báo lỗi — KHÔNG để nửa vời.
# ============================================================================
set -eu

SIDECAR_PID=''
DASH_PID=''

# Chuyển tiếp SIGTERM/SIGINT tới cả hai tiến trình con, rồi thoát.
shutdown() {
  trap - TERM INT
  printf '[entrypoint] đang dừng…\n'
  [ -n "$DASH_PID" ] && kill -TERM "$DASH_PID" 2>/dev/null || true
  [ -n "$SIDECAR_PID" ] && kill -TERM "$SIDECAR_PID" 2>/dev/null || true
  # Cho tối đa 10 giây để đóng sạch (SQLite WAL cần thời gian checkpoint).
  i=0
  while [ "$i" -lt 20 ]; do
    alive=0
    [ -n "$DASH_PID" ] && kill -0 "$DASH_PID" 2>/dev/null && alive=1
    [ -n "$SIDECAR_PID" ] && kill -0 "$SIDECAR_PID" 2>/dev/null && alive=1
    [ "$alive" -eq 0 ] && break
    sleep 0.5
    i=$((i + 1))
  done
  [ -n "$DASH_PID" ] && kill -KILL "$DASH_PID" 2>/dev/null || true
  [ -n "$SIDECAR_PID" ] && kill -KILL "$SIDECAR_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

cd /app

# Bật/tắt từng phần bằng biến môi trường — mặc định bật cả hai.
RUN_SIDECAR="${ZALO_RUN_SIDECAR:-1}"
RUN_DASHBOARD="${ZALO_RUN_DASHBOARD:-1}"

if [ "$RUN_SIDECAR" = '1' ]; then
  node server.js &
  SIDECAR_PID=$!
  printf '[entrypoint] sidecar pid=%s cổng=%s\n' "$SIDECAR_PID" "${ZCA_PORT:-3872}"
fi

# Chờ sidecar mở cổng trước khi khởi động dashboard: dashboard đọc .env và gọi
# /control của sidecar lúc khởi động; sidecar chưa lên thì nó báo lỗi kết nối
# (vẫn tự thử lại, nhưng log sẽ ồn và lần đo sức khoẻ đầu tiên là rác).
if [ "$RUN_DASHBOARD" = '1' ] && [ "$RUN_SIDECAR" = '1' ]; then
  node -e '
    const port = process.env.ZCA_PORT || 3872;
    const deadline = Date.now() + 30000;
    const tick = () => {
      fetch(`http://127.0.0.1:${port}/api/status`)
        .then(() => process.exit(0))
        .catch(() => (Date.now() > deadline ? process.exit(1) : setTimeout(tick, 300)));
    };
    tick();
  ' || printf '[entrypoint] sidecar chưa sẵn sàng sau 30s — vẫn khởi động dashboard\n'
fi

if [ "$RUN_DASHBOARD" = '1' ]; then
  node dashboard/server.js &
  DASH_PID=$!
  printf '[entrypoint] dashboard pid=%s\n' "$DASH_PID"
fi

if [ -z "$SIDECAR_PID" ] && [ -z "$DASH_PID" ]; then
  printf '[entrypoint] LỖI: cả ZALO_RUN_SIDECAR và ZALO_RUN_DASHBOARD đều tắt — không có gì để chạy\n'
  exit 1
fi

# Giám sát: tiến trình nào chết trước thì dừng tất cả và thoát khác 0.
while :; do
  if [ -n "$SIDECAR_PID" ] && ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    printf '[entrypoint] sidecar đã thoát — dừng toàn bộ\n'
    shutdown
    exit 1
  fi
  if [ -n "$DASH_PID" ] && ! kill -0 "$DASH_PID" 2>/dev/null; then
    printf '[entrypoint] dashboard đã thoát — dừng toàn bộ\n'
    shutdown
    exit 1
  fi
  sleep 2
done
