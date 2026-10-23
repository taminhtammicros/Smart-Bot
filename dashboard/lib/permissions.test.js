import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermissionsStore, FEATURE_KEYS, InvalidPermissions, makeDmEnv, makeGlobalReplyOnlyTagged, normalize, parseDm, parseGroupsPatch, parseSettings, parseStudio, STUDIO_FEATURES, studioPolicy } from './permissions.js';

const G = '2054797107487294899';
const allOn = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
const studioOff = () => Object.fromEntries(STUDIO_FEATURES.map((f) => [f.key, false]));
const settings = (over = {}, features = {}) => ({ active: true, replyOnlyTagged: true, paused: false, ...over, features: { ...allOn(), ...features } });

function setup(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-perm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'zalo', 'permissions.json');
  return { file, store: createPermissionsStore({ file, ...opts }), disk: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('chưa có tệp: mọi tính năng bật, cờ tag theo cài đặt chung, không tạo tệp', (t) => {
  const s = setup(t, { globalReplyOnlyTagged: false });
  const v = s.store.get();
  assert.equal(v.exists, false);
  assert.deepEqual(v.defaults, { active: true, replyOnlyTagged: false, paused: false, features: allOn(), studio: studioOff() });
  assert.deepEqual(v.groups, {});
  assert.equal(existsSync(s.file), false);
});

test('lưu nhóm chỉ ghi khoá khác mặc định; trùng mặc định thì xoá mục của nhóm', (t) => {
  const s = setup(t);
  const { state, changed } = s.store.setGroup(G, settings({ replyOnlyTagged: false }, { web: false }), 'Tổ Hoá');
  assert.deepEqual(changed, ['replyOnlyTagged', 'web']);
  assert.deepEqual(s.disk(), { version: 1, defaults: { replyOnlyTagged: true }, groups: { [G]: { name: 'Tổ Hoá', replyOnlyTagged: false, features: { web: false } } } });
  assert.equal(state.groups[G].custom, true);
  assert.equal(state.groups[G].features.kb, true);
  // Nhóm chưa chỉnh "kb" nên đi theo mặc định khi mặc định đổi.
  s.store.setDefaults(settings({}, { kb: false }));
  assert.equal(s.store.get().groups[G].features.kb, false);
  // Đưa về đúng mặc định → mục của nhóm biến mất.
  const back = s.store.setGroup(G, settings({}, { kb: false }));
  assert.deepEqual(back.changed, []);
  assert.deepEqual(s.disk().groups, {});
});

test('nhóm thuộc danh sách cũ "chỉ chủ nhân": lưu bằng mặc định vẫn giữ mục riêng (chỉ tên) để thắng danh sách đó', (t) => {
  const s = setup(t);
  s.store.setGroup(G, settings({}), 'CLB', { keep: true });
  assert.deepEqual(s.disk().groups, { [G]: { name: 'CLB' } });
  assert.equal(s.store.get().groups[G].active, true, 'mục chỉ tên đi theo mặc định');
  s.store.setGroup(G, settings({}), 'CLB');
  assert.deepEqual(s.disk().groups, {}, 'không thuộc danh sách cũ thì vẫn xoá như trước');
});

test('ghi nguyên tử, giữ .bak bản trước, quyền 600', (t) => {
  const s = setup(t);
  s.store.setDefaults(settings({}, { video: false }));
  s.store.setDefaults(settings({}, { voice: false }));
  assert.equal(s.disk().defaults.features.voice, false);
  assert.equal(JSON.parse(readFileSync(`${s.file}.bak`, 'utf8')).defaults.features.video, false);
  assert.equal(existsSync(`${s.file}.tmp`), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(s.file).mode & 0o777, 0o600);
    assert.equal(statSync(`${s.file}.bak`).mode & 0o777, 0o600);
  }
});

test('tệp hỏng: báo corrupt, hiện mặc định, không đổi tên tệp; lưu lại thì .bak giữ bản hỏng', (t) => {
  const s = setup(t);
  s.store.setDefaults(settings());
  writeFileSync(s.file, '{hỏng');
  const v = s.store.get();
  assert.equal(v.corrupt, true);
  assert.deepEqual(v.defaults.features, allOn());
  assert.equal(readFileSync(s.file, 'utf8'), '{hỏng');
  s.store.setGroup(G, settings({ active: false }));
  assert.equal(readFileSync(`${s.file}.bak`, 'utf8'), '{hỏng');
  assert.equal(s.store.get().corrupt, false);
});

