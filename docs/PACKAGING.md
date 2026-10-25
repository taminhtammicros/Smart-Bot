# Đóng gói & phân phối 2Anh Zalo Bot

Tài liệu này dành cho **người phát hành bản build**. Người dùng cuối chỉ cần đọc
[`README-INSTALL.md`](../README-INSTALL.md).

Phạm vi hỗ trợ:

| Nền tảng | Kiến trúc | Native | Docker |
|---|---|---|---|
| macOS | x86_64 (Intel) | ✅ | ✅ (chạy image linux/amd64) |
| macOS | ARM64 (Apple Silicon) | ✅ | ✅ (chạy image linux/arm64) |
| Linux | x86_64 / amd64 | ✅ | ✅ |
| Linux | ARM64 | ✅ | ✅ |
| Windows 10/11 | x86_64 | ✅ | ⚠️ qua WSL2 |

---

## 1. Manifest phụ thuộc

Ba tệp, ba mục đích khác nhau — **không thay thế nhau**:

| Tệp | Dùng cho | Ai đọc |
|---|---|---|
| `package.json` + `package-lock.json` | Thư viện Node của sidecar + dashboard | `npm ci`, Dockerfile |
| `requirements.txt` | Thư viện Python của plugin (zalo, zalo_tools, zalo_memory) | Dockerfile, `.venv` để chạy test |
| `hermes-plugin/zalo/plugin.yaml` → `python_dependencies` | Nguồn **chân lý** cho môi trường Hermes | `hermes pm install` |

### Vì sao không ghim phiên bản Python

`requirements.txt` dùng khoảng (`>=x,<y`) chứ không ghim (`==x.y.z`). Lý do:
một bản ghim cứng thường chỉ có wheel cho một nền tảng. Ví dụ `pymupdf==1.24.1`
phát hành wheel `cp312-manylinux_x86_64`, `cp312-macosx_11_0_arm64`,
`cp312-win_amd64` — nhưng không phải **mọi** phiên bản đều có đủ cả bốn.
Khoảng phiên bản để `pip` chọn bản mới nhất **có wheel khớp OS + kiến trúc
đang chạy**, nên cùng một tệp cài được trên cả Intel, Apple Silicon, Linux và
Windows.

Muốn tái lập chính xác tuyệt đối cho CI thì sinh lockfile riêng cho từng
nền tảng, đừng ghim vào `requirements.txt` dùng chung:

```bash
# Trên máy Linux x86_64
python -m pip freeze > requirements.lock.linux-x86_64.txt
# Trên máy macOS arm64
python -m pip freeze > requirements.lock.macos-arm64.txt
```

### Kiểm tra không có gói chỉ dành cho một OS

```bash
# Liệt kê mọi import bên thứ ba trong plugin
grep -rhoE '^\s*(import|from) [a-zA-Z_0-9]+' hermes-plugin --include=*.py \
  | sed -E 's/^\s*(import|from) //' | sort -u \
  | comm -23 - <(python3 -c 'import sys; print("\n".join(sorted(sys.stdlib_module_names)))')
```

Kết quả phải là tập con của `requirements.txt` + `plugin.yaml`.

---

## 2. Đường dẫn trong mã nguồn

Đã rà toàn bộ `*.js` / `*.py`:

* **Node**: mọi đường dẫn dựng bằng `node:path` (`join`, `resolve`, `dirname`).
  Không có chuỗi `'a/b'` nào được dùng để mở tệp.
* **Python**: mọi đường dẫn dùng `pathlib.Path` hoặc `os.path`.
* **Ngoại lệ có chủ đích** (không phải lỗi):

| Vị trí | Nội dung | Vì sao giữ |
|---|---|---|
| `owner-commands.js:463` | `/usr/local/bin/hermes`, `/opt/homebrew/bin/hermes` | Danh sách **ứng viên** dò binary, có `join(homedir(), '.local', 'bin', 'hermes')` đứng trước; Windows dùng nhánh riêng |
| `scripts/hermes-install-lib.js:80` | `/opt/hermes/hermes-agent` | Đường dẫn cài chuẩn của Hermes trên Linux; có kiểm `hostPlatform === 'win32'` trước |
| `dashboard/lib/hermes-admin.js:42,47` | `/opt/hermes/hermes-agent` | Cùng lý do |
| `scripts/dashboard-service.js:9` | `/etc/systemd/system` | Chỉ chạy trên Linux (`systemctl`) |

