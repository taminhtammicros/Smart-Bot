export function createRuntimeHealth({ store, now = Date.now, staleAfterMs = 45_000 } = {}) {
  if (!store) throw new Error('Runtime health requires a store');
  const startedAtMs = Number(now());
  const clients = new Map();
  const backfill = new Map();
  let zalo = { status: 'idle', userId: null, displayName: null };
  // Đăng nhập xong chưa chắc đã nghe được tin: listener có thể đứt riêng.
  // null = chưa có ai báo (không tính vào sức khoẻ).
  let listener = null;
  // Zalo đá phiên (mã 3000/3003): nối lại vô ích, cần quét QR đăng nhập lại.
  let needsRelogin = false;
  let lastInboundAtMs = null;
  let lastOutboundAtMs = null;
  let lastError = null;

  function setZaloState(status, profile = {}) {
    zalo = {
      status: String(status || 'idle'),
      userId: profile.userId == null ? null : String(profile.userId),
      displayName: profile.displayName == null ? null : String(profile.displayName),
    };
    if (zalo.status === 'logged-in') needsRelogin = false;
  }

  function setNeedsRelogin(flag) {
    needsRelogin = Boolean(flag);
  }

  function setListenerState(state) {
    listener = state == null ? null : String(state);
  }

  function bridgeConnected(clientId) {
    const timestamp = Number(now());
    clients.set(String(clientId), { connectedAtMs: timestamp, lastHeartbeatAtMs: timestamp });
  }

  function bridgeHeartbeat(clientId) {
    const key = String(clientId);
    const prior = clients.get(key) || { connectedAtMs: Number(now()) };
    clients.set(key, { ...prior, lastHeartbeatAtMs: Number(now()) });
  }

  function bridgeDisconnected(clientId) {
    clients.delete(String(clientId));
  }

  function staleClientIds() {
    const current = Number(now());
    return [...clients.entries()]
      .filter(([, state]) => current - state.lastHeartbeatAtMs > staleAfterMs)
      .map(([clientId]) => clientId)
      .sort();
  }

  function setBackfill(state) {
    if (!state || state.threadType == null) return;
    backfill.set(Number(state.threadType), {
      threadType: Number(state.threadType),
      status: String(state.status || 'idle'),
      pagesFetched: Number(state.pagesFetched) || 0,
      messagesInserted: Number(state.messagesInserted) || 0,
      updatedAtMs: Number(now()),
    });
  }

  function recordError(code, _sensitiveMessage = '') {
    lastError = {
      code: String(code || 'runtime_error'),
      message: 'Đã ghi nhận lỗi nội bộ; xem log cục bộ để biết chi tiết.',
      atMs: Number(now()),
    };
  }

  function snapshot() {
    let database;
    try {
      database = store.getHealth();
    } catch {
      database = { ready: false, databaseSizeBytes: 0, messageCount: 0, auditCount: 0 };
    }
    const stale = staleClientIds();
    const heartbeatTimes = [...clients.values()].map((state) => state.lastHeartbeatAtMs);
    const latestHeartbeat = heartbeatTimes.length ? Math.max(...heartbeatTimes) : null;
    const brain = database.brain || { pendingTopics: 0, pendingFacts: 0, stuckThreads: 0, lagMs: 0 };
    let status = 'healthy';
    if (!database.ready) status = 'unhealthy';
    else if (
      zalo.status !== 'logged-in'
      || (listener != null && listener !== 'connected')
      || clients.size === 0
      || stale.length
      || needsRelogin
    ) status = 'degraded';
    // Kẹt học: còn tồn đọng mà mốc tiến độ không nhích quá 30 phút. Đây chính là trạng thái âm thầm
    // của sự cố 23/10 — bot vẫn "khoẻ" theo mọi chỉ số khác nhưng không học thêm gì.
    else if (brain.stuckThreads > 0) status = 'degraded';

    return {
      status,
      uptimeMs: Math.max(0, Number(now()) - startedAtMs),
      zalo: { ...zalo, listener, needsRelogin },
      bridge: {
        attachedClients: clients.size,
        heartbeatAgeMs: latestHeartbeat == null ? null : Math.max(0, Number(now()) - latestHeartbeat),
        staleClients: stale.length,
      },
      database,
      backfill: [...backfill.values()].sort((left, right) => left.threadType - right.threadType),
      traffic: { lastInboundAtMs, lastOutboundAtMs },
      // Tồn đọng tầng não, đọc từ `store.getHealth()`. Nhô lên cấp cao nhất để `/api/health` trả thẳng
      // và dashboard cảnh báo được mà không phải chui vào `database`.
      brain: database.brain || { pendingTopics: 0, pendingFacts: 0, stuckThreads: 0, lagMs: 0 },
      lastError,
    };
  }

  return {
    setZaloState,
    setListenerState,
    setNeedsRelogin,
    bridgeConnected,
    bridgeHeartbeat,
    bridgeDisconnected,
    staleClientIds,
    markInbound: () => { lastInboundAtMs = Number(now()); },
    markOutbound: () => { lastOutboundAtMs = Number(now()); },
    setBackfill,
    recordError,
    snapshot,
    // Đọc nhẹ (không chạm SQLite như snapshot) cho các chỗ hỏi mỗi giây.
    zaloSession: () => ({ status: zalo.status, listener, needsRelogin }),
  };
}
