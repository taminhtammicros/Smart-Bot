# syntax=docker/dockerfile:1.7
# ============================================================================
#  2Anh Zalo Bot — image đa kiến trúc (linux/amd64 + linux/arm64)
# ============================================================================
#  Build từ máy macOS Intel:
#    docker buildx create --name zalo-builder --driver docker-container --use
#    docker buildx build \
#      --platform linux/amd64,linux/arm64 \
#      -t 2anh/zalo-bot:2.54.0 \
#      --push .
#
#  Build riêng cho máy đang đứng (nạp vào docker local, không --push):
#    docker buildx build --platform linux/amd64 -t 2anh/zalo-bot:latest --load .
#
#  Vì sao Debian slim chứ không Alpine: `node:22-alpine` dùng musl, và nhiều
#  wheel Python của pymupdf/pdf2docx/pillow-jxl chỉ có bản manylinux (glibc).
#  Trên Alpine phải biên dịch từ mã nguồn (thêm ~500 MB toolchain và dễ hỏng),
#  trong khi slim-bookworm có sẵn wheel cho cả amd64 lẫn arm64.
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — cài thư viện Node (chỉ production dependencies)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS node-deps

WORKDIR /app

# Chỉ chép manifest trước: layer này chỉ mất cache khi package*.json đổi.
COPY package.json package-lock.json ./
# `npm ci` cài đúng theo lockfile và bỏ qua devDependencies nhờ NODE_ENV.
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2 — cài thư viện Python của plugin vào một thư mục riêng
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS py-deps

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1
# build-essential chỉ cần khi một wheel không có sẵn cho kiến trúc đích;
# gỡ ngay trong cùng layer để không mang theo vào image cuối.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
# Cài vào `/opt/pylibs` bằng `--target`, KHÔNG dùng venv: venv chứa symlink
# tuyệt đối tới `/usr/local/bin/python` của base image này. Khi chép sang
# stage runtime (image khác), symlink trỏ vào chỗ không tồn tại và mọi lệnh
# python trong venv chết với "No such file or directory". `--target` chỉ sinh
# thư mục thuần, chép đi đâu cũng chạy, miễn cùng phiên bản Python (3.12).
RUN mkdir -p /opt/pylibs \
 && pip install --target /opt/pylibs -r /tmp/requirements.txt

# ---------------------------------------------------------------------------
# Stage 3 — image chạy
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# `tini` làm PID 1 để SIGTERM từ `docker stop` tới được Node, không để tiến
# trình thành zombie khi bot khởi động lại tiến trình con.
# `ca-certificates` cho HTTPS ra cổng AI; `tini` nhỏ (~20 KB).
# `python3` của Debian bookworm là 3.11, nhưng wheel ở stage 2 dựng cho 3.12
# (image `python:3.12-slim-bookworm`). Trộn hai bản thì extension native chết
# với `undefined symbol: _PyObject_VisitManagedDict` — lxml/docx đều hỏng.
# Nên chép nguyên `/usr/local` của stage 2 (CPython 3.12 + stdlib đã biên dịch
# sẵn) và trỏ PATH vào đó, thay vì dùng python3 của Debian.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin zalo

COPY --from=py-deps /usr/local /usr/local

# `ZCA_HOST`/`ZALO_DASHBOARD_HOST` = 0.0.0.0 vì trong container phải nghe mọi
# interface mới nhận được từ ngoài. compose chỉ publish ra 127.0.0.1 của máy
# chủ, nên cổng vẫn không lộ ra mạng LAN.
# `PYTHONPATH` để `python3` thấy thư viện đã cài ở stage 2.
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Ho_Chi_Minh \
    HERMES_HOME=/hermes \
    ZCA_PORT=3872 \
    ZALO_BRIDGE_PORT=3873 \
    ZCA_HOST=0.0.0.0 \
    ZALO_DASHBOARD_HOST=0.0.0.0 \
    ZALO_BRIDGE_HOST=0.0.0.0 \
    PYTHONPATH=/opt/pylibs

WORKDIR /app

# Thư viện từ hai stage trước — chép nguyên trạng, không cài lại.
COPY --from=node-deps /app/node_modules ./node_modules
COPY --from=py-deps /opt/pylibs /opt/pylibs

# Mã nguồn. Thứ tự: manifest trước, mã sau, để layer cache còn dùng được.
# `COPY *.js` lấy toàn bộ mô-đun ở gốc — liệt kê tay từng tệp thì thêm mô-đun
# mới là image thiếu ngay mà build vẫn "thành công" (chỉ hỏng lúc chạy).
# Tệp *.test.js đã bị .dockerignore loại bỏ.
COPY package.json package-lock.json ./
COPY *.js ./
COPY dashboard ./dashboard
COPY hermes-plugin ./hermes-plugin
COPY tts ./tts
COPY scripts ./scripts

# Thư mục dữ liệu: bind mount hoặc named volume gắn vào đây.
# Quyền cho user 10001 trước khi VOLUME biến nó thành mount point.
RUN mkdir -p /app/data /app/logs /hermes \
 && chown -R zalo:zalo /app /hermes

VOLUME ["/app/data", "/app/logs", "/hermes"]

USER zalo

# 3872 = sidecar (API điều khiển), 3873 = cầu nối WebSocket cho plugin Hermes,
# 3880 = dashboard quản trị (thứ người dùng thật sự mở trong trình duyệt).
EXPOSE 3872 3873 3880

# Healthcheck kiểm CẢ HAI: sidecar phải trả /api/health, dashboard phải trả
# trang chủ. Chỉ kiểm sidecar thì container báo "healthy" dù dashboard đã chết
# — đúng lỗi đã gặp khi đóng gói.
HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
  CMD node -e "const g=(u)=>fetch(u,{redirect:'manual'}).then(r=>r.status<400).catch(()=>false);Promise.all([g('http://127.0.0.1:'+(process.env.ZCA_PORT||3872)+'/api/health'),g('http://127.0.0.1:3880/')]).then(([a,b])=>process.exit(a&&b?0:1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Chạy CẢ sidecar và dashboard (xem scripts/docker-entrypoint.sh). Chỉ chạy
# sidecar thì container "healthy" nhưng mở dashboard lại nhận 302 trỏ về cổng
# không tồn tại — không quét được QR, không quản trị được.
CMD ["/app/scripts/docker-entrypoint.sh"]
