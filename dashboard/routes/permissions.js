// Phân quyền Bot theo nhóm (spec §7.1, §8): Quản trị và Chủ bot đều xem và sửa (spec §6).
// Lưu là có hiệu lực ngay — plugin đọc lại permissions.json khi tệp đổi.
import express from 'express';
import { requireAuth } from '../lib/http-guards.js';
import { DM_FEATURES, FEATURES, GROUP_ID, STUDIO_FEATURES, parseDm, parseGroupsPatch, parseSettings, parseStudio, studioPolicy } from '../lib/permissions.js';
import { fallbackName } from '../lib/thread-names.js';
import { failSidecar } from '../lib/route-errors.js';

const SAVE_FAIL = 'Chưa lưu được phân quyền — thử lại, nếu vẫn lỗi hãy báo người cài đặt.';
const READ_FAIL = 'Chưa đọc được phân quyền — tải lại trang, nếu vẫn lỗi hãy báo người cài đặt.';
const label = Object.fromEntries(FEATURES.map((f) => [f.key, f.label]));

/** Phần Nhật ký cho xưởng (chỉ khi lần lưu có gửi nút xưởng): "xưởng: Slide PowerPoint, Video" / "xưởng tắt". */
function describeStudio(studio, quota) {
  if (!studio) return [];
  const on = STUDIO_FEATURES.filter((f) => studio[f.key]).map((f) => f.label);
  const parts = [on.length ? `xưởng: ${on.join(', ')}` : 'xưởng tắt'];
  if (Number.isInteger(quota)) parts.push(`${quota} lượt/người/ngày`);
  return parts;
}

/** Một dòng dễ đọc cho Nhật ký: "Hoạt động · chỉ trả lời khi được tag · tắt: Tra cứu web, Video". */
export function describeSettings(s) {
  const off = FEATURES.filter((f) => !s.features[f.key]).map((f) => label[f.key]);
  return [s.active ? 'Hoạt động' : 'Tạm tắt', s.replyOnlyTagged ? 'chỉ trả lời khi được tag' : 'trả lời mọi tin',
    s.paused ? 'đang tạm dừng' : '',
    off.length ? `tắt: ${off.join(', ')}` : 'bật mọi tính năng', ...describeStudio(s.studio, s.studioQuota),
    s.soulReminder ? 'dòng nhắc riêng' : ''].filter(Boolean).join(' · ');
}

/** Dòng Nhật ký cho thay đổi hàng loạt: "Tạm tắt · bật: Tra cứu web · tắt: Video" — chỉ các mục đã đổi. */
export function describePatch(p) {
  const all = [...FEATURES, ...STUDIO_FEATURES];
  const pick = (on) => all.filter((f) => (p.features?.[f.key] ?? p.studio?.[f.key]) === on).map((f) => f.label);
  const on = pick(true);
  const off = pick(false);
  return [p.active === undefined ? '' : p.active ? 'Hoạt động' : 'Tạm tắt',
    p.replyOnlyTagged === undefined ? '' : p.replyOnlyTagged ? 'chỉ trả lời khi được tag' : 'trả lời mọi tin',
    p.paused === undefined ? '' : p.paused ? 'tạm dừng' : 'hết tạm dừng',
    on.length ? `bật: ${on.join(', ')}` : '', off.length ? `tắt: ${off.join(', ')}` : ''].filter(Boolean).join(' · ');
}

export const WHO_LABELS = { owners: 'Chỉ chủ nhân', list: 'Những người trong danh sách', everyone: 'Mọi người' };

/** Dòng Nhật ký cho mục Nhắn riêng: "Chỉ chủ nhân · tắt: Video · 2 người trong danh sách (1 chỉnh riêng)". */
export function describeDm(s) {
  const off = DM_FEATURES.filter((f) => !s.features[f.key]).map((f) => f.label);
  const custom = s.people.filter((p) => p.features).length;
  return [WHO_LABELS[s.who], off.length ? `tắt: ${off.join(', ')}` : 'bật mọi tính năng', ...describeStudio(s.studio),
    `${s.people.length} người trong danh sách${custom ? ` (${custom} chỉnh riêng)` : ''}`].join(' · ');
}

