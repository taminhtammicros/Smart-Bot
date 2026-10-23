import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { createAgentConfig, createSoul } from './agent-config.js';

const CONFIG = 'model:\n  default: hermes\n  provider: custom\n  base_url: http://127.0.0.1:20128/v1\n  api_key: sk-bi-mat\nagent:\n  reasoning_effort: medium\nplatform_hints:\n  zalo:\n    append: Lễ phép.\nplatforms:\n  zalo:\n    extra:\n      model_choices: [hermes, ag/gemini-3.1-pro]\n';

function home(t) {
  const h = mkdtempSync(join(tmpdir(), 'zd-agent-'));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  writeFileSync(join(h, 'config.yaml'), CONFIG);
  return h;
}
const fakeFetch = (ids, calls = []) => async (url, opts) => { calls.push([url, opts.headers]); return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) }; };

test('xem: model, cổng AI chỉ tên máy, danh sách chọn nhanh, mức suy nghĩ, lời dặn Zalo — không bao giờ có khoá', (t) => {
  const h = home(t);
  const v = createAgentConfig({ configFile: join(h, 'config.yaml') }).view();
  assert.deepEqual({ ...v, zaloHint: undefined }, { model: 'hermes', provider: 'custom', endpoint: '127.0.0.1:20128', choices: ['hermes', 'ag/gemini-3.1-pro'], defaultModel: '', reasoning: 'medium', zaloHint: undefined });
  assert.equal(v.zaloHint, 'Lễ phép.');
  assert.doesNotMatch(JSON.stringify(v), /sk-bi-mat/);
});

test('xem: base_url có tài khoản/mật khẩu trong URL → chỉ tên máy, không lộ', (t) => {
  const h = home(t);
  writeFileSync(join(h, 'config.yaml'), CONFIG.replace('http://127.0.0.1:20128/v1', 'https://user:sk-trong-url@ai.example.vn/v1'));
  const v = createAgentConfig({ configFile: join(h, 'config.yaml') }).view();
  assert.equal(v.endpoint, 'ai.example.vn');
  assert.doesNotMatch(JSON.stringify(v), /sk-trong-url|sk-bi-mat/);
});

test('đổi model: chỉ tên có trên cổng AI, khoá gửi kèm ở máy chủ; sửa đúng model.default', async (t) => {
  const h = home(t);
  const calls = [];
  const a = createAgentConfig({ configFile: join(h, 'config.yaml'), fetchImpl: fakeFetch(['hermes', 'ag/gemini-3.1-pro'], calls) });
  assert.equal(await a.setModel('ag/gemini-3.1-pro'), true);
  assert.equal(calls[0][0], 'http://127.0.0.1:20128/v1/models');
  assert.equal(calls[0][1].Authorization, 'Bearer sk-bi-mat');
  const y = YAML.parse(readFileSync(join(h, 'config.yaml'), 'utf8'));
  assert.equal(y.model.default, 'ag/gemini-3.1-pro');
  assert.equal(y.model.api_key, 'sk-bi-mat');
  await assert.rejects(a.setModel('khong-co'), (e) => e.statusCode === 400);
  await assert.rejects(a.setModel('a b'), (e) => e.statusCode === 400);
  await assert.rejects(createAgentConfig({ configFile: join(h, 'config.yaml'), fetchImpl: async () => { throw new Error('ECONNREFUSED sk-bi-mat'); } }).models(),
    (e) => e.statusCode === 502 && !/sk-bi-mat/.test(e.message));
});

test('mức suy nghĩ: chỉ giá trị Hermes nhận', (t) => {
  const h = home(t);
  const a = createAgentConfig({ configFile: join(h, 'config.yaml') });
  a.setReasoning('high');
  assert.equal(YAML.parse(readFileSync(join(h, 'config.yaml'), 'utf8')).agent.reasoning_effort, 'high');
  assert.throws(() => a.setReasoning('max-max'), (e) => e.statusCode === 400);
});

