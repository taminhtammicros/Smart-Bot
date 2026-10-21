// Tổng quan: dải tình trạng gọn · Cần chú ý (có chỗ xử lý ngay) · hội thoại hôm nay · lịch sắp chạy · AI hôm nay · lối tắt.
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Icon, Live, PageHead, Spinner, fmtTime } from '../ui.js';
import { FolderChip, folderIndex, folderOfThread } from './folder-ui.js';
import { addToFolder, FolderSelect, lastFolder, rememberFolder } from './contacts.js';

export function zaloCard(s) {
  if (s.sidecar === 'down') return { kind: 'danger', state: 'Kết nối Zalo đang tắt — hệ thống sẽ tự bật lại trong ít phút' };
  if (s.zalo.needsRelogin) return { kind: 'danger', state: 'Bị đăng xuất — cần quét QR lại', qr: true };
  if (s.zalo.status === 'logged-in' && s.zalo.listener != null && s.zalo.listener !== 'connected') {
    return { kind: 'warn', state: 'Đang nối lại… — tạm thời chưa nhận được tin nhắn' };
  }
  if (s.zalo.status === 'logged-in') return { kind: 'ok', state: `Đang hoạt động — ${s.zalo.displayName || 'bot Zalo'}` };
  return { kind: 'danger', state: 'Chưa đăng nhập — cần quét QR', qr: true };
}

// Mã lỗi runtime-health của bot → câu dễ hiểu + bước tiếp theo. Mã lạ dùng câu chung.
const ERRORS = {
  zalo_listener_closed: ['Kết nối nhận tin Zalo bị ngắt.', 'Bot thường tự nối lại sau ít phút. Nếu thanh trên cùng báo mất kết nối, hãy quét mã đăng nhập lại.'],
  bridge_command_failed: ['Bot chưa làm được một việc trên Zalo (gửi tin hoặc thao tác nhóm).', 'Thường do Zalo từ chối hoặc mạng chập chờn — xem Nhật ký, chọn "Chỉ lỗi" để biết việc nào.'],
  system_notice_failed: ['Bot chưa gửi được một tin thông báo.', 'Xem Nhật ký, chọn "Chỉ lỗi" để biết tin nào; nếu lặp lại hãy báo người cài đặt.'],
  bridge_server_error: ['Trợ lý gặp lỗi khi trao đổi với Zalo.', 'Nếu bot ngừng trả lời, nhờ Quản trị khởi động lại trợ lý.'],
  history_retention_failed: ['Bot chưa dọn được lịch sử tin nhắn cũ.', 'Bot vẫn trả lời bình thường; báo người cài đặt nếu lỗi lặp lại.'],
  legacy_history_import_failed: ['Bot chưa nhập được lịch sử tin nhắn cũ.', 'Bot vẫn trả lời bình thường; báo người cài đặt nếu Phiên chat thiếu tin cũ.'],
  automatic_backfill_failed: ['Bot chưa tải bù được tin nhắn lúc mất kết nối.', 'Bot vẫn trả lời bình thường; vài tin trong lúc mất kết nối có thể không hiện ở Phiên chat.'],
  dashboard_server_error: ['Bot không mở được cổng nội bộ của nó.', 'Báo người cài đặt kèm thời điểm trên.'],
};
const GENERIC = ['Bot ghi nhận một lỗi nội bộ.', 'Nếu lỗi lặp lại hoặc bot ngừng trả lời, hãy báo người cài đặt kèm thời điểm trên.'];

/** { text, next, code } cho thẻ "Lỗi gần nhất"; mã kỹ thuật chỉ dành cho Quản trị. */
export function errorText(lastError, role) {
  const [text, next] = ERRORS[lastError?.code] || GENERIC;
  return { text, next, code: role === 'admin' && lastError?.code ? String(lastError.code) : null };
}

