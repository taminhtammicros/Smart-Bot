import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotUses, startOfDayVN } from './bot-uses.js';

const NOW = Date.UTC(2026, 9, 13, 8, 0);   // 15:00 giờ Việt Nam
const H = 3600_000;

function setup(t, rows, backfill = null) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-uses-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'zalo'));
  writeFileSync(join(dir, 'zalo', 'bot-uses.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\nkhông phải json\n`);
  if (backfill) writeFileSync(join(dir, 'zalo', 'bot-uses-backfill.json'), JSON.stringify({ builtAt: NOW, rows: backfill }));
  return createBotUses({
    hermesHome: dir, now: () => NOW,
    groupName: (id) => ({ g1: 'Đoàn trường', g2: 'Lớp 12A' }[id] || ''),
    personName: (uid) => ({ 111: 'An' }[uid] || ''),
  });
}

test('khách dùng bot: đếm lượt trong nhóm / nhắn riêng, xếp hạng kèm nhóm dùng nhiều nhất', (t) => {
  const r = (h, uid, name, thread, group, owner = false) => ({ t: NOW - h * H, uid, name, thread, group, owner });
  const uses = setup(t, [
    r(1, '111', 'An cũ', 'g1', true), r(2, '111', 'An cũ', 'g1', true), r(3, '111', 'An cũ', 'g2', true),
    r(1, '222', 'Bình', 'g2', true), r(1, '222', 'Bình', '222', false),
    r(30, '333', 'Cũ', 'g1', true),
  ]);
  const today = uses.stats(1);
  assert.equal(today.since, startOfDayVN(NOW));
  assert.deepEqual([today.group.uses, today.group.people, today.dm.uses, today.dm.people], [4, 2, 1, 1]);
  assert.deepEqual(today.group.top[0], { uid: '111', name: 'An', count: 3, thread: 'g1', threadName: 'Đoàn trường' });
  assert.equal(today.group.top[1].name, 'Bình', 'không có tên mới thì dùng tên trong sổ');
  assert.equal(today.approx, false);
  assert.equal(uses.stats(7).group.uses, 5, '7 ngày tính cả lượt hôm qua');
  assert.equal(uses.stats(99).days, 7, 'khoảng lạ → 7 ngày');
});

test('khách dùng bot: đếm cả chủ nhân (không loại ZALO_ALLOWED_USERS)', (t) => {
  const uses = setup(t, [
    { t: NOW - H, uid: '999', name: 'Chủ', thread: 'g1', group: true, owner: true },
    { t: NOW - H, uid: '111', name: 'An', thread: 'g1', group: true, owner: false },
  ]);
  const s = uses.stats(1);
  assert.deepEqual([s.group.uses, s.group.people], [2, 2]);
  assert.deepEqual(s.group.top.map((p) => p.name).sort(), ['An', 'Chủ']);
});

test('khách dùng bot: số dựng lại chỉ dùng cho trước dòng đầu tiên của sổ thật, đánh dấu gần đúng', (t) => {
  const uses = setup(t,
    [{ t: NOW - 2 * H, uid: '111', name: 'An', thread: 'g1', group: true }],
    [{ t: NOW - 50 * H, uid: '', name: 'Lan', thread: 'g1', group: true },
      { t: NOW - 40 * H, uid: '444', name: '', thread: '444', group: false },
      { t: NOW - 1 * H, uid: '111', name: 'An', thread: 'g1', group: true }]);
  const s = uses.stats(7);
  assert.equal(s.approx, true);
  assert.equal(s.group.uses, 2, 'lượt dựng lại sau dòng sổ thật đầu tiên bị bỏ (không đếm trùng)');
  assert.deepEqual(s.group.top.map((p) => p.name).sort(), ['An', 'Lan']);
  assert.equal(s.dm.top[0].name, 'Chưa rõ tên');
  assert.equal(uses.stats(1).approx, false, 'hôm nay chỉ có số thật');
});

test('dựng lại 30 ngày: nhắn riêng theo chat_id; nhóm ghép tên với tin cùng lúc, lịch sử thiếu UID thì tra theo tên', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { buildBackfill } = await import('./bot-uses.js');
  const dir = mkdtempSync(join(tmpdir(), 'zd-backfill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sdb = new DatabaseSync(join(dir, 'state.db'));
  sdb.exec(`CREATE TABLE sessions (id TEXT, source TEXT, chat_type TEXT, chat_id TEXT, user_id TEXT, origin_json TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    INSERT INTO sessions VALUES ('s1','zalo','group','g1',NULL,NULL), ('s2','zalo','dm','555',NULL,NULL), ('s3','cron','group','g1',NULL,NULL);`);
  const ts = (NOW - 2 * H) / 1000;
  const ins = sdb.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)');
  ins.run('s1', 'user', '[Lan] @bot giúp em', ts);
  ins.run('s1', 'assistant', 'Dạ', ts + 5);
  ins.run('s1', 'user', '[Ngữ cảnh gần nhất trong nhóm Zalo]\n- x\n[New message]\n[Minh] hỏi tiếp', ts + 60);
  ins.run('s2', 'user', 'chào bot', ts);
  ins.run('s3', 'user', '[Lan] việc hẹn', ts);
  ins.run('s1', 'user', '[Lan] quá cũ', (NOW - 40 * 86_400_000) / 1000);
  sdb.close();
  const zdb = new DatabaseSync(join(dir, 'zalo.sqlite'));
  zdb.exec(`CREATE TABLE messages (thread_id TEXT, thread_type INTEGER, sender_uid TEXT, sender_name TEXT, timestamp_ms INTEGER, is_self INTEGER)`);
  const zi = zdb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)');
  zi.run('g1', 1, '', 'Lan', ts * 1000, 0);            // dòng nhập từ bản cũ: có tên, thiếu UID
  zi.run('g1', 1, '111', 'Lan', ts * 1000 - 86_400_000, 0);
  zi.run('g1', 1, '222', 'Minh', (ts + 60) * 1000, 0);
  zdb.close();
  const b = buildBackfill({ stateDb: join(dir, 'state.db'), zaloDb: join(dir, 'zalo.sqlite'), now: NOW });
  assert.deepEqual(b.rows.map((r) => [r.uid, r.name, r.thread, r.group]), [
    ['111', 'Lan', 'g1', true], ['555', '', '555', false], ['222', 'Minh', 'g1', true],
  ]);
  assert.deepEqual(buildBackfill({ stateDb: join(dir, 'khong-co.db'), now: NOW }).rows, []);
});

