import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv, waitSpawned } from './spawn-detached.js';

const execFileP = promisify(execFile);
const defaultExec = (file, args, opts) => execFileP(file, args, opts);

// Tìm PID đang LISTEN đúng cổng từ đầu ra `netstat -ano -p tcp`.
function findListenerPid(stdout, port) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP$/i.test(cols[0])) continue;
    const [, local, , state, pid] = cols;
    if (state !== 'LISTENING' || !local.endsWith(`:${port}`)) continue;
    const n = Number(pid);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

// Giải phóng cổng: chỉ kill đúng PID đang LISTEN trên cổng đó (không kill theo tên, không kill chính mình).
export async function freeListenerPort({
  port, execImpl = defaultExec, ownPid = process.pid,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const listenerPid = async () => {
    const { stdout } = await execImpl('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
    return findListenerPid(stdout, port);
  };
  const pid = await listenerPid();
  if (!pid || pid === ownPid) return;
  await execImpl('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
  for (let i = 0; i < 12; i++) { // chờ tối đa ~3 giây cho cổng được nhả
    await sleepImpl(250);
    if (!(await listenerPid())) return;
  }
}

/**
 * `systemctl restart` chạy tới khi xong và xét mã thoát: dịch vụ không tồn tại / thiếu quyền
 * thì báo lỗi thật thay vì "đã gửi lệnh". stderr chỉ ghi ra log, không đưa lên giao diện.
 */
export async function systemctlRestart({ service, envVar, execImpl = defaultExec }) {
  try {
    await execImpl('systemctl', ['restart', service], { windowsHide: true, timeout: 90_000 });
  } catch (err) {
    console.error(`[restart] systemctl restart ${service} thất bại (mã ${err?.code ?? '?'}):`, String(err?.stderr || err?.message || err).trim());
    throw new Error(`Không khởi động lại được dịch vụ ${service} — kiểm tra "systemctl status ${service}" trên máy chủ, hoặc đặt ${envVar} trong .env của bot thành lệnh khởi động lại đúng cho máy này.`);
  }
}

export function makeRestartSidecar({
  cmd, platform = process.platform, sidecarRoot, port = 3872,
  spawnImpl = spawn, execImpl = defaultExec, ownPid = process.pid,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const opts = { detached: true, windowsHide: true, stdio: 'ignore' };
  const freePort = () => freeListenerPort({ port, execImpl, ownPid, sleepImpl });

  return async () => {
    // Chỉ Linux mới có systemctl để khởi động lại dịch vụ (chờ tới khi xong và xét mã thoát).
    // Windows/macOS không có systemctl: tự chạy lại tiến trình theo kiểu "spawn là xong".
    if (!cmd && platform === 'linux') {
      await systemctlRestart({ service: 'zalo-bridge', envVar: 'ZALO_SIDECAR_RESTART_CMD', execImpl });
      return;
    }
    let child;
    if (cmd) child = spawnImpl(cmd, { ...opts, shell: true, env: childEnv() });
    else {
      // netstat/taskkill chỉ có trên Windows. macOS thì tiến trình đã chết nên cổng đã nhả — spawn thẳng.
      if (platform === 'win32') await freePort().catch((e) => console.warn('[restart] không giải phóng được cổng:', e.message));
      child = spawnImpl(process.execPath, ['server.js'], { ...opts, cwd: sidecarRoot, env: childEnv() });
    }
    await waitSpawned(child);
  };
}
