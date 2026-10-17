// Cá Heo AI BOT FORUM: nhóm Zalo trải nghiệm bot, fanpage và Facebook của tác giả. Link ngoài mở tab mới,
// không gửi Referer (đường dẫn dashboard của khách không lộ ra ngoài).
import { html, Icon } from '../ui.js';

export const COMMUNITY = {
  zalo: 'https://zalo.me/g/eyugp7bwy7k2bfdrlfbb',
  fanpage: 'https://2anhaieducation.pro.vn/',
  facebook: 'https://www.facebook.com/luonghaianh1208',
};

const ext = (href, cls, label, body) => html`<a class=${cls} href=${href} target="_blank" rel="noopener noreferrer" aria-label=${label}>${body}</a>`;

/** Nút "Cá Heo AI BOT FORUM" trên thanh trạng thái: vào nhóm Zalo trải nghiệm bot. */
export function CommunityButton() {
  return ext(COMMUNITY.zalo, 'community-pill', 'Tham gia nhóm Zalo Cá Heo AI BOT FORUM (mở tab mới)',
    html`<${Icon} name="users" size=${18} /><span>Cá Heo AI<span class="community-more"> BOT FORUM</span></span>`);
}

/** Ba link cộng đồng (cửa sổ Ủng hộ tác giả). */
export function CommunityLinks() {
  return html`<div class="community-links">
    <p class="small"><strong>Cá Heo AI BOT FORUM</strong> — trải nghiệm bot, hỏi đáp và đặt dùng:</p>
    <ul>
      <li>${ext(COMMUNITY.zalo, 'link', 'Nhóm Zalo Cá Heo AI BOT FORUM (mở tab mới)', 'Nhóm Zalo Cá Heo AI BOT FORUM')}</li>
      <li>${ext(COMMUNITY.fanpage, 'link', 'Trang 2Anh AI Education (mở tab mới)', 'Trang 2Anh AI Education')}</li>
      <li>${ext(COMMUNITY.facebook, 'link', 'Facebook Lương Hải Anh (mở tab mới)', 'Facebook Lương Hải Anh')}</li>
    </ul>
  </div>`;
}
