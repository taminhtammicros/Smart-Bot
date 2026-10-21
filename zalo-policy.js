import { dmVerdict } from './dm-rules.js';

const PUBLIC_READ_METHODS = new Set([
  'searchSticker', 'getStickersDetail', 'getListReminder',
]);

// getGroupMembersInfo tra hồ sơ theo ID thành viên bất kỳ, không gắn với
// nhóm nào — người ngoài xem thành viên nhóm mình qua lệnh group_members.
const OWNER_READ_METHODS = new Set([
  'getGroupMembersInfo',
  'getGroupChatHistory', 'getGroupInfo', 'getAllGroups', 'getAllFriends',
  'getUserInfo', 'findUser', 'findUserByUsername', 'fetchAccountInfo',
  'getPollDetail', 'getPendingGroupMembers', 'getGroupLinkDetail',
]);

// Chỉ gửi chữ/tệp/thoại/nhắc hẹn — việc người trong nhóm nhờ bot làm trong chính
// hội thoại họ đang nói (sameThread bên dưới). Mọi hàm sửa trạng thái Zalo (tên
// nhóm, thành viên, ghim, chuyển tiếp, bảng hỏi…) thuộc OWNER_SIDE_EFFECT_METHODS.
const PUBLIC_SIDE_EFFECT_METHODS = new Set([
  'sendMessage', 'sendVoice', 'sendSticker', 'sendLink', 'uploadAttachment',
  'createReminder', 'removeReminder',
]);

const OWNER_SIDE_EFFECT_METHODS = new Set([
  'forwardMessage', 'createPoll', 'lockPoll', 'votePoll', 'addPollOptions', 'createNote',
  'setPinnedConversations', 'setMute', 'changeGroupName', 'addUserToGroup',
  'removeUserFromGroup', 'addGroupDeputy', 'removeGroupDeputy',
  'reviewPendingMemberRequest', 'enableGroupLink', 'disableGroupLink',
  'createGroup', 'inviteUserToGroups', 'joinGroupLink', 'updateProfileBio',
  'updateActiveStatus',
  // Chỉ mở khi ZALO_FRIEND_TOOLS bật — cầu nối kiểm công tắc.
  'sendFriendRequest', 'acceptFriendRequest',
]);

const DANGEROUS_METHODS = new Set([
  'lockPoll', 'setPinnedConversations', 'setMute', 'changeGroupName',
  'addUserToGroup', 'removeUserFromGroup', 'addGroupDeputy', 'removeGroupDeputy',
  'reviewPendingMemberRequest', 'enableGroupLink', 'disableGroupLink',
  'createGroup', 'inviteUserToGroups', 'joinGroupLink', 'updateProfileBio',
  'updateActiveStatus',
]);

const PUBLIC_COMMANDS = new Set(['send', 'typing', 'reaction', 'seen', 'ack_message']);

// Lệnh Zalo gắn đúng một nút tính năng nhắn riêng. Gửi tệp/thoại không có ở đây: adapter cũng
// dùng uploadAttachment/sendVoice để gửi tệp kèm câu trả lời, nên chỉ plugin phân biệt được.
const DM_METHOD_FEATURE = new Map([
  ['createReminder', 'reminders'], ['removeReminder', 'reminders'], ['getListReminder', 'reminders'],
]);

const TARGET_ARG_INDEX = new Map([
  ['sendMessage', 1], ['sendVoice', 1], ['sendSticker', 1], ['sendLink', 1],
  ['uploadAttachment', 1], ['createReminder', 1], ['getListReminder', 0],
  ['removeReminder', 1],
]);

function denied(role, code, category) {
  return { allowed: false, role, code, category };
}

function allowed(role, category) {
  return { allowed: true, role, code: 'allowed', category };
}

function sameThread(command, auth) {
  let targetId = command.threadId;
  let targetType = command.threadType;
  if (command.type === 'invoke') {
    const index = TARGET_ARG_INDEX.get(String(command.method || ''));
    if (index == null) return true;
    targetId = Array.isArray(command.args) ? command.args[index] : null;
    if (['getListReminder'].includes(command.method)) targetType = command.args?.[1];
    else targetType = command.args?.[index + 1];
  }
  return String(targetId ?? '') === String(auth.sourceThreadId ?? '')
    && Number(targetType) === Number(auth.sourceThreadType);
}

