// Phiên chat kiểu Zalo: ảnh đại diện và bảng "Thông tin hội thoại" bên phải (ảnh/video, tệp, link gần đây, lối vào
// Phân quyền và Tìm tin nhắn). Danh sách đầy đủ vẫn ở MediaPanel (chat-media.js).
import { useEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Icon, fmtTime } from '../ui.js';
import { FileBadge, Thumb, useProxiedImage } from './chat-media.js';
import { FolderAssign } from './move-to-folder.js';

const AVATAR_TINTS = 10; // .av-0 … .av-9 trong style.css (CSP: không dùng style nội tuyến)

/** Chữ cái đầu để vẽ ảnh đại diện: bỏ ký tự trang trí, lấy chữ đầu của từ cuối (tên riêng kiểu Việt) — "Lương Hải Anh" → "A". */
export function initialOf(name) {
  const words = String(name || '').normalize('NFC').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const w = words.length > 1 && /^\p{L}/u.test(words.at(-1)) ? words.at(-1) : words[0];
  return w ? w[0].toLocaleUpperCase('vi-VN') : '?';
}

/** Số màu (0…9) cố định theo tên — cùng một người luôn cùng màu. */
export function tintOf(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % AVATAR_TINTS;
}

/** Ảnh thật qua bộ tải ảnh của dashboard (chung hàng chờ với ảnh thu nhỏ); chưa tải xong hoặc lỗi → chữ cái đầu. */
function AvatarImg({ url, fallback }) {
  const img = useProxiedImage(url);
  const tries = useRef(0);
  // Bộ tải ảnh giới hạn số ảnh mỗi người — ảnh đại diện bị từ chối lúc bận thì tự thử lại vài lần, cách nhau một chút.
  useEffect(() => {
    if (img.phase !== 'busy' || tries.current >= 3) return undefined;
    const t = setTimeout(() => { tries.current += 1; img.retry(); }, 2000 + Math.random() * 3000);
    return () => clearTimeout(t);
  }, [img.phase]);
  if (img.phase !== 'ok' || !img.ready) return fallback;
  return html`<img key=${img.src} src=${img.src} alt="" decoding="async" onLoad=${img.onLoad} onError=${img.onError} />`;
}

/** size: 'sm' (36px, trong khung tin) | 'md' (44px, danh sách + đầu khung) | 'lg' (64px, bảng Thông tin). url: ảnh Zalo (nếu có). */
export function Avatar({ name, size = 'md', group = false, url = '' }) {
  const fallback = group && size !== 'sm' ? html`<${Icon} name="users" size=${size === 'lg' ? 28 : 20} />` : initialOf(name);
  return html`<span class=${`avatar av-${size} av-${tintOf(name)}`} aria-hidden="true">
    ${url ? html`<${AvatarImg} key=${url} url=${url} fallback=${fallback} />` : fallback}</span>`;
}

const RECENT = { photo: 8, file: 3, link: 3 };
const num = (n) => new Intl.NumberFormat('vi-VN').format(n);

