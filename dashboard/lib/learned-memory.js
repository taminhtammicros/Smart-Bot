/**
 * Kho tri thức tự học (spec §21.8, 2.52.0): những gì trợ lý tự rút ra sau các cuộc trò chuyện, nay nằm ngay
 * trong kho SQLite của bot (`data/zalo.sqlite`) — KHÔNG còn OpenViking:
 *
 *   facts (theo phạm vi)   profiles (hồ sơ gộp)   soft_memories (câu tự rút)   contradictions (chờ duyệt)
 *
 * Mỗi phạm vi là một chuỗi `zalo-g-<groupId>` / `zalo-u-<uid>`; mọi câu truy vấn lọc theo đúng phạm vi đó.
 * Tách hẳn khỏi Kho tri thức (tài liệu người dùng tải lên) và Second brain (kho riêng, nếu có cấu hình).
 * Quản trị và Chủ bot cùng xem/sửa/xoá; RIÊNG kho tin nhắn riêng của chủ nhân bot (`zalo-u-<UID chủ nhân>`) chỉ
 * Quản trị thấy — chặn ở đây (máy chủ), không chỉ ẩn ở giao diện.
 *
 * Vì sao đổi: OpenViking là dự án ngoài (AGPL-3.0) và bắt mỗi máy chạy thêm dịch vụ + nạp model. Xem README.
 */
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { readJson, writeJsonAtomic } from './json-store.js';
import { openBrainStore, forgetScopeFacts } from './brain-store.js';

// `account_id` trong kho là UID Zalo của CHÍNH BOT (sidecar lấy từ profile), không phải chuỗi cố định — xem
// `hermes-plugin/zalo_memory/__init__.py:41`. Đăng nhập tài khoản khác là UID đổi, nên mỗi lượt đọc lấy lại từ
// dòng mới nhất. Không đệm trong module: dashboard mở nhiều kho (test, nhiều máy) và một cache dùng chung sẽ trả
// UID của kho này cho kho khác.
export const LM_PROVIDER = 'zalo_memory';

/** UID Zalo của bot = `account_id` dùng chung mọi dòng trí nhớ; kho chưa có tin nào → ''. */
export function resolveAccount(conn) {
  if (!conn) return '';
  for (const sql of ['SELECT account_id FROM messages ORDER BY timestamp_ms DESC LIMIT 1',
    'SELECT account_id FROM facts ORDER BY fact_id DESC LIMIT 1',
    'SELECT account_id FROM profiles LIMIT 1']) {
    try {
      const value = String(conn.prepare(sql).get()?.account_id ?? '');
      if (value) return value;
    } catch { /* bảng chưa có → thử nguồn kế */ }
  }
  return '';
}

// Chu kỳ rút/gói trí nhớ (phút) — `brain_jobs` (plugin) đọc nóng cùng tệp `<HERMES_HOME>/zalo/brain.json`.
export const EXTRACT_DEFAULT = 120;
export const EXTRACT_MIN = 30;
export const EXTRACT_MAX = 1440;
export const EXTRACT_NOW_PER_DAY = 3;
const SCOPE = /^zalo-(g|u)-(\d{1,32})$/;
const MAX_TEXT = 2000;
export const MAX_BULK = 200;
export const WINDOWS_NOTE = 'Kho tri thức tự học chỉ bật trên máy chủ Linux/VPS.';
export const OFF_NOTE = 'Trí nhớ dài hạn chưa bật — người cài đặt đặt memory.provider: zalo_memory trong config.yaml của Hermes (xem README, mục Trí nhớ dài hạn).';

const err = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const vnDay = (ms) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** `{ kind: 'group'|'dm', id }` của tên phạm vi hợp lệ, ngược lại null. */
export function parseScope(scope) {
  const m = SCOPE.exec(String(scope ?? ''));
  return m ? { kind: m[1] === 'g' ? 'group' : 'dm', id: m[2] } : null;
}

/** Đọc `memory.provider` của Hermes; lỗi đọc → ''. */
export function readProvider(configFile) {
  try { return String(YAML.parse(readFileSync(configFile, 'utf8'))?.memory?.provider ?? '').trim(); } catch { return ''; }
}

/** Chu kỳ gói/trích đang có hiệu lực — cùng luật với worker: thiếu/hỏng/sai kiểu → 120, ngoài khoảng → kẹp. */
export function readMemorySettings(file) {
  let minutes = EXTRACT_DEFAULT;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (Number.isInteger(data?.topicQuietMinutes)) {
      minutes = Math.min(EXTRACT_MAX, Math.max(EXTRACT_MIN, data.topicQuietMinutes));
    }
  } catch { /* chưa có tệp → mặc định */ }
  return { extractMinutes: minutes, min: EXTRACT_MIN, max: EXTRACT_MAX, default: EXTRACT_DEFAULT };
}

