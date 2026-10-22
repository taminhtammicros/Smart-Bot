// Phiên chat (spec §9): trái là hội thoại + tìm toàn văn; phải là tin nhắn (bot canh phải, khác màu),
// cuộn lên tải tin cũ, ô soạn gửi dưới tên bot. Chữ tin nhắn chỉ đi qua htm — không bao giờ thành HTML.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api, sendFile } from '../api.js';
import { html, Icon, Live, Notice, PageHead, Spinner, fmtTime } from '../ui.js';
import { fold, indexOfFolded, markMatches } from '../fold.js';
import { classifyMedia } from '../media.js';
import { FileCard, Lightbox, MediaPanel, Thumb, VideoCard } from './chat-media.js';
import { PermsIcon, PermsPanel, permsTint } from './chat-perms.js';
import { Avatar, InfoPanel } from './chat-info.js';
import { FolderChip, FolderFilter, folderIndex, folderOfThread, inFolderFilter } from './folder-ui.js';

export { markMatches };

const LIST_MS = 10_000;
const THREAD_MS = 5_000;
const MAX_TEXT = 2000;
const LEAD = 30; // kết quả tìm: chỗ trùng nằm sâu thì cắt bớt phần đầu, chừa lại chừng này ký tự

const TYPE_LABELS = {
  'chat.photo': 'Ảnh', 'chat.sticker': 'Nhãn dán', 'share.file': 'Tệp', 'chat.voice': 'Tin thoại',
  'chat.video.msg': 'Video', 'group.poll': 'Bình chọn', 'chat.recommended': 'Danh thiếp', 'chat.delete': 'Tin đã thu hồi', 'chat.undo': 'Tin đã thu hồi',
  'chat.gif': 'Ảnh động', 'chat.location.new': 'Vị trí', 'chat.link': 'Liên kết',
};

// Zalo gửi link chia sẻ (Drive, Docs…) cũng dưới loại chat.recommended như danh thiếp — gọi đúng tên theo trang.
const SITE_NAMES = [
  ['drive.google.com', 'Google Drive'], ['docs.google.com', 'Google Docs'], ['forms.gle', 'Google Forms'],
  ['forms.google.com', 'Google Forms'], ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'],
  ['facebook.com', 'Facebook'], ['fb.watch', 'Facebook'], ['tiktok.com', 'TikTok'], ['zalo.me', 'Zalo'],
];

export function siteName(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  const hit = SITE_NAMES.find(([h]) => host === h || host.endsWith(`.${h}`));
  return hit ? hit[1] : null;
}

/** Link rút gọn để hiện: tên máy + đường dẫn, cắt bớt nếu dài. */
export function shortUrl(url, max = 48) {
  let s = url;
  try { const u = new URL(url); s = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname); } catch { /* giữ nguyên */ }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const keyOf = (c) => `${c.threadType}:${c.threadId}`;

export function messageView(m) {
  const label = TYPE_LABELS[m.msgType] || null;
  const raw = String(m.text ?? '');
  // Ảnh/tệp/video trên máy chủ Zalo: vẽ thành ảnh thu nhỏ hoặc thẻ (xem chat-media.js).
  const media = classifyMedia(m.msgType, raw);
  if (media) return { label, text: media.kind === 'file' ? '' : media.caption, link: null, media };
  const trimmed = raw.trim();
  if (/^https:\/\/\S+$/.test(trimmed)) {
    const linkLabel = siteName(trimmed) || (m.msgType === 'chat.recommended' ? 'Liên kết' : label) || 'Liên kết';
    return { label: linkLabel, text: '', link: trimmed, media: null };
  }
  // Bot lưu sẵn "[Nhãn dán]"… cho tin không có chữ — nhãn đã nói đủ, không lặp lại.
  return { label, text: label && /^\[[^\]]*\]$/.test(trimmed) ? '' : raw, link: null, media: null };
}

/** Đoạn chữ quanh chỗ trùng: chỗ trùng nằm sâu thì cắt bớt phần đầu. */
export function snippet(text, q) {
  const s = String(text ?? '');
  const at = indexOfFolded(s, q);
  return at > LEAD * 2 ? `…${s.slice(at - LEAD)}` : s;
}

const hits = (text, q) => markMatches(text, q).map((s) => (s.hit ? html`<mark>${s.text}</mark>` : s.text));

export function mergeMessages(a, b) {
  const byId = new Map();
  for (const m of [...a, ...b]) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.ts - y.ts || x.id - y.id);
}

export function preview(c) {
  const v = messageView({ msgType: c.lastMsgType, text: c.lastText });
  return `${c.lastIsSelf ? 'Bot: ' : ''}${v.text || (v.label ? `[${v.label}]` : '')}`;
}

function ConvItem({ c, active, folder, onSelect }) {
  return html`<li><button type="button" class=${`conv conv-ava${active ? ' active' : ''}`} aria-current=${active ? 'true' : undefined} onClick=${() => onSelect(c)}>
    <${Avatar} name=${c.name} group=${c.threadType === 1} url=${c.avatar || ''} />
    <span class="conv-main">
    <span class="conv-top"><span class="conv-name">${c.name}</span>${c.pinned ? html`<span class="conv-pin" title="Đã ghim"><${Icon} name="pin" size=${14} /></span>` : null}${c.today ? html`<span class="conv-count" title=${`${c.today} tin hôm nay`}>${c.today}</span>` : null}<time class="conv-time">${fmtTime(c.lastAtMs)}</time></span>
    <span class="conv-sub">${folder ? html`<${FolderChip} folder=${folder} />` : c.threadType === 1 ? html`<span class="tag">Nhóm</span>` : null}<span class="conv-preview">${preview(c)}</span></span>
    </span>
  </button></li>`;
}

/** "1.234 tin · 56 hôm nay · 3 phiên AI · phiên hiện tại từ 09/10 (120 lượt)" — rỗng khi chưa có số (vd. mở từ kết quả tìm). */
export function convStats(c) {
  if (!Number.isFinite(c?.total)) return '';
  const n = new Intl.NumberFormat('vi-VN');
  const parts = [`${n.format(c.total)} tin`];
  if (c.today) parts.push(`${n.format(c.today)} hôm nay`);
  if (c.ai?.sessions) {
    parts.push(`${n.format(c.ai.sessions)} phiên AI`);
    if (c.ai.startedAt) {
      const d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit' }).format(new Date(c.ai.startedAt));
      parts.push(`phiên hiện tại từ ${d} (${n.format(c.ai.turns || 0)} lượt)`);
    }
  } else parts.push('chưa có phiên AI');
  return parts.join(' · ');
}

