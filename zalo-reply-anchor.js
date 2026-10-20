/**
 * Neo trả lời: nhớ tin nhắn của NGƯỜI HỎI để câu trả lời trích dẫn (quote) đúng
 * tin đó.
 *
 * Vì sao cần: trước đây câu trả lời là một tin trôi nổi trong hội thoại. Trong
 * nhóm đông người, bot trả lời xong một câu mà không ai biết nó đang trả lời
 * ai; còn khi hai người hỏi chen nhau thì câu trả lời nằm sai luồng. Zalo có
 * sẵn cơ chế trích dẫn: khung tin mang `uidFrom` + `msgId`, và Zalo tự hiển thị
 * tên người được trích dẫn theo UID đó — đúng tên người hỏi, kể cả khi họ đổi
 * tên hiển thị sau này, chứ không phải chép tên vào nội dung như một câu chữ.
 *
 * Hai tầng dùng chung tệp này:
 *   - bot-handler.js gọi `rememberQuestion` cho mỗi tin nhắn tới (người hỏi).
 *   - hermes-bridge.js gọi `quoteForAsk` khi gửi câu trả lời của CHÍNH người đó.
 *
 * Neo sống tới khi chính người đó hỏi câu mới hoặc quá hạn, chứ không xoá sau
 * lần gửi đầu: một lượt trả lời của Hermes có thể đi qua nhiều lệnh `send`
 * (câu báo đang xử lý, từng đoạn của câu trả lời dài). Xoá sau lần gửi đầu thì
 * câu báo "đang xử lý" ăn mất trích dẫn và câu trả lời thật lại trôi nổi —
 * đúng thứ tệp này sinh ra để tránh.
 *
 * Chỉ nhớ tin chữ. zca-js từ chối trích dẫn `webchat` khi nội dung không phải
 * chuỗi (`This kind of webchat quote type is not available`), và trích dẫn
 * sticker/tệp cần thêm `propertyExt`/`qmsgAttach` — sai một trường là Zalo trả
 * "Lỗi không xác định" và mất cả câu trả lời. Không trích dẫn còn hơn mất tin.
 */

/** Một lượt agent có thể chạy vài phút; quá mốc này thì câu hỏi đã cũ, không neo nữa. */
const ANCHOR_TTL_MS = 30 * 60 * 1000;

/** Số người đang chờ trả lời cùng lúc có hạn; giữ đủ rộng nhưng không phình vô hạn. */
const MAX_ANCHORS = 500;

/** Khoá theo hội thoại + người hỏi: hai người hỏi chen nhau trong một nhóm vẫn có neo riêng. */
const anchors = new Map();
const keyOf = (threadId, threadType, askerUid) =>
  `${Number(threadType) === 1 ? 1 : 0}:${String(threadId ?? '')}:${String(askerUid ?? '')}`;

/**
 * Loại tin trích dẫn được. zca-js chỉ nhận `qmsg` là chuỗi cho loại `webchat`,
 * và khung trích dẫn phải khai đúng loại của tin gốc (`qmsgType`) — khai
 * `webchat` cho một tin nhãn dán là Zalo trả "Lỗi không xác định". Nên chỉ neo
 * tin chữ thật; tin khác thì không trích dẫn, còn hơn làm hỏng cả câu trả lời.
 */
const QUOTABLE_TYPES = new Set(['', 'webchat', 'chat.text']);

/** Chuỗi để trích + loại tin, hoặc null khi tin này không trích dẫn được. */
function quotableContent(msg) {
  const content = msg?.data?.content;
  if (typeof content !== 'string' || !content.trim()) return null;
  const msgType = String(msg?.data?.msgType ?? '');
  if (!QUOTABLE_TYPES.has(msgType)) return null;
  return { text: content, msgType: msgType || 'webchat' };
}

/**
 * Ghi nhớ tin vừa tới như câu hỏi đang chờ được trả lời.
 *
 * Trả về true khi đã neo được (là tin chữ, có msgId và người gửi). Tin của
 * chính bot, tin rỗng và tin đính kèm không bao giờ thành neo.
 */
export function rememberQuestion(msg, now = Date.now()) {
  if (msg?.isSelf) return false;
  const quotable = quotableContent(msg);
  if (!quotable) return false;
  const msgId = msg?.data?.msgId == null ? '' : String(msg.data.msgId);
  const cliMsgId = msg?.data?.cliMsgId == null ? '' : String(msg.data.cliMsgId);
  const uidFrom = String(msg?.data?.uidFrom ?? '');
  const threadId = String(msg?.threadId ?? '');
  if (!msgId || !threadId || !uidFrom) return false;

  const threadType = Number(msg.type) === 1 ? 1 : 0;
  const key = keyOf(threadId, threadType, uidFrom);
  anchors.delete(key);
  anchors.set(key, {
    key,
    threadId,
    threadType,
    askerUid: uidFrom,
    askerName: String(msg?.data?.dName ?? ''),
    msgId,
    // Zalo chấp nhận thiếu cliMsgId (dashboard đã dùng đường này từ trước).
    cliMsgId: cliMsgId || msgId,
    text: quotable.text,
    msgType: quotable.msgType,
    ts: Number(msg?.data?.ts) || now,
    storedAt: now,
  });
  while (anchors.size > MAX_ANCHORS) anchors.delete(anchors.keys().next().value);
  return true;
}

/**
 * Khung trích dẫn (zca-js SendMessageQuote) cho câu trả lời của `askerUid`,
 * hoặc null khi người nhận không phải người vừa hỏi.
 *
 * Chỉ trả về neo khi đúng NGƯỜI đã hỏi: lịch gửi định kỳ, thông báo hệ thống
 * hay câu trả lời cho người khác không được kéo theo câu hỏi cũ của người
 * khác — trích dẫn sai người còn tệ hơn không trích dẫn.
 */
export function quoteForAsk(threadId, threadType, askerUid, now = Date.now()) {
  const asker = String(askerUid ?? '');
  if (!asker) return null;
  const anchor = anchors.get(keyOf(threadId, threadType, asker));
  if (!anchor) return null;
  if (now - anchor.storedAt > ANCHOR_TTL_MS) {
    anchors.delete(anchor.key);
    return null;
  }
  return {
    content: anchor.text,
    msgType: anchor.msgType,
    // `undefined` giống hệt đường trích dẫn đang chạy ở dashboard: zca-js bỏ
    // trường này khỏi tham số, nên không có `qmsgAttach` lệch với tin gốc.
    propertyExt: undefined,
    ttl: 0,
    ts: anchor.ts,
    msgId: anchor.msgId,
    cliMsgId: anchor.cliMsgId,
    uidFrom: anchor.askerUid,
  };
}

/** Quên hết neo (dừng listener, đổi tài khoản) — neo cũ không được dính sang phiên mới. */
export function forgetQuestions() {
  anchors.clear();
}
