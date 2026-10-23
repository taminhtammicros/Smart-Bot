import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentConfig } from '../lib/agent-config.js';
import { FEATURE_KEYS, STUDIO_FEATURES } from '../lib/permissions.js';
import { fakeSidecar, loginAs, makeDeps, startApp } from '../test-helpers.js';

const G = '2054797107487294899';
const allOn = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
const body = (over = {}, features = {}) => ({ active: true, replyOnlyTagged: true, paused: false, ...over, features: { ...allOn(), ...features } });

async function ready(t, overrides = {}) {
  const deps = makeDeps(t, overrides);
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const disk = () => JSON.parse(readFileSync(join(deps.dir, 'zalo', 'permissions.json'), 'utf8'));
  return { deps, call, admin, owner, disk };
}

test('phân quyền trả kèm UID chủ nhân (bảng Quyền trong Phiên chat nói "chủ nhân luôn được")', async (t) => {
  const deps = makeDeps(t, { owners: { list: () => ['123456789012345678'] } });
  const { call } = await startApp(t, deps);
  const cookie = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  assert.deepEqual((await call('/api/permissions', { cookie })).json.ownerUids, ['123456789012345678']);
});

test('thư mục nhóm qua API: tạo → đặt nhóm → cài đặt → tắt nhanh → xoá; ghi Nhật ký; dữ liệu sai → 400; chưa đăng nhập → 401', async (t) => {
  const { deps, call, owner, disk } = await ready(t);
  const G2 = '2054797107487294811';
  assert.equal((await call('/api/permissions/folders', { method: 'POST', body: { name: 'X' } })).status, 401);
  const made = await call('/api/permissions/folders', { method: 'POST', cookie: owner, body: { name: 'Lớp học' } });
  assert.equal(made.status, 200);
  const fid = made.json.created;
  assert.equal(made.json.folders[0].name, 'Lớp học');
  assert.equal((await call(`/api/permissions/folders/${fid}/members`, { method: 'PUT', cookie: owner, body: { groups: [G, G2] } })).status, 200);
  const set = await call(`/api/permissions/folders/${fid}/settings`, { method: 'PUT', cookie: owner, body: body({}, { web: false }) });
  assert.equal(set.status, 200);
  assert.equal(disk().folders[fid].features.web, false);
  const off = await call(`/api/permissions/folders/${fid}/active`, { method: 'PUT', cookie: owner, body: { active: false } });
  assert.equal(off.status, 200);
  assert.equal(disk().folders[fid].active, false);
  assert.equal((await call(`/api/permissions/folders/${fid}`, { method: 'PUT', cookie: owner, body: { name: '  ' } })).status, 400);
  assert.equal((await call(`/api/permissions/folders/${fid}/members`, { method: 'PUT', cookie: owner, body: { groups: ['abc'] } })).status, 400);
  assert.equal((await call('/api/permissions/folders/khongco/settings', { method: 'PUT', cookie: owner, body: body() })).status, 400);
  assert.equal((await call(`/api/permissions/folders/${fid}`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal(disk().folders?.[fid], undefined);
  const log = deps.activity.list ? deps.activity.list({}) : null;
  const lines = JSON.stringify(log ?? readFileSync(join(deps.dir, 'activity.jsonl'), 'utf8'));
  for (const bit of ['tạo thư mục \\"Lớp học\\"', 'tắt bot cả thư mục', 'xoá thư mục']) assert.ok(lines.includes(bit), bit);
});

test('chưa đăng nhập → 401 ở mọi route phân quyền', async (t) => {
  const { call } = await ready(t);
  for (const [path, method] of [['/api/permissions', 'GET'], ['/api/groups', 'GET'],
    ['/api/permissions/defaults', 'PUT'], [`/api/permissions/groups/${G}`, 'PUT']]) {
    assert.equal((await call(path, { method, body: method === 'PUT' ? body() : undefined })).status, 401, path);
  }
});

test('Chủ bot xem và sửa được phân quyền (spec §6), có hiệu lực trong tệp ngay', async (t) => {
  const { call, owner, disk, deps } = await ready(t, { sidecar: fakeSidecar({ groups: async () => [{ id: G, name: 'Tổ Hoá', members: 12 }] }) });
  const first = await call('/api/permissions', { cookie: owner });
  assert.equal(first.status, 200);
  assert.equal(first.json.exists, false);
  assert.deepEqual(first.json.features.map((f) => f.key), FEATURE_KEYS);
  assert.deepEqual(first.json.defaults.features, allOn());

  const saved = await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: owner, body: body({ active: false }, { web: false }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.groups[G], { name: 'Tổ Hoá', custom: true, folder: null, active: false, replyOnlyTagged: true, paused: false, features: { ...allOn(), web: false },
    studio: Object.fromEntries(STUDIO_FEATURES.map((f) => [f.key, false])), studioQuota: null, imageQuota: null, videoQuota: null });
  assert.deepEqual(disk().groups[G], { name: 'Tổ Hoá', active: false, features: { web: false } });
  // Lần lưu đầu ghi cờ tag thật của bot vào mặc định một lần, không ghi vào nhóm.
  assert.equal(disk().defaults.replyOnlyTagged, true);

  const log = deps.activity.list();
  assert.equal(log[0].actor, 'khach');
  assert.equal(log[0].action, 'permissions_group');
  assert.equal(log[0].detail, 'Tổ Hoá: Tạm tắt · chỉ trả lời khi được tag · tắt: Tra cứu web');
});

test('lưu mặc định ghi đủ khoá; nhóm đưa về đúng mặc định thì mục riêng biến mất', async (t) => {
  const { call, admin, disk, deps } = await ready(t);
  const d = await call('/api/permissions/defaults', { method: 'PUT', cookie: admin, body: body({ replyOnlyTagged: false }, { video: false }) });
  assert.equal(d.status, 200);
  assert.deepEqual(disk().defaults, { active: true, replyOnlyTagged: false, features: { ...allOn(), video: false } });
  await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({}, { video: false }) });
  assert.deepEqual(disk().groups[G], { replyOnlyTagged: true }); // khác mặc định; bot chưa biết tên nhóm này → không ghi name
  await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({ replyOnlyTagged: false }, { video: false }) });
  assert.deepEqual(disk().groups, {});
  assert.match(deps.activity.list()[0].detail, /: dùng mặc định$/);
});

