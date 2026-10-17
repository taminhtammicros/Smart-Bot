import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidBrand, brandCss, createBrandStore, decodeLogo, parseBrand } from './brand.js';
import { SUGGESTIONS, brandVars, contrastWithWhite, normalizeHex } from '../public/brand-color.js';
import { pngOf } from '../test-helpers.js';

function store(t) {
  const d = mkdtempSync(join(tmpdir(), 'zd-brand-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  let clock = 1000;
  return { d, s: createBrandStore({ file: join(d, 'brand.json'), logoFile: join(d, 'brand', 'logo.png'), now: () => clock++ }) };
}
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

test('màu: chuẩn hoá mã, tương phản chữ trắng, 6 gợi ý đều đạt 4,5 : 1', () => {
  assert.equal(normalizeHex(' #0F766E '), '#0f766e');
  assert.equal(normalizeHex('abc'), '#aabbcc');
  for (const bad of ['', '#12345', 'red', '#ggg000', null]) assert.equal(normalizeHex(bad), null, String(bad));
  assert.equal(contrastWithWhite('#ffffff').toFixed(2), '1.00');
  assert.equal(contrastWithWhite('#000000').toFixed(2), '21.00');
  assert.ok(contrastWithWhite('#777777') < 4.5, '#777 vừa dưới ngưỡng');
  assert.equal(SUGGESTIONS.length, 6);
  for (const { color } of SUGGESTIONS) assert.ok(contrastWithWhite(color) >= 4.5, color);
  assert.deepEqual(brandVars('#1d4ed8'), {
    '--brand': '#1d4ed8', '--brand-dark': '#173ead', '--brand-soft': '#e8edfb', '--focus': '0 0 0 3px rgba(29, 78, 216, 0.35)',
  });
});

test('parseBrand: chuẩn hoá tên, từ chối màu nhạt, tên rỗng/dài, sai kiểu', () => {
  assert.deepEqual(parseBrand({ name: '  Trường\nCNT  ', color: '1D4ED8', poweredBy: false }), { name: 'Trường CNT', subtitle: 'Không gian làm việc', color: '#1d4ed8', poweredBy: false });
  assert.equal(parseBrand({ name: 'A', subtitle: '  THPT\nCNT ', color: '#1d4ed8', poweredBy: true }).subtitle, 'THPT CNT');
  assert.equal(parseBrand({ name: 'A', subtitle: '   ', color: '#1d4ed8', poweredBy: true }).subtitle, 'Không gian làm việc', 'để trống = mặc định');
  const bad = [
    [{ name: '', color: '#1d4ed8', poweredBy: true }, /trống/],
    [{ name: 'x'.repeat(41), color: '#1d4ed8', poweredBy: true }, /40 ký tự/],
    [{ name: 'A', color: '#777777', poweredBy: true }, /quá nhạt/],
    [{ name: 'A', color: 'đỏ', poweredBy: true }, /Mã màu/],
    [{ name: 'A', color: '#1d4ed8', poweredBy: 'true' }, /Vận Hành bởi/],
    [{ name: 5, color: '#1d4ed8', poweredBy: true }, /Tên/],
    [null, /Tên/],
    [{ name: 'A', subtitle: 'x'.repeat(41), color: '#1d4ed8', poweredBy: true }, /Dòng phụ tối đa 40/],
    [{ name: 'A', subtitle: 7, color: '#1d4ed8', poweredBy: true }, /Dòng phụ/],
  ];
  for (const [body, re] of bad) assert.throws(() => parseBrand(body), (e) => e instanceof InvalidBrand && e.statusCode === 400 && re.test(e.message));
  assert.equal(parseBrand({ name: '🙂'.repeat(40), color: '#1d4ed8', poweredBy: true }).name.length, 80, 'đếm theo ký tự, không theo đơn vị UTF-16');
});

test('decodeLogo: chỉ PNG thật ≤ 256 px; SVG, JPEG, PNG cụt, PNG quá to, chuỗi lạ bị từ chối', () => {
  assert.equal(decodeLogo(dataUrl(pngOf(256, 64))).length > 0, true);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(60).fill(0)]);
  for (const bad of [
    `data:image/svg+xml;base64,${svg.toString('base64')}`,
    dataUrl(svg),
    dataUrl(jpeg),
    dataUrl(pngOf(257, 10)),
    dataUrl(pngOf(10, 300)),
    dataUrl(pngOf(10, 10).subarray(0, 40)),
    'data:image/png;base64,@@@',
    'https://evil.vn/logo.png',
    undefined,
  ]) {
    assert.throws(() => decodeLogo(bad), InvalidBrand, String(bad).slice(0, 40));
  }
  const huge = Buffer.concat([pngOf(4, 4).subarray(0, 33), Buffer.alloc(400 * 1024), pngOf(4, 4).subarray(-12)]);
  assert.throws(() => decodeLogo(dataUrl(huge)), /quá lớn/);
  assert.throws(() => decodeLogo(dataUrl(pngOf(257, 10))), /tối đa 256×256/);
});

