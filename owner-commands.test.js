import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildArgv, commandIsDangerous, createOwnerCommandRunner, formatOutput, memoryReport, parseMemoryEntries,
  parseOwnerCommand, redactSecrets, rememberNote, runProcess, setGroupReplyMode,
} from './owner-commands.js';
import { createOwnerDirectory, splitOwnerUids } from './zalo-owners.js';

const MAIN = '8022000000000000001';
const OTHER = '6443000000000000002';

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-cmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseOwnerCommand nhận đúng mọi lệnh chủ nhân trong danh sách', () => {
  const expected = {
    '/new': 'new',
    '/reset': 'reset',
    '/clear': 'new',
    '/STOP': 'stop',
    '/memory': 'memory',
    '/model': 'model-list',
    '/skills': 'skills-list',
    'hermes sessions list': 'sessions-list',
    'hermes setup': 'setup',
    'hermes model x': 'model-set',
    'hermes doctor': 'doctor',
    'hermes profile create office': 'profile-create',
    'hermes profile list': 'profile-list',
    'hermes --profile office doctor': 'doctor',
    'hermes gateway setup': 'gateway-setup',
    'hermes gateway start': 'gateway-start',
    'hermes gateway status': 'gateway-status',
    'hermes skills search pdf': 'skills-search',
    'hermes skills install pdf-tools': 'skills-install',
    'hermes skills inspect pdf-tools': 'skills-inspect',
    'hermes skills check': 'skills-check',
    'hermes skills update': 'skills-update',
    'hermes config set security.approvals.mode smart': 'config-set',
    'hermes config set security.redact_secrets true': 'config-set',
    'hermes update': 'update',
  };
  for (const [text, command] of Object.entries(expected)) {
    assert.equal(parseOwnerCommand(text)?.run?.command, command, text);
  }
});

test('câu lệnh lạ/không phải lệnh chủ nhân trả null để trợ lý trả lời', () => {
  for (const text of ['hello', '/help', '/usage', 'hermes', 'hermes rm -rf /', '/whoami']) {
    assert.equal(parseOwnerCommand(text), null, text);
  }
});

test('gõ sai cú pháp trả hướng dẫn, không chạy gì', () => {
  for (const text of ['/remember', '/model foo bar', 'hermes model', 'hermes sessions resume abc']) {
    const parsed = parseOwnerCommand(text);
    assert.equal(parsed?.run, undefined, text);
    assert.equal(typeof parsed?.usage, 'string');
  }
});

test('/shutup là lệnh chủ nhân: tạm dừng hội thoại, kể cả khi tin còn chữ @Bot dính liền', () => {
  for (const text of ['/shutup', '/SHUTUP', '@Bot /shutup', '@Minh Luan /shutup']) {
    assert.deepEqual(parseOwnerCommand(text)?.run, { command: 'pause', display: '/shutup' }, text);
  }
});

test('setGroupReplyMode ghi đúng nhóm, giữ khoá khác và bỏ khoá bằng lớp trên', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-cmd-perm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'permissions.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    defaults: { replyOnlyTagged: false },
    folders: { lop: { name: 'Lớp', groups: ['222'], replyOnlyTagged: true } },
    groups: { 111: { active: false, features: { web: false } } },
    dm: { who: 'open', features: {}, people: {} },
  }));
  assert.equal(setGroupReplyMode(file, '111', { tagged: true }), true);
  let disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(disk.groups['111'], { active: false, features: { web: false }, replyOnlyTagged: true });
  assert.equal(disk.folders.lop.replyOnlyTagged, true, 'thư mục giữ nguyên');
  assert.deepEqual(disk.dm, { who: 'open', features: {}, people: {} }, 'mục nhắn riêng sống qua lần ghi');
  // Trùng lớp thư mục (true) → không ghi khoá riêng cho nhóm trong thư mục.
  assert.equal(setGroupReplyMode(file, '222', { tagged: true }), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).groups['222'], undefined);
  // Trùng `defaults` (false) → khoá của nhóm biến mất.
  assert.equal(setGroupReplyMode(file, '111', { tagged: false }), true);
  disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(disk.groups['111'], { active: false, features: { web: false } });
});