test('dữ liệu sai → 400 tiếng Việt, tệp không đổi', async (t) => {
  const { call, admin, deps } = await ready(t);
  for (const [path, payload] of [
    ['/api/permissions/groups/abc', body()],
    [`/api/permissions/groups/${G}`, { ...body(), active: 'true' }],
    [`/api/permissions/groups/${G}`, { ...body(), features: { web: true } }],
    ['/api/permissions/defaults', { ...body(), features: { ...allOn(), lạ: true } }],
  ]) {
    const res = await call(path, { method: 'PUT', cookie: admin, body: payload });
    assert.equal(res.status, 400, path);
    assert.match(res.json.error, /—/);
  }
  assert.equal(deps.permissions.get().exists, false);
});

test('tệp hỏng: GET báo corrupt và mặc định; lưu ghi lại tệp sạch', async (t) => {
  const { call, admin, deps, disk } = await ready(t);
  await call('/api/permissions/defaults', { method: 'PUT', cookie: admin, body: body() });
  writeFileSync(join(deps.dir, 'zalo', 'permissions.json'), 'không phải json');
  const res = await call('/api/permissions', { cookie: admin });
  assert.equal(res.json.corrupt, true);
  assert.deepEqual(res.json.defaults.features, allOn());
  await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({}, { kb: false }) });
  assert.equal(disk().version, 1);
});

test('GET /api/groups: tên trùng ID thành tên dự phòng; bot tắt → 503 tiếng Việt', async (t) => {
  const { call, admin } = await ready(t, { sidecar: fakeSidecar({ groups: async () => [
    { id: G, name: G, members: 3 }, { id: '200', name: 'Tổ Hoá', members: 12 }, { id: 'x', name: 'lạ' },
  ] }) });
  const res = await call('/api/groups', { cookie: admin });
  assert.deepEqual(res.json.groups, [
    { id: G, name: 'Nhóm chưa rõ tên', members: 3 }, { id: '200', name: 'Tổ Hoá', members: 12 },
  ]);
  const down = await ready(t, { sidecar: fakeSidecar({ groups: async () => { throw Object.assign(new Error('x'), { name: 'SidecarDown' }); } }) });
  const off = await down.call('/api/groups', { cookie: down.admin });
  assert.equal(off.status, 503);
  assert.match(off.json.error, /Kết nối Zalo đang tắt/);
});

test('Nhật ký hỏng không biến lần lưu thành công thành 500', async (t) => {
  const { call, admin, disk, deps } = await ready(t);
  deps.activity.append = () => { throw new Error('đĩa đầy'); };
  const res = await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({ active: false }) });
  assert.equal(res.status, 200);
  assert.equal(disk().groups[G].active, false);
});

