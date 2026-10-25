import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentConfig } from '../lib/agent-config.js';
import { createAiKeys } from '../lib/ai-keys.js';
import { createAiModels } from '../lib/ai-models.js';
import { createMediaEngines } from '../lib/media-engines.js';
import { loginAs, makeDeps, startApp } from '../test-helpers.js';

const SECRET = 'core-abcdefghijklmnop9876';

function withAi(t) {
  const deps = makeDeps(t);
  const envFile = join(deps.dir, '.env');
  const configFile = join(deps.dir, 'config.yaml');
  writeFileSync(envFile, `CORE_API_KEY=${SECRET}\n`);
  writeFileSync(configFile, 'model:\n  default: 2anhPRO\n  provider: custom\n  base_url: http://127.0.0.1:9/v1\n  api_key: sk-abcdefghijkl0000\ntts:\n  provider: gemini-9router\n  gemini:\n    voice: Leda\nimage_gen:\n  provider: openai-codex\n  model: gpt-image-2-medium\n');
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '2anhPRO' }, { id: 'ag/gemini-3.8-flash-low' }] }) };
    if (url.endsWith('/chat/completions')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Xin chào, mình sẵn sàng.' } }] }) };
    return { ok: true, status: 200 };
  };
  deps.agentConfig = createAgentConfig({ configFile, fetchImpl });
  deps.aiKeys = createAiKeys({ envFile, configFile, fetchImpl, poolFile: join(deps.dir, 'key-pool.json') });
  deps.aiModels = createAiModels({ configFile, fetchImpl, sqliteFile: join(deps.dir, 'zalo.sqlite') });
  return { deps, envFile, configFile };
}

test('Khoá API & Model: chỉ Quản trị; thẻ theo chức năng; đổi model chính, thử; thay khoá ghi Nhật ký chỉ tên', async (t) => {
  const { deps, envFile, configFile } = withAi(t);
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  for (const p of ['/api/admin/ai/models', '/api/admin/ai/keys']) assert.equal((await call(p, { cookie: owner })).status, 403);
  const admin = await loginAs(t, deps, call);
  const m = (await call('/api/admin/ai/models', { cookie: admin })).json;
  assert.deepEqual(m.cards.map((c) => [c.id, c.model]), [['main', '2anhPRO'], ['tts', 'giọng Leda'], ['image', 'gpt-image-2-medium']]);
  assert.deepEqual(m.models, ['2anhPRO', 'ag/gemini-3.8-flash-low']);
  assert.ok(!JSON.stringify(m).includes('sk-abcdefghijkl'), 'không lộ khoá cổng AI');
  const changed = await call('/api/admin/ai/model', { method: 'PUT', cookie: admin, body: { model: 'ag/gemini-3.8-flash-low' } });
  assert.equal(changed.status, 200);
  assert.match(readFileSync(configFile, 'utf8'), /default: ag\/gemini-3.8-flash-low/);
  const tried = (await call('/api/admin/ai/test', { method: 'POST', cookie: admin, body: {} })).json;
  assert.deepEqual([tried.ok, tried.reply], [true, 'Xin chào, mình sẵn sàng.']);
  const keys = (await call('/api/admin/ai/keys', { cookie: admin })).json;
  assert.ok(!JSON.stringify(keys).includes(SECRET));
  const put = await call('/api/admin/ai/keys/CORE_API_KEY', { method: 'PUT', cookie: admin, body: { value: 'core-moi-1234567890abcd' } });
  assert.equal(put.status, 200);
  assert.match(readFileSync(envFile, 'utf8'), /CORE_API_KEY=core-moi-1234567890abcd/);
  assert.equal(deps.restartFlags.get().assistant, null, 'khoá công cụ có hiệu lực ngay, không cần khởi động lại');
  const log = deps.activity.list().filter((e) => e.action.startsWith('ai_key'));
  assert.deepEqual(log.map((e) => [e.action, e.detail]), [['ai_key_set', 'CORE_API_KEY']]);
  assert.ok(!JSON.stringify(deps.activity.list()).includes('core-moi'), 'Nhật ký không ghi giá trị khoá');
  assert.equal((await call('/api/admin/ai/keys/ZALO_ALLOWED_USERS', { method: 'PUT', cookie: admin, body: { value: 'abcdefgh12345678' } })).status, 400);
});

test('Khoá API: danh sách khoá dự phòng qua API — thêm, dùng khoá khác; đổi khoá công cụ không bật cờ khởi động lại', async (t) => {
  const { deps, envFile } = withAi(t);
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const B = 'core-backup-zzzzzzzzzzzz7777';
  const add = await call('/api/admin/ai/keys/CORE_API_KEY/pool', { method: 'POST', cookie: admin, body: { value: B, label: 'dự phòng' } });
  assert.equal(add.status, 200);
  const row = add.json.keys.find((k) => k.key === 'CORE_API_KEY');
  assert.deepEqual(row.pool.map((e) => [e.id, e.active]), [['k1', true], ['k2', false]]);
  assert.ok(!JSON.stringify(add.json).includes(B) && !JSON.stringify(add.json).includes(SECRET));
  assert.equal((await call('/api/admin/ai/keys/CORE_API_KEY/pool/k2/activate', { method: 'POST', cookie: admin })).status, 200);
  assert.match(readFileSync(envFile, 'utf8'), new RegExp(`CORE_API_KEY=${B}`));
  assert.equal(deps.restartFlags.get().assistant, null, 'khoá công cụ có hiệu lực ngay — không cần khởi động lại');
  assert.deepEqual(deps.activity.list().filter((e) => e.action.startsWith('ai_key')).map((e) => e.action).sort(), ['ai_key_activate', 'ai_key_add']);
  assert.ok(!JSON.stringify(deps.activity.list()).includes(B));
});

