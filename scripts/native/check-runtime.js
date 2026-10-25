#!/usr/bin/env node
/**
 * Kiểm tra runtime trước khi cài native — dùng chung cho macOS / Linux / Windows.
 *
 * Chạy: node scripts/native/check-runtime.js [--json]
 * Mã thoát 0 = đủ điều kiện; 1 = thiếu, in rõ cách sửa cho đúng HĐH đang chạy.
 *
 * Vì sao bằng Node chứ không bằng bash: sidecar vốn đã cần Node, nên kiểm tra
 * bằng chính Node là thứ duy nhất chắc chắn có mặt trên cả ba HĐH — không phải
 * viết lại logic kiểm tra ba lần bằng bash/PowerShell/cmd rồi lệch nhau.
 *
 * Mọi đường dẫn đi qua `node:path` (path.join/path.resolve), không ghép chuỗi
 * bằng '/' hay '\\' — xem docs/PACKAGING.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arch, availableParallelism, platform, release, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const WANT_MAJOR = 22;
const WANT_MINOR = 5;
const WANT_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const WANT_ARCHS = new Set(['x64', 'arm64']);
const MIN_RAM_BYTES = 2 * 1024 ** 3;

const COLOR = !process.argv.includes('--json') && process.stdout.isTTY
  ? { ok: '\u001b[32m', bad: '\u001b[31m', warn: '\u001b[33m', dim: '\u001b[2m', off: '\u001b[0m' }
  : { ok: '', bad: '', warn: '', dim: '', off: '' };

const checks = [];
const add = (name, ok, detail = '', fatal = false, fix = '') => checks.push({ name, ok, detail, fatal, fix });

/** `22.5.0` → `{ major, minor }`; chuỗi lạ → major 0 để rơi vào nhánh "quá cũ". */
function parseNodeVersion(raw) {
  const [major = '0', minor = '0'] = String(raw).replace(/^v/, '').split('.');
  return { major: Number.parseInt(major, 10) || 0, minor: Number.parseInt(minor, 10) || 0 };
}

const NODE_FIX = {
  darwin: 'cài Node 22:  brew install node@22\n  hoặc tải bản .pkg: https://nodejs.org/en/download  (chọn macOS ' +
    (arch() === 'arm64' ? 'Apple Silicon' : 'Intel') + ')',
  linux: 'cài Node 22 bằng NodeSource:\n  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n  sudo apt-get install -y nodejs',
  win32: 'cài Node 22 LTS:  winget install OpenJS.NodeJS.LTS\n  hoặc tải installer: https://nodejs.org/en/download',
};

function checkNode() {
  const { major, minor } = parseNodeVersion(process.versions.node);
  const ok = major > WANT_MAJOR || (major === WANT_MAJOR && minor >= WANT_MINOR);
  add('Node.js', ok, `v${process.versions.node} (cần >= ${WANT_MAJOR}.${WANT_MINOR})`, true,
    ok ? '' : (NODE_FIX[platform()] || NODE_FIX.linux));
  // node:sqlite là API thử nghiệm tới 22.5, nhưng store-reader/learned-memory import trực tiếp.
  const sqlite = (() => { try { return typeof process.getBuiltinModule === 'function' && Boolean(process.getBuiltinModule('node:sqlite')); } catch { return false; } })();
  add('node:sqlite', sqlite, sqlite ? 'có' : 'không có trong bản Node này', true,
    sqlite ? '' : 'bản Node này thiếu node:sqlite (cần >= 22.5) — nâng Node lên 22 LTS mới nhất');
}

function checkPlatform() {
  const p = platform();
  add('Hệ điều hành', WANT_PLATFORMS.has(p), `${p} ${release()}`, true,
    WANT_PLATFORMS.has(p) ? '' : 'chỉ hỗ trợ macOS, Linux và Windows');
  const a = arch();
  add('Kiến trúc CPU', WANT_ARCHS.has(a), a, true,
    WANT_ARCHS.has(a) ? '' : 'chỉ hỗ trợ x86_64 (x64) và ARM64');
}

