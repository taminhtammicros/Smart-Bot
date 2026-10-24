import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchedules, cronTarget, hermesBin, zaloJobs } from './schedules.js';

const JOBS = { jobs: [
  { id: 'cc158a101f88', name: 'Báo cáo GCP', prompt: 'x', script: 'run_billing_report.py', deliver: 'origin', origin: { platform: 'telegram', chat_id: '86' } },
  { id: 'aa11bb22cc33', name: 'Nhắc nộp bài', prompt: 'Nhắc lớp nộp bài', schedule: { display: '0 7 * * 1' }, enabled: true, state: 'scheduled',
    next_run_at: '2026-10-12T07:00:00+07:00', deliver: 'origin', origin: { platform: 'zalo', chat_id: '555', zalo_scope: 'group', zalo_creator_uid: '1111111111111111111', zalo_creator_name: 'Lan' } },
  { id: 'dd44ee55ff66', name: 'Tin sáng', schedule_display: '0 6 * * *', deliver: 'zalo:777:1', state: 'paused', paused_at: '2026-10-01T00:00:00Z', origin: {} },
  { id: '../evil', deliver: 'zalo:1' },
] };

function home(t, data = JOBS) {
  const h = mkdtempSync(join(tmpdir(), 'zd-cron-'));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  mkdirSync(join(h, 'cron'));
  writeFileSync(join(h, 'cron', 'jobs.json'), JSON.stringify(data));
  return h;
}

/** Giả lập Hermes thật sự làm việc: sửa jobs.json (hoặc xoá việc nếu fn trả 'remove'). */
function mutate(h, id, fn) {
  const file = join(h, 'cron', 'jobs.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const job = data.jobs.find((j) => j.id === id);
  if (fn(job) === 'remove') data.jobs = data.jobs.filter((j) => j.id !== id);
  writeFileSync(file, JSON.stringify(data));
}

test('chỉ việc gửi về Zalo; phân biệt hẹn giờ nhóm và việc của chủ nhân; không lộ script', () => {
  assert.equal(cronTarget({ deliver: 'telegram,zalo:42:1' }), '42');
  assert.equal(cronTarget({ deliver: 'origin', origin: { platform: 'zalo', chat_id: 9 } }), '9');
  const list = zaloJobs(JOBS);
  assert.deepEqual(list.map((j) => [j.id, j.kind, j.target, j.paused]), [['aa11bb22cc33', 'group', '555', false], ['dd44ee55ff66', 'owner', '777', true]]);
  assert.equal(list[0].creatorName, 'Lan');
  assert.equal('creatorUid' in list[0], false, 'không lộ uid người tạo');
  assert.equal(list[0].schedule, '0 7 * * 1');
  assert.equal(list[0].nextRunAt, Date.parse('2026-10-12T07:00:00+07:00'));
  assert.doesNotMatch(JSON.stringify(list), /run_billing|telegram/);
});

test('thao tác chạy đúng lệnh Hermes, chỉ với việc Zalo; id lạ/việc khác → 404; lệnh lỗi → 502 câu chung', async (t) => {
  const h = home(t);
  const calls = [];
  const s = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async (file, args, opts) => {
    calls.push([file, args, opts.env.HERMES_HOME, opts.windowsHide]);
    mutate(h, args[2], (j) => { j.state = 'paused'; j.paused_at = '2026-10-08T00:00:00Z'; });
    return { stdout: '' };
  } });
  assert.equal((await s.cron('pause', 'aa11bb22cc33')).name, 'Nhắc nộp bài');
  assert.deepEqual(calls, [['hermes', ['cron', 'pause', 'aa11bb22cc33'], h, true]]);
  await assert.rejects(s.cron('remove', 'cc158a101f88'), (e) => e.statusCode === 404, 'việc gửi Telegram không đụng tới được');
  await assert.rejects(s.cron('remove', '../evil'), (e) => e.statusCode === 404);
  await assert.rejects(s.cron('run', 'aa11bb22cc33'), (e) => e.statusCode === 400);
  const failing = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async () => { throw Object.assign(new Error('exit 1'), { stderr: '/root/.hermes bí mật' }); } });
  await assert.rejects(failing.cron('resume', 'dd44ee55ff66'), (e) => e.statusCode === 502 && !/root/.test(e.message));
});

