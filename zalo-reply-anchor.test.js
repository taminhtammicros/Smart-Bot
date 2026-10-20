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
  assert.notEqual(quoteForAsk('g1', ThreadType.Group, 'u1', 1_000 + 30 * 60 * 1000 - 1), null);

  forgetQuestions();
  rememberQuestion(ask(), 1_000);
  assert.equal(quoteForAsk('g1', ThreadType.Group, 'u1', 1_000 + 30 * 60 * 1000 + 1), null);
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
