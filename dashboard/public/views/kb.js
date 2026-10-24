// Kho tri thức (spec §18.5), trang gọn: nguồn có sẵn chỉ hiện số tệp theo thư mục (tìm tệp khi cần); tài liệu tự tạo
// (tải lên / viết trên dashboard) hiện từng tệp, bấm "Chi tiết" để sửa trong cửa sổ. Quản trị đổi được nguồn.
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api, sendFile } from '../api.js';
import { Dialog, html, fmtTime, Icon, Live, Notice, PageHead, Spinner } from '../ui.js';
import { fold } from '../fold.js';
import { RestartBanner } from './restart-banner.js';
import { BulkBar, flip, stillPicked } from './multi-pick.js';
import { colorOf, FOLDER_COLORS, FolderChip, FolderColorPicker, FolderFilter, inFolderFilter, NO_FOLDER } from './folder-ui.js';

/** "12 KB", "3,4 MB". */
export function fmtSize(bytes) {
  const n = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${n.format(bytes / 1024)} KB`;
  return `${n.format(bytes / 1024 / 1024)} MB`;
}

/** Kiểm trước khi gửi (máy chủ kiểm lại): đuôi và cỡ. Trả câu lỗi hoặc ''. */
export function uploadProblem(file, types, maxBytes) {
  const ext = (/\.[^.]+$/.exec(file.name)?.[0] || '').toLowerCase();
  if (!types.includes(ext)) return `Chỉ nhận ${types.join(', ')} — đổi định dạng rồi tải lại.`;
  if (file.size > maxBytes) return `Tệp quá ${fmtSize(maxBytes)} — chia nhỏ hoặc nén lại rồi tải lên.`;
  if (!file.size) return 'Tệp rỗng — chọn tệp khác.';
  return '';
}

/** "214 tệp · 3 link", "Chưa có tệp". */
export function sourceCount({ files, links }) {
  const n = new Intl.NumberFormat('vi-VN');
  const bits = [files ? `${n.format(files)} tệp` : '', links ? `${n.format(links)} link` : ''].filter(Boolean);
  return bits.length ? bits.join(' · ') : 'Chưa có tệp';
}

/** Thư mục của một tài liệu tự tạo (id lạ → Chưa xếp). */
export function docFolderOf(folders) {
  const byId = new Map((folders || []).map((f) => [f.id, f]));
  return (doc) => byId.get(doc.folder) || null;
}

/** Bộ lọc còn hợp lệ: thư mục vừa bị xoá → "all". */
export const liveFilter = (value, folders) => (value === 'all' || value === NO_FOLDER || (folders || []).some((f) => f.id === value) ? value : 'all');

/** Tài liệu khớp bộ lọc thư mục ('all' | NO_FOLDER | id). */
export function docsInFilter(own, folders, value) {
  const of = docFolderOf(folders);
  const v = liveFilter(value, folders);
  return (own || []).filter((d) => inFolderFilter(v, of(d)));
}

/** Tài liệu mới vào thư mục đang lọc (Tất cả / Chưa xếp → null). */
export const newDocFolder = (value, folders) => ((folders || []).some((f) => f.id === value) ? value : null);

const nameOf = (path) => path.split('/').pop();
const stemOf = (path) => nameOf(path).replace(/\.[^.]+$/, '');
const isText = (path) => /\.(md|txt)$/i.test(path);

/** Cửa sổ chi tiết một tài liệu tự tạo: đổi tên, sửa nội dung (.md/.txt), thay tệp, xoá. */
function OwnDoc({ file, data, onDone, onClose }) {
  const [name, setName] = useState(stemOf(file.path));
  const [folder, setFolder] = useState(file.folder || '');
  const [text, setText] = useState(null);
  const [orig, setOrig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  const ext = (/\.[^.]+$/.exec(file.path)?.[0] || '').toLowerCase();
  useEffect(() => {
    if (!isText(file.path)) return;
    api(`/api/kb/own?path=${encodeURIComponent(file.path)}`).then((r) => { setText(r.text); setOrig(r.text); }).catch((e) => setMsg({ error: e.message }));
  }, []);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setMsg({});
    try {
      const body = { path: file.path, name };
      if (text !== null && text !== orig) body.text = text;
      const moved = folder !== (file.folder || '');
      if (moved) await api('/api/kb/files/folder', { method: 'PUT', body: { paths: [file.path], folder: folder || null } });
      if (!moved || name !== stemOf(file.path) || body.text !== undefined) await api('/api/kb/own', { method: 'PUT', body });
      onDone('Đã lưu — bot dùng bản mới trong vòng 5 phút.');
    } catch (err) { setMsg({ error: err.message }); setBusy(false); }
  }
  async function replace(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(ext)) { setMsg({ error: `Chọn tệp ${ext} để thay (giữ đúng định dạng).` }); return; }
    const problem = uploadProblem(f, data.uploadTypes, data.maxBytes);
    if (problem) { setMsg({ error: problem }); return; }
    setBusy(true); setMsg({});
    try { await sendFile(`/api/kb/own/replace?path=${encodeURIComponent(file.path)}`, f); onDone(`Đã thay nội dung ${nameOf(file.path)}.`); } catch (err) { setMsg({ error: err.message }); setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Xoá ${nameOf(file.path)}? Bot sẽ không tra được tài liệu này nữa.`)) return;
    setBusy(true);
    try { await api('/api/kb/file', { method: 'DELETE', body: { path: file.path } }); onDone('Đã xoá tài liệu.'); } catch (err) { setMsg({ error: err.message }); setBusy(false); }
  }
  const dirty = () => !busy && (name !== stemOf(file.path) || folder !== (file.folder || '') || (text !== null && text !== orig));
  return html`<${Dialog} title="Chi tiết tài liệu" onClose=${onClose} dirty=${dirty} wide=${isText(file.path)}>
    <form class="stack" onSubmit=${save}>
      <label class="field"><span>Tên tài liệu</span>
        <span class="input-suffix"><input value=${name} maxlength="120" required onInput=${(e) => setName(e.currentTarget.value)} /><span class="muted mono">${ext}</span></span></label>
      <p class="muted small">${fmtSize(file.size)} · sửa lần cuối ${fmtTime(file.mtime)}</p>
      ${data.folders?.length ? html`<label class="field"><span>Thư mục</span>
        <${FolderSelect} folders=${data.folders} value=${folder} onChange=${setFolder} /></label>` : null}
      ${isText(file.path) ? html`<label class="field"><span>Nội dung</span>
        ${text === null ? html`<${Spinner} />` : html`<textarea class="doc-editor" rows="14" value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>`}</label>` : null}
      <${Live} error=${msg.error} />
      <div class="dialog-actions">
        <button class="btn btn-primary" disabled=${busy}>${busy ? 'Đang lưu…' : 'Lưu'}</button>
        <label class="btn btn-secondary file-btn"><input class="sr-only" type="file" accept=${ext} disabled=${busy} onChange=${replace} />Thay tệp…</label>
        <button type="button" class="btn btn-danger-outline" disabled=${busy} onClick=${remove}>Xoá tài liệu</button>
      </div>
    </form>
  <//>`;
}