test('normalize bỏ khoá lạ, sai kiểu, ID nhóm không phải số; sai phiên bản thì ném', () => {
  const n = normalize({ version: 1, defaults: { active: 'no', features: { web: false, lạ: false, kb: 1 } },
    groups: { abc: { active: false }, [G]: { name: ' Tổ Hoá ', active: false, features: [] }, '1': 'rác' } });
  assert.deepEqual(n, { version: 1, defaults: { features: { web: false } }, groups: { [G]: { name: 'Tổ Hoá', active: false }, 1: {} } });
  assert.throws(() => normalize({ version: 2 }));
  assert.throws(() => normalize([]));
});

test('parseSettings đòi đủ hai công tắc và đủ 9 nút boolean', () => {
  assert.deepEqual(parseSettings(settings({}, { web: false })).features.web, false);
  for (const bad of [null, [], { ...settings(), active: 'true' }, { ...settings(), replyOnlyTagged: undefined },
    { ...settings(), features: { ...allOn(), web: 'off' } }, { ...settings(), features: { ...allOn(), lạ: true } },
    { active: true, replyOnlyTagged: true, features: { web: true } }]) {
    assert.throws(() => parseSettings(bad), (e) => e.name === 'InvalidPermissions' && e.status === 400, JSON.stringify(bad));
  }
});

test('danh sách nút khớp FEATURES của plugin Python', () => {
  const py = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hermes-plugin', 'zalo_tools', 'group_permissions.py'), 'utf8');
  const tuple = /^FEATURES = \(([^)]*)\)/m.exec(py)[1];
  assert.deepEqual([...tuple.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]), FEATURE_KEYS);
});

test('lần lưu nhóm đầu tiên ghi cờ tag thật vào defaults một lần, không ghi vào nhóm', (t) => {
  const s = setup(t, { globalReplyOnlyTagged: false });
  // Bot đang trả lời mọi tin (cờ chung false); chỉ tắt "web" ở nhóm G → nhóm G không được thành chỉ-khi-tag.
  const { changed, state } = s.store.setGroup(G, settings({ replyOnlyTagged: false }, { web: false }));
  assert.deepEqual(changed, ['web']);
  assert.deepEqual(s.disk(), { version: 1, defaults: { replyOnlyTagged: false }, groups: { [G]: { features: { web: false } } } });
  assert.equal(state.groups[G].replyOnlyTagged, false);
  // Từ đó cờ tag so khác biệt như mọi khoá khác: đổi mặc định thì nhóm không chỉnh khoá này đi theo.
  s.store.setDefaults(settings({ replyOnlyTagged: true }));
  assert.equal(s.store.get().groups[G].replyOnlyTagged, true);
  assert.deepEqual(s.disk().groups[G], { features: { web: false } });
});

test('cờ chung lấy qua hàm: đọc lại mỗi lần, chỉ hạt giống một lần', (t) => {
  let flag = true;
  const s = setup(t, { globalReplyOnlyTagged: () => flag });
  assert.equal(s.store.get().defaults.replyOnlyTagged, true);
  flag = false;
  assert.equal(s.store.get().defaults.replyOnlyTagged, false);
  s.store.setGroup(G, settings({ replyOnlyTagged: false, active: false }));
  flag = true;
  // Đã có trong tệp → tệp thắng, không đổi theo cờ chung nữa.
  assert.equal(s.store.get().defaults.replyOnlyTagged, false);
  assert.deepEqual(s.disk().groups[G], { active: false });
});

test('tệp cũ ghi cờ tag vào từng nhóm: bằng hạt giống thì dọn, khác thì giữ — hành vi không đổi', (t) => {
  const s = setup(t, { globalReplyOnlyTagged: false });
  mkdirSync(dirname(s.file), { recursive: true });
  const H = '2054797107487294811';
  const K = '2054797107487294822';
  writeFileSync(s.file, JSON.stringify({ version: 1, defaults: {}, groups: {
    [G]: { name: 'A', replyOnlyTagged: false, features: { web: false } },
    [H]: { name: 'B', replyOnlyTagged: true },
    [K]: { name: 'C', replyOnlyTagged: false },
  } }));
  const before = s.store.get();
  s.store.setGroup('1', settings({ replyOnlyTagged: false, active: false }));
  const after = s.store.get();
  for (const id of [G, H, K]) {
    assert.equal(after.groups[id]?.replyOnlyTagged ?? after.defaults.replyOnlyTagged, before.groups[id].replyOnlyTagged, id);
  }
  assert.deepEqual(s.disk().groups[G], { name: 'A', features: { web: false } });
  assert.deepEqual(s.disk().groups[H], { name: 'B', replyOnlyTagged: true });
  assert.equal(s.disk().groups[K], undefined);
  assert.equal(after.groups[H].replyOnlyTagged, true);
});

