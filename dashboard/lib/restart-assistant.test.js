import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeRestartAssistant } from './restart-assistant.js';

function fakes({ exeExists = false, stopFails = false } = {}) {
  const spawned = []; const execs = []; const order = [];
  const spawnImpl = (...args) => { const rec = args; spawned.push(rec); order.push('spawn'); return { unref() { rec.unrefd = true; } }; };
  const execImpl = async (file, args, opts) => { execs.push([file, args, opts]); order.push('exec'); if (stopFails) throw new Error('exit 1'); return { stdout: '' }; };
  const existsImpl = (p) => exeExists && p.endsWith('hermes.exe');
  return { spawned, execs, order, spawnImpl, execImpl, existsImpl };
}

test('Linux: chạy systemctl restart hermes-gateway tới khi xong (không spawn tách rời)', async () => {
  const f = fakes();
  await makeRestartAssistant({ platform: 'linux', hermesHome: '/h', spawnImpl: f.spawnImpl, execImpl: f.execImpl, existsImpl: f.existsImpl })();
  assert.equal(f.execs.length, 1);
  assert.deepEqual(f.execs[0].slice(0, 2), ['systemctl', ['restart', 'hermes-gateway']]);
  assert.equal(f.execs[0][2].windowsHide, true);
  assert.equal(f.spawned.length, 0);
});

test('Linux: systemctl lỗi thì báo lỗi gợi ý ZALO_ASSISTANT_RESTART_CMD, không báo thành công', async () => {
  const logged = [];
  const execImpl = async () => { throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'Access denied' }); };
  const error = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    await assert.rejects(makeRestartAssistant({ platform: 'linux', hermesHome: '/h', execImpl, spawnImpl: () => { throw new Error('không được spawn'); } })(),
      (e) => /ZALO_ASSISTANT_RESTART_CMD/.test(e.message) && /hermes-gateway/.test(e.message) && !/Access denied/.test(e.message));
  } finally { console.error = error; }
  assert.ok(logged.some((l) => /Access denied/.test(l)));
});

test('macOS: KHÔNG gọi systemctl (máy không có systemd) mà chạy thẳng hermes gateway run', async () => {
  // Lỗi đã xảy ra: điều kiện cũ `platform !== 'win32'` khiến macOS rơi vào nhánh systemctl, lệnh luôn thất bại
  // nên gateway đã dừng thì không bao giờ được dựng lại. macOS phải spawn như Windows, không đụng systemctl.
  const f = fakes();
  await makeRestartAssistant({ platform: 'darwin', hermesHome: '/h', spawnImpl: f.spawnImpl, execImpl: f.execImpl, existsImpl: f.existsImpl })();
  assert.equal(f.execs.filter(([file]) => file === 'systemctl').length, 0, 'không được gọi systemctl trên macOS');
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0][0], 'hermes');
  assert.deepEqual(f.spawned[0][1], ['gateway', 'run', '--accept-hooks']);
  assert.equal(f.spawned[0][2].detached, true);
  assert.equal(f.spawned[0][2].cwd, '/h');
});

test('macOS: gateway cũ chưa nhả khoá (mã 75) thì chạy lại, có giới hạn số lần', async () => {
  const spawned = [];
  const execImpl = async (file, args) => { if (file === 'systemctl') throw new Error('không có systemctl trên macOS'); return { stdout: '' }; };
  const spawnImpl = (exe, argv, opts) => {
    const rec = { exe, argv, opts, listeners: {}, unref() {}, on(ev, fn) { this.listeners[ev] = fn; } };
    spawned.push(rec);
    return rec;
  };
  await makeRestartAssistant({ platform: 'darwin', hermesHome: '/h', spawnImpl, execImpl, existsImpl: () => false, retryDelayMs: 5, maxRetries: 2 })();
  assert.equal(spawned.length, 1, 'lần chạy đầu');
  spawned[0].listeners.exit?.(75);           // gateway cũ còn giữ khoá
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 2, 'mã 75 → chạy lại');
  spawned[1].listeners.exit?.(75);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 3, 'còn lượt retry');
  spawned[2].listeners.exit?.(75);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 3, 'hết maxRetries thì dừng, không lặp vô hạn');
});

test('có cmd: chạy qua shell, ẩn cửa sổ, tách rời', async () => {
  const f = fakes();
  await makeRestartAssistant({ cmd: 'do-it', platform: 'win32', hermesHome: 'C:/h', spawnImpl: f.spawnImpl, execImpl: f.execImpl, existsImpl: f.existsImpl })();
  assert.equal(f.spawned[0][0], 'do-it');
  assert.equal(f.spawned[0][1].shell, true);
  assert.equal(f.spawned[0][1].windowsHide, true);
  assert.equal(f.spawned[0][1].detached, true);
  assert.equal(f.spawned[0].unrefd, true);
  assert.equal(f.execs.length, 0);
});

