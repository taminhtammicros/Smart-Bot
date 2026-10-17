import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRestartSidecar } from './restart.js';

function fakes({ netstat = '' } = {}) {
  const calls = []; const execCalls = []; const sleeps = [];
  const spawnImpl = (...args) => { const rec = args; calls.push(rec); return { unref() { rec.unrefd = true; } }; };
  const execImpl = async (file, args, opts) => { execCalls.push([file, args, opts]); return { stdout: file === 'netstat' ? netstat : '' }; };
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  return { calls, execCalls, sleeps, spawnImpl, execImpl, sleepImpl };
}
const LINE = (port, pid, state = 'LISTENING') =>
  `  TCP    127.0.0.1:${port}        0.0.0.0:0              ${state}       ${pid}\n`;
const HEAD = '  Proto  Local Address          Foreign Address        State           PID\n';

test('Linux không cmd: chạy systemctl restart zalo-bridge tới khi xong (không spawn tách rời)', async () => {
  const f = fakes();
  await makeRestartSidecar({ platform: 'linux', sidecarRoot: '/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl })();
  assert.equal(f.execCalls.length, 1);
  assert.deepEqual(f.execCalls[0].slice(0, 2), ['systemctl', ['restart', 'zalo-bridge']]);
  assert.equal(f.execCalls[0][2].windowsHide, true);
  assert.equal(f.calls.length, 0);
});

test('Linux: systemctl thoát mã khác 0 thì báo lỗi kèm bước tiếp theo, stderr chỉ vào log', async () => {
  const logged = [];
  const execImpl = async () => { throw Object.assign(new Error('Command failed'), { code: 5, stderr: 'Unit zalo-bridge.service not found.' }); };
  const error = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    await assert.rejects(makeRestartSidecar({ platform: 'linux', sidecarRoot: '/x', execImpl, spawnImpl: () => { throw new Error('không được spawn'); } })(),
      (e) => /ZALO_SIDECAR_RESTART_CMD/.test(e.message) && /Không khởi động lại được/.test(e.message) && !/not found/.test(e.message));
  } finally { console.error = error; }
  assert.ok(logged.some((l) => /Unit zalo-bridge\.service not found/.test(l)));
});

test('có cmd: chạy qua shell, ẩn cửa sổ, không đụng netstat', async () => {
  const f = fakes();
  await makeRestartSidecar({ cmd: 'start-it', platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl })();
  assert.equal(f.calls[0][0], 'start-it');
  assert.equal(f.calls[0][1].shell, true);
  assert.equal(f.calls[0][1].windowsHide, true);
  assert.equal(f.calls[0].unrefd, true);
  assert.equal(f.execCalls.length, 0);
});

test('macOS không cmd: spawn thẳng server.js, không gọi systemctl/netstat', async () => {
  const f = fakes();
  await makeRestartSidecar({ platform: 'darwin', sidecarRoot: '/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl })();
  assert.equal(f.execCalls.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], process.execPath);
  assert.deepEqual(f.calls[0][1], ['server.js']);
  assert.equal(f.calls[0][2].cwd, '/x');
  assert.equal(f.calls[0].unrefd, true);
});

test('có cmd: không đụng systemctl trên macOS', async () => {
  const f = fakes();
  await makeRestartSidecar({ cmd: 'start-it', platform: 'darwin', sidecarRoot: '/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl })();
  assert.equal(f.execCalls.length, 0);
  assert.equal(f.calls[0][0], 'start-it');
  assert.equal(f.calls[0][1].shell, true);
});

test('Windows: giết đúng tiến trình đang LISTEN cổng rồi mới spawn', async () => {
  const f = fakes({ netstat: HEAD + LINE(3872, 4321) + LINE(5000, 999) });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl, ownPid: 1 })();
  assert.equal(f.execCalls[0][0], 'netstat');
  assert.deepEqual(f.execCalls[0][1], ['-ano', '-p', 'tcp']);
  assert.equal(f.execCalls[1][0], 'taskkill');
  assert.deepEqual(f.execCalls[1][1], ['/PID', '4321', '/F']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], process.execPath);
  assert.deepEqual(f.calls[0][1], ['server.js']);
  assert.equal(f.calls[0][2].cwd, 'C:/x');
  assert.equal(f.calls[0][2].windowsHide, true);
  assert.equal(f.calls[0].unrefd, true);
});

test('Windows: dòng cổng khác / không LISTENING / cổng có tiền tố trùng bị bỏ qua', async () => {
  const f = fakes({ netstat: HEAD + LINE(5000, 999) + LINE(3872, 77, 'TIME_WAIT') + LINE(38720, 55) });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl })();
  assert.equal(f.execCalls.filter((c) => c[0] === 'taskkill').length, 0);
  assert.equal(f.calls.length, 1);
});

