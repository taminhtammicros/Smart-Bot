import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { checkContent, createKbStore, kbAllowed, safeFileName } from './kb-store.js';

const PDF = Buffer.from('%PDF-1.7\n...');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....word/document.xml....')]);

function kb(t) {
  const root = mkdtempSync(join(tmpdir(), 'zd-kb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ['Nam 2026', 'Nam 2026/.git', 'node_modules', 'Luu tru']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'Nam 2026', 'Ke hoach.docx'), DOCX);
  writeFileSync(join(root, 'Nam 2026', 'mat-khau-password.txt'), 'x');
  writeFileSync(join(root, 'Nam 2026', '.git', 'config'), 'x');
  writeFileSync(join(root, 'node_modules', 'a.md'), 'x');
  writeFileSync(join(root, 'Luu tru', 'cu.pdf'), PDF);
  writeFileSync(join(root, 'goc.md'), '# gốc');
  writeFileSync(join(root, 'anh.png'), 'x');
  // Giới hạn thời gian duyệt rộng: test không được phụ thuộc tốc độ máy (giới hạn 8 giây có test riêng ở cuối tệp).
  return { root, store: createKbStore({ kbDir: () => root, walkBudgetMs: 600_000 }) };
}

test('luật lọc giống plugin: bỏ thư mục ẩn/mã nguồn, tên gợi ý dữ liệu riêng', () => {
  assert.equal(kbAllowed('Nam 2026/Ke hoach.docx'), true);
  assert.equal(kbAllowed('goc.md'), true);
  assert.equal(kbAllowed('a/.env/x.md'), false);
  assert.equal(kbAllowed('a/khach-hang.xlsx'), false);
});

test('liệt kê đúng tệp bot đọc được (cả kho); chưa cấu hình → rỗng', async (t) => {
  const { store } = kb(t);
  assert.deepEqual((await store.list()).files.map((f) => f.path).sort(), ['Luu tru/cu.pdf', 'Nam 2026/Ke hoach.docx', 'goc.md']);
  assert.equal(store.info().uploadDir, 'tai-len-dashboard');
  const none = createKbStore({ kbDir: () => '' });
  assert.deepEqual(none.info(), { configured: false, publicDirs: [], uploadDir: null });
  assert.deepEqual(await none.list(), { files: [], truncated: false, sources: [], own: [] });
});

test('tên tệp: tên thiết bị Windows bị từ chối (có/không đuôi, hoa thường); cắt dài chỉ cắt phần tên, giữ đuôi', () => {
  for (const bad of ['CON.txt', 'nul.md', 'Aux.pdf', 'prn.docx', 'COM1.txt', 'lpt9.md', 'com5.tar.txt', 'con .txt']) {
    assert.throws(() => safeFileName(bad), (e) => e.statusCode === 400 && /Windows/.test(e.message), bad);
  }
  assert.equal(safeFileName('console.txt'), 'console.txt');
  assert.equal(safeFileName('COM10.txt'), 'COM10.txt');
  const long = safeFileName(`${'a'.repeat(300)}.DOCX`);
  assert.ok(long.endsWith('.DOCX') && long.length === 125, long.length);
});

test('tên tệp: bỏ đường dẫn và ký tự cấm, chỉ docx/pdf/md/txt; nội dung phải khớp đuôi, ≤ 10 MB', () => {
  assert.equal(safeFileName('C:\\fakepath\\Kế hoạch: tháng 10?.docx'), 'Kế hoạch tháng 10 .docx');
  assert.equal(safeFileName('../../.env.md'), 'env.md');
  for (const bad of ['', '.docx', 'a.exe', 'a.html']) assert.throws(() => safeFileName(bad), (e) => e.statusCode === 400, bad);
  checkContent('a.pdf', PDF); checkContent('a.docx', DOCX); checkContent('a.md', Buffer.from('Xin chào'));
  assert.throws(() => checkContent('a.pdf', DOCX), (e) => e.statusCode === 400);
  assert.throws(() => checkContent('a.docx', Buffer.from('PK\u0003\u0004 không có word')), (e) => e.statusCode === 400);
  assert.throws(() => checkContent('a.txt', Buffer.from([0xff, 0xfe, 0x00])), (e) => e.statusCode === 400);
  assert.throws(() => checkContent('a.pdf', Buffer.alloc(10 * 1024 * 1024 + 1)), (e) => e.statusCode === 413);
});

test('tải lên vào thư mục riêng, không đè tệp trùng tên; chỉ xoá được tệp trong thư mục đó', async (t) => {
  const { root, store } = kb(t);
  assert.equal(store.upload('Ke hoach.pdf', PDF), 'tai-len-dashboard/Ke hoach.pdf');
  assert.equal(store.upload('Ke hoach.pdf', PDF), 'tai-len-dashboard/Ke hoach (2).pdf');
  assert.ok((await store.list()).own.some((f) => f.path === 'tai-len-dashboard/Ke hoach (2).pdf'), 'tài liệu tự tạo nằm ở own');
  store.remove('tai-len-dashboard/Ke hoach.pdf');
  assert.equal(existsSync(join(root, 'tai-len-dashboard', 'Ke hoach.pdf')), false);
  for (const rel of ['Luu tru/cu.pdf', 'tai-len-dashboard/../goc.md', '../x', 'tai-len-dashboard']) {
    assert.throws(() => store.remove(rel), (e) => e.statusCode === 403, rel);
  }
  assert.throws(() => store.remove('tai-len-dashboard/khong-co.pdf'), (e) => e.statusCode === 404);
  assert.equal(readFileSync(join(root, 'Luu tru', 'cu.pdf'), 'latin1').slice(0, 5), '%PDF-');
});

test('liên kết tượng trưng: thư mục tải lên trỏ ra ngoài kho thì không ghi/xoá được; tệp là liên kết thì không xoá', (t) => {
  const { root, store } = kb(t);
  const outside = mkdtempSync(join(tmpdir(), 'zd-out-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'x.pdf'), PDF);
  try { symlinkSync(outside, join(root, 'tai-len-dashboard'), 'junction'); } catch { t.skip('không tạo được liên kết trên máy này'); return; }
  assert.throws(() => store.upload('a.pdf', PDF), (e) => e.statusCode === 403);
  assert.equal(existsSync(join(outside, 'a.pdf')), false);
  assert.throws(() => store.remove('tai-len-dashboard/x.pdf'), (e) => e.statusCode === 403);
  assert.equal(existsSync(join(outside, 'x.pdf')), true);
});

test('thư mục cha (phạm vi) là liên kết trỏ ra ngoài: từ chối TRƯỚC khi mkdir, không tạo gì ngoài kho', (t) => {
  const { root, store } = kb(t, { scope: 'ngoai' });
  const outside = mkdtempSync(join(tmpdir(), 'zd-out-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  try { symlinkSync(outside, join(root, 'ngoai'), 'junction'); } catch { t.skip('không tạo được liên kết trên máy này'); return; }
  assert.throws(() => store.upload('a.pdf', PDF), (e) => e.statusCode === 403);
  assert.equal(existsSync(join(outside, 'tai-len-dashboard')), false, 'không mkdir ngoài kho');
});

test('liệt kê bất đồng bộ giữ trần 3000 tệp và báo truncated', async (t) => {
  const { root, store } = kb(t);
  mkdirSync(join(root, 'nhieu'));
  for (let i = 0; i < 3100; i += 1) writeFileSync(join(root, 'nhieu', `f${i}.md`), 'x');
  const out = await store.list({ fresh: true });
  assert.equal(out.files.length, 3000);
  assert.equal(out.truncated, true);
});

test('trang gọn: nguồn có sẵn chỉ đếm tệp theo thư mục cấp 1 (".url" là lối tắt link); tài liệu tự tạo liệt kê riêng', async (t) => {
  const { root, store } = kb(t, { scope: 'Nam 2026, Trong' });
  mkdirSync(join(root, 'Trong'));
  writeFileSync(join(root, 'Nam 2026', 'Bai giang.url'), '[InternetShortcut]\nURL=https://docs.google.com/x');
  store.upload('Ghi chu.md', Buffer.from('# hi'));
  const { sources, own } = await store.list({ fresh: true });
  assert.deepEqual(sources, [{ name: 'Nam 2026', files: 1, links: 1 }, { name: 'Trong', files: 0, links: 0 }]);
  assert.deepEqual(own.map((f) => f.path), ['Nam 2026/tai-len-dashboard/Ghi chu.md']);
});

test('tài liệu tự tạo: viết mới, đọc, sửa nội dung, đổi tên (giữ đuôi), thay tệp; ngoài thư mục tự tạo bị chặn', async (t) => {
  const { root, store } = kb(t);
  const p = store.createNote('Nội quy nhóm', 'Điều 1: lịch sự');
  assert.equal(p, 'tai-len-dashboard/Nội quy nhóm.md');
  assert.equal(store.readOwn(p), 'Điều 1: lịch sự');
  const renamed = store.saveOwn(p, { name: 'Nội quy 2026.txt', text: 'Điều 1: lịch sự\nĐiều 2: đúng giờ' });
  assert.equal(renamed, 'tai-len-dashboard/Nội quy 2026.md', 'giữ đuôi cũ');
  assert.equal(readFileSync(join(root, renamed), 'utf8'), 'Điều 1: lịch sự\nĐiều 2: đúng giờ');
  const pdf = store.upload('a.pdf', PDF);
  assert.throws(() => store.readOwn(pdf), /Thay tệp/);
  assert.throws(() => store.replaceOwn(pdf, DOCX), /không khớp/);
  store.replaceOwn(pdf, Buffer.from('%PDF-2.0 mới'));
  assert.throws(() => store.readOwn('goc.md'), (e) => e.statusCode === 403);
  assert.throws(() => store.saveOwn('tai-len-dashboard/../goc.md', { text: 'x' }), (e) => e.statusCode === 403);
  assert.throws(() => store.createNote('', 'x'), /tiêu đề/);
  assert.throws(() => store.saveOwn(renamed, { text: '' }), /trống/);
});

test('đổi nguồn: chỉ kho hiện tại hoặc gốc người cài đặt cho phép — không nhận đường dẫn tự do; phải xác nhận cả kho', (t) => {
  const { root } = kb(t);
  const other = mkdtempSync(join(tmpdir(), 'zd-kb2-'));
  const secret = mkdtempSync(join(tmpdir(), 'zd-secret-'));
  t.after(() => { rmSync(other, { recursive: true, force: true }); rmSync(secret, { recursive: true, force: true }); });
  mkdirSync(join(other, 'Drive Doan'));
  const envFile = join(secret, '.env');
  writeFileSync(envFile, `ZALO_KB_DIR=${root}\n`);
  const store = createKbStore({ kbDir: () => root, allowedRoots: () => `${other};${join(other, 'khong-co')}`, envFile });
  const src = store.source();
  assert.deepEqual(src.roots, [root, other], 'gốc không tồn tại bị bỏ');
  assert.deepEqual(src.subdirs, ['Luu tru', 'Nam 2026'], 'bỏ thư mục ẩn, node_modules');
  assert.deepEqual(store.browse(other).subdirs, ['Drive Doan']);
  for (const bad of [secret, join(secret, '..'), '', 'tuong-doi', join(root, 'Nam 2026')]) {
    assert.throws(() => store.browse(bad), (e) => e.statusCode === 400, String(bad));
    assert.throws(() => store.setSource({ dir: bad, allDirs: true }), (e) => e.statusCode === 400, String(bad));
  }
  assert.throws(() => store.setSource({ dir: root }), /xác nhận/);
  const saved = store.setSource({ dir: root, allDirs: true });
  assert.equal(saved.changed, false, 'nguồn đang là chính nó → không đổi');
  const moved = store.setSource({ dir: other, allDirs: true });
  assert.equal(moved.changed, true);
  const env = readFileSync(envFile, 'utf8');
  assert.ok(!env.includes(String.fromCharCode(92) + 'n'), env);
});

test('tên tài liệu: từ bị lọc bị từ chối trước khi ghi; "v1.2" giữ nguyên; đổi chỉ hoa/thường không báo trùng', (t) => {
  const { store } = kb(t);
  assert.throws(() => store.createNote('Order tháng 10', 'x'), /đổi tên khác/);
  assert.throws(() => store.upload('backup.md', Buffer.from('x')), /đổi tên khác/);
  const p = store.createNote('Báo cáo v1.2', 'nội dung');
  assert.equal(p, 'tai-len-dashboard/Báo cáo v1.2.md');
  const q = store.createNote('Ghi chú.md', 'nội dung');
  assert.equal(q, 'tai-len-dashboard/Ghi chú.md');
  assert.throws(() => store.saveOwn(q, { name: 'Báo cáo v1.2' }), (e) => e.statusCode === 409);
  assert.throws(() => store.saveOwn(q, { name: 'Private notes', text: 'mới' }), /đổi tên khác/);
  assert.equal(store.readOwn(q), 'nội dung', 'lỗi tên thì không ghi nội dung');
  assert.equal(store.saveOwn(q, { name: 'GHI CHÚ' }), 'tai-len-dashboard/GHI CHÚ.md');
  assert.equal(store.createNote('a/b', 'x'), 'tai-len-dashboard/a-b.md');
});

test('danh sách gọn: đếm vượt trần 3000; tài liệu tự tạo đọc riêng, chỉ ở thư mục tải lên hiện tại', async (t) => {
  const { root, store } = kb(t);
  mkdirSync(join(root, 'Lon'));
  for (let i = 0; i < 3005; i += 1) writeFileSync(join(root, 'Lon', `t${i}.md`), 'x');
  mkdirSync(join(root, 'Lon', 'tai-len-dashboard'));
  writeFileSync(join(root, 'Lon', 'tai-len-dashboard', 'cu.md'), 'x');
  const p = store.createNote('Mới nhất', 'x');
  const r = await store.list({ fresh: true });
  assert.equal(r.sources.find((s) => s.name === 'Lon').files, 3006, 'thư mục tải lên cũ ở nguồn khác tính là tệp nguồn');
  assert.deepEqual(r.own.map((f) => f.path), [p]);
  assert.equal(r.truncated, true);
});

test('xoá nhiều tài liệu tự tạo: kiểm mọi đường dẫn trước (một cái ngoài thư mục → 403, chưa xoá gì); bỏ trùng', (t) => {
  const { root, store } = kb(t);
  const a = store.upload('a.pdf', PDF);
  const b = store.upload('b.pdf', PDF);
  assert.throws(() => store.removeMany([a, 'Luu tru/cu.pdf']), (e) => e.statusCode === 403);
  assert.throws(() => store.removeMany([a, 'tai-len-dashboard/khong-co.pdf']), (e) => e.statusCode === 404);
  assert.throws(() => store.removeMany([]), (e) => e.statusCode === 400);
  assert.throws(() => store.removeMany('a'), (e) => e.statusCode === 400);
  assert.ok(existsSync(join(root, a)) && existsSync(join(root, b)), 'chưa xoá gì');
  assert.equal(store.removeMany([a, b, a]), 2);
  assert.equal(existsSync(join(root, a)) || existsSync(join(root, b)), false);
  assert.equal(readFileSync(join(root, 'Luu tru', 'cu.pdf'), 'latin1').slice(0, 5), '%PDF-');
});

test('kho nằm trên ổ mạng chậm (Google Drive): lượt duyệt dừng khi hết thời gian, trả phần đã thấy và báo chưa đủ', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zd-kb-slow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 5; i += 1) {
    mkdirSync(join(root, `Thu muc ${i}`), { recursive: true });
    writeFileSync(join(root, `Thu muc ${i}`, `tai lieu ${i}.md`), 'x');
  }
  let clock = 0;
  // Mỗi lần hỏi giờ là 3 giây trôi qua: ổ mạng chậm.
  const store = createKbStore({ kbDir: () => root, now: () => (clock += 3000), walkBudgetMs: 8000 });
  const list = await store.list();
  assert.equal(list.truncated, true, 'báo kho chưa duyệt hết');
  assert.ok(list.files.length < 5, `dừng sớm, thấy ${list.files.length} tệp`);
});