test('/shutup đặt ô "Tạm dừng", không đụng ô tag; /silent và /talk nhả tạm dừng ngay', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-cmd-perm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'permissions.json');
  const disk = () => JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(setGroupReplyMode(file, '111', { paused: true }), true);
  assert.deepEqual(disk().groups['111'], { paused: true });
  assert.equal(setGroupReplyMode(file, '111', { tagged: true, resume: true }), true);
  // /silent: đặt ô tag VÀ nhả tạm dừng — `/silent` phải trả lời được ngay câu tiếp theo, kể cả khi mặc định chưa có khoá.
  assert.deepEqual(disk().groups['111'], { replyOnlyTagged: true, paused: false }, 'resume ghi false tường minh');
  assert.equal(setGroupReplyMode(file, '111', { tagged: false, resume: true }), true);
  assert.deepEqual(disk().groups['111'], { replyOnlyTagged: false, paused: false }, '/talk ghi false tường minh (tệp chưa có mặc định)');
});

test('setGroupReplyMode tạo tệp khi chưa có, không đụng tệp hỏng', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-cmd-perm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'permissions.json');
  assert.equal(setGroupReplyMode(file, '333', { tagged: true }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, defaults: {}, groups: { 333: { replyOnlyTagged: true } } });
  writeFileSync(file, '{ hỏng');
  assert.throws(() => setGroupReplyMode(file, '333', { tagged: false }), /hỏng/);
  assert.equal(readFileSync(file, 'utf8'), '{ hỏng');
});

test('argv không bao giờ chứa chuỗi shell của người gõ', () => {
  const argv = buildArgv(parseOwnerCommand('hermes skills search pdf maths').run);
  assert.deepEqual(argv, ['skills', 'search', 'pdf maths']);
  const cfg = buildArgv(parseOwnerCommand('hermes config set security.approvals.mode smart').run);
  assert.deepEqual(cfg, ['config', 'set', 'security.approvals.mode', 'smart']);
  // Ký tự shell bị từ chối trước khi tới argv.
  assert.equal(parseOwnerCommand('hermes config set a.b "x; rm -rf /"').run, undefined);
  assert.equal(parseOwnerCommand("hermes profile create a'b").run, undefined);
});

test('nhóm nguy hiểm khớp danh sách của plugin Python', () => {
  const dangerous = ['hermes update', 'hermes skills install x', 'hermes config set a b',
    'hermes profile create x', 'hermes setup', 'hermes gateway start', 'hermes gateway setup']
    .map((text) => commandIsDangerous(parseOwnerCommand(text)));
  assert.deepEqual(dangerous, Array(dangerous.length).fill(true));
  for (const text of ['hermes doctor', 'hermes sessions list', '/model', '/memory', '/skills', '/new']) {
    assert.equal(commandIsDangerous(parseOwnerCommand(text)), false, text);
  }
});

test('chủ nhân phụ không chạy được lệnh đổi máy; chủ nhân chính thì được', async (t) => {
  const home = tempHome(t);
  const calls = [];
  const run = createOwnerCommandRunner({
    env: () => ({ HERMES_HOME: home }),
    hermesBin: '/bin/hermes',
    runProcessImpl: async (argv) => { calls.push(argv); return { code: 0, stdout: 'ok', stderr: '' }; },
  });
  const denied = await run('hermes update', 'owner');
  assert.equal(denied.denied, true);
  assert.deepEqual(calls, [], 'bị từ chối thì không chạy');

  const allowed = await run('hermes container check', 'main');
  assert.equal(allowed, null, 'lệnh lạ vẫn không chạy');
  const needsConfirm = await run('hermes update', 'main');
  assert.equal(needsConfirm.needsConfirm, true, 'thiếu chữ xác nhận thì chưa chạy');
  assert.deepEqual(calls, [], 'chưa xác nhận thì không chạm tới tiến trình');

  const started = await run('hermes update xác nhận', 'main');
  assert.equal(started.needsConfirm, undefined);
  assert.deepEqual(calls, [['/bin/hermes', 'update']]);
});

