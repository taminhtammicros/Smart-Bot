/**
 * Kho tri thức (spec §18.5): thư mục `ZALO_KB_DIR` mà bot tra bằng `zalo_kb_list`/`zalo_kb_read`. Dashboard liệt kê
 * đúng những tệp bot được đọc (cùng luật lọc với plugin `tools.py`: bỏ thư mục ẩn,
 * thư mục mã nguồn, tên gợi ý dữ liệu riêng), tải tệp mới vào MỘT thư mục riêng `tai-len-dashboard`, và chỉ xoá
 * được tệp trong thư mục đó — phần còn lại của kho là tài liệu của chủ bot, dashboard không đụng.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from './json-store.js';
import { writeEnvKeys } from './env-file.js';
import { createKbFolders } from './kb-folders.js';

export const UPLOAD_DIR = 'tai-len-dashboard';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Trần số tài liệu mỗi lần xoá hàng loạt. */
export const MAX_BULK = 200;
export const UPLOAD_TYPES = ['.docx', '.pdf', '.md', '.txt'];
// Khớp tools.py (KB_TEXT_SUFFIXES | KB_DOC_SUFFIXES | KB_LINK_SUFFIXES, KB_SKIP_DIRS, KB_SKIP_PATTERNS).
const READABLE = new Set(['.md', '.txt', '.html', '.htm', '.json', '.yaml', '.yml', '.csv', '.xml', '.rst', '.ini', '.toml',
  '.docx', '.xlsx', '.pdf', '.doc', '.pptx', '.ppt', '.rtf', '.epub', '.odt', '.url']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__', 'venv', '.venv', 'vendor', 'tmp', 'temp', 'cache']);
const SKIP_PATTERNS = ['backup', 'order', 'customer', 'khach', 'don-hang', 'donhang', 'secret', 'credential', 'password', 'token', 'private'];
const MAX_FILES = 3000;
const MAX_STEM = 120;
// Tên thiết bị của Windows: CON, NUL, COM1… (kể cả khi có đuôi, không phân biệt hoa thường) không tạo được thành tệp.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const LIST_TTL_MS = 60_000;
// Kho trên ổ mạng (Google Drive…) có thể duyệt mất vài phút: dừng sau ngần này, trả phần đã thấy, báo chưa đủ.
const WALK_BUDGET_MS = 8_000;
const TEXT_TYPES = ['.md', '.txt'];
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SUBDIRS = 200;
const MAX_COUNT = 100_000;

const err = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const NOT_ALLOWED = 'Chỉ xoá được tệp đã tải lên từ dashboard — tài liệu khác trong kho hãy xoá trên máy.';


/** Như `_kb_allowed` của plugin: đường tương đối dạng a/b/c.pdf này bot có được thấy không. */
export function kbAllowed(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p.toLowerCase()))) return false;
  const low = rel.toLowerCase();
  return !SKIP_PATTERNS.some((p) => low.includes(p));
}

/** Tên tệp an toàn trên cả Windows lẫn Linux; giữ chữ có dấu. Rỗng → lỗi 400. */
export function safeFileName(raw) {
  // eslint-disable-next-line no-control-regex
  const full = basename(String(raw ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\.+/, '');
  const ext = extname(full);
  if (!full || full === ext) throw err(400, 'Tên tệp không hợp lệ — đổi tên tệp rồi tải lại.');
  if (!UPLOAD_TYPES.includes(ext.toLowerCase())) throw err(400, `Chỉ nhận ${UPLOAD_TYPES.join(', ')} — đổi định dạng rồi tải lại.`);
  // Chỉ cắt phần tên (stem) để giữ nguyên đuôi.
  let stem = full.slice(0, -ext.length);
  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM).trimEnd();
  if (!stem || RESERVED_NAME.test(stem.split('.')[0].trim())) throw err(400, 'Tên tệp trùng tên thiết bị của Windows (CON, NUL, COM1…) — đổi tên tệp rồi tải lại.');
  return `${stem}${ext}`;
}

