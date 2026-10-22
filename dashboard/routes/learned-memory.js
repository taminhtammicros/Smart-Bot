// Kho tri thức tự học (spec §19.6): Quản trị và Chủ bot cùng xem, tìm, sửa, xoá trí nhớ trợ lý tự rút ra theo nhóm/người.
// Kho tin nhắn riêng của chủ nhân bot chỉ Quản trị thấy (lib chặn theo vai trò). Đổi chu kỳ rút và "Rút trí nhớ ngay"
// chỉ Quản trị. Mọi thao tác ghi để lại dòng Nhật ký (không chép nội dung trí nhớ vào Nhật ký).
import express from 'express';
import { requireAuth, requireRole } from '../lib/http-guards.js';

export function learnedMemoryRoutes({ learnedMemory, activity }) {
  const r = express.Router();
  const anyRole = [requireAuth];
  const adminOnly = [requireAuth, requireRole('admin')];
  const fail = (res, err) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    if (status !== 500) return res.status(status).json({ ok: false, error: err.message });
    console.error('[dashboard]', err);
    return res.status(500).json({ ok: false, error: 'Lỗi bên trong dashboard — xem nhật ký dịch vụ.' });
  };
  const log = (req, action, detail) => {
    try { activity.append({ actor: req.user.username, action, detail }); } catch (e) { console.error('[dashboard] không ghi được Nhật ký:', e); }
  };
  const lm = (req) => learnedMemory.as(req.user.role);
  const scope = (req) => String(req.params.scope ?? '');
  const base = '/learned-memory';

  r.get(`${base}/status`, ...anyRole, (req, res) => {
    try { res.json({ ok: true, ...learnedMemory.status(), settings: learnedMemory.settings(), canAdmin: req.user.role === 'admin' }); } catch (err) { fail(res, err); }
  });
  r.put(`${base}/settings`, ...adminOnly, (req, res) => {
    try {
      const settings = learnedMemory.setSettings(req.body || {});
      log(req, 'learned_memory_settings', `chu kỳ rút ${settings.extractMinutes} phút`);
      res.json({ ok: true, settings });
    } catch (err) { fail(res, err); }
  });
  r.get(`${base}/scopes`, ...anyRole, async (req, res) => { try { res.json({ ok: true, scopes: await lm(req).scopes() }); } catch (err) { fail(res, err); } });
  r.get(`${base}/:scope/list`, ...anyRole, async (req, res) => {
    try { res.json({ ok: true, entries: await lm(req).list(scope(req), req.query.kind ? String(req.query.kind) : undefined) }); } catch (err) { fail(res, err); }
  });
  r.get(`${base}/:scope/search`, ...anyRole, async (req, res) => {
    try { res.json({ ok: true, hits: await lm(req).search(scope(req), req.query.q) }); } catch (err) { fail(res, err); }
  });
  r.put(`${base}/:scope/item`, ...anyRole, async (req, res) => {
    try {
      await lm(req).edit(scope(req), String(req.body?.id ?? ''), req.body?.text);
      log(req, 'learned_memory_edit', `${scope(req)}: ${String(req.body?.id ?? '')}`);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
  r.delete(`${base}/:scope/item`, ...anyRole, async (req, res) => {
    try {
      await lm(req).remove(scope(req), String(req.body?.id ?? ''));
      log(req, 'learned_memory_delete', `${scope(req)}: ${String(req.body?.id ?? '')}`);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
  /** Xoá nhiều mục: `{ ids: [...] }` → `{ done, failed }`; một dòng Nhật ký. */
  r.post(`${base}/:scope/bulk-delete`, ...anyRole, async (req, res) => {
    try {
      const out = await lm(req).removeMany(scope(req), req.body?.ids);
      if (out.done.length) log(req, 'learned_memory_delete', `${scope(req)}: ${out.done.length} mục`);
      res.json({ ok: true, ...out });
    } catch (err) { fail(res, err); }
  });
  r.post(`${base}/:scope/extract`, ...adminOnly, async (req, res) => {
    try {
      const out = await lm(req).extractNow(scope(req));
      log(req, 'learned_memory_extract', `${scope(req)}: ${out.committed} phiên`);
      res.json({ ok: true, ...out });
    } catch (err) { fail(res, err); }
  });
  r.delete(`${base}/:scope`, ...anyRole, async (req, res) => {
    try {
      await lm(req).forget(scope(req));
      log(req, 'learned_memory_forget', scope(req));
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
  return r;
}
