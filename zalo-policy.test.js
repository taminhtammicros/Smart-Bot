import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeBridgeCommand } from './zalo-policy.js';

const publicAuth = {
  actorUid: 'member-1', actorRole: 'public', sourceThreadId: 'group-1', sourceThreadType: 1, confirmed: false,
};
const ownerAuth = {
  actorUid: 'owner-1', actorRole: 'owner', sourceThreadId: 'owner-1', sourceThreadType: 0, confirmed: false,
};
const policyOptions = { ownerUids: new Set(['owner-1']) };

test('public actor can send only to the active conversation', () => {
  assert.deepEqual(authorizeBridgeCommand({
    type: 'invoke', method: 'sendSticker', args: [{ id: '1' }, 'group-1', 1], auth: publicAuth,
  }, policyOptions), { allowed: true, role: 'public', code: 'allowed', category: 'send' });

  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'sendSticker', args: [{ id: '1' }, 'other-group', 1], auth: publicAuth,
  }, policyOptions).code, 'cross_thread_denied');
});

test('public actor cannot call an owner method', () => {
  const result = authorizeBridgeCommand({
    type: 'invoke', method: 'removeUserFromGroup', args: [['user-2'], 'group-1'], auth: publicAuth,
  }, policyOptions);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'owner_required');
});

test('claimed owner role cannot elevate a uid absent from the allowlist', () => {
  const result = authorizeBridgeCommand({
    type: 'invoke', method: 'getAllGroups', args: [],
    auth: { ...publicAuth, actorRole: 'owner' },
  }, policyOptions);
  assert.equal(result.allowed, false);
  assert.equal(result.role, 'public');
  assert.equal(result.code, 'owner_required');
});

test('uid chủ nhân mà adapter hạ xuống public thì sidecar không tự nâng lại', () => {
  const result = authorizeBridgeCommand({
    type: 'invoke', method: 'getAllGroups', args: [], auth: { ...ownerAuth, actorRole: 'public' },
  }, policyOptions);
  assert.equal(result.role, 'public');
  assert.equal(result.code, 'owner_required');
});

test('allowlisted owner can call owner read operations', () => {
  assert.deepEqual(authorizeBridgeCommand({
    type: 'invoke', method: 'getAllGroups', args: [], auth: ownerAuth,
  }, policyOptions), { allowed: true, role: 'owner', code: 'allowed', category: 'read' });
});

test('dangerous owner operation requires explicit confirmation', () => {
  const command = {
    type: 'invoke', method: 'removeUserFromGroup', args: [['user-2'], 'group-1'], auth: ownerAuth,
  };
  assert.equal(authorizeBridgeCommand(command, policyOptions).code, 'confirmation_required');
  assert.equal(authorizeBridgeCommand({
    ...command, auth: { ...ownerAuth, confirmed: true },
  }, policyOptions).allowed, true);
});

test('undo is owner-only, confirmed, and scoped to its declared destination', () => {
  const command = { type: 'undo', threadId: 'group-1', threadType: 1, auth: ownerAuth };
  assert.equal(authorizeBridgeCommand(command, policyOptions).code, 'confirmation_required');
  assert.deepEqual(authorizeBridgeCommand({
    ...command, auth: { ...ownerAuth, confirmed: true },
  }, policyOptions), { allowed: true, role: 'owner', code: 'allowed', category: 'undo' });
});

test('missing and malformed authorization fail closed', () => {
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'group-1', threadType: 1 }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({
    type: 'send', threadId: 'group-1', threadType: 1,
    auth: { actorUid: '', sourceThreadId: 'group-1', sourceThreadType: 1 },
  }, policyOptions).code, 'auth_required');
});

test('system actor (cron, gửi bù, thông báo gateway) gửi chữ được tới mọi hội thoại nhưng không làm gì khác', () => {
  const system = { actorUid: '', actorRole: 'system', sourceThreadId: '', sourceThreadType: 0, confirmed: false };
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'owner-1', threadType: 0, auth: system }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'typing', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'invoke', method: 'getAllGroups', args: [], auth: system }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'sendMessage', args: [{ msg: 'x' }, 'group-1', 1], auth: system,
  }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({ type: 'undo', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).code, 'auth_required');
});

test('history mở cho public nhưng chỉ trong đúng hội thoại đang thao tác', () => {
  assert.deepEqual(authorizeBridgeCommand({ type: 'history', threadId: 'group-1', threadType: 1, auth: publicAuth }, policyOptions), {
    allowed: true, role: 'public', code: 'allowed', category: 'read',
  });
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'other-group', threadType: 1, auth: publicAuth }, policyOptions).code, 'cross_thread_denied');
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'group-1', threadType: 0, auth: publicAuth }, policyOptions).code, 'cross_thread_denied');
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'any-thread', threadType: 1, auth: ownerAuth }, policyOptions).allowed, true);
});

