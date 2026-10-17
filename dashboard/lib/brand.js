// Thương hiệu (spec §5.1, §9, §11.8): tên, màu, logo, dòng "Vận Hành bởi Cá Heo AI".
// Logo chỉ nhận PNG ≤ 256 px đã được trình duyệt thu nhỏ; máy chủ kiểm byte, không giải mã ảnh.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { DEFAULT_COLOR, MIN_CONTRAST, brandVars, contrastWithWhite, normalizeHex } from '../public/brand-color.js';
import { readJson, writeFileAtomic, writeJsonAtomic } from './json-store.js';

export const DEFAULT_NAME = 'Dashboard Zalo';
export const MAX_NAME = 40;
export const DEFAULT_SUBTITLE = 'Không gian làm việc';
export const MAX_SUBTITLE = 40;
export const LOGO_MAX_SIDE = 256;
export const LOGO_MAX_BYTES = 400 * 1024;

export class InvalidBrand extends Error {
  constructor(message) { super(message); this.name = 'InvalidBrand'; this.statusCode = 400; }
}

/** Kiểm thân PUT /api/brand; trả bản đã chuẩn hoá hoặc ném InvalidBrand (chữ tiếng Việt có bước tiếp theo). */
export function parseBrand(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof b.name !== 'string') throw new InvalidBrand('Tên hiển thị không hợp lệ — nhập lại tên.');
  // eslint-disable-next-line no-control-regex
  const name = b.name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new InvalidBrand('Tên hiển thị đang trống — nhập tên rồi lưu lại.');
  if ([...name].length > MAX_NAME) throw new InvalidBrand(`Tên hiển thị tối đa ${MAX_NAME} ký tự — rút gọn rồi lưu lại.`);
  const color = normalizeHex(b.color);
  if (!color) throw new InvalidBrand('Mã màu không hợp lệ — nhập dạng #0f766e hoặc chọn một màu gợi ý.');
  if (contrastWithWhite(color) < MIN_CONTRAST) {
    throw new InvalidBrand('Màu này quá nhạt, chữ trắng trên nút sẽ khó đọc — chọn màu đậm hơn.');
  }
  if (typeof b.poweredBy !== 'boolean') throw new InvalidBrand('Lựa chọn "Vận Hành bởi Cá Heo AI" không hợp lệ — tải lại trang rồi thử lại.');
  // Dòng phụ dưới tên (giai đoạn 7): bản giao diện cũ không gửi → giữ mặc định.
  if (b.subtitle !== undefined && typeof b.subtitle !== 'string') throw new InvalidBrand('Dòng phụ không hợp lệ — nhập lại.');
  // eslint-disable-next-line no-control-regex
  const subtitle = String(b.subtitle ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() || DEFAULT_SUBTITLE;
  if ([...subtitle].length > MAX_SUBTITLE) throw new InvalidBrand(`Dòng phụ tối đa ${MAX_SUBTITLE} ký tự — rút gọn rồi lưu lại.`);
  return { name, subtitle, color, poweredBy: b.poweredBy };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** Nhận `data:image/png;base64,…` → Buffer PNG đã kiểm (chữ ký, IHDR, kích thước, IEND). SVG/JPEG/khác → InvalidBrand. */
export function decodeLogo(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl ?? ''));
  if (!m) throw new InvalidBrand('Logo phải là ảnh PNG, JPG hoặc WebP — chọn ảnh khác.');
  if (m[1].length > Math.ceil(LOGO_MAX_BYTES * 4 / 3) + 4) throw new InvalidBrand('Logo quá lớn — chọn ảnh đơn giản hơn hoặc nhỏ hơn.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > LOGO_MAX_BYTES) throw new InvalidBrand('Logo quá lớn — chọn ảnh đơn giản hơn hoặc nhỏ hơn.');
  const ok = buf.length >= 8 + 25 + 12
    && buf.subarray(0, 8).equals(PNG_SIGNATURE)
    && buf.readUInt32BE(8) === 13 && buf.toString('latin1', 12, 16) === 'IHDR'
    && buf.subarray(buf.length - 12).equals(IEND);
  if (!ok) throw new InvalidBrand('Tệp không phải ảnh PNG hợp lệ — chọn ảnh khác.');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 1 || height < 1 || width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE) {
    throw new InvalidBrand(`Logo phải tối đa ${LOGO_MAX_SIDE}×${LOGO_MAX_SIDE} điểm ảnh — tải lại trang rồi chọn lại ảnh.`);
  }
  return buf;
}

/** Nội dung /brand.css: ghi đè biến màu khi khác mặc định; mặc định thì để style.css quyết. */
export function brandCss(color) {
  if (color === DEFAULT_COLOR) return '/* Màu mặc định — xem style.css */\n';
  const vars = Object.entries(brandVars(color)).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `:root {\n${vars}\n}\n`;
}

export function createBrandStore({ file, logoFile, now = Date.now }) {
  const DEFAULTS = { name: DEFAULT_NAME, subtitle: DEFAULT_SUBTITLE, color: DEFAULT_COLOR, poweredBy: true, logoAt: null };
  function read() {
    const raw = readJson(file, {});
    const out = { ...DEFAULTS };
    try { Object.assign(out, parseBrand({ ...DEFAULTS, ...raw })); } catch { /* tệp sửa tay sai → mặc định */ }
    out.logoAt = Number.isFinite(raw?.logoAt) && existsSync(logoFile) ? raw.logoAt : null;
    return out;
  }
  const save = (data) => writeJsonAtomic(file, data);
  return {
    /** Phần công khai — đúng thứ trang đăng nhập cần, không hơn. */
    get() {
      const b = read();
      return { name: b.name, subtitle: b.subtitle, color: b.color, poweredBy: b.poweredBy, logoUrl: b.logoAt ? `/brand/logo.png?v=${b.logoAt}` : null };
    },
    set(body) {
      const b = parseBrand(body);
      save({ ...b, logoAt: read().logoAt });
      return this.get();
    },
    setLogo(dataUrl) {
      const buf = decodeLogo(dataUrl);
      writeFileAtomic(logoFile, buf);
      const { logoAt, ...rest } = read();
      save({ ...rest, logoAt: Math.max(now(), (logoAt || 0) + 1) });
      return this.get();
    },
    removeLogo() {
      rmSync(logoFile, { force: true });
      const { logoAt, ...rest } = read();
      save({ ...rest, logoAt: null });
      return this.get();
    },
    reset() {
      rmSync(logoFile, { force: true });
      rmSync(file, { force: true });
      return this.get();
    },
    /** Buffer logo hoặc null. */
    logo: () => (read().logoAt ? readFileSync(logoFile) : null),
    css: () => brandCss(read().color),
  };
}
