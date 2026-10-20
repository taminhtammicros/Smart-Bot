// Cấu hình (spec §18.6, chỉ Quản trị): cài đặt an toàn trong danh sách cố định + lời chào thành viên mới theo nhóm.
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Live, PageHead, SaveBar, Spinner, Toggle } from '../ui.js';
import { RestartBanner } from './restart-banner.js';
import { ReplyStyle } from './reply-style.js';
import { BulkBar, flip, stillPicked } from './multi-pick.js';

/** Câu cho biết đổi xong cần làm gì. */
export function restartText(restart) {
  if (!restart.length) return 'đổi xong có hiệu lực ngay';
  return `đổi xong cần khởi động lại ${restart.includes('sidecar') ? (restart.includes('assistant') ? 'trợ lý và kết nối Zalo' : 'kết nối Zalo') : 'trợ lý'}`;
}

/** Chữ trong ô nhập → giá trị gửi lên theo kiểu của mục. */
export function parseInput(s, text) {
  if (s.type === 'int') return /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
  if (['ids', 'names', 'patterns'].includes(s.type)) return text.split(',').map((x) => x.trim()).filter(Boolean);
  return text;
}

/** Mục đã sửa so với giá trị đã lưu: { id: value }. */
export function changedValues(list, draft) {
  return Object.fromEntries(list.filter((s) => JSON.stringify(draft[s.id]) !== JSON.stringify(s.value)).map((s) => [s.id, draft[s.id]]));
}

export const SOURCE_LABELS = { env: 'Cài đặt của trợ lý (.env)', config: 'config.yaml', default: 'Mặc định' };

function Field({ s, value, onChange }) {
  const id = `set-${s.id}`;
  const note = html`<small class="muted">${s.hint ? `${s.hint} ` : ''}Đang lấy từ: ${SOURCE_LABELS[s.source]} · ${restartText(s.restart)}.</small>`;
  if (s.type === 'bool') return html`<${Toggle} id=${id} checked=${value} onChange=${onChange} label=${s.label} hint=${note} />`;
  if (s.type === 'enum') return html`<div class="field"><label for=${id}>${s.label}</label>
    <select id=${id} value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>${s.options.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}</select>${note}</div>`;
  if (s.type === 'text') return html`<div class="field"><label for=${id}>${s.label}</label>
    <textarea id=${id} rows="3" maxlength=${s.max || 500} value=${value ?? ''} onInput=${(e) => onChange(e.currentTarget.value)}></textarea>${note}</div>`;
  const text = Array.isArray(value) ? value.join(', ') : Number.isNaN(value) ? '' : String(value);
  // onInput: Preact gắn onChange thành DOM "change" (chỉ bắn khi blur) — poll 3 s của Shell sẽ trả giá trị cũ vào ô.
  return html`<div class="field"><label for=${id}>${s.label}${s.type === 'int' ? ` (${s.min}–${s.max})` : ''}</label>
    <input id=${id} inputmode=${s.type === 'int' ? 'numeric' : undefined} value=${text} onInput=${(e) => onChange(parseInput(s, e.currentTarget.value))} />${note}</div>`;
}

/** Ghép kết quả lưu nhiều nhóm (`[{ id, ...cấu hình }]`) vào danh sách đang hiện; nhóm vừa lưu hết "chưa lưu". */
export function mergeWelcome(groups, saved) {
  const byId = new Map(saved.map((g) => [g.id, g]));
  return groups.map((g) => (byId.has(g.id) ? { ...g, ...byId.get(g.id), name: g.name, dirty: false } : g));
}

const WELCOME_FORM = { enabled: true, message: '', batchSize: 5, maxWaitMinutes: 15 };

