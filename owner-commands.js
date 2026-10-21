import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

/** Vật mang JSON phẳng (`{…}`) — không nhận mảng. */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Lệnh chủ nhân gõ trong Zalo, chạy đúng câu lệnh tương ứng của Hermes.
 *
 * Chủ nhân nhắn `/new`, `hermes gateway status`, `hermes sessions list`… thì bot
 * chạy lệnh đó trên máy đang chạy bot rồi trả kết quả về đúng hội thoại ấy.
 *
 * Hai mức:
 *   - `main` (chủ nhân chính): mọi lệnh, kể cả nhóm đổi máy — `hermes update`,
 *     `hermes skills install`, `hermes config set`, `hermes profile create`,
 *     `hermes setup`, `hermes gateway start`.
 *   - `owner`: chỉ đọc + tổng hợp (`hermes doctor`, `sessions list`, `gateway
 *     status`, `/reset`, `/clear`, `/memory`, `/remember`, `/skills`…).
 *
 * Mọi thứ khác bị từ chối trước khi chạy — danh sách trắng đúng từng lệnh, không
 * phải "so khớp tiền tố rồi tin tưởng". Bí mật (token bridge, khoá API) bị thay
 * bằng `<đã ẩn>` trước khi chữ đi lên Zalo.
 */

// Lệnh đổi trạng thái máy: chỉ chủ nhân chính.
const DANGEROUS = new Set([
  'update', 'skills-install', 'config-set', 'profile-create', 'setup',
  'gateway-start', 'gateway-setup',
]);

const TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_LIMIT = 3500;

const ANSI = /\u001B\][^\u0007]*\u0007|\u001B\[[0-?]*[ -/]*[@-~]/g;
// Tham số đi thẳng vào argv (không qua shell), nhưng vẫn chỉ nhận ký tự của một
// định danh: tên model, tên profile, mã phiên.
const IDENT = /^[A-Za-z0-9._:/@+~-]+$/;
const MODEL_ID = /^[A-Za-z0-9._:/@+~-]+$/;
const CONFIG_KEY = /^[A-Za-z0-9._-]+$/;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Bỏ chữ xác nhận ở cuối câu (chủ nhân chính phải gõ; xem `confirmed`). */
function stripConfirm(text) {
  return text.replace(/(^|\s)xac([\s_-]*nhan)?\s*$/i, '').trim();
}

/** Danh sách từ của câu đã bỏ dấu: "xác nhận" → "xac nhan". */
function bareWords(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd');
}

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

const USAGE = {
  remember: 'Gõ `/remember <điều cần nhớ>`.',
  model: 'Tên model không hợp lệ (chỉ chữ, số và `._:/@+~-`).',
  skills: 'Cú pháp: `hermes skills search|install|inspect|check|update <tên>`.',
  config: 'Cú pháp: `hermes config set <khoá> <giá trị>` (vd. `hermes config set security.approvals.mode smart`).',
  kick: 'Cú pháp: `/kick <userID>` — nhận UID đầy đủ, hoặc tag thẳng người cần mời ra (tag trước, UID sau).',
};

/**
 * Bỏ chữ tag đứng trước lệnh `/` khi Zalo không gắn tag (uid) cho tin — `@Bot /silent` hay `@Minh Luan /talk`
 * còn nguyên `@` ở đầu vẫn là lệnh chủ nhân, không phải câu trò chuyện. Câu thường có dấu gạch chéo ở giữa
 * (`hermes config set a.b x/y`) thì để nguyên cho bộ phân tích lệnh.
 */
export function stripTagBeforeSlash(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('/') || !text.startsWith('@')) return text;
  const at = text.indexOf(' /');
  return at < 0 ? text : text.slice(at + 1).trimStart();
}

/**
 * Phân tích câu chủ nhân gõ.
 * Trả `{ run }` | `{ usage }` | `null` (không phải lệnh chủ nhân — để Hermes/agent trả lời).
 */
