import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fold } from './dashboard/public/fold.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Tin chứa mã đăng nhập dashboard (server.js gửi với remember:false, nhưng bản cũ từng lưu lại) — không bao giờ trả cho công cụ.
export const LOGIN_CODE_MARK = 'Mã đăng nhập dashboard:';
// Tra lịch sử cho thành viên (spec §19.5): quét tối đa chừng này tin gần nhất trong khoảng thời gian (theo trang
// HISTORY_SEARCH_PAGE, đủ tin thì dừng), trả tối đa 40 tin.
export const HISTORY_SEARCH_PAGE = 500;
export const HISTORY_SEARCH_SCAN = 5_000;
export const HISTORY_SEARCH_MAX = 40;
// Trợ lý biết chuyện (spec §20, bản 2.51.0): mỗi hội thoại chia chủ đề nhỏ (topics), tri thức bot tự rút ra
// thành các "fact" có gốc tin nhắn (provenance) và thời hạn hiệu lực (supersede/expire). Tất cả khoá theo
// (account_id, scope) trùng công thức phạm vi của provider zalo_memory — nhóm này không bao giờ rò sang nhóm khác.
export const FACT_KINDS = ['preference', 'entity', 'decision', 'task', 'deadline', 'event', 'owner_note'];
export const FACT_STATUSES = ['active', 'superseded', 'expired', 'deleted', 'contradiction'];
const SCOPE_RE = /^zalo-(g|u)-\d{1,32}$/;
// Trần nội dung fact và trần kết quả recall/search của fact (spec §20.6) — recall OV bị trần riêng của nó.
export const FACT_CONTENT_MAX = 300;
export const FACT_RECALL_MAX = 12;
// Tầng "bộ nhớ chính" thuần SQLite (spec §21): hồ sơ gộp và trí nhớ mềm.
export const PROFILE_MAX_CHARS = 2000;
export const SOFT_MAX_CHARS = 400;

function text(value) {
  return value == null ? '' : String(value);
}

function nullableText(value) {
  return value == null || value === '' ? null : String(value);
}

