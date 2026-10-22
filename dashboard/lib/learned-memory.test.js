import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OFF_NOTE, WINDOWS_NOTE, createLearnedMemory, learnedMemoryStatus, parseScope, readMemorySettings, readProvider } from './learned-memory.js';
import { openZaloStore } from '../../zalo-store.js';
import { openBrainStore } from './brain-store.js';

const G = 'zalo-g-2054797107487294899';
const U = 'zalo-u-5554567890123456789';   // một khách nhắn riêng
const O = 'zalo-u-1234567890123456789';   // chủ nhân bot nhắn riêng

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-lm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Kho thật (cùng schema sidecar tạo), gieo sẵn dữ liệu cho ba phạm vi. */
function seeded(t, { owners = [O.slice('zalo-u-'.length)] } = {}) {
  const dir = tmp(t);
  const sqliteFile = join(dir, 'zalo.sqlite');
  openZaloStore({ path: sqliteFile }).close();   // sidecar tạo schema; test chỉ gieo dữ liệu
  const conn = openBrainStore(sqliteFile);
  const now = Date.now();
  const fact = conn.prepare(
    'INSERT INTO facts (account_id, scope, kind, subject, content, source_msg_keys, confidence, valid_from_ms, valid_to_ms, status, origin, created_at_ms, updated_at_ms) '
    + "VALUES ('zalo', ?, ?, ?, ?, '[]', ?, 0, NULL, 'active', 'extract', ?, ?)");
  fact.run(G, 'preference', 'xưng hô', 'Nhóm gọi bot là Nhi', 0.9, now, now);
  fact.run(U, 'decision', 'giá', 'Khách chốt 50k', 0.8, now, now);
  fact.run(O, 'preference', 'sở thích', 'Chủ nhân thích cà phê đen', 0.95, now, now);
  conn.prepare('INSERT INTO soft_memories (account_id, scope, body, kind, source_msg_keys, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('zalo', G, 'Nhóm thích trả lời ngắn, có emoji', 'note', '[]', 'active', now, now);
  conn.prepare('INSERT INTO profiles (account_id, scope, body, source_fact_ids, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run('zalo', G, 'Nhóm cà phê, hỏi nhiều về giá.', '[]', now);
  conn.close();
  return { dir, sqliteFile, now };
}

const make = (sqliteFile, over = {}) => createLearnedMemory({
  settings: () => ({ provider: 'zalo_memory' }),
  names: (kind, id) => (kind === 'group' ? { [G.slice(7)]: 'Nhóm cà phê' }[id] || '' : ''),
  owners: () => [],
  ownerOverrides: () => [],
  settingsFile: join(tmpdir(), `brain-${Date.now()}.json`),
  sqliteFile,
  now: over.now || Date.now,
  ...over,
});

test('phạm vi: chỉ zalo-g-/zalo-u- số; tên lạ → null', () => {
  assert.deepEqual(parseScope(G), { kind: 'group', id: G.slice(7) });
  assert.deepEqual(parseScope(U), { kind: 'dm', id: U.slice(7) });
  for (const bad of ['', 'default', 'zalo-g-', 'zalo-x-1', 'zalo-g-abc', null, undefined]) {
    assert.equal(parseScope(bad), null, `phải từ chối ${bad}`);
  }
});

test('bật/tắt: Windows luôn tắt; provider khác → tắt kèm hướng dẫn; bật khi đúng provider', () => {
  assert.equal(learnedMemoryStatus({ provider: 'zalo_memory', platform: 'win32' }).note, WINDOWS_NOTE);
  assert.equal(learnedMemoryStatus({ provider: 'omh', platform: 'linux' }).reason, 'off');
  assert.equal(learnedMemoryStatus({ provider: 'omh', platform: 'linux' }).note, OFF_NOTE);
  assert.equal(learnedMemoryStatus({ provider: 'zalo_memory', platform: 'linux' }).enabled, true);
});

test('đọc cấu hình: provider từ config.yaml; chu kỳ kẹp 30–1440, thiếu tệp → 120', (t) => {
  const dir = tmp(t);
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, 'memory:\n  provider: zalo_memory\n');
  assert.equal(readProvider(cfg), 'zalo_memory');
  writeFileSync(cfg, 'memory:\n  provider: ""\n');
  assert.equal(readProvider(cfg), '');
  const brain = join(dir, 'brain.json');
  assert.equal(readMemorySettings(brain).extractMinutes, 120);
  writeFileSync(brain, JSON.stringify({ version: 1, topicQuietMinutes: 5 }));
  assert.equal(readMemorySettings(brain).extractMinutes, 30, 'kẹp dưới');
  writeFileSync(brain, JSON.stringify({ version: 1, topicQuietMinutes: 9999 }));
  assert.equal(readMemorySettings(brain).extractMinutes, 1440, 'kẹp trên');
  writeFileSync(brain, '{"version":1,"topicQuietMinutes":"60"}');
  assert.equal(readMemorySettings(brain).extractMinutes, 120, 'sai kiểu → mặc định');
});

test('danh sách: tách đúng ba loại của một phạm vi, KHÔNG lẫn phạm vi khác', async (t) => {
  const { sqliteFile } = seeded(t);
  const lm = make(sqliteFile);
  const all = await lm.as('admin').list(G);
  assert.deepEqual(all.map((x) => x.kind).sort(), ['fact', 'profile', 'soft']);
  assert.equal(all.find((x) => x.kind === 'fact').text, 'Nhóm gọi bot là Nhi');
  assert.equal(all.find((x) => x.kind === 'soft').text, 'Nhóm thích trả lời ngắn, có emoji');
  assert.match(all.find((x) => x.kind === 'profile').text, /Nhóm cà phê/);
  const other = await lm.as('admin').list(U);
  assert.equal(other.some((x) => x.text.includes('Nhóm gọi bot')), false, 'không lẫn fact của phạm vi khác');
});

test('phân vai: Chủ bot thấy nhóm và DM khách nhưng KHÔNG thấy kho DM của chủ nhân bot', async (t) => {
  const { sqliteFile } = seeded(t);
  const lm = make(sqliteFile, { owners: () => [O.slice(7)] });
  const scopes = await lm.as('owner').scopes();
  assert.deepEqual(scopes.map((s) => s.scope).sort(), [G, U].sort());
  // Quản trị thấy hết
  assert.equal((await lm.as('admin').scopes()).length, 3);
  // Gọi thẳng vào kho chủ nhân → 404, và KHÔNG chạm kho (không đọc được dòng nào)
  await assert.rejects(() => lm.as('owner').list(O), (e) => e.statusCode === 404);
  await assert.rejects(() => lm.as('owner').search(O, 'cà phê'), (e) => e.statusCode === 404);
});

test('đóng khi lỗi: không đọc được danh sách chủ nhân → Chủ bot không thấy MỌI kho DM', async (t) => {
  const { sqliteFile } = seeded(t);
  const lm = make(sqliteFile, { owners: () => { throw new Error('hỏng'); } });
  assert.deepEqual((await lm.as('owner').scopes()).map((s) => s.scope), [G], 'chỉ còn nhóm');
});

test('tìm: chỉ trong một phạm vi; khớp không dấu; câu FTS hỏng → rỗng, không ném', async (t) => {
  const { sqliteFile } = seeded(t);
  const lm = make(sqliteFile);
  const hits = await lm.as('admin').search(G, 'goi bot');
  assert.deepEqual(hits.map((h) => h.id), ['fact:1']);
  assert.deepEqual((await lm.as('admin').search(U, 'goi bot')).length, 0, 'không rò sang phạm vi khác');
  assert.deepEqual(await lm.as('admin').search(G, 'emoji').then((h) => h.map((x) => x.id)), ['soft:1']);
  await assert.rejects(() => lm.as('admin').search(G, 'a'), (e) => e.statusCode === 400, 'quá ngắn');
});

test('sửa: hồ sơ, fact, trí nhớ mềm đều đổi đúng dòng của phạm vi', async (t) => {
  const { sqliteFile } = seeded(t);
  const lm = make(sqliteFile);
  await lm.as('admin').edit(G, 'profile', 'Nhóm cà phê, hay hỏi giá.');
  await lm.as('admin').edit(G, 'fact:1', 'Nhóm gọi bot là Uyển Nhi');
  await lm.as('admin').edit(G, 'soft:1', 'Nhóm thích trả lời ngắn');
  const all = await lm.as('admin').list(G);
  assert.equal(all.find((x) => x.kind === 'profile').text, 'Nhóm cà phê, hay hỏi giá.');
  assert.equal(all.find((x) => x.kind === 'fact').text, 'Nhóm gọi bot là Uyển Nhi');
  assert.equal(all.find((x) => x.kind === 'soft').text, 'Nhóm thích trả lời ngắn');
  await assert.rejects(() => lm.as('admin').edit(G, 'fact:999', 'x'), (e) => e.statusCode === 400);
  await assert.rejects(() => lm.as('admin').edit(G, 'soft:1', '   '), (e) => e.statusCode === 400);
});

test('xoá: fact đánh dấu deleted (giữ dòng), soft xoá hẳn, profile xoá dòng', async (t) => {
  const { sqliteFile } = seeded(t);
  const lm = make(sqliteFile);
  await lm.as('admin').remove(G, 'fact:1');
  await lm.as('admin').remove(G, 'soft:1');
  await lm.as('admin').remove(G, 'profile');
  assert.deepEqual(await lm.as('admin').list(G), [], 'không còn mục đang dùng');
  const conn = openBrainStore(sqliteFile);
  assert.equal(conn.prepare('SELECT status FROM facts WHERE fact_id = 1').get().status, 'deleted', 'fact giữ dòng để tra lại');
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM soft_memories').get().n, 0);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 0);
  conn.close();
});

test('xoá nhiều: bỏ trùng, một mục lỗi không dừng mục sau', async (t) => {
  const { sqliteFile } = seeded(t);
  const lm = make(sqliteFile);
  const out = await lm.as('admin').removeMany(G, ['fact:1', 'fact:1', 'soft:1', 'bogus']);
  assert.deepEqual(out.done.sort(), ['fact:1', 'soft:1']);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].error, /Không mở được|Chỉ xoá được/);
});