/** Mục "Bảng tin" của nhóm (chỉ đọc) kiểu Zalo: 3 dòng gọn Tin ghim · Ghi chú · Bình chọn, bấm dòng nào mở danh sách dòng đó. */
function Bulletin({ board, reminders, group, onJump }) {
  const [open, setOpen] = useState(true);
  const [kind, setKind] = useState(null); // 'pins' | 'notes' | 'polls'
  const rows = [...(group ? [['pins', 'pin', 'Tin ghim'], ['notes', 'file', 'Ghi chú'], ['polls', 'chart', 'Bình chọn']] : []), ['reminders', 'clock', 'Nhắc hẹn']];
  const data = { pins: [], notes: [], polls: [], ...(board && !board.error ? board : {}), reminders: Array.isArray(reminders) ? reminders : [] };
  const loading = (group && !board) || reminders === null;
  const failed = group && board?.error;
  const list = (k) => {
    if (k === 'pins') {
      return board.pins.map((p) => html`<li key=${p.id}>
        <button type="button" class="board-item" disabled=${!p.ref} onClick=${() => onJump(p.ref)} title=${p.ref ? 'Xem tin này trong khung chat' : 'Tin này không có trong lịch sử của bot'}>
          <span class="board-main"><small class="muted">${p.sender || 'Tin ghim'}</small><span class="board-text">${p.text || '[Tin không có chữ]'}</span></span>
        </button></li>`);
    }
    if (k === 'reminders') {
      return data.reminders.map((r) => html`<li key=${r.id}><div class="board-item"><span class="board-main">
        <small class="muted">${r.startAt ? fmtTime(r.startAt) : 'Chưa đặt giờ'}${r.repeat ? ' · lặp lại' : ''}${r.mine ? ' · bot tạo' : ''}</small>
        <span class="board-text">${r.title || '[Không có tiêu đề]'}</span></span></div></li>`);
    }
    if (k === 'notes') return board.notes.map((n) => html`<li key=${n.id}><div class="board-item"><span class="board-main"><span class="board-text">${n.text}</span></span></div></li>`);
    return board.polls.map((v) => html`<li key=${v.id}><div class="board-item">
      <span class="board-main"><small class="muted">${v.closed ? 'Đã khoá · ' : ''}${num(v.votes)} lượt bình chọn</small><span class="board-text">${v.question}</span>
        <ul class="poll-opts">${v.options.map((o, i) => html`<li key=${i}><span>${o.text}</span><b>${num(o.votes)}</b></li>`)}</ul></span></div></li>`);
  };
  return html`<section class="info-sec">
    <button type="button" class="info-sec-head" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      <span>${group ? 'Bảng tin nhóm' : 'Nhắc hẹn'}</span><span class=${`info-caret${open ? ' open' : ''}`} aria-hidden="true"><${Icon} name="next" size=${16} /></span></button>
    ${open ? html`<div class="info-sec-body">
      ${loading ? html`<p class="muted small">Đang tải…</p>`
        : failed ? html`<p class="muted small">${board.error}</p>`
          : html`<ul class="board-rows">${rows.map(([k, icon, label]) => html`<li key=${k}>
            <button type="button" class="board-row" aria-expanded=${kind === k ? 'true' : 'false'} disabled=${!data[k].length} onClick=${() => setKind(kind === k ? null : k)}>
              <span class="board-ico" aria-hidden="true"><${Icon} name=${icon} size=${16} /></span>
              <span class="board-label">${label}</span><span class="muted small">${data[k].length ? num(data[k].length) : 'Chưa có'}</span>
            </button>
            ${kind === k ? html`<ul class="board-list">${list(k)}</ul>` : null}
          </li>`)}</ul>`}
    </div>` : null}
  </section>`;
}

function useRecent(conv, kind) {
  const [state, setState] = useState(null); // { items } | { error }
  useEffect(() => {
    let alive = true;
    api(`/api/chats/${encodeURIComponent(conv.threadId)}/media?type=${conv.threadType}&kind=${kind}`)
      .then((r) => { if (alive) setState({ items: r.items.slice(0, RECENT[kind]), more: r.items.length > RECENT[kind] || Boolean(r.nextBefore) }); },
        (e) => { if (alive) setState({ error: e.message }); });
    return () => { alive = false; };
  }, [conv.threadId, conv.threadType, kind]);
  return state;
}

function Section({ title, state, onAll, empty, children }) {
  const [open, setOpen] = useState(true);
  return html`<section class="info-sec">
    <button type="button" class="info-sec-head" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      <span>${title}</span><span class=${`info-caret${open ? ' open' : ''}`} aria-hidden="true"><${Icon} name="next" size=${16} /></span></button>
    ${open ? html`<div class="info-sec-body">
      ${!state ? html`<p class="muted small">Đang tải…</p>`
        : state.error ? html`<p class="muted small">${state.error}</p>`
          : !state.items.length ? html`<p class="muted small">${empty}</p>` : children}
      ${state?.items?.length ? html`<button type="button" class="btn btn-secondary btn-sm info-all" onClick=${onAll}>Xem tất cả</button>` : null}
    </div>` : null}
  </section>`;
}

/**
 * Bảng "Thông tin hội thoại" (giống cột phải của Zalo). onOpen(tab) mở bảng Ảnh/Video · Tệp · Link ở đúng tab;
 * onTool('perms' | 'search') mở Phân quyền / Tìm tin nhắn ngay trong cột này.
 */
