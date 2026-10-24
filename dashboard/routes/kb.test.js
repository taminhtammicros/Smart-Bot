import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKbStore } from '../lib/kb-store.js';
import { loginAs, makeDeps, startApp } from '../test-helpers.js';

function withKb(t) {
  const deps = makeDeps(t);
  const root = join(deps.dir, 'kho');
  mkdirSync(root);
  deps.kb = createKbStore({ kbDir: () => root, publicDirs: () => '' });
  return deps;
}

async function upload(base, cookie, name, body, headers = {}) {
  const res = await fetch(`${base}/api/kb/upload`, {
    method: 'POST', body,
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'zalo-dashboard', 'X-File-Name': encodeURIComponent(name), ...headers },
  });
  return { status: res.status, json: await res.json() };
}

test('kho tri thức: Chủ bot tải lên PDF, thấy trong danh sách, xoá được; Nhật ký có tên tệp', async (t) => {
  const deps = withKb(t);
  const { base, call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const up = await upload(base, owner, 'Kế hoạch tháng 10.pdf', Buffer.from('%PDF-1.7 nội dung'));
  assert.equal(up.status, 200);
  assert.equal(up.json.path, 'tai-len-dashboard/Kế hoạch tháng 10.pdf');
  const list = await call('/api/kb', { cookie: owner });
  assert.equal(list.json.configured, true);
  assert.deepEqual(list.json.own.map((f) => f.path), ['tai-len-dashboard/Kế hoạch tháng 10.pdf']);
  assert.equal((await call('/api/kb/file', { method: 'DELETE', cookie: owner, body: { path: up.json.path } })).status, 200);
  assert.deepEqual(deps.activity.list().filter((e) => e.action.startsWith('kb_')).map((e) => [e.action, e.detail]),
    [['kb_delete', 'tai-len-dashboard/Kế hoạch tháng 10.pdf'], ['kb_upload', 'tai-len-dashboard/Kế hoạch tháng 10.pdf']]);
});

test('kho tri thức: 401 chưa đăng nhập, sai định dạng 400, quá 10 MB 413 có câu dễ hiểu, xoá ngoài thư mục tải lên 403', async (t) => {
  const deps = withKb(t);
  const { base, call } = await startApp(t, deps);
  assert.equal((await call('/api/kb')).status, 401);
  const admin = await loginAs(t, deps, call);
  assert.equal((await upload(base, admin, 'a.exe', Buffer.from('MZ'))).status, 400);
  assert.equal((await upload(base, admin, 'a.pdf', Buffer.from('không phải pdf'))).status, 400);
  const big = await upload(base, admin, 'a.pdf', Buffer.alloc(10 * 1024 * 1024 + 10, 0x41));
  assert.equal(big.status, 413);
  assert.match(big.json.error, /10 MB/);
  assert.equal((await call('/api/kb/file', { method: 'DELETE', cookie: admin, body: { path: '../config.yaml' } })).status, 403);
});

test('kho tri thức gọn: viết tài liệu, sửa/đổi tên; đổi nguồn chỉ Quản trị, ghi .env, bật cờ khởi động lại', async (t) => {
  const deps = makeDeps(t);
  const root = join(deps.dir, 'kho');
  mkdirSync(join(root, 'Doan truong'), { recursive: true });
  const envFile = join(deps.dir, 'hermes.env');
  writeFileSync(envFile, '');
  deps.kb = createKbStore({ kbDir: () => root, allowedRoots: () => join(deps.dir, 'kho-khac'), envFile });
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const made = await call('/api/kb/note', { method: 'POST', cookie: owner, body: { title: 'Lịch trực', text: 'Thứ Hai: Lan' } });
  assert.equal(made.status, 200);
  assert.equal((await call(`/api/kb/own?path=${encodeURIComponent(made.json.path)}`, { cookie: owner })).json.text, 'Thứ Hai: Lan');
  const saved = await call('/api/kb/own', { method: 'PUT', cookie: owner, body: { path: made.json.path, name: 'Lịch trực tuần', text: 'Thứ Ba: Minh' } });
  assert.equal(saved.json.path, 'tai-len-dashboard/Lịch trực tuần.md');
  const list = await call('/api/kb', { cookie: owner });
  assert.deepEqual(list.json.own.map((f) => f.path), ['tai-len-dashboard/Lịch trực tuần.md']);
  assert.equal((await call('/api/admin/kb/source', { cookie: owner })).status, 403);
  assert.equal((await call('/api/admin/kb/source', { method: 'PUT', cookie: owner, body: { dir: root } })).status, 403);
  const admin = await loginAs(t, deps, call);
  assert.deepEqual((await call(`/api/admin/kb/source?dir=${encodeURIComponent(root)}`, { cookie: admin })).json.subdirs, ['Doan truong']);
  const other = join(deps.dir, 'kho-khac');
  mkdirSync(other);
  const put = await call('/api/admin/kb/source', { method: 'PUT', cookie: admin, body: { dir: other, allDirs: true } });
  assert.equal(put.status, 200);
  assert.match(readFileSync(envFile, 'utf8'), /ZALO_KB_DIR=/);
  assert.ok(deps.restartFlags.get().assistant, 'cần khởi động lại trợ lý');
  assert.ok(deps.activity.list().some((e) => e.action === 'kb_source'));
});

test('kho tri thức: xoá nhiều tài liệu một lần — kiểm từng đường dẫn như xoá một tệp; một dòng Nhật ký', async (t) => {
  const deps = withKb(t);
  const { base, call } = await startApp(t, deps);
  const paths = [];
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  for (const name of ['a.pdf', 'b.pdf']) paths.push((await upload(base, owner, name, Buffer.from('%PDF-1.7 x'))).json.path);
  assert.equal((await call('/api/kb/files/delete', { method: 'POST', body: { paths } })).status, 401);
  assert.equal((await call('/api/kb/files/delete', { method: 'POST', cookie: owner, body: { paths: [...paths, '../config.yaml'] } })).status, 403);
  assert.equal((await call('/api/kb', { cookie: owner })).json.own.length, 2);
  const r = await call('/api/kb/files/delete', { method: 'POST', cookie: owner, body: { paths } });
  assert.deepEqual([r.status, r.json.count], [200, 2]);
  assert.equal((await call('/api/kb?fresh=1', { cookie: owner })).json.own.length, 0);
  assert.deepEqual(deps.activity.list().filter((e) => e.action === 'kb_delete').map((e) => e.detail), ['2 tài liệu']);
});
