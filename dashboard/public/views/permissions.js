// Phân quyền Bot (spec §9): trái là "Nhắn riêng", "Hạn mức xưởng", "Mặc định" + danh sách nhóm có ô tìm; phải là
// Hoạt động, Chỉ trả lời khi được tag, 9 nút tính năng và hộp Xưởng tạo sản phẩm (spec §17). Lưu là có hiệu lực ngay.
import { useEffect, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, Icon, Live, Notice, PageHead, SaveBar, Spinner, Toggle, onText } from '../ui.js';
import { fold } from '../fold.js';
import { DmEditor, dmBadge } from './dm-permissions.js';
import { FolderPeople } from './folder-people.js';
import { MoveToFolder, addGroupsToFolder } from './move-to-folder.js';
import { BulkBar, flip, stillPicked, toggleAll } from './multi-pick.js';
import { FolderChip, FolderColorPicker, FolderFilter, colorOf, inFolderFilter } from './folder-ui.js';
import { StudioBox, applyPolicy, lockedByPolicy, parseQuota, studioComplete } from './studio-box.js';
import { QuotaEditor, quotaBadge } from './studio-quota.js';
import { CallWordsEditor } from './call-words.js';
import { modelOptions } from './agent.js';

export const DEFAULTS_KEY = 'defaults';
// Mục "Nhắn riêng" và "Hạn mức xưởng" ở đầu danh sách; mã nhóm Zalo luôn là số nên không trùng.
export const DM_KEY = 'dm';
export const QUOTA_KEY = 'studio';
export const CALL_KEY = 'call';
// Bảng "Chỉnh nhiều nhóm" (chế độ Chọn nhiều) — trên điện thoại mở bằng nút "Chỉnh N nhóm".
export const BULK_KEY = 'bulk';
// Thư mục nhóm: khoá chọn `f:<mã>` (mã nhóm Zalo luôn là số nên không trùng).
export const FOLDER_PREFIX = 'f:';
const pick = (s) => ({ active: s.active, replyOnlyTagged: s.replyOnlyTagged, paused: s.paused, features: { ...s.features },
  studio: { ...(s.studio || {}) }, studioQuota: s.studioQuota ?? null, imageQuota: s.imageQuota ?? null, videoQuota: s.videoQuota ?? null,
  soulReminder: s.soulReminder || '', modelOverride: s.modelOverride || '' });
// Hạn mức theo nhóm/thư mục: lượt xưởng, ảnh AI, video AI (null = theo lớp trên).
const QUOTA_KEYS = ['studioQuota', 'imageQuota', 'videoQuota'];
const MAX_RULES = 3000; // = MAX_FOLDER_RULES (lib/permissions.js)
const MAX_REMINDER = 1000; // = MAX_SOUL (lib/permissions.js)
const sameQuotas = (a, b) => QUOTA_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
const sameBools = (a = {}, b = {}) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);
const quotaText = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * Gộp danh sách nhóm của bot với permissions.json: nhóm bot đang ở (theo thứ tự bot trả) trước,
 * rồi nhóm chỉ còn trong tệp (bot đã rời hoặc Zalo đang tắt). Mỗi nhóm mang quyền đang hiệu lực.
 */
export function folderOfGroup(perms, id) {
  return (perms.folders || []).find((f) => f.groups.includes(id)) || null;
}

/** Cài đặt nền của nhóm: thư mục chứa nó (nếu có), không thì mặc định. */
export function baseOfGroup(perms, id) {
  return folderOfGroup(perms, id) || perms.defaults;
}

export function mergeGroups(groups, perms) {
  const seen = new Set();
  const out = [];
  const add = (id, name, members) => {
    if (seen.has(id)) return;
    seen.add(id);
    const own = perms.groups[id];
    const folder = folderOfGroup(perms, id);
    const base = folder || perms.defaults;
    // Mục trong tệp có thể trùng hẳn nền (tệp của bản cũ từng ghi cờ tag vào từng nhóm) — khi đó không coi là chỉnh riêng.
    const custom = Boolean(own) && !sameSettings(own, base);
    // Danh sách cũ ở Cấu hình chỉ còn tác dụng với nhóm chưa có mục riêng trong tệp và không thuộc thư mục nào.
    const ownerOnly = !own && !folder && (perms.legacyOwnerOnly || []).includes(id);
    out.push({ id, name: name || 'Nhóm chưa rõ tên', members, custom, ownerOnly,
      folder: folder ? { id: folder.id, name: folder.name } : null, ...pick(own || base) });
  };
  for (const g of groups || []) add(g.id, g.name, g.members);
  for (const [id, g] of Object.entries(perms.groups)) add(id, g.name, null);
  return out;
}

/** Hai bộ cài đặt trùng nhau ở MỌI trường người dùng sửa được — dùng để bật/tắt nút Lưu. */
export function sameSettings(a, b) {
  return a.active === b.active && a.replyOnlyTagged === b.replyOnlyTagged && Boolean(a.paused) === Boolean(b.paused)
    && sameBools(a.features, b.features) && (a.modelOverride || '') === (b.modelOverride || '')
    && (a.soulReminder || '') === (b.soulReminder || '') && sameQuotas(a, b)
    && Object.keys({ ...a.studio, ...b.studio }).every((k) => a.studio?.[k] === b.studio?.[k]);
}

/** Số thay đổi của một nhóm/mặc định: Hoạt động, Chỉ trả lời khi được tag, tính năng, nút xưởng, số lượt, lời nhắc riêng, model riêng. */
export function changeCount(a, b) {
  let n = (a.active !== b.active) + (a.replyOnlyTagged !== b.replyOnlyTagged) + (Boolean(a.paused) !== Boolean(b.paused))
    + QUOTA_KEYS.filter((k) => (a[k] ?? null) !== (b[k] ?? null)).length;
  if ((a.soulReminder || '') !== (b.soulReminder || '')) n += 1;
  if ((a.modelOverride || '') !== (b.modelOverride || '')) n += 1;
  for (const k of Object.keys({ ...a.features, ...b.features })) if (a.features[k] !== b.features[k]) n += 1;
  for (const k of Object.keys({ ...a.studio, ...b.studio })) if (a.studio?.[k] !== b.studio?.[k]) n += 1;
  return n;
}

