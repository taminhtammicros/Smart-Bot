import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Danh sách chủ nhân bot, đọc lại khi `<HERMES_HOME>/.env` đổi.
 *
 * Trước đây cầu nối chụp `ZALO_ALLOWED_USERS` một lần lúc khởi động, nên thêm
 * chủ nhân trên dashboard phải khởi động lại kết nối Zalo mới có hiệu lực —
 * trong lúc chờ, người vừa thêm vẫn bị coi là người ngoài. Đọc lại theo tem
 * (mtime + kích thước; chỉ `stat` mỗi lần hỏi, chỉ đọc tệp khi tem đổi) giữ
 * đúng một nguồn sự thật là dòng trong `.env`.
 *
 * UID Zalo là dãy số dài 17–21 chữ số, không bắt đầu bằng `0`; số điện thoại
 * thì ngược lại nên bị loại. Điền nhầm số điện thoại không cấp quyền cho ai.
 */
const ZALO_UID = /^[1-9]\d{16,20}$/;

/** UID thật của Zalo (17–21 chữ số) — dùng khi đọc từ `.env` hay biến môi trường. */
const ZALO_UID_REAL = ZALO_UID;

export function splitOwnerUids(raw, { strict = false } = {}) {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => (strict ? ZALO_UID_REAL : /^[^\s,]{1,64}$/).test(value));
}

function parseAllowed(rawEnv) {
  let found = false;
  let value = '';
  for (const line of String(rawEnv ?? '').split('\n')) {
    const match = /^\s*(?:export\s+)?ZALO_ALLOWED_USERS\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    found = true;
    value = match[1].trim();
  }
  if (!found) return null;
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1);
  }
  return splitOwnerUids(value, { strict: true });
}

/**
 * @param {object} options
 * @param {string} [options.home] `<HERMES_HOME>`; trống thì theo môi trường của tiến trình.
 * @param {() => string} [options.envSource] nguồn dự phòng khi `.env` không có dòng này.
 * @param {string[]|(() => string[])} [options.fixed] danh sách cố định (test, chạy nhúng).
 */
export function createOwnerDirectory({
  home = process.env.HERMES_HOME || '',
  envSource = () => process.env.ZALO_ALLOWED_USERS || '',
  fixed = null,
  now = () => Date.now(),
} = {}) {
  const file = home ? join(home, '.env') : '';
  const RETRY_MS = 60_000;
  let stamp;
  let cached = null;
  let readAt = 0;

  function fileStamp() {
    if (!file) return 'none';
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return 'missing';
    }
  }

  function fromFile() {
    const next = fileStamp();
    if (cached && (next === stamp || (next === 'missing' && now() - readAt < RETRY_MS))) return cached;
    stamp = next;
    readAt = now();
    try {
      if (!file) throw new Error('không có HERMES_HOME');
      const parsed = parseAllowed(readFileSync(file, 'utf8'));
      cached = new Set(parsed ?? splitOwnerUids(envSource(), { strict: true }));
    } catch {
      // Tệp chưa có (hoặc hỏng): giữ danh sách cũ nếu đã có, thử lại sau một phút.
      if (!cached || now() - readAt >= RETRY_MS) cached = new Set(splitOwnerUids(envSource(), { strict: true }));
    }
    return cached;
  }

  function current() {
    if (fixed == null) return fromFile();
    const list = typeof fixed === 'function' ? fixed() : fixed;
    // Danh sách cố định do người gọi truyền vào (test, nhúng) — không lọc theo dạng UID.
    return new Set(splitOwnerUids(Array.isArray(list) ? list.join(',') : list));
  }

  return {
    /** @returns {Set<string>} UID chủ nhân hiện tại. */
    uids: current,
    has: (uid) => current().has(String(uid ?? '')),
    /** Tệp đang theo dõi — để log/health nói rõ nguồn. */
    file: () => file,
  };
}
