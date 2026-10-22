# §21 Giai đoạn 10 — Bộ não thuần SQLite: gỡ OpenViking

**Ngày:** 2026-10-22
**Trạng thái:** Đã triển khai (2.52.0). Provider `zalo_memory` viết lại; `openviking_base/` đã gỡ.
**Dự án:** 2anh-zalo-bot, từ v2.51.0 lên **2.52.0**
**Thay thế:** §19 (`2026-10-09-memory-openviking.md`) — toàn bộ phần OpenViking. §20 (chủ đề + tri thức) **giữ nguyên** và nay là nền của bộ nhớ.
**Lý do đổi:** `local://brain-audit.md` + quyết định của chủ dự án 2026-10-22.

## 21.1 Vì sao gỡ OpenViking

| Vấn đề | Chi tiết |
|---|---|
| **Giấy phép** | OpenViking (`github.com/volcengine/OpenViking`) là **AGPL-3.0**. Nhúng vào bộ cài = ràng buộc AGPL lên toàn bộ `2anh-zalo-bot`; §13 còn buộc cung cấp source cho **người tương tác qua mạng**. Chỉ hợp lý nếu dự án vốn định mở mã nguồn. |
| **Vận hành** | Bắt mỗi máy khách chạy thêm một dịch vụ HTTP (`127.0.0.1:1933`) + `auth_mode: dev` + `ov.conf`. |
| **Phụ thuộc model** | OpenViking không có model sẵn: cần embedding + VLM (spec §19 ghi `text-embedding-3-small` + `gemini-2.5-flash` qua 9router) → vẫn ra Internet, vẫn phụ thuộc nhà cung cấp. "Không phụ thuộc source khác" không đạt được theo hướng đó. |
| **Đã có sẵn thứ khó** | §20 đã dựng trong `zalo.sqlite`: `topics`, `facts` (kiểu · gốc tin nhắn · hạn hiệu lực · supersede · hàng đợi mâu thuẫn), FTS5, cô lập `(account_id, scope)`. Thiếu đúng hai bảng. |

**Quyết định:** bỏ OpenViking; mở rộng tầng SQLite thành bộ nhớ chính thức. Không thêm dịch vụ, không thêm giấy phép, không thêm phụ thuộc model cho phần **recall** (recall chỉ SELECT; chỉ phần **trích xuất** mới gọi `ctx.llm` sẵn có của Hermes).

## 21.2 Kho ở đâu (bẫy đã sập một lần)

Plugin chạy trong tiến trình gateway ở `<HERMES_HOME>/plugins/…`, còn kho ở thư mục mã cầu nối. Suy đường dẫn
theo vị trí plugin là SAI (`<HERMES_HOME>/data/…` không tồn tại) → worker im lặng, recall rỗng.

Một luật duy nhất trong `brain_jobs.sqlite_path()`; provider `zalo_memory.sqlite_path()` **gọi lại chính hàm
đó**. Fallback `_resolve_sqlite_path` chỉ dùng khi không import được `zalo_tools`. Hai chỗ tự giải riêng là mầm
lệch nhau — đã lệch thật: worker tìm ra kho còn provider trả `None`, recall rỗng trên cùng một máy.

Thứ tự:

1. `ZALO_SQLITE_FILE` — test/cài đặt riêng.
2. `ZALO_SIDECAR_ROOT` (hoặc `ZALO_SIDECAR_DIR`) → `<root>/data/zalo.sqlite`. **Trình cài ghi biến này vào
   `<HERMES_HOME>/.env`** (`ensureHermesEnvValue`, thay giá trị cũ khi đổi chỗ mã).
3. `<HERMES_HOME>/data/zalo.sqlite` — bản cài kiểu cũ.
4. **Đọc thẳng `.env`**: `<HERMES_HOME>/.env`, và `.env` cạnh thư mục gói (`plugins/zalo_tools` → `../../.env`,
   tức `.env` của sidecar khi cài tại chỗ). Cần cho lúc biến chưa vào `os.environ` (gateway nạp `.env` muộn,
   chạy tay, plugin nạp lẻ trong test) và cho bản cài cũ ghi biến ở `.env` sidecar. Chỉ đọc đúng ba khoá,
   **không** nạp cả tệp vào môi trường.
5. Dò ngược tìm thư mục có `server.js` + `data/zalo.sqlite`. **Giới hạn có thật:** chỉ hiệu quả khi plugin nằm
   *bên trong* thư mục mã bot. Bản cài chuẩn đặt plugin ở `<HERMES_HOME>/plugins/`, đi ngược từ đó chỉ lên tới
   `$HOME` — nên mắt này **không** cứu được trường hợp thiếu biến ở bản cài chuẩn; mắt 4 mới cứu. Mắt 5 giữ
   lại cho lúc chạy trực tiếp từ repo.