test('đường lệnh hermes: biến môi trường → bản cài kèm → PATH', () => {
  assert.equal(hermesBin({ hermesHome: '/h', env: { ZALO_HERMES_BIN: '/x/hermes' } }), '/x/hermes');
  assert.equal(hermesBin({ hermesHome: 'E:/Hermes', env: {}, platform: 'win32', exists: () => true }), join('E:/Hermes', 'bin', 'hermes.exe'));
  assert.equal(hermesBin({ hermesHome: '/root/.hermes', env: {}, platform: 'linux', exists: () => false }), 'hermes');
});

test('hermes cron không làm được → lý do thật (400) hoặc 502 khi lỗi lạ; làm được thì xác nhận trạng thái', async (t) => {
  const h = home(t);
  // Lệnh chạy được nhưng jobs.json không đổi → lỗi bên trong, 502 kèm bước tiếp theo.
  const noop = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async () => ({ stdout: 'ok' }) });
  for (const [action, id] of [['pause', 'aa11bb22cc33'], ['resume', 'dd44ee55ff66'], ['remove', 'aa11bb22cc33']]) {
    await assert.rejects(noop.cron(action, id), (e) => e.statusCode === 502 && /thử lại/.test(e.message), `${action} không đổi trạng thái`);
  }
  // Hermes từ chối vì việc đã chạy xong → 400 nói rõ, không phải 502 chung (thoát mã khác 0 vẫn đọc được lý do).
  const terminal = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async (f, a) => {
    throw Object.assign(new Error('Command failed'), { stdout: `Failed to pause job: Cannot activate terminal cron job 'x' through update_job\n`, stderr: '' });
  } });
  await assert.rejects(terminal.cron('pause', 'aa11bb22cc33'), (e) => e.statusCode === 400 && /chạy xong/.test(e.message), 'lý do thật của Hermes, không phải 502');
  // Thoát 0 mà vẫn có dòng "Failed to <động từ> job" → cũng là câu 400 theo lý do.
  const said = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async () => ({ stdout: 'Failed to remove job: Không tìm thấy việc hẹn giờ này\n' }) });
  await assert.rejects(said.cron('remove', 'aa11bb22cc33'), (e) => e.statusCode === 400 && /không nhận lịch này/i.test(e.message), 'lý do trong stdout');
  const real = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async (f, [, action, id]) => {
    mutate(h, id, (j) => { if (action === 'resume') { j.state = 'scheduled'; delete j.paused_at; } else if (action === 'remove') return 'remove'; });
    return { stdout: 'done' };
  } });
  assert.equal((await real.cron('resume', 'dd44ee55ff66')).id, 'dd44ee55ff66');
  assert.equal((await real.cron('remove', 'aa11bb22cc33')).id, 'aa11bb22cc33');
  assert.deepEqual(real.list().map((j) => j.id), ['dd44ee55ff66']);
});

/** Giả lập `hermes cron create/edit` thật: ghi jobs.json như Hermes; `refuse` = in dòng từ chối như Hermes. */
function fakeHermes(h, calls, { refuse = '' } = {}) {
  return async (file, args) => {
    calls.push(args);
    if (refuse) return { stdout: `Failed to update job: ${refuse}\n` };
    const f = join(h, 'cron', 'jobs.json');
    const data = JSON.parse(readFileSync(f, 'utf8'));
    const sched = (v) => (/T/.test(v) ? { kind: 'once', run_at: `${v}:00+07:00` } : { kind: 'cron', expr: v });
    if (args[1] === 'create') {
      const [, , name, deliver, , schedule, prompt] = args;
      data.jobs.push({ id: 'abcdef123456', name: name.slice(7), prompt, deliver: deliver.slice(10), schedule: sched(schedule), state: 'scheduled', repeat: { times: null, completed: 0 } });
    } else {
      const j = data.jobs.find((x) => x.id === args[2]);
      for (const a of args.slice(3)) {
        const k = a.slice(2, a.indexOf('=')); const v = a.slice(a.indexOf('=') + 1);
        if (k === 'name') j.name = v; else if (k === 'prompt') j.prompt = v; else if (k === 'deliver') j.deliver = v;
        else if (k === 'schedule') j.schedule = sched(v); else if (k === 'repeat') j.repeat = { ...(j.repeat || {}), times: Number(v) || null };
      }
    }
    writeFileSync(f, JSON.stringify(data));
    return { stdout: 'Updated job\n  Name: Báo lỗi Error Invalid (tên có chữ lạ vẫn không phải lỗi)\n' };
  };
}