test('public group_members chỉ đọc được nhóm đang trò chuyện; tra hồ sơ theo ID là việc của chủ', () => {
  assert.equal(authorizeBridgeCommand({ type: 'group_members', threadId: 'group-1', threadType: 1, auth: publicAuth }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'group_members', threadId: 'other', threadType: 1, auth: publicAuth }, policyOptions).code, 'cross_thread_denied');
  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'getGroupMembersInfo', args: [['u1']], auth: publicAuth,
  }, policyOptions).code, 'owner_required');
});

test('ping và health_details được miễn xét quyền: không gắn với hội thoại nào', () => {
  assert.deepEqual(authorizeBridgeCommand({ type: 'ping' }, policyOptions), {
    allowed: true, role: 'system', code: 'allowed', category: 'health',
  });
  // Plugin hỏi khung thử ngay lúc mới nối, trước mọi lượt chat nên không có `auth` để mượn.
  // Nay phải trả lời được (mức system), nếu không plugin đọc câu trả lời thành "bản cũ".
  assert.deepEqual(authorizeBridgeCommand({ type: 'health_details' }, policyOptions), {
    allowed: true, role: 'system', code: 'allowed', category: 'health',
  });
});

test('tra chi tiết nhãn dán là quyền đọc công khai', () => {
  // Bot cần tra ngược id sticker để biết người ta vừa gửi cái gì; đây là đọc
  // thuần, không gắn với hội thoại nào nên không cần cùng luồng.
  assert.deepEqual(
    authorizeBridgeCommand({ type: 'invoke', method: 'getStickersDetail', args: [4001], auth: publicAuth }, policyOptions),
    { allowed: true, role: 'public', code: 'allowed', category: 'read' },
  );
});

test('đọc cả khoảng thời gian chỉ dành cho chủ nhân', () => {
  const command = { type: 'history_range', threadId: 'group-1', threadType: 1, sinceMs: 0 };
  assert.equal(authorizeBridgeCommand({ ...command, auth: publicAuth }, policyOptions).code, 'owner_required');
  assert.deepEqual(
    authorizeBridgeCommand({ ...command, auth: ownerAuth }, policyOptions),
    { allowed: true, role: 'owner', code: 'allowed', category: 'read' },
  );
});

test('kết bạn và kế hoạch kết bạn rồi tạo nhóm chỉ dành cho chủ nhân', () => {
  const commands = [
    { type: 'friend_group', action: 'create', memberIds: ['1'] },
    { type: 'invoke', method: 'sendFriendRequest', args: ['Chào', '1'] },
    { type: 'invoke', method: 'acceptFriendRequest', args: ['1'] },
  ];
  for (const command of commands) {
    assert.equal(authorizeBridgeCommand({ ...command, auth: publicAuth }, policyOptions).code, 'owner_required');
    assert.equal(authorizeBridgeCommand({ ...command, auth: { ...ownerAuth, confirmed: true } }, policyOptions).allowed, true);
  }
  // Lập kế hoạch dẫn tới tạo nhóm nên cần xác nhận như createGroup; xem danh sách thì không.
  assert.equal(authorizeBridgeCommand({ ...commands[0], auth: ownerAuth }, policyOptions).allowed, false);
  assert.equal(authorizeBridgeCommand({ type: 'friend_group', action: 'list', auth: ownerAuth }, policyOptions).allowed, true);
});

test('cấu hình chào thành viên mới chỉ dành cho chủ nhân', () => {
  const command = { type: 'welcome_config', action: 'set', groupId: '123', patch: { enabled: false } };
  assert.equal(authorizeBridgeCommand({ ...command, auth: publicAuth }, policyOptions).code, 'owner_required');
  assert.equal(authorizeBridgeCommand({ ...command, auth: { actorRole: 'system' } }, policyOptions).code, 'auth_required');
  assert.deepEqual(
    authorizeBridgeCommand({ ...command, auth: ownerAuth }, policyOptions),
    { allowed: true, role: 'owner', code: 'allowed', category: 'admin' },
  );
});

// --- Nhắn riêng (spec §16): lớp chặn thứ hai sau plugin ---
const dmAuth = (uid, extra = {}) => ({ actorUid: uid, actorRole: 'public', sourceThreadId: uid, sourceThreadType: 0, confirmed: false, ...extra });
const dmOptions = (dm) => ({ ownerUids: new Set(['owner-1']), dmRules: () => dm });
const sendTo = (uid) => ({ type: 'send', threadId: uid, threadType: 0 });

