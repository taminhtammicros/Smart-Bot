/**
 * Model AI theo từng chức năng (trang "Khoá API & Model", chỉ Quản trị): đọc config.yaml của Hermes (+ kho trí nhớ
 * SQLite zalo.sqlite nếu bật trí nhớ tự học, + biến ảnh của xưởng) để cho thấy mỗi việc đang dùng model nào, qua đâu.
 * Không hiện khoá, đường dẫn lệnh hay URL đầy đủ (chỉ máy chủ:cổng). "Thử" gửi một câu ngắn tới cổng AI chính.
 *
 * Trí nhớ dài hạn đọc thẳng `zalo.sqlite` của sidecar — cùng tệp provider `zalo_memory` ghi (spec §21). Không đọc
 * tệp nào ngoài sidecar (ov.conf của OpenViking đã gỡ 2026-10-22).
 */
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readConfigYaml } from './config-yaml.js';
import { MODEL_NAME } from './agent-config.js';
import { LM_PROVIDER, resolveAccount } from './learned-memory.js';

const err = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const str = (v, n = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = (url) => { try { return new URL(String(url)).host; } catch { return ''; } };

/** Giọng đọc đang chọn: tts.<provider>.voice hoặc tts.providers.<provider>.voice hoặc tts.voice. */
function ttsVoice(tts) {
  const p = String(tts?.provider || '');
  return str(tts?.[p]?.voice || tts?.providers?.[p]?.voice || tts?.voice || tts?.gemini?.voice || '', 60);
}

export function createAiModels({ configFile, envValue = () => null, sqliteFile = null, fetchImpl = fetch }) {
  const conf = () => readConfigYaml(configFile) || {};
  /**
   * Kho trí nhớ dài hạn: provider `zalo_memory` ghi vào `zalo.sqlite` (facts / profiles / soft_memories).
   * `account_id` là UID Zalo của chính bot (xem `zalo_memory/__init__.py:41`), nên lấy từ dòng mới nhất chứ
   * không dùng hằng số — UID đổi khi đăng nhập tài khoản khác.
   * Đọc chỉ-đọc, mở đóng trong một lượt — kho chưa có (bot chưa chạy lần nào) hoặc bảng chưa tạo → 0.
   */
  function longTermMemory(c) {
    if (String(c?.memory?.provider || '') !== LM_PROVIDER || !sqliteFile) return null;
    let db = null;
    try {
      if (!existsSync(sqliteFile)) return { facts: 0, profiles: 0, soft: 0, lastAtMs: 0 };
      db = new DatabaseSync(sqliteFile, { readOnly: true });
      const account = resolveAccount(db);
      if (!account) return { facts: 0, profiles: 0, soft: 0, lastAtMs: 0 };
      const count = (sql) => {
        try { return Number(db.prepare(sql).get(account)?.n ?? 0); } catch { return 0; }   // bảng chưa có → 0
      };
      const facts = count("SELECT COUNT(*) AS n FROM facts WHERE account_id = ? AND status = 'active'");
      const profiles = count('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?');
      const soft = count("SELECT COUNT(*) AS n FROM soft_memories WHERE account_id = ? AND status = 'active'");
      let lastAtMs = 0;
      try {
        const r = db.prepare(`SELECT MAX(ts) AS last FROM (
          SELECT MAX(updated_at_ms) AS ts FROM facts WHERE account_id = ?
          UNION ALL SELECT MAX(updated_at_ms) FROM profiles WHERE account_id = ?
          UNION ALL SELECT MAX(updated_at_ms) FROM soft_memories WHERE account_id = ?)`).get(account, account, account);
        lastAtMs = Number(r?.last ?? 0) || 0;
      } catch { /* bảng chưa có → không có mốc thời gian */ }
      return { facts, profiles, soft, lastAtMs };
    } catch {
      return null;   // kho hỏng/khoá → ẩn thẻ, không làm hỏng cả trang
    } finally {
      try { db?.close(); } catch { /* đã đóng */ }
    }
  }
  return {
    /** Thẻ cho từng chức năng: { id, label, model, via, note }. */
    view() {
      const c = conf();
      const m = c.model || {};
      const tts = c.tts || {};
      const stt = c.stt || {};
      const img = c.image_gen || {};
      const mem = longTermMemory(c);
      const studio = hostOf(envValue('ZALO_STUDIO_IMAGE_URL'));
      const cards = [
        { id: 'main', label: 'Trò chuyện chính', model: str(m.default), via: hostOf(m.base_url) || str(m.provider), note: 'Mọi câu trả lời của bot trong nhóm và tin nhắn riêng.', testable: true, editable: true },
        { id: 'fallback', label: 'Dự phòng khi model chính lỗi', model: str(c.fallback_model?.model || c.fallback_model || ''), via: str(c.fallback_provider || c.fallback_model?.provider || ''), note: 'Bot tự chuyển sang khi model chính không trả lời được.' },
        { id: 'tts', label: 'Giọng đọc (tin nhắn thoại)', model: ttsVoice(tts) ? `giọng ${ttsVoice(tts)}` : '', via: str(tts.provider), note: tts.fallback_provider ? `Dự phòng: ${str(tts.fallback_provider)}.` : '' },
        { id: 'stt', label: 'Nghe giọng nói', model: str(stt?.openai?.model || stt?.model || ''), via: stt.enabled === false ? 'đang tắt' : str(stt.provider), note: 'Chuyển tin nhắn thoại thành chữ.' },
        { id: 'image', label: 'Tạo ảnh', ...(img.provider === 'stali' ? { model: 'req/gpt-image-2', via: 'Stali API' } : { model: str(img.model), via: str(img.provider) }), note: 'Khi được nhờ vẽ/tạo ảnh.' },
        ...(studio ? [{ id: 'studio', label: 'Ảnh cho xưởng (slide, tài liệu)', model: '', via: studio, note: 'Ảnh minh hoạ trong sản phẩm của 2Anh Studio.' }] : []),
        ...(mem ? [{
          id: 'memory',
          label: 'Trí nhớ dài hạn (kho của bot)',
          model: `${mem.facts} fact · ${mem.profiles} hồ sơ · ${mem.soft} trí nhớ mềm`,
          via: '',
          note: `SQLite nội bộ, không gọi model lúc truy hồi.${mem.lastAtMs ? ` Cập nhật gần nhất ${new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(mem.lastAtMs))}.` : ''}`,
        }] : []),
      ].filter((x) => x.id === 'main' || x.model || x.via);
      return { cards, reasoning: str(c.agent?.reasoning_effort || 'medium', 20) };
    },
    /** Gửi một câu ngắn tới cổng AI chính bằng `model` (mặc định model chính): { ok, ms, reply|detail }. */
    async test(model) {
      const m = conf().model || {};
      const name = String(model || m.default || '').trim();
      if (!MODEL_NAME.test(name)) throw err(400, 'Tên model không hợp lệ.');
      const base = String(m.base_url || '').replace(/\/+$/, '');
      if (!/^https?:\/\//.test(base)) throw err(409, 'config.yaml chưa có model.base_url — báo người cài đặt.');
      const t0 = Date.now();
      try {
        const res = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
          headers: { 'Content-Type': 'application/json', ...(m.api_key ? { Authorization: `Bearer ${m.api_key}` } : {}) },
          body: JSON.stringify({ model: name, stream: false, max_tokens: 30, messages: [{ role: 'user', content: 'Trả lời đúng một câu ngắn: "Xin chào, mình sẵn sàng."' }] }),
        });
        const ms = Date.now() - t0;
        let j = null;
        try { j = await res.json(); } catch { /* không phải JSON */ }
        if (!res.ok) return { ok: false, ms, detail: res.status === 401 ? 'Khoá cổng AI sai.' : res.status === 404 ? `Cổng AI không có model ${name}.` : `Cổng AI trả lỗi ${res.status}.` };
        const reply = str(j?.choices?.[0]?.message?.content, 160);
        return reply ? { ok: true, ms, reply } : { ok: false, ms, detail: 'Model trả lời rỗng.' };
      } catch { return { ok: false, ms: Date.now() - t0, detail: 'Không gọi được cổng AI (mạng hoặc hết thời gian chờ).' }; }
    },
  };
}
