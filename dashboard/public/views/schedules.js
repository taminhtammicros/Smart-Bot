// Lịch hẹn (spec §18.4): việc hẹn giờ của trợ lý gửi về Zalo (của chủ nhân và "hẹn giờ cho nhóm"), lời nhắc Zalo.
// Việc hẹn giờ hiện thành LỊCH TUẦN: kéo thẻ sang ngày khác để dời lịch; bấm thẻ để sửa bằng lời thường (tên, việc bot
// làm, gửi vào đâu, lặp lại, giờ). Lịch phức tạp (khoảng lặp, cron lạ) nằm ở "Lịch nâng cao" — cron gốc chỉ Quản trị sửa.
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { Dialog, html, fmtTime, Icon, Live, Notice, PageHead, Spinner } from '../ui.js';
import { fold } from '../fold.js';
import { BulkBar, bulkMessage, flip, stillPicked } from './multi-pick.js';
import { DAY_LABELS, DAY_NAMES, REPEATS, describeSpec, mondayOf, moveSpec, specProblem, weekOccurrences } from '../schedule-spec.js';

export const REPEAT_LABELS = { 0: 'Một lần', 1: 'Hằng ngày', 2: 'Hằng tuần', 3: 'Hằng tháng' };

/** Trạng thái một việc hẹn giờ: { kind, text } cho nhãn màu. */
export function jobState(j) {
  if (j.terminal) return { kind: 'idle', text: 'Đã chạy xong' };
  if (!j.enabled) return { kind: 'idle', text: 'Đã tắt' };
  if (j.paused) return { kind: 'warn', text: 'Tạm dừng' };
  if (j.lastStatus && j.lastStatus !== 'ok') return { kind: 'danger', text: 'Lần trước lỗi' };
  return { kind: 'ok', text: 'Đang chạy' };
}

/** Lọc việc theo chữ không dấu (tên, lời nhắn, tên nhóm, người tạo). */
export function filterJobs(jobs, q) {
  const n = fold(q).trim();
  return n ? jobs.filter((j) => fold(`${j.name} ${j.prompt} ${j.targetName} ${j.creatorName}`).includes(n)) : jobs;
}

