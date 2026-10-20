import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadType } from 'zca-js';
import { rememberQuestion, quoteForAsk, forgetQuestions } from './zalo-reply-anchor.js';

const ask = (over = {}) => ({
  threadId: 'g1',
  type: ThreadType.Group,
  isSelf: false,
  data: {
    msgId: 'm1', cliMsgId: 'c1', uidFrom: 'u1', dName: 'Liên', content: 'Cho em hỏi bài này', ts: 1000,
    ...over,
  },
});
const askFrom = (uid, over = {}) => ask({ uidFrom: uid, ...over });

test('câu trả lời cho đúng người hỏi trích dẫn đúng tin của họ', () => {
  forgetQuestions();
  assert.equal(rememberQuestion(ask()), true);

  assert.deepEqual(quoteForAsk('g1', ThreadType.Group, 'u1'), {
    content: 'Cho em hỏi bài này',
    msgType: 'webchat',
    propertyExt: undefined,
    ttl: 0,
    ts: 1000,
    msgId: 'm1',
    cliMsgId: 'c1',
    uidFrom: 'u1',
  });
});

test('người khác trong cùng nhóm không kéo theo câu hỏi của người đã hỏi', () => {
  forgetQuestions();
  rememberQuestion(ask());
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u2'), null);
  assert.equal(quoteForAsk('g1', ThreadType.Group, ''), null);
});

test('hai người hỏi chen nhau thì mỗi người có neo riêng, người sau không ghi đè người trước', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm1', content: 'câu của Liên' }));
  rememberQuestion(askFrom('u2', { msgId: 'm2', dName: 'Trang', content: 'câu của Trang' }));

  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1').msgId, 'm1');
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u2').msgId, 'm2');
});

test('cùng một người hỏi lại thì neo lấy câu mới nhất', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm1', content: 'câu cũ' }));
  rememberQuestion(ask({ msgId: 'm2', content: 'câu mới' }));

  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1').msgId, 'm2');
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1').content, 'câu mới');
});

test('neo sống suốt lượt trả lời: nhiều lệnh gửi liên tiếp đều trích cùng câu hỏi', () => {
  forgetQuestions();
  rememberQuestion(ask());

  const first = quoteForAsk('g1', ThreadType.Group, 'u1');
  const second = quoteForAsk('g1', ThreadType.Group, 'u1');
  assert.equal(first.msgId, 'm1');
  assert.deepEqual(second, first);
});

test('tin đính kèm, nhãn dán, tin rỗng và tin của chính bot không thành neo', () => {
  forgetQuestions();
  assert.equal(rememberQuestion(ask({ content: { title: 'link', href: 'https://x' } })), false);
  assert.equal(rememberQuestion(ask({ content: { id: 4001 } })), false);
  assert.equal(rememberQuestion(ask({ content: '   ' })), false);
  assert.equal(rememberQuestion(ask({ msgId: '' })), false);
  assert.equal(rememberQuestion({ ...ask(), isSelf: true }), false);
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1'), null);
});

test('neo cũ quá hạn thì không trích dẫn nữa', () => {
  forgetQuestions();
  rememberQuestion(ask(), 1_000);
  assert.notEqual(quoteForAsk('g1', ThreadType.Group, 'u1', { now: 1_000 + 30 * 60 * 1000 - 1 }), null);

  forgetQuestions();
  rememberQuestion(ask(), 1_000);
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { now: 1_000 + 30 * 60 * 1000 + 1 }), null);
});

test('neo tách theo hội thoại: nhóm và nhắn riêng không lẫn nhau', () => {
  forgetQuestions();
  rememberQuestion({ ...ask(), threadId: 'u1', type: ThreadType.User });
  assert.equal(quoteForAsk('u1', ThreadType.User, 'u1').msgId, 'm1');
  assert.equal(quoteForAsk('u1', ThreadType.Group, 'u1'), null);
});

test('thiếu cliMsgId thì dùng msgId, Zalo vẫn nhận khung trích dẫn', () => {
  forgetQuestions();
  rememberQuestion(ask({ cliMsgId: '' }));
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1').cliMsgId, 'm1');
});