test('quá 500 nhóm riêng → 400 có hướng dẫn; nhóm đã có vẫn sửa được', async (t) => {
  const { call, admin, deps } = await ready(t);
  for (let i = 1; i <= 500; i++) deps.permissions.setGroup(String(i), { active: false, replyOnlyTagged: true, features: allOn() });
  const over = await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({ active: false }) });
  assert.equal(over.status, 400);
  assert.match(over.json.error, /500.*—/);
  const again = await call('/api/permissions/groups/1', { method: 'PUT', cookie: admin, body: body({ active: true }) });
  assert.equal(again.status, 200);
});

test('nhắn riêng: Chủ bot lưu được, tệp có mục dm, Nhật ký ghi dòng dễ đọc; 401 khi chưa đăng nhập; 400 kèm bước tiếp theo', async (t) => {
  const { call, owner, disk, deps } = await ready(t);
  const dm8 = (over = {}) => ({ web: true, files: true, voice: true, reminders: true, kb: true, people: true, academic: true, video: true, history: true, ...over });
  const payload = { who: 'list', features: dm8({ video: false }), people: [{ uid: '1234567890123456', name: 'Cô Lan', features: dm8({ voice: false }) }] };
  assert.equal((await call('/api/permissions/dm', { method: 'PUT', body: payload })).status, 401);
  const first = await call('/api/permissions', { cookie: owner });
  assert.deepEqual(first.json.dmFeatures.map((f) => f.key), ['web', 'files', 'voice', 'reminders', 'kb', 'people', 'academic', 'video', 'history']);
  assert.equal(first.json.dm.explicit, false);
  const saved = await call('/api/permissions/dm', { method: 'PUT', cookie: owner, body: payload });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.dm.who, 'list');
  assert.deepEqual(saved.json.dmFeatures.map((f) => f.key), first.json.dmFeatures.map((f) => f.key));
  assert.deepEqual(disk().dm.people, { '1234567890123456': { name: 'Cô Lan', features: { voice: false, video: true } } });
  const log = readFileSync(join(deps.dir, 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(log.action, 'permissions_dm');
  assert.equal(log.detail, 'Những người trong danh sách · tắt: Video · 1 người trong danh sách (1 chỉnh riêng)');
  const bad = await call('/api/permissions/dm', { method: 'PUT', cookie: owner, body: { ...payload, people: [{ uid: '0912345678' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /—/);
  const group = await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: owner, body: body({}, { web: false }) });
  assert.equal(group.json.dm.who, 'list', 'lưu nhóm trả kèm mục dm để giao diện không mất');
  assert.ok(Array.isArray(group.json.dmFeatures));
});

test('xưởng: lưu nút xưởng + hạn mức nhóm, hạn mức theo người; Nhật ký ghi rõ; 400 kèm bước tiếp theo', async (t) => {
  const { call, owner, disk, deps } = await ready(t);
  const off = Object.fromEntries(STUDIO_FEATURES.map((f) => [f.key, false]));
  const first = await call('/api/permissions', { cookie: owner });
  assert.deepEqual(first.json.studioFeatures.map((f) => f.key), Object.keys(off));
  assert.deepEqual(first.json.studio, { quota: 3, image: 5, video: 1, people: [] });
  const g = await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: owner,
    body: { ...body(), studio: { ...off, studioSlides: true }, studioQuota: 5 } });
  assert.equal(g.status, 200);
  assert.deepEqual(disk().groups[G], { features: { studioSlides: true }, studioQuota: 5 });
  assert.match(deps.activity.list()[0].detail, /xưởng: Slide PowerPoint · 5 lượt\/người\/ngày$/);
  const q = await call('/api/permissions/studio', { method: 'PUT', cookie: owner, body: { quota: 2, people: [{ uid: '1234567890123456', name: 'Cô Lan', quota: 10 }] } });
  assert.equal(q.status, 200);
  assert.deepEqual(q.json.studio, { quota: 2, image: 5, video: 1, people: [{ uid: '1234567890123456', name: 'Cô Lan', quota: 10, image: null, video: null }] });
  assert.deepEqual(disk().studio, { quota: 2, image: 5, video: 1, people: { '1234567890123456': { name: 'Cô Lan', quota: 10 } } });
  assert.equal(deps.activity.list()[0].detail, 'Mặc định 2 lượt/người/ngày · 1 người có hạn mức riêng');
  assert.equal(disk().groups[G].studioQuota, 5, 'lưu hạn mức không đụng nhóm');
  for (const bad of [{ quota: 99, people: [] }, { quota: 2, people: [{ uid: '0912345678', quota: 1 }] }]) {
    const res = await call('/api/permissions/studio', { method: 'PUT', cookie: owner, body: bad });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /—/);
  }
  assert.equal((await call('/api/permissions/studio', { method: 'PUT', body: { quota: 1, people: [] } })).status, 401);
});

