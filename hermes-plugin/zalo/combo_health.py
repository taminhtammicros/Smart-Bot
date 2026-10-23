"""Sức khoẻ của combo trên cổng AI: combo nào đang chết thì đừng ghim vào, và biết đường về model chung.

Vì sao cần: mỗi nhóm ghim một combo (``permissions.json`` › ``modelOverride``). Cổng AI (9router) tự chuyển
model ruột BÊN TRONG combo, nhưng combo chỉ có **một** model ruột thì model đó chết là cả combo chết — bot
im lặng cho tới khi có người nhận ra. Module này giữ bộ nhớ ngắn hạn về combo vừa lỗi để:

1. ``is_down(name)`` — adapter biết combo nhóm ghim đang chết, chủ động bỏ ghim (rơi về model chung) thay vì
   gửi request vào chỗ đã biết là hỏng rồi bắt người dùng chờ hết các lần thử.
2. ``note_result(...)`` — ghi nhận kết quả mỗi lượt: lỗi thì cho combo "nghỉ" một lúc (như ``key_pool`` cho
   khoá nghỉ), thành công thì xoá ngay. Combo tự hồi vì cổng AI có thể được sửa bất cứ lúc nào.

Vì sao KHÔNG tự đổi model sang combo khác: người dùng đã chọn combo cho nhóm đó. Tự ý chạy model họ không
chọn còn tệ hơn việc bot chậm một nhịp — nên ở đây chỉ có "dùng model chung như khi nhóm chưa ghim gì".

Lỗi nào tính là combo chết: khác 2xx, và không phải lỗi phía người dùng (400/413/422 — sai dữ liệu gửi
lên thì đổi model cũng vô ích, và tránh đánh dấu oan một combo tốt chỉ vì một lượt hỏng nội dung).
"""

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Combo lỗi thì nghỉ bao lâu. Đủ ngắn để cổng AI sửa xong là bot tự quay lại combo của nhóm ở lần chat sau,
# đủ dài để một chuỗi lỗi không bắt mọi tin của nhóm chờ hết các lần thử.
COOL_SECONDS = 300
# Lỗi "hết đường" (combo rỗng, model ruột bị khai tử, không có khoá nào dùng được): nghỉ lâu hơn — sửa được thì
# phải vào cổng AI đổi cấu hình, không phải chuyện vài phút.
COOL_HARD_SECONDS = 3600
# Chỉ giữ chừng này combo trong bộ nhớ, tệp phân quyền giới hạn 500 nhóm nên đây là mức dư dùng.
MAX_ENTRIES = 600
# Lỗi phía NGƯỜI DÙNG: đổi model không giúp gì, và đánh dấu oan sẽ làm hụt tính năng đang chạy tốt.
FATAL_BUT_REQUEST = (400, 413, 422)
# Lỗi cho thấy combo hỏng hẳn (không phải quá tải nhất thời) — nghỉ lâu.
HARD_PATTERN = re.compile(
    r"modeldeprecated|model is unavailable|model_not_found|not found|no active credentials|"
    r"does not exist|unknown model|invalid[ _-]?model|không có model|no model",
    re.I,
)


class ComboHealth:
    """Bộ nhớ trong tiến trình: combo nào vừa lỗi, nghỉ tới lúc nào. Chỉ đọc/ghi RAM, không tốn I/O."""

    def __init__(self, clock=time.monotonic, cool_s: float = COOL_SECONDS,
                 cool_hard_s: float = COOL_HARD_SECONDS, max_entries: int = MAX_ENTRIES) -> None:
        self._clock = clock
        self._cool_s = cool_s
        self._cool_hard_s = cool_hard_s
        self._max = max_entries
        self._until: Dict[str, float] = {}
        self._why: Dict[str, str] = {}
        self._lock = threading.Lock()

    def is_down(self, model) -> bool:
        """Combo/model này đang trong thời gian nghỉ? Không tên nào → False (không có gì để nói)."""
        name = str(model or "").strip()
        if not name:
            return False
        now = self._clock()
        with self._lock:
            until = self._until.get(name)
            if until is None:
                return False
            if until <= now:
                self._until.pop(name, None)
                self._why.pop(name, None)
                return False
            return True

    def reason(self, model) -> str:
        """Câu ngắn vì sao đang nghỉ (để ghi log), ``""`` khi không có."""
        with self._lock:
            return self._why.get(str(model or "").strip(), "")

    @staticmethod
    def is_combo_error(exc: Any) -> bool:
        """Lỗi này có nghĩa "combo không dùng được" (khác lỗi phía người dùng)?

        Nhận cả ngoại lệ có ``status_code``/``statusCode`` lẫn chuỗi thông báo — Hermes bọc lỗi cổng AI theo
        nhiều kiểu, và lỗi 503 của 9router thường mang nguyên văn thông báo của provider ruột ở trong.
        """
        if exc is None:
            return False
        code = None
        for attr in ("status_code", "statusCode", "status", "code"):
            value = getattr(exc, attr, None)
            if isinstance(value, int):
                code = value
                break
        if code is not None:
            if code in FATAL_BUT_REQUEST:
                return False
            return code >= 500 or code in (402, 403, 404, 408, 429)
        text = str(exc)
        if re.search(r"\b(400|413|422)\b", text):
            return False
        return bool(re.search(r"\b(402|403|404|408|429|5\d\d)\b|timeout|timed out|unavailable|connection|"
                              r"connect|refused|overloaded", text, re.I))

    def note_result(self, model, exc: Optional[Any] = None, *, ok: bool = False) -> None:
        """Ghi kết quả một lượt gọi cổng AI cho combo ``model``.

        Thành công → xoá ngay (combo sống lại tức thì). Lỗi không liên quan combo → không đụng gì. Lỗi combo →
        cho nghỉ ``cool_s``, hoặc ``cool_hard_s`` nếu thông báo cho thấy hỏng hẳn.
        """
        name = str(model or "").strip()
        if not name:
            return
        if ok:
            with self._lock:
                if self._until.pop(name, None) is not None:
                    self._why.pop(name, None)
                    logger.info("[zalo] combo %s đã trả lời được — bỏ ghim nghỉ", name)
            return
        if not self.is_combo_error(exc):
            return
        text = str(exc)
        cool = self._cool_hard_s if HARD_PATTERN.search(text) else self._cool_s
        now = self._clock()
        with self._lock:
            if len(self._until) >= self._max:
                # Bỏ mục cũ nhất (hết hạn trước) để bộ nhớ không phình theo thời gian chạy.
                oldest = min(self._until, key=self._until.get)
                self._until.pop(oldest, None)
                self._why.pop(oldest, None)
            self._until[name] = now + cool
            self._why[name] = text[:200]
        logger.warning("[zalo] combo %s lỗi — nghỉ %d giây rồi thử lại: %s", name, int(cool), text[:200])

    def snapshot(self) -> Dict[str, Dict[str, Any]]:
        """Trạng thái hiện tại cho dashboard: ``{combo: {"seconds_left": n, "reason": "..."}}``."""
        now = self._clock()
        with self._lock:
            out = {}
            for name, until in self._until.items():
                left = int(until - now)
                if left > 0:
                    out[name] = {"seconds_left": left, "reason": self._why.get(name, "")}
            return out


def load_combo_health(path: Optional[Path] = None) -> ComboHealth:
    """Bộ nhớ dùng chung cho tiến trình gateway (một instance cho mọi hội thoại)."""
    global _HEALTH
    if _HEALTH is None:
        _HEALTH = ComboHealth()
    return _HEALTH


_HEALTH: Optional[ComboHealth] = None