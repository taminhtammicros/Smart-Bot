// Thương hiệu (spec §7.1): logo, tên hiển thị, màu chủ đạo, dòng "Vận Hành bởi Cá Heo AI" — có khung xem trước.
import { useEffect, useRef, useState } from '../vendor/hooks.mjs';
import { api } from '../api.js';
import { html, BrandMark, Icon, Live, PageHead, PoweredBy, Spinner } from '../ui.js';
import { DEFAULT_COLOR, MIN_CONTRAST, SUGGESTIONS, brandVars, contrastWithWhite, normalizeHex } from '../brand-color.js';

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const LOGO_MAX_INPUT = 5 * 1024 * 1024;
export const LOGO_SIDE = 256;
const DEFAULT_NAME = 'Dashboard Zalo';
const DEFAULT_SUBTITLE = 'Không gian làm việc';
export const LEAVE_MSG = 'Bạn có thay đổi chưa lưu ở trang Thương hiệu. Bỏ thay đổi và rời trang?';

/** Cỡ mới giữ tỉ lệ, cạnh dài nhất ≤ max; ảnh nhỏ hơn thì giữ nguyên. */
export function fitSize(width, height, max = LOGO_SIDE) {
  const s = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** Kiểm tệp người dùng chọn trước khi đọc; trả câu lỗi hoặc ''. SVG bị từ chối (có thể chứa mã chạy được). */
export function checkLogoFile(file) {
  if (!file || !LOGO_TYPES.includes(file.type)) return 'Chỉ nhận ảnh PNG, JPG hoặc WebP (không nhận SVG) — chọn ảnh khác.';
  if (file.size > LOGO_MAX_INPUT) return 'Ảnh lớn hơn 5 MB — chọn ảnh nhỏ hơn.';
  return '';
}

/** Câu tương phản hiện cạnh ô mã màu. */
export function contrastInfo(value) {
  const hex = normalizeHex(value);
  if (!hex) return { hex: null, ok: false, text: 'Mã màu chưa đúng — nhập dạng #0f766e hoặc chọn một màu gợi ý.' };
  const ratio = contrastWithWhite(hex);
  const shown = ratio.toFixed(2).replace('.', ',');
  return ratio >= MIN_CONTRAST
    ? { hex, ok: true, text: `Chữ trắng trên màu này: ${shown} : 1 — dễ đọc.` }
    : { hex, ok: false, text: `Chữ trắng trên màu này: ${shown} : 1 — dưới 4,5 : 1, khó đọc. Chọn màu đậm hơn.` };
}

/** Thu ảnh về ≤ 256 px rồi xuất PNG ngay trong trình duyệt — máy chủ chỉ nhận PNG đã thu nhỏ. */
async function logoDataUrl(file) {
  const problem = checkLogoFile(file);
  if (problem) throw new Error(problem);
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch {
    throw new Error('Không đọc được ảnh này — mở ảnh bằng trình xem ảnh, lưu lại dạng PNG rồi chọn lại.');
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas.toDataURL('image/png');
}

/** Gắn biến CSS lên phần tử qua CSSOM: CSP `style-src 'self'` chặn thuộc tính style viết trong HTML, không chặn CSSOM. */
function useCssVars(ref, vars) {
  const key = JSON.stringify(vars);
  useEffect(() => {
    const el = ref.current;
    if (el) for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  }, [key]);
}

function Swatch({ s, selected, onPick }) {
  const ref = useRef(null);
  useCssVars(ref, { '--swatch': s.color });
  return html`<button type="button" ref=${ref} class=${`swatch${selected ? ' selected' : ''}`} aria-pressed=${selected}
    onClick=${() => onPick(s.color)}><span class="swatch-dot" aria-hidden="true"></span>${s.label}</button>`;
}

/** Thanh bên và trang đăng nhập thu nhỏ, tô theo màu đang chọn (chưa lưu). */
function Preview({ brand, hex }) {
  const ref = useRef(null);
  useCssVars(ref, brandVars(hex || DEFAULT_COLOR));
  return html`<div class="brand-preview" ref=${ref} aria-hidden="true">
    <div class="pv-side">
      <div class="side-brand"><${BrandMark} brand=${brand} />
        <span class="side-brand-text"><span>${brand.name}</span><small>${brand.subtitle}</small></span></div>
      <span class="nav-item active"><${Icon} name="home" /><span>Tổng quan</span></span>
      <span class="nav-item"><${Icon} name="chat" /><span>Phiên chat</span></span>
      <${PoweredBy} brand=${brand} />
    </div>
    <div class="pv-login">
      <div class="auth-brand"><${BrandMark} brand=${brand} size=${22} /><span>${brand.name}</span></div>
      <strong>Đăng nhập</strong>
      <span class="btn btn-primary btn-block">Tiếp tục</span>
      <${PoweredBy} brand=${brand} />
    </div>
  </div>`;
}

const formOf = (b) => ({ name: b.name, subtitle: b.subtitle || '', color: b.color, poweredBy: b.poweredBy });

export function Brand() {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const [fileName, setFileName] = useState('');

  useEffect(() => {
    api('/api/brand').then((r) => { setSaved(r); setForm(formOf(r)); }).catch((err) => setLoadError(err.message));
  }, []);

  const info = contrastInfo(form?.color);
  const dirty = Boolean(form && saved)
    && (form.name.trim() !== saved.name || form.subtitle.trim() !== (saved.subtitle || '') || info.hex !== saved.color || form.poweredBy !== saved.poweredBy);

  // Như trang Phân quyền: còn thay đổi chưa lưu thì hỏi trước khi đóng/tải lại trang hoặc chuyển trang.
  useEffect(() => {
    if (!dirty) return undefined;
    const here = location.hash;
    const onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    const onPop = () => {
      if (location.hash === here || window.confirm(LEAVE_MSG)) return;
      history.replaceState(history.state, '', here);
    };
    addEventListener('beforeunload', onUnload);
    addEventListener('popstate', onPop);
    return () => { removeEventListener('beforeunload', onUnload); removeEventListener('popstate', onPop); };
  }, [dirty]);

  const head = html`<${PageHead} title="Thương hiệu" sub="Logo, tên và màu hiện trên dashboard và trang đăng nhập." />`;
  if (loadError) return html`${head}<${Live} error=${loadError} />`;
  if (!form) return html`${head}<${Spinner} />`;

  const preview = { name: form.name.trim() || DEFAULT_NAME, subtitle: form.subtitle.trim() || DEFAULT_SUBTITLE, poweredBy: form.poweredBy, logoUrl: saved.logoUrl };

  // keepForm: đổi logo không được xoá phần tên/màu đang sửa dở.
  async function run(key, fn, okText, { keepForm = false } = {}) {
    setBusy(key); setMsg({});
    try {
      const r = await fn();
      setSaved(r);
      if (!keepForm) setForm(formOf(r));
      window.dispatchEvent(new CustomEvent('zd:brand', { detail: r }));
      setMsg({ ok: okText });
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(''); }
  }
  const save = (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setMsg({ error: 'Tên hiển thị đang trống — nhập tên rồi lưu lại.' }); return; }
    if (!info.ok) { setMsg({ error: info.text }); return; }
    run('save', () => api('/api/brand', { method: 'PUT', body: { name: form.name, subtitle: form.subtitle, color: info.hex, poweredBy: form.poweredBy } }),
      'Đã lưu — thanh bên và trang đăng nhập đã đổi theo.');
  };
  const upload = (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setFileName(file.name);
    run('logo', async () => api('/api/brand/logo', { method: 'POST', body: { dataUrl: await logoDataUrl(file) } }), 'Đã đổi logo.', { keepForm: true });
  };
  const removeLogo = () => {
    setFileName('');
    run('logo', () => api('/api/brand/logo', { method: 'DELETE' }), 'Đã gỡ logo — dùng lại biểu tượng mặc định.', { keepForm: true });
  };
  const reset = () => {
    if (!confirm('Khôi phục tên, màu và logo mặc định? Logo đã tải lên sẽ bị xoá.')) return;
    setFileName('');
    run('reset', () => api('/api/brand', { method: 'DELETE' }), 'Đã khôi phục mặc định.');
  };
  const set = (k) => (v) => setForm({ ...form, [k]: v });

  return html`${head}
    <div class="grid grid-2">
      <div class="brand-col">
        <section class="card">
          <h2>Logo</h2>
          <div class="logo-pick">
            <${BrandMark} brand=${saved} size=${22} />
            <div class="field">
              <div class="file-pick">
                <label class="btn btn-secondary file-btn">
                  <input id="brand-logo" class="sr-only" type="file" accept=${LOGO_TYPES.join(',')} disabled=${busy !== ''}
                    aria-describedby="brand-logo-name brand-logo-help" onChange=${upload} />
                  <${Icon} name="image" size=${16} /> Chọn ảnh…</label>
                <span id="brand-logo-name" class="file-name muted">${fileName || 'Chưa chọn ảnh'}</span>
              </div>
              <small id="brand-logo-help">PNG, JPG hoặc WebP, tối đa 5 MB. Ảnh được thu về ${LOGO_SIDE}×${LOGO_SIDE} điểm ảnh — nên dùng ảnh vuông, nền trong suốt.</small>
            </div>
          </div>
          ${saved.logoUrl ? html`<button type="button" class="btn btn-secondary btn-sm" disabled=${busy !== ''} onClick=${removeLogo}>Gỡ logo</button>` : null}
          ${busy === 'logo' ? html`<${Spinner} label="Đang xử lý ảnh…" />` : null}
        </section>
        <form class="card" onSubmit=${save} novalidate>
          <h2>Tên và màu</h2>
          <div class="field">
            <label for="brand-name">Tên hiển thị</label>
            <input id="brand-name" maxlength="40" value=${form.name} aria-describedby="brand-name-help"
              onInput=${(e) => set('name')(e.currentTarget.value)} />
            <small id="brand-name-help">Hiện trên thanh bên, trang đăng nhập và tab trình duyệt. Tối đa 40 ký tự.</small>
          </div>
          <div class="field">
            <label for="brand-subtitle">Dòng phụ dưới tên</label>
            <input id="brand-subtitle" maxlength="40" value=${form.subtitle} placeholder=${DEFAULT_SUBTITLE} aria-describedby="brand-subtitle-help"
              onInput=${(e) => set('subtitle')(e.currentTarget.value)} />
            <small id="brand-subtitle-help">Chữ nhỏ dưới tên ở thanh bên, vd. tên trường hoặc đơn vị. Để trống = "${DEFAULT_SUBTITLE}".</small>
          </div>
          <fieldset class="field brand-colors">
            <legend>Màu chủ đạo</legend>
            <div class="swatches">
              ${SUGGESTIONS.map((s) => html`<${Swatch} key=${s.color} s=${s} selected=${info.hex === s.color} onPick=${set('color')} />`)}
            </div>
            <div class="color-row">
              <input type="color" aria-label="Bảng chọn màu" value=${info.hex || DEFAULT_COLOR} onInput=${(e) => set('color')(e.currentTarget.value)} />
              <label class="sr-only" for="brand-hex">Mã màu</label>
              <input id="brand-hex" class="mono" spellcheck="false" autocomplete="off" maxlength="7" value=${form.color}
                aria-describedby="brand-contrast" onInput=${(e) => set('color')(e.currentTarget.value)} />
            </div>
            <p id="brand-contrast" class=${`contrast ${info.ok ? 'contrast-ok' : 'contrast-bad'}`} aria-live="polite">
              <${Icon} name=${info.ok ? 'check' : 'warn'} size=${16} /> ${info.text}</p>
          </fieldset>
          <label class="check" for="brand-powered">
            <input id="brand-powered" type="checkbox" checked=${form.poweredBy} onChange=${(e) => set('poweredBy')(e.currentTarget.checked)} />
            Hiện dòng "Vận Hành bởi Cá Heo AI"</label>
          <div class="row form-end">
            <button class="btn btn-primary" disabled=${busy !== '' || !dirty || !info.ok}>${busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
            <button type="button" class="btn btn-secondary" disabled=${busy !== ''} onClick=${reset}>
              <${Icon} name="refresh" size=${16} /> Khôi phục mặc định</button>
            ${dirty ? html`<small class="muted">Có thay đổi chưa lưu.</small>` : null}
          </div>
          <${Live} error=${msg.error} ok=${msg.ok} />
        </form>
      </div>
      <section class="card">
        <h2>Xem trước</h2>
        <p class="muted small">Thanh bên và trang đăng nhập theo lựa chọn hiện tại — bấm Lưu để áp dụng.</p>
        <${Preview} brand=${preview} hex=${info.hex} />
      </section>
    </div>`;
}
