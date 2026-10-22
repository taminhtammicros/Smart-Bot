import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLearnedMemory } from '../lib/learned-memory.js';
import { openZaloStore } from '../../zalo-store.js';
import { openBrainStore } from '../lib/brain-store.js';
import { loginAs, makeDeps, startApp } from '../test-helpers.js';

const G = 'zalo-g-2054797107487294899';
const O = 'zalo-u-1234567890123456789';   // kho DM của chủ nhân bot

/**
 * Thư viện thật + kho SQLite thật (schema do sidecar tạo). Kiểm chặn theo vai trò ở PHÍA MÁY CHỦ, không
 * chỉ ẩn ở giao diện — và kiểm rằng Chủ bot không chạm được kho DM của chủ nhân (không dòng nào bị đọc).
 */
function realLearned(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-lmr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sqliteFile = join(dir, 'zalo.sqlite');
  openZaloStore({ path: sqliteFile }).close();
  const conn = openBrainStore(sqliteFile);
  const now = Date.now();
  const fact = conn.prepare(
    'INSERT INTO facts (account_id, scope, kind, subject, content, source_msg_keys, confidence, valid_from_ms, valid_to_ms, status, origin, created_at_ms, updated_at_ms) '
    + "VALUES ('zalo', ?, 'preference', 'xưng hô', ?, '[]', 0.9, 0, NULL, 'active', 'extract', ?, ?)");
  fact.run(G, 'Nhóm gọi bot là Nhi', now, now);
  fact.run(O, 'Chủ nhân thích cà phê đen', now, now);
  conn.prepare('INSERT INTO soft_memories (account_id, scope, body, kind, source_msg_keys, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('zalo', G, 'Nhóm thích trả lời ngắn', 'note', '[]', 'active', now, now);
  conn.close();
  const settingsFile = join(dir, 'zalo', 'brain.json');
  const learnedMemory = createLearnedMemory({
    settings: () => ({ provider: 'zalo_memory' }),
    platform: 'linux',
    sqliteFile,
    settingsFile,
    owners: () => ['1234567890123456789'],
    names: () => '',
  });
  return { learnedMemory, settingsFile, sqliteFile };
}

const scopesOf = (r) => r.json.scopes.map((s) => s.scope);

test('Kho tri thức: Quản trị và Chủ bot cùng xem/sửa/xoá; kho DM của chủ nhân chỉ Quản trị', async (t) => {
  const { learnedMemory } = realLearned(t);
  const deps = makeDeps(t, { learnedMemory });
  const { call } = await startApp(t, deps);
  assert.equal((await call('/api/learned-memory/scopes')).status, 401);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const admin = await loginAs(t, deps, call);

  assert.deepEqual(scopesOf(await call('/api/learned-memory/scopes', { cookie: owner })), [G]);
  assert.deepEqual(scopesOf(await call('/api/learned-memory/scopes', { cookie: admin })).sort(), [G, O].sort());

  const list = await call(`/api/learned-memory/${G}/list`, { cookie: owner });
  assert.equal(list.status, 200);
  const factEntry = list.json.entries.find((e) => e.kind === 'fact');
  const softEntry = list.json.entries.find((e) => e.kind === 'soft');
  assert.equal(factEntry.text, 'Nhóm gọi bot là Nhi');

  // Sửa rồi xoá một mục — Chủ bot làm được trong kho của nhóm
  assert.equal((await call(`/api/learned-memory/${G}/item`, { method: 'PUT', cookie: owner, body: { id: factEntry.id, text: 'Nhóm gọi bot là Uyển Nhi' } })).status, 200);
  assert.equal((await call(`/api/learned-memory/${G}/item`, { method: 'DELETE', cookie: owner, body: { id: softEntry.id } })).status, 200);

  // Kho DM của chủ nhân: mọi đường vào đều 404 với Chủ bot
  for (const [p, method, body] of [
    [`/api/learned-memory/${O}/list`, 'GET'],
    [`/api/learned-memory/${O}/search?q=cà%20phê`, 'GET'],
    [`/api/learned-memory/${O}/item`, 'PUT', { id: 'fact:2', text: 'x' }],
    [`/api/learned-memory/${O}/item`, 'DELETE', { id: 'fact:2' }],
    [`/api/learned-memory/${O}`, 'DELETE'],
  ]) {
    assert.equal((await call(p, { method, cookie: owner, body })).status, 404, `${method} ${p}`);
  }
  assert.equal((await call(`/api/learned-memory/${O}/list`, { cookie: admin })).status, 200, 'Quản trị vẫn thấy');

  assert.equal((await call(`/api/learned-memory/${G}`, { method: 'DELETE', cookie: owner })).status, 200);
  const log = deps.activity.list().filter((e) => e.action.startsWith('learned_memory_'));
  assert.deepEqual(log.map((e) => e.action).sort(), ['learned_memory_delete', 'learned_memory_edit', 'learned_memory_forget']);
  assert.equal(JSON.stringify(log).includes('Uyển Nhi'), false, 'Nhật ký không chép nội dung trí nhớ');
});

test('chu kỳ gói/trích: chỉ Quản trị sửa; ghi brain.json; Nhật ký có dòng', async (t) => {
  const { learnedMemory, settingsFile } = realLearned(t);
  const deps = makeDeps(t, { learnedMemory });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const admin = await loginAs(t, deps, call);

  const status = await call('/api/learned-memory/status', { cookie: owner });
  assert.equal(status.json.canAdmin, false);
  assert.equal(status.json.settings.extractMinutes, 120);

  assert.equal((await call('/api/learned-memory/settings', { method: 'PUT', cookie: owner, body: { extractMinutes: 45 } })).status, 403);
  assert.equal((await call('/api/learned-memory/settings', { method: 'PUT', cookie: admin, body: { extractMinutes: 45 } })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { version: 1, topicQuietMinutes: 45 });
  assert.equal((await call('/api/learned-memory/settings', { method: 'PUT', cookie: admin, body: { extractMinutes: 5 } })).status, 400);

  // "Rút ngay": chỉ Quản trị
  assert.equal((await call(`/api/learned-memory/${G}/extract`, { method: 'POST', cookie: owner })).status, 403);
  assert.equal((await call(`/api/learned-memory/${G}/extract`, { method: 'POST', cookie: admin })).status, 200);
  const log = deps.activity.list().filter((e) => e.action.startsWith('learned_memory_'));
  assert.deepEqual(log.map((e) => e.action).sort(), ['learned_memory_extract', 'learned_memory_settings']);
});

test('xoá nhiều mục: một dòng Nhật ký; đếm đúng; kho DM chủ nhân vẫn chặn Chủ bot', async (t) => {
  const { learnedMemory } = realLearned(t);
  const deps = makeDeps(t, { learnedMemory });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });

  const list = await call(`/api/learned-memory/${G}/list`, { cookie: owner });
  const ids = list.json.entries.map((e) => e.id);
  assert.equal(ids.length, 2);
  const out = await call(`/api/learned-memory/${G}/bulk-delete`, { method: 'POST', cookie: owner, body: { ids } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.done.sort(), [...ids].sort());
  assert.deepEqual(out.json.failed, []);
  assert.equal((await call(`/api/learned-memory/${G}/list`, { cookie: owner })).json.entries.length, 0);

  assert.equal((await call(`/api/learned-memory/${O}/bulk-delete`, { method: 'POST', cookie: owner, body: { ids: ['fact:2'] } })).status, 404);
  assert.equal((await call(`/api/learned-memory/${G}/bulk-delete`, { method: 'POST', cookie: owner, body: { ids: [] } })).status, 400);
  const log = deps.activity.list().filter((e) => e.action === 'learned_memory_delete');
  assert.equal(log.length, 1, 'một dòng cho cả lô');
});
