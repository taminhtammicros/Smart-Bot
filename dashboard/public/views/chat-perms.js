// Bảng "Quyền" ngay trong Phiên chat, để không phải đổi sang tab Phân quyền Bot (tab đó vẫn giữ đủ mọi mục).
// Nhóm: đúng trình sửa quyền nhóm của tab Phân quyền. Chat riêng: chỉ quyền nhắn riêng của đúng người đang xem
// (cho/không cho nhắn riêng với bot, tính năng riêng) — ghi cùng tệp, cùng API, cùng Nhật ký với tab Phân quyền.
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Icon, Notice, SaveBar, Spinner, Toggle } from '../ui.js';
import { Editor, baseOfGroup, mergeGroups } from './permissions.js';
import { addPerson, dmDraft, dmPayload, folderOfPeople, sameDm, WHO_OPTIONS } from './dm-permissions.js';
import { lockedByPolicy } from './studio-box.js';
import { tintOf } from './shell.js';

/** Ô biểu tượng khiên cùng màu với mục "Phân quyền Bot" ở thanh bên (đổi màu ở đó thì ở đây đổi theo). */
export const permsTint = () => `tint-${tintOf('/permissions')}`;
export function PermsIcon({ size = 14 }) {
  return html`<span class=${`nav-ico perms-ico ${permsTint()}`} aria-hidden="true"><${Icon} name="shield" size=${size} /></span>`;
}

const UID = /^[1-9]\d{14,21}$/;
const LEAVE = 'Bạn có thay đổi quyền chưa lưu. Bỏ thay đổi và đóng?';

/** Người này đang được nhắn riêng với bot không (chủ nhân luôn được — không xét ở đây). */
export function dmStatus(dm, uid, folder = null) {
  const person = dm.people.find((p) => p.uid === uid) || null;
  // Người trong thư mục được tính là có trong danh sách nhắn riêng (giống kết nối Zalo và plugin).
  return { person, allowed: dm.who === 'everyone' || (dm.who === 'list' && Boolean(person || folder)) };
}

/**
 * Bật/tắt một người trong danh sách nhắn riêng. Bật khi đang "Chỉ chủ nhân" thì chuyển sang "Chủ nhân và những người
 * trong danh sách" (người khác vẫn bị chặn như cũ vì chỉ thêm đúng người này). → `{ draft }` hoặc `{ error }`.
 */
export function setPersonAllowed(draft, uid, name, on) {
  if (!on) return { draft: { ...draft, people: draft.people.filter((p) => p.uid !== uid) } };
  const r = draft.people.some((p) => p.uid === uid) ? { draft } : addPerson(draft, uid, name);
  if (r.error) return r;
  return { draft: { ...r.draft, who: r.draft.who === 'owners' ? 'list' : r.draft.who } };
}

