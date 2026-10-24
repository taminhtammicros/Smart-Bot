/**
 * Lịch hẹn (spec §18.4): việc hẹn giờ của Hermes (`<HERMES_HOME>/cron/jobs.json`) có gửi kết quả về Zalo —
 * cả việc của chủ nhân lẫn "hẹn giờ cho nhóm" (`origin.zalo_scope = "group"`, tạo bằng `zalo_group_cron`).
 * Đọc thẳng jobs.json (Hermes ghi bằng đổi tên nguyên tử). Tạm dừng / chạy lại / xoá KHÔNG sửa tệp: chạy lệnh
 * `hermes cron pause|resume|remove <id>` của chính Hermes (giữ khoá `.jobs.lock`), chỉ với việc thuộc Zalo.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromSchedule, toSchedule } from '../public/schedule-spec.js';

export const JOB_ID = /^[0-9a-f]{6,32}$/;
export const CRON_ACTIONS = ['pause', 'resume', 'remove'];

const short = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Hội thoại Zalo mà việc gửi kết quả về (như `_cron_target` của plugin); rỗng = không thuộc Zalo. */
export function cronTarget(job) {
  for (const part of String(job?.deliver ?? '').split(',')) {
    const p = part.trim();
    if (p.startsWith('zalo:')) return p.slice(5).split(':')[0];
  }
  const o = job?.origin;
  return o && typeof o === 'object' && o.platform === 'zalo' ? String(o.chat_id ?? '') : '';
}

/**
 * Mọi hội thoại Zalo việc gửi kết quả tới (Hermes nhận nhiều nơi gửi cách nhau bằng dấu phẩy và gửi cùng một kết
 * quả tới tất cả). "origin" của việc tạo từ Zalo = hội thoại gốc. Không trùng, giữ thứ tự.
 */
export function cronTargets(job) {
  const out = [];
  const o = job?.origin && typeof job.origin === 'object' ? job.origin : {};
  for (const part of String(job?.deliver ?? '').split(',')) {
    const p = part.trim();
    const id = p.startsWith('zalo:') ? p.slice(5).split(':')[0] : p === 'origin' && o.platform === 'zalo' ? String(o.chat_id ?? '') : '';
    if (/^\d{1,32}$/.test(id) && !out.includes(id)) out.push(id);
  }
  if (!out.length && o.platform === 'zalo' && /^\d{1,32}$/.test(String(o.chat_id ?? ''))) out.push(String(o.chat_id));
  return out;
}

/** deliver mới: giữ nơi gửi không thuộc Zalo (telegram…), thay toàn bộ phần Zalo bằng `targets`. */
export function rebuildDeliver(job, targets) {
  const o = job?.origin && typeof job.origin === 'object' ? job.origin : {};
  const keep = String(job?.deliver ?? '').split(',').map((p) => p.trim())
    .filter((p) => p && !p.startsWith('zalo:') && !(p === 'origin' && o.platform === 'zalo'));
  return [...keep, ...targets.map((t) => `zalo:${t}`)].join(',');
}

// Việc hẹn giờ nhóm (plugin `_group_cron_prompt`): "<chỉ dẫn hệ thống>\n---\n<nội dung thành viên viết>".
// Dashboard chỉ cho sửa phần sau dấu tách; khi ghi tự bọc lại phần chỉ dẫn cũ.
export const GROUP_PROMPT_SEPARATOR = '\n---\n';
const MAX_PROMPT = 2000;

function editablePrompt(job, group) {
  const raw = String(job?.prompt ?? '');
  if (!group) return raw;
  const at = raw.indexOf(GROUP_PROMPT_SEPARATOR);
  return at >= 0 ? raw.slice(at + GROUP_PROMPT_SEPARATOR.length) : raw;
}

