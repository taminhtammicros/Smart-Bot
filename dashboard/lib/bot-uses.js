/**
 * Người dùng bot (Tổng quan): đếm lượt bot nhận xử lý — trong nhóm và khi nhắn riêng — và xếp hạng người dùng
 * nhiều nhất. Tính cả chủ nhân (không loại ZALO_ALLOWED_USERS).
 *
 * Nguồn chính: `<HERMES_HOME>/zalo/bot-uses.jsonl` do plugin ghi mỗi lượt (hermes-plugin/zalo/bot_uses.py).
 * Trước khi có sổ đó: dựng lại (30 ngày) từ state.db của Hermes, lưu `bot-uses-backfill.json`:
 *  - nhắn riêng: mỗi tin người dùng của phiên `chat_type='dm'` là một lượt của người có UID = chat_id (chính xác);
 *  - trong nhóm: người gửi lấy từ phiên (sessions.user_id + origin_json.user_name); bản Hermes cũ ghi "[Tên] …" thì
 *    ghép tên với tin cùng nhóm, cùng lúc (±3 phút) trong lịch sử tin của kết nối Zalo để lấy UID; không ghép được thì
 *    giữ tên, UID rỗng (gần đúng — `approx`).
 * Chưa có sổ thật thì bản dựng lại là nguồn duy nhất, được dựng lại mỗi lần đọc cho kịp lượt mới; có sổ thật rồi thì chỉ
 * dùng phần dựng lại cho khoảng thời gian TRƯỚC dòng đầu tiên của sổ thật, không đếm trùng.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJson, writeJsonAtomic } from './json-store.js';
import { questionOf } from './agent-trace.js';

const DAY = 86_400_000;
const BACKFILL_DAYS = 30;
const MATCH_MS = 3 * 60_000;
export const PERIODS = [1, 7, 30];
const VN_OFFSET = 7 * 3600_000;
export const startOfDayVN = (t) => Math.floor((t + VN_OFFSET) / DAY) * DAY - VN_OFFSET;

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Number.isFinite(r?.t)) out.push({ t: r.t, uid: String(r.uid || ''), name: String(r.name || ''), thread: String(r.thread || ''), group: Boolean(r.group), owner: Boolean(r.owner) });
    } catch { /* dòng hỏng */ }
  }
  return out;
}

/** Dựng lại lượt dùng từ state.db (+ lịch sử tin Zalo để ghép UID trong nhóm). Trả { builtAt, rows }. */
export function buildBackfill({ stateDb, zaloDb, now }) {
  const since = Math.floor((now - BACKFILL_DAYS * DAY) / 1000);
  const rows = [];
  if (!stateDb || !existsSync(stateDb)) return { builtAt: now, rows };
  const db = new DatabaseSync(stateDb, { readOnly: true, timeout: 2000 });
  let turns = [];
  try {
    turns = db.prepare(`SELECT s.chat_type AS type, s.chat_id AS chat, s.user_id AS uid, s.origin_json AS origin, m.content AS content, m.timestamp AS ts
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.source = 'zalo' AND m.role = 'user' AND m.timestamp >= ? ORDER BY m.timestamp`).all(since);
  } finally { db.close(); }
  let zdb = null;
  if (zaloDb && existsSync(zaloDb)) zdb = new DatabaseSync(zaloDb, { readOnly: true, timeout: 2000 });
  try {
    const near = zdb?.prepare(`SELECT sender_uid AS uid, sender_name AS name FROM messages
      WHERE thread_id = ? AND thread_type = 1 AND is_self = 0 AND timestamp_ms BETWEEN ? AND ?
      ORDER BY ABS(timestamp_ms - ?) LIMIT 20`);
    // Lịch sử nhập từ bản cũ có tên nhưng thiếu UID → tra UID theo tên: trong nhóm đó trước, rồi mọi nơi.
    const byNameInThread = zdb?.prepare(`SELECT sender_uid AS uid FROM messages WHERE thread_id = ? AND sender_name = ? AND sender_uid <> ''
      ORDER BY timestamp_ms DESC LIMIT 1`);
    const byName = zdb?.prepare(`SELECT sender_uid AS uid FROM messages WHERE sender_name = ? AND sender_uid <> '' AND is_self = 0
      ORDER BY timestamp_ms DESC LIMIT 1`);
    const uidCache = new Map();
    const uidOfName = (thread, who) => {
      const key = `${thread}\n${who}`;
      if (!uidCache.has(key)) uidCache.set(key, String(byNameInThread.get(thread, who)?.uid || byName.get(who)?.uid || ''));
      return uidCache.get(key);
    };
    for (const r of turns) {
      const t = Math.round(Number(r.ts) * 1000);
      const chat = String(r.chat || '');
      if (!chat) continue;
      if (r.type === 'dm') { rows.push({ t, uid: chat, name: '', thread: chat, group: false }); continue; }
      if (r.type !== 'group') continue;
      const rawWho = questionOf(r.content).who;
      // Bản Hermes mới KHÔNG gắn tiền tố "[Tên]" vào nội dung — người gửi nằm ở phiên
      // (sessions.user_id + origin_json.user_name). Chỉ dùng `who` cho dữ liệu cũ có tiền tố,
      // và bỏ qua tiêu đề ngữ cảnh "[Ngữ cảnh gần nhất trong nhóm Zalo]" bị nhận nhầm là tên.
      const who = /^Ngữ cảnh gần nhất/.test(rawWho) ? '' : rawWho;
      const senderUid = String(r.uid || '');
      let senderName = '';
      try { senderName = String(JSON.parse(r.origin || '{}').user_name || '').trim(); } catch { senderName = ''; }
      const name = senderName || who;
      let uid = senderUid;
      if (!uid && near) {
        const cands = near.all(chat, t - MATCH_MS, t + 30_000, t);
        const hit = cands.find((c) => name && c.uid && String(c.name || '').trim() === name)
          || (!name && cands.filter((c) => c.uid).length === 1 ? cands.find((c) => c.uid) : null);
        uid = hit ? String(hit.uid) : name ? uidOfName(chat, name) : '';
      }
      rows.push({ t, uid, name, thread: chat, group: true });
    }
  } finally { zdb?.close(); }
  return { builtAt: now, rows };
}