const ROWS = 4;
/**
 * Biểu đồ chấm: mỗi cột một giá trị, số chấm sáng (từ dưới lên, 0–4) tỉ lệ với giá trị/max. Giá trị > 0 luôn sáng ít nhất 1 chấm.
 * Trả mảng cột, mỗi cột ROWS cờ từ trên xuống.
 */
export function dotColumns(values, max = Math.max(1, ...values)) {
  return values.map((v) => {
    const lit = v > 0 ? Math.max(1, Math.min(ROWS, Math.round((v / max) * ROWS))) : 0;
    return Array.from({ length: ROWS }, (_, i) => ROWS - i <= lit);
  });
}

/** Gộp chuỗi số đo thành `n` cột (trung bình mỗi nhóm) — biểu đồ chấm không quá dày trên điện thoại. */
export function bucket(values, n) {
  if (values.length <= n) return values;
  const size = values.length / n;
  return Array.from({ length: n }, (_, i) => {
    const part = values.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    return part.length ? part.reduce((a, b) => a + b, 0) / part.length : 0;
  });
}

function Dots({ values, max, label }) {
  return html`<div class="dots" role="img" aria-label=${label}>
    ${dotColumns(values, max).flatMap((col, c) => col.map((on, r) => html`<span key=${`${c}-${r}`} class=${on ? 'dot on' : 'dot'}></span>`))}
  </div>`;
}

const compact = new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });
const hhmm = (ms) => (ms ? new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(ms)) : '—');
const todayVN = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

/** Số đo máy chủ (CPU, RAM, ổ đĩa) và lượt gọi AI theo ngày — hỏi lại mỗi phút. */
function useServer() {
  const [h, setH] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api('/api/server-health').then((r) => alive && setH(r)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return h;
}

/** Tải một API định kỳ (lỗi → giữ giá trị cũ). */
function usePoll(path, ms, enabled = true) {
  const [v, setV] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const load = () => api(path).then((r) => alive && setV(r)).catch(() => {});
    load();
    const t = setInterval(load, ms);
    return () => { alive = false; clearInterval(t); };
  }, [path, enabled, tick]);
  return [v, () => setTick((x) => x + 1)];
}

/** Mở thẳng một hội thoại ở Phiên chat (Phiên chat đọc khoá này khi mở). */
export const OPEN_CHAT_KEY = 'zd:open-chat';
function openChat(c) {
  try { sessionStorage.setItem(OPEN_CHAT_KEY, JSON.stringify({ threadId: c.threadId, threadType: c.threadType, name: c.name })); } catch { /* bỏ qua */ }
  location.hash = '#/chats';
}

/**
 * Việc cần chú ý, mỗi việc một dòng có chỗ xử lý: `{ kind: 'danger'|'warn'|'info', text, href?, action? }`.
 * Không có gì → mảng rỗng (trang hiện "Mọi thứ ổn").
 */
export function attentionItems({ status: s, host, requests, memory, notice, admin, now = Date.now() }) {
  const out = [];
  if (s) {
    const z = zaloCard(s);
    if (z.kind !== 'ok') out.push({ kind: z.kind === 'warn' ? 'warn' : 'danger', text: `Zalo: ${z.state}`, href: '#/zalo' });
    if (s.sidecar !== 'down' && s.assistant && s.assistant !== 'connected') out.push({ kind: 'danger', text: 'Trợ lý AI chưa phản hồi — bot có thể không trả lời tin nhắn.', action: admin ? 'restart' : null });
    if (s.lastError && now - Number(s.lastError.atMs || 0) < 24 * 3600_000) {
      out.push({ kind: 'warn', text: `Lỗi lúc ${fmtTime(s.lastError.atMs)}: ${errorText(s.lastError, 'owner').text}`, href: '#/audit' });
    }
  }
  if (requests?.length) out.push({ kind: 'info', text: `${requests.length} lời mời kết bạn đang chờ`, requests: true });
  if (host && Math.max(host.cpuPct, host.ramPct, host.diskPct) >= 85) {
    out.push({ kind: 'warn', text: `Máy chủ đang tải cao — CPU ${Math.round(host.cpuPct)}%, RAM ${Math.round(host.ramPct)}%, ổ đĩa ${Math.round(host.diskPct)}%.`, href: '#/health' });
  }
  for (const t of ['user', 'memory']) {
    const m = memory?.[t];
    if (m && m.limit && m.used / m.limit >= 0.9) out.push({ kind: 'warn', text: `${m.label} đã đầy ${Math.round((m.used / m.limit) * 100)}% — bot sắp không nhớ thêm được.`, href: '#/memory' });
  }
  if (notice?.newer) out.push({ kind: 'info', text: `Có bản cập nhật mới ${notice.latest || ''}`.trim(), href: admin ? '#/maintenance' : '' });
  return out;
}