test('decodeLogo: chuỗi base64 quá dài bị từ chối trước khi giải mã', (t) => {
  const orig = Buffer.from;
  let decoded = 0;
  t.mock.method(Buffer, 'from', (...a) => { if (typeof a[0] === 'string' && a[1] === 'base64') decoded += 1; return orig.apply(Buffer, a); });
  assert.throws(() => decodeLogo(`data:image/png;base64,${'A'.repeat(Math.ceil(400 * 1024 * 4 / 3) + 8)}`), /quá lớn/);
  assert.equal(decoded, 0);
});

test('brandCss: màu mặc định không ghi đè; màu khác chỉ có biến trong :root', () => {
  assert.doesNotMatch(brandCss('#0f766e'), /--brand/);
  const css = brandCss('#be123c');
  assert.match(css, /^:root \{\n {2}--brand: #be123c;\n/);
  assert.match(css, /--focus: 0 0 0 3px rgba\(190, 18, 60, 0\.35\);/);
  assert.doesNotMatch(css, /[<>"'\\]|url\(|@import/);
});

test('kho: mặc định → lưu → logo → gỡ logo → khôi phục; tệp quyền 600; tệp sửa tay sai thì về mặc định', (t) => {
  const { d, s } = store(t);
  assert.deepEqual(s.get(), { name: 'Dashboard Zalo', subtitle: 'Không gian làm việc', color: '#0f766e', poweredBy: true, logoUrl: null });
  assert.equal(s.logo(), null);
  s.set({ name: 'Trường CNT', color: '#1d4ed8', poweredBy: false });
  const withLogo = s.setLogo(dataUrl(pngOf(64, 64)));
  assert.equal(withLogo.name, 'Trường CNT');
  assert.match(withLogo.logoUrl, /^\/brand\/logo\.png\?v=\d+$/);
  assert.ok(s.logo().subarray(1, 4).toString() === 'PNG');
  const again = s.setLogo(dataUrl(pngOf(32, 32)));
  assert.notEqual(again.logoUrl, withLogo.logoUrl, 'đổi logo thì đổi ?v= để trình duyệt tải lại');
  assert.equal(s.set({ name: 'Trường CNT', color: '#be123c', poweredBy: false }).logoUrl, again.logoUrl, 'lưu màu giữ logo');
  assert.match(s.css(), /--brand: #be123c/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(d, 'brand.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(d, 'brand', 'logo.png')).mode & 0o777, 0o600);
  }
  assert.equal(s.removeLogo().logoUrl, null);
  assert.equal(existsSync(join(d, 'brand', 'logo.png')), false);
  s.setLogo(dataUrl(pngOf(8, 8)));
  assert.deepEqual(s.reset(), { name: 'Dashboard Zalo', subtitle: 'Không gian làm việc', color: '#0f766e', poweredBy: true, logoUrl: null });
  assert.equal(existsSync(join(d, 'brand', 'logo.png')), false);
  writeFileSync(join(d, 'brand.json'), JSON.stringify({ name: 'X', color: '#ffffff', poweredBy: true, logoAt: 5 }));
  assert.deepEqual(s.get(), { name: 'Dashboard Zalo', subtitle: 'Không gian làm việc', color: '#0f766e', poweredBy: true, logoUrl: null }, 'màu nhạt sửa tay + logo đã mất');
});