function classify(command) {
  if (command.type === 'ping') return { minimumRole: 'system', category: 'health', dangerous: false };
  // Khung thử của plugin (``health_details``): chỉ để hỏi "cầu nối này có biết lệnh
  // trong nhóm không". Không phải lệnh, không chạy gì, không đụng hội thoại nào —
  // nên xếp cùng mức với ``ping``: THOÁT SỚM trước mọi phép xét ``auth``.
  //
  // Sự cố 21/10 07:36: plugin gọi lúc mới nối, chưa có lượt chat nào để mượn
  // ``auth``; để mức ``public`` thì ``authorizeBridgeCommand`` trả ``auth_required``
  // và plugin đọc đó thành "cầu nối không biết lệnh" → báo nhầm bản cũ.
  if (command.type === 'health_details') return { minimumRole: 'system', category: 'health', dangerous: false };
  if (PUBLIC_COMMANDS.has(command.type)) return { minimumRole: 'public', category: 'send', dangerous: false };
  if (command.type === 'group_members') return { minimumRole: 'public', category: 'read', dangerous: false };
  if (command.type === 'history') return { minimumRole: 'public', category: 'read', dangerous: false };
  // Lệnh hệ thống của chủ nhân (owner-commands.js): chạy CLI Hermes. Đổi máy thì cần
  // xác nhận như các hàm admin khác; lệnh đọc thì không.
  if (command.type === 'owner_command') {
    return { minimumRole: 'owner', category: 'admin', dangerous: command.role === 'main' && command.confirm === true };
  }
  if (command.type === 'owner_reset_session') return { minimumRole: 'owner', category: 'read', dangerous: false };
  // Đọc cả một khoảng thời gian (có thể hàng nghìn tin) chỉ dành cho chủ nhân.
  if (command.type === 'history_range') return { minimumRole: 'owner', category: 'read', dangerous: false };
  // Tra lịch sử của thành viên (spec §19.5): chỉ đọc kho, tối đa 40 tin, đúng hội thoại đang thao tác (sameThread bên dưới).
  if (command.type === 'history_search') return { minimumRole: 'public', category: 'read', dangerous: false };
  if (command.type === 'undo') return { minimumRole: 'owner', category: 'undo', dangerous: true };
  if (command.type === 'welcome_config') return { minimumRole: 'owner', category: 'admin', dangerous: false };
  // `/outgroup` và `/kick` đuổi người khỏi nhóm (hoặc đuổi chính bot): cần chữ xác nhận trong cùng tin, như mọi
  // lệnh admin khác. Plugin gắn cờ đó — cầu nối không tự đặt.
  if (command.type === 'outgroup' || command.type === 'kick') {
    return { minimumRole: 'owner', category: 'admin', dangerous: true };
  }
  // Kết bạn rồi tạo nhóm (zalo-friends.js): chủ bot duyệt lúc ra lệnh, sidecar tự tạo nhóm sau.
  // Lập kế hoạch dẫn tới gửi lời mời và tạo nhóm, nên cần xác nhận như createGroup; xem/huỷ thì không.
  if (command.type === 'friend_group') {
    return { minimumRole: 'owner', category: 'admin', dangerous: command.action === 'create' };
  }
  if (command.type !== 'invoke') return null;

  const method = String(command.method || '');
  if (PUBLIC_READ_METHODS.has(method)) return { minimumRole: 'public', category: 'read', dangerous: false };
  if (OWNER_READ_METHODS.has(method)) return { minimumRole: 'owner', category: 'read', dangerous: false };
  if (PUBLIC_SIDE_EFFECT_METHODS.has(method)) return { minimumRole: 'public', category: 'send', dangerous: false };
  if (OWNER_SIDE_EFFECT_METHODS.has(method)) {
    return { minimumRole: 'owner', category: 'admin', dangerous: DANGEROUS_METHODS.has(method) };
  }
  return null;
}