/** Hội thoại có tin hôm nay, mới nhất trước. */
export const todayChats = (list, n = 8) => (list || []).filter((c) => c.today > 0).sort((a, b) => b.lastAtMs - a.lastAtMs).slice(0, n);

/** Việc hẹn giờ sắp chạy trong `hours` giờ tới, gần nhất trước. */
export function upcomingJobs(jobs, now = Date.now(), hours = 48, n = 5) {
  return (jobs || []).filter((j) => j.enabled && !j.paused && j.nextRunAt && j.nextRunAt >= now - 60_000 && j.nextRunAt <= now + hours * 3600_000)
    .sort((a, b) => a.nextRunAt - b.nextRunAt).slice(0, n);
}

const when = (ms) => {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
  const label = day === todayVN() ? 'Hôm nay' : 'Ngày mai';
  return `${label} ${hhmm(ms)}`;
};

function Card({ title, icon, tint, href, hrefText, extra = '', children }) {
  return html`<section class=${`card ov-card tint-${tint}${extra ? ` ${extra}` : ''}`}>
    <div class="ov-head"><span class=${`nav-ico tint-${tint}`} aria-hidden="true"><${Icon} name=${icon} size=${18} /></span>
      <h2>${title}</h2>${href ? html`<a class="ov-more" href=${href}>${hrefText || 'Xem tất cả'} <${Icon} name="next" size=${14} /></a>` : null}</div>
    ${children}
  </section>`;
}

function Requests({ list, onDone, folders = [] }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const [folder, setFolderRaw] = useState(lastFolder);
  const setFolder = (v) => { setFolderRaw(v); rememberFolder(v); };
  const target = folders.find((f) => f.id === folder) || null;
  async function answer(r, accept) {
    if (!accept && !confirm(`Từ chối lời mời kết bạn của ${r.name || 'người này'}?`)) return;
    setBusy(r.uid); setMsg({});
    try {
      await api(`/api/contacts/requests/${r.uid}`, { method: 'POST', body: { accept } });
      // Đồng ý xong thì xếp luôn vào thư mục đã chọn; lỗi xếp không làm hỏng việc kết bạn đã xong.
      let filed = '';
      if (accept && target) {
        try { await addToFolder(target.id, [r]); filed = ` Đã xếp vào thư mục ${target.name}.`; } catch (e) { filed = ` Chưa xếp được vào thư mục ${target.name}: ${e.message}`; }
      }
      setMsg({ ok: accept ? `Đã đồng ý kết bạn với ${r.name || 'người này'}.${filed}` : 'Đã từ chối.' }); onDone();
    } catch (e) { setMsg({ error: e.message }); } finally { setBusy(''); }
  }
  return html`${folders.length ? html`<${FolderSelect} id="ov-req-folder" folders=${folders} value=${target ? folder : ''} onChange=${setFolder} label="Xếp người được đồng ý vào" />` : null}
    <ul class="ov-requests">${list.map((r) => html`<li key=${r.uid}>
      <span class="ov-req-name"><strong>${r.name || 'Chưa rõ tên'}</strong>${r.message ? html`<small class="muted">Có lời nhắn — xem ở Liên hệ</small>` : null}</span>
      <button type="button" class="btn btn-primary btn-sm" disabled=${busy !== ''} onClick=${() => answer(r, true)}>Đồng ý${target ? ` → ${target.name}` : ''}</button>
      <button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== ''} onClick=${() => answer(r, false)}>Từ chối</button>
    </li>`)}</ul><${Live} error=${msg.error} ok=${msg.ok} />`;
}