export function createBotUses({ hermesHome, stateDb = '', zaloDb = '', groupName = () => '', personName = () => '', isKnown = null, now = Date.now }) {
  const file = join(hermesHome, 'zalo', 'bot-uses.jsonl');
  const backfillFile = join(hermesHome, 'zalo', 'bot-uses-backfill.json');
  let cache = { mtime: -1, rows: [] };
  function live() {
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { return []; }
    if (mtime !== cache.mtime) cache = { mtime, rows: parseLines(readFileSync(file, 'utf8')) };
    return cache.rows;
  }
  function backfill(hasLive) {
    const saved = readJson(backfillFile, null);
    // Có sổ thật rồi thì bản dựng lại chỉ là nền lịch sử trước đó, không cần làm mới.
    if (hasLive && saved && Array.isArray(saved.rows)) return saved;
    // Chưa có sổ thật thì đây là nguồn duy nhất — dựng lại mỗi lần đọc cho kịp lượt mới (rẻ: quét state.db).
    let built = { builtAt: now(), rows: [] };
    try { built = buildBackfill({ stateDb, zaloDb, now: now() }); } catch (e) { console.error('[dashboard] không dựng lại được lượt dùng bot:', e?.message || e); }
    try { writeJsonAtomic(backfillFile, built); } catch { /* lần sau dựng lại */ }
    return built;
  }

  return {
    /** Thống kê `days` ngày gần nhất (tính cả hôm nay, giờ Việt Nam). */
    stats(days = 7) {
      const d = PERIODS.includes(Number(days)) ? Number(days) : 7;
      const t = now();
      const since = startOfDayVN(t) - (d - 1) * DAY;
      const real = live();
      const firstLive = real.length ? Math.min(...real.map((r) => r.t)) : Infinity;
      const old = backfill(real.length > 0).rows.filter((r) => r.t < firstLive);
      const approx = old.some((r) => r.t >= since);
      // isKnown: UID có thật trong lịch sử tin nhắn của bot — chặn UID lạ (người giả của test lọt vào sổ thật).
      // Chỉ áp cho sổ thật: bản dựng lại lấy từ sổ phiên Hermes nên đáng tin, chỉ cần có UID để tên khớp UID.
      const known = new Map();
      const real_ = (uid) => {
        if (!isKnown) return true;
        if (!uid) return false;
        if (!known.has(uid)) { let ok = true; try { ok = Boolean(isKnown(uid)); } catch { /* không kiểm được: giữ */ } known.set(uid, ok); }
        return known.get(uid);
      };
      const keep = (r, trusted) => (trusted ? (!isKnown || Boolean(r.uid)) : real_(r.uid))
        && r.t >= since;
      const rows = [...old.map((r) => ({ r, trusted: true })), ...real.map((r) => ({ r, trusted: false }))]
        .filter(({ r, trusted }) => keep(r, trusted)).map(({ r }) => r);
      const board = (group) => {
        const map = new Map();
        for (const r of rows.filter((x) => x.group === group)) {
          const key = r.uid || `name:${r.name}`;
          const e = map.get(key) || { uid: r.uid, name: r.name, count: 0, threads: new Map() };
          e.count += 1;
          if (r.name) e.name = r.name;
          e.threads.set(r.thread, (e.threads.get(r.thread) || 0) + 1);
          map.set(key, e);
        }
        const people = [...map.values()].sort((a, b) => b.count - a.count);
        return {
          uses: people.reduce((s, p) => s + p.count, 0),
          people: people.length,
          top: people.slice(0, 10).map((p) => {
            const [thread] = [...p.threads.entries()].sort((a, b) => b[1] - a[1])[0] || [''];
            return { uid: p.uid, name: personName(p.uid) || p.name || 'Chưa rõ tên', count: p.count,
              thread, threadName: group ? groupName(thread) : '' };
          }),
        };
      };
      return { days: d, since, approx, group: board(true), dm: board(false) };
    },
  };
}