/** Bật khi: không phải Windows và Hermes đang chọn provider `zalo_memory`. Kho chưa có thì báo riêng. */
export function learnedMemoryStatus({ provider, sqliteFile = null, platform = process.platform }) {
  if (platform === 'win32') return { enabled: false, reason: 'windows', note: WINDOWS_NOTE };
  if (provider !== LM_PROVIDER) return { enabled: false, reason: 'off', note: OFF_NOTE };
  return { enabled: true, reason: 'ok', note: '', sqliteFile };
}

export function createLearnedMemory({
  settings, names = () => '', owners = () => [], ownerOverrides = () => [], everOwnersFile,
  settingsFile, sqliteFile = null, platform = process.platform, now = Date.now,
}) {
  const status = () => learnedMemoryStatus({ provider: settings().provider, sqliteFile, platform });
  const extractLog = new Map();   // phạm vi → [mốc ms] "Rút ngay" trong ngày VN

  /** Mở kho GHI; chưa có tệp → null (route trả 404 kèm câu dễ hiểu). */
  function db() {
    if (!sqliteFile) return null;
    return openBrainStore(sqliteFile);
  }
  const withDb = (fn) => {
    const conn = db();
    if (!conn) throw err(404, 'Chưa có kho tri thức — bot chạy lần đầu sẽ tạo.');
    try { return fn(conn); } finally { try { conn.close(); } catch { /* đã đóng */ } }
  };
  /** Bảng chưa có (kho mở bằng bản cũ) → coi như rỗng thay vì lỗi. */
  const orEmpty = (fn) => {
    try { return fn(); } catch (e) { if (/no such table/i.test(String(e?.message ?? ''))) return []; throw e; }
  };
  const uids = (fn) => { try { return (fn() || []).map((x) => String(x).trim()).filter(Boolean); } catch { return null; } };

  /** UID có kho DM chỉ Quản trị thấy — đóng khi lỗi (danh sách trống → ẩn MỌI kho DM với vai trò khác). */
  function ownerSet() {
    const current = uids(owners);
    if (!current?.length) return null;
    const all = new Set([...current, ...(uids(ownerOverrides) || [])]);
    if (everOwnersFile) {
      const saved = readJson(everOwnersFile, null);
      const ever = Array.isArray(saved?.uids) ? saved.uids.map(String) : [];
      for (const u of ever) all.add(u);
      if (all.size > ever.length) {
        try { writeJsonAtomic(everOwnersFile, { version: 1, uids: [...all] }); } catch { /* lần sau ghi lại */ }
      }
    }
    return all;
  }
  const ownerDm = (p, set) => p?.kind === 'dm' && (set === null || set.has(p.id));
  const visible = (scope, role, set) => { const p = parseScope(scope); return Boolean(p) && (role === 'admin' || !ownerDm(p, set)); };
  function need(scope, role) { if (!visible(scope, role, ownerSet())) throw err(404, 'Không có nhóm/người này — chọn lại từ danh sách.'); }

  function as(role) {
    return {
      /** Mọi phạm vi đang có trí nhớ mà vai trò này được thấy: nhóm trước, rồi người; kèm tên và nhãn chủ nhân. */
      async scopes() {
        const set = ownerSet();
        const rows = withDb((conn) => {
          const acc = resolveAccount(conn);
          if (!acc) return [];
          return orEmpty(() => conn.prepare(
            'SELECT DISTINCT scope FROM facts WHERE account_id = ? '
            + 'UNION SELECT DISTINCT scope FROM soft_memories WHERE account_id = ? '
            + 'UNION SELECT DISTINCT scope FROM profiles WHERE account_id = ?').all(acc, acc, acc));
        });
        return rows
          .map((r) => String(r.scope ?? ''))
          .filter((scope) => visible(scope, role, set))
          .map((scope) => { const p = parseScope(scope); return { scope, ...p, name: String(names(p.kind, p.id) || ''), owner: p.kind === 'dm' && Boolean(set?.has(p.id)) }; })
          .sort((a, b) => ((a.kind === 'group' ? 0 : a.owner ? 2 : 1) - (b.kind === 'group' ? 0 : b.owner ? 2 : 1)) || a.name.localeCompare(b.name, 'vi'))
          .slice(0, 1000);
      },
      /** Hồ sơ gộp + fact + trí nhớ mềm của một phạm vi; `kind` lọc ('profile' | 'fact' | 'soft'). */
      async list(scope, kind) {
        need(scope, role);
        const want = String(kind ?? '');
        return withDb((conn) => {
          const acc = resolveAccount(conn);
          if (!acc) return [];
          const out = [];
          if (!want || want === 'profile') {
            const p = orEmpty(() => conn.prepare('SELECT body, updated_at_ms FROM profiles WHERE scope = ? AND account_id = ?').all(String(scope), acc))[0];
            if (p?.body) out.push({ id: 'profile', kind: 'profile', text: String(p.body), updatedAtMs: num(p.updated_at_ms) });
          }
          if (!want || want === 'fact') {
            for (const f of orEmpty(() => conn.prepare(
              "SELECT fact_id, kind, subject, content, confidence, status, valid_to_ms, updated_at_ms FROM facts WHERE scope = ? AND account_id = ? AND status = 'active' ORDER BY created_at_ms DESC LIMIT 500").all(String(scope), acc))) {
              out.push({ id: `fact:${f.fact_id}`, kind: 'fact', factKind: f.kind, subject: String(f.subject || ''),
                text: String(f.content || ''), confidence: num(f.confidence), status: String(f.status),
                expiresAtMs: f.valid_to_ms == null ? null : num(f.valid_to_ms), updatedAtMs: num(f.updated_at_ms) });
            }
          }
          if (!want || want === 'soft') {
            for (const s of orEmpty(() => conn.prepare(
              'SELECT id, body, kind, updated_at_ms FROM soft_memories WHERE scope = ? AND account_id = ? AND status = ? ORDER BY updated_at_ms DESC LIMIT 500').all(String(scope), acc, 'active'))) {
              out.push({ id: `soft:${s.id}`, kind: 'soft', softKind: String(s.kind), text: String(s.body), updatedAtMs: num(s.updated_at_ms) });
            }
          }
          return out;
        });
      },
      /** Tìm trong ĐÚNG phạm vi: fact (FTS) + trí nhớ mềm (FTS) + hồ sơ (khớp thô). */
      async search(scope, query) {
        need(scope, role);
        const q = String(query ?? '').trim();
        if (q.length < 2 || q.length > 200) throw err(400, 'Gõ 2–200 ký tự để tìm.');
        return withDb((conn) => {
          const acc = resolveAccount(conn);
          if (!acc) return [];
          const hits = [];
          for (const f of orEmpty(() => conn.prepare(
            'SELECT f.fact_id, f.kind, f.subject, f.content, f.status FROM facts_fts fi JOIN facts f ON f.rowid = fi.rowid '
            + 'WHERE facts_fts MATCH ? AND f.scope = ? AND f.account_id = ? LIMIT 30').all(q, String(scope), acc))) {
            hits.push({ id: `fact:${f.fact_id}`, kind: 'fact', subject: String(f.subject || ''), text: String(f.content || ''), status: String(f.status) });
          }
          for (const s of orEmpty(() => conn.prepare(
            'SELECT s.id, s.body FROM soft_fts fi JOIN soft_memories s ON s.id = fi.rowid '
            + 'WHERE soft_fts MATCH ? AND s.scope = ? AND s.account_id = ? AND s.status = ? LIMIT 30').all(q, String(scope), acc, 'active'))) {
            hits.push({ id: `soft:${s.id}`, kind: 'soft', text: String(s.body) });
          }
          return hits;
        });
      },
      /** Sửa: chỉ trí nhớ mềm và hồ sơ (fact là bản ghi có provenance — sửa được `content` để đính chính). */
      async edit(scope, id, text) {
        need(scope, role);
        const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
        if (!body) throw err(400, 'Nội dung trống — muốn bỏ mục này thì bấm Xoá.');
        if (body.length > MAX_TEXT) throw err(400, `Mỗi mục tối đa ${MAX_TEXT} ký tự.`);
        const stamp = now();
        return withDb((conn) => {
          const acc = resolveAccount(conn);
          if (!acc) throw err(404, 'Chưa có kho trí nhớ — bot chạy lần đầu sẽ tạo.');
          const [kind, raw] = String(id ?? '').split(':');
          const changed = (info) => {
            if (Number(info.changes) > 0) return true;
            throw err(400, 'Không mở được mục này — chọn lại từ danh sách.');
          };
          if (kind === 'profile') {
            return changed(conn.prepare('UPDATE profiles SET body = ?, updated_at_ms = ? WHERE scope = ? AND account_id = ?')
              .run(body, stamp, String(scope), acc));
          }
          if (kind === 'fact') {
            return changed(conn.prepare('UPDATE facts SET content = ?, updated_at_ms = ? WHERE fact_id = ? AND scope = ? AND account_id = ?')
              .run(body.slice(0, 2000), stamp, Number(raw), String(scope), acc));
          }
          if (kind === 'soft') {
            return changed(conn.prepare('UPDATE soft_memories SET body = ?, updated_at_ms = ? WHERE id = ? AND scope = ? AND account_id = ?')
              .run(body, stamp, Number(raw), String(scope), acc));
          }
          throw err(400, 'Không mở được mục này — chọn lại từ danh sách.');
        });
      },
      /** Xoá một mục (fact thì đánh dấu `deleted`, giữ dòng để tra lại lịch sử — như tầng §20). */
      async remove(scope, id) {
        need(scope, role);
        const stamp = now();
        return withDb((conn) => {
          const acc = resolveAccount(conn);
          if (!acc) throw err(404, 'Chưa có kho trí nhớ — bot chạy lần đầu sẽ tạo.');
          const [kind, raw] = String(id ?? '').split(':');
          const changed = (info) => {
            if (Number(info.changes) > 0) return true;
            throw err(400, 'Không mở được mục này — chọn lại từ danh sách.');
          };
          if (kind === 'profile') {
            return changed(conn.prepare('DELETE FROM profiles WHERE scope = ? AND account_id = ?').run(String(scope), acc));
          }
          if (kind === 'fact') {
            return changed(conn.prepare("UPDATE facts SET status = 'deleted', updated_at_ms = ? WHERE fact_id = ? AND scope = ? AND account_id = ?")
              .run(stamp, Number(raw), String(scope), acc));
          }
          if (kind === 'soft') {
            return changed(conn.prepare('DELETE FROM soft_memories WHERE id = ? AND scope = ? AND account_id = ?')
              .run(Number(raw), String(scope), acc));
          }
          throw err(400, 'Chỉ xoá được từng mục — chọn lại từ danh sách.');
        });
      },
      /** Xoá nhiều mục: trả `{ done, failed }` (mỗi mục một lệnh, không nguyên tử). */
      async removeMany(scope, ids) {
        need(scope, role);
        if (!Array.isArray(ids) || !ids.length) throw err(400, 'Chưa chọn mục nào.');
        if (ids.length > MAX_BULK) throw err(400, `Tối đa ${MAX_BULK} mục mỗi lần.`);
        const done = [];
        const failed = [];
        for (const id of [...new Set(ids.map((x) => String(x ?? '')))]) {
          try { await this.remove(scope, id); done.push(id); } catch (e) { failed.push({ id, error: e?.message || 'Lỗi' }); }
        }
        return { done, failed };
      },
      /** "Quên hẳn" một nhóm/người: xoá facts + hồ sơ + trí nhớ mềm + chủ đề của đúng phạm vi (tin thô giữ nguyên). */
      async forget(scope) {
        need(scope, role);
        return withDb((conn) => forgetScopeFacts(conn, scope, resolveAccount(conn)));
      },
      /** Chỉ Quản trị: xin worker gói/trích ngay (worker đọc cờ này ở vòng kế tiếp), 3 lần/kho/ngày. */
      async extractNow(scope) {
        if (role !== 'admin') throw err(403, 'Chỉ Quản trị được rút trí nhớ ngay.');
        need(scope, role);
        const day = vnDay(now());
        const used = (extractLog.get(scope) || []).filter((ms) => vnDay(ms) === day);
        if (used.length >= EXTRACT_NOW_PER_DAY) throw err(429, `Kho này đã rút ngay ${EXTRACT_NOW_PER_DAY} lần hôm nay — trợ lý vẫn tự chạy theo chu kỳ.`);
        writeJsonAtomic(`${settingsFile}.now`, { scope, at: now(), version: 1 });
        extractLog.set(scope, [...used, now()]);
        return { queued: true, left: EXTRACT_NOW_PER_DAY - used.length - 1 };
      },
    };
  }

  return {
    status() { const { enabled, reason, note } = status(); return { enabled, reason, note }; },
    as,
    settings() { return readMemorySettings(settingsFile); },
    /** Chỉ Quản trị (route kiểm): đổi chu kỳ; worker đọc lại tệp ngay vòng sau, không cần khởi động lại. */
    setSettings({ extractMinutes } = {}) {
      const m = extractMinutes;
      if (typeof m !== 'number' || !Number.isInteger(m) || m < EXTRACT_MIN || m > EXTRACT_MAX) {
        throw err(400, `Chu kỳ rút trí nhớ là số phút từ ${EXTRACT_MIN} đến ${EXTRACT_MAX}.`);
      }
      writeJsonAtomic(settingsFile, { version: 1, topicQuietMinutes: m });
      return readMemorySettings(settingsFile);
    },
  };
}
