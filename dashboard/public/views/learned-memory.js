// Kho tri thức tự học (spec §21.8, Quản trị + Chủ bot; kho DM chủ nhân, chu kỳ gói/trích và "Rút ngay" chỉ
// Quản trị): trợ lý tự rút ra từ các cuộc trò chuyện, tách theo nhóm/người, lưu ngay trong kho SQLite của bot.
// Ba loại mục: Hồ sơ (bản gộp) · Tri thức (fact có kiểu + gốc tin nhắn) · Ghi chú (câu tự rút).
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, fmtTime, Icon, Live, Notice, Spinner } from '../ui.js';
import { BulkBar, bulkMessage, flip, stillPicked } from './multi-pick.js';

const KIND_LABEL = { profile: 'Hồ sơ', fact: 'Tri thức', soft: 'Ghi chú' };
const FACT_KIND_LABEL = {
  preference: 'sở thích, cách xưng hô', entity: 'người, việc, đồ vật', decision: 'quyết định đã chốt',
  task: 'việc đang làm', deadline: 'hạn', event: 'sự việc', owner_note: 'chủ nhân dặn',
};
const SHORT = {
  profile: 'Hồ sơ', fact: 'Tri thức', soft: 'Ghi chú',
  preference: 'Sở thích', entity: 'Người/việc', decision: 'Quyết định',
  task: 'Việc', deadline: 'Hạn', event: 'Sự việc', owner_note: 'Chủ nhân dặn', note: 'Ghi chú',
};

/** Nhãn một phạm vi: tên nhóm/người, hoặc "Nhóm/Người chưa rõ tên"; chủ nhân có thêm "(chủ nhân)". */
export function scopeLabel(s) {
  const base = s.name || `${s.kind === 'group' ? 'Nhóm' : 'Người'} chưa rõ tên`;
  return s.owner ? `${base} (chủ nhân)` : base;
}

/** Tên dễ đọc của một mục: theo loại + kiểu fact; giữ tương thích với chuỗi id `kind:raw`. */
export function entryLabel(id) {
  return SHORT[String(id ?? '').split(':')[0]] || 'Mục';
}

/** Nhãn kiểu của một mục trong danh sách (dùng ở đầu dòng). */
export function itemKindLabel(entry) {
  if (!entry) return '';
  if (entry.kind === 'fact') return SHORT[entry.factKind] || 'Tri thức';
  if (entry.kind === 'soft') return SHORT[entry.softKind] || 'Ghi chú';
  return KIND_LABEL[entry.kind] || 'Mục';
}

function Item({ scope, entry, onChanged }) {
  const [text, setText] = useState(entry.text ?? '');
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState({});
  useEffect(() => { setText(entry.text ?? ''); setDraft(null); }, [entry.id]);
  async function save() {
    try {
      await api(`/api/learned-memory/${scope}/item`, { method: 'PUT', body: { id: entry.id, text: draft } });
      setText(draft); setDraft(null);
      setMsg({ ok: 'Đã lưu — có hiệu lực từ lượt trò chuyện sau.' });
    } catch (e) { setMsg({ error: e.message }); }
  }
  async function remove() {
    if (!confirm('Xoá mục trí nhớ này? Trợ lý sẽ không còn nhớ điều này nữa.')) return;
    try { await api(`/api/learned-memory/${scope}/item`, { method: 'DELETE', body: { id: entry.id } }); onChanged('Đã xoá mục trí nhớ.'); } catch (e) { setMsg({ error: e.message }); }
  }
  const meta = [
    itemKindLabel(entry),
    entry.kind === 'fact' && entry.subject ? `về ${entry.subject}` : '',
    entry.kind === 'fact' && Number.isFinite(entry.confidence) ? `tin cậy ${Math.round(entry.confidence * 100)}%` : '',
    entry.expiresAtMs ? `hết hạn ${fmtTime(entry.expiresAtMs)}` : '',
    entry.updatedAtMs ? `cập nhật ${fmtTime(entry.updatedAtMs)}` : '',
  ].filter(Boolean).join(' · ');
  return html`<div class="mem-block">
    <p class="muted small">${meta}</p>
    <${Live} error=${msg.error} ok=${msg.ok} />
    ${draft === null ? html`<pre class="sb-text">${text}</pre>
      <div class="row form-end">
        <button type="button" class="btn btn-secondary btn-sm" onClick=${() => setDraft(text)}>Sửa</button>
        <button type="button" class="btn btn-danger-outline btn-sm" onClick=${remove}>Xoá</button></div>` : null}
    ${draft !== null ? html`<label class="sr-only" for="lm-edit">Nội dung mục trí nhớ</label>
      <textarea id="lm-edit" rows="6" maxlength="2000" value=${draft} onInput=${(e) => setDraft(e.currentTarget.value)}></textarea>
      <div class="row form-end">
        <button type="button" class="btn btn-primary btn-sm" disabled=${!draft.trim()} onClick=${save}>Lưu</button>
        <button type="button" class="btn btn-secondary btn-sm" onClick=${() => setDraft(null)}>Huỷ</button></div>` : null}
  </div>`;
}