/** Viết tài liệu mới ngay trên dashboard → lưu thành .md. */
function NewNote({ folder, onDone, onClose }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { const r = await api('/api/kb/note', { method: 'POST', body: { title, text, folder } }); onDone(`Đã tạo ${nameOf(r.path)}. Bot thấy tài liệu mới trong vòng 5 phút.`); } catch (err) { setError(err.message); setBusy(false); }
  }
  return html`<${Dialog} title="Viết tài liệu mới" onClose=${onClose} dirty=${() => !busy && Boolean(title.trim() || text.trim())} wide>
    <form class="stack" onSubmit=${save}>
      <label class="field"><span>Tiêu đề</span><input value=${title} maxlength="120" required placeholder="Ví dụ: Nội quy nhóm" onInput=${(e) => setTitle(e.currentTarget.value)} /></label>
      <label class="field"><span>Nội dung</span><textarea class="doc-editor" rows="14" required value=${text} placeholder="Gõ nội dung bot cần biết…" onInput=${(e) => setText(e.currentTarget.value)}></textarea></label>
      <${Live} error=${error} />
      <div class="dialog-actions"><button class="btn btn-primary" disabled=${busy}>${busy ? 'Đang lưu…' : 'Lưu tài liệu'}</button></div>
    </form>
  <//>`;
}