/** Câu báo cho lệnh hàng loạt trên việc hẹn giờ (máy chủ trả `{ done, failed }`). */
export const BULK_VERBS = { pause: 'Đã tạm dừng', resume: 'Đã chạy lại', remove: 'Đã xoá' };
export function jobsBulkMessage(res, action, jobs) {
  const nameOf = (id) => jobs.find((j) => j.id === id)?.name || '';
  return bulkMessage(res, { verb: BULK_VERBS[action], unit: 'việc', name: (f) => nameOf(f.id) });
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayVN = () => isoDay(Date.now() + 7 * 3_600_000); // giờ Việt Nam: lịch của trợ lý chạy theo giờ VN
const shiftDays = (date, n) => isoDay(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000);
const ddmm = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** Thẻ của tuần: [{ day, date, items: [{ job, time }] }] — 7 ngày từ thứ Hai `week`. */
export function weekBoard(jobs, week) {
  const days = DAY_LABELS.map((label, i) => ({ day: i + 1, label, date: shiftDays(week, i), items: [] }));
  for (const job of jobs) for (const o of weekOccurrences(job.spec, week)) days[o.day - 1].items.push({ job, time: o.time });
  for (const d of days) d.items.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return days;
}

const blankSpec = () => ({ repeat: 'daily', times: ['07:00'], days: [1], dayOfMonth: 1, date: shiftDays(todayVN(), 1) });

/** Giờ kế tiếp chưa dùng, cùng số phút (cron chỉ cho một số phút chung): 08:00 → 09:00 … */
export function nextTime(times) {
  const minute = (times[0] || '07:00').slice(3);
  const used = new Set(times.map((t) => Number(t.slice(0, 2))));
  const last = Number((times[times.length - 1] || '07:00').slice(0, 2));
  for (let i = 1; i <= 24; i += 1) { const h = (last + i) % 24; if (!used.has(h)) return `${String(h).padStart(2, '0')}:${minute}`; }
  return null;
}

/** Việc một lần mà thời điểm đã qua (theo giờ VN) → câu lỗi. */
export function pastProblem(spec, nowMs = Date.now()) {
  if (spec.repeat !== 'once' || !spec.date || !spec.times[0]) return '';
  return Date.parse(`${spec.date}T${spec.times[0]}:00+07:00`) <= nowMs ? 'Thời điểm này đã qua — chọn ngày giờ sau bây giờ.' : '';
}

/** Cửa sổ tạo/sửa một lịch hẹn bằng lời thường. */
function JobDialog({ job, convs, admin, onDone, onClose }) {
  const advanced = Boolean(job) && !job.spec;
  const [name, setName] = useState(job?.name || '');
  const [prompt, setPrompt] = useState(job?.prompt || '');
  const [targets, setTargets] = useState(job?.targets || []);
  const nameOfTarget = (id) => { const c = convs.find((x) => x.threadId === id); return c ? c.name : (job?.targetNames?.[job.targets.indexOf(id)] || 'Chưa rõ tên'); };
  const [spec, setSpec] = useState(() => ({ ...blankSpec(), ...(job?.spec || {}) }));
  const [expr, setExpr] = useState(job?.expr || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setSpec((s) => ({ ...s, ...patch }));
  const times = spec.repeat === 'once' ? spec.times.slice(0, 1) : spec.times;
  const clean = { ...spec, times };
  const scheduleChanged = !job || JSON.stringify(clean) !== JSON.stringify({ ...blankSpec(), ...job.spec, times: job.spec?.repeat === 'once' ? job.spec.times.slice(0, 1) : job.spec?.times });
  const problem = advanced ? '' : specProblem(clean) || (scheduleChanged ? pastProblem(clean) : '');
  const snapshot = () => JSON.stringify([name, prompt, targets, advanced ? expr : clean]);
  const [initial] = useState(snapshot);
  // Đang lưu cũng coi là "chưa xong" → đóng sẽ hỏi, không lặng lẽ mất lỗi lưu.
  const dirty = () => busy || snapshot() !== initial;
  const group = job?.kind === 'group';
  async function save(e) {
    e.preventDefault();
    if (problem) { setError(problem); return; }
    if (!targets.length) { setError('Chọn nhóm hoặc người nhận.'); return; }
    setBusy(true); setError('');
    const body = { name, prompt, targets, ...(advanced ? (admin ? { expr } : {}) : { spec: clean }) };
    try {
      await api(job ? `/api/schedules/cron/${job.id}` : '/api/schedules/cron', { method: job ? 'PUT' : 'POST', body });
      onDone(job ? (job.terminal && scheduleChanged ? `Đã hẹn lại "${name}".` : `Đã lưu "${name}".`) : `Đã tạo lịch hẹn "${name}".`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  async function act(action) {
    const ask = { remove: `Xoá hẳn "${job.name}"? Không hoàn tác được.`, pause: `Tạm dừng "${job.name}"?` }[action];
    if (ask && !confirm(ask)) return;
    setBusy(true); setError('');
    try { await api(`/api/schedules/cron/${job.id}/${action}`, { method: 'POST' }); onDone({ pause: 'Đã tạm dừng.', resume: 'Đã chạy lại.', remove: 'Đã xoá.' }[action]); } catch (err) { setError(err.message); setBusy(false); }
  }
  const st = job ? jobState(job) : null;
  return html`<${Dialog} title=${job ? 'Sửa lịch hẹn' : 'Tạo lịch hẹn'} onClose=${onClose} dirty=${dirty} wide>
    <form class="stack" onSubmit=${save}>
      ${st ? html`<p><span class=${`badge badge-${st.kind}`}>${st.text}</span> <small class="muted">Lần tới: ${fmtTime(job.nextRunAt)} · Lần trước: ${fmtTime(job.lastRunAt)}${job.creatorName ? ` · ${job.creatorName} tạo` : ''}</small></p>` : null}
      ${job?.terminal ? html`<${Notice} kind="info">Việc một lần này đã chạy xong. Chọn ngày giờ mới rồi bấm "Lưu & chạy lại" để hẹn lại lần nữa.<//>` : null}
      <label class="field"><span>Tên</span><input value=${name} maxlength="120" required placeholder="Ví dụ: Nhắc nộp bài" onInput=${(e) => setName(e.currentTarget.value)} /></label>
      <label class="field"><span>Bot sẽ làm gì</span>
        <textarea rows="3" maxlength="2000" required value=${prompt} placeholder="Ví dụ: Nhắc lớp 12A1 nộp bài tập Hoá trước 21h, kèm lời động viên ngắn." onInput=${(e) => setPrompt(e.currentTarget.value)}></textarea></label>
      <fieldset class="field"><legend>Gửi vào <small class="muted">(cùng một kết quả tới mọi nơi, tối đa 10)</small></legend>
        <div class="chips">${targets.map((t) => html`<span key=${t} class="tag target-tag">${nameOfTarget(t)}
          ${group || targets.length < 2 ? null : html`<button type="button" class="tag-x" aria-label=${`Bỏ ${nameOfTarget(t)}`} onClick=${() => setTargets(targets.filter((x) => x !== t))}><${Icon} name="close" size=${12} /></button>`}</span>`)}</div>
        ${group ? html`<small class="muted">Việc do thành viên tạo trong nhóm này — chỉ gửi vào chính nhóm đó.</small>`
          : targets.length >= 10 ? null : html`<select aria-label="Thêm nơi gửi" value="" onChange=${(e) => { const v = e.currentTarget.value; if (v) setTargets([...targets, v]); }}>
            <option value="">${targets.length ? '+ Thêm nơi gửi…' : '— Chọn nhóm hoặc người —'}</option>
            ${convs.filter((c) => !targets.includes(c.threadId)).map((c) => html`<option key=${c.threadId} value=${c.threadId}>${c.threadType === 1 ? 'Nhóm' : 'Riêng'} · ${c.name}</option>`)}
          </select>`}</fieldset>
      ${advanced ? html`<${Notice} kind="info">Lịch này đặt bằng cách nâng cao (${job.schedule}). ${admin ? 'Quản trị sửa được cron gốc bên dưới; còn lại sửa tên, việc, nơi gửi như thường.' : 'Bạn sửa được tên, việc và nơi gửi; muốn đổi giờ chạy hãy nhờ Quản trị.'}<//>
        ${admin ? html`<label class="field"><span>Cron gốc</span><input class="mono" value=${expr} onInput=${(e) => setExpr(e.currentTarget.value)} /><small class="muted">5 trường: phút giờ ngày tháng thứ — vd. */30 * * * * (mỗi 30 phút).</small></label>` : null}`
      : html`<fieldset class="field"><legend>Lặp lại</legend>
          <div class="chips" role="group" aria-label="Lặp lại">${REPEATS.map((r) => html`<button type="button" key=${r.value}
            class="btn btn-secondary btn-sm chip" aria-pressed=${spec.repeat === r.value ? 'true' : 'false'} onClick=${() => set({ repeat: r.value })}>${r.label}</button>`)}</div></fieldset>
        ${spec.repeat === 'weekly' ? html`<fieldset class="field"><legend>Vào các thứ</legend>
          <div class="chips">${DAY_LABELS.map((d, i) => html`<button type="button" key=${d} class="btn btn-secondary btn-sm chip" aria-label=${DAY_NAMES[i]}
            aria-pressed=${spec.days.includes(i + 1) ? 'true' : 'false'} onClick=${() => set({ days: spec.days.includes(i + 1) ? spec.days.filter((x) => x !== i + 1) : [...spec.days, i + 1] })}>${d}</button>`)}</div></fieldset>` : null}
        ${spec.repeat === 'monthly' ? html`<label class="field"><span>Vào ngày</span><input type="number" min="1" max="31" value=${spec.dayOfMonth} onInput=${(e) => set({ dayOfMonth: Number(e.currentTarget.value) })} /><small class="muted">Tháng nào không có ngày này (vd. 31) thì không chạy.</small></label>` : null}
        ${spec.repeat === 'once' ? html`<label class="field"><span>Ngày</span><input type="date" value=${spec.date} onInput=${(e) => set({ date: e.currentTarget.value })} /></label>` : null}
        <fieldset class="field"><legend>Giờ chạy</legend>
          <div class="time-list">${times.map((t, i) => html`<span key=${i} class="time-item"><input type="time" value=${t} required aria-label=${`Giờ ${i + 1}`}
            onInput=${(e) => set({ times: times.map((x, k) => (k === i ? e.currentTarget.value : x)) })} />
            ${times.length > 1 ? html`<button type="button" class="btn btn-ghost btn-sm" aria-label="Bỏ giờ này" onClick=${() => set({ times: times.filter((_, k) => k !== i) })}><${Icon} name="close" size=${14} /></button>` : null}</span>`)}
            ${spec.repeat === 'once' || times.length >= 6 || !nextTime(times) ? null : html`<button type="button" class="btn btn-secondary btn-sm" onClick=${() => set({ times: [...times, nextTime(times)] })}><${Icon} name="plus" size=${14} /> Thêm giờ</button>`}</div>
          <small class="muted">${problem || describeSpec(clean)} · giờ Việt Nam</small></fieldset>`}
      <${Live} error=${error} />
      <div class="dialog-actions">
        <button class="btn btn-primary" disabled=${busy}>${busy ? 'Đang lưu…' : job ? (job.terminal ? 'Lưu & chạy lại' : 'Lưu') : 'Tạo lịch hẹn'}</button>
        ${job && !job.terminal ? (job.paused ? html`<button type="button" class="btn btn-secondary" disabled=${busy} onClick=${() => act('resume')}>Chạy lại</button>`
          : html`<button type="button" class="btn btn-secondary" disabled=${busy} onClick=${() => act('pause')}>Tạm dừng</button>`) : null}
        ${job ? html`<button type="button" class="btn btn-danger-outline" disabled=${busy} onClick=${() => act('remove')}>Xoá</button>` : null}
      </div>
    </form>
  <//>`;
}

/** Thêm / bỏ / chuyển nơi gửi trong luồng → danh sách nơi gửi mới của từng việc (null = không đổi). */
export function flowTargetsChange(job, action, id) {
  const cur = job.targets || [];
  if (action === 'add') return cur.includes(id) || cur.length >= 10 ? null : [...cur, id];
  if (action === 'remove') return cur.length < 2 || !cur.includes(id) ? null : cur.filter((x) => x !== id);
  return null;
}

/**
 * Chế độ "Luồng" (kiểu node như n8n): mỗi lịch hẹn một làn Khi nào → Bot làm gì → Gửi vào. Kéo nhóm/người từ bảng bên
 * phải thả vào cột "Gửi vào" để thêm nơi nhận (gửi cùng kết quả tới nhiều nơi); kéo khối nơi nhận sang làn khác để
 * chuyển; × để bỏ. Bấm khối Khi nào / Bot làm gì để sửa. Màn cảm ứng / bàn phím: ô chọn "+ Thêm nơi gửi" ở mỗi làn.
 */
function Flow({ jobs, convs, onOpen, onChanged, onError }) {
  const [drag, setDrag] = useState(null); // { kind: 'conv', id } | { kind: 'target', id, from: jobId }
  const [over, setOver] = useState('');
  const [busy, setBusy] = useState(false);
  const [pq, setPq] = useState('');
  const nameOf = (job, id) => {
    const c = convs.find((x) => x.threadId === id);
    return c ? c.name : job.targetNames?.[job.targets.indexOf(id)] || 'Chưa rõ tên';
  };
  async function put(job, targets) {
    await api(`/api/schedules/cron/${job.id}`, { method: 'PUT', body: { targets } });
  }
  async function change(job, action, id) {
    if (busy) return;
    if (job.kind === 'group') { onError(`"${job.name}" do thành viên tạo trong nhóm — chỉ gửi vào chính nhóm đó.`); return; }
    const next = flowTargetsChange(job, action, id);
    if (!next) { onError(action === 'remove' ? 'Lịch hẹn cần ít nhất một nơi gửi.' : 'Nơi này đã có trong luồng (hoặc đã đủ 10 nơi).'); return; }
    setBusy(true);
    try { await put(job, next); onChanged(action === 'add' ? `Đã thêm ${nameOf(job, id)} vào "${job.name}".` : `Đã bỏ ${nameOf(job, id)} khỏi "${job.name}".`); } catch (e) { onError(e.message); } finally { setBusy(false); }
  }
  async function drop(job) {
    const d = drag; setDrag(null); setOver('');
    if (!d || busy) return;
    if (d.kind === 'conv') { await change(job, 'add', d.id); return; }
    if (d.kind === 'target' && d.from !== job.id) {
      const src = jobs.find((j) => j.id === d.from);
      if (!src) return;
      if (job.kind === 'group' || src.kind === 'group') { onError('Việc do thành viên tạo trong nhóm chỉ gửi vào chính nhóm đó.'); return; }
      const add = flowTargetsChange(job, 'add', d.id);
      const rest = flowTargetsChange(src, 'remove', d.id);
      if (!add || !rest) { onError(!rest ? `"${src.name}" cần ít nhất một nơi gửi — thêm nơi khác trước khi chuyển.` : 'Nơi này đã có trong luồng đích.'); return; }
      setBusy(true);
      try { await put(job, add); await put(src, rest); onChanged(`Đã chuyển ${nameOf(src, d.id)} từ "${src.name}" sang "${job.name}".`); } catch (e) { onError(e.message); } finally { setBusy(false); }
    }
  }
  const n = fold(pq).trim();
  const palette = convs.filter((c) => !n || fold(c.name).includes(n)).slice(0, 60);
  return html`<div class=${`flow-board${busy ? ' is-busy' : ''}`}>
    <div class="flow-lanes">${jobs.map((job) => { const st = jobState(job); return html`<div key=${job.id} class=${`flow-lane lane-${st.kind}`}>
      <button type="button" class="flow-node node-when" onClick=${() => onOpen(job)}>
        <span class="node-head"><${Icon} name="clock" size=${14} /> Khi nào</span>
        <span>${job.spec ? describeSpec(job.spec) : job.schedule}</span>
        ${st.kind === 'ok' ? null : html`<span class=${`badge badge-${st.kind}`}>${st.text}</span>`}</button>
      <span class="flow-edge" aria-hidden="true"></span>
      <button type="button" class="flow-node node-do" onClick=${() => onOpen(job)}>
        <span class="node-head"><${Icon} name="bot" size=${14} /> Bot làm</span>
        <strong>${job.name}</strong><small class="muted">${job.promptPreview}</small></button>
      <span class="flow-edge" aria-hidden="true"></span>
      <div class=${`flow-targets${over === job.id ? ' is-over' : ''}`}
        onDragOver=${(e) => { if (drag) { e.preventDefault(); setOver(job.id); } }}
        onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(''); }}
        onDrop=${(e) => { e.preventDefault(); drop(job); }}>
        <span class="node-head"><${Icon} name="chat" size=${14} /> Gửi vào</span>
        ${job.targets.map((t) => html`<div key=${t} class="flow-node node-to" draggable=${job.kind === 'group' ? 'false' : 'true'}
          onDragStart=${(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t); setDrag({ kind: 'target', id: t, from: job.id }); }}
          onDragEnd=${() => { setDrag(null); setOver(''); }}>
          <span>${nameOf(job, t)}</span>
          ${job.kind === 'group' || job.targets.length < 2 ? null : html`<button type="button" class="tag-x" aria-label=${`Bỏ ${nameOf(job, t)} khỏi ${job.name}`} disabled=${busy} onClick=${() => change(job, 'remove', t)}><${Icon} name="close" size=${12} /></button>`}
        </div>`)}
        ${job.kind === 'group' || job.targets.length >= 10 ? null : html`<select class="flow-add" aria-label=${`Thêm nơi gửi cho ${job.name}`} value="" disabled=${busy}
          onChange=${(e) => { const v = e.currentTarget.value; if (v) change(job, 'add', v); }}>
          <option value="">+ Thêm nơi gửi…</option>
          ${convs.filter((c) => !job.targets.includes(c.threadId)).map((c) => html`<option key=${c.threadId} value=${c.threadId}>${c.threadType === 1 ? 'Nhóm' : 'Riêng'} · ${c.name}</option>`)}
        </select>`}
      </div>
    </div>`; })}</div>
    <aside class="flow-palette" aria-label="Nhóm và người">
      <strong>Nhóm & người</strong>
      <p class="muted small">Kéo vào cột "Gửi vào" của một luồng.</p>
      <label class="sr-only" for="flow-q">Lọc nhóm hoặc người</label>
      <input id="flow-q" type="search" placeholder="Lọc…" value=${pq} onInput=${(e) => setPq(e.currentTarget.value)} />
      <div class="flow-chips">${palette.map((c) => html`<div key=${c.threadId} class="tag flow-chip" draggable="true"
        onDragStart=${(e) => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', c.threadId); setDrag({ kind: 'conv', id: c.threadId }); }}
        onDragEnd=${() => { setDrag(null); setOver(''); }}>${c.threadType === 1 ? '' : 'Riêng · '}${c.name}</div>`)}</div>
    </aside>
  </div>`;
}

const VIEW_KEY = 'zd-schedules-view';
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'flow' ? 'flow' : 'week'; } catch { return 'week'; } };

function Jobs({ admin }) {
  const [data, setData] = useState(null);
  const [convs, setConvs] = useState([]);
  const [q, setQ] = useState('');
  const [week, setWeek] = useState(() => mondayOf(todayVN()));
  const [open, setOpen] = useState(null); // { job } | { job: null } (tạo mới)
  const [drag, setDrag] = useState(null);
  const [saving, setSaving] = useState(false);
  const [over, setOver] = useState(0);
  const [msg, setMsg] = useState({});
  const [view, setView] = useState(readView);
  // Chế độ "Chọn nhiều": Set mã việc đã tích, null = tắt (hiện danh sách thay cho lịch tuần/luồng).
  const [bulk, setBulk] = useState(null);
  const pickView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* chỉ là tiện ích */ } };
  const load = () => api('/api/schedules').then(setData).catch((e) => setMsg({ error: e.message }));
  useEffect(() => { load(); api('/api/chats').then((r) => setConvs(r.conversations || [])).catch(() => {}); }, []);
  const done = (text) => { setOpen(null); setMsg({ ok: text }); load(); };
  const jobs = filterJobs(data?.jobs || [], q);
  const board = weekBoard(jobs, week);
  const advanced = jobs.filter((j) => !j.spec);
  const today = todayVN();
  async function runMany(action, ids) {
    if (action === 'remove' && !confirm(`Xoá ${ids.length} việc? Không hoàn tác được.`)) return;
    setSaving(true); setMsg({});
    try {
      const r = await api('/api/schedules/cron/bulk', { method: 'POST', body: { action, ids } });
      setBulk(new Set()); setMsg(jobsBulkMessage(r, action, data?.jobs || [])); load();
    } catch (e) { setMsg({ error: e.message }); } finally { setSaving(false); }
  }
  const picks = bulk ? stillPicked(bulk, jobs.map((j) => ({ uid: j.id }))) : [];
  const pickedJobs = jobs.filter((j) => picks.includes(j.id));
  async function drop(day) {
    setOver(0);
    const d = drag; setDrag(null);
    if (!d || d.fromDay === day.day) return;
    if (saving) return;
    if (d.job.spec.repeat === 'weekly' && d.job.spec.days.includes(day.day)) { setMsg({ error: `"${d.job.name}" đã chạy vào ${DAY_NAMES[day.day - 1]} rồi.` }); return; }
    const next = moveSpec(d.job.spec, d.fromDay, day.day, day.date);
    if (!next) { setMsg({ error: `"${d.job.name}" chạy hằng ngày nên không cần dời ngày — bấm vào thẻ để đổi giờ.` }); return; }
    const past = pastProblem(next);
    if (past) { setMsg({ error: past }); return; }
    setMsg({}); setSaving(true);
    try {
      // Chỉ gửi lịch — tên, nội dung, nơi gửi giữ nguyên trên máy chủ.
      await api(`/api/schedules/cron/${d.job.id}`, { method: 'PUT', body: { spec: next } });
      done(`Đã dời "${d.job.name}" sang ${DAY_NAMES[day.day - 1]} (${describeSpec(next)}).`);
    } catch (e) { setMsg({ error: e.message }); } finally { setSaving(false); }
  }
  return html`<section class="card">
    <div class="toolbar"><h2>Việc hẹn giờ của trợ lý</h2>
      <div class="chips" role="group" aria-label="Kiểu xem">
        <button type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${view === 'week' ? 'true' : 'false'} onClick=${() => pickView('week')}>Lịch tuần</button>
        <button type="button" class="btn btn-secondary btn-sm chip" aria-pressed=${view === 'flow' ? 'true' : 'false'} onClick=${() => pickView('flow')}>Luồng</button>
      </div>
      ${data?.jobs?.length > 1 ? html`<button type="button" class="btn btn-ghost btn-sm" aria-pressed=${bulk ? 'true' : 'false'} onClick=${() => setBulk(bulk ? null : new Set())}>${bulk ? 'Xong' : 'Chọn nhiều'}</button>` : null}
      <button type="button" class="btn btn-primary btn-sm" disabled=${!data} onClick=${() => setOpen({ job: null })}><${Icon} name="plus" size=${16} /> Tạo lịch hẹn</button></div>
    <div class="toolbar week-nav">${view === 'flow' || bulk ? null : html`
      <button type="button" class="btn btn-secondary btn-sm" aria-label="Tuần trước" onClick=${() => setWeek(shiftDays(week, -7))}>‹</button>
      <strong>${ddmm(week)} – ${ddmm(shiftDays(week, 6))}</strong>
      <button type="button" class="btn btn-secondary btn-sm" aria-label="Tuần sau" onClick=${() => setWeek(shiftDays(week, 7))}>›</button>
      ${week !== mondayOf(today) ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setWeek(mondayOf(today))}>Tuần này</button>` : null}`}
      <label class="sr-only" for="job-q">Tìm lịch hẹn</label>
      <input id="job-q" type="search" placeholder="Tìm theo tên, nhóm, người tạo…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
    </div>
    <${Live} error=${msg.error} ok=${msg.ok} />
    ${data?.cronError ? html`<${Notice} kind="warn">${data.cronError}<//>` : null}
    ${!data && !msg.error ? html`<${Spinner} />` : null}
    ${data && bulk ? html`<${BulkBar} shown=${jobs.map((j) => ({ uid: j.id }))} picked=${new Set(picks)} onPick=${setBulk} filtered=${Boolean(q.trim())} unit="việc">
        ${pickedJobs.some((j) => !j.paused) ? html`<button type="button" class="btn btn-secondary btn-sm" disabled=${saving} onClick=${() => runMany('pause', pickedJobs.filter((j) => !j.paused).map((j) => j.id))}>Tạm dừng</button>` : null}
        ${pickedJobs.some((j) => j.paused) ? html`<button type="button" class="btn btn-secondary btn-sm" disabled=${saving} onClick=${() => runMany('resume', pickedJobs.filter((j) => j.paused).map((j) => j.id))}>Chạy lại</button>` : null}
        <button type="button" class="btn btn-danger-outline btn-sm" disabled=${saving} onClick=${() => runMany('remove', picks)}>Xoá ${picks.length} việc</button><//>
      <ul class="row-list">${jobs.map((j) => { const st = jobState(j); return html`<li key=${j.id} class="row-item">
        <input type="checkbox" class="bulk-check" checked=${bulk.has(j.id)} disabled=${saving} aria-label=${`Chọn ${j.name}`} onChange=${() => setBulk(flip(bulk, j.id))} />
        <span class="row-main"><strong>${j.name || 'Chưa đặt tên'}</strong><small class="muted">${j.spec ? describeSpec(j.spec) : j.schedule} · gửi vào ${j.targetName}</small></span>
        <span class=${`badge badge-${st.kind}`}>${st.text}</span></li>`; })}</ul>
      ${!jobs.length ? html`<p class="muted">${q ? 'Không có lịch hẹn nào khớp.' : 'Chưa có lịch hẹn nào.'}</p>` : null}` : null}
    ${data && !bulk && view === 'flow' ? html`<p class="muted small">Mỗi luồng: Khi nào → Bot làm gì → Gửi vào. <span class="drag-hint">Kéo nhóm từ bảng bên phải vào cột "Gửi vào" để gửi thêm nơi; kéo khối nơi nhận sang luồng khác để chuyển. </span>Bấm khối để sửa.</p>
      ${jobs.length ? html`<${Flow} jobs=${jobs} convs=${convs} onOpen=${(j) => setOpen({ job: j })} onChanged=${done} onError=${(t) => setMsg({ error: t })} />`
        : html`<p class="muted">${q ? 'Không có lịch hẹn nào khớp.' : 'Chưa có lịch hẹn nào — bấm "Tạo lịch hẹn".'}</p>`}` : null}
    ${data && !bulk && view === 'week' ? html`<p class="muted small"><span class="drag-hint">Kéo thẻ sang ngày khác để dời lịch; </span>Bấm vào thẻ để sửa, tạm dừng hoặc xoá.</p>
      <div class="week-grid">${board.map((d) => html`<div key=${d.day} class=${`week-col${d.date === today ? ' is-today' : ''}${over === d.day ? ' is-over' : ''}`}
        onDragOver=${(e) => { if (drag) { e.preventDefault(); setOver(d.day); } }} onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(0); }} onDrop=${(e) => { e.preventDefault(); drop(d); }}>
        <div class="week-head"><strong>${d.label}</strong> <small class="muted">${ddmm(d.date)}</small></div>
        ${d.items.length ? d.items.map((it) => { const st = jobState(it.job); return html`<div role="button" tabindex="0" key=${`${it.job.id}-${it.time}`}
          class=${`job-card job-${st.kind}${saving ? ' is-busy' : ''}`} draggable=${saving ? 'false' : 'true'} title=${it.job.promptPreview}
          aria-label=${`${it.time} ${it.job.name}, gửi vào ${it.job.targetName}. Bấm để sửa.`}
          onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen({ job: it.job }); } }}
          onDragStart=${(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.job.id); setDrag({ job: it.job, fromDay: d.day }); }}
          onDragEnd=${() => { setDrag(null); setOver(0); }} onClick=${() => setOpen({ job: it.job })}>
          <span class="job-time">${it.time}</span><span class="job-name">${it.job.name}</span><small class="muted">${it.job.targetName}</small></div>`; })
          : html`<p class="muted small week-empty">—</p>`}
      </div>`)}</div>
      ${advanced.length ? html`<h3>Lịch nâng cao <small class="muted">${advanced.length}</small></h3>
        <ul class="row-list">${advanced.map((j) => { const st = jobState(j); return html`<li key=${j.id} class="row-item">
          <span class="row-main"><strong>${j.name || j.id}</strong><small class="muted">${j.schedule} · gửi vào ${j.targetName}</small></span>
          <span class=${`badge badge-${st.kind}`}>${st.text}</span>
          <button type="button" class="btn btn-secondary btn-sm" aria-label=${`Sửa ${j.name}`} onClick=${() => setOpen({ job: j })}>Sửa</button></li>`; })}</ul>` : null}
      ${!jobs.length ? html`<p class="muted">${q ? 'Không có lịch hẹn nào khớp.' : 'Chưa có lịch hẹn nào — bấm "Tạo lịch hẹn".'}</p>` : null}` : null}
    ${open ? html`<${JobDialog} job=${open.job} convs=${convs} admin=${admin} onDone=${done} onClose=${() => setOpen(null)} />` : null}
  </section>`;
}

function Reminders() {
  const [convs, setConvs] = useState(null);
  const [sel, setSel] = useState('');
  const [list, setList] = useState(null);
  const [msg, setMsg] = useState({});
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/chats').then((r) => setConvs(r.conversations || [])).catch((e) => setMsg({ error: e.message })); }, []);
  const conv = (convs || []).find((c) => `${c.threadType}:${c.threadId}` === sel);
  const load = () => conv && api(`/api/schedules/reminders?${new URLSearchParams({ threadId: conv.threadId, threadType: String(conv.threadType) })}`)
    .then((r) => setList(r.reminders)).catch((e) => setMsg({ error: e.message }));
  useEffect(() => { setList(null); setMsg({}); setPicked(new Set()); load(); }, [sel]);
  async function remove(r) {
    if (!confirm(`Xoá lời nhắc "${r.title}" trong ${conv.name}?`)) return;
    try { await api('/api/schedules/reminders/remove', { method: 'POST', body: { reminderId: r.id, threadId: conv.threadId, threadType: conv.threadType } }); setMsg({ ok: 'Đã xoá lời nhắc.' }); load(); } catch (e) { setMsg({ error: e.message }); }
  }
  async function removeMany(ids) {
    if (!confirm(`Xoá ${ids.length} lời nhắc? Không hoàn tác được.`)) return;
    setBusy(true); setMsg({});
    try {
      const r = await api('/api/schedules/reminders/bulk-remove', { method: 'POST', body: { reminderIds: ids, threadId: conv.threadId, threadType: conv.threadType } });
      setPicked(new Set());
      setMsg(bulkMessage(r, { unit: 'lời nhắc', name: (f) => (list || []).find((x) => x.id === f.id)?.title || '' })); load();
    } catch (e) { setMsg({ error: e.message }); } finally { setBusy(false); }
  }
  const items = (list || []).map((r) => ({ uid: r.id }));
  const pick = stillPicked(picked, items);
  return html`<section class="card">
    <h2>Lời nhắc Zalo</h2>
    <p class="muted small">Lời nhắc tạo trong Zalo (bởi bot hoặc thành viên). Chọn hội thoại để xem.</p>
    <div class="field"><label for="rem-conv">Hội thoại</label>
      <select id="rem-conv" value=${sel} onChange=${(e) => setSel(e.currentTarget.value)}>
        <option value="">— Chọn nhóm hoặc người —</option>
        ${(convs || []).map((c) => html`<option key=${`${c.threadType}:${c.threadId}`} value=${`${c.threadType}:${c.threadId}`}>${c.threadType === 1 ? 'Nhóm' : 'Riêng'} · ${c.name}</option>`)}
      </select></div>
    <${Live} error=${msg.error} ok=${msg.ok} />
    ${sel && !list && !msg.error ? html`<${Spinner} />` : null}
    ${list && !list.length ? html`<p class="muted">Hội thoại này chưa có lời nhắc.</p>` : null}
    ${list && list.length > 1 ? html`<${BulkBar} shown=${items} picked=${new Set(pick)} onPick=${setPicked} unit="lời nhắc">
      <button type="button" class="btn btn-danger-outline btn-sm" disabled=${busy} onClick=${() => removeMany(pick)}>Xoá ${pick.length} lời nhắc</button><//>` : null}
    <ul class="row-list">${(list || []).map((r) => html`<li key=${r.id} class="row-item">
      ${list.length > 1 ? html`<input type="checkbox" class="bulk-check" checked=${picked.has(r.id)} disabled=${busy}
        aria-label=${`Chọn ${r.title || 'lời nhắc này'}`} onChange=${() => setPicked(flip(picked, r.id))} />` : null}
      <span class="row-main"><strong>${r.title || '(không tên)'}</strong>
        <small class="muted">${fmtTime(r.startAt)} · ${REPEAT_LABELS[r.repeat] || 'Lặp lại'}${r.mine ? ' · bot tạo' : ''}</small></span>
      <button class="btn btn-secondary btn-sm" onClick=${() => remove(r)}><${Icon} name="close" size=${14} /> Xoá</button>
    </li>`)}</ul>
  </section>`;
}

export function Schedules({ me }) {
  return html`<${PageHead} title="Lịch hẹn" sub="Việc trợ lý làm theo giờ và lời nhắc trong các nhóm Zalo." />
    <${Jobs} admin=${me?.role === 'admin'} /><${Reminders} />`;
}
