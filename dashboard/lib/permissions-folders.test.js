import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionsStore, FEATURE_KEYS, InvalidPermissions, normalize, normalizeFolders } from './permissions.js';

const A = '2054797107487294899';
const B = '2054797107487294811';
const C = '2054797107487294822';
const allOn = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
const body = (over = {}, features = {}) => ({ active: true, replyOnlyTagged: true, paused: false, features: { ...allOn(), ...features }, ...over });

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-folders-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'permissions.json');
  return { store: createPermissionsStore({ file, globalReplyOnlyTagged: true }), disk: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('thư mục: tạo, đổi tên, đặt nhóm; cài đặt thư mục chỉ ghi khoá khác mặc định, nhóm thừa hưởng', (t) => {
  const { store, disk } = fresh(t);
  const { id } = store.createFolder('  Lớp   học ');
  assert.match(id, /^[a-z0-9]{1,16}$/);
  store.setFolderMembers(id, [A, B, A]);
  const { changed } = store.setFolderSettings(id, { ...body({ replyOnlyTagged: false }, { web: false }), studioQuota: 2 });
  assert.deepEqual(changed.sort(), ['replyOnlyTagged', 'studioQuota', 'web']);
  assert.deepEqual(disk().folders[id], { name: 'Lớp học', color: 'blue', groups: [A, B], replyOnlyTagged: false, features: { web: false }, studioQuota: 2 });
  store.renameFolder(id, 'Lớp 12');
  const state = store.get();
  assert.equal(state.folders[0].name, 'Lớp 12');
  assert.equal(state.folders[0].features.web, false);
  // Nhóm trong thư mục chỉnh riêng: chỉ ghi khoá khác THƯ MỤC (không phải khác mặc định).
  store.setGroup(A, { ...body({ replyOnlyTagged: false }, { web: false, kb: false }), studioQuota: null }, 'Lớp 12A');
  assert.deepEqual(disk().groups[A], { name: 'Lớp 12A', features: { kb: false } });
  const g = store.get().groups[A];
  assert.equal(g.folder, id);
  assert.equal(g.features.web, false, 'web theo thư mục');
  assert.equal(g.studioQuota, 2, 'số lượt theo thư mục');
});

test('đưa nhóm vào thư mục khác thì nhóm rời thư mục cũ; xoá thư mục giữ phần chỉnh riêng của nhóm', (t) => {
  const { store, disk } = fresh(t);
  const one = store.createFolder('Một').id;
  const two = store.createFolder('Hai').id;
  store.setFolderMembers(one, [A, B]);
  store.setFolderMembers(two, [B, C]);
  assert.deepEqual(disk().folders[one].groups, [A]);
  assert.deepEqual(disk().folders[two].groups, [B, C]);
  store.setGroup(C, body({ active: false }), 'C');
  store.deleteFolder(two);
  assert.equal(disk().folders[two], undefined);
  assert.deepEqual(disk().groups[C], { name: 'C', active: false });
  assert.equal(store.get().groups[C].folder, null);
});

test('bật/tắt nhanh cả thư mục: đặt Hoạt động của thư mục và bỏ "Hoạt động" chỉnh riêng của nhóm bên trong', (t) => {
  const { store, disk } = fresh(t);
  const { id } = store.createFolder('Đoàn');
  store.setFolderMembers(id, [A, B]);
  store.setGroup(A, body({ active: true }, { voice: false }), 'A');            // trùng nền → chỉ còn voice
  store.setFolderActive(id, false);
  store.setGroup(B, body({ active: true }), 'B');                              // B bật riêng (khác thư mục đang tắt)
  assert.equal(disk().groups[B].active, true);
  const { cleared } = store.setFolderActive(id, false);
  assert.equal(cleared, 1);
  assert.equal(disk().folders[id].active, false);
  assert.equal(disk().groups[B], undefined, 'B chỉ còn tên → bỏ mục');
  assert.deepEqual(disk().groups[A], { name: 'A', features: { voice: false } });
  const s = store.get();
  assert.equal(s.groups[A].active, false);
  store.setFolderActive(id, true);
  assert.equal(disk().folders[id].active, undefined, 'bằng mặc định → không ghi khoá');
});

test('dữ liệu sai bị chặn bằng câu tiếng Việt; tệp sửa tay: nhóm ở hai thư mục thuộc thư mục đứng trước', (t) => {
  const { store } = fresh(t);
  assert.throws(() => store.createFolder('   '), InvalidPermissions);
  assert.throws(() => store.renameFolder('khongco', 'x'), InvalidPermissions);
  const { id } = store.createFolder('X');
  assert.throws(() => store.setFolderMembers(id, ['abc']), InvalidPermissions);
  assert.throws(() => store.setFolderActive(id, 'false'), InvalidPermissions);
  const folders = normalizeFolders({ a1: { name: 'A', groups: [A, 'x', 5] }, b2: { groups: [A, B] }, 'BAD ID': { groups: [C] }, c3: 'hỏng' });
  assert.deepEqual(Object.keys(folders), ['a1', 'b2']);
  assert.deepEqual(folders.a1.groups, [A]);
  assert.deepEqual(folders.b2, { name: 'Thư mục', groups: [B] });
  assert.equal(normalize({ version: 1 }).folders, undefined, 'tệp cũ không có thư mục vẫn y như cũ');
});

test('người trong thư mục: đặt, chuyển giữa thư mục, lưu cài đặt thư mục không làm rơi người', (t) => {
  const { store, disk } = fresh(t);
  const P = '1111111111111111111'; const Q = '2222222222222222222';
  const { id: f1 } = store.createFolder('BCH');
  const { id: f2 } = store.createFolder('Lớp');
  store.setFolderPeople(f1, [{ uid: P, name: 'Lan' }, { uid: Q }, { uid: P }]);
  assert.deepEqual(disk().folders[f1].people, [{ uid: P, name: 'Lan' }, { uid: Q }]);
  store.setFolderSettings(f1, body({}, { web: false }));
  assert.equal(disk().folders[f1].people.length, 2, 'lưu cài đặt thư mục giữ danh sách người');
  const state = store.setFolderPeople(f2, [{ uid: Q, name: 'Minh' }]);
  assert.deepEqual(disk().folders[f1].people, [{ uid: P, name: 'Lan' }]);
  assert.deepEqual(state.folders.find((f) => f.id === f2).people, [{ uid: Q, name: 'Minh' }]);
  store.setFolderPeople(f1, []);
  assert.equal(disk().folders[f1].people, undefined);
  assert.throws(() => store.setFolderPeople(f1, [{ uid: '0123' }]), InvalidPermissions);
  assert.deepEqual(normalizeFolders({ a: { groups: [], people: [P, { uid: P }, 'x'] }, b: { groups: [], people: [P] } }).a.people, [{ uid: P }]);
});

test('màu thư mục: thư mục mới nhận màu chưa dùng; đổi màu; màu lạ bị từ chối; lưu cài đặt giữ màu', (t) => {
  const { store, disk } = fresh(t);
  const { id: f1 } = store.createFolder('Một');
  const { id: f2 } = store.createFolder('Hai');
  assert.notEqual(disk().folders[f1].color, disk().folders[f2].color);
  const state = store.setFolderColor(f1, 'pink');
  assert.equal(state.folders.find((f) => f.id === f1).color, 'pink');
  assert.throws(() => store.setFolderColor(f1, '#fff'), InvalidPermissions);
  store.setFolderSettings(f1, body({}, { web: false }));
  assert.equal(disk().folders[f1].color, 'pink');
  assert.equal(normalizeFolders({ a: { groups: [], color: 'neon' } }).a.color, undefined);
});

test('thêm người vào thư mục (từ Liên hệ): giữ người cũ, bỏ trùng, chuyển từ thư mục khác sang, cập nhật tên', (t) => {
  const { store, disk } = fresh(t);
  const P = '1111111111111111111'; const Q = '2222222222222222222'; const R = '3333333333333333333';
  const { id: f1 } = store.createFolder('Trải nghiệm');
  const { id: f2 } = store.createFolder('Khách hàng');
  store.setFolderPeople(f1, [{ uid: P, name: 'Lan' }]);
  store.setFolderPeople(f2, [{ uid: Q, name: 'Minh' }]);
  store.addFolderPeople(f1, [{ uid: Q, name: 'Minh' }, { uid: R }, { uid: P, name: 'Lan Anh' }]);
  assert.deepEqual(disk().folders[f1].people, [{ uid: P, name: 'Lan Anh' }, { uid: Q, name: 'Minh' }, { uid: R }]);
  assert.equal(disk().folders[f2].people, undefined, 'người chỉ thuộc một thư mục: chuyển khỏi thư mục cũ');
  assert.throws(() => store.addFolderPeople(f1, [{ uid: '12' }]), InvalidPermissions);
  assert.throws(() => store.addFolderPeople('khong-co', [{ uid: P }]), InvalidPermissions);
});

test('quy tắc riêng của thư mục: lưu giữ xuống dòng, lưu cài đặt/đổi màu không làm rơi, rỗng = bỏ, quá dài bị chặn', (t) => {
  const { store, disk } = fresh(t);
  const { id } = store.createFolder('KHKT');
  store.setFolderMembers(id, [A]);
  const state = store.setFolderRules(id, '  1. Hỏi trước – gợi sau.\r\n2. Không làm hộ.\u0007  ');
  assert.equal(state.folders[0].rules, '1. Hỏi trước – gợi sau.\n2. Không làm hộ.');
  store.setFolderSettings(id, body({}, { web: false }));
  store.setFolderColor(id, 'red');
  assert.equal(disk().folders[id].rules, '1. Hỏi trước – gợi sau.\n2. Không làm hộ.');
  assert.equal(normalizeFolders(disk().folders)[id].rules, '1. Hỏi trước – gợi sau.\n2. Không làm hộ.');
  assert.throws(() => store.setFolderRules(id, 'x'.repeat(3001)), InvalidPermissions);
  assert.throws(() => store.setFolderRules(id, null), InvalidPermissions);
  store.setFolderRules(id, '   ');
  assert.equal('rules' in disk().folders[id], false);
  assert.equal(store.get().folders[0].rules, '');
});