function Welcome() {
  const [groups, setGroups] = useState(null);
  const [msg, setMsg] = useState({});
  // Chọn nhiều nhóm rồi áp một cấu hình lời chào; `bulk` = ô đang soạn (null = đóng).
  const [picked, setPicked] = useState(() => new Set());
  const [bulk, setBulk] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/admin/welcome').then((r) => setGroups(r.groups)).catch((e) => setMsg({ error: e.message })); }, []);
  const set = (id, patch) => setGroups(groups.map((g) => (g.id === id ? { ...g, ...patch, dirty: true } : g)));
  async function save(g) {
    setMsg({});
    try { await api(`/api/admin/welcome/${g.id}`, { method: 'PUT', body: { enabled: g.enabled, message: g.message, batchSize: g.batchSize, maxWaitMinutes: g.maxWaitMinutes, name: g.name } }); setGroups((cur) => cur.map((x) => (x.id === g.id ? { ...x, dirty: false } : x))); setMsg({ ok: `Đã lưu lời chào cho ${g.name}.` }); } catch (e) { setMsg({ error: e.message }); }
  }
  const sel = stillPicked(picked, (groups || []).map((g) => ({ uid: g.id })));
  async function saveMany() {
    if (busy || !sel.length) return;
    setBusy(true); setMsg({});
    try {
      const r = await api('/api/admin/welcome', { method: 'PUT', body: { ids: sel, settings: bulk } });
      setGroups((cur) => mergeWelcome(cur, r.groups)); setBulk(null); setPicked(new Set());
      setMsg({ ok: `Đã lưu lời chào cho ${r.groups.length} nhóm.` });
    } catch (e) { setMsg({ error: e.message }); } finally { setBusy(false); }
  }
  const setB = (patch) => { setBulk({ ...bulk, ...patch }); setMsg({}); };
  return html`<section class="card"><h2>Lời chào thành viên mới</h2>
    <p class="muted small">Bot gom người mới vào nhóm rồi chào một lần (tag tất cả). Có hiệu lực ngay, không cần khởi động lại.</p>
    <${Live} error=${msg.error} ok=${msg.ok} />
    ${!groups && !msg.error ? html`<${Spinner} />` : null}
    ${groups && groups.length > 1 ? html`<${BulkBar} shown=${groups.map((g) => ({ uid: g.id }))} picked=${new Set(sel)} onPick=${setPicked} unit="nhóm">
      <button type="button" class="btn btn-secondary btn-sm" onClick=${() => setBulk(bulk || { ...WELCOME_FORM })}>Đặt lời chào chung</button>
    <//>` : null}
    ${bulk && sel.length ? html`<div class="bulk-panel">
      <p class="small"><strong>Một lời chào cho ${sel.length} nhóm đã chọn</strong> — thay cấu hình đang có của các nhóm đó.</p>
      <${Toggle} id="wel-bulk" checked=${bulk.enabled} onChange=${(v) => setB({ enabled: v })} label="Chào thành viên mới" />
      <div class="field"><label for="welm-bulk">Lời chào</label><textarea id="welm-bulk" rows="3" maxlength="1500" value=${bulk.message} onInput=${(e) => setB({ message: e.currentTarget.value })}></textarea></div>
      <div class="grid grid-2">
        <div class="field"><label for="welb-bulk">Gom đủ (người)</label><input id="welb-bulk" type="number" min="1" max="20" value=${bulk.batchSize} onInput=${(e) => setB({ batchSize: Number(e.currentTarget.value) })} /></div>
        <div class="field"><label for="welw-bulk">Chờ tối đa (phút)</label><input id="welw-bulk" type="number" min="1" max="1440" value=${bulk.maxWaitMinutes} onInput=${(e) => setB({ maxWaitMinutes: Number(e.currentTarget.value) })} /></div>
      </div>
      <div class="row">
        <button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${saveMany}>${busy ? 'Đang lưu…' : `Lưu cho ${sel.length} nhóm`}</button>
        <button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => setBulk(null)}>Huỷ</button>
      </div>
    </div>` : null}
    ${(groups || []).map((g) => html`<div key=${g.id} class="welcome-row">
      ${groups.length > 1 ? html`<input type="checkbox" class="bulk-check" checked=${picked.has(g.id)} aria-label=${`Chọn ${g.name}`} onChange=${() => setPicked(flip(picked, g.id))} />` : null}
      <details class="perm-box"><summary>${g.name} <span class=${`badge ${g.enabled ? 'badge-ok' : 'badge-idle'}`}>${g.enabled ? 'Đang chào' : 'Tắt'}</span></summary>
      <${Toggle} id=${`wel-${g.id}`} checked=${g.enabled} onChange=${(v) => set(g.id, { enabled: v })} label="Chào thành viên mới" />
      <div class="field"><label for=${`welm-${g.id}`}>Lời chào</label><textarea id=${`welm-${g.id}`} rows="3" maxlength="1500" value=${g.message} onInput=${(e) => set(g.id, { message: e.currentTarget.value })}></textarea></div>
      <div class="grid grid-2">
        <div class="field"><label for=${`welb-${g.id}`}>Gom đủ (người)</label><input id=${`welb-${g.id}`} type="number" min="1" max="20" value=${g.batchSize} onInput=${(e) => set(g.id, { batchSize: Number(e.currentTarget.value) })} /></div>
        <div class="field"><label for=${`welw-${g.id}`}>Chờ tối đa (phút)</label><input id=${`welw-${g.id}`} type="number" min="1" max="1440" value=${g.maxWaitMinutes} onInput=${(e) => set(g.id, { maxWaitMinutes: Number(e.currentTarget.value) })} /></div>
      </div>
      <button type="button" class="btn btn-primary btn-sm" disabled=${!g.dirty} onClick=${() => save(g)}>Lưu lời chào</button>
    </details></div>`)}
  </section>`;
}

export function Settings() {
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState({});
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const take = (r) => { setList(r.settings); setDraft(Object.fromEntries(r.settings.map((s) => [s.id, s.value]))); };
  useEffect(() => { api('/api/admin/settings').then(take).catch((e) => setMsg({ error: e.message })); }, []);
  const head = html`<${PageHead} title="Cấu hình" sub="Cài đặt chung của bot trong danh sách an toàn. Khoá bí mật và cài đặt khác chỉ sửa được trên máy chủ. Chỉ Quản trị." />`;
  if (!list) return html`${head}<${Live} error=${msg.error} />${msg.error ? null : html`<${Spinner} />`}`;
  const changes = changedValues(list, draft);
  const count = Object.keys(changes).length;
  async function save(e) {
    e.preventDefault();
    if (changes.publicMcp && !confirm('Mở kết nối MCP cho thành viên nghĩa là người ngoài dùng được tài nguyên của chủ bot qua kết nối đó. Tiếp tục?')) return;
    setBusy(true); setMsg({});
    // Phần lớn cài đặt áp dụng ngay (plugin đọc lại tệp khi đổi); chỉ vài mục còn cần khởi động lại.
    const needRestart = list.some((s) => s.id in changes && s.restart.length);
    try {
      take(await api('/api/admin/settings', { method: 'PUT', body: { values: changes } })); setVersion((v) => v + 1);
      setMsg({ ok: needRestart ? 'Đã lưu — có mục cần khởi động lại: bấm "Khởi động lại ngay" ở dải vàng.' : 'Đã lưu — có hiệu lực ngay từ tin nhắn tiếp theo.' });
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  const groups = [...new Set(list.map((s) => s.group))];
  return html`${head}<${RestartBanner} version=${version} />
    <form class="card settings-form" onSubmit=${save} novalidate>
      ${groups.map((g) => html`<fieldset key=${g} class="mem-block"><legend><h3>${g}</h3></legend>
        ${list.filter((s) => s.group === g).map((s) => html`<${Field} key=${s.id} s=${s} value=${draft[s.id]} onChange=${(v) => setDraft((d) => ({ ...d, [s.id]: v }))} />`)}
      </fieldset>`)}
      <${SaveBar} count=${count} busy=${busy} canSave=${count > 0} onUndo=${() => take({ settings: list })} msg=${msg} />
    </form>
    <${ReplyStyle} />
    <${Welcome} />`;
}