export function parseOwnerCommand(raw) {
  // Đệm: bỏ "@Tên bot" đứng trước; bản Zalo không gắn tag (uid) cho tin thì còn chữ "@Bot" dính liền lệnh.
  const text = stripConfirm(bareWords(stripTagBeforeSlash(clean(raw, 500)).trim()));
  if (!text) return null;
  const words = text.split(/\s+/);
  const first = words[0].toLowerCase();

  if (first.startsWith('/')) {
    const cmd = first.slice(1);
    const args = words.slice(1);
    switch (cmd) {
      case 'silent':
        return { run: { command: 'tag-off', display: '/silent' } };
      case 'talk':
        return { run: { command: 'tag-on', display: '/talk' } };
      case 'shutup':
        return { run: { command: 'pause', display: '/shutup' } };
      case 'new':
      case 'reset':
        return { run: { command: cmd, display: `/${cmd}` } };
      case 'clear':
        return { run: { command: 'new', display: '/clear' } }; // giao diện Zalo không có màn hình để xoá
      case 'stop':
        return { run: { command: 'stop', display: '/stop' } };
      case 'memory':
        return { run: { command: 'memory', display: ['/memory', ...args].join(' ') } };
      case 'remember': {
        const note = text.slice(first.length).trim();
        return note ? { run: { command: 'remember', display: '/remember', note } } : { usage: USAGE.remember };
      }
      case 'outgroup':
        // Rời đúng nhóm đang nhắn — gateway gắn hội thoại nguồn vào khung lệnh.
        return { run: { command: 'outgroup', display: '/outgroup' } };
      case 'kick': {
        // Tag thật (Zalo gắn uid cho tin) do adapter đọc riêng; ở đây chỉ UID viết tay.
        const users = [...new Set(args.filter((word) => /^\d{5,24}$/.test(word)))].slice(0, 10);
        return {
          run: { command: 'kick', display: `/kick${users.length ? ` ${users.join(' ')}` : ''}`, users },
        };
      }
      case 'model': {
        const target = args.join(' ').trim();
        if (!target) return { run: { command: 'model-list', display: '/model' } };
        if (!MODEL_ID.test(target)) return { usage: USAGE.model };
        return { run: { command: 'model-set', display: `/model ${target}`, model: target } };
      }
      case 'skills': {
        const part = args.join(' ').trim();
        const head = (args[0] || 'list').toLowerCase();
        if (head === 'list' || part === '') return { run: { command: 'skills-list', display: '/skills' } };
        if (!['search', 'install', 'inspect', 'check', 'update'].includes(head)) return { usage: USAGE.skills };
        return parseOwnerCommand(`hermes skills ${part}`);
      }
      default:
        return null; // /help, /usage, /whoami… để Hermes tự trả lời.
    }
  }

  if (first !== 'hermes') return null;
  const args = words.slice(1);

  if (args[0] === '--profile' || args[0] === '-p') {
    const name = clean(args[1], 64);
    const rest = args.slice(2);
    if (!PROFILE_NAME.test(name)) return { usage: 'Tên profile không hợp lệ (chữ thường, số, `-`, `_`).' };
    const inner = parseOwnerCommand(['hermes', ...rest].join(' '));
    if (!inner?.run) return { usage: 'Sau `--profile <tên>` chỉ dùng được lệnh chỉ đọc: `hermes doctor`, `status`, `sessions list`, `skills check`, `gateway status`.' };
    return { run: { ...inner.run, display: `hermes --profile ${name} ${rest.join(' ')}`, profile: name } };
  }

  const head = (args[0] || '').toLowerCase();
  const rest = args.slice(1);
  const sub = (index, max = 80) => clean(rest[index], max);

  switch (head) {
    case 'status':
    case 'doctor':
      return { run: { command: head, display: `hermes ${head}` } };

    case 'setup':
      return { run: { command: 'setup', display: 'hermes setup' } };

    case 'update':
      // `hermes update` khởi động lại gateway — chính tiến trình gọi nó, nên phải
      // chạy tách hẳn khỏi cây tiến trình của gateway.
      return { run: { command: 'update', display: 'hermes update', detached: true } };

    case 'model': {
      // `hermes model` là trình chọn tương tác (cần terminal), không chạy được từ
      // đây. `list` thì đọc danh sách model đã cấu hình.
      if (sub(0) === 'list') return { run: { command: 'model-list', display: 'hermes model list' } };
      const target = rest.join(' ').trim();
      if (!target) return { usage: 'Chọn model: `/model <tên>` hoặc `model list`.' };
      if (!MODEL_ID.test(target)) return { usage: USAGE.model };
      return { run: { command: 'model-set', display: `hermes model ${target}`, model: target } };
    }

    case 'sessions': {
      const action = sub(0) || 'list';
      if (action === 'list') {
        const limit = /^\d{1,3}$/.test(sub(1, 3)) ? sub(1, 3) : '20';
        return { run: { command: 'sessions-list', display: `hermes sessions list --limit ${limit}`, limit } };
      }
      if (action === 'resume') {
        return {
          usage: 'Hermes không có `sessions resume`: mở lại phiên là `hermes --resume <id>` trong terminal.\n'
            + 'Xem mã phiên bằng `hermes sessions list`; tách phiên mới cho hội thoại này bằng `/new`.',
        };
      }
      return { usage: 'Chỉ dùng được: `hermes sessions list [số]`.' };
    }

    case 'profile': {
      const action = sub(0);
      if (action === 'list') return { run: { command: 'profile-list', display: 'hermes profile list' } };
      if (action === 'create') {
        const name = sub(1, 64);
        if (!PROFILE_NAME.test(name)) return { usage: 'Cú pháp: `hermes profile create <tên>` (chữ thường, số, `-`, `_`).' };
        return { run: { command: 'profile-create', display: `hermes profile create ${name}`, name } };
      }
      return { usage: 'Chỉ dùng được: `hermes profile list`, `hermes profile create <tên>`.' };
    }

    case 'gateway': {
      const action = sub(0);
      if (action === 'status') return { run: { command: 'gateway-status', display: 'hermes gateway status' } };
      if (action === 'start') return { run: { command: 'gateway-start', display: 'hermes gateway start', detached: true } };
      if (action === 'setup') return { run: { command: 'gateway-setup', display: 'hermes gateway setup' } };
      return { usage: 'Chỉ dùng được: `hermes gateway status`, `hermes gateway start`, `hermes gateway setup`.' };
    }

    case 'skills': {
      const action = sub(0) || 'list';
      const detail = rest.slice(1).join(' ').trim();
      switch (action) {
        case 'list':
          return { run: { command: 'skills-list', display: 'hermes skills list' } };
        case 'check': case 'update': case 'audit': {
          if (detail && !IDENT.test(detail)) return { usage: USAGE.skills };
          return { run: { command: `skills-${action}`, display: `hermes skills ${action}${detail ? ` ${detail}` : ''}`, name: detail } };
        }
        case 'search': case 'inspect': {
          if (!detail) return { usage: USAGE.skills };
          if (!/^[A-Za-z0-9._/@:+~ -]+$/.test(detail)) return { usage: USAGE.skills };
          return { run: { command: `skills-${action}`, display: `hermes skills ${action} ${detail}`, query: detail } };
        }
        case 'install': {
          if (!detail) return { usage: 'Cú pháp: `hermes skills install <tên> [--force]`.' };
          const force = /(^|\s)--force(\s|$)/.test(detail);
          const name = detail.replace(/(^|\s)--force(\s|$)/, ' ').trim();
          if (!IDENT.test(name)) return { usage: 'Tên hoặc link skill không hợp lệ.' };
          return {
            run: {
              command: 'skills-install',
              display: `hermes skills install ${name}${force ? ' --force' : ''}`,
              name, force,
            },
          };
        }
        default:
          return { usage: USAGE.skills };
      }
    }

    case 'config': {
      const action = sub(0);
      const key = sub(1, 120);
      const value = rest.slice(2).join(' ').trim();
      if (action !== 'set' || !CONFIG_KEY.test(key) || !value) return { usage: USAGE.config };
      if (!/^[A-Za-z0-9._/:,-]+$/.test(value)) {
        return { usage: 'Giá trị chỉ nhận chữ, số và `._/:,-`; khoảng trắng phải thay bằng dấu gạch dưới.' };
      }
      return { run: { command: 'config-set', display: `hermes config set ${key} ${value}`, key, value } };
    }

    default:
      return null;
  }
}