test('tệp có BOM (sửa bằng Notepad) không bị coi là hỏng', (t) => {
  const s = setup(t);
  mkdirSync(dirname(s.file), { recursive: true });
  writeFileSync(s.file, `﻿${JSON.stringify({ version: 1, defaults: { features: { web: false } }, groups: {} })}`);
  const v = s.store.get();
  assert.equal(v.corrupt, false);
  assert.equal(v.defaults.features.web, false);
});

test('cờ tag chung đọc từ .env và config.yaml của Hermes như adapter, đọc lại khi tệp đổi', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zd-flag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const configFile = join(dir, 'config.yaml');
  const read = (inherited) => makeGlobalReplyOnlyTagged({ envFile, configFile, inherited })();
  // Không có gì → mặc định bật.
  assert.equal(read(undefined), true);
  // config.yaml do bộ cài ghi.
  writeFileSync(configFile, 'platforms:\n  zalo:\n    extra:\n      reply_only_tagged: false\n');
  assert.equal(read(undefined), false);
  // Biến môi trường dịch vụ khác rỗng đè config.yaml; .env của Hermes đè biến môi trường.
  assert.equal(read('yes'), true);
  writeFileSync(envFile, '﻿# ghi chú\nZALO_GROUP_REPLY_ONLY_TAGGED="off"\n');
  assert.equal(read('yes'), false);
  writeFileSync(envFile, 'ZALO_GROUP_REPLY_ONLY_TAGGED=On\n');
  assert.equal(read(undefined), true);
  // Rỗng trong .env → rơi về config.yaml (giống _env_enablement bỏ giá trị rỗng).
  writeFileSync(envFile, 'ZALO_GROUP_REPLY_ONLY_TAGGED=\n');
  assert.equal(read('true'), false);
  // Một bộ đọc dùng lâu dài thấy thay đổi của tệp.
  const live = makeGlobalReplyOnlyTagged({ envFile, configFile });
  assert.equal(live(), false);
  writeFileSync(envFile, 'ZALO_GROUP_REPLY_ONLY_TAGGED=true\nKHAC=1\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(envFile, later, later);
  assert.equal(live(), true);
});

test('quá 500 nhóm riêng thì từ chối nhóm mới bằng InvalidPermissions', (t) => {
  const s = setup(t);
  for (let i = 1; i <= 500; i++) s.store.setGroup(String(i), settings({ active: false }));
  assert.throws(() => s.store.setGroup(G, settings({ active: false })), (e) => e.name === 'InvalidPermissions' && /—/.test(e.message));
  assert.equal(s.store.setGroup('7', settings({ active: true }, { web: false })).state.groups['7'].custom, true);
});

// --- Nhắn riêng (spec §16) ---
const P1 = '1234567890123456';
const P2 = '2234567890123456789';
const dm8 = (over = {}) => ({ web: true, files: true, voice: true, reminders: true, kb: true, people: true, academic: true, video: true, history: true, ...over });

test('nhắn riêng: chưa có mục dm → theo ZALO_DM_POLICY, mọi nút bật; báo Hermes có đang chặn người ngoài không', (t) => {
  const s = setup(t, { dmEnv: () => ({ legacyWho: 'everyone', gatewayOpen: false }) });
  assert.deepEqual(s.store.get().dm, { who: 'everyone', explicit: false, gatewayOpen: false, features: dm8(), studio: studioOff(), people: [] });
});