/** Chọn thư mục ('' = Chưa xếp). */
function FolderSelect({ folders, value, onChange, id }) {
  return html`<select id=${id} value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>
    <option value="">Chưa xếp</option>
    ${folders.map((f) => html`<option key=${f.id} value=${f.id}>${f.name}</option>`)}
  </select>`;
}

/** Tạo thư mục (folder null) hoặc đổi tên/màu/xoá thư mục. */
function FolderEditor({ folder, folders, onDone, onClose }) {
  const used = new Set(folders.map((f) => f.color));
  const [name, setName] = useState(folder?.name || '');
  const [color, setColor] = useState(folder ? colorOf(folder) : (FOLDER_COLORS.find((c) => !used.has(c)) || 'blue'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(fn) {
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err.message); setBusy(false); }
  }
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      if (folder) {
        await api(`/api/kb/folders/${folder.id}`, { method: 'PUT', body: { name, color } });
        onDone('Đã lưu thư mục.');
      } else {
        await api('/api/kb/folders', { method: 'POST', body: { name, color } });
        onDone(`Đã tạo thư mục ${name.trim()}.`);
      }
    });
  };
  const remove = () => {
    if (!confirm('Xoá thư mục? Tài liệu bên trong chuyển về Chưa xếp.')) return;
    run(async () => { await api(`/api/kb/folders/${folder.id}`, { method: 'DELETE' }); onDone('Đã xoá thư mục.'); });
  };
  const dirty = () => !busy && (name !== (folder?.name || '') || Boolean(folder && color !== colorOf(folder)));
  return html`<${Dialog} title=${folder ? 'Sửa thư mục' : 'Thư mục mới'} onClose=${onClose} dirty=${dirty}>
    <form class="stack" onSubmit=${save}>
      <label class="field"><span>Tên thư mục</span><input value=${name} maxlength="60" required placeholder="Ví dụ: Nội quy" onInput=${(e) => setName(e.currentTarget.value)} /></label>
      <div class="field"><span>Màu</span><${FolderColorPicker} value=${color} disabled=${busy} onChange=${setColor} /></div>
      <${Live} error=${error} />
      <div class="dialog-actions">
        <button class="btn btn-primary" disabled=${busy || !name.trim()}>${busy ? 'Đang lưu…' : folder ? 'Lưu' : 'Tạo thư mục'}</button>
        ${folder ? html`<button type="button" class="btn btn-danger-outline" disabled=${busy} onClick=${remove}>Xoá thư mục</button>` : null}
      </div>
    </form>
  <//>`;
}