test('dựng lại 30 ngày: nhóm lấy người gửi từ phiên khi tin không có tiền tố [Tên] (adapter mới)', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { buildBackfill } = await import('./bot-uses.js');
  const dir = mkdtempSync(join(tmpdir(), 'zd-backfill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sdb = new DatabaseSync(join(dir, 'state.db'));
  sdb.exec(`CREATE TABLE sessions (id TEXT, source TEXT, chat_type TEXT, chat_id TEXT, user_id TEXT, origin_json TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);`);
  const ts = (NOW - 2 * H) / 1000;
  const origin = JSON.stringify({ platform: 'zalo', chat_type: 'group', user_id: '111', user_name: 'Lan' });
  sdb.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('s1', 'zalo', 'group', 'g1', '111', origin);
  const ins = sdb.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)');
  ins.run('s1', 'user', 'cho em hỏi bài này với', ts);
  ins.run('s1', 'user', '[Ngữ cảnh gần nhất trong nhóm Zalo]\n- x\n[New message]\nMinh: hỏi tiếp', ts + 60);
  sdb.close();
  const b = buildBackfill({ stateDb: join(dir, 'state.db'), now: NOW });
  assert.deepEqual(b.rows.map((r) => [r.uid, r.name, r.thread, r.group]), [
    ['111', 'Lan', 'g1', true], ['111', 'Lan', 'g1', true],
  ]);
});

test('không có sổ thật: mỗi lần đọc đều dựng lại nên lượt mới hiện ngay', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'zd-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'zalo'));
  const stateDb = join(dir, 'state.db');
  const sdb = new DatabaseSync(stateDb);
  sdb.exec(`CREATE TABLE sessions (id TEXT, source TEXT, chat_type TEXT, chat_id TEXT, user_id TEXT, origin_json TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);`);
  const origin = JSON.stringify({ chat_type: 'group', user_id: '111', user_name: 'Lan' });
  sdb.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('s1', 'zalo', 'group', 'g1', '111', origin);
  const ins = sdb.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)');
  ins.run('s1', 'user', 'câu hỏi đầu', (NOW - 2 * H) / 1000);
  sdb.close();
  const uses = createBotUses({ hermesHome: dir, stateDb, now: () => NOW });
  assert.equal(uses.stats(7).group.uses, 1);
  const add = new DatabaseSync(stateDb);
  add.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('s1', 'user', 'câu hỏi sau', (NOW - H) / 1000);
  add.close();
  assert.equal(uses.stats(7).group.uses, 2, 'lượt mới được tính ngay, không chờ hết TTL');
});

test('khách dùng bot: UID không có trong lịch sử tin nhắn (dữ liệu test lọt vào) thì không tính, tên luôn theo UID', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zd-uses-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'zalo'));
  const r = (uid, name, thread, group) => JSON.stringify({ t: NOW - H, uid, name, thread, group, owner: false });
  writeFileSync(join(dir, 'zalo', 'bot-uses.jsonl'), [
    r('111', 'Tên cũ', 'g1', true), r('9876543210987654321', 'Lan', 'g1', true), r('9876543210987654321', 'Lan', 'g1', true),
    r('u1', 'Giả', 'g1', true), r('9876543210987654321', 'Lan', '9876543210987654321', false), r('', 'Chỉ có tên', 'g1', true),
  ].join('\n'));
  const uses = createBotUses({
    hermesHome: dir, now: () => NOW,
    personName: (uid) => ({ 111: 'An' }[uid] || ''),
    isKnown: (uid) => uid === '111',
  });
  const s = uses.stats(1);
  assert.deepEqual([s.group.uses, s.group.people, s.dm.uses], [1, 1, 0]);
  assert.deepEqual(s.group.top.map((p) => [p.uid, p.name]), [['111', 'An']]);
});