test('nhắn riêng: lưu ghi who + 8 nút chung, người chỉ ghi nút khác; lưu nhóm sau đó không làm mất mục dm', (t) => {
  const s = setup(t);
  const state = s.store.setDm(parseDm({
    who: 'list', features: dm8({ web: false }),
    people: [{ uid: P1, name: '  Cô   Lan ', features: dm8({ web: true, voice: false }) }, { uid: P2, features: null }, { uid: P1, name: 'trùng', features: null }],
  }));
  assert.deepEqual(s.disk().dm, {
    who: 'list', features: dm8({ web: false }),
    people: { [P1]: { name: 'Cô Lan', features: { web: true, voice: false } }, [P2]: {} },
  });
  assert.deepEqual(state.dm.people, [
    { uid: P1, name: 'Cô Lan', custom: true, features: dm8({ voice: false }), studio: studioOff() },
    { uid: P2, name: '', custom: false, features: dm8({ web: false }), studio: studioOff() },
  ]);
  assert.equal(state.dm.explicit, true);
  s.store.setGroup(G, settings({}, { web: false }), 'Tổ Hoá');
  s.store.setDefaults(settings({}, { kb: false }));
  assert.equal(s.disk().dm.who, 'list', 'lưu nhóm/mặc định giữ nguyên mục dm');
  assert.equal(s.disk().version, 1, 'không đổi phiên bản tệp — bản v1.21+ vẫn đọc được');
});

test('parseDm: từ chối who lạ, thiếu nút, nút groupCron, UID là số điện thoại, quá 200 người', () => {
  const ok = { who: 'everyone', features: dm8(), people: [] };
  assert.deepEqual(parseDm(ok), ok);
  const bad = [
    [{ ...ok, who: 'all' }, /Chưa chọn ai/],
    [{ ...ok, features: { ...dm8(), groupCron: true } }, /tính năng/],
    [{ ...ok, features: { web: true } }, /tính năng/],
    [{ ...ok, people: 'x' }, /Danh sách người/],
    [{ ...ok, people: [{ uid: '0912345678' }] }, /không phải UID Zalo — .*\/sethome/],
    [{ ...ok, people: [{ uid: P1, features: { web: false } }] }, /Tính năng riêng/],
    [{ ...ok, people: Array.from({ length: 201 }, (_, i) => ({ uid: String(1234567890123456n + BigInt(i)) })) }, /tối đa 200/],
    [null, /Chưa chọn ai/],
  ];
  for (const [body, re] of bad) assert.throws(() => parseDm(body), (e) => e instanceof InvalidPermissions && re.test(e.message), JSON.stringify(body)?.slice(0, 60));
});

test('makeDmEnv: config.yaml thắng .env; "open" → mọi người; cờ mở cổng của Hermes; đọc lại khi tệp đổi', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zd-dmenv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const configFile = join(dir, 'config.yaml');
  const read = makeDmEnv({ envFile, configFile, inherited: { ZALO_ALLOW_ALL_USERS: 'true' } });
  assert.deepEqual(read(), { legacyWho: 'owners', gatewayOpen: true }, 'không có tệp: mặc định owner-only, cờ từ môi trường dịch vụ');
  let stamp = 1_700_000_000;
  const put = (path, text) => { writeFileSync(path, text); stamp += 10; utimesSync(path, stamp, stamp); };
  put(envFile, 'ZALO_DM_POLICY=open\nZALO_ALLOW_ALL_USERS=false\n');
  assert.deepEqual(read(), { legacyWho: 'everyone', gatewayOpen: false });
  put(configFile, 'platforms:\n  zalo:\n    extra:\n      dm_policy: owner-only\n');
  assert.equal(read().legacyWho, 'owners', 'extra.dm_policy trong config.yaml thắng .env như adapter');
  put(envFile, 'GATEWAY_ALLOW_ALL_USERS=1\n');
  assert.equal(read().gatewayOpen, true);
});

// --- Xưởng tạo sản phẩm (spec §17) ---
const studioOn = (over = {}) => ({ ...studioOff(), ...over });

test('xưởng: chưa có gì → 6 nút tắt, 3 lượt mỗi ngày; danh sách nút khớp STUDIO_FEATURES của plugin Python', (t) => {
  const s = setup(t);
  const v = s.store.get();
  assert.deepEqual(v.defaults.studio, studioOff());
  assert.deepEqual(v.dm.studio, studioOff());
  assert.deepEqual(v.studio, { quota: 3, image: 5, video: 1, people: [] });
  const py = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hermes-plugin', 'zalo_tools', 'group_permissions.py'), 'utf8');
  const tuple = /^STUDIO_FEATURES = \(([^)]*)\)/m.exec(py)[1];
  assert.deepEqual([...tuple.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]), STUDIO_FEATURES.map((f) => f.key));
});

