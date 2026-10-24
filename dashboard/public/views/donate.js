// Ủng hộ tác giả: nút mở cửa sổ có mã VietQR (MB Bank) + số tài khoản, bấm để chép.
import { useState } from '../vendor/hooks.mjs';
import { html, Dialog, Icon } from '../ui.js';
import { CommunityLinks } from './community.js';

export const DONATE = { bank: 'MB Bank', account: '0988328338', name: 'TA MINH TAM' };

function DonateDialog({ onClose }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(DONATE.account); setCopied(true); } catch { setCopied(false); }
  }
  return html`<${Dialog} title="Ủng hộ" onClose=${onClose}>
    <div class="stack donate">
      <p class="small">Nếu bot Zalo này hay và hữu ích với anh chị, một ly cà phê ủng hộ sẽ giúp chúng tôi có thêm động lực làm tiếp. Cảm ơn anh chị rất nhiều!</p>
      <img class="donate-qr" src="/donate-qr.jpg" width="240" height="240" alt=${`Mã QR chuyển khoản ${DONATE.bank} ${DONATE.account} ${DONATE.name}`} />
      <dl class="donate-info">
        <dt>Ngân hàng</dt><dd>${DONATE.bank}</dd>
        <dt>Số tài khoản</dt><dd><span class="mono">${DONATE.account}</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick=${copy}>${copied ? 'Đã chép' : 'Chép'}</button></dd>
        <dt>Chủ tài khoản</dt><dd>${DONATE.name}</dd>
      </dl>
      <p class="muted small">Quét mã bằng ứng dụng ngân hàng bất kỳ.</p>
      <${CommunityLinks} />
    </div>
  <//>`;
}

/** Nút "Ủng hộ tác giả" (thanh trạng thái đầu trang, trang Tài khoản). */
export function DonateButton({ className = 'donate-pill' }) {
  const [open, setOpen] = useState(false);
  return html`<button type="button" class=${className} aria-label="Ủng hộ tác giả" onClick=${() => setOpen(true)}><${Icon} name="heart" size=${18} /><span>Ủng hộ<span class="donate-more"></span></span></button>
    ${open ? html`<${DonateDialog} onClose=${() => setOpen(false)} />` : null}`;
}