test('quên phạm vi: xoá facts + hồ sơ + trí nhớ mềm của ĐÚNG phạm vi, tin nhắn thô giữ nguyên', async (t) => {
  const { sqliteFile } = seeded(t);
  const conn = openBrainStore(sqliteFile);
  conn.prepare("INSERT INTO messages (identity_key, account_id, thread_id, thread_type, sender_name, text, msg_type, timestamp_ms, is_self, source, created_at_ms, updated_at_ms) "
    + "VALUES ('k1', 'zalo', ?, 1, 'Ai đó', 'tin thô', 'chat.text', 1, 0, 'live', 1, 1)").run(G.slice(7));
  conn.close();
  const lm = make(sqliteFile);
  await lm.as('admin').forget(G);
  assert.deepEqual(await lm.as('admin').list(G), []);
  assert.equal((await lm.as('admin').list(U)).length, 1, 'phạm vi khác giữ nguyên');
  const after = openBrainStore(sqliteFile);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1, 'lịch sử không phải tri thức');
  after.close();
});

test('rút ngay: chỉ Quản trị, ghi yêu cầu cho worker, tối đa 3 lần/kho/ngày', async (t) => {
  const { sqliteFile } = seeded(t);
  const dir = tmp(t);
  const lm = make(sqliteFile, { settingsFile: join(dir, 'brain.json') });
  await assert.rejects(() => lm.as('owner').extractNow(G), (e) => e.statusCode === 403);
  assert.equal((await lm.as('admin').extractNow(G)).queued, true);
  assert.equal((await lm.as('admin').extractNow(G)).queued, true);
  await lm.as('admin').extractNow(G);
  await assert.rejects(() => lm.as('admin').extractNow(G), (e) => e.statusCode === 429);
});

test('đổi chu kỳ: chỉ số nguyên trong 30–1440, ghi đúng tệp worker đọc', async (t) => {
  const { sqliteFile } = seeded(t);
  const dir = tmp(t);
  const settingsFile = join(dir, 'brain.json');
  const lm = make(sqliteFile, { settingsFile });
  assert.equal(lm.settings().extractMinutes, 120);
  assert.equal(lm.setSettings({ extractMinutes: 45 }).extractMinutes, 45);
  assert.equal(readMemorySettings(settingsFile).extractMinutes, 45);
  for (const bad of [10, 2000, 60.5, '60', null]) {
    assert.throws(() => lm.setSettings({ extractMinutes: bad }), (e) => e.statusCode === 400, `phải từ chối ${bad}`);
  }
});