test('xưởng: mặc định chỉ ghi nút đang bật vào features; nhóm ghi khác biệt + hạn mức riêng; null = theo mặc định', (t) => {
  const s = setup(t);
  s.store.setDefaults({ ...settings(), studio: studioOn({ studioSlides: true, studioDocs: true }) });
  assert.deepEqual(s.disk().defaults.features, { ...allOn(), studioSlides: true, studioDocs: true });
  const { changed, state } = s.store.setGroup(G, { ...settings(), studio: studioOn({ studioSlides: true, studioVideo: true }), studioQuota: 5 });
  assert.deepEqual(changed, ['studioDocs', 'studioVideo', 'studioQuota']);
  assert.deepEqual(s.disk().groups[G], { features: { studioDocs: false, studioVideo: true }, studioQuota: 5 });
  assert.deepEqual(state.groups[G].studio, studioOn({ studioSlides: true, studioVideo: true }));
  assert.deepEqual(state.groups[G].features, allOn(), 'nút xưởng không lẫn vào 9 nút');
  assert.equal(state.groups[G].studioQuota, 5);
  s.store.setGroup(G, { ...settings(), studio: studioOn({ studioSlides: true, studioDocs: true }), studioQuota: null });
  assert.equal(s.disk().groups[G], undefined, 'trùng mặc định và hạn mức theo mặc định → bỏ mục nhóm');
});

test('xưởng: bản giao diện cũ (không gửi studio/studioQuota) lưu mặc định, nhóm, nhắn riêng không làm mất nút xưởng', (t) => {
  const s = setup(t);
  s.store.setDefaults({ ...settings(), studio: studioOn({ studioExams: true }) });
  s.store.setGroup(G, { ...settings(), studio: studioOn({ studioExams: true, studioVideo: true }), studioQuota: 9 });
  s.store.setDm(parseDm({ who: 'everyone', features: dm8(), studio: studioOn({ studioSlides: true }),
    people: [{ uid: P1, features: dm8(), studio: studioOn({ studioDocs: true }) }] }));
  s.store.setStudio(parseStudio({ quota: 4, people: [{ uid: P2, name: 'Thầy Nam', quota: 10 }] }));
  s.store.setDefaults(parseSettings(settings({}, { web: false })));
  s.store.setGroup(G, parseSettings(settings({}, { kb: false })));
  s.store.setDm(parseDm({ who: 'everyone', features: dm8({ voice: false }), people: [{ uid: P1, features: dm8() }] }));
  const v = s.store.get();
  assert.deepEqual(v.defaults.studio, studioOn({ studioExams: true }));
  assert.deepEqual(v.groups[G].studio, studioOn({ studioExams: true, studioVideo: true }));
  assert.equal(v.groups[G].studioQuota, 9);
  assert.deepEqual(v.dm.studio, studioOn({ studioSlides: true }));
  assert.deepEqual(v.dm.people[0].studio, studioOn({ studioDocs: true }), 'người có tính năng riêng giữ nút xưởng riêng');
  assert.deepEqual(v.studio, { quota: 4, image: 5, video: 1, people: [{ uid: P2, name: 'Thầy Nam', quota: 10, image: null, video: null }] });
});

test('xưởng: normalize giữ mục studio hợp lệ, bỏ rác; parseSettings/parseStudio từ chối số lượt sai', () => {
  const n = normalize({ version: 1, defaults: { features: { studioVideo: true, studioX: true } }, groups: { [G]: { studioQuota: 51 } },
    studio: { quota: -1, people: { [P2]: { name: '  Thầy  Nam ', quota: 7 }, abc: { quota: 1 }, [P1]: { quota: 'x' } } } });
  assert.deepEqual(n.defaults, { features: { studioVideo: true } });
  assert.deepEqual(n.groups[G], {});
  assert.deepEqual(n.studio, { people: { [P2]: { name: 'Thầy Nam', quota: 7 } } });
  for (const bad of [{ ...settings(), studio: { studioSlides: true } }, { ...settings(), studio: { ...studioOff(), lạ: true } },
    { ...settings(), studioQuota: 1.5 }, { ...settings(), studioQuota: 99 }]) {
    assert.throws(() => parseSettings(bad), (e) => e instanceof InvalidPermissions && /—/.test(e.message), JSON.stringify(bad));
  }
  assert.equal(parseSettings({ ...settings(), studioQuota: null }).studioQuota, null);
  for (const bad of [null, { quota: 60, people: [] }, { quota: 3, people: [{ uid: '0912345678', quota: 1 }] },
    { quota: 3, people: [{ uid: P1, quota: -2 }] }, { quota: 3 }]) {
    assert.throws(() => parseStudio(bad), (e) => e instanceof InvalidPermissions && /—/.test(e.message), JSON.stringify(bad));
  }
  assert.deepEqual(parseStudio({ quota: 0, people: [{ uid: P1, quota: 2 }, { uid: P1, quota: 9 }] }),
    { quota: 0, image: 5, video: 1, people: [{ uid: P1, name: '', quota: 2, image: null, video: null }] });
});