/** Các việc thuộc Zalo, dạng an toàn để hiện (không có đường dẫn script, model, khoá…). */
export function zaloJobs(data) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.filter((j) => j && JOB_ID.test(String(j.id ?? '')) && cronTarget(j)).map((j) => {
    const o = j.origin && typeof j.origin === 'object' ? j.origin : {};
    const group = o.zalo_scope === 'group';
    const prompt = editablePrompt(j, group);
    return {
      // `prompt`: nguyên văn phần sửa được (không cắt, không gộp dòng) — biểu mẫu gửi lại đúng như cũ nếu không sửa.
      id: String(j.id), name: short(j.name, 120), prompt: prompt.slice(0, MAX_PROMPT), promptPreview: short(prompt, 200),
      schedule: short(j.schedule_display || j.schedule?.display || j.schedule?.expr, 80),
      // Lịch bằng lời thường cho biểu mẫu / lịch tuần; null = lịch nâng cao (khoảng lặp, cron phức tạp).
      spec: fromSchedule(j.schedule), expr: short(j.schedule?.expr || '', 80),
      enabled: j.enabled !== false, paused: j.state === 'paused' || Boolean(j.paused_at),
      nextRunAt: j.next_run_at ? Date.parse(j.next_run_at) || null : null,
      lastRunAt: j.last_run_at ? Date.parse(j.last_run_at) || null : null,
      lastStatus: short(j.last_status, 20), target: cronTarget(j), targets: cronTargets(j),
      // `terminal`: việc một lần đã chạy xong (state completed/error) — Hermes không cho sửa giờ trực tiếp, phải
      // "chạy lại" (`cron resume --at`). `scheduleKind`: 'once' | 'cron' | 'interval' — biết lịch có phải một lần không.
      terminal: (j.state === 'completed' || j.state === 'error') && j.schedule?.kind === 'once',
      scheduleKind: short(j.schedule?.kind || '', 20),
      kind: group ? 'group' : 'owner',
      creatorName: group ? short(o.zalo_creator_name, 80) : '',
    };
  });
}

function readRaw(hermesHome) {
  const file = join(hermesHome, 'cron', 'jobs.json');
  if (!existsSync(file)) return { jobs: [] };
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function readZaloJobs(hermesHome) {
  return zaloJobs(readRaw(hermesHome));
}

/** Đường tới lệnh `hermes`: ZALO_HERMES_BIN → `<HERMES_HOME>/bin/hermes(.exe)` (bản cài Windows) → `hermes` trên PATH. */
export function hermesBin({ hermesHome, env = process.env, platform = process.platform, exists = existsSync }) {
  if (env.ZALO_HERMES_BIN) return env.ZALO_HERMES_BIN;
  const bundled = join(hermesHome, 'bin', platform === 'win32' ? 'hermes.exe' : 'hermes');
  return exists(bundled) ? bundled : 'hermes';
}

const defaultExec = (file, args, opts) => new Promise((resolve, reject) => {
  // Giữ CẢ stdout lẫn stderr khi lỗi: Hermes thoát khác 0 vẫn in lý do từ chối ra stdout — mất nó thì dashboard
  // chỉ còn câu 502 chung thay vì nói đúng người dùng phải sửa gì.
  execFile(file, args, opts, (e, stdout, stderr) => (e
    ? reject(Object.assign(e, { stdout: String(stdout || ''), stderr: String(stderr || '') }))
    : resolve({ stdout: String(stdout) })));
});

const RAW_CRON = /^[\w*,/-]+( [\w*,/-]+){4}$/;
// Ký tự điều khiển (trừ xuống dòng/tab) và ký tự vô hình Hermes chặn trong prompt (`_scan_cron_prompt`).
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/;
const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * Kiểm + chuẩn hoá thân tạo/sửa. Tạo (`partial` false): đủ tên, việc bot làm, nơi gửi, lịch. Sửa (`partial` true):
 * trường nào không gửi là giữ nguyên (kéo thả chỉ gửi `spec`). Lịch từ dạng thường (`spec`) hoặc, chỉ Quản trị, cron
 * gốc (`expr`). Trả { name?, prompt?, target?, schedule? }.
 */
export function parseJobInput(body, { admin = false, partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = String(b.name ?? '').replace(/\s+/g, ' ').trim();
    if (!out.name || out.name.length > 120 || BAD_CHARS.test(out.name)) throw bad('Đặt tên cho lịch hẹn (tối đa 120 ký tự).');
  }
  if (!partial || b.prompt !== undefined) {
    out.prompt = String(b.prompt ?? '').replace(/\r\n/g, '\n').trim();
    if (!out.prompt || out.prompt.length > MAX_PROMPT) throw bad(`Ghi việc bot cần làm (tối đa ${MAX_PROMPT} ký tự).`);
    if (BAD_CHARS.test(out.prompt)) throw bad('Nội dung có ký tự ẩn (thường do dán từ nơi khác) — gõ lại hoặc dán dạng chữ thường.');
  }
  // Nơi gửi: `targets` (nhiều nơi, tối đa 10) hoặc `target` (một nơi — bản cũ).
  if (!partial || b.targets !== undefined || b.target !== undefined) {
    const list = Array.isArray(b.targets) ? b.targets : b.target !== undefined && b.target !== '' ? [b.target] : [];
    out.targets = [...new Set(list.map((x) => String(x ?? '').trim()))];
    if (!out.targets.length || out.targets.some((x) => !/^\d{1,32}$/.test(x))) throw bad('Chọn nhóm hoặc người nhận.');
    if (out.targets.length > 10) throw bad('Gửi tối đa 10 nơi cho một lịch hẹn.');
  }
  if (b.spec) {
    try { out.schedule = toSchedule(b.spec); } catch (e) { throw bad(e.message); }
  } else if (admin && typeof b.expr === 'string' && b.expr.trim()) {
    if (!RAW_CRON.test(b.expr.trim())) throw bad('Cron gốc phải có 5 trường: phút giờ ngày tháng thứ.');
    out.schedule = b.expr.trim();
  } else if (!partial) throw bad('Chọn lịch chạy.');
  return out;
}

const isOnce = (schedule) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(schedule));
/** Lịch đã lưu khớp chuỗi lịch vừa gửi: cron so đúng nguyên chuỗi; một lần so ngày giờ (Hermes thêm giây + múi giờ). */
function sameSchedule(raw, schedule) {
  const sch = raw?.schedule || {};
  if (isOnce(schedule)) return sch.kind === 'once' && String(sch.run_at || '').startsWith(`${schedule}:`);
  return String(sch.expr || '') === schedule;
}