test('xưởng: phản hồi phân quyền mang chính sách máy chủ (Windows: video tắt)', async (t) => {
  const win = await ready(t, { platform: 'win32' });
  const res = await win.call('/api/permissions', { cookie: win.owner });
  assert.deepEqual(res.json.studioPolicy, { videoBlocked: true, note: 'Máy chủ Windows không có hộp cát — video tắt' });
  // Linux: theo studio-policy.json của plugin (group_permissions.publish_video_policy); chưa có tệp → đóng.
  const dir = mkdtempSync(join(tmpdir(), 'studio-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'studio-policy.json');
  const lin = await ready(t, { platform: 'linux', studioPolicyFile: file });
  const policy = async () => (await lin.call('/api/permissions', { cookie: lin.owner })).json.studioPolicy;
  assert.equal((await policy()).videoBlocked, true, 'plugin chưa ghi chính sách: video tắt');
  writeFileSync(file, JSON.stringify({ version: 1, videoBlocked: false, note: '', sandbox: 'systemd' }));
  assert.deepEqual(await policy(), { videoBlocked: false, note: '' });
  writeFileSync(file, JSON.stringify({ version: 1, videoBlocked: true, note: 'Máy chủ chưa dùng được hộp cát systemd — video tắt', sandbox: 'plain' }));
  assert.deepEqual(await policy(), { videoBlocked: true, note: 'Máy chủ chưa dùng được hộp cát systemd — video tắt' });
});

test('PUT /api/permissions/groups: áp một thay đổi cho nhiều nhóm, một dòng Nhật ký; sai → 400; chưa đăng nhập → 401', async (t) => {
  const G2 = '2054797107487294811';
  const { call, owner, disk, deps } = await ready(t, { sidecar: fakeSidecar({ groups: async () => [{ id: G, name: 'Tổ Hoá', members: 12 }] }) });
  const patch = { ids: [G, G2], patch: { replyOnlyTagged: false, features: { web: false } } };
  assert.equal((await call('/api/permissions/groups', { method: 'PUT', body: patch })).status, 401);
  await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: owner, body: body({}, { kb: false }) });
  const res = await call('/api/permissions/groups', { method: 'PUT', cookie: owner, body: patch });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.features.map((f) => f.key), FEATURE_KEYS, 'cùng dạng trả về với route một nhóm');
  assert.deepEqual(disk().groups[G], { name: 'Tổ Hoá', replyOnlyTagged: false, features: { kb: false, web: false } });
  assert.deepEqual(disk().groups[G2], { replyOnlyTagged: false, features: { web: false } });
  const log = deps.activity.list();
  assert.equal(log[0].action, 'permissions_group');
  assert.equal(log[0].detail, '2 nhóm: trả lời mọi tin · tắt: Tra cứu web');
  const before = JSON.stringify(disk());
  for (const bad of [{ ids: ['abc'], patch: { active: true } }, { ids: [G], patch: {} }, { ids: [G], patch: { features: { web: 'x' } } }]) {
    const r = await call('/api/permissions/groups', { method: 'PUT', cookie: owner, body: bad });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /—/);
  }
  assert.equal(JSON.stringify(disk()), before);
});