function checkResources() {
  const ram = totalmem();
  const gb = (ram / 1024 ** 3).toFixed(1);
  add('RAM', ram >= MIN_RAM_BYTES, `${gb} GB (khuyến nghị >= 2 GB)`, false,
    ram >= MIN_RAM_BYTES ? '' : 'máy ít RAM — bot vẫn chạy được nhưng TTS/PDF có thể chậm');
  const cores = availableParallelism();
  add('CPU', cores >= 2, `${cores} luồng`, false, cores >= 2 ? '' : 'một luồng: bot vẫn chạy, nên giảm việc chạy song song');
}

function checkTree() {
  const need = ['server.js', 'package.json', 'package-lock.json', 'dashboard', 'hermes-plugin'];
  const missing = need.filter((n) => !existsSync(join(ROOT, n)));
  add('Mã nguồn', missing.length === 0, missing.length ? `thiếu: ${missing.join(', ')}` : ROOT, true,
    missing.length ? 'chạy script này từ bản clone đầy đủ của repo (không chép lẻ vài tệp)' : '');
}

function checkOptional(bin, label, fix, versionFlag = '-version') {
  const probe = spawnSync(bin, [versionFlag], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const ok = probe.status === 0;
  add(label, ok, ok ? String(probe.stdout || '').split('\n')[0].trim() : 'chưa cài (tuỳ chọn)', false, ok ? '' : fix);
}

function checkDisk() {
  // Không có API đĩa đa nền tảng trong Node; chỉ báo dung lượng gói cần tải.
  const lock = (() => { try { return readFileSync(join(ROOT, 'package-lock.json'), 'utf8').length; } catch { return 0; } })();
  add('package-lock.json', lock > 0, lock ? 'có (cài đặt tất định bằng `npm ci`)' : 'thiếu', true,
    lock ? '' : 'thiếu lockfile: `npm ci` sẽ không chạy — dùng bản clone đầy đủ của repo');
}

checkNode();
checkPlatform();
checkResources();
checkTree();
checkDisk();
checkOptional('git', 'git', 'cài git để bộ cài tải được plugin/bản cập nhật', '--version');
checkOptional('ffmpeg', 'ffmpeg', 'tuỳ chọn: cần cho TTS VieNeu và chuyển đổi âm thanh');

const fatals = checks.filter((c) => !c.ok && c.fatal);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    ok: fatals.length === 0,
    platform: platform(), arch: arch(), node: process.versions.node,
    root: ROOT,
    checks: checks.map(({ fatal, ...c }) => c),
  }, null, 2));
} else {
  console.log(`${COLOR.dim}Kiểm tra máy đích: ${platform()} ${arch()} · Node v${process.versions.node}${COLOR.off}\n`);
  for (const c of checks) {
    const tag = c.ok ? `${COLOR.ok}OK  ${COLOR.off}` : `${c.fatal ? COLOR.bad + 'THIẾU' : COLOR.warn + 'LƯU Ý'}${COLOR.off}`;
    console.log(`  ${tag}  ${c.name.padEnd(16)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`         ${COLOR.dim}→ ${c.fix.replace(/\n {2}/g, '\n           ')}${COLOR.off}`);
  }
  console.log('');
  if (fatals.length) {
    console.log(`${COLOR.bad}Chưa đủ điều kiện:${COLOR.off} ${fatals.map((c) => c.name).join(', ')}`);
    console.log('Sửa các mục trên rồi chạy lại lệnh cài đặt.');
  } else {
    console.log(`${COLOR.ok}Máy này chạy được native.${COLOR.off}  Tiếp theo: chạy script cài đặt của HĐH bạn.`);
  }
}
process.exitCode = fatals.length ? 1 : 0;