test('Windows có hermes.exe: stop rồi mới chạy lại, không dùng Hermes-Online.vbs', async () => {
  const f = fakes({ exeExists: true });
  await makeRestartAssistant({ platform: 'win32', hermesHome: 'C:/h', spawnImpl: f.spawnImpl, execImpl: f.execImpl, existsImpl: f.existsImpl })();
  const exe = join('C:/h', 'bin', 'hermes.exe');
  assert.equal(f.execs[0][0], exe);
  assert.deepEqual(f.execs[0][1], ['gateway', 'stop']);
  assert.equal(f.execs[0][2].windowsHide, true);
  assert.ok(f.execs[0][2].timeout >= 1000);
  assert.deepEqual(f.order, ['exec', 'spawn']);
  assert.equal(f.spawned[0][0], exe);
  assert.deepEqual(f.spawned[0][1], ['gateway', 'run', '--accept-hooks']);
  const { env, ...spawnOpts } = f.spawned[0][2];
  assert.deepEqual(spawnOpts, { detached: true, windowsHide: true, stdio: 'ignore', cwd: 'C:/h' });
  assert.ok(env && !('ZALO_ALLOWED_USERS' in env), 'không mang danh sách chủ nhân cũ sang tiến trình mới');
  assert.equal(f.spawned[0].unrefd, true);
  assert.ok(!JSON.stringify(f.execs).includes('vbs') && !JSON.stringify(f.spawned).includes('vbs'));
});

test('Windows không có hermes.exe: dùng "hermes"; stop lỗi vẫn chạy tiếp', async () => {
  const f = fakes({ exeExists: false, stopFails: true });
  const warn = console.warn; console.warn = () => {};
  try {
    await makeRestartAssistant({ platform: 'win32', hermesHome: 'C:/h', spawnImpl: f.spawnImpl, execImpl: f.execImpl, existsImpl: f.existsImpl })();
  } finally { console.warn = warn; }
  assert.equal(f.execs[0][0], 'hermes');
  assert.equal(f.spawned[0][0], 'hermes');
  assert.deepEqual(f.spawned[0][1], ['gateway', 'run', '--accept-hooks']);
});

test('spawn phát sự kiện error (ENOENT) thì rejects', async () => {
  const { EventEmitter } = await import('node:events');
  const spawnImpl = () => { const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; };
  await assert.rejects(makeRestartAssistant({ cmd: 'do-it', platform: 'linux', hermesHome: '/h', spawnImpl })(), /ENOENT/);
});

// Tiến trình giả có sự kiện spawn/exit như ChildProcess.
function proc() {
  const h = {};
  const p = {
    on(ev, fn) { (h[ev] ||= []).push(fn); return p; }, once(ev, fn) { return p.on(ev, fn); },
    removeListener() { return p; }, unref() {},
    emit(ev, ...a) { for (const fn of h[ev] || []) fn(...a); },
  };
  setImmediate(() => p.emit('spawn'));
  return p;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('Windows: gateway cũ chưa nhả khoá (Hermes thoát mã 75) thì đợi rồi chạy lại; mã khác thì thôi; có giới hạn', async () => {
  const kids = [];
  const spawnImpl = () => { const p = proc(); kids.push(p); return p; };
  const execImpl = async () => ({ stdout: '' });
  const restart = makeRestartAssistant({ platform: 'win32', hermesHome: 'C:/h', spawnImpl, execImpl, existsImpl: () => true, retryDelayMs: 5, maxRetries: 2 });
  await restart();
  assert.equal(kids.length, 1);
  kids[0].emit('exit', 75);
  await tick(30);
  assert.equal(kids.length, 2, 'mã 75 → chạy lại');
  kids[1].emit('exit', 75);
  await tick(30);
  assert.equal(kids.length, 3);
  kids[2].emit('exit', 75);
  await tick(30);
  assert.equal(kids.length, 3, 'quá số lần thử thì dừng');

  const other = [];
  await makeRestartAssistant({ platform: 'win32', hermesHome: 'C:/h', spawnImpl: () => { const p = proc(); other.push(p); return p; }, execImpl, existsImpl: () => true, retryDelayMs: 5 })();
  other[0].emit('exit', 1);
  await tick(30);
  assert.equal(other.length, 1, 'thoát vì lỗi khác thì không chạy lại vô tận');
});