const QUICK = [
  ['#/chats', 'chat', 'Nhắn tin', 'blue'], ['#/permissions', 'shield', 'Phân quyền', 'purple'], ['#/memory', 'brain', 'Trí nhớ', 'pink'],
  ['#/agent', 'bot', 'Tính cách AI', 'indigo', true], ['#/schedules', 'clock', 'Lịch hẹn', 'orange'], ['#/settings', 'settings', 'Cấu hình', 'gray', true],
];

const USE_PERIODS = [[1, 'Hôm nay'], [7, '7 ngày'], [30, '30 ngày']];
/** Người dùng bot: lượt được bot xử lý trong nhóm / nhắn riêng + xếp hạng (tính cả chủ nhân). */
function BotUses() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setError('');
    api(`/api/bot-uses?days=${days}`).then((r) => { if (alive) setData(r); }, (e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [days]);
  const board = (title, b, group) => html`<div class="ov-board">
    <h3>${title}</h3>
    ${b.top.length ? html`<ol class="ov-rank">${b.top.map((p, i) => html`<li key=${`${p.uid}:${p.name}:${i}`}>
      <button type="button" class="ov-rank-row" disabled=${!(group ? p.thread : p.uid)}
        onClick=${() => openChat(group ? { threadId: p.thread, threadType: 1, name: p.threadName || 'Nhóm' } : { threadId: p.uid, threadType: 0, name: p.name })}>
        <span class="ov-rank-no">${i + 1}</span>
        <span class="ov-rank-who"><strong>${p.name}</strong>${group && p.threadName ? html`<small class="muted">nhiều nhất ở ${p.threadName}</small>` : null}</span>
        <span class="conv-count" title=${`${p.count} lượt`}>${p.count.toLocaleString('vi-VN')}</span>
      </button></li>`)}</ol>` : html`<p class="muted small">Chưa có ai.</p>`}
  </div>`;
  return html`<${Card} title="Người dùng bot" icon="users" tint="teal" extra="ov-uses-card">
    <div class="chips" role="group" aria-label="Khoảng thời gian">${USE_PERIODS.map(([d, label]) => html`<button key=${d} type="button"
      class="btn btn-secondary btn-sm chip" aria-pressed=${days === d ? 'true' : 'false'} onClick=${() => setDays(d)}>${label}</button>`)}</div>
    ${error ? html`<p class="muted small">${error}</p>` : !data || data.days !== days ? html`<${Spinner} />` : html`
      <dl class="ov-facts ov-uses">
        <div><dt>Lượt trong nhóm</dt><dd>${data.group.uses.toLocaleString('vi-VN')}</dd><dd class="ov-small muted">${data.group.people} người</dd></div>
        <div><dt>Lượt nhắn riêng</dt><dd>${data.dm.uses.toLocaleString('vi-VN')}</dd><dd class="ov-small muted">${data.dm.people} người</dd></div>
      </dl>
      <div class="ov-boards">${board('Dùng nhiều nhất trong nhóm', data.group, true)}${board('Nhắn riêng nhiều nhất', data.dm, false)}</div>
      <p class="muted small">Chỉ tính lượt bot thực sự nhận xử lý (được tag, nhóm đang bật, được phép nhắn riêng); tính cả chủ nhân.${data.approx ? ' Số trước ngày cập nhật được dựng lại từ lịch sử trợ lý nên có thể lệch vài lượt trong nhóm.' : ''}</p>`}
  <//>`;
}