/** Kiểm nội dung khớp đuôi: PDF "%PDF-", DOCX là ZIP có word/document.xml, MD/TXT là UTF-8 không có byte 0. */
export function checkContent(name, buf) {
  if (!buf?.length) throw err(400, 'Tệp rỗng — chọn tệp khác.');
  if (buf.length > MAX_UPLOAD_BYTES) throw err(413, 'Tệp quá 10 MB — chia nhỏ hoặc nén lại rồi tải lên.');
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf' && buf.subarray(0, 5).toString('latin1') === '%PDF-') return;
  if (ext === '.docx' && buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && buf.includes('word/document.xml')) return;
  if (ext === '.md' || ext === '.txt') {
    if (!buf.includes(0)) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return; } catch { /* không phải UTF-8 */ }
    }
  }
  throw err(400, 'Nội dung tệp không khớp với đuôi tệp — mở bằng Word/trình đọc PDF rồi lưu lại đúng định dạng.');
}

/** Danh sách thư mục gốc người cài đặt cho phép chọn (ZALO_KB_ALLOWED_ROOTS, cách nhau bằng ";" hoặc xuống dòng). */
export function parseRoots(raw) {
  return String(raw ?? '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

/** Đường thật (theo hệ điều hành, chuẩn hoá tên ngắn/đuôi chấm trên Windows) của một thư mục có thật, hoặc null. */
function realDir(p) {
  try { const r = realpathSync.native(resolve(String(p))); return statSync(r).isDirectory() ? r : null; } catch { return null; }
}
const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Bỏ đuôi đúng định dạng nhận (".md", ".pdf"…) mà người dùng gõ kèm — không ăn "v1.2". */
function stripKnownExt(name) {
  const ext = extname(name).toLowerCase();
  return UPLOAD_TYPES.includes(ext) ? name.slice(0, -ext.length) : name;
}

/**
 * Trang Kho tri thức gọn (spec §18.5): nguồn có sẵn chỉ hiện số tệp theo thư mục cấp 1 (".url" = lối tắt link).
 * `counts`: Map tên thư mục cấp 1 (chữ thường; '' = gốc) → { name, files, links }; `scope`: thư mục mở, đúng thứ tự.
 */
export function summarize(counts, scope = []) {
  const by = new Map();
  for (const name of scope) by.set(name.toLowerCase(), { name, files: 0, links: 0 });
  for (const [key, c] of counts) {
    const s = by.get(key) || { name: c.name, files: 0, links: 0 };
    s.name = c.name || s.name; s.files += c.files; s.links += c.links;
    by.set(key, s);
  }
  const list = [...by.values()];
  return scope.length ? list : list.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Thư mục cấp 1 bot có thể được mở (bỏ ẩn, thư mục mã nguồn, thư mục tải lên của dashboard). */
function subdirsOf(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name.toLowerCase()) && d.name !== UPLOAD_DIR)
    .map((d) => d.name).sort((a, b) => a.localeCompare(b, 'vi')).slice(0, MAX_SUBDIRS);
}

/**
 * `kbDir`, `allowedRoots`: đọc lại mỗi lần (người cài đặt có thể đổi .env). `envFile`: .env của Hermes.
 * Đổi nguồn từ dashboard CHỈ chọn trong thư mục con của kho hiện tại, hoặc chuyển sang một gốc trong `allowedRoots`
 * — không bao giờ nhận đường dẫn tự do: bot đọc được kho bằng công cụ công khai, nên một phiên Quản trị bị chiếm
 * không được biến thư mục khoá/phiên đăng nhập thành kho.
 */
export function createKbStore({ kbDir, allowedRoots = () => '', envFile = null, foldersFile = null, now = Date.now, walkBudgetMs = WALK_BUDGET_MS }) {
  let cache = null;
  // Thư mục của tài liệu tự tạo: chỉ là siêu dữ liệu (kb-folders.js), tệp vẫn nằm phẳng trong thư mục tải lên.
  const folders = createKbFolders({ file: foldersFile });
  function root() {
    const raw = String(kbDir() || '').trim();
    if (!raw) return null;
    try { const r = realpathSync(resolve(raw)); return statSync(r).isDirectory() ? r : null; } catch { return null; }
  }
  function uploadDir(r) { return join(r, UPLOAD_DIR); }
  const relOf = (r, p) => relative(r, p).split(sep).join('/');
  /** Thư mục tải lên phải là thư mục thật nằm trong kho — không phải liên kết trỏ ra ngoài. */
  function assertRealInside(r, dir) {
    let real;
    try { real = realpathSync(dir); } catch { return false; }
    const rel = relative(r, real);
    if (!rel || rel.startsWith('..') || resolve(r, rel) !== real || real !== resolve(dir)) throw err(403, 'Thư mục tải lên không nằm trong kho — báo người cài đặt kiểm tra.');
    return true;
  }
  /** Thư mục cha của thư mục tải lên (chính kho hoặc thư mục phạm vi) nếu đã có thì phải là thư mục thật trong kho. */
  function assertParentInside(r, dir) {
    const lexical = relative(r, dir);
    if (!lexical || lexical.startsWith('..') || resolve(r, lexical) !== resolve(dir)) throw err(403, 'Thư mục tải lên không nằm trong kho — báo người cài đặt kiểm tra.');
    const parent = dirname(dir);
    let real;
    try { real = realpathSync(parent); } catch { return; } // chưa có: sẽ được tạo ngay dưới kho (đã là đường thật)
    if (real !== r && (relative(r, real).startsWith('..') || real !== resolve(parent))) throw err(403, 'Thư mục tải lên không nằm trong kho — báo người cài đặt kiểm tra.');
  }
  /** Tên tệp mới trong thư mục tự tạo phải qua được luật lọc của bot — nếu không, bot không đọc mà trang cũng không hiện. */
  function assertReadable(dir, name) {
    if (!kbAllowed(relOf(root(), join(dir, name)))) {
      throw err(400, `Tên có từ bot bỏ qua để bảo vệ dữ liệu riêng (${SKIP_PATTERNS.slice(0, 6).join(', ')}…) — đổi tên khác.`);
    }
  }
  /** Duyệt kho: giữ tối đa 3000 tệp mới nhất để tìm; ĐẾM tiếp tới 100.000 tệp theo thư mục cấp 1. */
  async function walk(r, uploadRel) {
    const files = [];
    const counts = new Map();
    let seen = 0;
    let outOfTime = false;
    const deadline = now() + walkBudgetMs;
    const stack = [''];
    while (stack.length && seen < MAX_COUNT) {
      if (now() > deadline) { outOfTime = true; break; }
      const relDir = stack.pop();
      let entries;
      try { entries = await readdir(join(r, relDir), { withFileTypes: true }); } catch { continue; }
      for (const d of entries) {
        const rel = relDir ? `${relDir}/${d.name}` : d.name;
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) {
          if (!d.name.startsWith('.') && !SKIP_DIRS.has(d.name.toLowerCase()) && rel.split('/').length < 8 && rel !== uploadRel) stack.push(rel);
          continue;
        }
        if (!d.isFile() || !READABLE.has(extname(d.name).toLowerCase()) || !kbAllowed(rel)) continue;
        seen += 1;
        const top = rel.includes('/') ? rel.split('/')[0] : '';
        const c = counts.get(top.toLowerCase()) || { name: top, files: 0, links: 0 };
        if (extname(d.name).toLowerCase() === '.url') c.links += 1; else c.files += 1;
        counts.set(top.toLowerCase(), c);
        if (files.length < MAX_FILES) {
          let st; try { st = await stat(join(r, rel)); } catch { continue; }
          files.push({ path: rel, size: st.size, mtime: st.mtimeMs });
        }
        if (seen >= MAX_COUNT) break;
      }
    }
    return { files: files.sort((a, b) => b.mtime - a.mtime), counts, capped: outOfTime || seen >= MAX_COUNT || files.length >= MAX_FILES };
  }
  /** Tài liệu tự tạo: đọc thẳng thư mục tải lên hiện tại (không phụ thuộc trần 3000 của lượt duyệt). */
  async function ownFiles(r, dir) {
    let entries;
    try { if (!assertRealInside(r, dir)) return []; entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const d of entries) {
      if (!d.isFile() || d.isSymbolicLink() || !READABLE.has(extname(d.name).toLowerCase())) continue;
      let st; try { st = await stat(join(dir, d.name)); } catch { continue; }
      out.push({ path: relOf(r, join(dir, d.name)), size: st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  /** Gốc được phép chọn: kho hiện tại + ZALO_KB_ALLOWED_ROOTS (chỉ những thư mục có thật). */
  function choices() {
    const out = [];
    for (const raw of [String(kbDir() || '').trim(), ...parseRoots(allowedRoots())]) {
      const real = raw && realDir(raw);
      if (real && !out.some((o) => sameDir(o.real, real))) out.push({ label: raw, real });
    }
    return out;
  }
  function pickRoot(dir) {
    const real = realDir(dir);
    const hit = real && choices().find((c) => sameDir(c.real, real));
    if (!hit) throw err(400, 'Chỉ chọn được kho hiện tại hoặc thư mục người cài đặt đã cho phép (ZALO_KB_ALLOWED_ROOTS).');
    return hit;
  }
  function ownTarget(rel) {
    const r = root();
    if (!r) throw err(409, 'Chưa cấu hình kho tri thức (ZALO_KB_DIR) — báo người cài đặt.');
    const dir = uploadDir(r);
    const target = resolve(r, String(rel ?? ''));
    const inside = relative(dir, target);
    if (!inside || inside.startsWith('..') || inside.includes(sep) || resolve(dir, inside) !== target) throw err(403, NOT_ALLOWED);
    if (!assertRealInside(r, dir)) throw err(404, 'Tệp không còn — tải lại trang.');
    let st; try { st = lstatSync(target); } catch { throw err(404, 'Tệp không còn — tải lại trang.'); }
    if (!st.isFile()) throw err(403, NOT_ALLOWED);
    return { r, dir, target };
  }
  function upload(rawName, buf, { folder = null } = {}) {
    const r = root();
    if (!r) throw err(409, 'Chưa cấu hình kho tri thức (ZALO_KB_DIR) — báo người cài đặt.');
    const name = safeFileName(rawName);
    checkContent(name, buf);
    const dir = uploadDir(r);
    assertReadable(dir, name);
    folders.check(folder);
    // Kiểm TRƯỚC khi tạo thư mục: thư mục cha là liên kết trỏ ra ngoài kho thì mkdir sẽ tạo ngoài kho.
    assertParentInside(r, dir);
    if (existsSync(dir)) assertRealInside(r, dir);
    mkdirSync(dir, { recursive: true });
    assertRealInside(r, dir);
    const ext = extname(name); const stem = name.slice(0, -ext.length);
    let final = name;
    for (let i = 2; existsSync(join(dir, final)); i += 1) final = `${stem} (${i})${ext}`;
    writeFileAtomic(join(dir, final), buf, { mode: 0o644 });
    cache = null;
    const rel = relOf(r, join(dir, final));
    if (folder != null) folders.assign([rel], folder);
    return rel;
  }
  return {
    info() {
      const r = root();
      return { configured: Boolean(r), publicDirs: [], uploadDir: r ? relOf(r, uploadDir(r)) : null };
    },
    async list({ fresh = false } = {}) {
      const r = root();
      if (!r) return { files: [], truncated: false, sources: [], own: [] };
      const key = String(r);
      if (fresh || !cache || cache.key !== key || now() - cache.at > LIST_TTL_MS) {
        const dir = uploadDir(r);
        const walked = await walk(r, relOf(r, dir));
        cache = { key, at: now(), files: walked.files, truncated: walked.capped, sources: summarize(walked.counts), own: await ownFiles(r, dir) };
      }
      const meta = folders.view(cache.own.map((f) => f.path), relOf(r, uploadDir(r)));
      return { files: cache.files, truncated: cache.truncated, sources: cache.sources, own: cache.own.map((f) => ({ ...f, folder: meta.folderOf(f.path) })), folders: meta.folders };
    },
    upload,
    remove(rel) {
      const { r, target } = ownTarget(rel);
      unlinkSync(target);
      folders.drop([relOf(r, target)]);
      cache = null;
    },
    /** Xoá nhiều tài liệu tự tạo: kiểm TẤT CẢ đường dẫn như xoá một tệp trước (một cái sai → lỗi, chưa xoá gì). */
    removeMany(rels) {
      if (!Array.isArray(rels) || !rels.length) throw err(400, 'Chưa chọn tài liệu nào.');
      if (rels.length > MAX_BULK) throw err(400, `Tối đa ${MAX_BULK} tài liệu mỗi lần.`);
      const targets = [...new Set([...new Set(rels.map((x) => String(x ?? '')))].map((rel) => ownTarget(rel).target))];
      for (const target of targets) unlinkSync(target);
      const r = root();
      folders.drop(targets.map((t) => relOf(r, t)));
      cache = null;
      return targets.length;
    },
    /** Xếp nhiều tài liệu tự tạo vào thư mục (`folder` null = "Chưa xếp"): kiểm hết đường dẫn và thư mục trước. */
    moveMany(rels, folder) {
      if (!Array.isArray(rels) || !rels.length) throw err(400, 'Chưa chọn tài liệu nào.');
      if (rels.length > MAX_BULK) throw err(400, `Tối đa ${MAX_BULK} tài liệu mỗi lần.`);
      const f = folders.check(folder);
      const picked = [...new Set(rels.map((x) => String(x ?? '')))].map((rel) => ownTarget(rel));
      const keys = [...new Set(picked.map(({ r, target }) => relOf(r, target)))];
      folders.assign(keys, f ? f.id : null);
      return { count: keys.length, folder: f };
    },
    createFolder: (body) => folders.create(body),
    updateFolder: (id, body) => folders.update(id, body),
    deleteFolder: (id) => folders.remove(id),
    /** Nội dung một tài liệu tự tạo dạng chữ (.md/.txt) để sửa trong cửa sổ chi tiết. */
    readOwn(rel) {
      const { target } = ownTarget(rel);
      if (!TEXT_TYPES.includes(extname(target).toLowerCase())) throw err(400, 'Chỉ sửa nội dung được tệp .md/.txt — tệp khác hãy bấm "Thay tệp".');
      if (statSync(target).size > MAX_TEXT_BYTES) throw err(400, 'Tệp quá 1 MB để sửa trên trang — tải tệp mới lên thay thế.');
      return readFileSync(target, 'utf8');
    },
    /** Đổi tên (giữ đuôi) và/hoặc lưu nội dung chữ mới. Kiểm hết rồi mới ghi. Trả đường dẫn mới. */
    saveOwn(rel, { name, text } = {}) {
      const { r, dir, target } = ownTarget(rel);
      const ext = extname(target);
      let buf = null;
      if (text !== undefined) {
        if (!TEXT_TYPES.includes(ext.toLowerCase())) throw err(400, 'Chỉ sửa nội dung được tệp .md/.txt.');
        buf = Buffer.from(String(text), 'utf8');
        if (buf.length > MAX_TEXT_BYTES) throw err(413, 'Nội dung quá 1 MB — chia thành nhiều tài liệu.');
        if (!String(text).trim()) throw err(400, 'Nội dung trống — gõ nội dung hoặc bấm Xoá tài liệu.');
      }
      let final = target;
      const wanted = stripKnownExt(String(name ?? '').trim()).replace(/[\\/]/g, '-');
      if (wanted && wanted !== basename(target, ext)) {
        const next = safeFileName(`${wanted}${ext}`);
        final = join(dir, next);
        assertReadable(dir, next);
        // Chỉ đổi hoa/thường (Windows không phân biệt) thì không phải trùng tên.
        if (!sameDir(final, target) && existsSync(final)) throw err(409, 'Đã có tài liệu trùng tên — chọn tên khác.');
      }
      if (buf) writeFileAtomic(target, buf, { mode: 0o644 });
      if (final !== target) { renameSync(target, final); folders.rename(relOf(r, target), relOf(r, final)); }
      cache = null;
      return relOf(r, final);
    },
    /** Thay cả tệp bằng tệp mới cùng định dạng (giữ tên). */
    replaceOwn(rel, buf) {
      const { target } = ownTarget(rel);
      checkContent(basename(target), buf);
      writeFileAtomic(target, buf, { mode: 0o644 });
      cache = null;
    },
    /** Viết tài liệu mới ngay trên dashboard → <tiêu đề>.md trong thư mục tự tạo. */
    createNote(title, text, opts) {
      const name = stripKnownExt(String(title ?? '').trim()).replace(/[\\/]/g, '-');
      if (!name) throw err(400, 'Đặt tiêu đề cho tài liệu.');
      const buf = Buffer.from(String(text ?? ''), 'utf8');
      if (!String(text ?? '').trim()) throw err(400, 'Nội dung trống — gõ nội dung tài liệu.');
      if (buf.length > MAX_TEXT_BYTES) throw err(413, 'Nội dung quá 1 MB — chia thành nhiều tài liệu.');
      return upload(`${name}.md`, buf, opts);
    },
    /** Nguồn hiện tại cho cửa sổ "Sửa nguồn" (chỉ Quản trị): gốc đang dùng + các gốc được phép. Bot luôn đọc cả kho. */
    source() {
      const r = root();
      const subs = r ? subdirsOf(r) : [];
      return { dir: String(kbDir() || '').trim(), exists: Boolean(r), roots: choices().map((c) => c.label), publicDirs: [], subdirs: subs };
    },
    /** Thư mục con của một gốc được phép (để chọn). */
    browse(dir) {
      const { label, real } = pickRoot(dir);
      return { dir: label, subdirs: subdirsOf(real) };
    },
    /**
     * Ghi nguồn vào .env của Hermes (có .bak): gốc phải là một trong các gốc được phép, xác nhận `allDirs` = bot đọc
     * cả kho. ZALO_KB_PUBLIC_DIRS đã ngừng dùng — xoá key khỏi .env khi đổi nguồn. Trả `changed`.
     */
    setSource({ dir, allDirs = false }) {
      if (!envFile) throw err(409, 'Bản cài này chưa cho đổi nguồn từ dashboard — báo người cài đặt.');
      if (allDirs !== true) throw err(400, 'Chưa xác nhận cho bot đọc cả kho.');
      const { label, real } = pickRoot(dir);
      const before = String(kbDir() || '').trim();
      const value = label.includes('\\') ? real.split(sep).join('/') : label;
      const changed = !sameDir(realDir(before) || before, real);
      if (changed) {
        try {
          writeEnvKeys(envFile, { ZALO_KB_DIR: value, ZALO_KB_PUBLIC_DIRS: '' });
        } catch (e) {
          if (/có ký tự không cho phép/.test(e.message)) throw err(400, 'Tên thư mục có ký tự đặc biệt (nháy, #, \\, …) — đổi tên thư mục rồi chọn lại.');
          throw e;
        }
        cache = null;
      }
      return { dir: value, publicDirs: [], changed };
    },
  };
}