test('tạo/sửa bằng lời thường: đúng lệnh hermes cron, chỉ gửi trường đổi; kéo thả chỉ đổi lịch; cron gốc chỉ Quản trị', async (t) => {
  const { parseJobInput } = await import('./schedules.js');
  const h = home(t);
  const calls = [];
  const s = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: fakeHermes(h, calls) });
  const input = parseJobInput({ name: ' Nhắc  nộp bài ', prompt: '-rm nhắc lớp\nnộp bài', target: '555', spec: { repeat: 'weekly', times: ['20:00'], days: [2, 4] } });
  assert.deepEqual(input, { name: 'Nhắc nộp bài', prompt: '-rm nhắc lớp\nnộp bài', targets: ['555'], schedule: '0 20 * * 2,4' });
  const made = await s.create(input);
  assert.deepEqual(calls[0], ['cron', 'create', '--name=Nhắc nộp bài', '--deliver=zalo:555', '--', '0 20 * * 2,4', '-rm nhắc lớp\nnộp bài']);
  assert.equal(made.id, 'abcdef123456');
  assert.equal(made.prompt, '-rm nhắc lớp\nnộp bài', 'prompt trả nguyên văn, không gộp dòng');
  // Luồng: thêm nơi gửi (gửi cùng kết quả tới nhiều nhóm).
  await s.update('abcdef123456', parseJobInput({ targets: ['555', '888'] }, { partial: true }));
  assert.deepEqual(calls.at(-1), ['cron', 'edit', 'abcdef123456', '--deliver=zalo:555,zalo:888']);
  assert.deepEqual(s.list().find((j) => j.id === 'abcdef123456').targets, ['555', '888']);
  await s.update('abcdef123456', parseJobInput({ targets: ['555'] }, { partial: true }));
  calls.splice(1);
  // Kéo thả: chỉ lịch.
  await s.update('abcdef123456', parseJobInput({ spec: { repeat: 'weekly', times: ['20:00'], days: [4, 5] } }, { partial: true }));
  assert.deepEqual(calls[1], ['cron', 'edit', 'abcdef123456', '--schedule=0 20 * * 4,5']);
  // Lưu biểu mẫu không đổi gì → không gọi Hermes.
  await s.update('abcdef123456', parseJobInput({ name: 'Nhắc nộp bài', prompt: '-rm nhắc lớp\nnộp bài', target: '555', spec: { repeat: 'weekly', times: ['20:00'], days: [4, 5] } }, { partial: true }));
  assert.equal(calls.length, 2);
  // Lặp → một lần: số lần chạy = đã chạy + 1; một lần → lặp: lặp mãi.
  await s.update('abcdef123456', parseJobInput({ target: '777', spec: { repeat: 'once', date: '2026-10-23', times: ['08:00'] } }, { partial: true }));
  assert.deepEqual(calls[2], ['cron', 'edit', 'abcdef123456', '--schedule=2026-10-23T08:00', '--repeat=1', '--deliver=zalo:777']);
  await s.update('abcdef123456', parseJobInput({ spec: { repeat: 'daily', times: ['06:00'] } }, { partial: true }));
  assert.deepEqual(calls[3], ['cron', 'edit', 'abcdef123456', '--schedule=0 6 * * *', '--repeat=0']);
  await assert.rejects(s.update('cc158a101f88', input), (e) => e.statusCode === 404, 'việc không thuộc Zalo');
  for (const [body, re] of [[{ prompt: 'x', target: '1', spec: { repeat: 'daily', times: ['08:00'] } }, /tên/], [{ name: 'a', prompt: '', target: '1' }, /việc bot/],
    [{ name: 'a', prompt: 'x', target: 'abc' }, /nhóm hoặc người/], [{ name: 'a', prompt: 'x', target: '1', spec: { repeat: 'weekly', times: ['08:00'], days: [] } }, /thứ/],
    [{ name: 'a', prompt: 'x', target: '1', expr: '*/5 * * * *' }, /lịch chạy/], [{ name: 'a', prompt: 'x\u0000y', target: '1', spec: { repeat: 'daily', times: ['08:00'] } }, /ký tự ẩn/]]) {
    assert.throws(() => parseJobInput(body), (e) => e.statusCode === 400 && re.test(e.message), JSON.stringify(body));
  }
  assert.equal(parseJobInput({ name: 'a', prompt: 'x', target: '1', expr: '*/5 * * * MON-FRI' }, { admin: true }).schedule, '*/5 * * * MON-FRI');
  assert.throws(() => parseJobInput({ name: 'a', prompt: 'x', target: '1', expr: '0 9 * * *; rm -rf' }, { admin: true }), /5 trường/);
  assert.deepEqual(parseJobInput({ name: 'Đổi tên' }, { partial: true }), { name: 'Đổi tên' }, 'sửa lịch nâng cao: không gửi lịch = giữ nguyên');
});