/** Dòng Nhật ký cho Hạn mức xưởng: "Mặc định 3 lượt/người/ngày · 2 người có hạn mức riêng". */
export function describeQuotas(s) {
  return [`Mặc định ${s.quota} lượt/người/ngày`, s.people.length ? `${s.people.length} người có hạn mức riêng` : 'không ai có hạn mức riêng'].join(' · ');
}

export function permissionRoutes({ permissions, sidecar, threadNames, activity, settings, owners = null, platform = process.platform, studioPolicyFile = '' }) {
  // Danh sách cũ "Nhóm chỉ chủ nhân gọi được" (Cấu hình / config.yaml): nhóm chưa phân quyền riêng mà nằm trong đó thì
  // thành viên vẫn bị bỏ qua — trang Phân quyền phải nói ra, không để tưởng nhóm đang mở.
  const legacyOwnerOnly = () => {
    try { const v = settings?.view().find((x) => x.id === 'ownerOnlyGroups')?.value; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  // UID chủ nhân: bảng Quyền trong Phiên chat nói rõ "chủ nhân luôn được" thay vì "chưa được nhắn riêng".
  const ownerUids = () => { try { return (owners?.list() || []).map(String); } catch { return []; } };
  const r = express.Router();
  const policy = () => studioPolicy(platform, studioPolicyFile);   // đọc lại mỗi lần: plugin có thể ghi sau
  const fail = (res, err, fallback) => {
    if (err?.name === 'InvalidPermissions') return res.status(400).json({ ok: false, error: err.message });
    console.error('[dashboard]', err);
    return res.status(500).json({ ok: false, error: fallback });
  };

  r.get('/permissions', requireAuth, (req, res) => {
    try { res.json({ ok: true, features: FEATURES, dmFeatures: DM_FEATURES, studioFeatures: STUDIO_FEATURES, studioPolicy: policy(), legacyOwnerOnly: legacyOwnerOnly(), ownerUids: ownerUids(), ...permissions.get() }); } catch (err) { fail(res, err, READ_FAIL); }
  });

  r.get('/groups', requireAuth, async (req, res) => {
    try {
      const groups = await sidecar.groups();
      res.json({
        ok: true,
        groups: (Array.isArray(groups) ? groups : []).filter((g) => GROUP_ID.test(String(g?.id ?? ''))).map((g) => {
          const id = String(g.id);
          const name = String(g.name || '').trim();
          return { id, name: name && name !== id ? name : fallbackName(id, 1), members: Number(g.members) || 0 };
        }),
      });
    } catch (err) { failSidecar(res, err); }
  });

  r.put('/permissions/defaults', requireAuth, (req, res) => {
    try {
      const s = parseSettings(req.body);
      const state = permissions.setDefaults(s);
      try {
        activity.append({ actor: req.user.username, action: 'permissions_defaults', detail: describeSettings(s) });
      } catch (err) { console.error('[dashboard] không ghi được Nhật ký phân quyền:', err); }
      res.json({ ok: true, features: FEATURES, dmFeatures: DM_FEATURES, studioFeatures: STUDIO_FEATURES, studioPolicy: policy(), legacyOwnerOnly: legacyOwnerOnly(), ownerUids: ownerUids(), ...state });
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });

  r.put('/permissions/dm', requireAuth, (req, res) => {
    try {
      const s = parseDm(req.body);
      const state = permissions.setDm(s);
      try {
        activity.append({ actor: req.user.username, action: 'permissions_dm', detail: describeDm(s) });
      } catch (err) { console.error('[dashboard] không ghi được Nhật ký phân quyền:', err); }
      res.json({ ok: true, features: FEATURES, dmFeatures: DM_FEATURES, studioFeatures: STUDIO_FEATURES, studioPolicy: policy(), legacyOwnerOnly: legacyOwnerOnly(), ownerUids: ownerUids(), ...state });
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });

  r.put('/permissions/studio', requireAuth, (req, res) => {
    try {
      const s = parseStudio(req.body);
      const state = permissions.setStudio(s);
      try {
        activity.append({ actor: req.user.username, action: 'permissions_studio', detail: describeQuotas(s) });
      } catch (err) { console.error('[dashboard] không ghi được Nhật ký phân quyền:', err); }
      res.json({ ok: true, features: FEATURES, dmFeatures: DM_FEATURES, studioFeatures: STUDIO_FEATURES, studioPolicy: policy(), legacyOwnerOnly: legacyOwnerOnly(), ownerUids: ownerUids(), ...state });
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });

  // Thư mục nhóm: nhóm trong thư mục thừa hưởng cài đặt thư mục (mặc định ← thư mục ← nhóm); mỗi nhóm một thư mục.
  const full = (state) => ({ ok: true, features: FEATURES, dmFeatures: DM_FEATURES, studioFeatures: STUDIO_FEATURES, studioPolicy: policy(),
    legacyOwnerOnly: legacyOwnerOnly(), ownerUids: ownerUids(), ...state });
  const folderLabel = (state, fid) => state.folders.find((f) => f.id === fid)?.name || fid;
  const logFolder = (req, detail) => {
    try { activity.append({ actor: req.user.username, action: 'permissions_folder', detail }); } catch (err) { console.error('[dashboard] không ghi được Nhật ký phân quyền:', err); }
  };
  r.post('/permissions/folders', requireAuth, (req, res) => {
    try {
      const { state, id } = permissions.createFolder(req.body?.name);
      logFolder(req, `tạo thư mục "${folderLabel(state, id)}"`);
      res.json({ ...full(state), created: id });
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.put('/permissions/folders/:fid', requireAuth, (req, res) => {
    try {
      const state = permissions.renameFolder(req.params.fid, req.body?.name);
      logFolder(req, `đổi tên thư mục thành "${folderLabel(state, req.params.fid)}"`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.delete('/permissions/folders/:fid', requireAuth, (req, res) => {
    try {
      const name = folderLabel(permissions.get(), req.params.fid);
      const state = permissions.deleteFolder(req.params.fid);
      logFolder(req, `xoá thư mục "${name}" — các nhóm bên trong về theo mặc định`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.put('/permissions/folders/:fid/members', requireAuth, (req, res) => {
    try {
      const state = permissions.setFolderMembers(req.params.fid, req.body?.groups);
      const f = state.folders.find((x) => x.id === req.params.fid);
      logFolder(req, `thư mục "${f?.name}": ${f?.groups.length ?? 0} nhóm`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.put('/permissions/folders/:fid/rules', requireAuth, (req, res) => {
    try {
      const state = permissions.setFolderRules(req.params.fid, req.body?.rules);
      const f = state.folders.find((x) => x.id === req.params.fid);
      logFolder(req, f?.rules ? `đặt quy tắc riêng cho thư mục "${f.name}" (${f.rules.length} ký tự)` : `bỏ quy tắc riêng của thư mục "${f?.name}"`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.put('/permissions/folders/:fid/color', requireAuth, (req, res) => {
    try {
      const state = permissions.setFolderColor(req.params.fid, req.body?.color);
      logFolder(req, `đổi màu thư mục "${folderLabel(state, req.params.fid)}"`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.put('/permissions/folders/:fid/people', requireAuth, (req, res) => {
    try {
      const state = permissions.setFolderPeople(req.params.fid, req.body?.people);
      const f = state.folders.find((x) => x.id === req.params.fid);
      logFolder(req, `thư mục "${f?.name}": ${f?.people.length ?? 0} người`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  // Liên hệ: đồng ý kết bạn rồi xếp luôn vào thư mục, hoặc chuyển 1/nhiều người — thêm vào, không thay cả danh sách.
  r.post('/permissions/folders/:fid/people/add', requireAuth, (req, res) => {
    try {
      const people = req.body?.people;
      const state = permissions.addFolderPeople(req.params.fid, people);
      const f = state.folders.find((x) => x.id === req.params.fid);
      logFolder(req, `thêm ${Array.isArray(people) ? people.length : 0} người vào thư mục "${f?.name}"`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.put('/permissions/folders/:fid/settings', requireAuth, (req, res) => {
    let s;
    try { s = parseSettings(req.body); } catch (err) { return fail(res, err, SAVE_FAIL); }
    try {
      const { state, changed } = permissions.setFolderSettings(req.params.fid, s);
      logFolder(req, `thư mục "${folderLabel(state, req.params.fid)}": ${changed.length ? describeSettings(s) : 'theo mặc định'}`);
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });
  r.put('/permissions/folders/:fid/active', requireAuth, (req, res) => {
    try {
      const { state, cleared } = permissions.setFolderActive(req.params.fid, req.body?.active);
      logFolder(req, `${req.body.active ? 'bật' : 'tắt'} bot cả thư mục "${folderLabel(state, req.params.fid)}"${cleared ? ` (bỏ chỉnh riêng ở ${cleared} nhóm)` : ''}`);
      res.json({ ...full(state), cleared });
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });

  // Chỉnh nhiều nhóm một lượt: chỉ các mục đã chọn, mục khác giữ giá trị riêng của từng nhóm. Một dòng Nhật ký.
  r.put('/permissions/groups', requireAuth, async (req, res) => {
    let p;
    try { p = parseGroupsPatch(req.body); } catch (err) { return fail(res, err, SAVE_FAIL); }
    try {
      const names = await threadNames.load();
      const legacy = legacyOwnerOnly();
      const { state } = permissions.setGroups(p.ids, p.patch, { nameOf: (id) => names.get(id) || '', keepOf: (id) => legacy.includes(id) });
      try {
        activity.append({ actor: req.user.username, action: 'permissions_group', detail: `${p.ids.length} nhóm: ${describePatch(p.patch)}` });
      } catch (err) { console.error('[dashboard] không ghi được Nhật ký phân quyền:', err); }
      res.json(full(state));
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });

  r.put('/permissions/groups/:groupId', requireAuth, async (req, res) => {
    const { groupId } = req.params;
    if (!GROUP_ID.test(groupId)) return res.status(400).json({ ok: false, error: 'Nhóm không hợp lệ — chọn lại từ danh sách.' });
    let s;
    try { s = parseSettings(req.body); } catch (err) { return fail(res, err, SAVE_FAIL); }
    try {
      const name = (await threadNames.load()).get(groupId) || '';
      // Nhóm thuộc danh sách cũ "chỉ chủ nhân": luôn giữ mục riêng (kể cả khi bằng mặc định) để phân quyền này thắng danh sách đó.
      const { state, changed } = permissions.setGroup(groupId, s, name, { keep: legacyOwnerOnly().includes(groupId) });
      try {
        activity.append({
          actor: req.user.username, action: 'permissions_group',
          detail: `${name || fallbackName(groupId, 1)}: ${changed.length ? describeSettings(s) : 'dùng mặc định'}`,
        });
      } catch (err) { console.error('[dashboard] không ghi được Nhật ký phân quyền:', err); }
      res.json({ ok: true, features: FEATURES, dmFeatures: DM_FEATURES, studioFeatures: STUDIO_FEATURES, studioPolicy: policy(), legacyOwnerOnly: legacyOwnerOnly(), ownerUids: ownerUids(), ...state });
    } catch (err) { fail(res, err, SAVE_FAIL); }
  });

  return r;
}
