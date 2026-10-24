// Kho tri thức (spec §18.5) — cả hai vai trò: xem (gọn: số tệp theo nguồn + tài liệu tự tạo), tải lên (≤ 10 MB,
// docx/pdf/md/txt), viết tài liệu mới, sửa/đổi tên/thay/xoá tài liệu tự tạo. Đổi nguồn (ZALO_KB_DIR + thư mục mở): chỉ Quản trị.
// Tải lên gửi thân nhị phân (application/octet-stream) + tên tệp ở X-File-Name (encodeURIComponent) — không base64.
import express from 'express';
import { requireAuth, requireRole } from '../lib/http-guards.js';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from '../lib/kb-store.js';

export function kbRoutes({ kb, activity, restartFlags }) {
  const r = express.Router();
  const fail = (res, err, fallback) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : (err?.type === 'entity.too.large' ? 413 : 500);
    if (status === 413) return res.status(413).json({ ok: false, error: 'Tệp quá 10 MB — chia nhỏ hoặc nén lại rồi tải lên.' });
    if (status >= 400 && status < 500) return res.status(status).json({ ok: false, error: err.message });
    console.error('[dashboard]', err);
    return res.status(500).json({ ok: false, error: fallback });
  };
  const log = (req, action, detail) => {
    try { activity.append({ actor: req.user.username, action, detail }); } catch (e) { console.error('[dashboard] không ghi được Nhật ký:', e); }
  };

  const readName = (req) => { try { return decodeURIComponent(String(req.get('x-file-name') || '')); } catch { return ''; } };
  /** Thư mục (siêu dữ liệu dashboard) cho tài liệu mới: thiếu/rỗng = "Chưa xếp". */
  const folderArg = (v) => (v == null || v === '' ? null : String(v));

  r.get('/kb', requireAuth, async (req, res) => {
    try { res.json({ ok: true, ...kb.info(), ...(await kb.list({ fresh: req.query.fresh === '1' })), uploadTypes: UPLOAD_TYPES, maxBytes: MAX_UPLOAD_BYTES }); } catch (err) { fail(res, err, 'Chưa đọc được kho tri thức — thử lại sau ít phút.'); }
  });

  r.post('/kb/upload', requireAuth, express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES }), (req, res) => {
    try {
      const name = readName(req);
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ ok: false, error: 'Chưa nhận được tệp — chọn lại tệp rồi tải lên.' });
      const path = kb.upload(name, req.body, { folder: folderArg(req.query.folder) });
      log(req, 'kb_upload', path);
      res.json({ ok: true, path });
    } catch (err) { fail(res, err, 'Chưa tải lên được — thử lại, nếu vẫn lỗi hãy báo người cài đặt.'); }
  });

  r.get('/kb/own', requireAuth, (req, res) => {
    try { res.json({ ok: true, text: kb.readOwn(String(req.query.path ?? '')) }); } catch (err) { fail(res, err, 'Chưa đọc được tài liệu — thử lại.'); }
  });

  r.put('/kb/own', requireAuth, (req, res) => {
    try {
      const { path, name, text } = req.body || {};
      const next = kb.saveOwn(String(path ?? ''), { name: name == null ? undefined : String(name), text: text == null ? undefined : String(text) });
      log(req, 'kb_edit', next);
      res.json({ ok: true, path: next });
    } catch (err) { fail(res, err, 'Chưa lưu được tài liệu — thử lại.'); }
  });

  r.post('/kb/own/replace', requireAuth, express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES }), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ ok: false, error: 'Chưa nhận được tệp — chọn lại tệp.' });
      const path = String(req.query.path ?? '');
      kb.replaceOwn(path, req.body);
      log(req, 'kb_replace', path);
      res.json({ ok: true, path });
    } catch (err) { fail(res, err, 'Chưa thay được tệp — thử lại.'); }
  });

  r.post('/kb/note', requireAuth, (req, res) => {
    try {
      const path = kb.createNote(req.body?.title, req.body?.text, { folder: folderArg(req.body?.folder) });
      log(req, 'kb_note', path);
      res.json({ ok: true, path });
    } catch (err) { fail(res, err, 'Chưa tạo được tài liệu — thử lại.'); }
  });

  r.get('/admin/kb/source', requireAuth, requireRole('admin'), (req, res) => {
    try { res.json({ ok: true, ...(req.query.dir ? kb.browse(String(req.query.dir)) : kb.source()) }); } catch (err) { fail(res, err, 'Chưa đọc được nguồn kho — thử lại.'); }
  });

  r.put('/admin/kb/source', requireAuth, requireRole('admin'), (req, res) => {
    try {
      const saved = kb.setSource({ dir: req.body?.dir, allDirs: req.body?.allDirs === true });
      if (saved.changed) {
        restartFlags?.mark('assistant', 'Kho tri thức: nguồn');
        log(req, 'kb_source', `${saved.dir} — cả kho`);
      }
      res.json({ ok: true, ...saved });
    } catch (err) { fail(res, err, 'Chưa đổi được nguồn — thử lại.'); }
  });

  r.delete('/kb/file', requireAuth, (req, res) => {
    try {
      const path = String(req.body?.path ?? '');
      kb.remove(path);
      log(req, 'kb_delete', path);
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'Chưa xoá được — thử lại.'); }
  });

  /** Xoá nhiều tài liệu tự tạo: `{ paths: [...] }` — kiểm hết đường dẫn trước; một dòng Nhật ký. */
  r.post('/kb/files/delete', requireAuth, (req, res) => {
    try {
      const n = kb.removeMany(req.body?.paths);
      log(req, 'kb_delete', `${n} tài liệu`);
      res.json({ ok: true, count: n });
    } catch (err) { fail(res, err, 'Chưa xoá được — thử lại.'); }
  });

  /** Xếp một hay nhiều tài liệu tự tạo vào thư mục: `{ paths: [...], folder: id | null }` — một dòng Nhật ký. */
  r.put('/kb/files/folder', requireAuth, (req, res) => {
    try {
      const { count, folder } = kb.moveMany(req.body?.paths, folderArg(req.body?.folder));
      log(req, 'kb_move', `${count} tài liệu → ${folder ? folder.name : 'Chưa xếp'}`);
      res.json({ ok: true, count });
    } catch (err) { fail(res, err, 'Chưa chuyển được tài liệu — thử lại.'); }
  });

  r.post('/kb/folders', requireAuth, (req, res) => {
    try {
      const folder = kb.createFolder({ name: req.body?.name, color: req.body?.color ?? undefined });
      log(req, 'kb_folder_create', folder.name);
      res.json({ ok: true, folder });
    } catch (err) { fail(res, err, 'Chưa tạo được thư mục — thử lại.'); }
  });

  r.put('/kb/folders/:id', requireAuth, (req, res) => {
    try {
      const { before, after } = kb.updateFolder(req.params.id, { name: req.body?.name ?? undefined, color: req.body?.color ?? undefined });
      log(req, 'kb_folder_edit', before.name === after.name ? after.name : `${before.name} → ${after.name}`);
      res.json({ ok: true, folder: after });
    } catch (err) { fail(res, err, 'Chưa lưu được thư mục — thử lại.'); }
  });

  r.delete('/kb/folders/:id', requireAuth, (req, res) => {
    try {
      const folder = kb.deleteFolder(req.params.id);
      log(req, 'kb_folder_delete', folder.name);
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'Chưa xoá được thư mục — thử lại.'); }
  });

  // Lỗi của express.raw (quá cỡ) đi qua đây thay vì câu chung của app.
  r.use(['/kb', '/admin/kb'], (err, req, res, next) => (err?.type === 'entity.too.large' ? fail(res, err, '') : next(err)));
  return r;
}