test('xưởng: chính sách máy chủ — Windows video tắt; Linux theo studio-policy.json của plugin, thiếu/hỏng = tắt', (t) => {
  assert.deepEqual(studioPolicy('win32'), { videoBlocked: true, note: 'Máy chủ Windows không có hộp cát — video tắt' });
  const dir = mkdtempSync(join(tmpdir(), 'studio-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'studio-policy.json');
  assert.equal(studioPolicy('linux', file).videoBlocked, true, 'chưa có tệp');
  writeFileSync(file, '{hỏng');
  assert.equal(studioPolicy('linux', file).videoBlocked, true, 'tệp hỏng');
  writeFileSync(file, JSON.stringify({ version: 1, videoBlocked: false, note: '', sandbox: 'systemd' }));
  assert.deepEqual(studioPolicy('linux', file), { videoBlocked: false, note: '' });
  writeFileSync(file, JSON.stringify({ version: 1, videoBlocked: true, note: 'Máy chủ chưa dùng được hộp cát systemd — video tắt', sandbox: 'plain' }));
  assert.deepEqual(studioPolicy('linux', file), { videoBlocked: true, note: 'Máy chủ chưa dùng được hộp cát systemd — video tắt' });
  writeFileSync(file, JSON.stringify({ version: 1, videoBlocked: false, note: '' }));
  assert.equal(studioPolicy('win32', file).videoBlocked, true, 'Windows luôn tắt, tệp nói gì cũng vậy');
});

test('nhiều nhóm một lượt: chỉ đổi mục đã chọn, mục khác giữ giá trị riêng; nhóm trong thư mục so với nền thư mục', (t) => {
  const s = setup(t);
  const A = '200';
  const B = '300';
  const C = '400';
  s.store.setGroup(A, settings({}, { kb: false }), 'Tổ Hoá');
  const { id: fid } = s.store.createFolder('Lớp học');
  s.store.setFolderMembers(fid, [B]);
  s.store.setFolderSettings(fid, settings({}, { web: false }));
  const { changed } = s.store.setGroups([A, B, C], { active: false, studio: { studioSlides: true } }, { nameOf: (id) => (id === C ? 'Tổ Lý' : '') });
  assert.equal(changed, 3);
  const disk = s.disk();
  assert.deepEqual(disk.groups[A], { name: 'Tổ Hoá', active: false, features: { kb: false, studioSlides: true } }, 'giữ kb tắt của riêng nhóm');
  assert.deepEqual(disk.groups[B], { active: false, features: { studioSlides: true } }, 'web tắt là của thư mục — không chép vào nhóm');
  assert.deepEqual(disk.groups[C], { name: 'Tổ Lý', active: false, features: { studioSlides: true } });
  // Đưa về đúng nền thì mục riêng biến mất như setGroup.
  s.store.setGroups([B, C], { active: true, studio: { studioSlides: false } });
  assert.equal(s.disk().groups[B], undefined);
  assert.equal(s.disk().groups[C], undefined);
  // Nhóm thuộc danh sách cũ "chỉ chủ nhân" giữ mục chỉ có tên.
  s.store.setGroups([C], { replyOnlyTagged: true }, { nameOf: () => 'Tổ Lý', keepOf: () => true });
  assert.deepEqual(s.disk().groups[C], { name: 'Tổ Lý' });
});

test('parseGroupsPatch: đòi danh sách mã nhóm hợp lệ (tối đa 500, bỏ trùng) và ít nhất một thay đổi đúng kiểu', () => {
  assert.deepEqual(parseGroupsPatch({ ids: ['200', '200', '300'], patch: { active: false, features: { web: true }, studio: {} } }),
    { ids: ['200', '300'], patch: { active: false, features: { web: true } } });
  for (const bad of [
    null, { ids: [], patch: { active: true } }, { ids: ['abc'], patch: { active: true } }, { ids: [200], patch: { active: true } },
    { ids: Array.from({ length: 501 }, (_, i) => String(1000 + i)), patch: { active: true } },
    { ids: ['200'], patch: {} }, { ids: ['200'], patch: { active: 'có' } }, { ids: ['200'], patch: { features: { lạ: true } } },
    { ids: ['200'], patch: { features: { web: 1 } } }, { ids: ['200'], patch: { studio: { web: true } } }, { ids: ['200'], patch: { studioQuota: 3 } },
  ]) assert.throws(() => parseGroupsPatch(bad), InvalidPermissions, JSON.stringify(bad)?.slice(0, 60));
});

test('nhắc riêng: mỗi nhóm một câu, ghi khác biệt so với thư mục, xoá được, không rơi vào defaults', (t) => {
  const s = setup(t);
  const { setFolderMembers, createFolder } = s.store;
  const { id: fid } = createFolder('Lớp');
  setFolderMembers(fid, [G]);
  const A = '2054797107487294001';
  const B = '2054797107487294002';

  // Nhóm đặt câu của riêng mình → ghi vào mục nhóm, không đụng lớp thư mục.
  s.store.setGroup(A, settings({ soulReminder: 'Lớp 12A: xưng em, gọi các bạn là anh chị.' }), '12A');
  // Nhóm khác không đặt → không có câu nào, cũng không mượn câu của nhóm A.
  s.store.setGroup(B, settings({ active: false }), '12B');
  const groupA = s.store.get().groups[A];
  const groupB = s.store.get().groups[B];
  assert.equal(s.disk().groups[A].soulReminder, 'Lớp 12A: xưng em, gọi các bạn là anh chị.');
  assert.equal(s.disk().groups[B].soulReminder, undefined);
  assert.equal(groupA.soulReminder, 'Lớp 12A: xưng em, gọi các bạn là anh chị.');
  assert.equal(groupB.soulReminder, undefined, 'nhóm chưa đặt không được mượn câu của nhóm khác');
  // Lời nhắc toàn cục nằm ở Cấu hình (ZALO_SOUL_REMINDER), không bao giờ đi vào defaults của tệp này.
  assert.equal('soulReminder' in s.disk().defaults, false);

  // Để trống = bỏ câu riêng của nhóm.
  s.store.setGroup(A, settings(), '12A');
  assert.equal(s.disk().groups[A]?.soulReminder, undefined);
});

test('nhắc riêng: chuẩn hoá một dòng, cắt 1000 ký tự, từ chối kiểu sai', (t) => {
  const s = setup(t);
  s.store.setGroup(G, settings({ soulReminder: '  một\nhai   ba  ' }), 'Tổ');
  assert.equal(s.disk().groups[G].soulReminder, 'một hai ba');
  s.store.setGroup(G, settings({ soulReminder: 'x'.repeat(1200) }), 'Tổ');
  assert.equal(s.disk().groups[G].soulReminder.length, 1000);
  assert.throws(() => parseSettings({ ...settings(), soulReminder: 42 }), InvalidPermissions);
  assert.throws(() => parseSettings({ ...settings(), soulReminder: 'x'.repeat(1001) }), InvalidPermissions);
  // Không gửi khoá = giữ nguyên câu đang có (bản giao diện cũ vẫn lưu được nhóm).
  assert.equal('soulReminder' in parseSettings(settings()), false);
});

test('model riêng: nhóm ghim model, thư mục làm nền, nhóm thắng; để trống là bỏ ghim', (t) => {
  const s = setup(t);
  const { setFolderMembers, createFolder } = s.store;
  const { id: fid } = createFolder('Lớp');
  setFolderMembers(fid, [G]);
  const A = '2054797107487294003';

  // Thư mục ghim model → mọi nhóm trong thư mục dùng, kể cả nhóm chưa có mục riêng trong tệp
  // (mục riêng chỉ sinh ra khi nhóm khác nền — nền của nhóm trong thư mục chính là thư mục đó).
  s.store.setFolderSettings(fid, settings({ modelOverride: 'cx/gpt-5.4' }));
  assert.equal(s.disk().folders[fid].modelOverride, 'cx/gpt-5.4');
  const folderView = s.store.get().folders.find((f) => f.id === fid);
  assert.equal(folderView.modelOverride, 'cx/gpt-5.4');
  assert.equal(s.store.get().groups[G], undefined, 'nhóm không ghim riêng thì không sinh mục trong tệp');

  // Nhóm ghim riêng thì thắng thư mục — `changed` chỉ đúng khoá khác nền thư mục.
  assert.deepEqual(s.store.setGroup(A, settings({ modelOverride: 'Kira/glm-5.3' }), '12A').changed, ['modelOverride']);
  assert.equal(s.disk().groups[A].modelOverride, 'Kira/glm-5.3');
  assert.equal(s.store.get().groups[A].modelOverride, 'Kira/glm-5.3');
  assert.equal(s.store.get().groups[G], undefined, 'nhóm G không ghim riêng nên vẫn theo thư mục');

  // Để trống = bỏ ghim của nhóm, quay về thư mục; khoá cũ biến khỏi tệp.
  assert.deepEqual(s.store.setGroup(A, settings(), '12A').changed, ['modelOverride']);
  assert.equal(s.disk().groups[A]?.modelOverride, undefined);
  // Nhóm A không còn khoá nào khác nền thư mục nên mục riêng của nó biến mất — model vẫn là model thư mục.
  assert.equal(s.store.get().groups[A], undefined);
  assert.equal(s.store.get().folders.find((f) => f.id === fid).modelOverride, 'cx/gpt-5.4');

  // Nhóm ĐANG trong thư mục ghim đúng bằng model thư mục: không ghi khoá nào và `changed` rỗng —
  // giá trị đang hiệu lực y nguyên, nên dòng Nhật ký không được nói là vừa có thay đổi.
  assert.deepEqual(s.store.setGroup(G, settings({ modelOverride: 'cx/gpt-5.4' }), 'Tổ').changed, []);
  assert.equal(s.disk().groups[G], undefined);
  // Còn nhóm KHÔNG thuộc thư mục nào thì nền là mặc định (không model) — ghim là chỉnh riêng thật.
  assert.deepEqual(s.store.setGroup(A, settings({ modelOverride: 'cx/gpt-5.4' }), '12A').changed, ['modelOverride']);
  // Lưu lại y nguyên lần nữa: không còn gì đổi.
  assert.deepEqual(s.store.setGroup(A, settings({ modelOverride: 'cx/gpt-5.4' }), '12A').changed, []);
  s.store.setGroup(A, settings(), '12A');

  // Model chung đổi ở Khoá API & Model (config.yaml), không bao giờ đi vào defaults của tệp này.
  assert.equal('modelOverride' in s.disk().defaults, false);
  s.store.setDefaults(settings({ modelOverride: 'khong-duoc-ghi' }));
  assert.equal('modelOverride' in s.disk().defaults, false);
});

test('model riêng: bỏ ghim ở thư mục trả nhóm về model chung; tên lạ bị từ chối', (t) => {
  const s = setup(t);
  const { setFolderMembers, createFolder } = s.store;
  const { id: fid } = createFolder('Lớp');
  setFolderMembers(fid, [G]);
  s.store.setFolderSettings(fid, settings({ modelOverride: 'cx/gpt-5.4' }));
  s.store.setFolderSettings(fid, settings());
  assert.equal(s.store.get().groups[G], undefined, 'nhóm G không có mục riêng nào');
  assert.equal(s.disk().folders[fid].modelOverride, undefined);
  assert.equal(s.store.get().folders.find((f) => f.id === fid).modelOverride, undefined);

  // Chuỗi rỗng = "theo lớp trên"; khoảng trắng gộp lại (như tên model hay bị dán kèm xuống dòng);
  // tên có ký tự lạ hoặc quá dài bị từ chối trước khi ghi.
  assert.equal(parseSettings({ ...settings(), modelOverride: '' }).modelOverride, '');
  assert.equal(parseSettings({ ...settings(), modelOverride: '  Kira/glm-5.3  ' }).modelOverride, 'Kira/glm-5.3');
  assert.equal(parseSettings({ ...settings(), modelOverride: 'Kira/\n  glm-5.3' }).modelOverride, 'Kira/glm-5.3');
  for (const bad of [42, 'x'.repeat(121), 'model;rm -rf /', 'e\u0000m', 'a"b']) {
    assert.throws(() => parseSettings({ ...settings(), modelOverride: bad }), InvalidPermissions, JSON.stringify(bad));
  }
  // Không gửi khoá = giữ nguyên model đang ghim (bản giao diện cũ vẫn lưu được nhóm).
  assert.equal('modelOverride' in parseSettings(settings()), false);
});