export function InfoPanel({ conv, info, board, reminders, topics = [], pinned, pinBusy, onPin, statsText, onClose, onOpen, onTool, onOpenPhoto, onJump, folders = null, onFolders }) {
  const group = conv.threadType === 1;
  const photos = useRecent(conv, 'photo');
  const files = useRecent(conv, 'file');
  const links = useRecent(conv, 'link');
  const stills = (photos?.items || []).filter((x) => !x.video);
  return html`<aside class="side-panel info-panel" aria-label="Thông tin hội thoại" onKeyDown=${(e) => { if (e.key === 'Escape' && !document.querySelector('.lightbox')) onClose(); }}>
    <header class="side-head">
      <h3>Thông tin ${group ? 'nhóm' : 'hội thoại'}</h3>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onClose} aria-label="Đóng bảng thông tin"><${Icon} name="close" /></button>
    </header>
    <div class="side-body">
      <div class="info-id">
        <${Avatar} name=${conv.name} size="lg" group=${group} url=${info?.avatar || ''} />
        <strong class="info-name">${conv.name}</strong>
        <span class="muted small">${group ? `Nhóm${info?.members ? ` · ${num(info.members)} thành viên` : ''}` : 'Nhắn riêng'}</span>
        ${info?.desc ? html`<span class="small info-desc">${info.desc}</span>` : null}
        ${statsText ? html`<span class="muted small info-stats">${statsText}</span>` : null}
      </div>
      <div class="info-actions">
        <button type="button" class=${`info-act${pinned ? ' is-on' : ''}`} disabled=${pinBusy} aria-pressed=${pinned ? 'true' : 'false'} onClick=${onPin}>
          <span class="info-act-ico"><${Icon} name="pin" size=${18} /></span>${pinned ? 'Bỏ ghim' : 'Ghim hội thoại'}</button>
        <button type="button" class="info-act" onClick=${() => onTool('perms')}><span class="info-act-ico"><${Icon} name="shield" size=${18} /></span>Phân quyền</button>
        <button type="button" class="info-act" onClick=${() => onTool('search')}><span class="info-act-ico"><${Icon} name="search" size=${18} /></span>Tìm tin nhắn</button>
        <button type="button" class="info-act" onClick=${() => onOpen('photo')}><span class="info-act-ico"><${Icon} name="image" size=${18} /></span>Ảnh, tệp, link</button>
      </div>
      ${folders ? html`<${FolderAssign} key=${`${conv.threadType}:${conv.threadId}`} conv=${conv} folders=${folders} onChanged=${onFolders} />` : null}
      <${Bulletin} board=${board} reminders=${reminders} group=${group} onJump=${onJump} />
      ${topics.length ? html`<div class="info-topics">
        <h4 class="info-topics-title">Chủ đề gần đây</h4>
        <ul class="media-list">${topics.slice(0, 6).map((t) => html`<li key=${t.topicId} class="media-row topic-row">
          <span class="link-ico" aria-hidden="true"><${Icon} name="brain" size=${16} /></span>
          <span class="media-main"><span class="file-name">${t.title || 'Chủ đề'}</span>
            <span class="muted small">${t.messageCount} tin · ${t.status === 'open' ? 'đang nói' : 'đã gói'}</span></span>
        </li>`)
        }</ul>
      </div>` : null}
      <${Section} title="Ảnh/Video" state=${photos} onAll=${() => onOpen('photo')} empty="Chưa có ảnh hay video nào.">
        <ul class="media-grid info-grid">${(photos?.items || []).map((x) => html`<li key=${x.id}>
          ${x.video
            ? html`<a class="media-tile media-video" href=${x.url} target="_blank" rel="noopener noreferrer" aria-label=${`Mở video, ${fmtTime(x.ts)}`}><${Icon} name="play" size=${22} /></a>`
            : html`<${Thumb} className="media-tile" compact url=${x.url} alt=${`Ảnh của ${x.isSelf ? 'bot' : (x.senderName || 'thành viên')}, ${fmtTime(x.ts)}`}
                onOpen=${() => onOpenPhoto(stills, stills.indexOf(x))} />`}
        </li>`)}</ul>
      <//>
      <${Section} title="File" state=${files} onAll=${() => onOpen('file')} empty="Chưa có tệp nào.">
        <ul class="media-list">${(files?.items || []).map((x) => html`<li key=${x.id}>
          <a class="media-row media-link" href=${x.url} target="_blank" rel="noopener noreferrer" aria-label=${`Tải về ${x.name}`}>
            <${FileBadge} ext=${x.ext} />
            <span class="media-main"><span class="file-name">${x.name}</span><span class="muted small">${fmtTime(x.ts)}</span></span>
          </a></li>`)}</ul>
      <//>
      <${Section} title="Link" state=${links} onAll=${() => onOpen('link')} empty="Chưa có link nào.">
        <ul class="media-list">${(links?.items || []).map((x) => html`<li key=${x.id}>
          <a class="media-row media-link" href=${x.url} target="_blank" rel="noopener noreferrer">
            <span class="link-ico" aria-hidden="true"><${Icon} name="link" size=${16} /></span>
            <span class="media-main"><span class="link-text">${x.title || x.url}</span><span class="link-host">${x.host}</span></span>
          </a></li>`)}</ul>
      <//>
    </div>
  </aside>`;
}