test('việc hẹn giờ nhóm: chỉ sửa phần thành viên viết, giữ chỉ dẫn hệ thống; không cho đổi nơi gửi', async (t) => {
  const { parseJobInput } = await import('./schedules.js');
  const h = home(t, { jobs: [{ id: 'aa11bb22cc33', name: 'Nhắc', prompt: 'Việc hẹn giờ do Lan tạo… không nhắc tới việc hẹn giờ.\n---\nNhắc nộp bài', deliver: 'origin',
    schedule: { kind: 'cron', expr: '0 7 * * 1' }, origin: { platform: 'zalo', chat_id: '555', zalo_scope: 'group', zalo_creator_name: 'Lan' } }] });
  const calls = [];
  const s = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: fakeHermes(h, calls) });
  assert.equal(s.list()[0].prompt, 'Nhắc nộp bài', 'chỉ hiện phần thành viên viết');
  await s.update('aa11bb22cc33', parseJobInput({ prompt: 'Nhắc nộp bài trước 21h' }, { partial: true }));
  assert.deepEqual(calls[0], ['cron', 'edit', 'aa11bb22cc33', '--prompt=Việc hẹn giờ do Lan tạo… không nhắc tới việc hẹn giờ.\n---\nNhắc nộp bài trước 21h']);
  await assert.rejects(s.update('aa11bb22cc33', parseJobInput({ target: '777' }, { partial: true })), (e) => e.statusCode === 400 && /chính nhóm/.test(e.message));
});

test('Hermes từ chối → 400 kèm lý do (không 502); lệnh lỗi mà việc đã được tạo → vẫn báo thành công, không tạo trùng', async (t) => {
  const { parseJobInput } = await import('./schedules.js');
  const h = home(t);
  const s = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: fakeHermes(h, [], { refuse: "Invalid cron expression '0 25 * * *'" }) });
  await assert.rejects(s.update('aa11bb22cc33', parseJobInput({ name: 'Mới' }, { partial: true })), (e) => e.statusCode === 400 && /Lịch chạy không hợp lệ/.test(e.message));
  const calls = [];
  const inner = fakeHermes(h, calls);
  const flaky = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async (f, a) => { await inner(f, a); throw new Error('timeout'); } });
  const made = await flaky.create(parseJobInput({ name: 'Tin sáng mới', prompt: 'x', target: '555', spec: { repeat: 'daily', times: ['06:30'] } }));
  assert.equal(made.name, 'Tin sáng mới');
});

test('Hermes thoát khác 0 (lịch đã qua): đọc lý do trên stdout → 400 dễ hiểu, không phải 502', async (t) => {
  const { parseJobInput } = await import('./schedules.js');
  const h = home(t);
  // `hermes cron` của bản này thoát 1 khi từ chối và in "Failed to … job: <lý do>" ra stdout.
  const refused = (verb, why) => async (file, args) => {
    throw Object.assign(new Error(`Command failed: hermes cron ${verb}`), { stdout: `Failed to ${verb} job: ${why}\n`, stderr: 'cảnh báo cũ\n' });
  };
  const past = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: refused('create', 'Requested one-shot time 2020-01-01T09:00:00+07:00 is more than 120s in the past') });
  await assert.rejects(past.create(parseJobInput({ name: 'Trễ', prompt: 'x', target: '555', spec: { repeat: 'daily', times: ['08:00'] } })),
    (e) => e.statusCode === 400 && /đã qua/.test(e.message), 'lịch đã qua phải là 400 kèm lý do, không phải 502');
  const badCron = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: refused('update', "Invalid cron expression '0 25 * * *': out of range") });
  await assert.rejects(badCron.update('aa11bb22cc33', parseJobInput({ spec: { repeat: 'daily', times: ['08:00'] } }, { partial: true })),
    (e) => e.statusCode === 400 && /không hợp lệ/.test(e.message));
  // Lỗi thật (không có dòng từ chối) vẫn là 502.
  const crash = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async () => { throw Object.assign(new Error('spawn ENOENT'), { stdout: '', stderr: '' }); } });
  await assert.rejects(crash.update('aa11bb22cc33', parseJobInput({ name: 'Mới' }, { partial: true })), (e) => e.statusCode === 502);
});