test('forgetQuestions xoá sạch neo khi đổi phiên', () => {
  forgetQuestions();
  rememberQuestion(ask());
  forgetQuestions();
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1'), null);
});

test('hỏi dồn: câu trả lời của Q1 vẫn trích Q1 dù Q2, Q3 đã tới', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm1', content: 'câu 1' }));
  rememberQuestion(ask({ msgId: 'm2', content: 'câu 2' }));
  rememberQuestion(ask({ msgId: 'm3', content: 'câu 3' }));

  // Lượt trả lời Q1 mang mã tin m1 (adapter gắn vào auth.msgId).
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgId: 'm1' }).msgId, 'm1');
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgId: 'm1' }).content, 'câu 1');
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgId: 'm2' }).msgId, 'm2');
  // Không có mã tin thì vẫn là hành vi cũ: câu mới nhất của người đó.
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1').msgId, 'm3');
});

test('mã tin không tra được thì không trích dẫn, không lùi về câu mới nhất', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm1', content: 'câu 1' }));
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgId: 'm-out-of-range' }), null);
});

test('mã tin của người khác không kéo theo neo của người đó', () => {
  forgetQuestions();
  rememberQuestion(askFrom('u2', { msgId: 'm2', content: 'câu của Trang' }));
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgId: 'm2' }), null);
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u2', { msgId: 'm2' }).msgId, 'm2');
});

test('neo theo mã tin cũng hết hạn sau 30 phút', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm1' }), 1_000);
  assert.notEqual(
    quoteForAsk('g1', ThreadType.Group, 'u1', { msgId: 'm1', now: 1_000 + 30 * 60 * 1000 - 1 }), null);
  assert.equal(
    quoteForAsk('g1', ThreadType.Group, 'u1', { msgId: 'm1', now: 1_000 + 30 * 60 * 1000 + 1 }), null);
});

test('neo theo mã tin tách theo hội thoại', () => {
  forgetQuestions();
  rememberQuestion({ ...ask(), threadId: 'u1', type: ThreadType.User, data: { ...ask().data, msgId: 'm1' } });
  assert.equal(quoteForAsk('u1', ThreadType.User, 'u1', { msgId: 'm1' }).msgId, 'm1');
  assert.equal(quoteForAsk('u1', ThreadType.Group, 'u1', { msgId: 'm1' }), null);
});

test('cụm tin gộp: trích tin ĐẦU dù Hermes ghi đè hay giữ mã tin cuối', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm1', content: 'câu 1' }));
  rememberQuestion(ask({ msgId: 'm3', content: 'câu 3' }));

  // Nhánh debounce: message_id bị ghi đè bằng tin cuối, nhưng adapter gom đủ
  // dãy nên sidecar vẫn chọn tin đầu.
  const fromDebounce = quoteForAsk('g1', ThreadType.Group, 'u1', { msgIds: ['m1', 'm3'], msgId: 'm3' });
  assert.equal(fromDebounce.msgId, 'm1');
  assert.equal(fromDebounce.content, 'câu 1');

  // Nhánh gộp giữ mã tin đầu thì kết quả không đổi.
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgIds: ['m1', 'm3'] }).msgId, 'm1');
});

test('cụm tin gộp: tin đầu không còn neo thì lấy tin sau, không nhảy sang người khác', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm3', content: 'câu 3' }));
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgIds: ['m1', 'm3'] }).msgId, 'm3');
  // Cả dãy không tra được thì không trích, kể cả khi người đó có neo khác.
  rememberQuestion(ask({ msgId: 'm5', content: 'câu 5' }));
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgIds: ['m1', 'm3'] }).msgId, 'm3');
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgIds: ['m-gone'] }), null);
});

test('danh sách mã tin rỗng thì rơi về neo theo người như trước', () => {
  forgetQuestions();
  rememberQuestion(ask({ msgId: 'm1', content: 'câu 1' }));
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', { msgIds: [], msgId: '' }).msgId, 'm1');
});