/** Danh sách của một phạm vi: lọc theo loại, chọn nhiều để xoá, mở ra sửa. */
function ScopeMemory({ scope, onChanged }) {
  const base = `/api/learned-memory/${encodeURIComponent(scope)}`;
  const [entries, setEntries] = useState(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(null);
  const [bulk, setBulk] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setEntries(null); setBulk(new Set());
    const qs = filter ? `?kind=${encodeURIComponent(filter)}` : '';
    api(`${base}/list${qs}`).then((r) => setEntries(r.entries)).catch((e) => setMsg({ error: e.message }));
  }, [scope, filter, tick]);

  const changed = (text) => { setMsg({ ok: text }); setOpen(null); setTick((n) => n + 1); onChanged?.(text); };

  async function forgetScope() {
    if (!confirm('Quên HẾT trí nhớ của nhóm/người này? Trợ lý sẽ không còn nhớ gì về họ (lịch sử tin nhắn vẫn giữ).')) return;
    try { await api(base, { method: 'DELETE' }); changed('Đã quên hết trí nhớ của phạm vi này.'); } catch (e) { setMsg({ error: e.message }); }
  }
  async function removeMany(ids) {
    if (!confirm(`Xoá ${ids.length} mục? Không hoàn tác được.`)) return;
    setBusy(true);
    try {
      const r = await api(`${base}/bulk-delete`, { method: 'POST', body: { ids } });
      setBulk(new Set());
      setMsg(bulkMessage(r, { name: (f) => entryLabel(f.id) }));
      setTick((n) => n + 1);
    } catch (e) { setMsg({ error: e.message }); } finally { setBusy(false); }
  }

  const rows = entries || [];
  const stale = rows.length && !rows.some((e) => bulk.has(e.id)) && bulk.size ? stillPicked(bulk, rows) : bulk;
  return html`<div class="mem-scope">
    <div class="row between">
      <div class="seg" role="tablist">
        ${[['', 'Tất cả'], ['profile', 'Hồ sơ'], ['fact', 'Tri thức'], ['soft', 'Ghi chú']].map(([value, label]) => html`
          <button type="button" role="tab" aria-selected=${filter === value} class=${`seg-btn${filter === value ? ' is-on' : ''}`}
            onClick=${() => setFilter(value)}>${label}</button>`)}
      </div>
      <button type="button" class="btn btn-danger-outline btn-sm" onClick=${forgetScope}>Quên hết phạm vi này</button>
    </div>
    <${Live} error=${msg.error} ok=${msg.ok} />
    ${entries === null ? html`<${Spinner} />` : null}
    ${entries !== null && !rows.length ? html`<${Notice} kind="info">Chưa có gì trong kho của nhóm/người này. Trợ lý gói chủ đề và rút tri thức sau khi cuộc trò chuyện im một lúc.</${Notice}>` : null}
    ${rows.length ? html`<${BulkBar} picked=${stale} busy=${busy} onClear=${() => setBulk(new Set())} onDelete=${removeMany} label="mục" />` : null}
    <ul class="row-list">${rows.map((e) => html`<li key=${e.id} class="row-item">
      <input type="checkbox" class="bulk-check" checked=${bulk.has(e.id)} disabled=${busy}
        aria-label=${`Chọn ${entryLabel(e.id)}`} onChange=${() => setBulk(flip(bulk, e.id))} />
      <span class="row-main">
        <button type="button" class="link-btn" onClick=${() => setOpen(open === e.id ? null : e.id)}>${e.text}</button>
        <small class="muted">${[itemKindLabel(e), e.subject ? `về ${e.subject}` : '', e.updatedAtMs ? fmtTime(e.updatedAtMs) : ''].filter(Boolean).join(' · ')}</small>
      </span>
    </li>`)}</ul>
    ${open ? html`<${Item} key=${open} scope=${scope} entry=${rows.find((e) => e.id === open) || { id: open, text: '' }} onChanged=${changed} />` : null}
  </div>`;
}

/** Cả thẻ: chọn nhóm/người bên trái, xem trí nhớ bên phải. */
export function LearnedMemory({ status, scopes, onReload }) {
  const [picked, setPicked] = useState(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null);
  useEffect(() => { if (!picked && scopes?.length) setPicked(scopes[0].scope); }, [scopes]);
  useEffect(() => {
    const q = query.trim();
    if (!picked || q.length < 2) { setHits(null); return; }
    api(`/api/learned-memory/${encodeURIComponent(picked)}/search?q=${encodeURIComponent(q)}`)
      .then((r) => setHits(r.hits)).catch(() => setHits([]));
  }, [picked, query]);
  if (!status?.enabled) return html`<${Notice} kind="info">${status?.note || 'Trí nhớ dài hạn chưa bật.'}</${Notice}>`;
  return html`<div class="mem-grid">
    <ul class="row-list mem-scopes">${(scopes || []).map((s) => html`<li key=${s.scope} class="row-item">
      <button type="button" class="link-btn${picked === s.scope ? ' is-on' : ''}" onClick=${() => { setPicked(s.scope); setQuery(''); }}>${scopeLabel(s)}</button>
    </li>`)}</ul>
    <div class="mem-main">
      ${picked ? html`<div class="row between">
        <label class="sr-only" for="lm-search">Tìm trong kho của nhóm/người này</label>
        <input id="lm-search" type="search" placeholder="Tìm trong kho này…" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
      </div>` : null}
      ${hits === null && picked ? html`<${ScopeMemory} scope=${picked} onChanged=${() => onReload?.()} />` : null}
      ${hits !== null ? html`<ul class="row-list">${hits.length ? hits.map((h) => html`<li key=${h.id} class="row-item">
        <span class="row-main"><span>${h.text}</span><small class="muted">${itemKindLabel(h)}${h.subject ? ` · về ${h.subject}` : ''}</small></span>
      </li>`) : html`<li class="muted">Không thấy mục nào khớp.</li>`}</ul>` : null}
    </div>
  </div>`;
}