test('nhắn riêng: người ngoài danh sách bị chặn mọi lệnh, trừ câu trả lời /sethome', () => {
  const opts = dmOptions({ who: 'list', features: {}, people: { 'friend-1': { features: {} } } });
  assert.equal(authorizeBridgeCommand({ ...sendTo('friend-1'), auth: dmAuth('friend-1') }, opts).allowed, true);
  assert.equal(authorizeBridgeCommand({ ...sendTo('stranger'), auth: dmAuth('stranger') }, opts).code, 'dm_not_allowed');
  assert.equal(authorizeBridgeCommand({ type: 'typing', threadId: 'stranger', threadType: 0, auth: dmAuth('stranger') }, opts).code, 'dm_not_allowed');
  assert.equal(authorizeBridgeCommand({ ...sendTo('stranger'), auth: dmAuth('stranger', { notice: 'sethome' }) }, opts).allowed, true);
  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'sendSticker', args: [{ id: '1' }, 'stranger', 0], auth: dmAuth('stranger', { notice: 'sethome' }),
  }, opts).code, 'dm_not_allowed', 'dấu /sethome chỉ mở đúng lệnh gửi chữ');
});

test('nhắn riêng: chủ nhân luôn được miễn, kể cả lượt bị hạ xuống quyền công khai', () => {
  const opts = dmOptions({ who: 'owners', features: { reminders: false }, people: {} });
  assert.equal(authorizeBridgeCommand({ ...sendTo('owner-1'), auth: dmAuth('owner-1') }, opts).allowed, true);
  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'createReminder', args: [{ title: 'x' }, 'owner-1', 0], auth: dmAuth('owner-1'),
  }, opts).allowed, true);
});

test('nhắn riêng: nút Nhắc hẹn tắt chặn lệnh nhắc hẹn; nhóm và lượt hệ thống không bị ảnh hưởng', () => {
  const opts = dmOptions({ who: 'everyone', features: { reminders: false }, people: { 'vip': { features: { reminders: true } } } });
  for (const [method, args] of [['createReminder', [{ title: 'x' }, 'u2', 0]], ['removeReminder', ['r1', 'u2', 0]], ['getListReminder', ['u2', 0]]]) {
    assert.equal(authorizeBridgeCommand({ type: 'invoke', method, args, auth: dmAuth('u2') }, opts).code, 'feature_disabled', method);
  }
  assert.equal(authorizeBridgeCommand({ type: 'invoke', method: 'createReminder', args: [{ title: 'x' }, 'vip', 0], auth: dmAuth('vip') }, opts).allowed, true, 'ghi đè riêng từng người');
  assert.equal(authorizeBridgeCommand({ type: 'invoke', method: 'sendVoice', args: [{}, 'u2', 0], auth: dmAuth('u2') }, opts).allowed, true);
  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'createReminder', args: [{ title: 'x' }, 'group-1', 1], auth: publicAuth,
  }, opts).allowed, true, 'trong nhóm: bảng nhóm do plugin lo');
  const system = { actorUid: '', actorRole: 'system', sourceThreadId: '', sourceThreadType: 0, confirmed: false };
  assert.equal(authorizeBridgeCommand({ ...sendTo('u2'), auth: system }, opts).allowed, true);
});

test('nhắn riêng: không có mục dm, chưa chọn who, hoặc đọc lỗi → không chặn thêm', () => {
  for (const dmRules of [() => null, () => ({ features: {}, people: {} }), () => { throw new Error('hỏng'); }, null]) {
    assert.equal(authorizeBridgeCommand({ ...sendTo('stranger'), auth: dmAuth('stranger') }, { ownerUids: new Set(['owner-1']), dmRules }).allowed, true);
  }
});

test('history_search (spec §19.5): thành viên tra đúng hội thoại đang thao tác; nhắn riêng tôn trọng nút "history"', () => {
  const cmd = (threadId, threadType, a) => ({ type: 'history_search', threadId, threadType, query: 'x', auth: a });
  assert.deepEqual(authorizeBridgeCommand(cmd('group-1', 1, publicAuth), policyOptions), {
    allowed: true, role: 'public', code: 'allowed', category: 'read',
  });
  assert.equal(authorizeBridgeCommand(cmd('other-group', 1, publicAuth), policyOptions).code, 'cross_thread_denied');
  assert.equal(authorizeBridgeCommand(cmd('group-1', 0, publicAuth), policyOptions).code, 'cross_thread_denied');
  const system = { actorUid: '', actorRole: 'system', sourceThreadId: '', sourceThreadType: 0, confirmed: false };
  assert.equal(authorizeBridgeCommand(cmd('group-1', 1, system), policyOptions).code, 'auth_required');
  const off = dmOptions({ who: 'everyone', features: { history: false }, people: { vip: { features: { history: true } } } });
  assert.equal(authorizeBridgeCommand(cmd('u2', 0, dmAuth('u2')), off).code, 'feature_disabled');
  assert.equal(authorizeBridgeCommand(cmd('vip', 0, dmAuth('vip')), off).allowed, true);
  assert.equal(authorizeBridgeCommand(cmd('owner-1', 0, dmAuth('owner-1')), off).allowed, true, 'chủ nhân luôn được miễn');
});
