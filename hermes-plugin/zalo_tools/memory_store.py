"""Chủ nhân dặn bot nhớ / quên trí nhớ của ĐÚNG cuộc trò chuyện đang diễn ra (spec §21.7).

Phạm vi lấy từ turn (ContextVar của tools.py), KHÔNG BAO GIỜ từ tham số mô hình: nhóm → ``zalo-g-<id>``,
nhắn riêng → ``zalo-u-<uid>`` — trùng công thức của provider ``zalo_memory`` và của sidecar.

Từ 2.52.0 (spec §21) không còn OpenViking: mọi thứ ghi vào ``zalo.sqlite`` qua module provider
(``zalo_memory.remember`` / ``forget_matching`` / ``forget_ids``). Lý do đổi: OpenViking là dự án ngoài
(AGPL-3.0) và bắt mỗi máy chạy thêm một dịch vụ + nạp model — xem đầu ``zalo_memory/__init__.py``.

Chỉ chạy khi trí nhớ dài hạn đang bật (``memory.provider: zalo_memory``): thiếu thì công cụ trả câu dễ hiểu.
"""

import re
from typing import Any, Dict, List, Optional

PROVIDER = "zalo_memory"
MAX_REMEMBER_CHARS = 1000
MAX_FORGET = 5
_ID = re.compile(r"^\d{1,32}$")


class MemoryUnavailable(RuntimeError):
    """Trí nhớ dài hạn đang tắt hoặc không dùng được — câu thông báo dành cho chủ nhân."""


def scope_of_turn(turn: Dict[str, Any]) -> Optional[str]:
    """Phạm vi của lượt: nhóm → ``zalo-g-<thread>``, nhắn riêng → ``zalo-u-<thread>``; None nếu không rõ."""
    thread = str(turn.get("thread_id") or "").strip()
    if not _ID.match(thread):
        return None
    return f"zalo-g-{thread}" if turn.get("is_group") else f"zalo-u-{thread}"


def _provider_module():
    """Module provider ``zalo_memory`` đang nạp (Hermes nạp plugin người dùng dưới nhiều tên khác nhau)."""
    import sys

    def _is_provider_name(name: str) -> bool:
        if name == "plugins.memory.zalo_memory":
            return True
        if not name.startswith("_hermes_user_memory."):
            return False
        rest = name[len("_hermes_user_memory."):]
        return "." not in rest and (rest == PROVIDER or rest.startswith(PROVIDER + "__source_"))

    for name, mod in list(sys.modules.items()):
        if mod is not None and _is_provider_name(name) and getattr(mod, "PROVIDER_NAME", None) == PROVIDER:
            return mod
    return None


def _config_provider() -> str:
    try:
        from hermes_cli.config import load_config_readonly
        return str(((load_config_readonly() or {}).get("memory") or {}).get("provider") or "").strip()
    except Exception:
        return ""


def _module_or_raise():
    """Module provider, hoặc ném MemoryUnavailable kèm lý do dễ hiểu."""
    if _config_provider() != PROVIDER:
        raise MemoryUnavailable("trí nhớ dài hạn đang tắt (memory.provider chưa là zalo_memory)")
    mod = _provider_module()
    if mod is None:
        raise MemoryUnavailable("trí nhớ dài hạn đang tắt (provider zalo_memory chưa chạy)")
    if getattr(mod, "sqlite_path", lambda: None)() is None:
        raise MemoryUnavailable("chưa tìm thấy kho lịch sử của bot (ZALO_SIDECAR_ROOT trong .env của Hermes) — "
                                "chạy lại install:hermes, rồi khởi động lại gateway")
    return mod


def remember(scope: str, text: str) -> int:
    """Ghi một mẩu trí nhớ do chủ nhân dặn vào kho của ĐÚNG phạm vi; trả id."""
    body = " ".join(str(text or "").split())
    if not body:
        raise ValueError("cần nội dung cần nhớ")
    if len(body) > MAX_REMEMBER_CHARS:
        raise ValueError(f"tối đa {MAX_REMEMBER_CHARS} ký tự mỗi lần nhớ — tách thành vài ý")
    return int(_module_or_raise().remember(scope, body))


def search(scope: str, query: str) -> List[Dict[str, Any]]:
    """Ứng viên để quên trong ĐÚNG phạm vi: tối đa ``MAX_FORGET`` mục ``{id, body}``."""
    text = str(query or "").strip()[:200]
    if len(text) < 2:
        raise ValueError("cần mô tả chuyện cần quên (ít nhất 2 ký tự)")
    return list(_module_or_raise().forget_matching(scope, text, limit=MAX_FORGET))


def forget(scope: str, ids: List[Any]) -> List[int]:
    """Xoá các mẩu đã chọn. Kiểm TOÀN BỘ id trước: một id ngoài phạm vi → từ chối cả lô (không xoá gì)."""
    chosen = [str(i) for i in (ids or []) if str(i).strip().lstrip("-").isdigit()]
    if not chosen:
        raise ValueError("chưa chọn mục nào để quên")
    if len(chosen) > MAX_FORGET:
        raise ValueError(f"mỗi lần quên tối đa {MAX_FORGET} mục — chọn lại rồi gọi lại")
    try:
        return list(_module_or_raise().forget_ids(scope, [int(i) for i in chosen]))
    except ValueError:
        raise