test('Tạo ảnh & video: chỉ Quản trị; lưu thứ tự nguồn → chọn bộ điều phối 2anh + video Stali, bật cờ khởi động lại; thử không vẽ', async (t) => {
  const { deps, envFile, configFile } = withAi(t);
  writeFileSync(envFile, 'STALI_API_KEY=sk-stali-0123456789abcdef\n');
  deps.mediaEngines = createMediaEngines({ hermesHome: deps.dir, configFile, envFile, fetchImpl: async (url, init) => {
    assert.equal(init.method, undefined, 'Thử chỉ GET danh sách model');
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'req/gpt-image-2' }] }) };
  } });
  mkdirSync(join(deps.dir, 'zalo'), { recursive: true });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.equal((await call('/api/admin/ai/media', { cookie: owner })).status, 403);
  const admin = await loginAs(t, deps, call);
  const v = (await call('/api/admin/ai/media', { cookie: admin })).json;
  assert.deepEqual(v.settings.image.engines.map((e) => e.id), ['stali', '9router', 'codex']);
  assert.equal(v.ready.stali, true);
  assert.ok(!JSON.stringify(v).includes('sk-stali-0123'), 'không lộ khoá');
  const body = { settings: { image: { engines: [{ id: '9router', model: 'cx/gpt-image' }, { id: 'stali' }, { id: 'codex', enabled: false }] }, video: { model: 'veo-3.1', seconds: 8 } } };
  const saved = (await call('/api/admin/ai/media', { method: 'PUT', cookie: admin, body })).json;
  assert.deepEqual(saved.settings.image.engines.map((e) => e.id), ['9router', 'stali', 'codex']);
  assert.match(readFileSync(configFile, 'utf8'), /provider: 2anh/);
  assert.match(readFileSync(configFile, 'utf8'), /video_gen:\n {2}provider: stali/);
  assert.ok(deps.restartFlags.get().assistant, 'đổi nguồn → cần khởi động lại trợ lý');
  assert.equal((await call('/api/admin/ai/media', { method: 'PUT', cookie: admin, body: { settings: { video: { model: 'sora' } } } })).status, 400);
  const tried = (await call('/api/admin/ai/media/test', { method: 'POST', cookie: admin, body: { kind: 'image', engine: 'stali' } })).json;
  assert.equal(tried.result.ok, true);
  assert.deepEqual(deps.activity.list().filter((e) => e.action === 'media_engines').length, 1);
});

test('Trí nhớ dài hạn: thẻ đọc kho SQLite nội bộ theo account_id thật (không đọc tệp ngoài sidecar)', async (t) => {
  const { deps, configFile } = withAi(t);
  const sqliteFile = join(deps.dir, 'zalo.sqlite');
  deps.aiModels = createAiModels({ configFile, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), sqliteFile });
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);

  const before = (await call('/api/admin/ai/models', { cookie: admin })).json;
  assert.deepEqual(before.cards.filter((c) => c.id === 'memory'), [], 'config.yaml chưa bật zalo_memory → không có thẻ');

  writeFileSync(configFile, readFileSync(configFile, 'utf8').replace('model:\n', 'memory:\n  provider: zalo_memory\nmodel:\n'));
  const absent = (await call('/api/admin/ai/models', { cookie: admin })).json;
  assert.deepEqual(absent.cards.filter((c) => c.id === 'memory').map((c) => c.model), ['0 fact · 0 hồ sơ · 0 trí nhớ mềm']);

  // account_id thật là UID Zalo của bot, lấy từ tin nhắn mới nhất — không phải chuỗi cố định.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(sqliteFile);
  db.exec(`CREATE TABLE messages (account_id TEXT, timestamp_ms INTEGER);
    CREATE TABLE facts (fact_id INTEGER PRIMARY KEY, account_id TEXT, status TEXT, updated_at_ms INTEGER);
    CREATE TABLE profiles (account_id TEXT, updated_at_ms INTEGER);
    CREATE TABLE soft_memories (id INTEGER PRIMARY KEY, account_id TEXT, status TEXT, updated_at_ms INTEGER);`);
  db.prepare('INSERT INTO messages (account_id, timestamp_ms) VALUES (?,?)').run('bot-uid-1', 1_700_000_300_000);
  db.prepare('INSERT INTO facts (account_id, status, updated_at_ms) VALUES (?,?,?), (?,?,?), (?,?,?)')
    .run('bot-uid-1', 'active', 1_700_000_000_000, 'bot-uid-1', 'deleted', 1, 'khac', 'active', 1);
  db.prepare('INSERT INTO profiles (account_id, updated_at_ms) VALUES (?,?), (?,?)').run('bot-uid-1', 1_700_000_100_000, 'khac', 1);
  db.prepare('INSERT INTO soft_memories (account_id, status, updated_at_ms) VALUES (?,?,?)').run('bot-uid-1', 'active', 1_700_000_200_000);
  db.close();

  const after = (await call('/api/admin/ai/models', { cookie: admin })).json;
  const card = after.cards.find((c) => c.id === 'memory');
  assert.equal(card.model, '1 fact · 1 hồ sơ · 1 trí nhớ mềm', 'chỉ đếm dòng active của đúng UID bot');
  assert.match(card.note, /Cập nhật gần nhất \d{2}:\d{2} \d{2}-\d{2}/, 'mốc thời gian lấy từ dòng mới nhất');
  assert.ok(!JSON.stringify(after).includes('.openviking'), 'trang không còn phụ thuộc ov.conf');
});