Không ra → `None`: worker bỏ vòng, recall rỗng, **không ném lỗi, không chặn lượt chat** — nhưng **có ghi log**:

- thiếu hẳn biến → WARNING nói rõ "chạy lại `npm run install:hermes` rồi khởi động lại gateway";
- có biến mà chưa có tệp → WARNING nói đây là bình thường (bot chưa chạy lần nào); các vòng sau hạ xuống
  DEBUG để không spam log mỗi 30 giây.

Trước bản này nhánh đó **im lặng hoàn toàn** — phải chạy `doctor` mới biết (§21.9).

### `account_id` là UID Zalo, không phải chuỗi cố định

Sidecar đặt `activeAccountId = profile.user_id` (hộp thư bot) và dùng nó cho **mọi** dòng. Provider **không
được** hard-code `account_id = 'zalo'` — đọc một lần từ kho (`messages` mới nhất, không có thì `facts`), nhớ
trong tiến trình 300 giây. Bản đầu hard-code và recall rỗng suốt dù kho đầy dữ liệu.

## 21.3 Hồ sơ gộp: bảng `profiles`

```
profiles (account_id, scope, body ≤2000 ký tự, source_fact_ids JSON, updated_at_ms,
          PRIMARY KEY(account_id, scope))
```

Một dòng một phạm vi; thay `profile.md` của OpenViking. Thay `facts[]` của OpenViking.

## 21.4 Trí nhớ mềm: bảng `soft_memories`

```
soft_memories (id, account_id, scope, body ≤400, kind, source_msg_keys JSON, topic_id,
               status active|deleted, created_at_ms, updated_at_ms)
soft_fts(content='soft_memories', tokenize='unicode61 remove_diacritics 2') + trigger sync
```

Khác `facts`: không đòi `kind`/`subject`, không supersede — dùng cho câu tự rút không có dạng sự thật rời rạc
(cách nói chuyện, mạch việc đang dở). Là chỗ "nhớ giúp…" của chủ nhân ghi vào.

## 21.5 Recall: chỉ SELECT

`build_memory_block(scope, query)` ghép ba phần, trần `MEMORY_BLOCK_CHARS = 1500`:

```
<memory-context>
[Hồ sơ]                ← profiles.body
[Điều đã biết]         ← facts đang hiệu lực (status='active', chưa hết valid_to_ms), tin cậy cao trước, ≤6
[Ghi chú gần đây]      ← soft_memories khớp câu hỏi (FTS5), ≤4
</memory-context>
```

Không mạng, không LLM, không gọi dịch vụ. Phạm vi giữ nguyên công thức §19.4: `zalo-g-<nhóm>` / `zalo-u-<uid>`;
mọi truy vấn kèm `scope = ?` và `account_id = ?` cứng trong hàm, không nhận từ tham số mô hình.

## 21.6 Trần

| Trần | Giá trị | Việc |
|---|---|---|
| Khối recall | 1 500 ký tự | không phình ngữ cảnh |
| Fact mỗi lượt | 6 | |
| Ghi chú mỗi lượt | 4 | |
| Hồ sơ | 2 000 ký tự | |
| Mỗi mục ghi chú | 400 ký tự | |
| Ghi của chủ nhân | 1 000 ký tự/lần, ≤5 mục mỗi lần quên | |
| Lượt ghi/ngày | 150 mỗi phạm vi · 600 toàn bot | |

## 21.7 Công cụ chủ nhân

`zalo_memory_remember` / `zalo_memory_forget` (chỉ chủ nhân, `TOOLSET_OWNER`): phạm vi **từ ContextVar của lượt**,
không bao giờ từ tham số mô hình. `forget` hai bước: `query` → liệt kê ≤5 mục `{id, body}`; `ids` → xoá (kiểm
toàn bộ id thuộc phạm vi trước, một id lạ → từ chối cả lô). Trả `id` (số) thay vì URI.

## 21.8 Dashboard › Trí nhớ › Kho tri thức tự học

Đọc/ghi thẳng `zalo.sqlite` (`dashboard/lib/brain-store.js` mở ghi, `learned-memory.js` bọc quyền):

- Chọn nhóm/người; lọc theo loại (Hồ sơ · Tri thức · Ghi chú); sửa; xoá.
- **Fact xoá = đánh dấu `deleted`** (giữ dòng để tra lại lịch sử); ghi chú/hồ sơ xoá hẳn.
- Xoá nhiều (`ids`), "Quên hết phạm vi này" quét facts + hồ sơ + ghi chú + chủ đề của đúng phạm vi — **tin
  nhắn thô giữ nguyên** (lịch sử không phải tri thức).
