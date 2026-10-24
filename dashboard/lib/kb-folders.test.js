import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKbFolders, normalizeKbFolders } from './kb-folders.js';
import { createKbStore } from './kb-store.js';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-kbf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('thư mục: tạo (tên gọn khoảng trắng, màu tự chọn khác nhau), đổi tên/màu, trùng tên không phân biệt hoa thường', (t) => {
  const file = join(tmp(t), 'kb-folders.json');
  const f = createKbFolders({ file });
  const a = f.create({ name: '  Nội   quy ' });
  assert.match(a.id, /^[a-z0-9]{1,16}$/);
  assert.equal(a.name, 'Nội quy');
  const b = f.create({ name: 'Lịch', color: 'red' });
  assert.equal(b.color, 'red');
  assert.notEqual(a.color, f.create({ name: 'Khác' }).color);
  assert.throws(() => f.create({ name: 'nội QUY' }), (e) => e.statusCode === 409);
  assert.throws(() => f.create({ name: '   ' }), (e) => e.statusCode === 400);
  assert.throws(() => f.create({ name: 'x'.repeat(61) }), (e) => e.statusCode === 400);
  assert.throws(() => f.create({ name: 'Màu lạ', color: 'neon' }), (e) => e.statusCode === 400);
  const { before, after } = f.update(a.id, { name: 'Nội quy nhóm', color: 'teal' });
  assert.deepEqual([before.name, after.name, after.color], ['Nội quy', 'Nội quy nhóm', 'teal']);
  assert.equal(f.update(a.id, { name: 'NỘI QUY NHÓM' }).after.name, 'NỘI QUY NHÓM', 'đổi hoa/thường chính nó được');
  assert.throws(() => f.update(a.id, { name: 'lịch' }), (e) => e.statusCode === 409);
  assert.throws(() => f.update('khongco', { name: 'X' }), (e) => e.statusCode === 400);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.folders.length, 3);
});

test('thư mục: tối đa 50; xoá thư mục → tài liệu bên trong về Chưa xếp', (t) => {
  const f = createKbFolders();
  const ids = Array.from({ length: 50 }, (_, i) => f.create({ name: `TM ${i}` }).id);
  assert.throws(() => f.create({ name: 'Thừa' }), (e) => e.statusCode === 400 && /50/.test(e.message));
  f.assign(['u/a.md', 'u/b.md'], ids[0]);
  f.assign(['u/c.md'], ids[1]);
  f.remove(ids[0]);
  assert.deepEqual(f.get().files, { 'u/c.md': ids[1] });
  assert.equal(f.get().folders.length, 49);
  assert.throws(() => f.assign(['u/a.md'], ids[0]), (e) => e.statusCode === 400);
});

test('đọc lỏng: bỏ thư mục sai/trùng, gán vào thư mục không có', () => {
  const d = normalizeKbFolders({ folders: [{ id: 'a1', name: ' A ', color: 'blue' }, { id: 'a1', name: 'B' }, { id: 'BAD!', name: 'C' }, { id: 'c2', name: 'D', color: 'neon' }],
    files: { 'u/x.md': 'a1', 'u/y.md': 'zz' } });
  assert.deepEqual(d, { version: 1, folders: [{ id: 'a1', name: 'A', color: 'blue' }, { id: 'c2', name: 'D', color: 'gray' }], files: { 'u/x.md': 'a1' } });
});

function store(t) {
  const dir = tmp(t);
  const root = join(dir, 'kho');
  const foldersFile = join(dir, 'kb-folders.json');
  mkdirSync(root);
  return { root, foldersFile, kb: createKbStore({ kbDir: () => root, foldersFile }) };
}

test('kho: tải lên/viết thẳng vào thư mục, danh sách có folders + folder từng tài liệu; thư mục lạ → 400, chưa ghi tệp', async (t) => {
  const { root, kb } = store(t);
  const lop = kb.createFolder({ name: 'Lớp học', color: 'green' });
  const a = kb.upload('a.md', Buffer.from('A'), { folder: lop.id });
  const b = kb.createNote('Ghi chú', 'B');
  assert.throws(() => kb.upload('c.md', Buffer.from('C'), { folder: 'khongco' }), (e) => e.statusCode === 400);
  assert.throws(() => readFileSync(join(root, 'tai-len-dashboard', 'c.md')), 'thư mục sai thì chưa ghi tệp');
  const list = await kb.list({ fresh: true });
  assert.deepEqual(list.folders, [{ id: lop.id, name: 'Lớp học', color: 'green' }]);
  assert.deepEqual(Object.fromEntries(list.own.map((f) => [f.path, f.folder])), { [a]: lop.id, [b]: null });
});

test('kho: chuyển nhiều tài liệu (kiểm hết đường dẫn trước), đổi tên giữ thư mục, xoá bỏ gán, tệp mất được dọn', async (t) => {
  const { root, foldersFile, kb } = store(t);
  const lop = kb.createFolder({ name: 'Lớp học' });
  const paths = ['a.md', 'b.md', 'c.md'].map((n) => kb.upload(n, Buffer.from(n)));
  assert.throws(() => kb.moveMany([paths[0], '../x.md'], lop.id), (e) => e.statusCode === 403);
  assert.deepEqual(createKbFolders({ file: foldersFile }).get().files, {}, 'một đường sai → chưa chuyển gì');
  assert.throws(() => kb.moveMany([], lop.id), (e) => e.statusCode === 400);
  assert.throws(() => kb.moveMany(Array(201).fill(paths[0]), lop.id), (e) => e.statusCode === 400);
  assert.throws(() => kb.moveMany(paths, 'khongco'), (e) => e.statusCode === 400);
  assert.equal(kb.moveMany([...paths, paths[0]], lop.id).count, 3);
  const renamed = kb.saveOwn(paths[0], { name: 'a moi' });
  kb.remove(paths[1]);
  unlinkSync(join(root, paths[2]));
  writeFileSync(join(root, 'tai-len-dashboard', 'ngoai.md'), 'tạo ngoài dashboard');
  const list = await kb.list({ fresh: true });
  assert.deepEqual(Object.fromEntries(list.own.map((f) => [f.path, f.folder])), { [renamed]: lop.id, 'tai-len-dashboard/ngoai.md': null });
  assert.deepEqual(createKbFolders({ file: foldersFile }).get().files, { [renamed]: lop.id }, 'gán của tệp đã xoá/mất bị dọn');
  assert.equal(kb.moveMany([renamed], null).folder, null);
  const d = kb.upload('d.md', Buffer.from('d'), { folder: lop.id });
  kb.removeMany([d]);
  assert.deepEqual(createKbFolders({ file: foldersFile }).get().files, {});
});

test('kho: xoá thư mục không xoá tệp — tài liệu về Chưa xếp', async (t) => {
  const { kb } = store(t);
  const lop = kb.createFolder({ name: 'Lớp học' });
  const a = kb.upload('a.md', Buffer.from('A'), { folder: lop.id });
  assert.equal(kb.deleteFolder(lop.id).name, 'Lớp học');
  const list = await kb.list({ fresh: true });
  assert.deepEqual([list.folders, list.own.map((f) => [f.path, f.folder])], [[], [[a, null]]]);
});