function ResultItem({ r, q, onSelect }) {
  const v = messageView(r);
  const who = r.isSelf ? 'Bot: ' : r.senderName ? `${r.senderName}: ` : '';
  const text = snippet(v.text, q);
  return html`<li><button type="button" class="conv" onClick=${() => onSelect({ threadId: r.threadId, threadType: r.threadType, name: r.threadName })}>
    <span class="conv-top"><span class="conv-name">${r.threadName}</span><time class="conv-time">${fmtTime(r.ts)}</time></span>
    <span class="conv-preview conv-wrap">${who}${text ? hits(text, q) : (v.label ? `[${v.label}]` : '')}</span>
  </button></li>`;
}

/** Đang gõ "@abc" ngay trước con trỏ (đầu dòng hoặc sau khoảng trắng) → "abc"; không thì null. */
export function mentionQuery(beforeCaret) {
  const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(String(beforeCaret || ''));
  return m ? m[1] : null;
}

/**
 * Vị trí tag trên nội dung gửi đi (đã cắt khoảng trắng): mỗi tên đã chọn tìm "@Tên" lần lượt từ trái sang;
 * tên đã bị xoá khỏi ô thì bỏ. Trả [{ pos, len, uid? | msg? }].
 */
export function placeMentions(body, picks) {
  const out = [];
  let from = 0;
  for (const p of picks) {
    const tag = `@${p.name}`;
    const pos = body.indexOf(tag, from);
    if (pos < 0) continue;
    out.push({ pos, len: tag.length, ...(p.uid ? { uid: p.uid } : { msg: p.msg }) });
    from = pos + tag.length;
  }
  return out;
}

const LONG_PRESS_MS = 450;

