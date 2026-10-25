# Cài đặt 2Anh Zalo Bot

Hướng dẫn cho **người dùng cuối**. Chọn đúng một mục dưới đây.

| Máy của bạn | Mục |
|---|---|
| macOS (Intel hoặc Apple Silicon) | [Native — macOS](#native--macos) |
| Linux (VPS hoặc máy bàn) | [Native — Linux](#native--linux) |
| Windows 10/11 | [Native — Windows](#native--windows) |
| Muốn chạy bằng Docker | [Docker](#docker) |

Người **phát hành** bản build đọc thêm [`docs/PACKAGING.md`](PACKAGING.md).

---

## Cần có trước

1. **Node.js 22.5 trở lên** — script cài đặt sẽ báo nếu thiếu và chỉ cách cài.
2. **Hermes Agent đã cài** — bot không có bộ não riêng; thiếu Hermes thì bot
   nhận tin nhưng không trả lời.
3. **Một tài khoản Zalo phụ** — đừng dùng tài khoản chính.

---

## Chuẩn bị mã nguồn (mọi nền tảng)

```bash
git clone https://github.com/luonghaianh1208/2anh-zalo-bot.git
cd 2anh-zalo-bot
```

Nếu nhận được **tệp nén** thay vì clone: giải nén, rồi mở terminal tại thư mục
vừa giải nén.

---

## Native — macOS

Áp dụng cho cả **Intel (x86_64)** và **Apple Silicon (arm64)**. Script tự nhận
kiến trúc, không cần chọn tay.

### Cài đặt

Mở **Terminal** tại thư mục dự án, rồi:

```bash
./scripts/setup.sh
```

Nếu báo `Permission denied`:

```bash
chmod +x scripts/*.sh scripts/lib/*.sh
./scripts/setup.sh
```

Script sẽ:
1. kiểm tra Node ≥ 22.5 và kiến trúc CPU;
2. `npm ci` (cài đúng theo `package-lock.json`);
3. tạo `.env` và **tự sinh** `ZALO_BRIDGE_TOKEN`;
4. cài plugin vào Hermes Agent, cập nhật `config.yaml`;
5. chạy `doctor` để kiểm tra lần cuối.

Hermes ở vị trí không mặc định:

```bash
./scripts/setup.sh --hermes-home ~/hermes
```

### Chạy

```bash
./scripts/run.sh
```

Mở trình duyệt: **http://127.0.0.1:3880**

Dừng: `Ctrl+C`.

### Chạy nền (không giữ cửa sổ Terminal)

```bash
./scripts/run.sh --background     # khởi động, in PID
./scripts/run.sh --status         # đang chạy không?
./scripts/run.sh --stop           # dừng
```

Log: `logs/sidecar.out`.

---

## Native — Linux

Áp dụng cho **x86_64/amd64** và **arm64** (VPS ARM, Raspberry Pi, máy bàn).

### Cài đặt

```bash
chmod +x scripts/*.sh scripts/lib/*.sh
./scripts/setup.sh
```

### Chạy như dịch vụ (khuyến nghị cho VPS)

`setup.sh` đã cài sẵn unit `zalo-dashboard` (nếu hệ thống dùng systemd):

```bash
sudo systemctl status zalo-dashboard     # xem trạng thái
sudo systemctl restart zalo-dashboard    # khởi động lại
sudo journalctl -u zalo-dashboard -f     # xem log trực tiếp
```

Chạy tay (không qua systemd):

```bash
./scripts/run.sh --background
./scripts/run.sh --stop
```

### Truy cập dashboard từ xa

Mặc định dashboard chỉ nghe `127.0.0.1:3880`. Trên VPS, dùng SSH tunnel:

```bash
ssh -L 3880:127.0.0.1:3880 user@ten-vps
# rồi mở http://127.0.0.1:3880 trên máy bạn
```

Hoặc đặt Caddy/nginx phía trước và cấu hình `ZALO_DASHBOARD_URL=https://…`.

---

## Native — Windows

Áp dụng cho **Windows 10 và 11, x86_64**.

### Cài đặt

Mở **Command Prompt** hoặc **PowerShell** tại thư mục dự án.

Cách 1 — nhấp đúp:

> Mở thư mục `scripts`, nhấp đúp **`setup.bat`**.

Cách 2 — dòng lệnh (khuyến nghị, thấy rõ thông báo):

```bat
scripts\setup.bat
```

Nếu PowerShell chặn script (`running scripts is disabled`), `setup.bat` đã tự
truyền `-ExecutionPolicy Bypass`, nên chỉ cần chạy qua tệp `.bat`.

Hermes ở vị trí không mặc định:

```bat
scripts\setup.bat -HermesHome "D:\hermes"
```

### Chạy

Nhấp đúp **`scripts\run.bat`**, hoặc:

```bat
scripts\run.bat
```

Mở trình duyệt: **http://127.0.0.1:3880**

Dừng: `Ctrl+C`.

### Chạy nền

```bat
scripts\run.bat -Background
scripts\run.bat -Status
scripts\run.bat -Stop
```

Log: `logs\sidecar.out`. Lỗi: `logs\sidecar.err`.

---

## Docker

Áp dụng cho macOS (Intel + Apple Silicon), Linux, và Windows qua WSL2.

### 1. Chuẩn bị `.env`

```bash
cp .env.example .env
```

Mở `.env` và đặt một `ZALO_BRIDGE_TOKEN` **tự chọn** (chuỗi hex 48 ký tự):

```bash
# macOS / Linux
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

```bat
:: Windows
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

### 2. Chạy

```bash
docker compose up -d
docker compose logs -f
```

Mở **http://127.0.0.1:3880**.

Dừng: `docker compose down` (dữ liệu vẫn còn trong volume).

**Máy đã có bản chạy native?** Cổng 3880 sẽ bận. Dùng override có sẵn — bản
Docker chuyển sang 3881, dữ liệu để trong volume riêng:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

Mở **http://127.0.0.1:3881**.

> Đừng quét QR đăng nhập Zalo trên cả hai bản cùng lúc — Zalo chỉ cho một phiên.

### 3. Tạo tài khoản Quản trị

Bản Docker chưa có tài khoản nào. Lấy link thiết lập (hiệu lực 24 giờ):

```bash
docker compose exec bot node dashboard/cli/setup-link.js
```

Mở link in ra, đặt tên đăng nhập và mật khẩu. Sau đó vào **Tài khoản Zalo** để
quét QR.

### 4. Dữ liệu nằm ở đâu

Ba named volume — `docker compose down` **không** xoá chúng:

| Volume | Nội dung |
|---|---|
| `2anh-zalo-bot_zalo-data` | Lịch sử Zalo, phiên đăng nhập, kho tri thức |
| `2anh-zalo-bot_zalo-logs` | Log |
| `2anh-zalo-bot_hermes-home` | Cấu hình Hermes |

Sao lưu:

```bash
docker run --rm -v 2anh-zalo-bot_zalo-data:/d -v "$(pwd):/b" alpine \
  tar czf /b/zalo-data-$(date +%F).tar.gz -C /d .
```

Xoá sạch (mất hết dữ liệu):

```bash
docker compose down -v
```

### 5. Hermes chạy ở đâu?

Ba lựa chọn:

| Cách | Làm gì |
|---|---|
| Hermes trên cùng máy (ngoài Docker) | Giữ `ZALO_BRIDGE_URL=ws://host.docker.internal:3873` trong `.env` của Hermes |
| Hermes trong cùng compose network | Thêm service Hermes vào compose, dùng `ws://bot:3873` |
| Hermes trong container khác | Dùng `ws://<tên-container>:3873` với `networks` chung |

Xem [`docs/PACKAGING.md`](PACKAGING.md) mục 3 để build image đa kiến trúc.

---

## Sau khi cài — các bước cho MỌI nền tảng

### 1. Đăng nhập Zalo

1. Mở dashboard → **Tài khoản Zalo**
2. Bấm **Tạo mã QR**
3. Trên điện thoại: Zalo → biểu tượng quét QR → quét mã

> Dùng **tài khoản phụ**. Zalo không có API chính thức cho tài khoản cá nhân;
> dùng tài khoản chính có nguy cơ bị khoá.

### 2. Nhận UID của bạn

Từ **Zalo cá nhân**, nhắn riêng cho tài khoản vừa quét:

```
/sethome
```

Bot trả về **UID** của bạn — dãy số dài 17–21 chữ số. Lệnh này **chưa** cấp
quyền chủ, chỉ cho biết UID.

### 3. Cấp quyền chủ

Mở **`.env` của Hermes** (không phải `.env` của repo):

| Nền tảng | Đường dẫn |
|---|---|
| macOS / Linux | `~/.hermes/.env` |
| Windows | `%LOCALAPPDATA%\hermes\.env` |
| Docker | `docker compose exec bot sh -c 'echo ZALO_ALLOWED_USERS=<UID> >> /hermes/.env'` |

Thêm dòng:

```
ZALO_ALLOWED_USERS=<UID vừa nhận>
```

### 4. Khởi động lại

```bash
# macOS / Linux
./scripts/run.sh --stop && ./scripts/run.sh --background

# Windows
scripts\run.bat -Stop
scripts\run.bat -Background

# Docker
docker compose restart
```

Rồi **khởi động lại gateway Hermes** theo cách máy bạn đang quản lý dịch vụ
(systemd / launchd / chạy tay).

### 5. Thử

Nhắn cho bot trên Zalo. Nếu không có phản hồi, xem:

```bash
npm run doctor -- --hermes-home <đường-dẫn-Hermes>
```

---

## Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| `Cần Node.js 22 trở lên` | Node quá cũ | Cài Node 22 LTS: macOS `brew install node@22`; Linux qua NodeSource; Windows `winget install OpenJS.NodeJS.LTS` |
| `Không tìm thấy Hermes Agent hợp lệ` | Hermes chưa cài, hoặc ở chỗ khác | Cài Hermes, hoặc chạy lại với `--hermes-home <p>` / `-HermesHome "<p>"` |
| `Không tìm thấy HERMES_HOME` khi chạy dashboard | `.env` chưa có `HERMES_HOME` | `./scripts/setup.sh` sẽ ghi; hoặc thêm tay vào `.env` |
| `EADDRINUSE: 3872` | Cổng bị chiếm | `./scripts/run.sh --port 3874` |
| `Permission denied` khi chạy `.sh` | Thiếu quyền thực thi | `chmod +x scripts/*.sh scripts/lib/*.sh` |
| Windows: `running scripts is disabled` | Execution policy | Chạy qua `scripts\setup.bat` (đã có `Bypass`) |
| `npm ci` lỗi mạng | Proxy / tường lửa | Đặt `npm config set proxy`, hoặc cài sau bằng `npm install` |
| Bot nhận tin nhưng không trả lời | Hermes gateway chưa chạy, hoặc UID chưa được cấp | Kiểm `ZALO_ALLOWED_USERS`, khởi động lại gateway |
| Docker: `no matching manifest for linux/arm64` | Image chỉ có một kiến trúc | Build lại với `--platform linux/amd64` hoặc dùng image đa kiến trúc |

### Xem log

| Nền tảng | Lệnh |
|---|---|
| Native | `tail -f logs/sidecar.out` (Windows: `type logs\sidecar.out`) |
| systemd | `sudo journalctl -u zalo-dashboard -f` |
| Docker | `docker compose logs -f` |

---

## Gỡ cài đặt

```bash
# 1. Gỡ plugin khỏi Hermes
npm run uninstall:hermes -- --hermes-home <đường-dẫn-Hermes>

# 2. Xoá dữ liệu (KHÔNG khôi phục được — chứa phiên Zalo)
rm -rf data logs .env

# Docker: xoá cả volume
docker compose down -v
```

---

## Bảng tuỳ chọn đầy đủ

### `setup.sh` / `setup.ps1`

| macOS/Linux | Windows | Ý nghĩa |
|---|---|---|
| `--hermes-home <p>` | `-HermesHome <p>` | Vị trí Hermes Agent |
| `--vieneu-tts` | `-VieneuTts` | Bật giọng Việt offline (~282 MB, cần ~10 GB RAM trống) |
| `--no-dashboard` | `-NoDashboard` | Không cài dịch vụ dashboard |
| `--skip-python` | `-SkipPython` | Bỏ kiểm tra thư viện Python của Hermes |
| `--venv` | `-Venv` | Dựng `.venv` cục bộ (cho `npm run test:py`) |
| `--offline` | `-Offline` | Không gọi mạng, dùng gói đã tải sẵn |

### `run.sh` / `run.ps1`

| macOS/Linux | Windows | Ý nghĩa |
|---|---|---|
| `--background` | `-Background` | Chạy nền |
| `--stop` | `-Stop` | Dừng tiến trình nền |
| `--status` | `-Status` | Kiểm tra đang chạy |
| `--dashboard` | `-Dashboard` | Chạy dashboard thay vì sidecar |
| `--port <n>` | `-Port <n>` | Đổi cổng sidecar (mặc định 3872) |
| `--no-checks` | `-NoChecks` | Bỏ kiểm tra trước khi chạy |

Thêm `--help` (hoặc `-Help`) để xem trợ giúp tại chỗ.