function DmQuick({ conv, perms, onSaved, onDirty }) {
  const uid = String(conv.threadId);
  const [draft, setDraft] = useState(() => dmDraft(perms.dm));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  const saved = dmDraft(perms.dm);
  const dirty = !sameDm(draft, saved);
  useEffect(() => { onDirty(dirty); }, [dirty]);
  useEffect(() => () => onDirty(false), []);
  if (!UID.test(uid)) return html`<${Notice} kind="info">Hội thoại này không có UID Zalo hợp lệ nên không chỉnh quyền được ở đây.<//>`;
  if ((perms.ownerUids || []).includes(uid)) return html`<${Notice} kind="info"><strong>${conv.name}</strong> là chủ nhân bot — luôn nhắn riêng được và dùng được mọi tính năng, không cần phân quyền.<//>`;

  const folder = folderOfPeople(perms.folders).get(uid) || null;
  const { person, allowed } = dmStatus(draft, uid, folder);
  const was = dmStatus(perms.dm, uid, folder).allowed;
  const everyone = draft.who === 'everyone';
  const features = perms.dmFeatures || [];
  const studioFeatures = perms.studioFeatures || [];
  const policy = perms.studioPolicy;
  const update = (d) => { setDraft(d); setMsg({}); };
  const setP = (patch) => update({ ...draft, people: draft.people.map((p) => (p.uid === uid ? { ...p, ...patch } : p)) });
  const toggle = (on) => {
    const r = setPersonAllowed(draft, uid, conv.name, on);
    if (r.error) setMsg({ error: r.error }); else update(r.draft);
  };

  async function save(e) {
    e.preventDefault();
    if (busy || !dirty) return;
    setBusy(true); setMsg({});
    try {
      const r = await api('/api/permissions/dm', { method: 'PUT', body: dmPayload(draft, policy) });
      onSaved(r); setDraft(dmDraft(r.dm));
      setMsg({ ok: 'Đã lưu — bot áp dụng ngay, không cần khởi động lại.' });
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }

  const switchedFromOwners = perms.dm.who === 'owners' && draft.who === 'list';
  return html`<form class="perm-form" onSubmit=${save} novalidate>
    <p class="muted small perm-note">Quyền nhắn riêng của <strong>${conv.name}</strong> với bot. Chủ nhân bot luôn nhắn riêng được và dùng được mọi tính năng.</p>
    <p class="small">Hiện tại: <span class=${`badge badge-${was ? 'ok' : 'idle'}`}>${was ? 'Được nhắn riêng với bot' : 'Chưa được nhắn riêng với bot'}</span>
      <span class="muted"> · Chế độ chung: ${WHO_OPTIONS.find((o) => o.value === perms.dm.who)?.label}</span></p>
    ${!perms.dm.gatewayOpen && draft.who !== 'owners' ? html`<${Notice} kind="warn">Trợ lý đang chỉ nhận tin của chủ nhân, nên quyền này chưa có tác dụng. Nhờ người cài đặt đặt <code>ZALO_ALLOW_ALL_USERS=true</code> trong .env của Hermes rồi khởi động lại trợ lý.<//>` : null}
    <fieldset class="perm-box">
      <legend>Nhắn riêng</legend>
      ${everyone
        ? html`<${Toggle} id="cp-in-list" checked=${Boolean(person)} onChange=${toggle} label="Chỉnh quyền riêng cho người này"
            hint="Bot đang trả lời mọi người khi nhắn riêng. Bật để đặt tính năng riêng cho người này." />`
        : html`<${Toggle} id="cp-in-list" checked=${allowed} onChange=${toggle} label="Cho nhắn riêng với bot"
            hint=${allowed ? 'Người này nhắn riêng thì bot trả lời.' : 'Người này nhắn riêng thì bot không trả lời.'} />`}
      ${folder ? html`<${Notice} kind="info">Người này nằm trong thư mục <strong>${folder.name}</strong> nên được nhắn riêng và dùng cài đặt của thư mục${person?.custom ? ' (đang chỉnh riêng — phần riêng thắng)' : ''}. Bỏ khỏi thư mục ở Phân quyền Bot › Thư mục.<//>` : null}
      ${switchedFromOwners ? html`<${Notice} kind="info">Đang ở chế độ <strong>Chỉ chủ nhân</strong> — lưu sẽ chuyển sang <strong>Chủ nhân và những người trong danh sách</strong>. Người khác vẫn bị chặn như cũ.<//>` : null}
    </fieldset>
    ${person ? html`<fieldset class="perm-box">
      <legend>Tính năng của người này</legend>
      <${Toggle} id="cp-custom" checked=${person.custom} label="Dùng tính năng riêng"
        hint=${person.custom ? 'Các nút dưới đây chỉ áp cho người này.' : folder ? `Đang theo thư mục "${folder.name}".` : 'Đang theo Tính năng chung khi nhắn riêng (Phân quyền Bot › Nhắn riêng) — không phải cài đặt của nhóm.'}
        onChange=${(v) => setP({ custom: v, features: { ...(v ? draft.features : person.features) }, ...(draft.studio ? { studio: { ...(v ? draft.studio : person.studio || draft.studio) } } : {}) })} />
      ${person.custom ? html`<div class="perm-grid">
        ${features.map((f) => html`<${Toggle} key=${f.key} id=${`cp-${f.key}`} checked=${person.features[f.key]} label=${f.label} hint=${f.hint}
          onChange=${(v) => setP({ features: { ...person.features, [f.key]: v } })} />`)}
      </div>
      ${person.studio && studioFeatures.length ? html`<p class="small dm-studio-head">Xưởng tạo sản phẩm</p><div class="perm-grid">
        ${studioFeatures.map((f) => (lockedByPolicy(f.key, policy)
          ? html`<${Toggle} key=${f.key} id=${`cp-${f.key}`} label=${f.label} checked=${false} disabled=${true}
              hint=${policy?.note || 'Máy chủ này chưa chạy được video — video tắt'} onChange=${() => {}} />`
          : html`<${Toggle} key=${f.key} id=${`cp-${f.key}`} label=${f.label} checked=${person.studio[f.key]}
              onChange=${(v) => setP({ studio: { ...person.studio, [f.key]: v } })} />`))}
      </div>` : null}` : null}
    </fieldset>` : null}
    <${SaveBar} count=${dirty ? 1 : 0} busy=${busy} canSave=${dirty} msg=${msg} onUndo=${() => { setDraft(dmDraft(perms.dm)); setMsg({}); }} />
  </form>`;
}

export function PermsPanel({ conv, onClose }) {
  const [perms, setPerms] = useState(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const group = conv.threadType === 1;
  useEffect(() => {
    let alive = true;
    api('/api/permissions').then((r) => { if (alive) setPerms(r); }, (err) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [conv.threadId]);
  const close = () => { if (!dirty || window.confirm(LEAVE)) onClose(); };

  let body;
  if (error) body = html`<${Notice} kind="danger">${error}<//>`;
  else if (!perms) body = html`<${Spinner} />`;
  else if (group) {
    const id = String(conv.threadId);
    const target = mergeGroups([{ id, name: conv.name, members: null }], perms).find((g) => g.id === id);
    const pick = (s) => ({ active: s.active, replyOnlyTagged: s.replyOnlyTagged, paused: s.paused, features: { ...s.features }, studio: { ...(s.studio || {}) }, studioQuota: s.studioQuota ?? null, imageQuota: s.imageQuota ?? null, videoQuota: s.videoQuota ?? null });
    body = html`<${Editor} key=${id} head=${false} target=${target} value=${pick(target)} defaults=${pick(baseOfGroup(perms, id))}
      features=${perms.features} studioFeatures=${perms.studioFeatures || []} studioPolicy=${perms.studioPolicy}
      defaultQuota=${perms.studio?.quota ?? 3} mediaDefaults=${perms.studio} onSaved=${(r) => { setPerms(r); return true; }} onDirty=${setDirty} onBack=${close}
      baseLabel=${target.folder ? 'Theo thư mục' : 'Dùng mặc định'}
      note=${target.folder ? `Nhóm thuộc thư mục "${target.folder.name}": mục nào chưa chỉnh riêng thì theo thư mục — chỉnh thư mục ở trang Phân quyền Bot.` : null} />`;
  } else body = html`<${DmQuick} key=${conv.threadId} conv=${conv} perms=${perms} onSaved=${setPerms} onDirty=${setDirty} />`;

  return html`<aside class="side-panel perms-panel" aria-label=${group ? 'Quyền của nhóm' : 'Quyền nhắn riêng'} onKeyDown=${(e) => { if (e.key === 'Escape') close(); }}>
    <header class="side-head">
      <h3 class="perms-title"><${PermsIcon} size=${13} />${group ? 'Quyền của nhóm' : 'Quyền nhắn riêng'}</h3>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${close} aria-label="Đóng bảng quyền"><${Icon} name="close" /></button>
    </header>
    <div class="side-body">
      ${body}
      <p class="small perms-more"><a href="#/permissions">Mở trang Phân quyền Bot</a> để chỉnh mặc định, hạn mức xưởng, cách gọi bot và các nhóm khác.</p>
    </div>
  </aside>`;
}
