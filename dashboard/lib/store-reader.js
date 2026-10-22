/**
 * Đọc lịch sử chat của bot từ <sidecar>/data/zalo.sqlite — CHỈ ĐỌC (spec §5.1, §11.4).
 * SQLite chạy WAL nên đọc song song được khi bot đang ghi, và vẫn đọc được khi bot tắt.
 * Không bao giờ tạo tệp: bot chưa chạy lần nào thì ném StoreUnavailable.
 */
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fold, indexOfFolded } from '../public/fold.js';
import { classifyMedia, linksOf, NOT_LINK_TYPES } from '../public/media.js';
import { groupInsightQuery, groupTranscriptQuery } from './insight.js';

export const LOGIN_CODE_PREFIX = 'Mã đăng nhập dashboard:';
const SECRET = `${LOGIN_CODE_PREFIX}%`;
const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
const END = Number.MAX_SAFE_INTEGER;
const SENDER_WINDOW_MS = 30 * DAY_MS;

export class StoreUnavailable extends Error {
  constructor() { super('Chưa có lịch sử trò chuyện'); this.name = 'StoreUnavailable'; }
}

/** Mốc 0 giờ hôm nay theo giờ Việt Nam (UTC+7, không có giờ mùa hè). */
export function startOfDayVN(nowMs) {
  return Math.floor((nowMs + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
}

/** Con trỏ trang "<timestamp_ms>:<rowid>"; sai dạng → null. */
export function parseCursor(value) {
  const match = /^(\d{1,16}):(\d{1,16})$/.exec(String(value ?? ''));
  return match ? { ts: Number(match[1]), id: Number(match[2]) } : null;
}

const pageSize = (n, max, dflt) => {
  const x = Number.parseInt(n, 10);
  return Number.isInteger(x) ? Math.min(Math.max(x, 1), max) : dflt;
};

function toMessage(r) {
  return { id: Number(r.id), senderName: r.sender_name, text: r.text, msgType: r.msg_type, ts: Number(r.timestamp_ms), isSelf: Boolean(r.is_self) };
}

/**
 * Câu hỏi nóng, xuất ra để test kiểm EXPLAIN QUERY PLAN trên chính câu thật.
 * "+account_id" tắt chỉ mục theo tài khoản: khi chưa ANALYZE, SQLite sẽ chọn idx_messages_thread_time
 * (account_id = ?) và quét mọi tin của tài khoản. Bỏ nó đi thì chỉ còn idx_messages_retention:
 * - số liệu hôm nay (gọi mỗi 3 s) chỉ đọc tin từ 0 giờ;
 * - tìm kiếm đi ngược từ tin mới nhất, dừng khi đủ một trang — không gom hết tin trùng rồi sắp xếp.
 */
export const SQL = {
  todayTotals: `
    SELECT COALESCE(SUM(is_self = 0), 0) AS received, COALESCE(SUM(is_self = 1), 0) AS sent
    FROM messages WHERE +account_id = ? AND timestamp_ms >= ? AND text NOT LIKE ?`,
  // Tin nhận/gửi theo từng giờ trong ngày (giờ 0 = mốc đầu ngày truyền vào).
  todayHourly: `
    SELECT CAST((timestamp_ms - ?) / 3600000 AS INTEGER) AS h, COALESCE(SUM(is_self = 0), 0) AS received, COALESCE(SUM(is_self = 1), 0) AS sent
    FROM messages WHERE +account_id = ? AND timestamp_ms >= ? AND text NOT LIKE ? GROUP BY h`,
  // Số tin hôm nay của từng hội thoại (nhóm và nhắn riêng).
  todayByThread: `
    SELECT thread_type, thread_id, COUNT(*) AS n FROM messages
    WHERE +account_id = ? AND timestamp_ms >= ? AND text NOT LIKE ?
    GROUP BY thread_type, thread_id`,
  todayTop: `
    SELECT thread_id, COUNT(*) AS n FROM messages
    WHERE +account_id = ? AND thread_type = 1 AND timestamp_ms >= ? AND text NOT LIKE ?
    GROUP BY thread_id ORDER BY n DESC, thread_id LIMIT 5`,
  search: (match) => `
    SELECT rowid AS id, thread_id, thread_type, sender_name, text, msg_type, timestamp_ms, is_self FROM messages
    WHERE +account_id = ? AND ${match} AND text NOT LIKE ?
      AND timestamp_ms <= ? AND (timestamp_ms < ? OR rowid < ?)
    ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?`,
};

// Câu trong một hội thoại: đi theo idx_messages_thread_time (account_id, thread_type, thread_id, timestamp_ms),
// mới nhất trước, dừng khi đủ trang. Con trỏ cùng dạng với getMessages: "<timestamp_ms>:<rowid>".
const THREAD_WHERE = 'account_id = ? AND thread_type = ? AND thread_id = ? AND text NOT LIKE ?';
const COLS = 'rowid AS id, sender_name, text, msg_type, timestamp_ms, is_self';
const OLDER = 'timestamp_ms <= ? AND (timestamp_ms < ? OR rowid < ?)';
const quoted = (list) => list.map((x) => `'${x}'`).join(', ');
export const MEDIA_MATCH = {
  photo: "msg_type IN ('chat.photo', 'chat.video.msg')",
  file: "msg_type = 'share.file'",
  link: `msg_type NOT IN (${quoted(NOT_LINK_TYPES)}) AND text LIKE '%https://%'`,
};
export const THREAD_SQL = {
  search: (match) => `
    SELECT ${COLS} FROM messages
    WHERE ${THREAD_WHERE} AND ${match} AND ${OLDER}
    ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?`,
  media: (kind) => `
    SELECT ${COLS} FROM messages
    WHERE ${THREAD_WHERE} AND ${MEDIA_MATCH[kind]} AND ${OLDER}
    ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?`,
  // Phía cũ của một mốc, gồm cả chính mốc (rowid <= ?).
  upTo: `
    SELECT ${COLS} FROM messages
    WHERE ${THREAD_WHERE} AND timestamp_ms <= ? AND (timestamp_ms < ? OR rowid <= ?)
    ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?`,
  // Phía mới hơn một mốc (không gồm mốc), cũ trước.
  after: `
    SELECT ${COLS} FROM messages
    WHERE ${THREAD_WHERE} AND timestamp_ms >= ? AND (timestamp_ms > ? OR rowid > ?)
    ORDER BY timestamp_ms ASC, rowid ASC LIMIT ?`,
};
export const SEARCH_MATCH = { fold: 'instr(zd_fold(text), ?) > 0', like: "text LIKE ? ESCAPE '\\'" };

const MEDIA_ROUNDS = 20;
const who = (r) => ({ senderName: r.sender_name, isSelf: Boolean(r.is_self), ts: Number(r.timestamp_ms) });

/** Một dòng tin → các mục của bảng Ảnh/Video · Tệp · Link (không bao giờ có senderUid). */
export function mediaItems(kind, r) {
  const base = { msgId: Number(r.id), ...who(r) };
  if (kind === 'link') return linksOf(r.msg_type, r.text).map((l, i) => ({ id: `${r.id}:${i}`, ...base, ...l }));
  const m = classifyMedia(r.msg_type, r.text);
  if (!m) return [];
  if (kind === 'file') return m.kind === 'file' ? [{ id: String(r.id), ...base, name: m.name, url: m.url, ext: m.ext }] : [];
  if (m.kind === 'photo' || m.kind === 'video') return [{ id: String(r.id), ...base, url: m.url, video: m.kind === 'video', caption: m.caption.slice(0, 300) }];
  return [];
}

const fileIdentity =(p) => { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; };

export function createStoreReader({
  path, caseFold = true, now = Date.now, identityCheckMs = 30_000, conversationsTtlMs = 10_000, statFile = fileIdentity,
}) {
  let db = null;
  let folding = false;
  let identity = null;
  let checkedAt = 0;
  let convCache = null; // { key, at, value } — danh sách hội thoại đệm ngắn, khỏi quét cả bảng mỗi lần giao diện hỏi

  function drop() {
    if (db) { try { db.close(); } catch { /* đã đóng */ } }
    db = null; convCache = null;
  }

  /** Tệp bị thay (khôi phục bản sao, cài lại) thì kết nối cũ vẫn trỏ vào inode cũ — kiểm tối đa 30 s/lần rồi mở lại. */
  function stale() {
    const t = now();
    if (t - checkedAt < identityCheckMs) return false;
    checkedAt = t;
    let id = null;
    try { id = statFile(path); } catch { /* tệp đã mất */ }
    return id !== identity;
  }

  function open() {
    if (db && !stale()) return db;
    drop();
    if (!path || !existsSync(path)) throw new StoreUnavailable();
    try { identity = statFile(path); } catch { throw new StoreUnavailable(); }
    checkedAt = now();
    const d = new DatabaseSync(path, { readOnly: true });
    // readOnly chỉ có từ Node 22.12 — query_only chặn mọi lệnh ghi trên mọi bản Node 22.
    d.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;');
    // database.function có từ Node 22.13; bản cũ hơn tìm bằng LIKE (chỉ không phân biệt hoa thường với chữ không dấu).
    folding = caseFold && typeof d.function === 'function';
    if (folding) d.function('zd_fold', { deterministic: true }, fold);
    db = d;
    return d;
  }

  /** Tài khoản Zalo của bot = tài khoản có tin mới nhất. */
  function account() {
    const row = open().prepare('SELECT account_id FROM messages ORDER BY timestamp_ms DESC LIMIT 1').get();
    return row ? row.account_id : null;
  }

  // Câu này gom cả bảng (~1 s với 200k tin) — đệm conversationsTtlMs theo tài khoản; gửi tay xong thì xoá đệm.
  function listConversations({ limit } = {}) {
    const acc = account();
    if (!acc) return [];
    const size = pageSize(limit, 300, 300);
    const key = `${acc}\n${size}`;
    if (convCache && convCache.key === key && now() - convCache.at < conversationsTtlMs) return convCache.value;
    const value = readConversations(acc, size);
    convCache = { key, at: now(), value };
    return value;
  }

  function readConversations(acc, size) {
    const d = open();
    const threads = d.prepare(`
      SELECT thread_id, thread_type, MAX(timestamp_ms) AS last_at, COUNT(*) AS total
      FROM messages WHERE account_id = ? AND text NOT LIKE ?
      GROUP BY thread_type, thread_id
      ORDER BY last_at DESC LIMIT ?
    `).all(acc, SECRET, size);
    const last = d.prepare(`
      SELECT text, msg_type, is_self FROM messages
      WHERE account_id = ? AND thread_type = ? AND thread_id = ? AND text NOT LIKE ?
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT 1
    `);
    const peer = d.prepare(`
      SELECT sender_name FROM messages
      WHERE account_id = ? AND thread_type = 0 AND thread_id = ? AND is_self = 0 AND sender_name <> ''
      ORDER BY timestamp_ms DESC LIMIT 1
    `);
    return threads.map((t) => {
      const type = Number(t.thread_type);
      const l = last.get(acc, type, t.thread_id, SECRET);
      return {
        threadId: t.thread_id, threadType: type, lastAtMs: Number(t.last_at), total: Number(t.total),
        lastText: l ? String(l.text).slice(0, 200) : '', lastMsgType: l?.msg_type || '', lastIsSelf: Boolean(l?.is_self),
        peerName: type === 0 ? (peer.get(acc, t.thread_id)?.sender_name || '') : '',
      };
    });
  }

  function getMessages(threadId, threadType, { before = null, limit } = {}) {
    const acc = account();
    if (!acc) return { messages: [], nextBefore: null };
    const size = pageSize(limit, 100, 50);
    const c = before ? parseCursor(before) : null;
    const rows = open().prepare(`
      SELECT rowid AS id, sender_name, text, msg_type, timestamp_ms, is_self FROM messages
      WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND text NOT LIKE ?
        AND (timestamp_ms < ? OR (timestamp_ms = ? AND rowid < ?))
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?
    `).all(acc, String(threadId), Number(threadType), SECRET, c?.ts ?? END, c?.ts ?? END, c?.id ?? END, size + 1);
    const page = rows.slice(0, size);
    const oldest = page[page.length - 1];
    const nextBefore = rows.length > size ? `${oldest.timestamp_ms}:${oldest.id}` : null;
    return { messages: page.reverse().map(toMessage), nextBefore };
  }

  function searchMessages(query, { before = null, limit } = {}) {
    const acc = account();
    if (!acc) return { results: [], nextBefore: null };
    const d = open();
    const size = pageSize(limit, 50, 30);
    const c = before ? parseCursor(before) : null;
    const match = folding ? SEARCH_MATCH.fold : SEARCH_MATCH.like;
    const needle = folding ? fold(query) : `%${String(query).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = d.prepare(SQL.search(match)).all(acc, needle, SECRET, c?.ts ?? END, c?.ts ?? END, c?.id ?? END, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return {
      results: page.map((r) => ({ ...toMessage(r), threadId: r.thread_id, threadType: Number(r.thread_type), text: String(r.text).slice(0, 300) })),
      nextBefore: rows.length > size ? `${last.timestamp_ms}:${last.id}` : null,
    };
  }

  const cursorOf = (r) => `${r.timestamp_ms}:${r.id}`;
  const threadArgs = (acc, threadId, threadType) => [acc, Number(threadType), String(threadId), SECRET];
  const needleOf = (query) => (folding ? fold(query) : `%${String(query).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);

  /** Tin mới hơn con trỏ (cuộn xuống sau khi nhảy tới một tin cũ), cũ trước. */
  function getMessagesAfter(threadId, threadType, after, { limit } = {}) {
    const acc = account();
    if (!acc) return { messages: [], nextAfter: null };
    const size = pageSize(limit, 100, 50);
    const c = parseCursor(after);
    const rows = open().prepare(THREAD_SQL.after).all(...threadArgs(acc, threadId, threadType), c.ts, c.ts, c.id, size + 1);
    const page = rows.slice(0, size);
    return { messages: page.map(toMessage), nextAfter: rows.length > size ? cursorOf(page[page.length - 1]) : null };
  }

  /** Trang quanh một tin (kết quả tìm): chừng `limit` tin mỗi phía, kèm con trỏ đi tiếp hai chiều. */
  function getMessagesAround(threadId, threadType, around, { limit } = {}) {
    const acc = account();
    if (!acc) return { messages: [], nextBefore: null, nextAfter: null };
    const size = pageSize(limit, 50, 25);
    const c = parseCursor(around);
    const d = open();
    const older = d.prepare(THREAD_SQL.upTo).all(...threadArgs(acc, threadId, threadType), c.ts, c.ts, c.id, size + 2);
    const oldPage = older.slice(0, size + 1); // chính tin đó + `size` tin cũ hơn
    const newer = getMessagesAfter(threadId, threadType, around, { limit: size });
    const oldest = oldPage[oldPage.length - 1];
    return {
      messages: [...oldPage.reverse().map(toMessage), ...newer.messages],
      nextBefore: older.length > size + 1 ? cursorOf(oldest) : null,
      nextAfter: newer.nextAfter,
    };
  }

  /** Tìm trong một hội thoại: cùng cách gấp chữ với tìm toàn văn, mới nhất trước. */
  function searchThread(threadId, threadType, query, { before = null, limit } = {}) {
    const acc = account();
    if (!acc) return { results: [], nextBefore: null };
    const size = pageSize(limit, 50, 30);
    const c = before ? parseCursor(before) : null;
    const sql = THREAD_SQL.search(folding ? SEARCH_MATCH.fold : SEARCH_MATCH.like);
    const [a, type, id, secret] = threadArgs(acc, threadId, threadType);
    const rows = open().prepare(sql).all(a, type, id, secret, needleOf(query), c?.ts ?? END, c?.ts ?? END, c?.id ?? END, size + 1);
    const page = rows.slice(0, size);
    return {
      results: page.map((r) => ({ ...toMessage(r), text: excerpt(String(r.text), query) })),
      nextBefore: rows.length > size ? cursorOf(page[page.length - 1]) : null,
    };
  }

  /** 300 ký tự quanh chỗ trùng (tin dài mà chỗ trùng nằm sâu thì vẫn thấy được chỗ tô sáng). */
  function excerpt(text, query) {
    const at = folding ? indexOfFolded(text, query) : text.toLowerCase().indexOf(String(query).toLowerCase());
    const from = at > 120 ? at - 60 : 0;
    return `${from ? '…' : ''}${text.slice(from, from + 300)}`;
  }

  /**
   * Ảnh/video, tệp hoặc link của một hội thoại, mới nhất trước. Link lấy từ chữ nên một tin có thể ra 0..n mục:
   * đọc từng lô cho tới khi đủ trang (tối đa MEDIA_ROUNDS lô một lần gọi, còn nữa thì trả con trỏ đi tiếp).
   */
  function listMedia(threadId, threadType, kind, { before = null, limit } = {}) {
    const acc = account();
    if (!acc) return { items: [], nextBefore: null };
    const size = pageSize(limit, 60, 30);
    const batch = size + 1;
    const stmt = open().prepare(THREAD_SQL.media(kind));
    const c = before ? parseCursor(before) : null;
    let cur = c ? { ts: c.ts, id: c.id } : { ts: END, id: END };
    const items = [];
    for (let round = 0; round < MEDIA_ROUNDS; round += 1) {
      const rows = stmt.all(...threadArgs(acc, threadId, threadType), cur.ts, cur.ts, cur.id, batch);
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        cur = { ts: Number(r.timestamp_ms), id: Number(r.id) };
        items.push(...mediaItems(kind, r));
        if (items.length >= size) {
          const more = i < rows.length - 1 || rows.length === batch;
          return { items, nextBefore: more ? `${cur.ts}:${cur.id}` : null };
        }
      }
      if (rows.length < batch) return { items, nextBefore: null };
    }
    return { items, nextBefore: `${cur.ts}:${cur.id}` };
  }

  function hasThread(threadId, threadType) {
    const acc = account();
    if (!acc) return false;
    return Boolean(open().prepare('SELECT 1 FROM messages WHERE account_id = ? AND thread_type = ? AND thread_id = ? LIMIT 1')
      .get(acc, Number(threadType), String(threadId)));
  }

  /** Chủ đề nhỏ của MỘT hội thoại (spec §20.2): tên + tóm tắt cho giao diện và API. Kho cũ chưa nâng cấp → rỗng. */
  function topicsOf(threadId, threadType, { limit = 30 } = {}) {
    const acc = account();
    if (!acc) return [];
    try {
      return open().prepare(`
        SELECT topic_id, title, abstract, status, first_ts_ms, last_ts_ms, message_count
        FROM topics WHERE account_id = ? AND thread_id = ? AND thread_type = ?
        ORDER BY status = 'open' DESC, last_ts_ms DESC LIMIT ?
      `).all(acc, String(threadId), Number(threadType), Math.min(Math.max(Number(limit) || 30, 1), 100))
        .map((r) => ({
          topicId: Number(r.topic_id), title: r.title, abstract: r.abstract, status: r.status,
          firstTsMs: Number(r.first_ts_ms), lastTsMs: Number(r.last_ts_ms), messageCount: Number(r.message_count),
        }));
    } catch { return []; }
  }
  function todayStats(sinceMs) {
    const acc = account();
    if (!acc) return { received: 0, sent: 0, hourly: Array.from({ length: 24 }, () => 0), topGroups: [] };
    const d = open();
    const totals = d.prepare(SQL.todayTotals).get(acc, sinceMs, SECRET);
    const top = d.prepare(SQL.todayTop).all(acc, sinceMs, SECRET);
    const hourly = Array.from({ length: 24 }, () => 0);
    for (const row of d.prepare(SQL.todayHourly).all(sinceMs, acc, sinceMs, SECRET)) {
      const h = Number(row.h);
      if (h >= 0 && h < 24) hourly[h] = Number(row.received) + Number(row.sent);
    }
    const threads = d.prepare(SQL.todayByThread).all(acc, sinceMs, SECRET).length;
    return { received: Number(totals.received), sent: Number(totals.sent), threads, hourly, topGroups: top.map((g) => ({ threadId: g.thread_id, count: Number(g.n) })) };
  }

  /** `Map("<loại>:<id>" → số tin hôm nay)` cho danh sách Phiên chat. */
  function todayCounts(sinceMs) {
    const acc = account();
    const out = new Map();
    if (!acc) return out;
    for (const r of open().prepare(SQL.todayByThread).all(acc, sinceMs, SECRET)) out.set(`${Number(r.thread_type)}:${r.thread_id}`, Number(r.n));
    return out;
  }

  function senderNames(uids) {
    const list = [...new Set([...uids].map(String))].filter((u) => /^\d{1,32}$/.test(u)).slice(0, 200);
    const acc = account();
    if (!list.length || !acc) return new Map();
    const d = open();
    const names = new Map();
    // 1) Người từng nhắn riêng: tin mới nhất của họ trong hội thoại riêng — tra thẳng idx_messages_thread_time.
    const dm = d.prepare(`
      SELECT sender_name FROM messages
      WHERE account_id = ? AND thread_type = 0 AND thread_id = ? AND is_self = 0 AND sender_uid = thread_id AND sender_name <> ''
      ORDER BY timestamp_ms DESC LIMIT 1
    `);
    for (const uid of list) {
      const row = dm.get(acc, uid);
      if (row) names.set(uid, row.sender_name);
    }
    // 2) Còn lại (chỉ nhắn trong nhóm): chỉ xét SENDER_WINDOW_MS tính lùi từ tin mới nhất (bot tắt lâu vẫn có tên),
    // đi theo idx_messages_retention. SQLite: cột thường đi cùng MAX() lấy giá trị ở đúng dòng có MAX — tức tên mới nhất.
    const rest = list.filter((u) => !names.has(u));
    if (rest.length) {
      const newest = Number(d.prepare('SELECT MAX(timestamp_ms) AS ts FROM messages').get().ts) || 0;
      const rows = d.prepare(`
        SELECT sender_uid, sender_name, MAX(timestamp_ms) AS last_at FROM messages
        WHERE +account_id = ? AND timestamp_ms >= ? AND is_self = 0 AND sender_name <> ''
          AND sender_uid IN (${rest.map(() => '?').join(', ')})
        GROUP BY sender_uid
      `).all(acc, newest - SENDER_WINDOW_MS, ...rest);
      for (const r of rows) names.set(r.sender_uid, r.sender_name);
    }
    return names;
  }

  function listAudit({ beforeMs = END, limit = 70, failedOnly = false } = {}) {
    // Chỉ tài khoản bot đang dùng (cùng quy ước với Phiên chat), kèm dòng chưa gắn tài khoản (lỗi trước khi đăng nhập).
    const acc = account() ?? '';
    // Không chọn target_summary: cột đó có thể chứa nội dung tin (kể cả mã đăng nhập).
    const rows = open().prepare(`
      SELECT id, created_at_ms, actor_uid, actor_role, action, category, thread_id, thread_type, status, error
      FROM audit_log
      WHERE account_id IN (?, '') AND status IN ('succeeded', 'failed') AND action NOT IN ('typing', 'ack_message')
        AND (? = 0 OR status = 'failed') AND created_at_ms < ?
      ORDER BY created_at_ms DESC, id DESC LIMIT ?
    `).all(acc, failedOnly ? 1 : 0, Number(beforeMs), pageSize(limit, 300, 70));
    return rows.map((r) => ({
      id: Number(r.id), at: Number(r.created_at_ms), actorUid: r.actor_uid, actorRole: r.actor_role,
      action: r.action, category: r.category, threadId: r.thread_id,
      threadType: r.thread_type == null ? null : Number(r.thread_type),
      ok: r.status === 'succeeded', error: r.error || null,
    }));
  }

  return {
    available: () => Boolean(db) || Boolean(path && existsSync(path)),
    isReadOnly: () => Number(open().prepare('PRAGMA query_only').get().query_only) === 1,
    listConversations,
    getMessages,
    searchMessages,
    getMessagesAfter,
    getMessagesAround,
    searchThread,
    listMedia,
    hasThread,
    topicsOf,
    todayStats,
    todayCounts,
    senderNames,
    /**
     * Người từng nhắn trong nhóm (kể cả tin đã thu hồi), mới nhắn trước, kèm tên gần nhất — bù cho danh sách thành viên
     * Zalo giấu (nhóm cộng đồng chỉ trả trưởng/phó khi bot không phải quản trị).
     */
    groupSenders(threadId, limit = 500) {
      const acc = account();
      if (!acc) return [];
      return open().prepare(`
        SELECT m.sender_uid AS uid, m.sender_name AS name FROM messages m
        JOIN (SELECT sender_uid, MAX(timestamp_ms) AS ts FROM messages
              WHERE account_id = ? AND thread_type = 1 AND thread_id = ? AND is_self = 0 AND sender_uid <> '' AND sender_name <> ''
              GROUP BY sender_uid) last ON last.sender_uid = m.sender_uid AND last.ts = m.timestamp_ms
        WHERE m.account_id = ? AND m.thread_type = 1 AND m.thread_id = ? AND m.is_self = 0 AND m.sender_name <> ''
        GROUP BY m.sender_uid ORDER BY last.ts DESC LIMIT ?
      `).all(acc, String(threadId), acc, String(threadId), Math.min(Math.max(Number(limit) || 0, 1), 2000))
        .map((r) => ({ uid: String(r.uid), name: String(r.name) }));
    },
    listAudit,
    /**
     * Tin để trích dẫn khi trả lời từ dashboard (theo rowid, đúng hội thoại). Chỉ máy chủ dùng — UID người gửi không
     * bao giờ ra trình duyệt. Tin chưa có msgId Zalo (bản nhập từ lịch sử cũ) → null.
     */
    messageRef(threadId, threadType, rowid) {
      const acc = account();
      if (!acc || !Number.isSafeInteger(Number(rowid))) return null;
      const r = open().prepare(`
        SELECT msg_id, cli_msg_id, sender_uid, sender_name, text, msg_type, timestamp_ms, is_self FROM messages
        WHERE rowid = ? AND account_id = ? AND thread_id = ? AND thread_type = ? AND text NOT LIKE ?
      `).get(Number(rowid), acc, String(threadId), Number(threadType), SECRET);
      if (!r || !r.msg_id) return null;
      return { msgId: String(r.msg_id), cliMsgId: String(r.cli_msg_id || ''), senderUid: String(r.sender_uid || ''), senderName: r.sender_name || '',
        text: String(r.text || ''), msgType: r.msg_type || '', ts: Number(r.timestamp_ms), isSelf: Boolean(r.is_self) };
    },
    /** Insight nhóm (spec §18.5): số liệu N ngày của một nhóm; chưa có tin nào của bot → null. */
    groupInsight(threadId, opts = {}) {
      const acc = account();
      return acc ? groupInsightQuery(open(), acc, threadId, { ...opts, secretLike: SECRET }) : null;
    },
    /** Đoạn hội thoại (đã bỏ mã đăng nhập, không đường dẫn ảnh/tệp) để AI tóm tắt chủ đề. */
    groupTranscript(threadId, opts = {}) {
      const acc = account();
      return acc ? groupTranscriptQuery(open(), acc, threadId, { ...opts, secretLike: SECRET }) : '';
    },
    /** UID người gửi theo rowid (gắn ảnh đại diện vào tin ở máy chủ — UID không ra trình duyệt). */
    senderUidsOf(threadId, threadType, rowids) {
      const acc = account();
      const ids = [...new Set((rowids || []).map(Number))].filter(Number.isSafeInteger).slice(0, 500);
      const out = new Map();
      if (!acc || !ids.length) return out;
      const rows = open().prepare(`
        SELECT rowid AS id, sender_uid AS uid FROM messages
        WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND is_self = 0 AND sender_uid <> ''
          AND rowid IN (${ids.map(() => '?').join(',')})
      `).all(acc, String(threadId), Number(threadType), ...ids);
      for (const r of rows) out.set(Number(r.id), String(r.uid));
      return out;
    },
    /** Tin theo mã Zalo (tin ghim của bảng tin) → `{ id, ts }` để nhảy tới; không có trong lịch sử → null. */
    findByMsgId(threadId, threadType, msgId, cliMsgId = '') {
      const acc = account();
      const ok = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
      if (!acc || !(ok(msgId) || ok(cliMsgId))) return null;
      const r = open().prepare(`
        SELECT rowid AS id, timestamp_ms AS ts FROM messages
        WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND (msg_id = ? OR (? <> '' AND cli_msg_id = ?)) AND text NOT LIKE ?
        LIMIT 1
      `).get(acc, String(threadId), Number(threadType), String(msgId || '-'), String(cliMsgId || ''), String(cliMsgId || ''), SECRET);
      return r ? { id: Number(r.id), ts: Number(r.ts) } : null;
    },
    /** Gửi tay thành công → danh sách hội thoại phải hiện tin vừa gửi ngay, không chờ hết hạn đệm. */
    invalidateConversations() { convCache = null; },
    close: drop,
  };
}