const VN = { timeZone: 'Asia/Ho_Chi_Minh' };
const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { ...VN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
/** Giờ trong bong bóng: "20:51" (ngày đã có ở dải ngăn cách). */
export const clock = (ts) => new Intl.DateTimeFormat('vi-VN', { ...VN, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
/** Dải ngăn cách ngày kiểu Zalo: "Hôm nay", "Hôm qua", "thứ Hai, 13/10/2026". */
export function dayLabel(ts, now = Date.now()) {
  const k = dayKey(ts);
  if (k === dayKey(now)) return 'Hôm nay';
  if (k === dayKey(now - 86_400_000)) return 'Hôm qua';
  return new Intl.DateTimeFormat('vi-VN', { ...VN, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ts));
}
const RUN_GAP_MS = 5 * 60_000;
/** Tin mở đầu một cụm (hiện ảnh đại diện + tên): khác người gửi, khác ngày, hoặc cách tin trước hơn 5 phút. */
export function isLead(prev, m) {
  return !prev || prev.isSelf !== m.isSelf || (prev.senderName || '') !== (m.senderName || '')
    || dayKey(prev.ts) !== dayKey(m.ts) || m.ts - prev.ts > RUN_GAP_MS;
}
export const sameDay = (a, b) => dayKey(a) === dayKey(b);

function Bubble({ m, group, lead = true, focus, onOpenPhoto, active, onActive, onReply, onMention, onRecall }) {
  const v = messageView(m);
  const md = v.media;
  const timer = useRef(0);
  const start = useRef(null);
  // Bấm giữ (điện thoại) hoặc chuột phải → hiện nút Trả lời / Nhắc tên / Chép; máy tính rê chuột là thấy.
  const press = (e) => { const t = e.touches?.[0]; start.current = t ? [t.clientX, t.clientY] : null; clearTimeout(timer.current); timer.current = setTimeout(() => onActive(m.id), LONG_PRESS_MS); };
  const move = (e) => { const t = e.touches?.[0]; if (start.current && t && Math.hypot(t.clientX - start.current[0], t.clientY - start.current[1]) > 10) clearTimeout(timer.current); };
  const release = () => clearTimeout(timer.current);
  const copy = async () => { try { await navigator.clipboard.writeText(v.text || v.link || ''); } catch { /* trình duyệt chặn */ } onActive(null); };
  const recalled = m.msgType === 'chat.undo' || m.msgType === 'chat.delete';
  const canMention = group && !m.isSelf;
  const li = useRef(null);
  // Hiện nút thao tác cho tin sát mép khung (vd. tin cuối) → cuộn cho thấy trọn, kẻo nút bị khung cắt mất.
  useEffect(() => { if (active) li.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [active]);
  const ava = group && !m.isSelf;
  return html`<li ref=${li} id=${`msg-${m.id}`} class=${`msg${m.isSelf ? ' msg-self' : ''}${ava ? ' msg-ava' : ''}${lead ? ' msg-lead' : ''}${focus ? ' msg-focus' : ''}${active ? ' msg-active' : ''}`}>
    ${ava ? html`<span class="msg-ava-slot">${lead ? html`<${Avatar} name=${m.senderName || 'Thành viên'} size="sm" url=${m.avatar || ''} />` : null}</span>` : null}
    <div class="msg-body">
    <div class="msg-row">
    <div class=${`msg-bubble${md ? ' msg-media' : ''}`} onTouchStart=${press} onTouchMove=${move} onTouchEnd=${release} onTouchCancel=${release}
      onContextMenu=${(e) => { e.preventDefault(); onActive(m.id); }}>
      ${ava && lead ? html`<span class="msg-from">${m.senderName || 'Thành viên'}</span>` : null}
      ${md?.kind === 'photo' ? html`<${Thumb} url=${md.url} alt=${md.caption || `Ảnh của ${m.isSelf ? 'bot' : (m.senderName || 'thành viên')}`} onOpen=${() => onOpenPhoto(m.id)} />` : null}
      ${md?.kind === 'file' ? html`<${FileCard} name=${md.name} url=${md.url} ext=${md.ext} />` : null}
      ${md?.kind === 'video' ? html`<${VideoCard} url=${md.url} />` : null}
      ${!md && v.label ? html`<span class="msg-kind">[${v.label}]</span> ` : null}
      ${v.link ? html`<a href=${v.link} target="_blank" rel="noopener noreferrer" title=${v.link}>${shortUrl(v.link)}</a>` : null}
      ${v.text ? html`<span class="msg-text">${v.text}</span>` : null}
      <time class="msg-time" datetime=${new Date(m.ts).toISOString()}>${m.isSelf ? 'Bot · ' : ''}${clock(m.ts)}</time>
    </div>
    ${recalled ? null : html`<span class="msg-actions" role="group" aria-label="Thao tác với tin">
      <button type="button" class="msg-act" onClick=${() => { onReply(m); onActive(null); }} aria-label="Trả lời tin này" title="Trả lời"><${Icon} name="reply" size=${16} /><span>Trả lời</span></button>
      ${canMention ? html`<button type="button" class="msg-act" onClick=${() => { onMention(m); onActive(null); }} aria-label=${`Nhắc tên ${m.senderName || 'thành viên'}`} title="Nhắc tên (@)"><span aria-hidden="true">@</span><span>Nhắc tên</span></button>` : null}
      ${m.isSelf ? html`<button type="button" class="msg-act msg-act-danger" onClick=${() => { onActive(null); onRecall(m); }} aria-label="Thu hồi tin này của bot" title="Thu hồi"><${Icon} name="undo" size=${16} /><span>Thu hồi</span></button>` : null}
      ${v.text || v.link ? html`<button type="button" class="msg-act" onClick=${copy} aria-label="Chép nội dung" title="Chép"><${Icon} name="copy" size=${16} /><span>Chép</span></button>` : null}
    </span>`}
    </div>
    </div>
  </li>`;
}

/** Bảng tìm trong một hội thoại; bấm kết quả thì khung tin nhảy tới đúng tin đó. */
function ThreadSearch({ conv, onJump, onClose }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null); // { q, items, next }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); }, []);

  async function search(e, more = null) {
    e?.preventDefault();
    const term = more ? more.q : q.trim();
    if (term.length < 2 || term.length > 100) { setError('Nhập từ 2 đến 100 ký tự để tìm trong hội thoại này.'); return; }
    const my = ++seq.current;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ type: String(conv.threadType), q: term, ...(more ? { before: more.next } : {}) });
      const r = await api(`/api/chats/${encodeURIComponent(conv.threadId)}/search?${params}`);
      if (my !== seq.current) return;
      setFound((cur) => ({ q: term, items: more && cur ? [...cur.items, ...r.results] : r.results, next: r.nextBefore }));
    } catch (err) {
      if (my === seq.current) setError(err.message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }

  return html`<aside class="side-panel" aria-label="Tìm trong hội thoại" onKeyDown=${(e) => { if (e.key === 'Escape') onClose(); }}>
    <header class="side-head">
      <h3>Tìm trong hội thoại</h3>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onClose} aria-label="Đóng bảng tìm"><${Icon} name="close" /></button>
    </header>
    <form class="chat-search" role="search" onSubmit=${search} novalidate>
      <label for="thread-q" class="sr-only">Từ khoá tìm trong hội thoại này</label>
      <input id="thread-q" ref=${input} type="search" maxlength="100" placeholder="Nhập từ khoá rồi Enter" value=${q}
        onInput=${(e) => setQ(e.currentTarget.value)} />
      <button class="btn btn-secondary btn-sm" disabled=${busy} aria-label="Tìm trong hội thoại"><${Icon} name="search" size=${16} /></button>
    </form>
    <${Live} error=${error} />
    <div class="side-body">
      ${!found
        ? html`<p class="muted small">${busy ? 'Đang tìm…' : 'Tìm không phân biệt hoa thường và dấu: “hoc sinh” cũng thấy “học sinh”.'}</p>`
        : !found.items.length
          ? html`<p class="muted small">Không thấy tin nào có “${found.q}” trong hội thoại này — thử từ khoá ngắn hơn.</p>`
          : html`<p class="muted small" aria-live="polite">Kết quả cho “${found.q}” — bấm để xem tin trong khung chat.</p>
            <ul class="conv-list">${found.items.map((r) => {
              const v = messageView(r);
              const text = snippet(v.text, found.q);
              return html`<li key=${r.id}><button type="button" class="conv" onClick=${() => onJump(r)}>
                <span class="conv-top"><span class="conv-name">${r.isSelf ? 'Bot' : (r.senderName || 'Thành viên')}</span><time class="conv-time">${fmtTime(r.ts)}</time></span>
                <span class="conv-preview conv-wrap">${text ? hits(text, found.q) : (v.label ? `[${v.label}]` : '')}</span>
              </button></li>`;
            })}</ul>`}
      ${found?.next ? html`<button type="button" class="btn btn-ghost btn-sm panel-more" disabled=${busy} onClick=${() => search(null, found)}>${busy ? 'Đang tìm…' : 'Xem thêm kết quả'}</button>` : null}
    </div>
  </aside>`;
}

/**
 * Ô soạn gửi dưới tên bot. Trả lời: thanh "Đang trả lời …" (gửi kèm trích dẫn). Nhóm: gõ "@" hiện danh sách thành viên
 * để gắn tag thật; "Nhắc tên" từ một tin chèn "@Tên " của người gửi tin đó.
 */
// Ảnh/tệp gửi kèm (khớp SEND_FILE_TYPES / MAX_SEND_FILE của routes/chats.js).
export const ATTACH_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md', 'zip', 'rar', '7z', 'mp3', 'm4a', 'wav', 'mp4', 'mov'];
export const ATTACH_MAX = 25 * 1024 * 1024;
const MAX_ATTACH = 10;
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Kiểm một tệp trước khi đưa vào hàng chờ → câu lỗi hoặc ''. */
export function attachProblem(name, size) {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')) || [])[1]?.toLowerCase();
  if (!ext || !ATTACH_TYPES.includes(ext)) return `“${name || 'tệp'}”: loại tệp này không gửi được.`;
  if (size > ATTACH_MAX) return `“${name}” nặng ${sizeText(size)} — tối đa 25 MB.`;
  if (!size) return `“${name}” rỗng.`;
  return '';
}

function Compose({ conv, onSent, reply, onClearReply, mentionReq }) {
  const [files, setFiles] = useState([]); // [{ id, file, preview? }]
  const [drag, setDrag] = useState(false);
  const picker = useRef(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  const [picks, setPicks] = useState([]); // [{ name, uid? , msg? }]
  const [members, setMembers] = useState(null); // null = chưa tải; [] khi lỗi/không có
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(null); // chuỗi sau "@" đang gõ, null = không gợi ý
  const [hi, setHi] = useState(0);
  const area = useRef(null);
  const group = conv.threadType === 1;

  useEffect(() => { setText(''); setPicks([]); setMembers(null); setQuery(null); setFiles([]); }, [conv.threadId]);
  function addFiles(list) {
    const errors = [];
    const next = [];
    for (let f of [...list]) {
      // Ảnh dán từ bộ nhớ tạm không có đuôi thì đặt tên theo giờ.
      if (!/\.[A-Za-z0-9]{1,5}$/.test(f.name || '') && /^image\//.test(f.type)) {
        f = new File([f], `anh-dan-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type });
      }
      const problem = attachProblem(f.name, f.size);
      if (problem) { errors.push(problem); continue; }
      next.push({ id: `${Date.now()}-${Math.random()}`, file: f, preview: null });
    }
    setFiles((cur) => [...cur, ...next].slice(0, MAX_ATTACH));
    if (files.length + next.length > MAX_ATTACH) errors.push(`Mỗi lần gửi tối đa ${MAX_ATTACH} tệp.`);
    // Xem trước ảnh bằng data: URL (CSP chỉ cho ảnh từ chính trang và data:).
    for (const item of next) {
      if (!/^image\//.test(item.file.type) || item.file.size > 8 * 1048576) continue;
      const fr = new FileReader();
      fr.onload = () => setFiles((cur) => cur.map((x) => (x.id === item.id ? { ...x, preview: String(fr.result) } : x)));
      fr.readAsDataURL(item.file);
    }
    setMsg(errors.length ? { error: errors.join(' ') } : {});
  }
  function onPaste(e) {
    const pasted = [...(e.clipboardData?.files || [])];
    if (pasted.length) { e.preventDefault(); addFiles(pasted); }
  }
  function insertAt(pos, removeLen, insert) {
    const el = area.current;
    const next = text.slice(0, pos) + insert + text.slice(pos + removeLen);
    setText(next);
    requestAnimationFrame(() => { if (el) { el.focus(); const c = pos + insert.length; el.setSelectionRange(c, c); } });
  }
  // "Nhắc tên" từ một tin: chèn "@Tên " vào chỗ con trỏ.
  useEffect(() => {
    if (!mentionReq) return;
    const name = mentionReq.name.trim();
    if (!name) return;
    const el = area.current;
    const pos = el ? el.selectionStart ?? text.length : text.length;
    const lead = pos > 0 && !/\s$/.test(text.slice(0, pos)) ? ' ' : '';
    insertAt(pos, 0, `${lead}@${name} `);
    setPicks((p) => [...p, { name, msg: mentionReq.msg }]);
  }, [mentionReq]);
  useEffect(() => { if (reply) area.current?.focus(); }, [reply]);

  async function loadMembers() {
    if (members !== null || loading || !group) return;
    setLoading(true);
    try { setMembers((await api(`/api/chats/${encodeURIComponent(conv.threadId)}/members`)).members); } catch { setMembers([]); } finally { setLoading(false); }
  }
  function onInput(e) {
    const el = e.currentTarget;
    setText(el.value);
    const q = group ? mentionQuery(el.value.slice(0, el.selectionStart)) : null;
    setQuery(q); setHi(0);
    if (q !== null) loadMembers();
  }
  const n = query === null ? '' : fold(query);
  const suggestions = query === null || !members ? [] : members.filter((m) => !n || fold(m.name).includes(n)).slice(0, 8);
  function pick(m) {
    const el = area.current;
    const caret = el ? el.selectionStart : text.length;
    const start = caret - (query?.length ?? 0) - 1;
    insertAt(start, caret - start, `@${m.name} `);
    setPicks((p) => [...p, { name: m.name, uid: m.uid }]);
    setQuery(null);
  }

  async function send(e) {
    e?.preventDefault();
    if (busy) return;
    const body = text.trim();
    if (!body && !files.length) { setMsg({ error: 'Nội dung đang trống — gõ tin nhắn hoặc đính kèm ảnh/tệp rồi gửi.' }); return; }
    if (body.length > MAX_TEXT) { setMsg({ error: `Tin nhắn dài quá ${MAX_TEXT} ký tự — rút gọn hoặc chia làm nhiều tin.` }); return; }
    setBusy(true); setMsg({});
    const mentions = group ? placeMentions(body, picks) : [];
    try {
      // Chữ (kèm trả lời / nhắc tên) đi trước, ảnh/tệp gửi lần lượt sau — mỗi tệp một tin như trên Zalo.
      if (body) {
        await api(`/api/chats/${encodeURIComponent(conv.threadId)}/send`, {
          method: 'POST', body: { text: body, threadType: conv.threadType, ...(reply ? { replyTo: reply.id } : {}), ...(mentions.length ? { mentions } : {}) },
        });
        setText((cur) => (cur.trim() === body ? '' : cur)); setPicks([]); onClearReply();
      }
      let sent = 0;
      for (const item of files) {
        setMsg({ ok: `Đang gửi ${item.file.name}…` });
        await sendFile(`/api/chats/${encodeURIComponent(conv.threadId)}/send-file?type=${conv.threadType}`, item.file);
        sent += 1;
        setFiles((cur) => cur.filter((x) => x.id !== item.id));
      }
      setMsg({ ok: sent ? `Đã gửi${body ? ' tin và' : ''} ${sent} tệp dưới tên bot.` : 'Đã gửi dưới tên bot.' }); onSent();
    } catch (err) {
      // 504: chưa rõ tin đã đi chưa; 409: vừa gửi đúng tin này. Giữ nguyên chữ trong ô, làm mới khung tin để người dùng tự kiểm.
      setMsg({ error: err.message });
      if (err.status === 504 || err.status === 409) onSent();
    } finally { setBusy(false); }
  }
  function onKeyDown(e) {
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[hi] || suggestions[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e);
  }
  // Nút "@" trên hàng công cụ: chèn "@" ở chỗ con trỏ rồi mở danh sách thành viên như khi gõ.
  function startMention() {
    const el = area.current;
    const pos = el ? el.selectionStart ?? text.length : text.length;
    const lead = pos > 0 && !/\s$/.test(text.slice(0, pos)) ? ' ' : '';
    insertAt(pos, 0, `${lead}@`);
    setQuery(''); setHi(0); loadMembers();
  }
  const replyView = reply ? messageView(reply) : null;
  return html`<form class=${`compose${drag ? ' is-drag' : ''}`} onSubmit=${send} novalidate
    onDragOver=${(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
    onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
    onDrop=${(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); } }}>
    ${files.length ? html`<ul class="attach-list" aria-label="Ảnh/tệp sẽ gửi">${files.map((f) => html`<li key=${f.id} class="attach-item">
      ${f.preview ? html`<img src=${f.preview} alt="" />` : html`<span class="attach-ico" aria-hidden="true"><${Icon} name="file" size=${18} /></span>`}
      <span class="attach-name"><span>${f.file.name}</span><small class="muted">${sizeText(f.file.size)}</small></span>
      <button type="button" class="word-x" disabled=${busy} aria-label=${`Bỏ ${f.file.name}`} onClick=${() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}><${Icon} name="close" size=${14} /></button>
    </li>`)}</ul>` : null}
    ${reply ? html`<div class="reply-bar">
      <${Icon} name="reply" size=${16} />
      <span class="reply-main"><strong>Trả lời ${reply.isSelf ? 'Bot' : (reply.senderName || 'thành viên')}</strong>
        <small class="muted reply-text">${replyView.text || (replyView.label ? `[${replyView.label}]` : '')}</small></span>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onClearReply} aria-label="Bỏ trả lời"><${Icon} name="close" size=${16} /></button>
    </div>` : null}
    ${query !== null && group ? html`<ul class="mention-list" role="listbox" aria-label="Chọn người để nhắc tên">
      ${loading ? html`<li class="muted small mention-empty">Đang tải thành viên…</li>` : null}
      ${members && !members.length ? html`<li class="muted small mention-empty">Chưa lấy được danh sách thành viên — vẫn có thể bấm giữ một tin rồi chọn Nhắc tên.</li>` : null}
      ${members && members.length && !suggestions.length ? html`<li class="muted small mention-empty">Không thấy ai tên “${query}”.</li>` : null}
      ${suggestions.map((m, i) => html`<li key=${m.uid} role="option" aria-selected=${i === hi ? 'true' : 'false'}>
        <button type="button" class=${`mention-item${i === hi ? ' active' : ''}`} onMouseDown=${(e) => e.preventDefault()} onClick=${() => pick(m)}>@${m.name}</button></li>`)}
    </ul>` : null}
    <div class="compose-tools" role="toolbar" aria-label="Công cụ soạn tin">
      <input ref=${picker} type="file" class="sr-only" multiple accept=${ATTACH_TYPES.map((x) => `.${x}`).join(',')} tabindex="-1" aria-hidden="true"
        onChange=${(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <button type="button" class="ctool" disabled=${busy} onClick=${() => picker.current?.click()} aria-label="Gửi ảnh" title="Gửi ảnh"><${Icon} name="image" size=${20} /></button>
      <button type="button" class="ctool" disabled=${busy} onClick=${() => picker.current?.click()} aria-label="Đính kèm tệp" title="Đính kèm tệp"><${Icon} name="clip" size=${20} /></button>
      ${group ? html`<button type="button" class="ctool ctool-at" disabled=${busy} onMouseDown=${(e) => e.preventDefault()} onClick=${startMention} aria-label="Nhắc tên thành viên" title="Nhắc tên (@)">@</button>` : null}
      <small class="muted compose-help"><span id="chat-compose-help">Gửi dưới tên bot · dán ảnh (Ctrl+V) hoặc kéo thả tệp${narrow() ? '' : ' · Ctrl+Enter để gửi'}</span> · ${text.length}/${MAX_TEXT}</small>
    </div>
    <div class="compose-row">
      <label for="chat-compose" class="sr-only">Tin nhắn gửi dưới tên bot</label>
      <textarea id="chat-compose" ref=${area} rows="2" maxlength=${MAX_TEXT} value=${text} readOnly=${busy}
        placeholder=${`Nhập ${group ? '@, ' : ''}tin nhắn tới ${conv.name || 'hội thoại'}`}
        aria-describedby="chat-compose-help" aria-autocomplete=${group ? 'list' : undefined} onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${onPaste}
        onBlur=${() => setTimeout(() => setQuery(null), 150)}></textarea>
      <button class="btn btn-primary btn-sm send-btn" disabled=${busy}><${Icon} name="send" size=${16} /> ${busy ? 'Đang gửi…' : 'Gửi'}</button>
    </div>
    <${Live} error=${msg.error} ok=${msg.ok} />
  </form>`;
}

const FLASH_MS = 2500;
const narrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches;
const INFO_KEY = 'zd:chat-info';
/** Màn rộng (≥1400px) mở sẵn bảng Thông tin như Zalo, trừ khi người dùng đã đóng nó (nhớ trên trình duyệt này). */
function infoPreferred() {
  if (typeof window === 'undefined' || !window.matchMedia?.('(min-width: 1400px)').matches) return false;
  try { return localStorage.getItem(INFO_KEY) !== 'closed'; } catch { return true; }
}
function rememberInfo(open) {
  try { localStorage.setItem(INFO_KEY, open ? 'open' : 'closed'); } catch { /* chế độ riêng tư */ }
}

function Thread({ conv, onBack, onPinned, folders = null, onFolders }) {
  const [reply, setReply] = useState(null); // tin đang trả lời
  const [active, setActive] = useState(null); // id tin đang mở nút thao tác (bấm giữ)
  const [mentionReq, setMentionReq] = useState(null); // { name, msg, n } — chèn @Tên vào ô soạn
  useEffect(() => { setReply(null); setActive(null); }, [conv.threadId]);
  const [recallMsg, setRecallMsg] = useState({});
  async function recall(m) {
    const v = messageView(m);
    const preview = (v.text || v.label || '').slice(0, 80);
    if (!confirm(`Thu hồi tin này của bot? Mọi người trong ${conv.threadType === 1 ? 'nhóm' : 'cuộc trò chuyện'} sẽ không xem được nữa.\n\n“${preview}”`)) return;
    setRecallMsg({});
    try {
      await api(`/api/chats/${encodeURIComponent(conv.threadId)}/recall`, { method: 'POST', body: { threadType: conv.threadType, msg: m.id } });
      setRecallMsg({ ok: 'Đã thu hồi tin.' });
      kick.current();
    } catch (err) { setRecallMsg({ error: err.message }); }
  }
  useEffect(() => {
    if (active === null) return undefined;
    const close = (e) => { if (!e.target.closest?.('.msg-actions')) setActive(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [active]);
  const [msgs, setMsgs] = useState(null);
  const [older, setOlder] = useState(null);
  const [newer, setNewer] = useState(null); // khác null: đang xem một đoạn cũ (sau khi nhảy tới kết quả tìm)
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [error, setError] = useState('');
  // Bảng bên phải: 'info' (Thông tin hội thoại, mở sẵn trên màn rộng) | 'search' | 'media' | 'perms'.
  const [keepInfo, setKeepInfo] = useState(infoPreferred);
  const [side, setSide] = useState(() => (infoPreferred() ? 'info' : null));
  const [mediaTab, setMediaTab] = useState('photo');
  const [info, setInfo] = useState(null);   // { name, avatar, members, desc } — từ Zalo qua sidecar
  const [board, setBoard] = useState(null); // { pins, notes, polls } | { error }
  const [pinsOpen, setPinsOpen] = useState(false);
  const [topics, setTopics] = useState([]); // chủ đề nhỏ bot tự gói (spec §20.2); rỗng = chưa có/kho cũ
  const [reminders, setReminders] = useState(null); // null = đang tải; [] khi lỗi/không có
  const [pinned, setPinned] = useState(Boolean(conv.pinned));
  const [pinBusy, setPinBusy] = useState(false);
  const [pinMsg, setPinMsg] = useState({});
  async function togglePin() {
    setPinBusy(true); setPinMsg({});
    try {
      await api(`/api/chats/${encodeURIComponent(conv.threadId)}/pin`, { method: 'POST', body: { threadType: conv.threadType, pinned: !pinned } });
      setPinned(!pinned);
      setPinMsg({ ok: pinned ? 'Đã bỏ ghim hội thoại trên Zalo của bot.' : 'Đã ghim hội thoại lên đầu danh sách (cả trên Zalo của bot).' });
      onPinned?.();
    } catch (err) { setPinMsg({ error: err.message }); } finally { setPinBusy(false); }
  }
  useEffect(() => {
    let alive = true;
    const id = encodeURIComponent(conv.threadId);
    api(`/api/chats/${id}/info?type=${conv.threadType}`).then((r) => { if (alive) setInfo(r.info); }, () => {});
    api(`/api/chats/${id}/topics?type=${conv.threadType}`).then((r) => { if (alive) setTopics(r.topics || []); }, () => { if (alive) setTopics([]); });
    api(`/api/schedules/reminders?threadId=${id}&threadType=${conv.threadType}`).then((r) => { if (alive) setReminders(r.reminders); }, () => { if (alive) setReminders([]); });
    if (conv.threadType !== 1) return () => { alive = false; };
    const load = () => api(`/api/chats/${id}/board`).then((r) => { if (alive) setBoard(r.board); }, (e) => { if (alive) setBoard((b) => b || { error: e.message }); });
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [conv.threadId, conv.threadType]);
  const [flash, setFlash] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { items, index }
  const box = useRef(null);
  const atBottom = useRef(true);   // đang ở đáy → có tin mới thì cuộn theo
  const anchor = useRef(null);     // khoảng cách tới đáy trước khi chèn tin cũ — giữ nguyên chỗ đang đọc
  const scrollTo = useRef(null);   // id tin cần đưa vào giữa khung sau lần vẽ kế tiếp
  const olderBusy = useRef(false);
  const newerBusy = useRef(false);
  const detached = useRef(false);  // đang xem đoạn cũ: không gộp trang mới nhất vào (sẽ hở một khoảng)
  const first = useRef(true);
  const view = useRef(0);          // tăng mỗi lần thay cả khung tin (nhảy tới tin, về tin mới nhất)
  const kick = useRef(() => {});
  const base = `/api/chats/${encodeURIComponent(conv.threadId)}/messages?type=${conv.threadType}`;

  // Poll trang mới nhất 5 s/lần, không chồng yêu cầu; gộp theo id nên tin cũ đã tải không mất.
  useEffect(() => {
    let alive = true; let timer = null; let inflight = false; let again = false;
    const tick = async () => {
      if (inflight) { again = true; return; }
      clearTimeout(timer); inflight = true;
      try {
        const r = await api(base);
        if (!alive) return;
        if (!detached.current) {
          setMsgs((cur) => mergeMessages(cur || [], r.messages));
          if (first.current) { setOlder(r.nextBefore); first.current = false; }
        }
        setError('');
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        inflight = false;
        const next = again ? 0 : THREAD_MS; again = false;
        if (alive) timer = setTimeout(tick, next);
      }
    };
    kick.current = () => {
      if (detached.current) {
        // Về tin mới nhất: bỏ đoạn đang xem, tải lại từ đầu như lúc mới mở hội thoại.
        view.current += 1; detached.current = false; first.current = true;
        setMsgs(null); setOlder(null); setNewer(null);
      }
      atBottom.current = true; tick();
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [base]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (scrollTo.current != null) {
      const target = el.querySelector(`#msg-${scrollTo.current}`);
      // Đưa tin vào giữa khung; tin cao hơn khung thì canh đầu tin.
      if (target) el.scrollTop = target.offsetTop - Math.max(8, (el.clientHeight - target.offsetHeight) / 2);
      scrollTo.current = null;
    } else if (anchor.current != null) { el.scrollTop = el.scrollHeight - anchor.current; anchor.current = null; }
    else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  useEffect(() => {
    if (flash == null) return undefined;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  async function loadOlder() {
    if (!older || olderBusy.current) return;
    olderBusy.current = true; setLoadingOlder(true);
    const v = view.current;
    try {
      const r = await api(`${base}&before=${encodeURIComponent(older)}`);
      if (v !== view.current) return;
      const el = box.current;
      anchor.current = el ? el.scrollHeight - el.scrollTop : null;
      setMsgs((cur) => mergeMessages(r.messages, cur || []));
      setOlder(r.nextBefore);
    } catch (err) { setError(err.message); } finally { olderBusy.current = false; setLoadingOlder(false); }
  }

  async function loadNewer() {
    if (!newer || newerBusy.current) return;
    newerBusy.current = true; setLoadingNewer(true);
    const v = view.current;
    try {
      const r = await api(`${base}&after=${encodeURIComponent(newer)}`);
      if (v !== view.current) return;
      setMsgs((cur) => mergeMessages(cur || [], r.messages));
      setNewer(r.nextAfter);
      if (!r.nextAfter) detached.current = false; // đã nối tới tin mới nhất — poll gộp tiếp như thường
    } catch (err) { setError(err.message); } finally { newerBusy.current = false; setLoadingNewer(false); }
  }

  async function jumpTo(hit) {
    const v = ++view.current;
    const was = detached.current;
    detached.current = true;
    try {
      const r = await api(`${base}&around=${encodeURIComponent(`${hit.ts}:${hit.id}`)}`);
      if (v !== view.current) return;
      atBottom.current = false; anchor.current = null; scrollTo.current = hit.id; first.current = false;
      setMsgs(r.messages); setOlder(r.nextBefore); setNewer(r.nextAfter);
      if (!r.nextAfter) detached.current = false;
      setFlash(hit.id); setError('');
      // Điện thoại: bảng tìm phủ cả màn hình — đóng để thấy tin, tiêu điểm về khung tin.
      if (narrow()) { setSide(null); setTimeout(() => box.current?.focus({ preventScroll: true }), 0); }
    } catch (err) {
      if (v === view.current) { detached.current = was; setError(err.message); }
    }
  }

  function onScroll(e) {
    const el = e.currentTarget;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = !newer && fromBottom < 40;
    if (el.scrollTop < 40) loadOlder();
    if (newer && fromBottom < 80) loadNewer();
  }

  function openPhoto(id) {
    const items = (msgs || []).flatMap((m) => {
      const md = m.id && classifyMedia(m.msgType, m.text);
      return md?.kind === 'photo' ? [{ id: m.id, url: md.url, caption: md.caption, senderName: m.isSelf ? 'Bot' : m.senderName, ts: m.ts }] : [];
    });
    const index = items.findIndex((x) => x.id === id);
    if (index >= 0) setLightbox({ items, index });
  }

  const back = keepInfo ? 'info' : null;
  const toggle = (name) => setSide((cur) => (cur === name ? back : name));
  const toggles = { search: useRef(null), info: useRef(null), perms: useRef(null) };
  // Đóng bảng thì về bảng Thông tin (nếu đang ghim mở) và trả tiêu điểm về nút đã mở nó.
  const closeSide = (name) => { setSide(back); setTimeout(() => (toggles[name] || toggles.info).current?.focus(), 0); };
  function toggleInfo() {
    const open = side !== 'info';
    setKeepInfo(open); rememberInfo(open); setSide(open ? 'info' : null);
  }
  const group = conv.threadType === 1;
  const stats = convStats(conv);
  return html`
    <header class="chat-head">
      <button type="button" class="btn btn-ghost btn-sm only-mobile chat-back" onClick=${onBack} aria-label="Về danh sách hội thoại">←</button>
      <${Avatar} name=${conv.name} group=${group} url=${info?.avatar || ''} />
      <div class="chat-head-main">
        <h2 title=${conv.name}>${conv.name}</h2>
        <p class="muted small chat-head-sub" title=${stats || undefined}>${group ? 'Nhóm' : 'Nhắn riêng'}${group && info?.members
          ? html` · <${Icon} name="users" size=${14} /> ${new Intl.NumberFormat('vi-VN').format(info.members)} thành viên` : stats ? html` · <span>${stats}</span>` : null}</p>
      </div>
      <div class="chat-head-tools">
      <button type="button" ref=${toggles.search} class=${`btn btn-ghost btn-sm head-tool${side === 'search' ? ' active' : ''}`} aria-pressed=${side === 'search' ? 'true' : 'false'}
        onClick=${() => toggle('search')} aria-label="Tìm trong hội thoại" title="Tìm tin nhắn"><${Icon} name="search" /></button>
      <button type="button" ref=${toggles.perms} class=${`btn btn-ghost btn-sm head-tool head-perms ${permsTint()}${side === 'perms' ? ' active' : ''}`} aria-pressed=${side === 'perms' ? 'true' : 'false'}
        onClick=${() => toggle('perms')} aria-label=${group ? 'Quyền của bot trong nhóm này' : 'Quyền nhắn riêng của người này'} title="Phân quyền Bot"><${PermsIcon} /></button>
      <button type="button" ref=${toggles.info} class=${`btn btn-ghost btn-sm head-tool${side === 'info' ? ' active' : ''}`} aria-pressed=${side === 'info' ? 'true' : 'false'}
        onClick=${toggleInfo} aria-label="Thông tin hội thoại" title="Thông tin hội thoại"><${Icon} name="sidebar" /></button>
      </div>
    </header>
    ${(board?.pins || []).length ? html`<div class="pin-bar">
      <button type="button" class="pin-main" disabled=${!board.pins[0].ref} onClick=${() => board.pins[0].ref && jumpTo(board.pins[0].ref)}>
        <span class="pin-ico" aria-hidden="true"><${Icon} name="chat" size=${18} /></span>
        <span class="pin-text"><strong>Tin nhắn</strong><span class="muted">${board.pins[0].sender ? `${board.pins[0].sender}: ` : ''}${board.pins[0].text || '[Tin không có chữ]'}</span></span>
      </button>
      ${board.pins.length > 1 ? html`<button type="button" class="btn btn-secondary btn-sm pin-more" aria-expanded=${pinsOpen ? 'true' : 'false'} onClick=${() => setPinsOpen(!pinsOpen)}>
        +${board.pins.length - 1} ghim <${Icon} name=${pinsOpen ? 'prev' : 'next'} size=${14} /></button>` : null}
      ${pinsOpen ? html`<ul class="pin-list">${board.pins.map((p) => html`<li key=${p.id}>
        <button type="button" class="pin-row" disabled=${!p.ref} onClick=${() => { setPinsOpen(false); jumpTo(p.ref); }}>
          <span class="muted small">${p.sender || 'Tin ghim'}</span><span>${p.text || '[Tin không có chữ]'}</span></button></li>`)}</ul>` : null}
    </div>` : null}
    <${Live} error=${error || recallMsg.error || pinMsg.error} ok=${recallMsg.ok || pinMsg.ok} />
    ${newer ? html`<div class="jump-bar"><span class="muted small">Đang xem tin cũ.</span>
      <button type="button" class="btn btn-secondary btn-sm" onClick=${() => kick.current()}>Về tin mới nhất ↓</button></div>` : null}
    ${msgs === null ? (error ? null : html`<${Spinner} />`) : html`
      <ol class="msgs" ref=${box} tabindex="0" onScroll=${onScroll} aria-label=${`Tin nhắn với ${conv.name}`}>
        <li class="msgs-top">
          ${older
            ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${loadingOlder} onClick=${loadOlder}>${loadingOlder ? 'Đang tải…' : 'Tải tin cũ hơn'}</button>`
            : html`<span class="muted small">${msgs.length ? 'Đầu cuộc trò chuyện' : 'Chưa có tin nhắn nào.'}</span>`}
        </li>
        ${msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const day = !prev || !sameDay(prev.ts, m.ts);
          return html`${day ? html`<li key=${`d${m.id}`} class="msg-day"><span>${dayLabel(m.ts)}</span></li>` : null}<${Bubble} key=${m.id} m=${m} group=${group} lead=${isLead(prev, m)} focus=${flash === m.id} onOpenPhoto=${openPhoto}
          active=${active === m.id} onActive=${setActive} onReply=${setReply}
          onMention=${(x) => setMentionReq({ name: x.senderName || '', msg: x.id, n: Date.now() })} onRecall=${recall} />`;
        })}
        ${newer ? html`<li class="msgs-top"><button type="button" class="btn btn-ghost btn-sm" disabled=${loadingNewer} onClick=${loadNewer}>${loadingNewer ? 'Đang tải…' : 'Tải tin mới hơn'}</button></li>` : null}
      </ol>`}
    <${Compose} conv=${conv} onSent=${() => kick.current()} reply=${reply} onClearReply=${() => setReply(null)} mentionReq=${mentionReq} />
    ${side === 'search' ? html`<${ThreadSearch} conv=${conv} onJump=${jumpTo} onClose=${() => closeSide('search')} />` : null}
    ${side === 'perms' ? html`<${PermsPanel} conv=${conv} onClose=${() => closeSide('perms')} />` : null}
    ${side === 'media' ? html`<${MediaPanel} key=${mediaTab} conv=${conv} initialTab=${mediaTab} onClose=${() => closeSide('media')} onOpenPhoto=${(items, index) => setLightbox({ items, index })} />` : null}
    ${side === 'info' ? html`<${InfoPanel} conv=${conv} info=${info} board=${board} topics=${topics} reminders=${reminders} pinned=${pinned} pinBusy=${pinBusy} onPin=${togglePin} onJump=${(ref) => ref && jumpTo(ref)} statsText=${stats} onClose=${toggleInfo} onTool=${(name) => setSide(name)} folders=${folders} onFolders=${onFolders}
      onOpen=${(tab) => { setMediaTab(tab); setSide('media'); }} onOpenPhoto=${(items, index) => setLightbox({ items, index })} />` : null}
    ${lightbox ? html`<${Lightbox} items=${lightbox.items} index=${lightbox.index}
      onIndex=${(index) => setLightbox((cur) => ({ ...cur, index }))} onClose=${() => setLightbox(null)} />` : null}`;
}

export function Chats() {
  const [list, setList] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(null); // { q, items, next } khi đang xem kết quả tìm
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  // Bấm một hội thoại ở Tổng quan → mở thẳng hội thoại đó (Tổng quan đặt khoá này trước khi chuyển trang).
  const [selected, setSelected] = useState(() => {
    try {
      const raw = sessionStorage.getItem('zd:open-chat');
      sessionStorage.removeItem('zd:open-chat');
      const c = raw ? JSON.parse(raw) : null;
      return c && c.threadId ? { threadId: String(c.threadId), threadType: Number(c.threadType), name: String(c.name || '') } : null;
    } catch { return null; }
  });
  const [folders, setFolders] = useState([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false); // chưa đọc được Phân quyền thì không hiện ô Thư mục
  const [folderFilter, setFolderFilter] = useState('all');
  const searchSeq = useRef(0); // bỏ kết quả về muộn của lần tìm đã bị thay hoặc huỷ

  useEffect(() => {
    let alive = true; let timer = null;
    const tick = async () => {
      try {
        const r = await api('/api/chats');
        if (!alive) return;
        setList(r.conversations); setUnavailable(Boolean(r.unavailable)); setListError('');
      } catch (err) {
        if (alive) { setListError(err.message); setList((cur) => cur || []); }
      }
      if (alive) timer = setTimeout(tick, LIST_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  // Thư mục (nhóm + người) từ Phân quyền Bot — chỉ để lọc và tô màu; không đọc được thì danh sách vẫn như cũ.
  useEffect(() => {
    let alive = true;
    const load = () => api('/api/permissions').then((r) => { if (alive) { setFolders(r.folders || []); setFoldersLoaded(true); } }, () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const index = folderIndex(folders);
  const folderOf = (c) => folderOfThread(index, c.threadId, c.threadType);

  function clearSearch() { searchSeq.current += 1; setFound(null); setSearching(false); setSearchError(''); }

  async function search(e, more = null) {
    e?.preventDefault();
    // "Xem thêm" tiếp tục đúng từ khoá đã tìm, kể cả khi ô tìm đã bị sửa.
    const q = more ? more.q : query.trim();
    if (q.length < 2 || q.length > 100) { setSearchError('Nhập từ 2 đến 100 ký tự để tìm trong tin nhắn.'); return; }
    const seq = ++searchSeq.current;
    setSearching(true); setSearchError('');
    try {
      const params = new URLSearchParams(more ? { q, before: more.next } : { q });
      const r = await api(`/api/chats/search?${params}`);
      if (seq !== searchSeq.current) return;
      setFound((cur) => ({ q, items: more && cur ? [...cur.items, ...r.results] : r.results, next: r.nextBefore }));
    } catch (err) {
      if (seq === searchSeq.current) setSearchError(err.message);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }

  const needle = fold(query.trim());
  const shown = (list || []).filter((c) => (!needle || fold(c.name).includes(needle)) && inFolderFilter(folderFilter, folderOf(c)));
  let left;
  if (found) {
    left = html`
      <div class="row found-head">
        <span class="muted small">${found.items.length ? `Kết quả cho “${found.q}”` : `Không thấy tin nào có “${found.q}”.`}</span>
        <button type="button" class="link" onClick=${() => { clearSearch(); setQuery(''); }}>Quay lại danh sách</button>
      </div>
      <ul class="conv-list">${found.items.map((r) => html`<${ResultItem} key=${r.id} r=${r} q=${found.q} onSelect=${setSelected} />`)}</ul>
      ${found.next ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${searching} onClick=${() => search(null, found)}>${searching ? 'Đang tìm…' : 'Xem thêm kết quả'}</button>` : null}`;
  } else if (list === null) {
    left = html`<${Spinner} />`;
  } else if (!shown.length) {
    left = html`<p class="muted small">${!list.length ? 'Chưa có hội thoại nào.' : folderFilter !== 'all' && !needle ? 'Thư mục này chưa có hội thoại nào.' : 'Không có hội thoại nào trùng tên — bấm Enter để tìm trong nội dung tin nhắn.'}</p>`;
  } else {
    left = html`<ul class="conv-list">${shown.map((c) => html`<${ConvItem} key=${keyOf(c)} c=${c} folder=${folderOf(c)}
      active=${Boolean(selected) && keyOf(selected) === keyOf(c)} onSelect=${setSelected} />`)}</ul>`;
  }

  return html`
    <${PageHead} title="Phiên chat" sub="Xem tin nhắn của bot và nhắn tay dưới tên bot khi cần." />
    ${unavailable ? html`<${Notice} kind="info">Chưa có lịch sử trò chuyện — bot cần đăng nhập Zalo và nhận tin trước. Nếu bot đã chạy lâu mà vẫn thấy dòng này, hãy báo người cài đặt.<//>` : null}
    <div class=${`chat${selected ? ' has-thread' : ''}`}>
      <section class="card chat-list" aria-label="Hội thoại">
        <form class="chat-search" role="search" onSubmit=${search} novalidate>
          <label for="chat-q" class="sr-only">Lọc theo tên, hoặc Enter để tìm trong tin nhắn</label>
          <input id="chat-q" type="search" maxlength="100" placeholder="Lọc tên, Enter để tìm trong tin nhắn" value=${query}
            onInput=${(e) => { setQuery(e.currentTarget.value); if (!e.currentTarget.value) clearSearch(); }} />
          <button class="btn btn-secondary btn-sm" disabled=${searching} aria-label="Tìm trong tin nhắn"><${Icon} name="search" size=${16} /></button>
        </form>
        ${found ? null : html`<${FolderFilter} folders=${folders} items=${list || []} of=${folderOf} value=${folderFilter} onChange=${setFolderFilter} label="Lọc hội thoại theo thư mục" />`}
        <${Live} error=${searchError || listError} />
        ${left}
      </section>
      <section class="card chat-thread" aria-label="Tin nhắn">
        ${selected
          ? html`<${Thread} key=${keyOf(selected)} conv=${selected} folders=${foldersLoaded ? folders : null} onFolders=${(r) => setFolders(r.folders || [])}
            onBack=${() => setSelected(null)} onPinned=${() => setList((cur) => {
              // Ghim/bỏ ghim: đổi ngay trong danh sách (đã ghim lên đầu), không chờ lượt làm mới 10 giây.
              const next = (cur || []).map((c) => (keyOf(c) === keyOf(selected) ? { ...c, pinned: !c.pinned } : c));
              return [...next.filter((c) => c.pinned), ...next.filter((c) => !c.pinned)];
            })} />`
          : html`<p class="muted chat-empty">Chọn một hội thoại bên trái để xem tin nhắn.</p>`}
      </section>
    </div>`;
}