const KIND_LABEL = { vision: 'Đọc ảnh', image: 'Vẽ ảnh', video: 'Tạo video' };
const ENGINE_LABEL = { stali: 'Stali', '9router': '9router', codex: 'ChatGPT (Codex)' };
const nf = new Intl.NumberFormat('vi-VN');

/** Sử dụng AI ngoài lượt gọi model chính: đọc ảnh, vẽ ảnh, tạo video — theo loại, nguồn + model, người dùng. */
function AiUse({ usageDays }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setError('');
    api(`/api/ai-events?days=${days}`).then((r) => { if (alive) setData(r); }, (e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [days]);
  const ready = data && data.days === days;
  const inRange = ready ? new Set(data.daily.map((d) => d.date)) : new Set();
  const calls = (usageDays || []).filter((d) => inRange.has(d.date)).reduce((a, d) => a + (d.calls || 0), 0);
  const tot = ready ? data.totals : null;
  const pair = (t) => `${nf.format(t.ok)}${t.failed ? ` · ${nf.format(t.failed)} lỗi` : ''}`;
  return html`<${Card} title="Sử dụng AI" icon="bot" tint="purple" extra="ov-ai-card">
    <div class="chips" role="group" aria-label="Khoảng thời gian">${USE_PERIODS.map(([d, label]) => html`<button key=${d} type="button"
      class="btn btn-secondary btn-sm chip" aria-pressed=${days === d ? 'true' : 'false'} onClick=${() => setDays(d)}>${label}</button>`)}</div>
    ${error ? html`<p class="muted small">${error}</p>` : !ready ? html`<${Spinner} />` : html`
      <dl class="ov-facts ov-ai-facts">
        <div><dt>Lượt gọi AI</dt><dd>${nf.format(calls)}</dd><dd class="ov-small muted">trò chuyện, công cụ</dd></div>
        <div><dt>Đọc ảnh (vision)</dt><dd>${nf.format(tot.vision.ok)}</dd><dd class="ov-small muted">${nf.format(tot.vision.images)} ảnh</dd></div>
        <div><dt>Vẽ ảnh</dt><dd>${pair(tot.image)}</dd><dd class="ov-small muted">${data.fallbacks ? `${nf.format(data.fallbacks)} lần chuyển nguồn dự phòng` : 'thành công'}</dd></div>
        <div><dt>Tạo video</dt><dd>${pair(tot.video)}</dd><dd class="ov-small muted">${nf.format(tot.video.seconds)} giây</dd></div>
      </dl>
      ${data.byModel.length ? html`<div class="table-wrap"><table class="ov-table">
        <thead><tr><th>Việc</th><th>Nguồn</th><th>Model</th><th class="num">Thành công</th><th class="num">Lỗi</th></tr></thead>
        <tbody>${data.byModel.map((m) => html`<tr key=${`${m.kind}|${m.engine}|${m.model}`}>
          <td>${KIND_LABEL[m.kind]}</td><td>${m.kind === 'vision' ? 'Model chính' : (ENGINE_LABEL[m.engine] || (m.engine || '—'))}</td>
          <td><code>${m.model || (m.kind === 'image' ? 'không nguồn nào vẽ được' : '—')}</code></td>
          <td class="num">${nf.format(m.ok)}</td><td class="num">${m.failed ? nf.format(m.failed) : '—'}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted small">Chưa có lượt đọc ảnh, vẽ ảnh hay tạo video nào trong khoảng này.</p>`}
      ${data.top.length ? html`<div class="ov-board"><h3>Dùng nhiều nhất</h3><ol class="ov-rank">${data.top.map((p, i) => html`<li key=${`${p.name}:${i}`}>
        <span class="ov-rank-row"><span class="ov-rank-no">${i + 1}</span>
          <span class="ov-rank-who"><strong>${p.name}${p.owner ? ' (chủ nhân)' : ''}</strong>
            <small class="muted">${[p.vision && `${p.vision} đọc ảnh`, p.image && `${p.image} ảnh`, p.video && `${p.video} video`].filter(Boolean).join(' · ')}</small></span>
          <span class="conv-count">${nf.format(p.total)}</span></span></li>`)}</ol></div>` : null}
      <p class="muted small">Đếm từ khi cài bản này. "Lượt gọi AI" là mọi lần bot gọi model (kể cả khi đọc ảnh, gọi công cụ); đọc ảnh dùng model chính của bot.</p>`}
  <//>`;
}

export function Overview({ me, status: s, update = null }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  const admin = me.role === 'admin';
  const server = useServer();
  const [chats] = usePoll('/api/chats', 30_000);
  const [perms] = usePoll('/api/permissions', 120_000);
  const [sched] = usePoll('/api/schedules', 60_000);
  const [reqs, reloadReqs] = usePoll('/api/contacts/requests', 60_000);
  const [memory] = usePoll('/api/admin/agent-memory', 300_000, admin);
  const notice = update;
  if (!s) return html`<${PageHead} title="Tổng quan" /><${Spinner} />`;

  async function restart() {
    if (!confirm('Khởi động lại trợ lý? Bot sẽ tạm ngừng trả lời trong khoảng một phút.')) return;
    setBusy(true); setMsg({});
    try {
      const r = await api('/api/admin/restart-assistant', { method: 'POST' });
      if (r.sidecarFailed) setMsg({ error: r.warning });
      else setMsg({ ok: 'Đã gửi lệnh khởi động lại — đợi khoảng một phút.' });
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }

  const host = server?.host || null;
  const requests = reqs?.requests || [];
  const items = attentionItems({ status: s, host, requests, memory, notice, admin });
  const index = folderIndex(perms?.folders || []);
  const recent = todayChats(chats?.conversations);
  const jobs = upcomingJobs(sched?.jobs);
  const days = server?.usage?.days || [];
  const aiToday = days.find((d) => d.date === todayVN());
  const week = days.slice(-7).reduce((a, d) => a + (d.calls || 0), 0);
  const today = s.today;
  const z = zaloCard(s);
  const assistantOk = s.sidecar !== 'down' && s.assistant === 'connected';

  return html`
    <${PageHead} title="Tổng quan" sub="Việc cần chú ý, hội thoại hôm nay, lịch sắp chạy — cập nhật liên tục." />
    <div class="ov-strip" role="status">
      <span class=${`ov-pill is-${z.kind}`}><${Icon} name="phone" size=${14} /> Zalo: ${z.kind === 'ok' ? 'đang chạy' : z.kind === 'warn' ? 'đang nối lại' : 'mất kết nối'}</span>
      <span class=${`ov-pill is-${assistantOk ? 'ok' : 'danger'}`}><${Icon} name="bot" size=${14} /> Trợ lý: ${assistantOk ? 'sẵn sàng' : 'chưa phản hồi'}</span>
      <span class="ov-pill"><${Icon} name="chat" size=${14} /> Hôm nay: ${today ? `${today.threads ?? '—'} hội thoại · ${(today.received + today.sent).toLocaleString('vi-VN')} tin` : '—'}</span>
      ${host ? html`<a class=${`ov-pill${Math.max(host.cpuPct, host.ramPct, host.diskPct) >= 85 ? ' is-warn' : ''}`} href="#/health"><${Icon} name="server" size=${14} /> CPU ${Math.round(host.cpuPct)}% · RAM ${Math.round(host.ramPct)}% · Ổ ${Math.round(host.diskPct)}%</a>` : null}
    </div>

    <section class=${`card ov-attention${items.length ? '' : ' is-ok'}`}>
      <div class="ov-head"><span class=${`nav-ico tint-${items.length ? 'orange' : 'green'}`} aria-hidden="true"><${Icon} name=${items.length ? 'warn' : 'check'} size=${18} /></span>
        <h2>${items.length ? `Cần chú ý (${items.length})` : 'Mọi thứ ổn'}</h2></div>
      ${items.length ? html`<ul class="ov-items">${items.map((it, i) => html`<li key=${i} class=${`is-${it.kind}`}>
          ${it.href ? html`<a href=${it.href}>${it.text} <${Icon} name="next" size=${14} /></a>` : html`<span>${it.text}</span>`}
          ${it.action === 'restart' ? html`<button class="btn btn-secondary btn-sm" disabled=${busy} onClick=${restart}><${Icon} name="refresh" size=${14} /> ${busy ? 'Đang gửi lệnh…' : 'Khởi động lại trợ lý'}</button>` : null}
          ${it.requests ? html`<${Requests} list=${requests} folders=${perms?.folders || []} onDone=${reloadReqs} />` : null}
        </li>`)}</ul>` : html`<p class="muted small">Bot đang chạy bình thường, không có lời mời hay lỗi nào cần xử lý.</p>`}
      <${Live} error=${msg.error} ok=${msg.ok} />
    </section>

    <div class="ov-grid">
      <${Card} title="Hội thoại hôm nay" icon="chat" tint="blue" href="#/chats" hrefText="Phiên chat">
        ${!chats ? html`<${Spinner} />` : recent.length ? html`<ul class="ov-chats">${recent.map((c) => html`<li key=${`${c.threadType}:${c.threadId}`}>
            <button type="button" class="ov-chat" onClick=${() => openChat(c)}>
              <span class="ov-chat-top"><strong>${c.name}</strong><span class="conv-count" title=${`${c.today} tin hôm nay`}>${c.today}</span><time>${hhmm(c.lastAtMs)}</time></span>
              <span class="ov-chat-sub">${folderOfThread(index, c.threadId, c.threadType) ? html`<${FolderChip} folder=${folderOfThread(index, c.threadId, c.threadType)} />` : c.threadType === 1 ? html`<span class="tag">Nhóm</span>` : html`<span class="tag">Nhắn riêng</span>`}</span>
            </button></li>`)}</ul>` : html`<p class="muted small">Hôm nay chưa có tin nhắn nào.</p>`}
      <//>
      <div class="ov-side">
      <${Card} title="Lịch hẹn sắp chạy" icon="clock" tint="orange" href="#/schedules" hrefText="Lịch hẹn">
        ${!sched ? html`<${Spinner} />` : jobs.length ? html`<ul class="ov-jobs">${jobs.map((j) => html`<li key=${j.id}>
            <time>${when(j.nextRunAt)}</time><span><strong>${j.name || 'Việc hẹn giờ'}</strong><small class="muted">→ ${j.targetName || '—'}</small></span></li>`)}</ul>`
          : html`<p class="muted small">Không có việc nào chạy trong 2 ngày tới.</p>`}
      <//>
      <${Card} title="AI hôm nay" icon="bot" tint="purple" href="#/health" hrefText="Chi tiết">
        <dl class="ov-facts">
          <div><dt>Lượt gọi AI</dt><dd>${aiToday ? aiToday.calls.toLocaleString('vi-VN') : '0'}</dd></div>
          <div><dt>7 ngày qua</dt><dd>${week.toLocaleString('vi-VN')}</dd></div>
          <div><dt>Chữ vào · ra</dt><dd class="ov-small">${aiToday ? `${compact.format(aiToday.input)} · ${compact.format(aiToday.output)}` : '0'}</dd></div>
        </dl>
        ${days.length ? html`<${Dots} values=${days.map((d) => d.calls)} label="Lượt gọi AI theo ngày" />` : null}
      <//>
      <${Card} title="Lối tắt" icon="list" tint="green">
        <div class="ov-quick">${QUICK.filter((q) => admin || !q[4]).map(([href, icon, text, tint]) => html`<a key=${href} class=${`ov-q tint-${tint}`} href=${href}><span class=${`nav-ico tint-${tint}`} aria-hidden="true"><${Icon} name=${icon} size=${18} /></span>${text}</a>`)}</div>
      <//>
      </div>
      <${BotUses} />
      <${AiUse} usageDays=${days} />
    </div>`;
}