/** Chuyển các tài liệu đã chọn vào một thư mục. */
function MoveDocs({ paths, folders, onDone, onClose }) {
  const [folder, setFolder] = useState(folders[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api('/api/kb/files/folder', { method: 'PUT', body: { paths, folder: folder || null } });
      onDone(`Đã chuyển ${r.count} tài liệu vào ${folders.find((f) => f.id === folder)?.name || 'Chưa xếp'}.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return html`<${Dialog} title=${`Chuyển ${paths.length} tài liệu`} onClose=${onClose}>
    <form class="stack" onSubmit=${save}>
      <label class="field"><span>Vào thư mục</span><${FolderSelect} folders=${folders} value=${folder} onChange=${setFolder} /></label>
      <${Live} error=${error} />
      <div class="dialog-actions"><button class="btn btn-primary" disabled=${busy}>${busy ? 'Đang chuyển…' : 'Chuyển'}</button></div>
    </form>
  <//>`;
}

/**
 * Đổi nguồn (chỉ Quản trị): chọn gốc trong danh sách người cài đặt cho phép. Bot luôn đọc CẢ kho —
 * không còn phạm vi thư mục mở riêng (ZALO_KB_PUBLIC_DIRS đã ngừng dùng).
 */
function SourceEditor({ onDone, onClose }) {
  const [roots, setRoots] = useState(null);
  const [dir, setDir] = useState('');
  const [subdirs, setSubdirs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/admin/kb/source').then((r) => {
      setRoots(r.roots); setDir(r.exists ? r.dir : (r.roots[0] || ''));
      setSubdirs(r.subdirs);
      if (!r.exists && r.roots[0]) choose(r.roots[0]);
    }).catch((e) => setError(e.message));
  }, []);
  async function choose(next) {
    setDir(next); setBusy(true); setError('');
    try { const r = await api(`/api/admin/kb/source?dir=${encodeURIComponent(next)}`); setSubdirs(r.subdirs); } catch (e) { setError(e.message); setSubdirs([]); } finally { setBusy(false); }
  }
  async function save(e) {
    e.preventDefault();
    if (!confirm('Bot sẽ đọc CẢ kho (mọi thư mục bên trong thư mục gốc). Tiếp tục?')) return;
    setBusy(true); setError('');
    try {
      const r = await api('/api/admin/kb/source', { method: 'PUT', body: { dir, allDirs: true } });
      onDone(r.changed ? 'Đã đổi nguồn. Khởi động lại trợ lý để bot đọc nguồn mới.' : 'Nguồn không thay đổi.');
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return html`<${Dialog} title="Sửa nguồn kho tri thức" onClose=${onClose}>
    ${!roots ? html`<${Live} error=${error} />${error ? null : html`<${Spinner} />`}` : !roots.length
      ? html`<${Notice} kind="info">Chưa có thư mục nào để chọn. Người cài đặt cần đặt ZALO_KB_DIR (hoặc danh sách ZALO_KB_ALLOWED_ROOTS, cách nhau bằng ";") trong cài đặt của trợ lý.<//>`
      : html`<form class="stack" onSubmit=${save}>
      <label class="field"><span>Thư mục gốc</span>
        <select value=${dir} disabled=${busy} onChange=${(e) => choose(e.currentTarget.value)}>${roots.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}</select>
        <small class="muted">Chỉ chọn được trong các thư mục người cài đặt cho phép (ZALO_KB_ALLOWED_ROOTS) — để bảo vệ dữ liệu trên máy. Thư mục Google Drive đồng bộ về máy dùng như thư mục thường.</small></label>
      <p class="muted small">Bot đọc toàn bộ thư mục này (luật an toàn vẫn áp: bỏ thư mục ẩn/mã nguồn và tên chứa khach-hang, secret, token…). Tài liệu tự tạo lưu trong <strong>tai-len-dashboard</strong>.</p>
      ${subdirs.length ? html`<p class="muted small">Thư mục con hiện có: ${subdirs.join(', ')}</p>` : null}
      <${Live} error=${error} />
      <div class="dialog-actions"><button class="btn btn-primary" disabled=${busy || !dir}>${busy ? 'Đang lưu…' : 'Lưu nguồn'}</button></div>
    </form>`}
  <//>`;
}

export function Kb({ me }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // { kind: 'doc', file } | { kind: 'note' } | { kind: 'source' }
  const [rev, setRev] = useState(0);
  const [picked, setPicked] = useState(() => new Set());
  const [folderFilter, setFolderFilter] = useState('all');
  const isAdmin = me?.role === 'admin';
  const load = (fresh) => api(`/api/kb${fresh ? '?fresh=1' : ''}`).then(setData).catch((e) => setMsg({ error: e.message }));
  useEffect(() => { load(); }, []);
  const done = (text) => { setOpen(null); setPicked(new Set()); setMsg({ ok: text }); setRev((r) => r + 1); load(true); };
  async function onPick(e) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const problem = uploadProblem(file, data.uploadTypes, data.maxBytes);
    if (problem) { setMsg({ error: problem }); return; }
    setBusy(true); setMsg({});
    const fid = newDocFolder(folderFilter, data.folders);
    try { const r = await sendFile(`/api/kb/upload${fid ? `?folder=${encodeURIComponent(fid)}` : ''}`, file); setMsg({ ok: `Đã tải lên ${nameOf(r.path)}. Bot thấy tệp mới trong vòng 5 phút.` }); await load(true); } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  async function removeMany(paths) {
    if (!confirm(`Xoá ${paths.length} tài liệu? Không hoàn tác được.`)) return;
    setBusy(true); setMsg({});
    try { const r = await api('/api/kb/files/delete', { method: 'POST', body: { paths } }); setPicked(new Set()); setMsg({ ok: `Đã xoá ${r.count} tài liệu.` }); await load(true); } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  const head = html`<${PageHead} title="Kho tri thức" sub="Tài liệu bot được tra cứu khi trả lời trong nhóm và tin nhắn riêng." />`;
  const banner = isAdmin ? html`<${RestartBanner} version=${rev} />` : null;
  const dialog = !open ? null
    : open.kind === 'doc' ? html`<${OwnDoc} file=${open.file} data=${data} onDone=${done} onClose=${() => setOpen(null)} />`
      : open.kind === 'note' ? html`<${NewNote} folder=${newDocFolder(folderFilter, data.folders)} onDone=${done} onClose=${() => setOpen(null)} />`
        : open.kind === 'folder' ? html`<${FolderEditor} folder=${open.folder} folders=${data.folders || []} onDone=${done} onClose=${() => setOpen(null)} />`
          : open.kind === 'move' ? html`<${MoveDocs} paths=${open.paths} folders=${data.folders || []} onDone=${done} onClose=${() => setOpen(null)} />`
            : html`<${SourceEditor} onDone=${done} onClose=${() => setOpen(null)} />`;
  if (!data) return html`${head}<${Live} error=${msg.error} />${msg.error ? null : html`<${Spinner} />`}`;
  if (!data.configured) {
    return html`${head}${banner}
      <${Notice} kind="info">Chưa có kho tri thức. ${isAdmin ? 'Bấm "Chọn nguồn" để chỉ thư mục tài liệu cho bot.' : 'Nhờ Quản trị chọn thư mục tài liệu cho bot.'}<//>
      ${isAdmin ? html`<p><button type="button" class="btn btn-primary" onClick=${() => setOpen({ kind: 'source' })}>Chọn nguồn…</button></p>` : null}
      <${Live} error=${msg.error} ok=${msg.ok} />${dialog}`;
  }
  const n = fold(q).trim();
  const hits = n ? data.files.filter((f) => fold(f.path).includes(n)) : [];
  const total = data.sources.reduce((a, s) => a + s.files + s.links, 0);
  const folders = data.folders || [];
  const filter = liveFilter(folderFilter, folders);
  const docFolder = docFolderOf(folders);
  const activeFolder = folders.find((f) => f.id === filter) || null;
  const docs = docsInFilter(data.own, folders, filter);
  const own = docs.map((f) => ({ uid: f.path }));
  const sel = stillPicked(picked, own);
  return html`${head}${banner}
    <${Live} error=${msg.error} ok=${msg.ok} />
    <section class="card">
      <div class="toolbar"><h2>Nguồn có sẵn <small class="muted">${new Intl.NumberFormat('vi-VN').format(total)}${data.truncated ? '+' : ''} tệp</small></h2>
        ${isAdmin ? html`<button type="button" class="btn btn-secondary btn-sm" onClick=${() => setOpen({ kind: 'source' })}><${Icon} name="settings" size=${16} /> Sửa nguồn</button>` : null}
        <button type="button" class="btn btn-secondary btn-sm" onClick=${() => load(true)}><${Icon} name="refresh" size=${16} /> Tải lại</button></div>
      ${data.sources.length ? html`<ul class="row-list">${data.sources.map((s) => html`<li key=${s.name || '.'} class="row-item">
        <${Icon} name="folder" />
        <span class="row-main"><strong>${s.name || 'Thư mục gốc'}</strong><small class="muted">${sourceCount(s)}</small></span>
      </li>`)}</ul>` : html`<p class="muted">Nguồn chưa có tệp nào bot đọc được.</p>`}
      ${data.truncated ? html`<p class="muted small">Kho lớn hoặc nằm trên ổ mạng — chỉ đếm một phần (tối đa 3000 tệp mới sửa gần nhất).</p>` : null}
      <details class="kb-find">
        <summary>Tìm một tệp trong nguồn</summary>
        <label class="sr-only" for="kb-q">Tìm tệp</label>
        <input id="kb-q" type="search" placeholder="Gõ tên tệp hoặc thư mục…" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
        ${n ? html`<ul class="row-list">${hits.slice(0, 50).map((f) => html`<li key=${f.path} class="row-item">
          <span class="row-main"><span class="mono">${f.path}</span><small class="muted">${fmtSize(f.size)} · ${fmtTime(f.mtime)}</small></span></li>`)}</ul>
          <p class="muted small">${hits.length ? (hits.length > 50 ? `Hiện 50/${hits.length} kết quả — gõ cụ thể hơn.` : `${hits.length} kết quả.`) : 'Không thấy tệp nào.'}</p>` : null}
      </details>
    </section>
    <section class="card">
      <div class="toolbar"><h2>Tài liệu tự tạo <small class="muted">${data.own.length}</small></h2>
        <button type="button" class="btn btn-primary btn-sm" onClick=${() => setOpen({ kind: 'note' })}><${Icon} name="plus" size=${16} /> Viết tài liệu mới</button>
        <label class="btn btn-secondary btn-sm file-btn">
          <input class="sr-only" type="file" accept=${data.uploadTypes.join(',')} disabled=${busy} onChange=${onPick} />
          ${busy ? 'Đang tải lên…' : 'Tải tệp lên…'}</label>
        <button type="button" class="btn btn-secondary btn-sm" onClick=${() => setOpen({ kind: 'folder', folder: null })}><${Icon} name="folder" size=${16} /> Thư mục mới</button></div>
      <p class="muted small">Nhận ${data.uploadTypes.join(', ')}, tối đa ${fmtSize(data.maxBytes)}.${activeFolder ? ` Tài liệu mới vào thư mục ${activeFolder.name}.` : ''}</p>
      ${folders.length ? html`<div class="kb-folder-bar">
        <${FolderFilter} folders=${folders} items=${data.own} of=${docFolder} value=${filter} onChange=${(v) => { setFolderFilter(v); setPicked(new Set()); }} label="Lọc tài liệu theo thư mục" />
        ${activeFolder ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setOpen({ kind: 'folder', folder: activeFolder })}>
          <${Icon} name="settings" size=${16} /> Sửa thư mục</button>` : null}
      </div>` : null}
      ${data.own.length > 1 ? html`<${BulkBar} shown=${own} picked=${new Set(sel)} onPick=${setPicked} filtered=${filter !== 'all'} unit="tài liệu">
        ${folders.length ? html`<button type="button" class="btn btn-secondary btn-sm" disabled=${busy} onClick=${() => setOpen({ kind: 'move', paths: sel })}>Chuyển vào thư mục…</button>` : null}
        <button type="button" class="btn btn-danger-outline btn-sm" disabled=${busy} onClick=${() => removeMany(sel)}>Xoá ${sel.length} tài liệu</button><//>` : null}
      ${docs.length ? html`<ul class="row-list">${docs.map((f) => html`<li key=${f.path} class="row-item">
        ${data.own.length > 1 ? html`<input type="checkbox" class="bulk-check" checked=${picked.has(f.path)} disabled=${busy}
          aria-label=${`Chọn ${nameOf(f.path)}`} onChange=${() => setPicked(flip(picked, f.path))} />` : null}
        <${Icon} name="file" />
        <span class="row-main"><span>${nameOf(f.path)}</span><small class="muted">${docFolder(f) ? html`<${FolderChip} folder=${docFolder(f)} /> ` : null}${fmtSize(f.size)} · ${fmtTime(f.mtime)}</small></span>
        <button type="button" class="btn btn-secondary btn-sm" aria-label=${`Chi tiết ${nameOf(f.path)}`} onClick=${() => setOpen({ kind: 'doc', file: f })}>Chi tiết</button>
      </li>`)}</ul>` : html`<p class="muted">${data.own.length ? 'Thư mục này chưa có tài liệu.' : 'Chưa có — viết tài liệu mới hoặc tải tệp lên.'}</p>`}
    </section>
    ${dialog}`;
}