export function createSchedules({ hermesHome, bin, execImpl = defaultExec, env = process.env }) {
  const fail = () => Object.assign(new Error('Trợ lý chưa làm được việc này — tải lại trang xem trạng thái, rồi thử lại sau ít phút; nếu vẫn lỗi hãy báo người cài đặt.'), { statusCode: 502 });
  const rawJob = (id) => (readRaw(hermesHome).jobs || []).find((j) => String(j?.id) === String(id));
  /**
   * Chạy `hermes cron …` (không qua shell). Hermes có thể thoát 0 HOẶC khác 0 khi từ chối — dòng
   * "Failed to … job: <lý do>" là lỗi người dùng sửa được (lịch đã qua, cron sai, việc đã chạy xong…) → 400 kèm lý do
   * thật. Chỉ khi KHÔNG có dòng từ chối nào mới coi là sự cố bên trong → `fail()` (502).
   */
  async function run(args, label) {
    let out;
    try {
      out = await execImpl(bin, ['cron', ...args], { windowsHide: true, timeout: 30_000, env: { ...env, HERMES_HOME: hermesHome } });
    } catch (e) {
      // Hermes thoát khác 0 cho cả lỗi người dùng sửa được: đọc stdout/stderr trước khi coi là sự cố.
      const why = refusalIn(`${e?.stdout ?? ''}\n${e?.stderr ?? ''}`);
      if (why !== undefined) refuse(label, why);
      console.error('[dashboard] hermes cron', label, 'lỗi:', e.message, e.stderr?.slice(0, 300));
      return false;
    }
    const why = refusalIn(out?.stdout);
    if (why !== undefined) refuse(label, why);
    return true;
  }
  /** Dòng "Failed to <động từ> job: <lý do>" (hoặc "Blocked") trong kết quả Hermes; undefined = không có. */
  function refusalIn(text) {
    const m = /^\s*(?:Failed to \w+ job|Blocked)[:\s]*(.*)$/m.exec(String(text ?? ''));
    return m ? m[1].trim() : undefined;
  }
  /** Lý do Hermes từ chối → câu 400 dễ hiểu (ném), để người dùng biết phải sửa gì. */
  function refuse(label, why) {
    console.error('[dashboard] hermes cron', label, 'từ chối:', why.slice(0, 300));
    if (/in the past/i.test(why)) throw bad('Thời điểm này đã qua — chọn ngày giờ sau bây giờ.');
    if (/invalid cron|out of range|not acceptable/i.test(why)) throw bad('Lịch chạy không hợp lệ — kiểm lại giờ, ngày.');
    if (/terminal cron job/i.test(why)) throw bad('Việc một lần này đã chạy xong nên không tạm dừng/chạy lại kiểu thường được — sửa lại lịch (chọn ngày giờ mới) để mở lại.');
    throw bad(`Trợ lý không nhận lịch này: ${why.slice(0, 200) || 'kiểm lại ngày giờ'}.`);
  }
  return {
    list: () => readZaloJobs(hermesHome),
    /** Tạo việc mới gửi về Zalo. Trả việc vừa tạo (đọc lại từ jobs.json — kể cả khi lệnh lỗi/hết giờ, để không tạo trùng). */
    async create(input) {
      const before = new Set((readRaw(hermesHome).jobs || []).map((j) => String(j?.id)));
      // "--" trước đối số vị trí: việc bot làm bắt đầu bằng "-" không bị hiểu thành tuỳ chọn.
      const ran = await run(['create', `--name=${input.name}`, `--deliver=${input.targets.map((t) => `zalo:${t}`).join(',')}`, '--', input.schedule, input.prompt], 'create');
      const raw = (readRaw(hermesHome).jobs || []).find((j) => !before.has(String(j?.id)) && j.name === input.name && sameSchedule(j, input.schedule));
      const made = raw && readZaloJobs(hermesHome).find((j) => j.id === String(raw.id));
      if (!made) { console.error('[dashboard] hermes cron create', ran ? 'thoát 0 nhưng không thấy việc mới' : 'lỗi'); throw fail(); }
      return made;
    },
    /**
     * Sửa một việc thuộc Zalo — CHỈ gửi trường thật sự đổi (kéo thả chỉ đổi lịch). Việc nhóm: giữ phần chỉ dẫn hệ thống
     * trong prompt, không cho đổi nơi gửi. Đổi giữa "một lần" và "lặp lại" thì chỉnh số lần chạy cho khớp.
     */
    async update(id, input) {
      const job = readZaloJobs(hermesHome).find((j) => j.id === id);
      const raw = job && rawJob(id);
      if (!JOB_ID.test(String(id)) || !job || !raw) throw Object.assign(new Error('Không tìm thấy việc hẹn giờ này — tải lại trang.'), { statusCode: 404 });
      const group = job.kind === 'group';
      const args = ['edit', id];
      if (input.name !== undefined && input.name !== job.name) args.push(`--name=${input.name}`);
      let prompt;
      if (input.prompt !== undefined && input.prompt !== job.prompt.trim()) {
        if (group) {
          const at = String(raw.prompt ?? '').indexOf(GROUP_PROMPT_SEPARATOR);
          prompt = at >= 0 ? `${String(raw.prompt).slice(0, at)}${GROUP_PROMPT_SEPARATOR}${input.prompt}` : input.prompt;
        } else prompt = input.prompt;
        args.push(`--prompt=${prompt}`);
      }
      // Việc một lần ĐÃ CHẠY XONG (terminal): Hermes từ chối `edit --schedule` (không cho tự kích hoạt lại).
      // Đặt lại giờ bằng `cron resume <id> --at <giờ>` — đúng đường Hermes chỉ.
      const terminal = Boolean(job.terminal) && raw.schedule?.kind === 'once';
      let rearm;
      if (input.schedule !== undefined && !sameSchedule(raw, input.schedule)) {
        if (terminal) {
          if (!isOnce(input.schedule)) throw bad('Việc một lần đã chạy xong chỉ đặt lại được một mốc giờ một lần — chọn lại "Một lần".');
          rearm = input.schedule;
        } else {
          args.push(`--schedule=${input.schedule}`);
          const wasOnce = raw.schedule?.kind === 'once';
          const completed = Number(raw.repeat?.completed) || 0;
          if (wasOnce && !isOnce(input.schedule)) args.push('--repeat=0');            // lặp mãi
          else if (!wasOnce && isOnce(input.schedule)) args.push(`--repeat=${completed + 1}`); // chạy đúng một lần nữa
        }
      }
      const sameTargets = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (input.targets !== undefined && !sameTargets(input.targets, job.targets)) {
        if (group) throw bad('Việc do thành viên nhóm tạo chỉ gửi vào chính nhóm đó — muốn gửi nơi khác hãy tạo lịch hẹn mới.');
        args.push(`--deliver=${rebuildDeliver(raw, input.targets)}`);
      }
      if (args.length === 2 && rearm === undefined) return job; // không có gì đổi
      // Sửa tên/việc/nơi gửi chạy trước (Hermes vẫn cho trên việc đã chạy xong); rồi mới mở lại giờ.
      if (args.length > 2 && !(await run(args, `edit ${id}`))) throw fail();
      if (rearm !== undefined && !(await run(['resume', id, `--at=${rearm}`], `resume ${id}`))) throw fail();
      const after = rawJob(id);
      const view = readZaloJobs(hermesHome).find((j) => j.id === id);
      const ok = after && view && (input.name === undefined || view.name === input.name)
        && (input.schedule === undefined || sameSchedule(after, input.schedule))
        && (prompt === undefined || String(after.prompt) === prompt)
        && (input.targets === undefined || sameTargets(view.targets, input.targets));
      if (!ok) { console.error('[dashboard] hermes cron edit', id, 'thoát 0 nhưng jobs.json không đổi như mong đợi'); throw fail(); }
      return view;
    },
    /** Chỉ việc thuộc Zalo; id đã kiểm; lệnh cố định, không qua shell. */
    async cron(action, id) {
      if (!CRON_ACTIONS.includes(action)) throw Object.assign(new Error('Thao tác không hợp lệ — tải lại trang.'), { statusCode: 400 });
      const job = readZaloJobs(hermesHome).find((j) => j.id === id);
      if (!JOB_ID.test(String(id)) || !job) throw Object.assign(new Error('Không tìm thấy việc hẹn giờ này — tải lại trang.'), { statusCode: 404 });
      let out;
      try {
        out = await execImpl(bin, ['cron', action, id], { windowsHide: true, timeout: 30_000, env: { ...env, HERMES_HOME: hermesHome } });
      } catch (e) {
        // Khi lệnh thoát khác 0 vì lý do người dùng sửa được (việc đã chạy xong…), Hermes in dòng "Failed to
        // <action> job: <lý do>" ra stdout — map sang 400 kèm lý do thật thay vì 502 chung.
        const why = refusalIn(`${e?.stdout ?? ''}\n${e?.stderr ?? ''}`);
        if (why !== undefined) refuse(`${action} ${id}`, why);
        console.error('[dashboard] hermes cron', action, id, 'lỗi:', e.message, e.stderr?.slice(0, 300));
        throw fail();
      }
      // `hermes cron` có thể thoát 0 kèm chữ báo lỗi → vẫn kiểm lại chữ báo và trạng thái thật trong jobs.json.
      const refusedText = /^\s*Failed to (?:pause|resume|remove) job[:\s]*(.*)$/m.exec(String(out?.stdout ?? ''));
      if (refusedText) refuse(`${action} ${id}`, refusedText[1].trim());
      let after;
      try { after = readZaloJobs(hermesHome).find((j) => j.id === id); } catch { after = undefined; }
      const ok = action === 'remove' ? !after : Boolean(after) && after.paused === (action === 'pause');
      if (!ok) {
        console.error('[dashboard] hermes cron', action, id, 'thoát 0 nhưng jobs.json không đổi như mong đợi');
        throw fail();
      }
      return job;
    },
  };
}