/** Chủ nhân đã gõ chữ xác nhận trong cùng câu lệnh chưa: "xác nhận" hoặc "xac-nhan". */
export function confirmed(parsed) {
  return /(^|\s)xac([\s_-]*nhan)?\s*$/i.test(bareWords(parsed?.run?.display));
}

/** Lệnh này có phải nhóm đổi máy/hermes (chỉ chủ nhân chính) không. */
export function commandIsDangerous(parsed) {
  return Boolean(parsed?.run && DANGEROUS.has(parsed.run.command));
}

/**
 * Dựng argv thật. Không dùng shell: mọi tham số đã qua regex ở trên và truyền
 * thành một phần tử argv riêng, nên không có chỗ nào để câu chủ nhân gõ thành
 * một câu lệnh khác.
 */
export function buildArgv(run) {
  const base = run.profile ? ['--profile', run.profile] : [];
  switch (run.command) {
    case 'status': case 'doctor': case 'setup': case 'update':
      return [...base, run.command];
    // `/stop` trong Hermes giết tiến trình nền của phiên (cần phiên đang chạy, không
    // có ở đây). Ngoài Zalo thì phép tương đương là dừng gateway — `hermes pause`
    // chỉ đặt cờ tạm dừng, gateway vẫn sống và vẫn trả lời.
    case 'stop': return [...base, 'gateway', 'stop'];
    case 'model-list': return [...base, 'model', 'list'];
    case 'model-set': return [...base, 'model', run.model];
    case 'sessions-list': return [...base, 'sessions', 'list', '--limit', run.limit];
    case 'profile-list': return [...base, 'profile', 'list'];
    case 'profile-create': return [...base, 'profile', 'create', run.name];
    case 'gateway-status': return [...base, 'gateway', 'status'];
    case 'gateway-start': return [...base, 'gateway', 'start'];
    case 'gateway-setup': return [...base, 'gateway', 'setup'];
    case 'skills-list': return [...base, 'skills', 'list'];
    case 'skills-check': return [...base, 'skills', 'check', ...(run.name ? [run.name] : [])];
    case 'skills-update': return [...base, 'skills', 'update', ...(run.name ? [run.name] : [])];
    case 'skills-audit': return [...base, 'skills', 'audit', ...(run.name ? [run.name] : [])];
    case 'skills-search': return [...base, 'skills', 'search', run.query];
    case 'skills-inspect': return [...base, 'skills', 'inspect', run.query];
    case 'skills-install': return [...base, 'skills', 'install', run.name, ...(run.force ? ['--force'] : []), '--yes'];
    case 'config-set': return [...base, 'config', 'set', run.key, run.value];
    default: throw new Error(`Lệnh không có argv: ${run.command}`);
  }
}

