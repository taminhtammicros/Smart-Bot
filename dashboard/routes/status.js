import express from 'express';
import { requireAuth } from '../lib/http-guards.js';
import { startOfDayVN } from '../lib/store-reader.js';
import { fallbackName } from '../lib/thread-names.js';

export function statusRoutes({ sidecar, linker, store, threadNames, health = null, botUses = null, aiEvents = null, now = Date.now }) {
  // Số đo máy chủ mới nhất (đã có sẵn trong bộ nhớ, không đo thêm) cho menu và Tổng quan.
  const host = () => {
    try { const h = health?.latest?.(); return h ? { cpuPct: h.cpuPct, ramPct: h.ramPct, diskPct: h.diskPct } : null; } catch { return null; }
  };
  const r = express.Router();
  // Đọc thẳng SQLite nên vẫn có số liệu khi kết nối Zalo tắt. Tên nhóm chỉ lấy từ bộ đệm
  // (không chờ bot) để /api/status không chậm thêm khi bot treo.
  const today = () => {
    try {
      if (!store?.available()) return null;
      const s = store.todayStats(startOfDayVN(now()));
      const names = threadNames?.cached() || new Map();
      return { received: s.received, sent: s.sent, threads: s.threads, hourly: s.hourly, topGroups: s.topGroups.map((g) => ({ ...g, name: names.get(g.threadId) || fallbackName(g.threadId, 1) })) };
    } catch (err) {
      console.error('[dashboard] đọc số liệu hôm nay lỗi:', err);
      return null;
    }
  };
  // Sử dụng AI (Tổng quan): đọc ảnh, vẽ ảnh, tạo video theo loại / model / ngày; đệm 30 giây theo khoảng ngày.
  const aiCache = new Map();
  r.get('/ai-events', requireAuth, (req, res) => {
    if (!aiEvents) return res.status(404).json({ ok: false, error: 'Chưa có số liệu sử dụng AI.' });
    try {
      const days = Number(req.query.days) || 7;
      const hit = aiCache.get(days);
      if (hit && now() - hit.at < 30_000) return res.json({ ok: true, ...hit.value });
      const value = aiEvents.stats(days);
      aiCache.set(days, { at: now(), value });
      res.json({ ok: true, ...value });
    } catch (err) {
      console.error('[dashboard] đọc số liệu sử dụng AI lỗi:', err);
      res.status(500).json({ ok: false, error: 'Chưa đọc được số liệu sử dụng AI.' });
    }
  });
  // Người dùng bot (Tổng quan): lượt trong nhóm / nhắn riêng + xếp hạng; đệm 15 giây theo khoảng ngày để lần tải lại sau
  // lượt mới vẫn thấy số đúng, không phải chờ lâu.
  const usesCache = new Map();
  r.get('/bot-uses', requireAuth, (req, res) => {
    if (!botUses) return res.status(404).json({ ok: false, error: 'Chưa có số liệu người dùng bot.' });
    try {
      const days = Number(req.query.days) || 7;
      const hit = usesCache.get(days);
      if (hit && now() - hit.at < 15_000) return res.json({ ok: true, ...hit.value });
      const value = botUses.stats(days);
      usesCache.set(days, { at: now(), value });
      res.json({ ok: true, ...value });
    } catch (err) {
      console.error('[dashboard] đọc lượt dùng bot lỗi:', err);
      res.status(500).json({ ok: false, error: 'Chưa đọc được số liệu người dùng bot.' });
    }
  });
  r.get('/status', requireAuth, async (req, res) => {
    const telegramLinked = Boolean(linker?.isLinked(req.user.username));
    try {
      const h = await sidecar.health();
      const brain = h?.brain || h?.database?.brain || null;
      res.json({
        ok: true, sidecar: 'up', telegramLinked,
        zalo: { status: h?.zalo?.status || 'idle', displayName: h?.zalo?.displayName || '', listener: h?.zalo?.listener || null, needsRelogin: Boolean(h?.zalo?.needsRelogin) },
        assistant: (h?.bridge?.attachedClients || 0) > 0 ? 'connected' : 'disconnected',
        traffic: { lastInboundAtMs: h?.traffic?.lastInboundAtMs || null, lastOutboundAtMs: h?.traffic?.lastOutboundAtMs || null },
        // Tồn đọng tầng não: bot còn phải học bao nhiêu, có kẹt không. `null` khi sidecar chưa trả.
        brain: brain ? {
          pendingTopics: Number(brain.pendingTopics) || 0,
          pendingFacts: Number(brain.pendingFacts) || 0,
          stuckThreads: Number(brain.stuckThreads) || 0,
          lagMs: Number(brain.lagMs) || 0,
        } : null,
        lastError: h?.lastError ? { code: h.lastError.code ?? null, message: h.lastError.message ?? '', atMs: h.lastError.atMs ?? null } : null,
        today: today(), host: host(),
      });
    } catch (err) {
      if (err?.name !== 'SidecarDown') console.error('[dashboard] đọc trạng thái lỗi:', err);
      res.json({ ok: true, sidecar: 'down', telegramLinked, zalo: { status: 'unknown', displayName: '', listener: null, needsRelogin: false },
        assistant: 'unknown', brain: null, traffic: { lastInboundAtMs: null, lastOutboundAtMs: null }, lastError: null, today: today(), host: host() });
    }
  });
  return r;
}