/** Thân PUT của nhóm/mặc định: nút xưởng chỉ gửi khi đủ khoá; số lượt chỉ có ở nhóm. */
export function settingsPayload(d, { isGroup, studioFeatures = [], policy, previous = {} }) {
  const body = { active: d.active, replyOnlyTagged: d.replyOnlyTagged, features: { ...d.features } };
  if (isGroup) body.paused = Boolean(d.paused);
  if (studioComplete(d.studio, studioFeatures)) body.studio = applyPolicy(d.studio, policy);
  if (isGroup) for (const k of QUOTA_KEYS) body[k] = d[k] ?? null;
  // Lời nhắc riêng chỉ có nghĩa với nhóm; "Mặc định" dùng ô ZALO_SOUL_REMINDER ở trang Cấu hình.
  // Nhóm không đặt gì thì không gửi khoá — đó cũng là hình dạng tệp mà diffLayer coi là "không chỉnh riêng".
  // Chỉ gửi chuỗi rỗng khi chủ động xoá câu đang có, vì vắng mặt = giữ nguyên.
  const soul = (d.soulReminder || '').trim();
  if (isGroup && (soul || (previous.soulReminder || '').trim())) body.soulReminder = soul;
  // Model riêng của nhóm/thư mục: cùng quy tắc — gửi chuỗi rỗng chỉ khi đang có ghim cần bỏ.
  // "Mặc định" không có ô này: model chung đổi ở trang Khoá API & Model.
  const model = (d.modelOverride || '').trim();
  if (isGroup && (model || (previous.modelOverride || '').trim())) body.modelOverride = model;
  return body;
}

/** Nhãn ngắn cạnh tên nhóm trong danh sách; null khi nhóm đang đúng mặc định. */
export function groupBadge(g) {
  if (g.ownerOnly) return { kind: 'danger', text: 'Chỉ chủ nhân (Cấu hình)' };
  if (!g.active) return { kind: 'danger', text: 'Đang tắt' };
  const off = Object.values(g.features).filter((v) => !v).length;
  if (off) return { kind: 'warn', text: `Tắt ${off} tính năng` };
  return g.custom ? { kind: 'idle', text: 'Chỉnh riêng' } : null;
}

export const LEAVE_MSG = 'Bạn có thay đổi chưa lưu ở nhóm này. Bỏ thay đổi và chuyển nhóm?';
export const SAVED_DEFAULT_MSG = 'Đã lưu — nhóm này đang dùng mặc định. Bot hiện không thấy nhóm này nên nhóm được ẩn khỏi danh sách.';

/** Được rời mục đang sửa không: không có thay đổi chưa lưu, hoặc người dùng đồng ý bỏ. */
export function mayLeave(dirty, ask) {
  return !dirty || Boolean(ask(LEAVE_MSG));
}

/** Sau khi lưu, nhóm còn trong danh sách không — nhóm chỉ có trong tệp, đưa về mặc định thì mất mục trong tệp. */
export function staysListed(id, perms, groups) {
  return id === DEFAULTS_KEY || id === DM_KEY || id === QUOTA_KEY || String(id).startsWith(FOLDER_PREFIX)
    || Boolean(perms.groups[id]) || Boolean(folderOfGroup(perms, id)) || (groups || []).some((g) => g.id === id);
}

/**
 * Máy chủ đã BỎ khoá `modelOverride` mình vừa gửi? Bản dashboard cũ (trước 2.54) trả 200 nhưng không biết
 * khoá này, nên ghim model biến mất trong im lặng — người dùng chỉ thấy thanh lưu mãi báo "còn thay đổi".
 * Phát hiện được thì báo thẳng thay vì để họ đoán.
 */
export function modelDropped(reply, id, draft) {
  const want = String(draft?.modelOverride || '').trim();
  if (!want) return false;
  return !String(reply?.groups?.[id]?.modelOverride || '').trim();
}