/**
 * Chạy một tiến trình, không qua shell. Gộp stdout+stderr ở người gọi vì CLI
 * của Hermes in tiến trình ra stderr.
 */
export function runProcess(argv, {
  timeoutMs = TIMEOUT_MS, detached = false, cwd = process.cwd(), env = process.env,
  maxBytes = 200_000, spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, stdout, stderr });
    };
    let child;
    try {
      child = spawnImpl(argv[0], argv.slice(1), {
        cwd,
        env,
        detached,
        stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return finish({ code: null, error });
    }
    if (detached) {
      // Tiến trình tự tách khỏi cây của gateway; không có kênh nào nghe mã thoát.
      child.unref?.();
      return finish({ code: 0, pid: child.pid, detached: true });
    }
    const collect = (buffer, chunk) => (buffer + chunk).slice(-maxBytes);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* đã thoát */ }
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* đã thoát */ } }, 3_000);
      kill.unref?.();
      finish({ code: null, error: new Error(`quá ${Math.round(timeoutMs / 1000)} giây`) });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => { clearTimeout(timer); finish({ code: null, error }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code }); });
  });
}

/** Thay bí mật bằng nhãn trước khi chữ đi lên Zalo. */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret ?? '');
    if (value.length >= 8) out = out.split(value).join('<đã ẩn>');
  }
  return out
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '<đã ẩn>')            // token bot Telegram
    .replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat|xoxb|xoxp)[-_][A-Za-z0-9_-]{16,}\b/g, '<đã ẩn>')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<đã ẩn>')
    // Khoá ngẫu nhiên hex dài (token bridge, khoá nội bộ). 32 ký tự hex trở lên
    // là token/chữ ký; git short-SHA (7–12) vẫn đọc được.
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<đã ẩn>');
}

