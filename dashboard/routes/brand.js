// Thương hiệu (spec §7.1): GET /api/brand công khai vì trang đăng nhập cần; mọi thao tác ghi cần đăng nhập
// (Quản trị và Chủ bot — spec §6). /brand.css và /brand/logo.png cũng công khai, phục vụ cùng nguồn (CSP).
import express from 'express';
import { requireAuth } from '../lib/http-guards.js';
import { SUGGESTIONS } from '../public/brand-color.js';

const SAVE_FAIL = 'Chưa lưu được thương hiệu — thử lại, nếu vẫn lỗi hãy báo người cài đặt.';

export function brandRoutes({ brand, activity }) {
  const r = express.Router();
  const fail = (res, err) => {
    if (err?.name === 'InvalidBrand') return res.status(400).json({ ok: false, error: err.message });
    console.error('[dashboard]', err);
    return res.status(500).json({ ok: false, error: SAVE_FAIL });
  };
  const log = (req, action, detail = '') => {
    try { activity.append({ actor: req.user.username, action, detail }); } catch (err) { console.error('[dashboard] không ghi được Nhật ký thương hiệu:', err); }
  };
  const noCache = (res) => res.set('Cache-Control', 'no-cache');

  r.get('/api/brand', (req, res) => {
    try { noCache(res).json({ ok: true, ...brand.get(), suggestions: SUGGESTIONS }); } catch (err) { fail(res, err); }
  });

  r.put('/api/brand', requireAuth, (req, res) => {
    try {
      const b = brand.set(req.body);
      log(req, 'brand_update', `${b.name} (${b.subtitle}) · ${b.color}${b.poweredBy ? '' : ' · ẩn "Vận Hành bởi Cá Heo AI"'}`);
      res.json({ ok: true, ...b, suggestions: SUGGESTIONS });
    } catch (err) { fail(res, err); }
  });

  r.post('/api/brand/logo', requireAuth, (req, res) => {
    try {
      const b = brand.setLogo(req.body?.dataUrl);
      log(req, 'brand_logo');
      res.json({ ok: true, ...b, suggestions: SUGGESTIONS });
    } catch (err) { fail(res, err); }
  });

  r.delete('/api/brand/logo', requireAuth, (req, res) => {
    try {
      const b = brand.removeLogo();
      log(req, 'brand_logo_remove');
      res.json({ ok: true, ...b, suggestions: SUGGESTIONS });
    } catch (err) { fail(res, err); }
  });

  r.delete('/api/brand', requireAuth, (req, res) => {
    try {
      const b = brand.reset();
      log(req, 'brand_reset');
      res.json({ ok: true, ...b, suggestions: SUGGESTIONS });
    } catch (err) { fail(res, err); }
  });

  r.get('/brand.css', (req, res) => {
    try { noCache(res).type('text/css; charset=utf-8').send(brand.css()); } catch (err) {
      console.error('[dashboard] /brand.css lỗi:', err);
      noCache(res).type('text/css; charset=utf-8').send('/* lỗi — dùng màu mặc định */\n');
    }
  });

  r.get('/brand/logo.png', (req, res) => {
    let buf = null;
    try { buf = brand.logo(); } catch (err) { console.error('[dashboard] đọc logo lỗi:', err); }
    if (!buf) return res.status(404).type('text/plain; charset=utf-8').send('Chưa có logo');
    noCache(res).type('image/png').set('Content-Disposition', 'inline; filename="logo.png"').send(buf);
  });

  return r;
}