/** Sửa quyền một nhóm/mặc định. `head=false` khi nhúng vào bảng Quyền của Phiên chat (bảng đã có tiêu đề). */
export function Editor({ target, value, defaults, features, studioFeatures, studioPolicy, defaultQuota, mediaDefaults = null, onSaved, onBack, onDirty, head = true,
  path: savePath = null, baseLabel = 'Dùng mặc định', note = null, modelChoices = null, onReloadModels = null }) {
  const isGroup = target.id !== DEFAULTS_KEY;
  // Thư mục cũng dùng Editor này (qua FolderEditor) — lời nhắc của thư mục áp cho mọi nhóm bên trong.
  const isFolder = String(target.id).startsWith(FOLDER_PREFIX);
  const [draft, setDraft] = useState(() => pick(value));
  const [qText, setQText] = useState(() => quotaText(value.studioQuota));
  const [mText, setMText] = useState(() => ({ imageQuota: quotaText(value.imageQuota), videoQuota: quotaText(value.videoQuota) }));
  const mQuota = { imageQuota: parseQuota(mText.imageQuota), videoQuota: parseQuota(mText.videoQuota) };
  const mError = mQuota.imageQuota.error || mQuota.videoQuota.error;
  const resetMedia = (v) => setMText({ imageQuota: quotaText(v.imageQuota), videoQuota: quotaText(v.videoQuota) });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  // Ô lọc cho danh sách model riêng của nhóm/thư mục (cùng cách lọc như trang Khoá API & Model).
  const [modelQ, setModelQ] = useState('');
  const quota = parseQuota(qText);
  const dirty = !sameSettings(draft, value) || quotaText(draft.studioQuota) !== qText.trim()
    || ['imageQuota', 'videoQuota'].some((k) => quotaText(draft[k]) !== mText[k].trim());
  useEffect(() => { onDirty(dirty); }, [dirty]);
  useEffect(() => () => onDirty(false), []);
  const set = (patch) => { setDraft((d) => ({ ...d, ...patch })); setMsg({}); };
  const setFeature = (k, v) => { setDraft((d) => ({ ...d, features: { ...d.features, [k]: v } })); setMsg({}); };

  async function save(e) {
    e.preventDefault();
    if (busy || !dirty) return;
    if (quota.error) { setMsg({ error: `Số lượt xưởng: ${quota.error} Sửa ô đó rồi lưu lại, hoặc để trống để theo mặc định.` }); return; }
    if (mError) { setMsg({ error: `Số ảnh/video AI: ${mError} Sửa ô đó rồi lưu lại, hoặc để trống để theo mặc định.` }); return; }
    setBusy(true); setMsg({});
    try {
      const path = savePath || (isGroup ? `/api/permissions/groups/${encodeURIComponent(target.id)}` : '/api/permissions/defaults');
      const r = await api(path, { method: 'PUT', body: settingsPayload(draft, { isGroup, studioFeatures, policy: studioPolicy, previous: value }) });
      // Máy chủ cũ trả 200 nhưng bỏ khoá nó không biết (vd. modelOverride của bản 2.53): phải nói ra, chứ
      // im lặng thì thanh lưu cứ báo "còn thay đổi" mà người dùng không hiểu vì sao.
      if (modelDropped(r, target.id, draft)) {
        setMsg({ error: 'Máy chủ chưa hiểu mục Model riêng — bản dashboard đang chạy còn cũ. Khởi động lại dashboard rồi lưu lại.' });
        return;
      }
      if (onSaved(r, target.id)) setMsg({ ok: 'Đã lưu — bot áp dụng ngay, không cần khởi động lại.' });
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }

  const p = `perm-${target.id}`;
  return html`<form class="perm-form" onSubmit=${save} novalidate>
    ${head ? html`<header class="thread-head">
      <button type="button" class="btn btn-ghost btn-sm only-mobile" onClick=${onBack}>← Danh sách</button>
      <h2>${target.name}</h2>
      ${isGroup && target.members ? html`<span class="tag">${target.members} thành viên</span>` : null}
    </header>` : null}
    ${isGroup && target.ownerOnly ? html`<${Notice} kind="warn">Nhóm này đang nằm trong danh sách cũ <strong>Nhóm chỉ chủ nhân gọi được bot</strong> (trang Cấu hình): thành viên tag bot thì bot im. Lưu phân quyền riêng cho nhóm ở đây thì phân quyền này thắng danh sách đó.<//>` : null}
    <div class="perm-note-row">
      <p class="muted small perm-note">${note || (isGroup
        ? 'Chỉ áp cho thành viên trong nhóm này. Chủ nhân bot luôn dùng được mọi tính năng.'
        : 'Áp cho mọi nhóm. Nhóm chỉnh riêng chỉ giữ những mục khác mặc định; mục còn lại đi theo Mặc định. Chủ nhân bot luôn dùng được mọi tính năng; tin nhắn riêng chỉnh ở mục Nhắn riêng.')}</p>
      ${isGroup ? html`<button type="button" class="btn btn-secondary btn-sm" disabled=${busy || sameSettings(draft, defaults)}
        onClick=${() => { set(pick(defaults)); setQText(quotaText(defaults.studioQuota)); resetMedia(defaults); }}>${baseLabel}</button>` : null}
    </div>
    <fieldset class="perm-box">
      <legend>Cách bot trả lời</legend>
      <div class="perm-grid">
        <${Toggle} id=${`${p}-active`} checked=${draft.active} onChange=${(v) => set({ active: v })} label="Hoạt động"
          hint="Tắt thì bot không trả lời thành viên trong nhóm."
          more="Bot vẫn đọc tin để hiểu ngữ cảnh khi chủ nhân hỏi. Việc hẹn giờ do thành viên tạo không còn gửi tin chữ vào nhóm đang tắt; muốn dừng hẳn, nhờ chủ nhân xoá việc đó. Việc chủ nhân hẹn vẫn gửi." />
        <${Toggle} id=${`${p}-tag`} checked=${draft.replyOnlyTagged} onChange=${(v) => set({ replyOnlyTagged: v })} label="Chỉ trả lời khi được tag"
          hint="Tắt thì bot trả lời mọi tin trong nhóm." />
        ${isGroup ? html`<${Toggle} id=${`${p}-paused`} checked=${Boolean(draft.paused)} onChange=${(v) => set({ paused: v })} label="Tạm dừng (/shutup)"
          hint="Bật thì bot không đáp bất kỳ tin nào trong nhóm, kể cả tin có tag."
          more="Chỉ chủ nhân còn gõ được lệnh: /silent hoặc /talk gọi bot lại (luôn nhả tạm dừng). Tin trong lúc tạm dừng vẫn được giữ làm ngữ cảnh để lúc được gọi lại bot trả lời đúng mạch." />` : null}
      </div>
    </fieldset>
    ${draft.active ? null : html`<${Notice} kind="info">Nhóm đang tắt nên các tính năng dưới đây chưa dùng tới. Bật "Hoạt động" ở trên để chỉnh.<//>`}
    <details class="perm-box" open>
      <summary><span>Tính năng cho thành viên</span><span class="muted perm-box-sum">· ${onText(draft.features, features)}</span></summary>
      <fieldset class="perm-grid" disabled=${!draft.active}>
        <legend class="sr-only">Tính năng cho thành viên</legend>
        ${features.map((f) => html`<${Toggle} key=${f.key} id=${`${p}-${f.key}`} checked=${draft.features[f.key]}
          onChange=${(v) => setFeature(f.key, v)} label=${f.label} hint=${f.hint} />`)}
      </fieldset>
    </details>
    <${StudioBox} id=${`${p}-studio`} studio=${draft.studio} features=${studioFeatures} disabled=${!draft.active}
      onChange=${(studio) => set({ studio })} policy=${studioPolicy} quota=${qText} defaultQuota=${defaultQuota} quotaError=${quota.error}
      quotaHint=${isGroup ? `Để trống để theo mặc định (${defaultQuota}); 0 = không ai trong nhóm được nhờ, trừ người có hạn mức riêng (đặt ở mục Hạn mức xưởng, thắng số của nhóm).` : ''}
      onQuota=${isGroup ? (text) => { setQText(text); setMsg({}); const q = parseQuota(text); if (!q.error) set({ studioQuota: q.value }); } : null}
      media=${isGroup ? mText : null} mediaDefaults=${mediaDefaults || { image: 5, video: 1 }} mediaErrors=${{ imageQuota: mQuota.imageQuota.error, videoQuota: mQuota.videoQuota.error }}
      onMedia=${isGroup ? (k, text) => { setMText((m) => ({ ...m, [k]: text })); setMsg({}); const q = parseQuota(text); if (!q.error) set({ [k]: q.value }); } : null}
      note=${isGroup ? '' : `Số lượt mỗi người mỗi ngày chỉnh ở mục Hạn mức xưởng (đang là ${defaultQuota}).`} />
    ${isGroup ? html`<details class="perm-box" open=${Boolean(draft.soulReminder)}>
      <summary><span>${isFolder ? 'Dòng nhắc riêng của thư mục' : 'Dòng nhắc riêng của nhóm'}</span><span class="muted perm-box-sum">· ${draft.soulReminder ? 'đang dùng' : 'chưa đặt'}</span></summary>
      <p class="muted small">${isFolder
        ? 'Mọi nhóm trong thư mục nhận câu này; nhóm đặt riêng thì câu của nhóm thắng. '
        : 'Chỉ nhóm này nhận; để trống thì theo thư mục (nếu có), không thì chỉ dùng dòng nhắc chung. '}
        Bot nối câu này vào <strong>cuối</strong> tin, ngay sau dòng nhắc chung ở Cấu hình, nên mô hình đọc nó sau cùng. Một dòng, tối đa ${MAX_REMINDER} ký tự.</p>
      <label for=${`${p}-soul`} class="sr-only">${isFolder ? 'Dòng nhắc riêng của thư mục' : 'Dòng nhắc riêng của nhóm'}</label>
      <textarea id=${`${p}-soul`} rows="3" maxlength=${MAX_REMINDER} value=${draft.soulReminder || ''}
        onInput=${(e) => set({ soulReminder: e.currentTarget.value })}
        placeholder="Vd. Nhóm này là lớp 12A: xưng em, gọi các bạn là anh chị. Không đưa đáp án bài kiểm tra, chỉ gợi ý."></textarea>
      <p class="muted small">${(draft.soulReminder || '').trim().length}/${MAX_REMINDER} ký tự</p>
    </details>` : null}
    ${isGroup ? html`<details class="perm-box" open=${Boolean(draft.modelOverride)}>
      <summary><span>${isFolder ? 'Model riêng của thư mục' : 'Model riêng của nhóm'}</span><span class="muted perm-box-sum">· ${draft.modelOverride ? `đang ghim ${draft.modelOverride}` : 'theo model chung'}</span></summary>
      <p class="muted small">${isFolder
        ? 'Mọi nhóm trong thư mục dùng model này; nhóm ghim riêng thì model của nhóm thắng. '
        : 'Chỉ nhóm này dùng model này; để trống thì theo thư mục (nếu có), không thì theo model chung của bot. '}
        Model chung đổi ở trang <a href="#/ai">Khoá API &amp; Model</a> (như lệnh <span class="mono">/model</span> trong Zalo). Lưu là có hiệu lực từ tin kế tiếp.</p>
      ${modelChoices && modelChoices.models.length ? html`<div class="field"><label for=${`${p}-model-q`} class="sr-only">Lọc model</label>
        <input id=${`${p}-model-q`} type="search" placeholder="Lọc, vd. gemini" aria-label="Lọc model" value=${modelQ} onInput=${(e) => setModelQ(e.currentTarget.value)} />
        <label for=${`${p}-model`} class="sr-only">${isFolder ? 'Model riêng của thư mục' : 'Model riêng của nhóm'}</label>
        <select id=${`${p}-model`} value=${draft.modelOverride || ''} onChange=${(e) => set({ modelOverride: e.currentTarget.value })}>
          <option value="">Theo ${isFolder ? 'model chung' : 'thư mục / model chung'}${modelChoices.defaultModel ? ` (${modelChoices.defaultModel})` : ''}</option>
          ${modelOptions({ current: draft.modelOverride, choices: modelChoices.choices, all: modelChoices.models, q: modelQ }).map((m) => html`<option key=${m} value=${m}>${m}${m === modelChoices.defaultModel ? ' (mặc định /model)' : ''}</option>`)}
        </select>
        <small class="muted">${modelChoices.listError || 'Danh sách lấy từ cổng AI (gồm cả combo).'}</small></div>`
      : html`<p class="muted small">${modelChoices?.listError
          ? `Chưa lấy được danh sách model: ${modelChoices.listError} Cổng AI trả ~2400 model nên lần đầu có thể mất 10–15 giây.`
          : 'Chưa lấy được danh sách model từ cổng AI.'}
        ${onReloadModels ? html` <button type="button" class="btn btn-secondary btn-sm" disabled=${busy} onClick=${onReloadModels}>Tải lại danh sách</button>` : null}</p>`}
    </details>` : null}
    <${SaveBar} count=${changeCount(draft, value) || (dirty ? 1 : 0)} busy=${busy} canSave=${dirty && !quota.error && !mError} msg=${msg}
      onUndo=${() => { setDraft(pick(value)); setQText(quotaText(value.studioQuota)); resetMedia(value); setMsg({}); }} />
  </form>`;
}

/** Chọn ở bảng chỉnh nhiều nhóm: mỗi mục 'keep' (giữ nguyên), 'on' hoặc 'off'. */
export const BULK_CHOICES = [{ value: 'keep', label: 'Giữ nguyên' }, { value: 'on', label: 'Bật' }, { value: 'off', label: 'Tắt' }];

/**
 * Thân `patch` của PUT /api/permissions/groups từ các lựa chọn `{ khoá: 'keep'|'on'|'off' }`: chỉ mục chọn Bật/Tắt;
 * nút xưởng bị máy chủ khoá thì không gửi. Không có gì đổi → null.
 */
export function bulkPatch(choices, { features = [], studioFeatures = [], policy } = {}) {
  const val = (k) => (choices[k] === 'on' ? true : choices[k] === 'off' ? false : undefined);
  const patch = {};
  for (const k of ['active', 'replyOnlyTagged']) if (val(k) !== undefined) patch[k] = val(k);
  const pick = (list) => Object.fromEntries(list.filter((f) => val(f.key) !== undefined).map((f) => [f.key, val(f.key)]));
  const f = pick(features);
  const s = pick(studioFeatures.filter((x) => !lockedByPolicy(x.key, policy)));
  if (Object.keys(f).length) patch.features = f;
  if (Object.keys(s).length) patch.studio = s;
  return Object.keys(patch).length ? patch : null;
}

/** Số mục một `patch` đổi (công tắc + từng nút). */
export const bulkCount = (patch) => ['active', 'replyOnlyTagged'].filter((k) => k in patch).length
  + Object.keys(patch.features || {}).length + Object.keys(patch.studio || {}).length;

/** Bảng bên phải ở chế độ "Chọn nhiều": áp một thay đổi cho mọi nhóm đã chọn. */
function BulkGroups({ picked, list, features, studioFeatures, studioPolicy, folders = [], onSaved, onBack, onDirty }) {
  const [choices, setChoices] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({});
  const patch = bulkPatch(choices, { features, studioFeatures, policy: studioPolicy });
  useEffect(() => { onDirty(Boolean(patch)); }, [Boolean(patch)]);
  useEffect(() => () => onDirty(false), []);
  const names = list.filter((g) => picked.includes(g.id)).map((g) => g.name);
  async function apply(e) {
    e.preventDefault();
    if (busy || !patch || !picked.length) return;
    setBusy(true); setMsg({});
    try {
      const r = await api('/api/permissions/groups', { method: 'PUT', body: { ids: picked, patch } });
      onSaved(r); setChoices({});
      setMsg({ ok: `Đã áp cho ${picked.length} nhóm — bot áp dụng ngay.` });
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  const row = (key, label, locked = false) => html`<div class="bulk-choice" key=${key}>
    <label for=${`bulk-${key}`}>${label}</label>
    <select id=${`bulk-${key}`} disabled=${locked} value=${locked ? 'keep' : choices[key] || 'keep'}
      onChange=${(e) => { setChoices({ ...choices, [key]: e.currentTarget.value }); setMsg({}); }}>
      ${BULK_CHOICES.map((c) => html`<option key=${c.value} value=${c.value}>${c.label}</option>`)}</select>
  </div>`;
  return html`<form class="perm-form" onSubmit=${apply} novalidate>
    <header class="thread-head">
      <button type="button" class="btn btn-ghost btn-sm only-mobile" onClick=${onBack}>← Danh sách</button>
      <h2>Chỉnh ${picked.length} nhóm đã chọn</h2>
    </header>
    <p class="muted small perm-note">${picked.length
      ? `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` và ${names.length - 5} nhóm khác` : ''}. Chỉ mục chọn Bật/Tắt được đổi; mục "Giữ nguyên" giữ cài đặt riêng của từng nhóm.`
      : 'Tích chọn nhóm ở danh sách bên trái.'}</p>
    <fieldset class="perm-box">
      <legend>Chuyển vào thư mục</legend>
      <p class="muted small">Nhóm theo cài đặt và quy tắc riêng của thư mục mới; nhóm đang ở thư mục khác được chuyển sang. Phần chỉnh riêng của từng nhóm giữ nguyên.</p>
      <${MoveToFolder} id="bulk-move" folders=${folders} count=${picked.length} unit="nhóm"
        onMove=${async (fid, created) => {
          const r = await addGroupsToFolder((created || { folders }).folders, fid, picked);
          onSaved(r);
          return `Đã chuyển ${picked.length} nhóm vào thư mục "${r.folders.find((f) => f.id === fid)?.name || ''}".`;
        }} />
    </fieldset>
    <fieldset class="perm-box">
      <legend>Cách bot trả lời</legend>
      <div class="perm-grid">${row('active', 'Hoạt động')}${row('replyOnlyTagged', 'Chỉ trả lời khi được tag')}${row('paused', 'Tạm dừng')}</div>
    </fieldset>
    <fieldset class="perm-box">
      <legend>Tính năng cho thành viên</legend>
      <div class="perm-grid">${features.map((f) => row(f.key, f.label))}</div>
    </fieldset>
    ${studioFeatures.length ? html`<fieldset class="perm-box">
      <legend>Xưởng tạo sản phẩm</legend>
      <div class="perm-grid">${studioFeatures.map((f) => row(f.key, f.label, lockedByPolicy(f.key, studioPolicy)))}</div>
    </fieldset>` : null}
    <div class="save-bar">
      <${Live} error=${msg.error} ok=${msg.ok} />
      <span class=${`save-bar-text${patch ? '' : ' muted'}`}>${patch ? `${bulkCount(patch)} mục sẽ đổi` : 'Chưa chọn thay đổi.'}</span>
      <button type="button" class="btn btn-secondary" disabled=${busy || !patch} onClick=${() => { setChoices({}); setMsg({}); }}>Hoàn tác</button>
      <button class="btn btn-primary" disabled=${busy || !patch || !picked.length}>${busy ? 'Đang lưu…' : `Áp cho ${picked.length} nhóm`}</button>
    </div>
  </form>`;
}

/** Nhãn của thư mục ở danh sách bên trái. */
export function folderBadge(f) {
  const n = (f.people || []).length;
  const count = `${f.groups.length} nhóm${n ? ` · ${n} người` : ''}`;
  if (!f.active) return { kind: 'danger', text: `Đang tắt · ${count}` };
  return { kind: 'idle', text: count };
}

function FolderEditor({ folder, perms, list, admin, onSaved, onBack, onDirty, onDeleted, modelChoices = null, onReloadModels = null }) {
  const [name, setName] = useState(folder.name);
  const [picked, setPicked] = useState(() => new Set(folder.groups));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const membersDirty = picked.size !== folder.groups.length || folder.groups.some((id) => !picked.has(id));
  const [rules, setRules] = useState(folder.rules || '');
  const rulesDirty = rules.trim() !== (folder.rules || '');
  const base = `/api/permissions/folders/${encodeURIComponent(folder.id)}`;
  async function run(key, path, method, body, ok) {
    setBusy(key); setMsg({});
    try { const r = await api(path, { method, body }); onSaved(r); setMsg({ ok: typeof ok === 'function' ? ok(r) : ok }); return r; }
    catch (err) { setMsg({ error: err.message }); return null; } finally { setBusy(''); }
  }
  const needle = fold(q.trim());
  const shown = list.filter((g) => !needle || fold(g.name).includes(needle));
  const toggle = (id) => setPicked((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return html`<div class="perm-form folder-edit">
    <header class="thread-head">
      <button type="button" class="btn btn-ghost btn-sm only-mobile" onClick=${onBack}>← Danh sách</button>
      <h2><span class=${`fdot fdot-${colorOf(folder)}`} aria-hidden="true"></span> ${folder.name}</h2>
      <span class=${`badge badge-${folderBadge(folder).kind}`}>${folderBadge(folder).text}</span>
    </header>
    <${Live} error=${msg.error} ok=${msg.ok} />
    <fieldset class="perm-box">
      <legend>Bật / tắt nhanh</legend>
      <p class="muted small">Áp cho mọi nhóm trong thư mục ngay lập tức, bỏ cả phần "Hoạt động" từng nhóm chỉnh riêng.</p>
      <div class="row">
        <button type="button" class="btn btn-primary btn-sm" disabled=${busy !== '' || !folder.groups.length}
          onClick=${() => run('on', `${base}/active`, 'PUT', { active: true }, (r) => `Đã bật bot ở ${folder.groups.length} nhóm${r.cleared ? ` (bỏ chỉnh riêng ở ${r.cleared} nhóm)` : ''}.`)}>Bật bot cả thư mục</button>
        <button type="button" class="btn btn-danger-outline btn-sm" disabled=${busy !== '' || !folder.groups.length}
          onClick=${() => run('off', `${base}/active`, 'PUT', { active: false }, (r) => `Đã tắt bot ở ${folder.groups.length} nhóm${r.cleared ? ` (bỏ chỉnh riêng ở ${r.cleared} nhóm)` : ''}.`)}>Tắt bot cả thư mục</button>
      </div>
    </fieldset>
    <details class="perm-box" open=${!folder.groups.length}>
      <summary><span>Nhóm trong thư mục</span><span class="muted perm-box-sum">· ${picked.size} nhóm${membersDirty ? ' (chưa lưu)' : ''}</span></summary>
      <p class="muted small">Mỗi nhóm thuộc một thư mục — chọn nhóm đang ở thư mục khác sẽ chuyển nó sang đây.</p>
      <label for="folder-q" class="sr-only">Lọc nhóm theo tên</label>
      <div class="multi-pick-bar">
        <input id="folder-q" type="search" maxlength="100" placeholder="Lọc nhóm theo tên" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
        <button type="button" class="btn btn-ghost btn-sm" disabled=${!shown.length}
          onClick=${() => setPicked(toggleAll(picked, shown.map((g) => ({ uid: g.id }))))}>${shown.length && shown.every((g) => picked.has(g.id)) ? 'Bỏ chọn' : `Chọn tất cả${q.trim() ? ' (đang lọc)' : ''}`}</button>
      </div>
      <ul class="folder-members">${shown.map((g) => html`<li key=${g.id}><label>
        <input type="checkbox" checked=${picked.has(g.id)} onChange=${() => toggle(g.id)} />
        <span>${g.name}</span>${g.folder && g.folder.id !== folder.id ? html`<small class="muted"> · đang ở "${g.folder.name}"</small>` : null}
      </label></li>`)}</ul>
      ${!shown.length ? html`<p class="muted small">Không có nhóm nào khớp.</p>` : null}
      <div class="row">
        <button type="button" class="btn btn-primary btn-sm" disabled=${busy !== '' || !membersDirty}
          onClick=${() => run('members', `${base}/members`, 'PUT', { groups: [...picked] }, `Đã lưu ${picked.size} nhóm vào thư mục.`)}>Lưu danh sách nhóm</button>
        <button type="button" class="btn btn-ghost btn-sm" disabled=${busy !== '' || !membersDirty} onClick=${() => setPicked(new Set(folder.groups))}>Hoàn tác</button>
      </div>
    </details>
    <${FolderPeople} folder=${folder} folders=${perms.folders} admin=${admin} busy=${busy} run=${run} base=${base} onSaved=${onSaved} />
    <details class="perm-box" open=${!!folder.rules}>
      <summary><span>Quy tắc riêng của thư mục</span><span class="muted perm-box-sum">· ${folder.rules ? 'đang dùng' : 'chưa đặt'}${rulesDirty ? ' (chưa lưu)' : ''}</span></summary>
      <p class="muted small">Bot làm theo các quy tắc này khi trả lời trong nhóm thuộc thư mục, và khi người trong thư mục nhắn riêng. Nơi khác không bị ảnh hưởng. Mỗi quy tắc một dòng là dễ đọc nhất.</p>
      <label for="folder-rules" class="sr-only">Quy tắc riêng của thư mục</label>
      <textarea id="folder-rules" rows="10" maxlength=${MAX_RULES} value=${rules} onInput=${(e) => setRules(e.currentTarget.value)}
        placeholder="Vd. 1. Hỏi trước – gợi sau: hỏi em đã thử gì rồi mới gợi ý từng bước."></textarea>
      <p class="muted small">${rules.trim().length}/${MAX_RULES} ký tự</p>
      <div class="row">
        <button type="button" class="btn btn-primary btn-sm" disabled=${busy !== '' || !rulesDirty}
          onClick=${() => run('rules', `${base}/rules`, 'PUT', { rules }, rules.trim() ? 'Đã lưu quy tắc — áp dụng từ tin nhắn tiếp theo.' : 'Đã bỏ quy tắc riêng của thư mục.')}>Lưu quy tắc</button>
        <button type="button" class="btn btn-ghost btn-sm" disabled=${busy !== '' || !rulesDirty} onClick=${() => setRules(folder.rules || '')}>Hoàn tác</button>
      </div>
    </details>
    <details class="perm-box">
      <summary><span>Tên, màu và xoá thư mục</span></summary>
      <p class="small">Màu thư mục — để phân biệt ở Phân quyền và Phiên chat:</p>
      <${FolderColorPicker} value=${colorOf(folder)} disabled=${busy !== ''}
        onChange=${(c) => { if (c !== colorOf(folder)) run('color', `${base}/color`, 'PUT', { color: c }, 'Đã đổi màu thư mục.'); }} />
      <div class="row">
        <label for="folder-name" class="sr-only">Tên thư mục</label>
        <input id="folder-name" maxlength="60" value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
        <button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== '' || !name.trim() || name.trim() === folder.name}
          onClick=${() => run('name', base, 'PUT', { name }, 'Đã đổi tên thư mục.')}>Đổi tên</button>
      </div>
      <button type="button" class="btn btn-danger-outline btn-sm" disabled=${busy !== ''}
        onClick=${async () => { if (!window.confirm(`Xoá thư mục "${folder.name}"? ${folder.groups.length} nhóm bên trong sẽ quay về theo Mặc định (phần chỉnh riêng của từng nhóm giữ nguyên).`)) return; if (await run('del', base, 'DELETE', undefined, 'Đã xoá thư mục.')) onDeleted(); }}>Xoá thư mục</button>
    </details>
    <h3 class="folder-settings-head">Cài đặt chung của thư mục</h3>
    <${Editor} key=${`fs-${folder.id}`} head=${false} target=${{ id: `${FOLDER_PREFIX}${folder.id}`, name: folder.name, members: null }}
      value=${pick(folder)} defaults=${pick(perms.defaults)} features=${perms.features} studioFeatures=${perms.studioFeatures || []}
      studioPolicy=${perms.studioPolicy} defaultQuota=${perms.studio?.quota ?? 3} mediaDefaults=${perms.studio} path=${`${base}/settings`}
      note=${`Mọi nhóm trong thư mục thừa hưởng các cài đặt này ngay khi lưu, kể cả nhóm thêm vào sau; người trong thư mục dùng các tính năng này khi nhắn riêng (bật bot, chỉ trả lời khi tag chỉ áp cho nhóm). Nhóm/người chỉnh riêng mục nào thì mục đó của họ thắng. Chủ nhân bot luôn dùng được mọi tính năng.`}
      modelChoices=${modelChoices} onReloadModels=${onReloadModels}
      onSaved=${(r) => { onSaved(r); return true; }} onDirty=${onDirty} onBack=${onBack} />
  </div>`;
}

export function Permissions({ me }) {
  const [perms, setPerms] = useState(null);
  const [groups, setGroups] = useState(null);
  const [groupsError, setGroupsError] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [folderFilter, setFolderFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [flash, setFlash] = useState('');
  // Chế độ "Chọn nhiều" ở danh sách nhóm: Set mã nhóm đã tích, null = tắt.
  const [bulk, setBulk] = useState(null);
  // Model của cổng AI cho ô "Model riêng" của nhóm/thư mục (cùng nguồn với trang Khoá API & Model).
  // Chỉ Quản trị đọc được: Chủ bot nhận 403 → để null, giao diện ghi rõ chưa đọc được danh sách.
  const [modelChoices, setModelChoices] = useState(null);

  // Đang có thay đổi chưa lưu: hỏi trước khi đóng/tải lại trang, hoặc đổi trang qua thanh bên / nút Lùi.
  useEffect(() => {
    if (!dirty) return undefined;
    const here = location.hash;
    const onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    // popstate đến trước hashchange (bấm link thanh bên, nút Lùi/Tiến, sửa địa chỉ). Huỷ → trả lại địa chỉ cũ ngay,
    // để khi hashchange tới thì bộ định tuyến của app.js vẫn thấy trang này và không chuyển.
    const onPop = () => {
      if (location.hash === here || mayLeave(true, (m) => window.confirm(m))) return;
      history.replaceState(history.state, '', here);
    };
    addEventListener('beforeunload', onUnload);
    addEventListener('popstate', onPop);
    return () => { removeEventListener('beforeunload', onUnload); removeEventListener('popstate', onPop); };
  }, [dirty]);

  function choose(id) {
    if (id === selected || !mayLeave(dirty, (m) => window.confirm(m))) return;
    setFlash(''); setSelected(id);
  }

  function toggleBulk() {
    if (!mayLeave(dirty, (m) => window.confirm(m))) return;
    setFlash(''); setDirty(false);
    if (bulk) { setBulk(null); if (selected === BULK_KEY) setSelected(null); } else { setBulk(new Set()); setSelected(null); }
  }

  function onSaved(r, id) {
    setPerms(r);
    if (staysListed(id, r, groups)) return true;
    setFlash(SAVED_DEFAULT_MSG); setSelected(null);
    return false;
  }

  /**
   * Lấy danh sách model cho ô "Model riêng". Cổng AI trả ~2400 model / hơn 1 MB nên lần đầu mất 10–15 giây;
   * máy chủ đã nhớ kết quả, còn `fresh` (nút "Tải lại danh sách") hỏi thẳng cổng khi cổng vừa thêm model.
   */
  async function reloadModels(fresh = false) {
    try {
      const r = await api(`/api/admin/ai/models${fresh ? '?fresh=1' : ''}`);
      setModelChoices({ models: r.models || [], choices: r.choices || [], defaultModel: r.defaultModel || '', listError: r.listError || '' });
    } catch (err) {
      // Chủ bot không có quyền đọc trang Khoá API & Model, hoặc máy chủ im: ghi lại lý do để khung sửa nói ra.
      setModelChoices({ models: [], choices: [], defaultModel: '', listError: err.message });
    }
  }

  useEffect(() => {
    let alive = true;
    api('/api/permissions').then((r) => { if (alive) setPerms(r); }, (err) => { if (alive) setError(err.message); });
    // Kết nối Zalo tắt (503) → vẫn liệt kê nhóm đã có trong lịch sử trò chuyện để chỉnh được (quyết định 10).
    api('/api/groups').then((r) => { if (alive) setGroups(r.groups); }, async (err) => {
      if (!alive) return;
      setGroupsError(err.message);
      let known = [];
      try {
        const r = await api('/api/chats');
        known = r.conversations.filter((c) => c.threadType === 1).map((c) => ({ id: String(c.threadId), name: c.name, members: null }));
      } catch { /* chỉ còn nhóm trong tệp */ }
      if (alive) setGroups(known);
    });
    // Danh sách model để ghim cho nhóm/thư mục: lỗi (Chủ bot không có quyền, cổng AI chưa trả) thì khung sửa
    // nói rõ lý do kèm nút "Tải lại danh sách", trang vẫn dùng được bình thường.
    reloadModels();
    return () => { alive = false; };
  }, []);

  if (error) return html`<${PageHead} title="Phân quyền Bot" /><${Notice} kind="danger">${error}<//>`;
  if (!perms || groups === null) return html`<${PageHead} title="Phân quyền Bot" /><${Spinner} />`;

  const list = mergeGroups(groups, perms);
  const folders = perms.folders || [];
  const selectedFolder = String(selected || '').startsWith(FOLDER_PREFIX) ? folders.find((f) => `${FOLDER_PREFIX}${f.id}` === selected) || null : null;
  async function newFolder() {
    const name = window.prompt('Tên thư mục mới (vd. "Lớp học", "Đoàn trường"):', '');
    if (!name || !name.trim()) return;
    try { const r = await api('/api/permissions/folders', { method: 'POST', body: { name } }); setPerms(r); choose(`${FOLDER_PREFIX}${r.created}`); }
    catch (err) { setFlash(''); window.alert(err.message); }
  }
  const needle = fold(query.trim());
  const groupFolder = (g) => (g.folder ? folders.find((f) => f.id === g.folder.id) || null : null);
  const shown = list.filter((g) => (!needle || fold(g.name).includes(needle)) && inFolderFilter(folderFilter, groupFolder(g)));
  const defaultsTarget = { id: DEFAULTS_KEY, name: 'Mặc định cho nhóm mới', members: null, ...pick(perms.defaults) };
  const target = selected === DEFAULTS_KEY ? defaultsTarget : list.find((g) => g.id === selected) || null;
  const picked = bulk ? stillPicked(bulk, list.map((g) => ({ uid: g.id }))) : [];
  const bulkPane = Boolean(bulk) && (selected === null || selected === BULK_KEY);
  const sub = (g) => {
    if (g.members) return `${g.members} thành viên`;
    return groupsError ? 'Chưa rõ số thành viên' : 'Bot không còn thấy nhóm này';
  };

  return html`
    <${PageHead} title="Phân quyền Bot" sub="Chọn ai được nhắn riêng với bot và bot được làm gì trong từng nhóm. Lưu là có hiệu lực ngay." />
    ${perms.corrupt ? html`<${Notice} kind="warn">Tệp phân quyền bị hỏng nên bot đang dùng mặc định (mọi tính năng bật). Lưu lại một mục bất kỳ để ghi tệp mới.<//>` : null}
    ${groupsError ? html`<${Notice} kind="warn">Chưa lấy được danh sách nhóm: ${groupsError} Danh sách dưới đây chỉ có nhóm đã chỉnh trước đó hoặc đã có trong Phiên chat.<//>` : null}
    <${Live} ok=${flash} />
    <div class=${`perm${target || selectedFolder || selected === DM_KEY || selected === QUOTA_KEY || selected === CALL_KEY || selected === BULK_KEY ? ' has-sel' : ''}`}>
      <section class="card perm-list" aria-label="Nhóm">
        <div class="chat-search">
          <label for="perm-q" class="sr-only">Lọc nhóm theo tên</label>
          <input id="perm-q" type="search" maxlength="100" placeholder="Lọc nhóm theo tên" value=${query}
            onInput=${(e) => setQuery(e.currentTarget.value)} />
        </div>
        <ul class="conv-list">
          <li><button type="button" class=${`conv${selected === DM_KEY ? ' active' : ''}`}
            aria-current=${selected === DM_KEY ? 'true' : undefined} onClick=${() => choose(DM_KEY)}>
            <span class="conv-top"><span class="conv-name"><${Icon} name="user" size=${16} /> Nhắn riêng</span>
              <span class=${`badge badge-${dmBadge(perms.dm).kind}`}>${dmBadge(perms.dm).text}</span></span>
            <span class="conv-preview">Ai được nhắn riêng với bot và bot được làm gì trong tin nhắn riêng.</span>
          </button></li>
          <li><button type="button" class=${`conv${selected === CALL_KEY ? ' active' : ''}`}
            aria-current=${selected === CALL_KEY ? 'true' : undefined} onClick=${() => choose(CALL_KEY)}>
            <span class="conv-top"><span class="conv-name"><${Icon} name="chat" size=${16} /> Cách gọi bot</span>
              <span class="badge badge-idle">Chủ nhân</span></span>
            <span class="conv-preview">Từ khoá chủ nhân dùng để gọi bot trong nhóm mà không cần tag (vd. “Tiêu ơi”).</span>
          </button></li>
          ${perms.studioFeatures ? html`<li><button type="button" class=${`conv${selected === QUOTA_KEY ? ' active' : ''}`}
            aria-current=${selected === QUOTA_KEY ? 'true' : undefined} onClick=${() => choose(QUOTA_KEY)}>
            <span class="conv-top"><span class="conv-name"><${Icon} name="list" size=${16} /> Hạn mức xưởng</span>
              <span class="badge badge-idle">${quotaBadge(perms.studio)}</span></span>
            <span class="conv-preview">Mỗi người được nhờ xưởng làm bao nhiêu sản phẩm mỗi ngày.</span>
          </button></li>` : null}
          <li><button type="button" class=${`conv${selected === DEFAULTS_KEY ? ' active' : ''}`}
            aria-current=${selected === DEFAULTS_KEY ? 'true' : undefined} onClick=${() => choose(DEFAULTS_KEY)}>
            <span class="conv-top"><span class="conv-name"><${Icon} name="shield" size=${16} /> Mặc định cho nhóm mới</span></span>
            <span class="conv-preview">Nhóm chỉnh riêng chỉ giữ những mục khác mặc định; mục còn lại đi theo Mặc định.</span>
          </button></li>
          <li class="folder-head"><span>Thư mục</span>
            <button type="button" class="btn btn-ghost btn-sm" onClick=${newFolder}><${Icon} name="plus" size=${14} /> Thư mục mới</button></li>
          ${folders.length ? folders.map((f) => {
            const key = `${FOLDER_PREFIX}${f.id}`;
            const badge = folderBadge(f);
            return html`<li key=${key}><button type="button" class=${`conv conv-folder${selected === key ? ' active' : ''}`}
              aria-current=${selected === key ? 'true' : undefined} onClick=${() => choose(key)}>
              <span class="conv-top"><span class="conv-name"><span class=${`fdot fdot-${colorOf(f)}`} aria-hidden="true"></span> ${f.name}</span>
                <span class=${`badge badge-${badge.kind}`}>${badge.text}</span></span>
              <span class="conv-preview">Cài đặt chung cho nhóm và người bên trong · bật/tắt hàng loạt</span>
            </button></li>`;
          }) : html`<li class="muted small folder-empty">Gom các nhóm cùng chủ đề vào thư mục để chỉnh và bật/tắt hàng loạt.</li>`}
          <li class="folder-head"><span>Nhóm</span>
            ${list.length ? html`<button type="button" class="btn btn-ghost btn-sm" aria-pressed=${bulk ? 'true' : 'false'} onClick=${toggleBulk}>${bulk ? 'Xong' : 'Chọn nhiều'}</button>` : null}</li>
          ${folders.length ? html`<li><${FolderFilter} folders=${folders} items=${list} of=${groupFolder} value=${folderFilter} onChange=${setFolderFilter} label="Lọc nhóm theo thư mục" /></li>` : null}
          ${bulk ? html`<li><${BulkBar} shown=${shown.map((g) => ({ uid: g.id }))} picked=${new Set(picked)} onPick=${setBulk} unit="nhóm"
            filtered=${Boolean(needle) || folderFilter !== 'all'}>
            <button type="button" class=${`btn btn-primary btn-sm${bulkPane ? ' only-mobile' : ''}`} disabled=${!picked.length} onClick=${() => choose(BULK_KEY)}>Chỉnh ${picked.length} nhóm</button><//></li>` : null}
          ${shown.map((g) => {
            const badge = groupBadge(g);
            if (bulk) {
              return html`<li key=${g.id}><label class="conv conv-pick">
                <input type="checkbox" checked=${bulk.has(g.id)} onChange=${() => setBulk(flip(bulk, g.id))} />
                <span class="conv-pick-body"><span class="conv-top"><span class="conv-name">${g.name}</span>
                  ${badge ? html`<span class=${`badge badge-${badge.kind}`}>${badge.text}</span>` : null}</span>
                <span class="conv-preview">${groupFolder(g) ? html`<${FolderChip} folder=${groupFolder(g)} /> ` : null}${sub(g)}</span></span>
              </label></li>`;
            }
            return html`<li key=${g.id}><button type="button" class=${`conv${selected === g.id ? ' active' : ''}`}
              aria-current=${selected === g.id ? 'true' : undefined} onClick=${() => choose(g.id)}>
              <span class="conv-top"><span class="conv-name">${g.name}</span>
                ${badge ? html`<span class=${`badge badge-${badge.kind}`}>${badge.text}</span>` : null}</span>
              <span class="conv-preview">${groupFolder(g) ? html`<${FolderChip} folder=${groupFolder(g)} /> ` : null}${sub(g)}</span>
            </button></li>`;
          })}
        </ul>
        ${list.length && !shown.length ? html`<p class="muted small">Không có nhóm nào trùng tên — xoá bớt chữ trong ô lọc.</p>` : null}
        ${!list.length && !groupsError ? html`<p class="muted small">Bot chưa ở nhóm nào — thêm bot vào nhóm Zalo rồi tải lại trang.</p>` : null}
      </section>
      <section class="card perm-edit" aria-label=${selected === DM_KEY ? 'Quyền nhắn riêng' : selected === QUOTA_KEY ? 'Hạn mức xưởng' : selected === CALL_KEY ? 'Cách gọi bot' : selectedFolder ? 'Thư mục nhóm' : bulkPane ? 'Chỉnh nhiều nhóm' : 'Quyền của nhóm'}>
        ${bulkPane
          ? html`<${BulkGroups} key=${BULK_KEY} picked=${picked} list=${list} features=${perms.features} studioFeatures=${perms.studioFeatures || []}
              studioPolicy=${perms.studioPolicy} folders=${perms.folders} onSaved=${(r) => setPerms(r)} onDirty=${setDirty} onBack=${() => setSelected(null)} />`
          : selectedFolder
          ? html`<${FolderEditor} key=${selected} folder=${selectedFolder} perms=${perms} list=${list} admin=${me?.role === 'admin'} modelChoices=${modelChoices}
              onReloadModels=${() => reloadModels(true)}
              onSaved=${(r) => setPerms(r)} onDirty=${setDirty} onBack=${() => choose(null)} onDeleted=${() => { setDirty(false); setSelected(null); }} />`
          : selected === DM_KEY
          ? html`<${DmEditor} key=${DM_KEY} dm=${perms.dm} folders=${perms.folders || []} features=${perms.dmFeatures} studioFeatures=${perms.studioFeatures || []}
              studioPolicy=${perms.studioPolicy} admin=${me?.role === 'admin'} onSaved=${(r) => setPerms(r)} onDirty=${setDirty} onBack=${() => choose(null)} />`
          : selected === CALL_KEY
          ? html`<${CallWordsEditor} key=${CALL_KEY} onDirty=${setDirty} onBack=${() => choose(null)} />`
          : selected === QUOTA_KEY
          ? html`<${QuotaEditor} key=${QUOTA_KEY} studio=${perms.studio} admin=${me?.role === 'admin'}
              onSaved=${(r) => setPerms(r)} onDirty=${setDirty} onBack=${() => choose(null)} />`
          : target
          ? html`<${Editor} key=${target.id} target=${target} value=${pick(target)}
              defaults=${pick(target.folder ? baseOfGroup(perms, target.id) : perms.defaults)} features=${perms.features} studioFeatures=${perms.studioFeatures || []} studioPolicy=${perms.studioPolicy}
              modelChoices=${modelChoices} onReloadModels=${() => reloadModels(true)}
              defaultQuota=${perms.studio?.quota ?? 3} mediaDefaults=${perms.studio} onSaved=${onSaved} onDirty=${setDirty} onBack=${() => choose(null)}
              baseLabel=${target.folder ? 'Theo thư mục' : 'Dùng mặc định'}
              note=${target.folder ? `Nhóm thuộc thư mục "${target.folder.name}": mục nào chưa chỉnh riêng thì theo thư mục. Chủ nhân bot luôn dùng được mọi tính năng.` : null} />`
          : html`<p class="muted chat-empty">Chọn "Nhắn riêng", "Hạn mức xưởng", "Mặc định" hoặc một nhóm bên trái để chỉnh.</p>`}
      </section>
    </div>`;
}
