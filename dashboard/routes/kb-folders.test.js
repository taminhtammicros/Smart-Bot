import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createKbStore } from '../lib/kb-store.js';
import { loginAs, makeDeps, startApp } from '../test-helpers.js';

function withKb(t) {
  const deps = makeDeps(t);
  const root = join(deps.dir, 'kho');
  mkdirSync(root);
  deps.kb = createKbStore({ kbDir: () => root, foldersFile: join(deps.dir, 'kb-folders.json') });
  return deps;
}

const kbLog = (deps) => deps.activity.list().filter((e) => /^kb_(folder|move)/.test(e.action)).map((e) => [e.action, e.detail]).reverse();

test('thư mục tài liệu: 401 khi chưa đăng nhập; Chủ bot tạo/đổi tên/đổi màu/xoá; Nhật ký ghi tên', async (t) => {
  const deps = withKb(t);
  const { call } = await startApp(t, deps);
  assert.equal((await call('/api/kb/folders', { method: 'POST', body: { name: 'A' } })).status, 401);
  assert.equal((await call('/api/kb/folders/abc', { method: 'PUT', body: { name: 'A' } })).status, 401);
  assert.equal((await call('/api/kb/folders/abc', { method: 'DELETE' })).status, 401);
  assert.equal((await call('/api/kb/files/folder', { method: 'PUT', body: { paths: [], folder: null } })).status, 401);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const made = await call('/api/kb/folders', { method: 'POST', cookie: owner, body: { name: 'Lớp học', color: 'green' } });
  assert.equal(made.status, 200);
  const id = made.json.folder.id;
  assert.equal((await call('/api/kb/folders', { method: 'POST', cookie: owner, body: { name: 'lớp HỌC' } })).status, 409);
  assert.equal((await call('/api/kb/folders', { method: 'POST', cookie: owner, body: { name: '' } })).status, 400);
  assert.equal((await call('/api/kb/folders', { method: 'POST', cookie: owner, body: { name: 'X', color: 'neon' } })).status, 400);
  const ren = await call(`/api/kb/folders/${id}`, { method: 'PUT', cookie: owner, body: { name: 'Lớp 12A', color: 'red' } });
  assert.deepEqual(ren.json.folder, { id, name: 'Lớp 12A', color: 'red' });
  assert.equal((await call('/api/kb/folders/khongco', { method: 'PUT', cookie: owner, body: { name: 'B' } })).status, 400);
  const list = await call('/api/kb', { cookie: owner });
  assert.deepEqual(list.json.folders, [{ id, name: 'Lớp 12A', color: 'red' }]);
  assert.equal((await call(`/api/kb/folders/${id}`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await call(`/api/kb/folders/${id}`, { method: 'DELETE', cookie: owner })).status, 400);
  assert.deepEqual(kbLog(deps), [['kb_folder_create', 'Lớp học'], ['kb_folder_edit', 'Lớp học → Lớp 12A'], ['kb_folder_delete', 'Lớp 12A']]);
});

test('thư mục tài liệu: viết thẳng vào thư mục; chuyển nhiều tài liệu kiểm từng đường dẫn, thư mục lạ 400; một dòng Nhật ký', async (t) => {
  const deps = withKb(t);
  const { call } = await startApp(t, deps);
  const owner = await loginAs(t, deps, call, { username: 'khach', role: 'owner' });
  const { id } = (await call('/api/kb/folders', { method: 'POST', cookie: owner, body: { name: 'Nội quy' } })).json.folder;
  const a = (await call('/api/kb/note', { method: 'POST', cookie: owner, body: { title: 'A', text: 'a', folder: id } })).json.path;
  const b = (await call('/api/kb/note', { method: 'POST', cookie: owner, body: { title: 'B', text: 'b' } })).json.path;
  assert.equal((await call('/api/kb/note', { method: 'POST', cookie: owner, body: { title: 'C', text: 'c', folder: 'khongco' } })).status, 400);
  let own = (await call('/api/kb?fresh=1', { cookie: owner })).json.own;
  assert.deepEqual(Object.fromEntries(own.map((f) => [f.path, f.folder])), { [a]: id, [b]: null });
  assert.equal((await call('/api/kb/files/folder', { method: 'PUT', cookie: owner, body: { paths: [b, '../config.yaml'], folder: id } })).status, 403);
  assert.equal((await call('/api/kb/files/folder', { method: 'PUT', cookie: owner, body: { paths: [b], folder: 'khongco' } })).status, 400);
  assert.equal((await call('/api/kb/files/folder', { method: 'PUT', cookie: owner, body: { paths: 'x', folder: id } })).status, 400);
  const moved = await call('/api/kb/files/folder', { method: 'PUT', cookie: owner, body: { paths: [a, b], folder: id } });
  assert.deepEqual([moved.status, moved.json.count], [200, 2]);
  await call('/api/kb/files/folder', { method: 'PUT', cookie: owner, body: { paths: [a], folder: null } });
  own = (await call('/api/kb', { cookie: owner })).json.own;
  assert.deepEqual(Object.fromEntries(own.map((f) => [f.path, f.folder])), { [a]: null, [b]: id });
  assert.deepEqual(kbLog(deps), [['kb_folder_create', 'Nội quy'], ['kb_move', '2 tài liệu → Nội quy'], ['kb_move', '1 tài liệu → Chưa xếp']]);
});

test('thư mục tài liệu: tải tệp lên thẳng vào thư mục qua ?folder=', async (t) => {
  const deps = withKb(t);
  const { base, call } = await startApp(t, deps);
  const admin = await loginAs(t, deps, call);
  const { id } = (await call('/api/kb/folders', { method: 'POST', cookie: admin, body: { name: 'Biểu mẫu' } })).json.folder;
  const send = (q) => fetch(`${base}/api/kb/upload${q}`, { method: 'POST', body: Buffer.from('%PDF-1.7 x'),
    headers: { Cookie: admin, 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'zalo-dashboard', 'X-File-Name': encodeURIComponent('Mẫu.pdf') } });
  assert.equal((await send('?folder=khongco')).status, 400);
  const ok = await (await send(`?folder=${id}`)).json();
  const own = (await call('/api/kb', { cookie: admin })).json.own;
  assert.deepEqual(own.map((f) => [f.path, f.folder]), [[ok.path, id]]);
});
