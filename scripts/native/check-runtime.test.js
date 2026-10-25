import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-runtime.js');
const ROOT = resolve(HERE, '..', '..');

const run = (args = []) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });

test('chạy được trên máy này và báo đủ điều kiện', () => {
  const r = run();
  assert.equal(r.status, 0, `phải thoát 0 khi máy đủ điều kiện; stderr: ${r.stderr}`);
  assert.match(r.stdout, /Kiểm tra máy đích:/);
  assert.match(r.stdout, /Node\.js/);
  assert.match(r.stdout, /node:sqlite/);
  assert.match(r.stdout, /Máy này chạy được native/);
});

test('--json trả cấu trúc máy đọc được, cùng kết luận với bản người đọc', () => {
  const r = run(['--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(typeof j.platform, 'string');
  assert.equal(typeof j.arch, 'string');
  assert.match(j.node, /^\d+\.\d+\.\d+/);
  assert.equal(j.root, ROOT, 'gốc dự án suy ra từ vị trí tệp, không phải cwd');
  assert.ok(Array.isArray(j.checks) && j.checks.length >= 8);
  for (const c of j.checks) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.equal('fatal' in c, false, 'không rò chi tiết nội bộ ra JSON');
  }
  // Không có mục bắt buộc nào hỏng thì `ok` mới là true — kiểm cả hai chiều.
  assert.equal(j.ok, j.checks.every((c) => c.ok || !['Node.js', 'node:sqlite', 'Hệ điều hành', 'Kiến trúc CPU'].includes(c.name)));
});

test('mọi đường dẫn trong script dựng bằng node:path, không nối chuỗi bằng "/"', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const inBlockComment = (() => {
    // Theo dõi khối /* … */ để bỏ qua phần thân comment khi quét.
    const marks = [];
    let open = false;
    for (const line of src.split('\n')) {
      if (!open && line.includes('/*')) open = true;
      marks.push(open);
      if (open && line.includes('*/')) open = false;
    }
    return marks;
  })();
  const suspicious = src.split('\n').filter((line, i) => {
    if (inBlockComment[i]) return false;
    const code = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, (m) => m); // giữ nguyên literal
    if (/https?:\/\//.test(code)) return false;                 // URL
    if (/\.split\(\s*['"`][./\\][^'"`]*['"`]\s*\)/.test(code)) return false;  // split('.') — tách chuỗi, không phải đường dẫn
    const literals = code.match(/(['"`])[^'"`]*\/[^'"`]*\1/g) || [];
    if (!literals.length) return false;
    if (/join\(|resolve\(|path_join/.test(code)) return false;   // chuỗi là đối số của join/resolve
    // Còn lại: chuỗi chứa "/" mà không đi qua join/resolve — chỉ chấp nhận trong thông điệp cho người dùng.
    return !/→|Kiểm tra|Hệ điều hành|Kiến trúc|cài|chạy|curl|apt|brew|winget|thiếu|không/.test(code);
  });
  assert.deepEqual(suspicious, [], `dòng nối đường dẫn bằng "/":\n${suspicious.join('\n')}`);
});