export function messageKey(accountId, message) {
  const msgId = nullableText(message.msgId);
  const cliMsgId = nullableText(message.cliMsgId);
  if (msgId || cliMsgId) {
    return [accountId, message.threadType, message.threadId, msgId || '', cliMsgId || ''].join(':');
  }
  return createHash('sha256').update(JSON.stringify([
    accountId, Number(message.threadType), text(message.threadId), text(message.senderUid),
    Number(message.ts) || 0, text(message.msgType), text(message.text),
  ])).digest('hex');
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function mapMessage(row) {
  return {
    threadId: row.thread_id,
    threadType: row.thread_type,
    msgId: row.msg_id,
    cliMsgId: row.cli_msg_id,
    senderUid: row.sender_uid,
    senderName: row.sender_name,
    text: row.text,
    msgType: row.msg_type,
    ts: row.timestamp_ms,
    isSelf: Boolean(row.is_self),
    source: row.source,
    ...(row.topic_id === undefined ? {} : { topicId: row.topic_id }),
  };
}

function repairDuplicateAliases(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const column of ['msg_id', 'cli_msg_id']) {
      const duplicates = db.prepare(`
        SELECT account_id, thread_id, thread_type, ${column} AS alias
        FROM messages
        WHERE ${column} IS NOT NULL AND ${column} <> ''
        GROUP BY account_id, thread_id, thread_type, ${column}
        HAVING COUNT(*) > 1
      `).all();
      const selectRows = db.prepare(`
        SELECT * FROM messages
        WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND ${column} = ?
        ORDER BY
          (cli_msg_id IS NOT NULL AND cli_msg_id <> '') DESC,
          (msg_id IS NOT NULL AND msg_id <> '') DESC,
          (source = 'live') DESC,
          LENGTH(text) DESC,
          updated_at_ms DESC
      `);
      const updateWinner = db.prepare(`
        UPDATE messages SET
          msg_id = ?, cli_msg_id = ?, sender_uid = ?, sender_name = ?, text = ?,
          msg_type = ?, timestamp_ms = ?, is_self = ?, source = ?,
          created_at_ms = ?, updated_at_ms = ?
        WHERE identity_key = ?
      `);
      const deleteRow = db.prepare('DELETE FROM messages WHERE identity_key = ?');

      for (const duplicate of duplicates) {
        const rows = selectRows.all(
          duplicate.account_id, duplicate.thread_id, duplicate.thread_type, duplicate.alias,
        );
        const winner = rows[0];
        const longestText = [...rows].sort((left, right) => right.text.length - left.text.length)[0].text;
        const firstText = (field) => rows.find((row) => row[field])?.[field] || '';
        updateWinner.run(
          firstText('msg_id') || null,
          firstText('cli_msg_id') || null,
          firstText('sender_uid'),
          firstText('sender_name'),
          longestText,
          firstText('msg_type'),
          winner.timestamp_ms,
          rows.some((row) => row.is_self) ? 1 : 0,
          rows.some((row) => row.source === 'live') ? 'live' : winner.source,
          Math.min(...rows.map((row) => row.created_at_ms)),
          Math.max(...rows.map((row) => row.updated_at_ms)),
          winner.identity_key,
        );
        for (const loser of rows.slice(1)) deleteRow.run(loser.identity_key);
      }
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msg_alias
        ON messages(account_id, thread_id, thread_type, msg_id)
        WHERE msg_id IS NOT NULL AND msg_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_cli_alias
        ON messages(account_id, thread_id, thread_type, cli_msg_id)
        WHERE cli_msg_id IS NOT NULL AND cli_msg_id <> '';
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openZaloStore({ path, retentionDays = 365, now = Date.now } = {}) {
  if (!path) throw new Error('SQLite path is required');
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS messages (
      identity_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL,
      msg_id TEXT,
      cli_msg_id TEXT,
      sender_uid TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      msg_type TEXT NOT NULL DEFAULT '',
      timestamp_ms INTEGER NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread_time
      ON messages(account_id, thread_type, thread_id, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_retention ON messages(timestamp_ms);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      actor_uid TEXT NOT NULL DEFAULT '',
      actor_role TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      thread_type INTEGER,
      status TEXT NOT NULL,
      target_summary TEXT,
      error TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id, id);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at_ms DESC);

    -- Dấu tin bot đã thu hồi (băm đầu nội dung, không lưu chữ): bản sao nhập lại từ Hermes cũ vào trắng luôn.
    CREATE TABLE IF NOT EXISTS recalled_heads (
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL,
      head_hash TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      PRIMARY KEY(account_id, thread_id, thread_type, head_hash)
    );

    CREATE TABLE IF NOT EXISTS backfill_state (
      account_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL,
      cursor_msg_id TEXT,
      status TEXT NOT NULL,
      pages_fetched INTEGER NOT NULL DEFAULT 0,
      messages_inserted INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(account_id, thread_type)
    );

    -- Chủ đề nhỏ trong từng hội thoại (spec §20.2). topic_id NULL trên messages = "Chung".
    CREATE TABLE IF NOT EXISTS topics (
      topic_id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      abstract TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      first_ts_ms INTEGER NOT NULL DEFAULT 0,
      last_ts_ms INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topics_thread ON topics(account_id, thread_type, thread_id, last_ts_ms DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_open ON topics(account_id, thread_id, thread_type) WHERE status = 'open';

    -- Tri thức rút ra theo phạm vi (spec §20.3): một dòng = một sự kiện rời rạc, có gốc tin nhắn và thời hạn hiệu lực.
    -- scope trùng công thức provider zalo_memory: zalo-g-<nhóm> | zalo-u-<người>. KHÔNG xoá cấp dòng — supersede/expired/deleted.
    CREATE TABLE IF NOT EXISTS facts (
      fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      source_msg_keys TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_from_ms INTEGER NOT NULL DEFAULT 0,
      valid_to_ms INTEGER,
      superseded_by INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      topic_id INTEGER,
      origin TEXT NOT NULL DEFAULT 'extract',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope, status, kind);
    CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(account_id, scope, kind, subject, status);

    -- Chỉ mục full-text cho fact (remove_diacritics 2 — "bao cao" khớp "báo cáo"); lọc phạm vi ở câu truy vấn.
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      content, subject, content='facts', content_rowid='fact_id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, subject) VALUES (new.fact_id, new.content, new.subject);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, subject) VALUES ('delete', old.fact_id, old.content, old.subject);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE OF content, subject ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, subject) VALUES ('delete', old.fact_id, old.content, old.subject);
      INSERT INTO facts_fts(rowid, content, subject) VALUES (new.fact_id, new.content, new.subject);
    END;

    -- Hàng đợi mâu thuẫn (spec §20.4): fact mới xung đột fact đang hiệu lực → giữ cả hai, người duyệt ở dashboard.
    CREATE TABLE IF NOT EXISTS contradictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      new_fact_id INTEGER NOT NULL,
      old_fact_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      resolved TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      UNIQUE(new_fact_id, old_fact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contradictions_open ON contradictions(scope, resolved, created_at_ms DESC);

    -- Hồ sơ theo phạm vi (spec §21.3): bản tóm tắt LLM tự gộp từ facts của chính phạm vi đó.
    -- Một dòng / một phạm vi; body là markdown ngắn; updated_at_ms cho biết độ mới.
    CREATE TABLE IF NOT EXISTS profiles (
      account_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      source_fact_ids TEXT NOT NULL DEFAULT '[]',
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(account_id, scope)
    );

    -- Trí nhớ mềm (spec §21.4): câu bot tự rút/gói ra không có schema cứng (sở thích, cách nói chuyện, mạch
    -- việc đang dở). Khác bảng facts ở chỗ không đòi kind/subject và không supersede — chỉ có tuổi thọ và độ liên quan.
    CREATE TABLE IF NOT EXISTS soft_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      source_msg_keys TEXT NOT NULL DEFAULT '[]',
      topic_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_soft_scope ON soft_memories(scope, status, updated_at_ms DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS soft_fts USING fts5(
      body, content='soft_memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS soft_ai AFTER INSERT ON soft_memories BEGIN
      INSERT INTO soft_fts(rowid, body) VALUES (new.id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS soft_ad AFTER DELETE ON soft_memories BEGIN
      INSERT INTO soft_fts(soft_fts, rowid, body) VALUES ('delete', old.id, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS soft_au AFTER UPDATE OF body ON soft_memories BEGIN
      INSERT INTO soft_fts(soft_fts, rowid, body) VALUES ('delete', old.id, old.body);
      INSERT INTO soft_fts(rowid, body) VALUES (new.id, new.body);
    END;
  `);
  // Cũ → mới: tệp đã có từ trước chưa có cột topic_id — ALTER chỉ khi cột chưa tồn tại.
  if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'topic_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN topic_id INTEGER');
  }
  repairDuplicateAliases(db);

  const upsertMessageStatement = db.prepare(`
    INSERT INTO messages (
      identity_key, account_id, thread_id, thread_type, msg_id, cli_msg_id,
      sender_uid, sender_name, text, msg_type, timestamp_ms, is_self, source,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(identity_key) DO UPDATE SET
      msg_id = COALESCE(excluded.msg_id, messages.msg_id),
      cli_msg_id = COALESCE(excluded.cli_msg_id, messages.cli_msg_id),
      sender_uid = excluded.sender_uid,
      sender_name = excluded.sender_name,
      -- Tin đã thu hồi giữ nguyên trạng thái: backfill/nhập lại không được khôi phục nội dung.
      -- Bản nhập từ Hermes cũ (prompt đã kẹp ngữ cảnh, trích dẫn) không bao giờ đè tin bắt trực tiếp từ Zalo.
      text = CASE WHEN messages.msg_type = 'chat.undo' THEN messages.text
        WHEN excluded.source = 'legacy-hermes' AND messages.source <> 'legacy-hermes' THEN messages.text
        ELSE excluded.text END,
      msg_type = CASE WHEN messages.msg_type = 'chat.undo' THEN messages.msg_type
        WHEN excluded.source = 'legacy-hermes' AND messages.source <> 'legacy-hermes' THEN messages.msg_type
        ELSE excluded.msg_type END,
      timestamp_ms = excluded.timestamp_ms,
      is_self = excluded.is_self,
      source = CASE WHEN messages.source = 'live' THEN messages.source ELSE excluded.source END,
      updated_at_ms = excluded.updated_at_ms
  `);

  function upsertMessage(accountId, message, source = 'live') {
    const timestamp = Number(message.ts);
    if (!accountId || !message?.threadId || !Number.isFinite(timestamp)) {
      throw new Error('Message requires accountId, threadId, and numeric ts');
    }
    const currentTime = Number(now());
    const msgId = nullableText(message.msgId);
    const cliMsgId = nullableText(message.cliMsgId);
    const alias = db.prepare(`
      SELECT identity_key FROM messages
      WHERE account_id = ? AND thread_id = ? AND thread_type = ?
        AND ((? IS NOT NULL AND msg_id = ?) OR (? IS NOT NULL AND cli_msg_id = ?))
      ORDER BY rowid LIMIT 1
    `).get(
      String(accountId), String(message.threadId), Number(message.threadType),
      msgId, msgId, cliMsgId, cliMsgId,
    );
    if (String(source) === 'legacy-hermes' && message.isSelf && isRecalledCopy(accountId, message.threadId, message.threadType, message.text, timestamp)) {
      message = { ...message, text: '', msgType: 'chat.undo' };
    }
    const generatedIdentityKey = messageKey(String(accountId), message);
    const identityKey = alias?.identity_key || generatedIdentityKey;
    const existed = Boolean(alias || db.prepare('SELECT 1 FROM messages WHERE identity_key = ?').get(identityKey));
    upsertMessageStatement.run(
      identityKey, String(accountId), String(message.threadId),
      Number(message.threadType), msgId, cliMsgId,
      text(message.senderUid), text(message.senderName), text(message.text), text(message.msgType),
      timestamp, message.isSelf ? 1 : 0, String(source), currentTime, currentTime,
    );
    return { inserted: !existed };
  }

  // Bản sao Hermes (legacy-hermes) của một tin sidecar đã tự ghi: cùng hội thoại, cùng chiều gửi, lệch dưới 3 phút.
  // Bản legacy còn nguyên Markdown/mã màu và không có msgId nên không gộp được theo identity — thành tin trùng.
  const TWIN_WINDOW_MS = 3 * 60_000;
  const liveTwinStatement = db.prepare(`
    SELECT 1 FROM messages
    WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND is_self = ? AND source = 'live'
      AND timestamp_ms BETWEEN ? AND ? LIMIT 1
  `);
  function hasLiveTwin(accountId, message) {
    const ts = Number(message.ts);
    return Boolean(liveTwinStatement.get(String(accountId), String(message.threadId), Number(message.threadType),
      message.isSelf ? 1 : 0, ts - TWIN_WINDOW_MS, ts + TWIN_WINDOW_MS));
  }

  // Xoá các bản sao legacy-hermes đã lỡ nhập mà có bản live song sinh. Tin legacy không có bản live (vd. lúc sidecar
  // không chạy) được giữ. Chạy lại không xoá thêm.
  function pruneLegacyOverlap(accountId) {
    const result = db.prepare(`
      DELETE FROM messages
      WHERE account_id = ? AND source = 'legacy-hermes' AND EXISTS (
        SELECT 1 FROM messages l
        WHERE l.account_id = messages.account_id AND l.thread_id = messages.thread_id AND l.thread_type = messages.thread_type
          AND l.is_self = messages.is_self AND l.source = 'live'
          AND l.timestamp_ms BETWEEN messages.timestamp_ms - ${TWIN_WINDOW_MS} AND messages.timestamp_ms + ${TWIN_WINDOW_MS}
      )
    `).run(String(accountId));
    return Number(result.changes);
  }

  function insertMessages(accountId, messages, source = 'backfill') {
    db.exec('BEGIN IMMEDIATE');
    let inserted = 0;
    try {
      for (const message of messages) {
        if (upsertMessage(accountId, message, source).inserted) inserted += 1;
      }
      db.exec('COMMIT');
      return inserted;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getHistory(accountId, threadId, threadType, count = 30) {
    const safeCount = Math.min(Math.max(Number(count) || 30, 1), 100);
    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE account_id = ? AND thread_id = ? AND thread_type = ?
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?
    `).all(String(accountId), String(threadId), Number(threadType), safeCount);
    return rows.reverse().map(mapMessage);
  }

  /**
   * Đọc tin của một hội thoại trong khoảng thời gian, cũ trước mới sau, có con
   * trỏ để lật trang.
   *
   * getHistory chỉ trả 100 tin gần nhất — đủ để trả lời một câu, không đủ để
   * tổng hợp cả ngày của một nhóm cộng đồng vài trăm người. Con trỏ là cặp
   * "thời điểm:rowid" của tin cuối trang, nên hai tin trùng mili-giây không bị
   * bỏ sót hay lặp lại giữa hai trang.
   */
  function getRange(accountId, threadId, threadType, { sinceMs = 0, untilMs = null, cursor = null, limit = 300 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 300, 1), 500);
    const until = untilMs == null ? Number.MAX_SAFE_INTEGER : Number(untilMs);
    let afterTs = -1;
    let afterRowid = -1;
    const match = /^(\d+):(\d+)$/.exec(String(cursor ?? ''));
    if (match) {
      afterTs = Number(match[1]);
      afterRowid = Number(match[2]);
    }
    const rows = db.prepare(`
      SELECT rowid AS cursor_rowid, * FROM messages
      WHERE account_id = ? AND thread_id = ? AND thread_type = ?
        AND timestamp_ms >= ? AND timestamp_ms < ?
        AND (timestamp_ms > ? OR (timestamp_ms = ? AND rowid > ?))
      ORDER BY timestamp_ms ASC, rowid ASC LIMIT ?
    `).all(
      String(accountId), String(threadId), Number(threadType),
      Number(sinceMs) || 0, until,
      afterTs, afterTs, afterRowid,
      safeLimit + 1,
    );
    const page = rows.slice(0, safeLimit);
    const last = page[page.length - 1];
    return {
      messages: page.map(mapMessage),
      nextCursor: rows.length > safeLimit && last ? `${last.timestamp_ms}:${last.cursor_rowid}` : null,
    };
  }

  function searchHistory(accountId, threadId, threadType, { query = '', sender = '', sinceMs = 0, limit = 20, topicId = null } = {}) {
    const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), HISTORY_SEARCH_MAX);
    const needle = fold(String(query ?? '').trim()).slice(0, 100);
    const who = fold(String(sender ?? '').trim()).slice(0, 60);
    // `topicId` = số nguyên (topic cụ thể) hoặc "chung" (chủ đề Chung — tin chưa gán). Tuỳ chọn, không có nghĩa là tìm khắp.
    const topic = topicId == null ? null : (String(topicId).trim() === 'chung' ? 'unassigned' : Math.trunc(Number(topicId)));
    if (topicId != null && topic !== 'unassigned' && !Number.isFinite(topic)) return { messages: [], scanned: 0, truncated: false };
    // Đi theo chỉ mục idx_messages_thread_time từ mới tới cũ, từng trang nhỏ: đủ tin thì dừng, không nạp cả
    // HISTORY_SEARCH_SCAN dòng một lúc (giữ vòng lặp sự kiện của sidecar không bị chặn lâu).
    const topicClause = topic === 'unassigned' ? ' AND topic_id IS NULL' : topic != null ? ' AND topic_id = ?' : '';
    const topicParam = topic === 'unassigned' ? [] : topic != null ? [topic] : [];
    const page = db.prepare(`
      SELECT rowid AS cursor_rowid, * FROM messages
      WHERE account_id = ? AND thread_type = ? AND thread_id = ? AND timestamp_ms >= ?
        AND (timestamp_ms < ? OR (timestamp_ms = ? AND rowid < ?))
        AND instr(text, ?) = 0 AND msg_type NOT IN ('chat.delete', 'chat.undo')${topicClause}
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT ?
    `);
    const found = [];
    let scanned = 0;
    let beforeTs = Number.MAX_SAFE_INTEGER;
    let beforeRowid = Number.MAX_SAFE_INTEGER;
    while (found.length < safeLimit && scanned < HISTORY_SEARCH_SCAN) {
      const rows = page.all(String(accountId), Number(threadType), String(threadId), Number(sinceMs) || 0,
        beforeTs, beforeTs, beforeRowid, LOGIN_CODE_MARK, ...topicParam,
        Math.min(HISTORY_SEARCH_PAGE, HISTORY_SEARCH_SCAN - scanned));
      for (const row of rows) {
        scanned += 1;
        if (needle && !fold(row.text).includes(needle)) continue;
        if (who && !fold(row.sender_name).includes(who)) continue;
        found.push(mapMessage(row));
        if (found.length >= safeLimit) break;
      }
      if (rows.length < HISTORY_SEARCH_PAGE) break;
      const last = rows[rows.length - 1];
      beforeTs = last.timestamp_ms;
      beforeRowid = last.cursor_rowid;
    }
    return { messages: found.reverse(), scanned, truncated: scanned >= HISTORY_SEARCH_SCAN };
  }

  function findOwnMessage(accountId, threadId, threadType, ids = null) {
    const conditions = [
      'account_id = ?', 'thread_id = ?', 'thread_type = ?', 'is_self = 1',
      'msg_id IS NOT NULL', 'cli_msg_id IS NOT NULL', "COALESCE(msg_type, '') <> 'chat.undo'",
    ];
    const params = [String(accountId), String(threadId), Number(threadType)];
    if (ids) {
      conditions.push('msg_id = ?', 'cli_msg_id = ?');
      params.push(String(ids.msgId), String(ids.cliMsgId));
    }
    const row = db.prepare(`
      SELECT * FROM messages WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT 1
    `).get(...params);
    return row ? mapMessage(row) : null;
  }

  const RECALL_WINDOW_MS = 1_800_000;
  const recallHead = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 40);
  // "<độ dài>:<sha256>" — tin trực tiếp có thể chỉ là mảnh đầu, ngắn hơn bản Hermes đầy đủ: so theo tiền tố cùng độ dài.
  const headHash = (head) => `${head.length}:${createHash('sha256').update(head).digest('hex')}`;

  function isRecalledCopy(accountId, threadId, threadType, value, timestamp) {
    const head = recallHead(value);
    if (head.length < 12) return false;
    const marks = db.prepare(`SELECT head_hash FROM recalled_heads WHERE account_id = ? AND thread_id = ? AND thread_type = ?
      AND timestamp_ms BETWEEN ? AND ?`).all(String(accountId), String(threadId), Number(threadType),
      timestamp - RECALL_WINDOW_MS, timestamp + RECALL_WINDOW_MS);
    return marks.some(({ head_hash: mark }) => headHash(head.slice(0, Number(String(mark).split(':')[0]))) === mark);
  }

  /**
   * Bot vừa thu hồi tin của chính nó: xoá nội dung khỏi lịch sử (tra lịch sử, dashboard không còn đọc được).
   * Cùng câu trả lời còn có bản sao không msgId do nhập lịch sử Hermes cũ (legacy-hermes, nguyên văn Markdown) —
   * khớp theo đầu nội dung đã bỏ dấu câu/định dạng, trong ±30 phút: xoá bản đang có và lưu dấu (băm) để bản nhập
   * về sau cũng vào trắng. Trạng thái thu hồi giữ khi nhập lại/backfill (upsert).
   */
  function markRecalled(accountId, threadId, threadType, { msgId, cliMsgId }) {
    const key = [String(accountId), String(threadId), Number(threadType)];
    const target = db.prepare(`SELECT text, timestamp_ms FROM messages WHERE account_id = ? AND thread_id = ? AND thread_type = ?
      AND is_self = 1 AND msg_id = ? AND cli_msg_id = ?`).get(...key, String(msgId), String(cliMsgId));
    const blank = db.prepare("UPDATE messages SET text = '', msg_type = 'chat.undo', updated_at_ms = ? WHERE rowid = ?");
    let changed = Number(db.prepare(`UPDATE messages SET text = '', msg_type = 'chat.undo', updated_at_ms = ?
      WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND is_self = 1 AND msg_id = ? AND cli_msg_id = ?`)
      .run(Number(now()), ...key, String(msgId), String(cliMsgId)).changes);
    const want = recallHead(target?.text);
    if (want.length >= 12) {
      const ts = Number(target.timestamp_ms);
      db.prepare('INSERT OR IGNORE INTO recalled_heads VALUES (?, ?, ?, ?, ?)').run(...key, headHash(want), ts);
      const near = db.prepare(`SELECT rowid, text FROM messages WHERE account_id = ? AND thread_id = ? AND thread_type = ?
        AND is_self = 1 AND msg_type = 'legacy-hermes' AND timestamp_ms BETWEEN ? AND ?`)
        .all(...key, ts - RECALL_WINDOW_MS, ts + RECALL_WINDOW_MS);
      for (const row of near) {
        if (recallHead(row.text).startsWith(want)) changed += Number(blank.run(Number(now()), row.rowid).changes);
      }
    }
    return changed;
  }

  function pruneMessages() {
    const cutoff = Number(now()) - Number(retentionDays) * DAY_MS;
    return Number(db.prepare('DELETE FROM messages WHERE timestamp_ms < ?').run(cutoff).changes);
  }

  function beginAudit(entry) {
    if (!entry?.requestId || !entry?.action || !entry?.category) {
      throw new Error('Audit requires requestId, action, and category');
    }
    db.prepare(`
      INSERT INTO audit_log (
        request_id, account_id, actor_uid, actor_role, action, category,
        thread_id, thread_type, status, target_summary, error, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attempted', ?, NULL, ?)
    `).run(
      String(entry.requestId), text(entry.accountId), text(entry.actorUid), text(entry.actorRole),
      String(entry.action), String(entry.category), text(entry.threadId),
      entry.threadType == null ? null : Number(entry.threadType),
      entry.targetSummary ? JSON.stringify(entry.targetSummary) : null, Number(now()),
    );
  }

  function finishAudit(requestId, status, detail = {}) {
    if (!['succeeded', 'failed'].includes(status)) throw new Error('Invalid terminal audit status');
    const attempted = db.prepare(`
      SELECT * FROM audit_log WHERE request_id = ? AND status = 'attempted'
      ORDER BY id DESC LIMIT 1
    `).get(String(requestId));
    if (!attempted) throw new Error(`No attempted audit record for ${requestId}`);
    const terminal = db.prepare(`
      SELECT id FROM audit_log WHERE request_id = ? AND status IN ('succeeded', 'failed') LIMIT 1
    `).get(String(requestId));
    if (terminal) return false;
    db.prepare(`
      INSERT INTO audit_log (
        request_id, account_id, actor_uid, actor_role, action, category,
        thread_id, thread_type, status, target_summary, error, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempted.request_id, attempted.account_id, attempted.actor_uid, attempted.actor_role,
      attempted.action, attempted.category, attempted.thread_id, attempted.thread_type,
      status, attempted.target_summary, nullableText(detail.error), Number(now()),
    );
    return true;
  }

  function getAuditTrail(requestId) {
    return db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY id').all(String(requestId)).map((row) => ({
      requestId: row.request_id,
      accountId: row.account_id,
      actorUid: row.actor_uid,
      actorRole: row.actor_role,
      action: row.action,
      category: row.category,
      threadId: row.thread_id,
      threadType: row.thread_type,
      status: row.status,
      targetSummary: parseJson(row.target_summary),
      error: row.error,
      createdAtMs: row.created_at_ms,
    }));
  }

  function saveBackfillState(state) {
    db.prepare(`
      INSERT INTO backfill_state (
        account_id, thread_type, cursor_msg_id, status, pages_fetched,
        messages_inserted, error, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, thread_type) DO UPDATE SET
        cursor_msg_id = excluded.cursor_msg_id,
        status = excluded.status,
        pages_fetched = excluded.pages_fetched,
        messages_inserted = excluded.messages_inserted,
        error = excluded.error,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      String(state.accountId), Number(state.threadType), nullableText(state.cursorMsgId),
      String(state.status), Number(state.pagesFetched) || 0, Number(state.messagesInserted) || 0,
      nullableText(state.error), Number(now()),
    );
  }

  function getBackfillState(accountId, threadType) {
    const row = db.prepare('SELECT * FROM backfill_state WHERE account_id = ? AND thread_type = ?')
      .get(String(accountId), Number(threadType));
    return row ? {
      accountId: row.account_id,
      threadType: row.thread_type,
      cursorMsgId: row.cursor_msg_id,
      status: row.status,
      pagesFetched: row.pages_fetched,
      messagesInserted: row.messages_inserted,
      error: row.error,
      updatedAtMs: row.updated_at_ms,
    } : null;
  }
  // ------------------------------------------------------------------ chủ đề (spec §20.2)

  /** Mở một chủ đề mới của một hội thoại; mỗi hội thoại chỉ có một chủ đề 'open' (chỉ mục riêng đảm bảo). */
  function openTopic(accountId, threadId, threadType, { firstTsMs = 0, at = now() } = {}) {
    const row = db.prepare(`
      SELECT topic_id FROM topics WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND status = 'open'
    `).get(String(accountId), String(threadId), Number(threadType));
    if (row) return row.topic_id;
    const stamp = Number(at);
    const result = db.prepare(`
      INSERT INTO topics (account_id, thread_id, thread_type, title, abstract, status, first_ts_ms, last_ts_ms,
        message_count, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, '', '', 'open', ?, ?, 0, ?, ?)
    `).run(String(accountId), String(threadId), Number(threadType), Number(firstTsMs) || 0, Number(firstTsMs) || 0, stamp, stamp);
    return Number(result.lastInsertRowid);
  }

  /** Tin vào đúng hội thoại 'open' (hoặc bất kỳ chủ đề nào): cập nhật mốc thời gian và số tin của chủ đề đó. */
  function attachMessageToTopic(topicId, tsMs, at = now()) {
    db.prepare(`UPDATE topics SET last_ts_ms = MAX(last_ts_ms, ?), message_count = message_count + 1,
      first_ts_ms = CASE WHEN first_ts_ms = 0 THEN ? ELSE first_ts_ms END, updated_at_ms = ? WHERE topic_id = ?`)
      .run(Number(tsMs) || 0, Number(tsMs) || 0, Number(at), Number(topicId));
  }

  /** Gán topicId cho tin (kiểm chủ đề đúng hội thoại — không gán chéo hội thoại). Trả true nếu gán được. */
  function assignMessageTopic(accountId, identityKey, topicId) {
    const ok = db.prepare(`
      SELECT 1 FROM messages m JOIN topics t ON t.topic_id = ? AND t.account_id = m.account_id
        AND t.thread_id = m.thread_id AND t.thread_type = m.thread_type
      WHERE m.identity_key = ? AND m.account_id = ?
    `).get(Number(topicId), String(identityKey), String(accountId));
    if (!ok) return false;
    db.prepare('UPDATE messages SET topic_id = ? WHERE identity_key = ?').run(Number(topicId), String(identityKey));
    return true;
  }

  /** Đặt tên/abstract cho chủ đề, kèm sẵn "đóng" hay không. Trả số dòng cập nhật. */
  function setTopicContent(accountId, topicId, { title, abstract, status }, at = now()) {
    const sets = [];
    const params = [Number(at)];
    if (title != null) { sets.push('title = ?'); params.push(String(title).slice(0, 200)); }
    if (abstract != null) { sets.push('abstract = ?'); params.push(String(abstract).slice(0, 600)); }
    if (status != null && ['open', 'closed'].includes(String(status))) { sets.push('status = ?'); params.push(String(status)); }
    if (!sets.length) return 0;
    const info = db.prepare(`UPDATE topics SET updated_at_ms = ?, ${sets.join(', ')}
      WHERE topic_id = ? AND account_id = ?`).run(...params, Number(topicId), String(accountId));
    return Number(info.changes);
  }

  /** Danh sách chủ đề của MỘT hội thoại, mới trước: trả tên/abstract cho dashboard và bots. */
  function listTopics(accountId, threadId, threadType, { limit = 30 } = {}) {
    return db.prepare(`
      SELECT topic_id, title, abstract, status, first_ts_ms, last_ts_ms, message_count
      FROM topics WHERE account_id = ? AND thread_id = ? AND thread_type = ?
      ORDER BY status = 'open' DESC, last_ts_ms DESC LIMIT ?
    `).all(String(accountId), String(threadId), Number(threadType), Math.min(Math.max(Number(limit) || 30, 1), 100))
      .map((row) => ({
        topicId: Number(row.topic_id), title: row.title, abstract: row.abstract, status: row.status,
        firstTsMs: Number(row.first_ts_ms), lastTsMs: Number(row.last_ts_ms), messageCount: Number(row.message_count),
      }));
  }

  /** Tên chủ đề để nhãn nhóm kết quả tìm kiếm: topic NULL → "Chung". */
  function topicTitle(accountId, topicId) {
    const row = db.prepare('SELECT title FROM topics WHERE topic_id = ? AND account_id = ?')
      .get(Number(topicId), String(accountId));
    return row ? String(row.title) : '';
  }

  /** Đóng chủ đề để mở chủ đề mới: từng hội thoại chỉ một 'open' cùng lúc. */
  function closeTopic(accountId, topicId, { at = now() } = {}) {
    return Number(db.prepare(`UPDATE topics SET status = 'closed', updated_at_ms = ?
      WHERE topic_id = ? AND account_id = ? AND status = 'open'`).run(Number(at), Number(topicId), String(accountId)).changes);
  }

  // ------------------------------------------------------------------ tri thức (facts, spec §20.3–20.4)

  const factLane = (scope, accountId) => {
    if (!SCOPE_RE.test(String(scope ?? ''))) throw new Error('facts scope phải là zalo-g-<nhóm> hoặc zalo-u-<người>');
    return [String(accountId), String(scope)];
  };

  /**
   * Ghi một fact (spec §20.3). `content` cắt FACT_CONTENT_MAX ký tự, `sourceMsgKeys` là mảng identity_key provenance.
   * (account_id, scope) bắt buộc: ghi nhầm scope không hợp lệ → lỗi ngay, không chờ test.
   */
  function addFact({ accountId, scope, kind, subject = '', content, sourceMsgKeys = [], confidence = 0.5,
                    validFromMs = 0, validToMs = null, topicId = null, origin = 'extract', at = now() } = {}) {
    factLane(scope, accountId);
    if (!FACT_KINDS.includes(String(kind))) throw new Error(`Loại fact không hợp lệ: ${kind}`);
    const keys = Array.isArray(sourceMsgKeys) ? sourceMsgKeys.map(String).filter(Boolean).slice(0, 20) : [];
    const stamp = Number(at);
    const result = db.prepare(`
      INSERT INTO facts (account_id, scope, kind, subject, content, source_msg_keys, confidence,
        valid_from_ms, valid_to_ms, superseded_by, status, topic_id, origin, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?)
    `).run(String(accountId), String(scope), String(kind), String(subject).slice(0, 200),
      String(content ?? '').slice(0, FACT_CONTENT_MAX), JSON.stringify(keys),
      Math.max(0, Math.min(1, Number(confidence) || 0)), Number(validFromMs) || 0,
      validToMs == null ? null : Number(validToMs), topicId == null ? null : Number(topicId),
      String(origin), stamp, stamp);
    return Number(result.lastInsertRowid);
  }

  /** active + chưa hết hạn là những gì recall nhìn thấy; mâu thuẫn nằm ở status riêng. */
  const FACT_VALIDITY = "status = 'active' AND (valid_to_ms IS NULL OR valid_to_ms > ?)";

  function activeFacts(scope, accountId, { kind = null, limit = 12, at = now() } = {}) {
    factLane(scope, accountId);
    const kindClause = kind ? ' AND kind = ?' : '';
    return db.prepare(`
      SELECT fact_id, kind, subject, content, confidence, valid_from_ms, valid_to_ms, topic_id, origin, created_at_ms
      FROM facts WHERE scope = ? AND account_id = ? AND ${FACT_VALIDITY}${kindClause}
      ORDER BY confidence DESC, created_at_ms DESC LIMIT ?
    `).all(String(scope), String(accountId), Number(at), ...(kind ? [String(kind)] : []),
      Math.min(Math.max(Number(limit) || 12, 1), FACT_RECALL_MAX))
      .map(mapFact);
  }

  function mapFact(row) {
    return {
      factId: Number(row.fact_id), kind: row.kind, subject: row.subject, content: row.content,
      confidence: Number(row.confidence), validFromMs: Number(row.valid_from_ms),
      validToMs: row.valid_to_ms == null ? null : Number(row.valid_to_ms), topicId: row.topic_id == null ? null : Number(row.topic_id),
      origin: row.origin, createdAtMs: Number(row.created_at_ms),
      ...(row.source_msg_keys === undefined ? {} : { sourceMsgKeys: parseJson(row.source_msg_keys) || [] }),
    };
  }

  /** Tìm kiếm full-text trong đúng phạm vi (FTS5 facts_fts): cho recall trộn và dashboard. */
  function searchFacts(scope, accountId, query, { limit = 8, at = now() } = {}) {
    factLane(scope, accountId);
    const q = String(query ?? '').trim().slice(0, 100);
    if (!q) return [];
    const rows = db.prepare(`
      SELECT f.fact_id, f.kind, f.subject, f.content, f.confidence, f.valid_from_ms, f.valid_to_ms, f.topic_id,
        f.origin, f.created_at_ms, f.source_msg_keys
      FROM facts_fts fi JOIN facts f ON f.rowid = fi.rowid
      WHERE facts_fts MATCH ? AND f.scope = ? AND f.account_id = ? AND ${FACT_VALIDITY.replace(/valid_to_ms/g, 'f.valid_to_ms')}
      ORDER BY f.confidence DESC, f.created_at_ms DESC LIMIT ?
    `).all(q, String(scope), String(accountId), Number(at), Math.min(Math.max(Number(limit) || 8, 1), FACT_RECALL_MAX));
    return rows.map(mapFact);
  }

  /**
   * Supersede (spec §20.4): fact cũ chấm dứt hiệu lực ngay, ghi superseded_by. KHÔNG xoá dữ liệu — dòng
   * 'superseded' còn lại để Quản trị xem lịch sử. Trả 1 khi cập nhật, ném lỗi nếu fact ngoài phạm vi.
   */
  function supersedeFact(scope, accountId, oldFactId, newFactId, { at = now() } = {}) {
    factLane(scope, accountId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare('SELECT fact_id FROM facts WHERE fact_id = ? AND scope = ? AND account_id = ?')
        .get(Number(oldFactId), String(scope), String(accountId));
      if (!old) throw new Error('fact cũ không có trong phạm vi này — không supersede chéo phạm vi');
      db.prepare(`UPDATE facts SET valid_to_ms = ?, status = 'superseded', superseded_by = ?, updated_at_ms = ?
        WHERE fact_id = ? AND scope = ? AND account_id = ?`).run(Number(at), Number(newFactId), Number(at), Number(oldFactId), String(scope), String(accountId));
      db.exec('COMMIT');
      return 1;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Xếp một cặp xung đột vào hàng đợi; người duyệt ở dashboard bấm một trong hai lệnh dưới. */
  function addContradiction(scope, accountId, newFactId, oldFactId, reason = '', at = now()) {
    factLane(scope, accountId);
    db.prepare(`INSERT OR IGNORE INTO contradictions (account_id, scope, new_fact_id, old_fact_id, reason, resolved, created_at_ms)
      VALUES (?, ?, ?, ?, ?, '', ?)`).run(String(accountId), String(scope), Number(newFactId), Number(oldFactId), String(reason).slice(0, 300), Number(at));
  }
  /** Danh sách hàng đợi mâu thuẫn, mới trước; `resolved` = '' là chưa xử lý, 'keep_old'|'keep_new' là đã xử lý. */
  function listContradictions(scope, accountId, { limit = 50 } = {}) {
    factLane(scope, accountId);
    return db.prepare(`
      SELECT c.id, c.new_fact_id, c.old_fact_id, c.reason, c.created_at_ms, c.resolved,
        nf.content AS new_content, nf.kind AS new_kind, nf.subject AS new_subject,
        oldf.content AS old_content, oldf.kind AS old_kind, oldf.subject AS old_subject
      FROM contradictions c
      JOIN facts nf ON nf.fact_id = c.new_fact_id
      JOIN facts oldf ON oldf.fact_id = c.old_fact_id
      WHERE c.scope = ? AND c.account_id = ?
      ORDER BY c.resolved <> '' ASC, c.created_at_ms DESC LIMIT ?
    `).all(String(scope), String(accountId), Math.min(Number(limit) || 50, 200));
  }

  /**
   * Duyệt một cặp mâu thuẫn (spec §20.4): `keep_new` → supersede fact cũ; `keep_old` → fact mới thành
   * 'contradiction'. Fact bị loại vẫn còn dòng để tra lại lịch sử.
   */
  function resolveContradiction(scope, accountId, id, choice, { at = now() } = {}) {
    factLane(scope, accountId);
    if (!['keep_new', 'keep_old'].includes(String(choice))) throw new Error('lựa chọn phải là keep_new hoặc keep_old');
    const row = db.prepare('SELECT new_fact_id, old_fact_id FROM contradictions WHERE id = ? AND scope = ? AND account_id = ?')
      .get(Number(id), String(scope), String(accountId));
    if (!row) throw new Error('không có mâu thuẫn này trong phạm vi');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (choice === 'keep_new') {
        db.prepare(`UPDATE facts SET valid_to_ms = ?, status = 'superseded', superseded_by = ?, updated_at_ms = ?
          WHERE fact_id = ? AND scope = ? AND account_id = ?`)
          .run(Number(at), Number(row.new_fact_id), Number(at), Number(row.old_fact_id), String(scope), String(accountId));
      } else {
        db.prepare(`UPDATE facts SET status = 'contradiction', updated_at_ms = ? WHERE fact_id = ? AND scope = ? AND account_id = ?`)
          .run(Number(at), Number(row.new_fact_id), String(scope), String(accountId));
      }
      db.prepare('UPDATE contradictions SET resolved = ? WHERE id = ?').run(String(choice), Number(id));
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * "Quên hẳn" một phạm vi (spec §20.7): xoá facts + hàng đợi + topics của đúng (account_id, scope). Tin nhắn thô
   * giữ nguyên — lịch sử hội thoại không phải tri thức. Dashboard gọi khi Quản trị/Chủ bot bấm "Quên hết phạm vi".
   */
  function forgetScopeFacts(scope, accountId) {
    factLane(scope, accountId);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM facts WHERE scope = ? AND account_id = ?').run(String(scope), String(accountId));
      db.prepare('DELETE FROM contradictions WHERE scope = ? AND account_id = ?').run(String(scope), String(accountId));
      // Bộ nhớ chính (spec §21): hồ sơ gộp + trí nhớ mềm cũng thuộc phạm vi — quên là quên trọn.
      db.prepare('DELETE FROM profiles WHERE scope = ? AND account_id = ?').run(String(scope), String(accountId));
      db.prepare('DELETE FROM soft_memories WHERE scope = ? AND account_id = ?').run(String(scope), String(accountId));
      if (String(scope).startsWith('zalo-g-')) {
        // Chủ đề gắn hội thoại: scope nhóm là thread — xoá topic của đúng hội thoại này, bỏ gán tin.
        const threadId = String(scope).slice('zalo-g-'.length);
        db.prepare(`UPDATE messages SET topic_id = NULL WHERE account_id = ? AND thread_id = ? AND topic_id IS NOT NULL`)
          .run(String(accountId), threadId);
        db.prepare('DELETE FROM topics WHERE account_id = ? AND thread_id = ?').run(String(accountId), threadId);
      }
      db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Xoá mọi chủ đề của MỘT hội thoại (spec §20.7 — "Quên nhóm này"): bỏ gán tin rồi xoá topic. */
  function forgetScopeTopics(accountId, threadId, threadType) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE messages SET topic_id = NULL WHERE account_id = ? AND thread_id = ? AND thread_type = ?')
        .run(String(accountId), String(threadId), Number(threadType));
      db.prepare('DELETE FROM topics WHERE account_id = ? AND thread_id = ? AND thread_type = ?')
        .run(String(accountId), String(threadId), Number(threadType));
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // ------------------------------------------------------------------ hồ sơ + trí nhớ mềm (spec §21)

  /** Hồ sơ của một phạm vi (markdown ngắn) hoặc null. Chỉ đọc; không gọi mạng. */
  function getProfile(scope, accountId) {
    factLane(scope, accountId);
    const row = db.prepare('SELECT body, updated_at_ms FROM profiles WHERE scope = ? AND account_id = ?')
      .get(String(scope), String(accountId));
    return row ? { body: String(row.body || ''), updatedAtMs: Number(row.updated_at_ms) } : null;
  }

  /** Ghi/đè hồ sơ một phạm vi (LLM gộp; `sourceFactIds` để tra lại fact nào sinh ra nó). */
  function setProfile(scope, accountId, body, { sourceFactIds = [], at = now() } = {}) {
    factLane(scope, accountId);
    const ids = Array.isArray(sourceFactIds) ? sourceFactIds.map(Number).filter(Number.isFinite).slice(0, 200) : [];
    db.prepare(`
      INSERT INTO profiles (account_id, scope, body, source_fact_ids, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, scope) DO UPDATE SET
        body = excluded.body, source_fact_ids = excluded.source_fact_ids, updated_at_ms = excluded.updated_at_ms
    `).run(String(accountId), String(scope), String(body ?? '').slice(0, PROFILE_MAX_CHARS),
      JSON.stringify(ids), Number(at));
    return true;
  }

  /** Thêm một mẩu trí nhớ mềm (không schema cứng) cho phạm vi. Trả id. */
  function addSoftMemory(scope, accountId, body, { kind = 'note', sourceMsgKeys = [], topicId = null, at = now() } = {}) {
    factLane(scope, accountId);
    const text = String(body ?? '').trim();
    if (!text) throw new Error('trí nhớ mềm cần nội dung');
    const keys = Array.isArray(sourceMsgKeys) ? sourceMsgKeys.map(String).filter(Boolean).slice(0, 20) : [];
    const stamp = Number(at);
    const result = db.prepare(`
      INSERT INTO soft_memories (account_id, scope, body, kind, source_msg_keys, topic_id, status, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(String(accountId), String(scope), text.slice(0, SOFT_MAX_CHARS), String(kind).slice(0, 40),
      JSON.stringify(keys), topicId == null ? null : Number(topicId), stamp, stamp);
    return Number(result.lastInsertRowid);
  }

  /** Trí nhớ mềm đang dùng của một phạm vi, mới nhất trước. */
  function listSoftMemories(scope, accountId, { limit = 20 } = {}) {
    factLane(scope, accountId);
    return db.prepare(`
      SELECT id, body, kind, updated_at_ms FROM soft_memories
      WHERE scope = ? AND account_id = ? AND status = 'active'
      ORDER BY updated_at_ms DESC LIMIT ?
    `).all(String(scope), String(accountId), Math.min(Math.max(Number(limit) || 20, 1), 100))
      .map((r) => ({ id: Number(r.id), body: String(r.body), kind: String(r.kind), updatedAtMs: Number(r.updated_at_ms) }));
  }

  /** Tìm trí nhớ mềm trong ĐÚNG phạm vi theo từ khoá (FTS5). */
  function searchSoftMemories(scope, accountId, query, { limit = 8 } = {}) {
    factLane(scope, accountId);
    const q = String(query ?? '').trim().slice(0, 100);
    if (!q) return [];
    try {
      return db.prepare(`
        SELECT s.id, s.body, s.kind, s.updated_at_ms
        FROM soft_fts f JOIN soft_memories s ON s.id = f.rowid
        WHERE soft_fts MATCH ? AND s.scope = ? AND s.account_id = ? AND s.status = 'active'
        ORDER BY s.updated_at_ms DESC LIMIT ?
      `).all(q, String(scope), String(accountId), Math.min(Math.max(Number(limit) || 8, 1), 50))
        .map((r) => ({ id: Number(r.id), body: String(r.body), kind: String(r.kind), updatedAtMs: Number(r.updated_at_ms) }));
    } catch { return []; }   // câu FTS hỏng (ký tự lạ) → coi như không thấy
  }

  function removeSoftMemory(scope, accountId, id) {
    factLane(scope, accountId);
    return Number(db.prepare('DELETE FROM soft_memories WHERE id = ? AND scope = ? AND account_id = ?')
      .run(Number(id), String(scope), String(accountId)).changes);
  }

  function getHealth() {
    const messageCount = Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count);
    const auditCount = Number(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count);
    let databaseSizeBytes = 0;
    try { databaseSizeBytes = statSync(databasePath).size; } catch { /* database is still ready */ }
    return { ready: true, databaseSizeBytes, messageCount, auditCount };
  }

  return {
    upsertMessage,
    insertMessages,
    hasLiveTwin,
    pruneLegacyOverlap,
    getHistory,
    getRange,
    searchHistory,
    findOwnMessage,
    markRecalled,
    pruneMessages,
    beginAudit,
    finishAudit,
    getAuditTrail,
    saveBackfillState,
    getBackfillState,
    // chủ đề (spec §20.2)
    openTopic,
    attachMessageToTopic,
    assignMessageTopic,
    setTopicContent,
    listTopics,
    topicTitle,
    closeTopic,
    // tri thức (spec §20.3–20.7)
    addFact,
    activeFacts,
    searchFacts,
    supersedeFact,
    addContradiction,
    listContradictions,
    resolveContradiction,
    forgetScopeFacts,
    forgetScopeTopics,
    // hồ sơ + trí nhớ mềm (spec §21)
    getProfile,
    setProfile,
    addSoftMemory,
    listSoftMemories,
    searchSoftMemories,
    removeSoftMemory,
    getHealth,
    close: () => db.close(),
  };
}