test('việc một lần đã chạy xong: đặt lại giờ bằng `resume --at`, không dùng `edit --schedule`', async (t) => {
  const { parseJobInput } = await import('./schedules.js');
  const h = home(t, { jobs: [{ id: 'bb11cc22dd33', name: 'Nhắc một lần', prompt: 'Nhắc nộp bài', deliver: 'zalo:555',
    schedule: { kind: 'once', run_at: '2026-10-20T08:00:00+07:00', display: 'once at 2026-10-20 08:00' },
    state: 'completed', enabled: false, repeat: { times: 1, completed: 1 } }] });
  assert.equal(createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: fakeHermes(h, []) }).list()[0].terminal, true, 'nhãn terminal cho việc đã chạy xong');
  const calls = [];
  const s = createSchedules({ hermesHome: h, bin: 'hermes', env: {}, execImpl: async (file, args) => {
    calls.push(args);
    const f = join(h, 'cron', 'jobs.json');
    const data = JSON.parse(readFileSync(f, 'utf8'));
    const j = data.jobs[0];
    if (args[1] === 'resume') { j.schedule = { kind: 'once', run_at: `${args[3].slice(5)}:00+07:00`, display: 'once' }; j.state = 'scheduled'; j.enabled = true; j.repeat.completed = 0; }
    else { for (const a of args.slice(3)) { const k = a.slice(2).split('=')[0]; const v = a.slice(k.length + 3); if (k === 'name') j.name = v; } }
    writeFileSync(f, JSON.stringify(data));
    return { stdout: 'ok' };
  } });
  const view = await s.update('bb11cc22dd33', parseJobInput({ name: 'Nhắc một lần mới', spec: { repeat: 'once', date: '2026-10-24', times: ['09:00'] } }, { partial: true }));
  assert.deepEqual(calls, [['cron', 'edit', 'bb11cc22dd33', '--name=Nhắc một lần mới'], ['cron', 'resume', 'bb11cc22dd33', '--at=2026-10-24T09:00']], 'sửa tên rồi mở lại giờ bằng resume --at');
  assert.equal(view.name, 'Nhắc một lần mới');
  assert.equal(view.spec.times[0], '09:00');
  // Đổi việc một lần đã chạy xong sang lặp lại → 400 nói rõ (Hermes không cho mở lại một việc terminal thành lặp).
  const h2 = home(t, { jobs: [{ id: 'cc11dd22ee33', name: 'Một lần', prompt: 'x', deliver: 'zalo:555',
    schedule: { kind: 'once', run_at: '2026-10-20T08:00:00+07:00' }, state: 'completed', enabled: false, repeat: { times: 1, completed: 1 } }] });
  const s2 = createSchedules({ hermesHome: h2, bin: 'hermes', env: {}, execImpl: fakeHermes(h2, []) });
  await assert.rejects(s2.update('cc11dd22ee33', parseJobInput({ spec: { repeat: 'daily', times: ['08:00'] } }, { partial: true })),
    (e) => e.statusCode === 400 && /đã chạy xong/.test(e.message));
});

test('nơi gửi: đọc mọi đích Zalo (kể cả "origin"), dựng lại deliver giữ đích không phải Zalo; tối đa 10', async () => {
  const { cronTargets, rebuildDeliver, parseJobInput } = await import('./schedules.js');
  const job = { deliver: 'telegram,origin,zalo:777:1,zalo:777', origin: { platform: 'zalo', chat_id: '555' } };
  assert.deepEqual(cronTargets(job), ['555', '777']);
  assert.equal(rebuildDeliver(job, ['777', '999']), 'telegram,zalo:777,zalo:999');
  assert.deepEqual(cronTargets({ deliver: 'origin', origin: { platform: 'telegram', chat_id: '1' } }), []);
  assert.throws(() => parseJobInput({ targets: Array.from({ length: 11 }, (_, i) => String(i + 1)) }, { partial: true }), /tối đa 10/);
  assert.deepEqual(parseJobInput({ targets: ['5', '5', '6'] }, { partial: true }).targets, ['5', '6']);
});