/** Cắt ANSI, gộp stdout/stderr, giới hạn độ dài còn đọc được trên Zalo. */
export function formatOutput({ stdout = '', stderr = '', code = 0, error = null }, { limit = OUTPUT_LIMIT } = {}) {
  const merged = [stdout, stderr].filter((part) => String(part).trim()).join('\n');
  const body = String(merged).replace(ANSI, '').replace(/\r/g, '')
    .split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').trim();
  const status = error ? `⚠️ ${error.message}` : code === 0 ? '' : `⚠️ Mã thoát ${code}`;
  const text = body.length > limit
    ? `${body.slice(0, limit).trimEnd()}\n… (còn nữa — xem đầy đủ trên máy chạy bot)`
    : body;
  if (!text && !status) return '(không có kết quả)';
  return [text, status].filter(Boolean).join('\n\n');
}

/** Giá trị bí mật trong môi trường và trong `.env` của Hermes, để ẩn khỏi kết quả. */
export function secretValues(env = process.env) {
  const values = [];
  for (const [key, value] of Object.entries(env)) {
    if (/(TOKEN|SECRET|KEY|PASSWORD|PASSWD)$/i.test(key)) values.push(value);
  }
  const home = env.HERMES_HOME || '';
  try {
    if (home) {
      for (const line of readFileSync(join(home, '.env'), 'utf8').split('\n')) {
        const match = /^\s*(?:export\s+)?([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD))\s*=\s*(.+)$/i.exec(line);
        if (match) values.push(match[2].trim().replace(/^["']|["']$/g, ''));
      }
    }
  } catch { /* chưa có .env: vẫn ẩn được biến môi trường */ }
  return values.filter((value) => typeof value === 'string' && value.length >= 8);
}

/**
 * Đặt các ô của MỘT nhóm trong `permissions.json` — lệnh `/silent` (`tagged: true`), `/talk` (`tagged: false`) và
 * `/shutup` (`paused: true`). Mọi khoá khác, thư mục và mặc định giữ nguyên; giá trị trùng lớp thư mục/mặc định thì
 * bỏ khoá của nhóm, giống `diffLayer` của dashboard. `resume` (`/silent`, `/talk`) bỏ ô "Tạm dừng" — lệnh gọi lại thì
 * bot nói lại. Ghi nguyên tử rồi chạm mtime để plugin đọc lại ngay.
 */
export function setGroupReplyMode(file, groupId, { tagged = null, paused = null, resume = false, now = () => new Date() } = {}) {
  const id = String(groupId ?? '');
  if (!/^\d{1,32}$/.test(id)) throw new Error('mã nhóm không hợp lệ');
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error(`${basename(file)} hỏng — sửa tệp rồi thử lại: ${err?.message || err}`);
    data = { version: 1, defaults: {}, groups: {} };
  }
  if (!data || typeof data !== 'object' || data.version !== 1) throw new Error(`${basename(file)} không phải phiên bản 1`);
  const groups = isObject(data.groups) ? data.groups : (data.groups = {});
  const entry = isObject(groups[id]) ? groups[id] : {};
  const folder = Object.values(isObject(data.folders) ? data.folders : {})
    .find((f) => isObject(f) && Array.isArray(f.groups) && f.groups.includes(id));
  const next = { ...entry };
  const put = (key, value) => {
    const pick = (layer) => (typeof layer?.[key] === 'boolean' ? layer[key] : undefined);
    const base = pick(folder) ?? pick(data.defaults);
    if (value === base) delete next[key]; else next[key] = value;
  };
  if (tagged !== null) put('replyOnlyTagged', Boolean(tagged));
  if (paused !== null) put('paused', Boolean(paused));
  // Lệnh gọi lại luôn nhả "Tạm dừng", kể cả khi lớp trên đang đặt: `/talk` phải trả lời được ngay.
  if (resume) put('paused', false);
  if (JSON.stringify(next) === JSON.stringify(entry)) return false;
  if (Object.keys(next).some((k) => k !== 'name')) groups[id] = next; else delete groups[id];
  const stamp = now();
  const tmp = `${file}.tmp-cli`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try { utimesSync(file, stamp, stamp); } catch { /* mtime tự tăng khi ghi */ }
  return true;
}


/**
 * Đường dẫn tới CLI Hermes. Thứ tự khớp với cách gateway tự gọi mình
 * (`gateway/run.py::_resolve_hermes_bin`): lệnh do Python chỉ định trước (cùng
 * môi trường ảo đang chạy), rồi mới tới PATH — tránh một `hermes` lạ đứng trước.
 */
export function resolveHermesBin(env = process.env, { pythonPath = null } = {}) {
  if (env.HERMES_BIN && existsSync(env.HERMES_BIN)) return env.HERMES_BIN;
  if (pythonPath && existsSync(pythonPath)) return pythonPath;
  const candidates = [];
  const home = env.HERMES_HOME || '';
  if (home) {
    candidates.push(join(home, 'venv', 'bin', 'hermes'), join(home, 'bin', 'hermes'));
  }
  candidates.push(join(homedir(), '.local', 'bin', 'hermes'), '/usr/local/bin/hermes', '/opt/homebrew/bin/hermes');
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (dir) candidates.push(join(dir, 'hermes'));
  }
  return candidates.find((path) => existsSync(path)) || 'hermes';
}

/**
 * Bọc toàn bộ đường chạy: phân tích → kiểm quyền → chạy → dọn kết quả.
 * Không ném lỗi: mọi trục trặc thành câu trả lời cho chủ nhân.
 */
export function createOwnerCommandRunner({
  /** 'main' | 'owner' */
  role = 'owner',
  hermesBin = null,
  pythonPath = null,
  cwd = process.cwd(),
  env = () => process.env,
  runProcessImpl = runProcess,
  now = () => Date.now(),
} = {}) {
  /** Chạy một lệnh; `roleOverride` cho phép gateway chọn 'main'/'owner' theo từng lượt. */
  return async function runOwnerCommand(rawText, roleOverride = null) {
    const effectiveRole = roleOverride === 'main' || roleOverride === 'owner' ? roleOverride : role;
    // Cờ xác nhận đọc trên câu gốc: `display` đã bị bỏ chữ xác nhận.
    const parsed = parseOwnerCommand(rawText);
    if (!parsed) return null;
    const confirmedByOwner = confirmed({ run: { display: bareWords(rawText) } });
    if (parsed.usage) return { reply: parsed.usage, handled: true, usage: true };
    const { run } = parsed;
    if (effectiveRole !== 'main' && commandIsDangerous(parsed)) {
      return {
        reply: `🔒 \`${run.display}\` đổi cấu hình máy chạy bot nên chỉ chủ nhân chính chạy được.`,
        handled: true, denied: true, display: run.display,
      };
    }
    // Rào cuối cho lệnh đổi máy: chủ nhân chính phải gõ thêm "xác nhận" trong cùng câu.
    // Trợ lý gọi cầu nối không có cách nào tự bật cờ này hộ người dùng.
    if (commandIsDangerous(parsed) && !confirmedByOwner) {
      return {
        reply: `⚠️ \`${run.display}\` đổi cấu hình máy chạy bot (có thể khởi động lại trợ lý).\n`
          + `Gõ lại kèm chữ \`xác nhận\`: \`${run.display} xác nhận\`.`,
        handled: true,
        needsConfirm: true,
        dangerous: true,
        role: effectiveRole,
        display: run.display,
      };
    }

    // Phiên của hội thoại Zalo nằm trong gateway, không phải tiến trình CLI: mở
    // phiên mới bằng cách xoá phiên đang gắn (lần ghi chép kế tiếp tạo phiên mới),
    // rồi để adapter báo Hermes bỏ phiên đã nạp.
    if (run.command === 'new' || run.command === 'reset') {
      const home = env().HERMES_HOME || '';
      const removed = home ? resetZaloSessions(home, { now, quietMs: 120_000 }) : [];
      return {
        reply: removed.length
          ? `🧹 Đã mở phiên mới. Đã xoá ${removed.length} phiên Zalo cũ (${removed.join(', ')}).\n`
            + 'Trí nhớ dài hạn vẫn còn; ngữ cảnh ngắn của hội thoại thì bắt đầu lại.'
          : '🧹 Đã mở phiên mới cho hội thoại này. Trí nhớ dài hạn vẫn còn, ngữ cảnh ngắn thì bắt đầu lại.',
        handled: true,
        newSession: true,
        exitCode: 0,
        display: run.display,
      };
    }

    // `/memory` và `/remember` đọc/ghi kho trí nhớ của Hermes trực tiếp (cùng
    // tệp MEMORY.md/USER.md mà công cụ memory dùng), không qua tiến trình CLI.
    if (run.command === 'memory') {
      return { reply: memoryReport(env().HERMES_HOME || '', run), handled: true, exitCode: 0, display: run.display };
    }
    if (run.command === 'remember') {
      return rememberNote(env().HERMES_HOME || '', run.note);
    }

    const environment = { ...env() };
    const bin = hermesBin || resolveHermesBin(environment, { pythonPath });
    const started = now();
    const result = await runProcessImpl([bin, ...buildArgv(run)], {
      timeoutMs: run.command === 'update' ? UPDATE_TIMEOUT_MS : TIMEOUT_MS,
      detached: Boolean(run.detached),
      cwd,
      env: environment,
    });
    const elapsed = ((now() - started) / 1000).toFixed(1);

    if (run.detached) {
      const failed = result.error ? ` Nhưng không khởi động được: ${result.error.message}` : '';
      return {
        reply: `▶️ Đã chạy \`${run.display}\` ở chế độ nền.${failed}\n`
          + 'Tiến trình này tự khởi động lại trợ lý — bot có thể ngừng trả lời một lúc. Kiểm tra lại bằng `hermes gateway status`.',
        handled: true,
        exitCode: result.error ? null : 0,
        display: run.display,
      };
    }

    const secrets = secretValues(environment);
    const body = formatOutput(
      { ...result, stdout: redactSecrets(result.stdout, secrets), stderr: redactSecrets(result.stderr, secrets) },
    );
    return {
      reply: `\`${run.display}\` → ${elapsed}s\n\n${body}`,
      handled: true,
      exitCode: result.code,
      display: run.display,
    };
  };
}

/** Ghi một dòng vào `.env` của Hermes, giữ nguyên mọi dòng khác. */
export function writeEnvLine(home, key, value) {
  if (!home) return false;
  const file = join(home, '.env');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'm');
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.replace(/\s*$/, '')}${text.trim() ? '\n' : ''}${line}\n`;
  mkdirSync(home, { recursive: true });
  writeFileSync(file, next, 'utf8');
  return true;
}

// ---- Trí nhớ và phiên, đọc/ghi thẳng kho của Hermes -------------------------------------
//
// Định dạng khớp `tools/memory_tool_store.py`: các mục nối bằng "\n§\n", giới hạn
// ký tự lấy từ `memory:` trong config.yaml (mặc định 2200 / 1375), khoá bằng
// `<tệp>.lock` — cùng khoá với Hermes để hai bên không ghi đè lên nhau.

const MEMORY_FILE = { memory: 'MEMORY.md', user: 'USER.md' };
const DELIMITER = '\n§\n';
const MEMORY_CAP = { memory: 2200, user: 1375 };

function memoryLimits(home) {
  const limits = { ...MEMORY_CAP };
  try {
    const text = readFileSync(join(home || '', 'config.yaml'), 'utf8');
    const block = /^memory:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text);
    if (block) {
      for (const target of ['memory', 'user']) {
        const hit = new RegExp(`^[ \\t]+${target}_char_limit:\\s*(\\d+)`, 'm').exec(block[1]);
        if (hit) limits[target] = Number(hit[1]);
      }
    }
  } catch { /* chưa có config: dùng mặc định */ }
  return limits;
}

function memoryFile(home, target) {
  return join(home || '', 'memories', MEMORY_FILE[target] || MEMORY_FILE.memory);
}

/** Tách mục đúng như Hermes: cắt theo đúng dấu phân cách, bỏ mục rỗng. */
export function parseMemoryEntries(raw) {
  return String(raw ?? '').split(DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Ghi nguyên tử qua tệp tạm + đổi tên, có khoá `<tệp>.lock` như Hermes.
 * Hermes đọc lại tệp từ đĩa ở mỗi lượt, nên ghi xong là lượt kế tiếp đã thấy.
 */
function writeMemoryFile(file, entries) {
  mkdirSync(join(file, '..'), { recursive: true });
  const release = withFileLock(`${file}.lock`);
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, entries.join(DELIMITER), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    release();
  }
}

/**
 * `flock` trên POSIX — cùng tệp khoá mà Hermes dùng, nên ghi từ đây và ghi từ
 * công cụ memory không chồng lên nhau. `node:fs` không có `flock`; `fs-ext` là
 * phụ thuộc tuỳ chọn, thiếu thì vẫn ghi (thà hiếm khi chen nhau còn hơn không ghi).
 */
let flockSync = null;
try {
  ({ flockSync } = await import('node:fs-ext').catch(() => ({ flockSync: null })));
} catch { /* không có fs-ext */ }

function withFileLock(lock) {
  let fd = null;
  try { fd = openSync(lock, 'a+', 0o600); } catch { return () => {}; }
  if (flockSync) { try { flockSync(fd, 2 /* LOCK_EX */); } catch { /* không khoá được */ } }
  return () => {
    if (flockSync) { try { flockSync(fd, 8 /* LOCK_UN */); } catch { /* đã giải phóng */ } }
    try { closeSync(fd); } catch { /* đã đóng */ }
  };
}

function readMemoryEntries(home, target) {
  try {
    return parseMemoryEntries(readFileSync(memoryFile(home, target), 'utf8'));
  } catch {
    return [];
  }
}

/** "Đã nhớ những gì" — chỉ đọc, không cầm khoá. */
export function memoryReport(home, { query = '' } = {}) {
  const want = clean(query).toLowerCase();
  const notes = readMemoryEntries(home, 'memory');
  const profile = readMemoryEntries(home, 'user');
  const limits = memoryLimits(home);
  const pick = (list) => (want ? list.filter((entry) => entry.toLowerCase().includes(want)) : list);
  const memory = pick(notes);
  const user = pick(profile);
  const line = (entry) => `• ${entry.replace(/\s*\n\s*/g, ' ').slice(0, 220)}`;
  const size = (list, target) => `${list.join(DELIMITER).length}/${limits[target]} ký tự`;
  return [
    `🧠 Trí nhớ — ${notes.length} mục (${size(notes, 'memory')})${want ? ` · khớp “${query}”: ${memory.length}` : ''}`,
    memory.length ? memory.slice(0, 20).map(line).join('\n') : (want ? '(không mục nào khớp)' : '(đang trống)'),
    `👤 Hồ sơ người dùng — ${profile.length} mục (${size(profile, 'user')})`,
    user.length ? user.slice(0, 15).map(line).join('\n') : '(đang trống)',
    'Thêm bằng `/remember <điều cần nhớ>`. Xoá mục: `/memory <từ khoá>` rồi sửa trong dashboard.',
  ].join('\n\n');
}

/** Thêm một mục vào MEMORY.md theo đúng định dạng khối Hermes dùng. */
export function rememberNote(home, note) {
  const text = clean(note, 500);
  if (!text) return { reply: USAGE.remember, handled: true, usage: true };
  if (!home) return { reply: '⚠️ Chưa biết HERMES_HOME nên không ghi được trí nhớ.', handled: true, exitCode: 1 };
  const entries = readMemoryEntries(home, 'memory');
  if (entries.some((entry) => entry.toLowerCase() === text.toLowerCase())) {
    return { reply: `Mình đã nhớ điều này rồi:\n• ${text}`, handled: true, exitCode: 0, display: '/remember' };
  }
  const limit = memoryLimits(home).memory;
  const next = [...entries, text];
  if (next.join(DELIMITER).length > limit) {
    const used = entries.join(DELIMITER).length;
    return {
      reply: `⚠️ Trí nhớ đã ${used}/${limit} ký tự, thêm "${text.slice(0, 80)}" sẽ vượt giới hạn nên chưa ghi.\n`
        + 'Xem `/memory` rồi xoá bớt mục cũ (dashboard › Trí nhớ) hoặc nâng `memory.memory_char_limit` trong config.yaml.',
      handled: true, exitCode: 1, display: '/remember',
    };
  }
  writeMemoryFile(memoryFile(home, 'memory'), next);
  return {
    reply: `🧠 Đã ghi vào trí nhớ dài hạn — ${next.length} mục (${next.join(DELIMITER).length}/${limit} ký tự):\n• ${text}`,
    handled: true, exitCode: 0, display: '/remember',
  };
}

/**
 * Xoá phiên Zalo trong `<HERMES_HOME>/sessions` để lần chạy sau mở phiên mới.
 * `quietMs`: bỏ qua phiên vừa ghi trong khoảng đó — phiên đang chạy của chính
 * lượt này không bị xoá.
 */
export function resetZaloSessions(home, { now = Date.now, quietMs = 0 } = {}) {
  const dir = join(home || '', 'sessions');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!/zalo/i.test(name)) continue;
    const path = join(dir, name);
    try {
      if (quietMs && now() - statSync(path).mtimeMs < quietMs) continue;
      rmSync(path, { force: true, recursive: true });
      removed.push(name);
    } catch { /* đang mở hoặc không phải tệp phiên: bỏ qua */ }
  }
  return removed;
}