test('thêm người vào thư mục qua API (Liên hệ): giữ người cũ, ghi Nhật ký; dữ liệu sai → 400; chưa đăng nhập → 401', async (t) => {
  const { call, owner, disk } = await ready(t);
  const fid = (await call('/api/permissions/folders', { method: 'POST', cookie: owner, body: { name: 'Trải nghiệm' } })).json.created;
  const P = '1111111111111111111'; const Q = '2222222222222222222';
  assert.equal((await call(`/api/permissions/folders/${fid}/people/add`, { method: 'POST', body: { people: [{ uid: P }] } })).status, 401);
  assert.equal((await call(`/api/permissions/folders/${fid}/people/add`, { method: 'POST', cookie: owner, body: { people: [{ uid: P, name: 'Lan' }] } })).status, 200);
  const res = await call(`/api/permissions/folders/${fid}/people/add`, { method: 'POST', cookie: owner, body: { people: [{ uid: Q, name: 'Minh' }] } });
  assert.equal(res.status, 200);
  assert.deepEqual(disk().folders[fid].people, [{ uid: P, name: 'Lan' }, { uid: Q, name: 'Minh' }]);
  assert.equal((await call(`/api/permissions/folders/${fid}/people/add`, { method: 'POST', cookie: owner, body: { people: 'x' } })).status, 400);
  assert.equal((await call('/api/permissions/folders/khong-co/people/add', { method: 'POST', cookie: owner, body: { people: [{ uid: P }] } })).status, 400);
});

test('model riêng qua API: phải có trên cổng AI mới lưu; ghim nhóm/thư mục; dòng Nhật ký nêu tên model', async (t) => {
  // Cổng AI giả: chỉ có đúng hai model — giống `agentConfig.models()` thật đọc `<base_url>/models`.
  const deps = makeDeps(t);
  const configFile = join(deps.dir, 'config.yaml');
  writeFileSync(configFile, 'model:\n  default: hermes\n  base_url: http://127.0.0.1:20128/v1\n  api_key: sk-test\n');
  deps.agentConfig = createAgentConfig({
    configFile,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'hermes' }, { id: 'Kira/glm-5.3' }] }) }),
  });
  const { call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const disk = () => JSON.parse(readFileSync(join(deps.dir, 'zalo', 'permissions.json'), 'utf8'));

  // Tên không có trên cổng AI → 400 kèm cách sửa, tệp không đổi.
  const bogus = await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({ modelOverride: 'khong-co-model-nay' }) });
  assert.equal(bogus.status, 400);
  assert.match(bogus.json.error, /Cổng AI không có model khong-co-model-nay/);
  assert.equal((await call('/api/permissions', { cookie: admin })).json.groups?.[G], undefined);

  // Tên có thật → lưu vào mục nhóm + Nhật ký nói rõ model riêng.
  const ok = await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({ modelOverride: 'Kira/glm-5.3' }) });
  assert.equal(ok.status, 200);
  assert.equal(disk().groups[G].modelOverride, 'Kira/glm-5.3');
  const log = deps.activity.list().filter((e) => e.action === 'permissions_group').pop();
  assert.match(log.detail, /model riêng: Kira\/glm-5\.3/);

  // Thư mục cũng nhận model riêng; nhóm trong thư mục thừa hưởng khi không ghim riêng.
  const fid = (await call('/api/permissions/folders', { method: 'POST', cookie: admin, body: { name: 'Lớp' } })).json.created;
  const G2 = '2054797107487294812';
  await call(`/api/permissions/folders/${fid}/members`, { method: 'PUT', cookie: admin, body: { groups: [G, G2] } });
  assert.equal((await call(`/api/permissions/folders/${fid}/settings`, { method: 'PUT', cookie: admin, body: body({ modelOverride: 'hermes' }) })).status, 200);
  assert.equal(disk().folders[fid].modelOverride, 'hermes');
  // Nhóm G ghim riêng "Kira/glm-5.3" nên thắng model thư mục; nhóm G2 đi theo thư mục nên không có mục riêng.
  assert.equal(disk().groups[G].modelOverride, 'Kira/glm-5.3');
  assert.equal(disk().groups[G2], undefined);
  assert.equal((await call('/api/permissions', { cookie: admin })).json.folders.find((f) => f.id === fid).modelOverride, 'hermes');

  // Bỏ ghim: gửi chuỗi rỗng, khoá biến khỏi mục nhóm.
  assert.equal((await call(`/api/permissions/groups/${G}`, { method: 'PUT', cookie: admin, body: body({ modelOverride: '' }) })).status, 200);
  assert.equal(disk().groups[G], undefined);

  // Chủ bot cũng sửa được (như mọi mục khác của Phân quyền Bot), chưa đăng nhập thì 401.
  const owner = await loginAs(t, deps, call, { username: 'chu', role: 'owner' });
  assert.equal((await call(`/api/permissions/groups/${G2}`, { method: 'PUT', cookie: owner, body: body({ modelOverride: 'hermes' }) })).status, 200);
  assert.equal((await call(`/api/permissions/groups/${G2}`, { method: 'PUT', body: body({ modelOverride: 'hermes' }) })).status, 401);
});