- Kho DM của chủ nhân bot chỉ Quản trị thấy: chặn ở máy chủ, 404, **không chạm kho**.
- Chu kỳ gói/trích: 30–1440 phút (mặc định 120), ghi `<HERMES_HOME>/zalo/brain.json`; "Rút ngay" 3 lần/kho/ngày.

## 21.9 Doctor

- `long-term-memory`: chỉ kiểm provider có được chọn và plugin có mặt. **Không còn** kiểm loopback OpenViking.
- `zalo-brain-jobs`: có `brain_jobs.py` + `store_writer.py`.
- `zalo-brain-store`: có `ZALO_SIDECAR_ROOT` (thiếu → chặn, vì worker sẽ im lặng) và kho có tìm thấy không.
- `memoryHint` không còn dò `[hermes-]openviking.service` — giữ hàm để chỗ gọi không đổi, luôn trả `null`.

## 21.10 Gỡ cái gì

| Gỡ | Ghi chú |
|---|---|
| `hermes-plugin/zalo_memory/openviking_base/` | toàn bộ lớp bọc |
| `pip_dependencies: httpx` trong `plugin.yaml` | không còn gọi HTTP nào |
| `OPENVIKING_ENDPOINT` / loopback / `auth_mode` / `api_key_would_be_sent` | hết khái niệm |
| Trường `endpoint` của `learnedMemoryStatus` | |
| `cleanAbstract` (chỗ giữ chỗ `viking://…`) | hết URI |
| Tầng OpenViking trong `learned-memory.js` (ovRequest, `read`, `memoryUri`, `scopeRoot`) | thay bằng SQL |

**Second brain** (`dashboard/lib/second-brain.js`, `ZALO_SECOND_BRAIN_URL`) **giữ nguyên** — đó là kho ghi chú
riêng của chủ máy (spec §18.5.4), tính năng khác, không thuộc phạm vi này; nó vẫn nói chuyện OpenViking nếu ai
đặt biến. Không đặt thì ẩn.

## 21.11 Đo (2026-10-22, máy chủ dự án)

| Kiểm | Kết quả |
|---|---|
| `node --test zalo-store.test.js` | 24/24 |
| `dashboard/lib/learned-memory.test.js` | 13/13 (viết lại theo SQLite) |
| `dashboard/routes/learned-memory.test.js` | 3/3 |
| `dashboard/public/public.test.js` | 84/84 |
| `scripts/hermes-install-lib.test.js` | 50/50 |
| `scripts/cli.test.js` | 3/3 |
| `test_zalo_brain_profile.py` | **25/25** — gộp hồ sơ (bỏ vỏ bọc model, chọn phạm vi, chu kỳ nghỉ, supersede không tính, trần mỗi vòng, đè không tạo dòng mới, model rỗng/lỗi thì giữ hồ sơ cũ) + tìm kho (ưu tiên biến môi trường, đọc `.env`, dò ngược cần đủ `server.js` + kho, cảnh báo WARNING rồi DEBUG, provider và worker trỏ cùng chỗ) |
| Toàn bộ `node --test` | **1091/1094** — 2 test hỏng có sẵn (`dashboard/lib/env-file.test.js` số byte, `dashboard/lib/kb-store.test.js`), xác nhận bằng `git stash` là **không** do thay đổi này |
| Chạy thật sau restart | worker tự gói **4 chủ đề + 6 fact + 4 hồ sơ** từ các cuộc trao đổi thật; hồ sơ lên đầu khối `<memory-context>`; nhóm A chỉ thấy tri thức nhóm A, nhóm toán chỉ thấy bài toán, DM riêng biệt; phiên CLI đóng hoàn toàn |

**Còn phải làm tay (không tự động):** khởi động lại gateway sau khi cài (`hermes gateway restart`).

## 21.12 Rủi ro

- **Chất lượng trích xuất phụ thuộc prompt + `ctx.llm`.** Nếu model trả sai dạng, lượt đó bị bỏ (không ghi gì),
  vòng sau thử lại. Không có gì hỏng.
- **`account_id` đọc lúc chạy:** lần gọi đầu khi kho hoàn toàn trống trả `''` → recall rỗng cho tới khi có tin
  đầu tiên. Chấp nhận: chưa có tin thì cũng chưa có trí nhớ.
- **Sidecar và plugin cùng ghi một tệp.** Cả hai đặt `busy_timeout` 5 s và dùng WAL; test chạy thật trên kho
  977 tin không gặp khoá.
- **Chưa có tự gộp hồ sơ (`profiles`)**: worker gói chủ đề + trích fact, nhưng chưa có luồng LLM gộp hồ sơ theo
  chu kỳ. Bảng đã sẵn và recall đã đọc; việc còn thiếu là ghi.
- **Bản ghi thô `soft_memories` không tự hết hạn.** Chỉ xoá khi chủ nhân dặn hoặc "Quên hết phạm vi".