/**
 * Lượt nhắn riêng của người không phải chủ nhân: kiểm mục `dm` của permissions.json (lớp thứ hai,
 * sau plugin). `dmRules()` trả dm đã chuẩn hoá hoặc null (không có mục / lỗi → không chặn thêm).
 * Chủ nhân luôn được miễn — xét theo UID, kể cả khi adapter hạ lượt của chủ xuống quyền công khai.
 */
function dmDenial(command, auth, owners, dmRules) {
  if (!dmRules || Number(auth.sourceThreadType) !== 0 || owners.has(String(auth.actorUid))) return null;
  let dm = null;
  try { dm = dmRules(); } catch { dm = null; }
  if (!dm) return null;
  const verdict = dmVerdict(dm, auth.actorUid);
  // Câu trả lời /sethome (chỉ cho người lạ biết UID của chính họ) vẫn phải đi được.
  if (verdict.allowed === false && !(command.type === 'send' && auth.notice === 'sethome')) return 'dm_not_allowed';
  const feature = command.type === 'history_search' ? 'history'
    : command.type === 'invoke' ? DM_METHOD_FEATURE.get(String(command.method || '')) : null;
  if (feature && verdict.features[feature] === false) return 'feature_disabled';
  return null;
}

export function authorizeBridgeCommand(command, { ownerUids = new Set(), dmRules = null } = {}) {
  const rule = classify(command || {});
  // Khung lạ (không có trong classify) phải nói đúng là "không biết", không phải "không được phép":
  // plugin dùng chính câu trả lời này để biết cầu nối đã có lệnh trong nhóm (adapter.bridge_group_commands).
  if (!rule) return denied('public', 'unknown_command', 'unknown');
  if (rule.minimumRole === 'system') return allowed('system', rule.category);

  const auth = command?.auth;
  const owners = ownerUids instanceof Set ? ownerUids : new Set(ownerUids || []);
  if (auth?.actorRole === 'system') {
    // Ngoài lượt chat (cron, gửi bù sau khi gateway khởi động lại, thông báo)
    // không có người gửi. Cầu nối chỉ nhận kết nối có token từ chính Hermes,
    // nên vai trò này tới được mọi hội thoại — nhưng chỉ để gửi chữ hoặc báo
    // đang gõ, không gọi hàm Zalo, không đọc lịch sử, không thu hồi.
    return ['send', 'typing'].includes(command.type)
      ? allowed('system', rule.category)
      : denied('system', 'auth_required', rule.category);
  }
  if (!auth || !String(auth.actorUid || '') || !String(auth.sourceThreadId || '')
      || ![0, 1].includes(Number(auth.sourceThreadType))) {
    return denied('public', 'auth_required', rule.category);
  }

  // Phải vừa nằm trong allowlist vừa được adapter xác nhận là chủ của lượt này:
  // adapter có thể hạ một lượt của chủ xuống quyền công khai (xem
  // _bind_turn_for_source), sidecar không được tự nâng lại.
  const role = owners.has(String(auth.actorUid)) && auth.actorRole === 'owner' ? 'owner' : 'public';
  if (rule.minimumRole === 'owner' && role !== 'owner') {
    return denied(role, 'owner_required', rule.category);
  }
  const dmCode = role === 'public' ? dmDenial(command, auth, owners, dmRules) : null;
  if (dmCode) return denied(role, dmCode, rule.category);
  if (role === 'public' && !sameThread(command, auth)) {
    return denied(role, 'cross_thread_denied', rule.category);
  }
  if (rule.dangerous && auth.confirmed !== true) {
    return denied(role, 'confirmation_required', rule.category);
  }
  return allowed(role, rule.category);
}

export const ZALO_POLICY_METHODS = Object.freeze({
  publicRead: PUBLIC_READ_METHODS,
  ownerRead: OWNER_READ_METHODS,
  publicSideEffects: PUBLIC_SIDE_EFFECT_METHODS,
  ownerSideEffects: OWNER_SIDE_EFFECT_METHODS,
  dangerous: DANGEROUS_METHODS,
});
