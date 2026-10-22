/**
 * Tầng "Trợ lý biết chuyện" phía dashboard (spec §20.7): quét sạch topics/facts/mâu thuẫn của MỘT phạm vi
 * khi Quản trị/Chủ bot bấm "Quên hết phạm vi": xoá trọn trí nhớ của nhóm/người đó (spec §21.8).
 *
 * Ghi thẳng tệp `zalo.sqlite` của sidecar (WAL nên ghi song song được với sidecar đang ghi; busy_timeout 5 s
 * giống phía sidecar nên không deadlock). CHỈ xoá theo `(account_id, scope)` — scope lấy từ đúng tệp scope
 * mà dashboard đã kiểm quyền, không bao giờ từ tham số của trình duyệt.
 */
import { DatabaseSync } from 'node:sqlite';

const SCOPE_RE = /^zalo-(g|u)-\d{1,32}$/;

/** Mở kho ở chế độ ghi; kho chưa có (sidecar chưa chạy) → null. */
export function openBrainStore(path) {
  try {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000;');
    return db;
  } catch {
    return null;
  }
}

/**
 * Xoá topics + facts + hàng đợi mâu thuẫn của `scope` trong kho. Tin nhắn thô GIỮ NGUYÊN — lịch sử hội thoại
 * không phải tri thức (bot vẫn tra lịch sử được sau khi "quên" trí nhớ).
 * Trả `{ facts, topics }` = số dòng đã xoá; scope sai dạng → ném lỗi.
 */
export function forgetScopeFacts(db, scope, accountId = '') {
  if (!db) return { facts: 0, topics: 0 };
  const value = String(scope ?? '');
  if (!SCOPE_RE.test(value)) throw new Error('phạm vi không hợp lệ');
  let facts = 0;
  let topics = 0;
  const has = (table) => Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
  try {
    if (!has('facts')) return { facts: 0, topics: 0 };
    db.exec('BEGIN IMMEDIATE');
    try {
      const run = db.prepare('DELETE FROM facts WHERE scope = ?' + (accountId ? ' AND account_id = ?' : ''));
      facts = Number(run.run(...(accountId ? [value, accountId] : [value])).changes);
      if (has('contradictions')) {
        db.prepare('DELETE FROM contradictions WHERE scope = ?' + (accountId ? ' AND account_id = ?' : ''))
          .run(...(accountId ? [value, accountId] : [value]));
      }
      // Bộ nhớ chính (spec §21): hồ sơ gộp + trí nhớ mềm cũng thuộc phạm vi — quên là quên trọn.
      for (const table of ['profiles', 'soft_memories']) {
        if (has(table)) {
          db.prepare(`DELETE FROM ${table} WHERE scope = ?` + (accountId ? ' AND account_id = ?' : ''))
            .run(...(accountId ? [value, accountId] : [value]));
        }
      }
      if (has('topics') && value.startsWith('zalo-g-')) {
        const threadId = value.slice('zalo-g-'.length);
        if (has('messages')) {
          db.prepare('UPDATE messages SET topic_id = NULL WHERE thread_id = ?' + (accountId ? ' AND account_id = ?' : ''))
            .run(...(accountId ? [threadId, accountId] : [threadId]));
        }
        topics = Number(db.prepare('DELETE FROM topics WHERE thread_id = ?' + (accountId ? ' AND account_id = ?' : ''))
          .run(...(accountId ? [threadId, accountId] : [threadId])).changes);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (/no such table/i.test(String(error?.message ?? ''))) return { facts: 0, topics: 0 };
    throw error;
  }
  return { facts, topics };
}

/** Số fact/topics đang có của một phạm vi (Quản trị xem trước khi quên). */
export function scopeCounts(db, scope) {
  if (!db) return { facts: 0, topics: 0 };
  const value = String(scope ?? '');
  if (!SCOPE_RE.test(value)) return { facts: 0, topics: 0 };
  const count = (table, extra) => {
    try {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${extra}`).get().n);
    } catch { return 0; }
  };
  return {
    facts: count('facts', 'scope = ?', [value]),
    topics: value.startsWith('zalo-g-') ? count('topics', 'thread_id = ?', [value.slice(7)]) : 0,
  };
}
