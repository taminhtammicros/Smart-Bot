#!/usr/bin/env bash
# ============================================================================
#  Thư viện dùng chung cho scripts/setup.sh và scripts/run.sh
#  macOS (Intel x86_64 + Apple Silicon arm64) và Linux (x86_64 / arm64)
# ============================================================================
#  Nguyên tắc:
#    • Chỉ dùng bash 3.2 (bản mặc định của macOS) — không dùng mảng kết hợp,
#      không `readarray`, không `${var^^}`.
#    • Mọi đường dẫn ghép bằng một hàm `path_join`, không viết "a/b" trong code.
#    • Không gán cứng /usr/local hay /opt/homebrew: dò bằng `command -v`.
# ============================================================================

# --- Đường dẫn gốc (script này nằm ở <repo>/scripts/lib/) -------------------
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${LIB_DIR}/../.." && pwd)"
export REPO_ROOT

# --- Màu: chỉ bật khi stdout là terminal thật -------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_BAD=''; C_WARN=''; C_DIM=''; C_OFF=''
fi

say()   { printf '%s\n' "$*"; }
ok()    { printf '  %sOK   %s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn()  { printf '  %sLƯU Ý%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
bad()   { printf '  %sLỖI  %s %s\n' "$C_BAD" "$C_OFF" "$*" >&2; }
step()  { printf '\n%s▸ %s%s\n' "$C_DIM" "$*" "$C_OFF"; }
die()   { bad "$*"; exit 1; }

# --- Ghép đường dẫn không phụ thuộc dấu phân cách của HĐH -------------------
# Bash luôn dùng '/', kể cả trên macOS/Linux; hàm này giữ một chỗ duy nhất để
# đổi nếu sau này có ai port sang môi trường khác.
path_join() {
  local out='' part
  for part in "$@"; do
    case "$part" in
      '') continue ;;
    esac
    if [ -z "$out" ]; then out="$part"
    elif [ "${out%/}" = "$out" ]; then out="${out}/${part}"
    else out="${out}${part}"; fi
  done
  printf '%s' "$out"
}

# --- Thông tin nền tảng -----------------------------------------------------
os_name() {
  case "$(uname -s)" in
    Darwin) printf 'macos' ;;
    Linux)  printf 'linux' ;;
    *)      printf 'unknown' ;;
  esac
}

cpu_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) uname -m ;;
  esac
}

is_macos() { [ "$(os_name)" = 'macos' ]; }
is_linux() { [ "$(os_name)" = 'linux' ]; }

# --- Dò lệnh: `command -v` thắng mọi đường dẫn gán cứng --------------------
have() { command -v "$1" >/dev/null 2>&1; }

# --- Node: bản trong PATH, hoặc bản của nvm/asdf/volta/fnm ------------------
# Trả về đường dẫn `node` dùng được, rỗng nếu không có.
find_node() {
  if have node; then command -v node; return 0; fi
  local candidate
  for candidate in \
    "${HOME}/.nvm/versions/node"/*/bin/node \
    "${HOME}/.volta/bin/node" \
    "${HOME}/.asdf/shims/node" \
    "${HOME}/.local/share/fnm/node-versions"/*/installation/bin/node \
    '/usr/local/bin/node' \
    '/opt/homebrew/bin/node'; do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

# --- Node >= 22.5 (cần node:sqlite) ----------------------------------------
node_major_minor() {
  "$1" -p 'process.versions.node.split(".").slice(0,2).join(".")' 2>/dev/null || printf '0.0'
}

node_version_ok() {
  local v major minor
  v="$(node_major_minor "$1")"
  major="${v%%.*}"
  minor="${v#*.}"
  [ "$major" -gt 22 ] 2>/dev/null && return 0
  [ "$major" -eq 22 ] 2>/dev/null && [ "$minor" -ge 5 ] 2>/dev/null
}

# --- Python 3 (dùng cho môi trường kiểm thử plugin, không phải Hermes) ------
find_python() {
  local candidate
  for candidate in python3 python; do
    if have "$candidate"; then command -v "$candidate"; return 0; fi
  done
  return 1
}

python_ok() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

# --- Cài Node gợi ý cho người dùng -----------------------------------------
node_install_hint() {
  if is_macos; then
    if have brew; then
      printf 'brew install node@22'
    else
      printf 'tải bản .pkg tại https://nodejs.org/en/download (chọn macOS %s)' \
        "$([ "$(cpu_arch)" = 'arm64' ] && printf 'Apple Silicon' || printf 'Intel')"
    fi
  elif is_linux; then
    printf 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs'
  else
    printf 'cài Node 22 từ https://nodejs.org/en/download'
  fi
}

# --- Kiểm tra Node bắt buộc, in hướng dẫn nếu thiếu ------------------------
require_node() {
  NODE_BIN="$(find_node || true)"
  if [ -z "$NODE_BIN" ]; then
    bad 'Chưa có Node.js.'
    say "  → $(node_install_hint)"
    return 1
  fi
  if ! node_version_ok "$NODE_BIN"; then
    bad "Node.js quá cũ: $("$NODE_BIN" -v) — cần >= 22.5 (dự án dùng node:sqlite)."
    say "  → $(node_install_hint)"
    return 1
  fi
  export NODE_BIN
  ok "Node $("$NODE_BIN" -v)  ($NODE_BIN)"
}

# --- npm đi kèm Node, không cần dò riêng -----------------------------------
# Tham số tuỳ chọn: đường dẫn `node` muốn lấy npm cạnh nó. Không truyền thì
# dùng $NODE_BIN (do require_node đặt). Phải có `:-` vì script chạy `set -u`.
NPM_BIN=''
resolve_npm() {
  local node_bin="${1:-${NODE_BIN:-}}" dir
  if [ -n "$node_bin" ]; then
    dir="$(dirname "$node_bin")"
    if [ -x "$(path_join "$dir" 'npm')" ]; then NPM_BIN="$(path_join "$dir" 'npm')"; return 0; fi
  fi
  if have npm; then NPM_BIN="$(command -v npm)"; return 0; fi
  return 1
}

# --- Thư mục môi trường ảo Python cục bộ (gitignored) ----------------------
venv_dir() { path_join "$REPO_ROOT" '.venv'; }

venv_python() {
  if [ -x "$(path_join "$(venv_dir)" 'bin/python3')" ]; then
    printf '%s' "$(path_join "$(venv_dir)" 'bin/python3')"
  elif [ -x "$(path_join "$(venv_dir)" 'bin/python')" ]; then
    printf '%s' "$(path_join "$(venv_dir)" 'bin/python')"
  else
    printf ''
  fi
}

# --- Tiện ích -----------------------------------------------------------------
ensure_dir() { [ -d "$1" ] || mkdir -p "$1"; }

# Đọc một khoá từ tệp .env (không nạp cả tệp vào môi trường shell).
env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  # Bỏ CRLF của Windows để file .env chép từ máy khác vẫn đọc được.
  tr -d '\r' < "$file" | sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" | tail -n 1
}

# Ghi/đè một khoá trong .env, giữ nguyên mọi dòng khác.
# Bỏ CRLF khi đọc để file .env chép từ Windows không sinh dòng "ZALO_...=\r"
# (Node cắt \r nhưng plugin Python thì không, và giá trị mang \r sẽ làm sai
# token xác thực bridge). Kết quả luôn là LF thuần.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  ensure_dir "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  tmp="${file}.tmp.$$"
  tr -d '\r' < "$file" | awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*" k "[[:space:]]*=" { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' > "$tmp" && mv "$tmp" "$file"
}