test('Windows: tuỳ chọn port được dùng', async () => {
  const f = fakes({ netstat: HEAD + LINE(4000, 12) });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', port: 4000, spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl, ownPid: 1 })();
  assert.deepEqual(f.execCalls[1][1], ['/PID', '12', '/F']);
});

test('Windows: không bao giờ giết chính tiến trình này', async () => {
  const f = fakes({ netstat: HEAD + LINE(3872, 555) });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl, ownPid: 555 })();
  assert.equal(f.execCalls.filter((c) => c[0] === 'taskkill').length, 0);
  assert.equal(f.calls.length, 1);
});

test('Windows: netstat và taskkill đều ẩn cửa sổ', async () => {
  const f = fakes({ netstat: HEAD + LINE(3872, 4321) });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl, ownPid: 1 })();
  for (const c of f.execCalls) assert.equal(c[2].windowsHide, true);
});

test('Windows: sau taskkill chờ cổng nhả rồi mới spawn', async () => {
  let listening = true; const order = [];
  const f = fakes();
  const execImpl = async (file) => {
    order.push(file);
    if (file === 'taskkill') return { stdout: '' };
    const out = listening ? HEAD + LINE(3872, 4321) : HEAD;
    if (order.filter((x) => x === 'netstat').length >= 2) listening = false;
    return { stdout: out };
  };
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: (...a) => { order.push('spawn'); return f.spawnImpl(...a); }, execImpl, sleepImpl: f.sleepImpl, ownPid: 1 })();
  assert.deepEqual(order, ['netstat', 'taskkill', 'netstat', 'netstat', 'spawn']);
  assert.deepEqual(f.sleeps, [250, 250]);
});

test('Windows: cổng không nhả thì chờ tối đa 12 lần rồi vẫn spawn', async () => {
  const f = fakes({ netstat: HEAD + LINE(3872, 4321) });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl, ownPid: 1 })();
  assert.equal(f.sleeps.length, 12); assert.equal(f.calls.length, 1);
});

test('netstat: [::]:3872 LISTENING khớp', async () => {
  const f = fakes({ netstat: HEAD + '  TCP    [::]:3872              [::]:0                 LISTENING       808' });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl, ownPid: 1 })();
  assert.deepEqual(f.execCalls[1][1], ['/PID', '808', '/F']);
});

test('netstat: 127.0.0.1:13872 không khớp', async () => {
  const f = fakes({ netstat: HEAD + LINE(13872, 808) });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl })();
  assert.equal(f.execCalls.filter((c) => c[0] === 'taskkill').length, 0);
});

test('netstat: chỉ cột Foreign Address kết thúc bằng :3872 thì không khớp', async () => {
  const f = fakes({ netstat: HEAD + '  TCP    10.0.0.5:50000         10.0.0.9:3872          LISTENING       808' });
  await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl })();
  assert.equal(f.execCalls.filter((c) => c[0] === 'taskkill').length, 0);
});

test('spawn phát sự kiện error (ENOENT) thì rejects, không thành uncaught', async () => {
  const { EventEmitter } = await import('node:events');
  const spawnImpl = () => { const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; };
  await assert.rejects(makeRestartSidecar({ cmd: 'start-it', platform: 'linux', sidecarRoot: '/x', spawnImpl })(), /ENOENT/);
});

test('spawn thành công: chờ sự kiện spawn rồi mới unref', async () => {
  const { EventEmitter } = await import('node:events');
  let unrefd = false;
  const spawnImpl = () => { const c = new EventEmitter(); c.unref = () => { unrefd = true; }; setImmediate(() => c.emit('spawn')); return c; };
  await makeRestartSidecar({ cmd: 'start-it', platform: 'linux', sidecarRoot: '/x', spawnImpl })();
  assert.equal(unrefd, true);
});

test('tiến trình con khởi động lại không thừa hưởng ZALO_ALLOWED_USERS cũ', async () => {
  const f = fakes();
  process.env.ZALO_ALLOWED_USERS = 'cu';
  try {
    await makeRestartSidecar({ platform: 'win32', sidecarRoot: 'C:/x', spawnImpl: f.spawnImpl, execImpl: f.execImpl, sleepImpl: f.sleepImpl, ownPid: 1 })();
  } finally { delete process.env.ZALO_ALLOWED_USERS; }
  const env = f.calls.at(-1)[2].env;
  assert.ok(env && !('ZALO_ALLOWED_USERS' in env));
});