test('lệnh đọc chạy qua argv và trả kết quả đã ẩn bí mật', async (t) => {
  const home = tempHome(t);
  writeFileSync(join(home, '.env'), 'ZALO_BRIDGE_TOKEN=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
  let seen = null;
  const run = createOwnerCommandRunner({
    env: () => ({ HERMES_HOME: home, ZALO_BRIDGE_TOKEN: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    hermesBin: '/bin/hermes',
    runProcessImpl: async (argv, options) => {
      seen = { argv, options };
      return { code: 0, stdout: 'token: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n\u001B[32mok\u001B[0m', stderr: '' };
    },
  });
  const result = await run('hermes gateway status', 'owner');
  assert.deepEqual(seen.argv, ['/bin/hermes', 'gateway', 'status']);
  assert.ok(!result.reply.includes('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
  assert.ok(result.reply.includes('token: <đã ẩn>'));
  assert.ok(!/\u001B\[/.test(result.reply), 'ANSI bị cắt');
  assert.equal(result.exitCode, 0);
});

test('/remember ghi đúng định dạng mục của Hermes và tôn trọng giới hạn ký tự', (t) => {
  const home = tempHome(t);
  writeFileSync(join(home, 'config.yaml'), 'memory:\n  memory_char_limit: 60\n  user_char_limit: 40\n');
  const first = rememberNote(home, 'thích cà phê đá');
  assert.equal(first.exitCode, 0);
  assert.deepEqual(parseMemoryEntries(readFileSync(join(home, 'memories', 'MEMORY.md'), 'utf8')), ['thích cà phê đá']);
  assert.match(memoryReport(home), /thích cà phê đá/);

  const duplicate = rememberNote(home, 'thích cà phê đá');
  assert.match(duplicate.reply, /đã nhớ điều này rồi/);

  const tooBig = rememberNote(home, 'x'.repeat(80));
  assert.equal(tooBig.exitCode, 1);
  assert.match(tooBig.reply, /60 ký tự/);
  assert.deepEqual(parseMemoryEntries(readFileSync(join(home, 'memories', 'MEMORY.md'), 'utf8')), ['thích cà phê đá']);
});

test('danh sách chủ nhân đọc lại khi .env đổi, loại số điện thoại', (t) => {
  const home = tempHome(t);
  const file = join(home, '.env');
  writeFileSync(file, `ZALO_ALLOWED_USERS=${MAIN}\n`);
  const owners = createOwnerDirectory({ home });
  assert.deepEqual([...owners.uids()], [MAIN]);

  writeFileSync(file, `ZALO_ALLOWED_USERS=${MAIN},${OTHER},0987654321\n`);
  assert.deepEqual([...owners.uids()], [MAIN, OTHER], 'thêm chủ nhân là có hiệu lực ngay, không cần khởi động lại');

  writeFileSync(file, `ZALO_ALLOWED_USERS="${OTHER}"\n`);
  assert.deepEqual([...owners.uids()], [OTHER]);
  // Đọc từ `.env` thì lọc theo dạng UID thật; danh sách cố định (test, nhúng) để nguyên.
  assert.deepEqual(splitOwnerUids('0987654321,12345', { strict: true }), []);
});

test('redactSecrets ẩn token thật, giữ mã ngắn', () => {
  const out = redactSecrets('a=contract-fee b=sk-abcdefghijklmnopqrstuvwx c=deadbeefdeadbeefdeadbeefdeadbeef',
    ['contract-fee']);
  assert.equal(out.includes('contract-fee'), false);
  assert.equal(out.includes('sk-abcdefghijklmnopqrstuvwx'), false);
  assert.equal(out.includes('deadbeefdeadbeefdeadbeefdeadbeef'), false);
});

test('formatOutput báo mã thoát khác 0 và cắt dài', () => {
  assert.match(formatOutput({ stdout: 'x'.repeat(40), code: 2 }, { limit: 10 }), /Mã thoát 2/);
  assert.match(formatOutput({ stdout: '', stderr: '', code: 0 }), /không có kết quả/);
});

test('runProcess trả mã thoát và gộp stderr của lệnh thật', async () => {
  const ok = await runProcess(['/bin/sh', '-c', 'echo out; echo err 1>&2; exit 3']);
  assert.equal(ok.code, 3);
  assert.match(ok.stdout, /out/);
  assert.match(ok.stderr, /err/);
});

test('lệnh tách nền trả ngay, không chờ', async () => {
  const run = createOwnerCommandRunner({
    env: () => ({ HERMES_HOME: '/tmp' }),
    hermesBin: '/bin/hermes',
    runProcessImpl: async (_argv, options) => ({ code: 0, detached: options.detached, stdout: '', stderr: '' }),
  });
  const result = await run('hermes update xác nhận', 'main');
  assert.equal(result.handled, true);
  assert.match(result.reply, /chế độ nền/);
});

test('chữ "xác nhận" bị bỏ khỏi lệnh, "xac-nhan" cũng nhận', () => {
  const withWord = parseOwnerCommand('hermes config set security.redact_secrets true xác nhận');
  assert.equal(withWord.run.display, 'hermes config set security.redact_secrets true');
  const spaced = parseOwnerCommand('hermes skills install pdf-tools xac-nhan');
  assert.equal(spaced.run.name, 'pdf-tools');
  assert.equal(parseOwnerCommand('hermes update').run.display, 'hermes update');
});

test('chủ nhân chính gõ "xác nhận" thì lệnh đổi máy chạy (tiến trình giả)', async () => {
  const calls = [];
  const run = createOwnerCommandRunner({
    env: () => ({ HERMES_HOME: '/tmp' }),
    hermesBin: '/bin/hermes',
    runProcessImpl: async (argv) => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; },
  });
  const gate = await run('hermes setup', 'main');
  assert.equal(gate.needsConfirm, true);
  assert.deepEqual(calls, []);
  await run('hermes setup xác nhận', 'main');
  assert.deepEqual(calls, [['/bin/hermes', 'setup']]);
});

test('/outgroup là lệnh chủ nhân, không cần argv Hermes', () => {
  for (const text of ['/outgroup', '/OUTGROUP']) {
    assert.deepEqual(parseOwnerCommand(text)?.run, { command: 'outgroup', display: '/outgroup' });
  }
});

test('/kick lấy UID viết tay, bỏ trùng; tag thật do adapter đọc riêng', () => {
  assert.deepEqual(parseOwnerCommand('/kick 6443000000000000002')?.run, {
    command: 'kick', display: '/kick 6443000000000000002', users: ['6443000000000000002'],
  });
  assert.deepEqual(parseOwnerCommand('/kick 6443000000000000002 6443000000000000002 9000000000000000009')?.run.users,
    ['6443000000000000002', '9000000000000000009']);
  // Chỉ có tag (@An), hoặc không có gì: vẫn là lệnh — adapter đọc ``mentions`` hay trả câu cú pháp.
  assert.deepEqual(parseOwnerCommand('/kick @An')?.run, { command: 'kick', display: '/kick', users: [] });
  assert.equal(parseOwnerCommand('/kick')?.run.command, 'kick');
});

test('/outgroup và /kick đuổi người nên không phải lệnh đổi máy', () => {
  for (const text of ['/outgroup', '/kick 6443000000000000002']) {
    assert.equal(commandIsDangerous(parseOwnerCommand(text)), false, text);
  }
});
