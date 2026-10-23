import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { childEnv, waitSpawned } from './spawn-detached.js';
import { systemctlRestart } from './restart.js';

const execFileP = promisify(execFile);
const defaultExec = (file, args, opts) => execFileP(file, args, opts);

// Khởi động lại trợ lý Hermes. Windows: tuyệt đối không chạy Hermes-Online.vbs (nó bật hộp thoại).
export function makeRestartAssistant({
  cmd, platform = process.platform, hermesHome,
  spawnImpl = spawn, execImpl = defaultExec, existsImpl = existsSync,
  retryDelayMs = 5000, maxRetries = 10,
}) {
  const opts = { detached: true, windowsHide: true, stdio: 'ignore' };
  return async () => {
    // Chỉ Linux mới có systemctl để khởi động lại dịch vụ (chờ tới khi xong và xét mã thoát).
    // Windows/macOS KHÔNG có systemctl — trước đây điều kiện là `platform !== 'win32'` nên macOS rơi vào nhánh
    // systemctl, lệnh luôn thất bại và gateway đã dừng thì KHÔNG bao giờ được dựng lại (bấm "Khởi động lại" hay
    // đổi cài đặt cần khởi động lại → bot chết tới khi có người chạy tay). Cùng cách viết với makeRestartSidecar.
    if (!cmd && platform === 'linux') {
      await systemctlRestart({ service: 'hermes-gateway', envVar: 'ZALO_ASSISTANT_RESTART_CMD', execImpl });
      return;
    }
    let child;
    if (cmd) child = spawnImpl(cmd, { ...opts, shell: true, env: childEnv() });
    else {
      const bundled = join(hermesHome, 'bin', 'hermes.exe');
      const exe = existsImpl(bundled) ? bundled : 'hermes';
      await execImpl(exe, ['gateway', 'stop'], { windowsHide: true, timeout: 30_000 })
        .catch((e) => console.warn('[restart] hermes gateway stop lỗi, vẫn chạy lại:', e.message));
      // Hermes mới giữ khoá "mỗi máy một gateway": gateway cũ vừa nhận lệnh stop có thể chưa nhả khoá, gateway mới
      // thoát ngay với mã 75 ("A gateway already owns this host") → đợi một chút rồi chạy lại, có giới hạn số lần.
      const start = (attempt) => {
        const c = spawnImpl(exe, ['gateway', 'run', '--accept-hooks'], { ...opts, cwd: hermesHome, env: childEnv() });
        c.on?.('exit', (code) => {
          if (code !== 75 || attempt >= maxRetries) return;
          setTimeout(() => waitSpawned(start(attempt + 1)).catch((e) => console.warn('[restart] chạy lại gateway lỗi:', e.message)), retryDelayMs);
        });
        return c;
      };
      child = start(0);
    }
    await waitSpawned(child);
  };
}