Không có chỗ nào nối chuỗi bằng `'/'` hay `'\\'` để tạo đường dẫn tệp.

---

## 3. Docker

### 3.1 Build cho nhiều kiến trúc từ máy macOS Intel

Máy Intel build được image `linux/arm64` nhờ QEMU mà Docker Desktop cài sẵn.

```bash
# Một lần duy nhất: tạo builder hỗ trợ đa kiến trúc
docker buildx create --name zalo-builder --driver docker-container --use
docker buildx inspect --bootstrap

# Build + đẩy lên registry (cách phân phối khuyến nghị)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t 2anh/zalo-bot:2.54.0 \
  -t 2anh/zalo-bot:latest \
  --push .
```

Kiểm tra image đã có đủ hai kiến trúc:

```bash
docker buildx imagetools inspect 2anh/zalo-bot:2.54.0
```

### 3.2 Build chỉ để chạy thử trên máy này

```bash
docker buildx build --platform linux/amd64 -t 2anh/zalo-bot:dev --load .
docker run --rm -p 3880:3880 -p 3873:3873 \
  -v "$(pwd)/data:/app/data" -v "$(pwd)/logs:/app/logs" \
  -e HERMES_HOME=/hermes -v zalo-hermes:/hermes \
  2anh/zalo-bot:dev
```

### 3.3 Build trên Apple Silicon cho máy Intel

```bash
docker buildx build --platform linux/amd64 -t 2anh/zalo-bot:dev-amd64 --load .
```

> Build `arm64` trên máy Intel chạy qua QEMU nên **chậm** (5–15 phút cho lần
> đầu, do phải biên dịch wheel Python). Build `amd64` thì native, nhanh.

### 3.4 Vì sao Debian slim chứ không Alpine

`node:22-alpine` dùng musl libc. Nhiều wheel Python của `pymupdf`,
`pdf2docx`, `pillow-jxl-plugin`, `lxml` chỉ phát hành bản `manylinux` (glibc).
Trên Alpine, `pip` phải biên dịch từ mã nguồn: cần `build-essential` +
`mupdf-dev` + `libxml2-dev`…, image phình thêm ~500 MB và dễ hỏng khi upstream
đổi bản. `bookworm-slim` có wheel sẵn cho **cả** `linux/amd64` và
`linux/arm64`, nên image gọn và build ổn định hơn.

### 3.5 Dữ liệu bền

Ba named volume trong `docker-compose.yml`:

| Volume | Nội dung | Ghi chú |
|---|---|---|
| `zalo-data` | `data/zalo.sqlite`, session Zalo, kho tri thức | **Bắt buộc** là volume, không bind mount |
| `zalo-logs` | `logs/*.out`, `*.log` | |
| `hermes-home` | `config.yaml`, `.env`, plugin của Hermes | |

Trên macOS, bind mount chạy qua VirtioFS; SQLite ở chế độ WAL trên VirtioFS
chậm và có thể hỏng khoá. Dùng named volume để tránh.

### 3.6 Container chạy HAI tiến trình

Bản native chạy `node server.js` (sidecar) và `node dashboard/server.js` (dashboard)
là hai tiến trình riêng. Image cũng vậy — `scripts/docker-entrypoint.sh` khởi động
cả hai và giám sát lẫn nhau:

| Tiến trình | Cổng | Vai trò |
|---|---|---|
| `node server.js` | 3872 (+3873 WebSocket) | Cầu nối Zalo, API điều khiển |
| `node dashboard/server.js` | 3880 | Giao diện quản trị — **thứ người dùng mở** |

Chỉ chạy sidecar thì container vẫn `healthy` nhưng mở cổng publish chỉ nhận
`302 → http://127.0.0.1:3880/#/zalo` trỏ vào hư không. Vì thế healthcheck kiểm
**cả hai**. Tắt một phần khi cần:

```bash
docker run -e ZALO_RUN_DASHBOARD=0 ...   # chỉ sidecar (Hermes headless)
docker run -e ZALO_RUN_SIDECAR=0 ...     # chỉ dashboard (xem giao diện)
```

### 3.7 Chạy song song với bản native

Máy đã có bản native giữ 3880/3872/3873 thì Docker không bind được cùng cổng.
Dùng override có sẵn:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

| | Native | Docker (override) |
|---|---|---|
| Dashboard | `127.0.0.1:3880` | `127.0.0.1:3881` |
| Sidecar | `127.0.0.1:3872` | (không publish) |
| Bridge | `127.0.0.1:3873` | `127.0.0.1:3882` |
| Dữ liệu | `LOCAL-REPO/data/` | volume `zalo-local-data` |

> ⚠️ Hai bản cùng đăng nhập **một** tài khoản Zalo là rủi ro thật: Zalo chỉ cho
> một phiên, bản sau đăng nhập sẽ đẩy bản trước ra. Dùng để xem giao diện thì
> ổn; đừng quét QR khi bản native vẫn đang chạy tài khoản đó.

Ba lưu ý của `docker-compose.local.yml`:

1. `ports: !override` và `volumes: !override` là **bắt buộc** — mặc định compose
   **gộp** danh sách, nên cổng 3880 của tệp gốc vẫn còn và đụng bản native.
2. `ZALO_ALLOWED_HOSTS` phải khớp cổng publish, nếu không mọi request trả
   *"Host không hợp lệ"*.
3. `ZALO_DASHBOARD_URL` phải khớp cổng publish, nếu không dashboard redirect
   người dùng sang cổng của bản native.

### 3.8 Bảy cái bẫy đã gặp khi đóng gói (đừng vấp lại)

| Triệu chứng | Nguyên nhân | Cách xử lý trong Dockerfile/compose |
|---|---|---|
| `python3` không có trong image | Runtime `node:22-bookworm-slim` không kèm Python | `COPY --from=py-deps /usr/local /usr/local` |
| `ImportError: undefined symbol: _PyObject_VisitManagedDict` khi `import lxml.etree` | `python3` của Debian bookworm là **3.11**, wheel cài ở stage 2 là **3.12** → sai ABI | Chép nguyên CPython 3.12 từ `py-deps`, KHÔNG `apt install python3` |
| `No such file or directory` khi gọi `/opt/venv/bin/python` | venv chứa symlink **tuyệt đối** tới `/usr/local/bin/python` của stage trước; chép sang stage khác là symlink chết | Dùng `pip install --target /opt/pylibs` + `PYTHONPATH`, không dùng venv |
| `{"error":"Host không hợp lệ"}` khi mở cổng đã publish | Guard chống DNS-rebinding của sidecar chỉ nhận Host là loopback **đúng cổng nội bộ** (3872); trình duyệt gửi `127.0.0.1:3880` | Đặt `ZALO_ALLOWED_HOSTS` trong compose khớp với `ports:` |
| Request treo/timeout từ host, log container vẫn ghi | Sidecar bind `127.0.0.1` bên trong container → không nhận từ ngoài | `ZCA_HOST=0.0.0.0` + `ZALO_DASHBOARD_HOST=0.0.0.0` (image đã đặt sẵn) |
| Image thiếu mô-đun Node khi thêm file mới ở gốc | `COPY server.js control-api.js …` liệt kê tay | `COPY *.js ./` — thêm file mới tự động vào image |
| Container `healthy` nhưng mở cổng chỉ thấy `302` | Chỉ chạy sidecar; dashboard là tiến trình thứ hai | `scripts/docker-entrypoint.sh` chạy cả hai + healthcheck kiểm cả hai |
| Port native và Docker tranh nhau | `ports:` của hai tệp compose bị **gộp**, không thay thế | `ports: !override` trong tệp override |

Kiểm tra nhanh sau khi build:

```bash
docker run --rm 2anh/zalo-bot:latest python3 -c \
  "import websockets,docx,pptx,openpyxl,fpdf,pymupdf,pdf2docx,lxml.etree,requests,httpx,yaml,psutil,PIL;print('libs OK')"
```

---

## 4. Kịch bản native

| Nền tảng | Cài | Chạy |
|---|---|---|
| macOS / Linux | `./scripts/setup.sh` | `./scripts/run.sh` |
| Windows | `scripts\setup.bat` | `scripts\run.bat` |

Cả hai gọi chung `scripts/native/check-runtime.js` để kiểm tra máy đích — một
chỗ duy nhất, không lệch logic giữa ba HĐH.

### Tuỳ chọn

| `setup.sh` | `setup.ps1` | Ý nghĩa |
|---|---|---|
| `--hermes-home <p>` | `-HermesHome <p>` | Hermes ở vị trí không mặc định |
| `--vieneu-tts` | `-VieneuTts` | Bật giọng Việt offline (tải ~282 MB) |
| `--no-dashboard` | `-NoDashboard` | Không cài dịch vụ dashboard |
| `--skip-python` | `-SkipPython` | Bỏ kiểm tra thư viện Python của Hermes |
| `--venv` | `-Venv` | Dựng `.venv` cục bộ để chạy `npm run test:py` |
| `--offline` | `-Offline` | Không gọi mạng, dùng gói đã có |

| `run.sh` | `run.ps1` | Ý nghĩa |
|---|---|---|
| `--background` | `-Background` | Chạy nền, ghi `logs/sidecar.out` |
| `--stop` | `-Stop` | Dừng tiến trình nền |
| `--status` | `-Status` | Xem tiến trình nền |
| `--dashboard` | `-Dashboard` | Chạy dashboard thay vì sidecar |
| `--port <n>` | `-Port <n>` | Ghi đè `ZCA_PORT` |
| `--no-checks` | `-NoChecks` | Bỏ kiểm tra trước khi chạy |

### Tương thích bash

`scripts/lib/common.sh` chỉ dùng cú pháp **bash 3.2** (bản macOS mặc định):
không mảng kết hợp, không `readarray`, không `${var^^}`. Đã kiểm bằng `bash -n`
và chạy thật trên macOS 15 / bash 3.2.

---

## 5. Kiểm chứng trước khi phát hành

```bash
# 1. Cú pháp shell
bash -n scripts/lib/common.sh scripts/setup.sh scripts/run.sh

# 2. Cú pháp JS
node --check server.js
for f in $(git ls-files '*.js'); do node --check "$f" || echo "FAIL $f"; done

# 3. Test
npm run test:js
npm run test:py          # cần .venv (./scripts/setup.sh --venv)

# 4. Compose hợp lệ
docker compose -f docker-compose.yml config >/dev/null
docker compose -f docker-compose.dev.yml config >/dev/null

# 5. Image chạy được, CẢ dashboard lẫn sidecar
docker buildx build --platform linux/amd64 -t zalo:test --load .
docker run -d --name zalo-test -p 3880:3880 zalo:test
sleep 25
curl -fsS -o /dev/null http://127.0.0.1:3880/            && echo "dashboard OK"
curl -fsS http://127.0.0.1:3880/api/health | head -c 60  && echo " sidecar OK"
docker rm -f zalo-test

# 6. Manifest Python cài được trên kiến trúc đích
docker run --rm --platform linux/arm64 \
  -v "$(pwd)/requirements.txt:/tmp/r.txt:ro" python:3.12-slim-bookworm \
  sh -c 'pip install --dry-run -r /tmp/r.txt | tail -5'
```

---

## 6. Những gì **không** đóng gói

* **Hermes Agent** — là dự án riêng, người dùng cài theo README của nó. Sidecar
  không có bộ não dự phòng; thiếu Hermes thì bot không trả lời.
* **Model AI** — gọi qua cổng `model.base_url` trong `config.yaml`.
* **VieNeu TTS** — tải model ở lần dùng đầu (tuỳ chọn `--vieneu-tts`).
* **Cookie/phiên Zalo** — sinh ra khi người dùng quét QR, nằm trong `data/`.