test('SOUL.md: lưu cất bản cũ + bản gốc; khôi phục; giới hạn; không đổi thì không ghi', (t) => {
  const h = home(t);
  writeFileSync(join(h, 'SOUL.md'), 'Tôi là Uyển Nhi.');
  let clock = 1_790_000_000_000;
  const soul = createSoul({ hermesHome: h, historyDir: join(h, 'soul-history'), now: () => (clock += 1000) });
  assert.equal(soul.save('Tôi là Uyển Nhi, lễ phép.', 'anh'), true);
  assert.equal(soul.save('Tôi là Uyển Nhi, lễ phép.', 'anh'), false);
  soul.save('Bản thứ ba', 'Anh.Hai');
  const v = soul.view();
  assert.equal(v.text, 'Bản thứ ba');
  assert.deepEqual(v.history.map((x) => [x.original, x.by]), [[false, 'anhhai'], [false, 'anh'], [true, '']]);
  assert.equal(soul.snapshot('original'), 'Tôi là Uyển Nhi.');
  soul.restore('original', 'anh');
  assert.equal(readFileSync(join(h, 'SOUL.md'), 'utf8'), 'Tôi là Uyển Nhi.');
  assert.throws(() => soul.save('   ', 'anh'), (e) => e.statusCode === 400);
  assert.throws(() => soul.save('x'.repeat(20_001), 'anh'), (e) => e.statusCode === 400);
  assert.throws(() => soul.snapshot('../config'), (e) => e.statusCode === 404);
});

test('SOUL.md: giữ 30 bản cũ + bản gốc; bản gốc không bao giờ bị xoá', (t) => {
  const h = home(t);
  writeFileSync(join(h, 'SOUL.md'), 'Bản 0');
  let clock = 1_790_000_000_000;
  const soul = createSoul({ hermesHome: h, historyDir: join(h, 'soul-history'), now: () => (clock += 1000) });
  for (let i = 1; i <= 35; i += 1) soul.save(`Bản ${i}`, 'anh');
  const hist = soul.view().history;
  assert.equal(hist.length, 31);
  assert.equal(hist.at(-1).original, true);
  assert.equal(soul.snapshot('original'), 'Bản 0');
  assert.equal(soul.snapshot(hist[0].id), 'Bản 34', 'bản mới nhất là bản ngay trước bản hiện tại');
});

test('mức suy nghĩ: config.yaml chưa có mục agent: → tạo mới', (t) => {
  const h = home(t);
  writeFileSync(join(h, 'config.yaml'), 'model:\n  default: hermes\n');
  createAgentConfig({ configFile: join(h, 'config.yaml') }).setReasoning('high');
  assert.equal(YAML.parse(readFileSync(join(h, 'config.yaml'), 'utf8')).agent.reasoning_effort, 'high');
});

test('SOUL.md: text không phải chuỗi → 400', (t) => {
  const h = home(t);
  const soul = createSoul({ hermesHome: h, historyDir: join(h, 'soul-history') });
  for (const bad of [undefined, null, 5, ['a'], { a: 1 }]) assert.throws(() => soul.save(bad, 'anh'), (e) => e.statusCode === 400);
});

test('models: cổng trả chậm vẫn lấy được, và nhớ kết quả cho lần sau', async (t) => {
  const h = home(t);
  let calls = 0;
  // Cổng thật trả ~2400 model / hơn 1 MB mất 11–13 giây; hạn chờ cũ 10 s luôn hết trước khi cổng kịp trả.
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, json: async () => ({ data: [{ id: 'AntiGravity' }, { id: 'NANO-FREE-COMBO' }] }) };
  };
  const a = createAgentConfig({ configFile: join(h, 'config.yaml'), fetchImpl });
  assert.deepEqual(await a.models(), ['AntiGravity', 'NANO-FREE-COMBO']);
  assert.equal(calls, 1);
  assert.deepEqual(await a.models(), ['AntiGravity', 'NANO-FREE-COMBO']);
  assert.equal(calls, 1, 'lần hai lấy từ bản đã nhớ, không gọi cổng nữa');
  await a.models({ fresh: true });
  assert.equal(calls, 2, 'fresh: true (nút Tải lại danh sách) hỏi thẳng cổng');
});

test('models: cổng trả rỗng KHÔNG được nhớ — lần sau phải hỏi lại', async (t) => {
  const h = home(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? { ok: true, json: async () => ({ data: [] }) }
      : { ok: true, json: async () => ({ data: [{ id: 'hermes' }] }) };
  };
  const a = createAgentConfig({ configFile: join(h, 'config.yaml'), fetchImpl });
  assert.deepEqual(await a.models(), []);
  assert.deepEqual(await a.models(), ['hermes'], 'cổng vừa trả được thì phải thấy ngay, không bị khoá vào bản rỗng');
});

test('models: cổng im thì báo 502 rõ ràng, không treo vô hạn', async (t) => {
  const h = home(t);
  const a = createAgentConfig({ configFile: join(h, 'config.yaml'), fetchImpl: async () => { throw new Error('fetch connect timeout'); } });
  await assert.rejects(a.models(), (e) => e.statusCode === 502 && /danh sách model/.test(e.message));
});
