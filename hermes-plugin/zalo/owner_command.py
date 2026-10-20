"""Lệnh hệ thống chủ nhân gõ trong Zalo — phân loại, chạy, và cấp quyền cho trợ lý.

Zalo không có terminal: chủ nhân nhắn ``/new``, ``hermes gateway status``,
``hermes config set security.approvals.mode smart``… trong khung chat và nhận
kết quả ngay đó. Module này là nửa Python của đường đó:

* :func:`parse` nhận diện câu lệnh và phân loại. Lệnh *đọc* và *tổng hợp*
  (``/reset``, ``/clear``, ``/memory``, ``/remember``, ``/skills``, ``hermes
  doctor``, ``sessions list``, ``gateway status``…) chạy được với mọi chủ nhân.
  Lệnh *đổi máy* — ``hermes update``, ``skills install``, ``config set``,
  ``profile create``, ``setup``, ``gateway start`` — chỉ chủ nhân chính
  (``ZALO_MAIN_OWNER``, hoặc UID đầu tiên trong ``ZALO_ALLOWED_USERS``).
* :func:`run` chuyển câu lệnh sang cầu nối Node (``owner_command``) để chạy CLI
  Hermes bằng argv, không qua shell, rồi trả kết quả đã cắt ANSI/ẩn bí mật.
* :func:`slash_admins` cho gateway biết ai được gõ lệnh chủ nhân ngay trong
  Trợ lý — gateway mặc định coi mọi người trên một nền tảng đều là admin, nên
  không có đây thì thành viên nhóm gõ ``/new`` là đổi phiên của cả nhóm, và
  người ngoài trong nhóm được gõ lệnh chủ nhân. Danh sách admin của nền tảng
  không đọc lại theo thời gian nên plugin phải tự trả lời theo UID người gửi.

Chỉ chủ nhân mới tới được đây: adapter lọc người ngoài trước (nhóm chỉ
``zalo_public``, nhắn riêng theo ``ZALO_DM_POLICY``) và sidecar kiểm lại UID
lần nữa trước khi chạy.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

BRIDGE_COMMAND = "owner_command"

# Lệnh đổi máy: chỉ chủ nhân chính. Khớp đúng danh sách trong owner-commands.js.
DANGEROUS = frozenset({
    "update", "skills-install", "config-set", "profile-create", "setup",
    "gateway-start", "gateway-setup",
})

_SLASH = re.compile(r"^/(?P<cmd>[A-Za-z_-]+)(?P<rest>[^/\S].*)?$", re.DOTALL)
_MODEL_ID = re.compile(r"^[A-Za-z0-9._:/@+~-]+$")
_PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_CONFIG_KEY = re.compile(r"^[A-Za-z0-9._-]+$")
# `/skills` nhận tên skill có dấu cách; những thứ khác chỉ nhận một định danh.
_IDENT = re.compile(r"^[A-Za-z0-9._:/@+~-]+$")
_QUERY = re.compile(r"^[A-Za-z0-9._/@:+~ -]+$")

USAGE: Dict[str, str] = {
    "remember": "Gõ `/remember <điều cần nhớ>`.",
    "model": "Tên model không hợp lệ (chỉ chữ, số và `._:/@+~-`).",
    "skills": "Cú pháp: `hermes skills search|install|inspect|check|update <tên>`.",
    "config": "Cú pháp: `hermes config set <khoá> <giá trị>` (vd. `hermes config set security.approvals.mode smart`).",
    "profile": "Chỉ dùng được: `hermes profile list`, `hermes profile create <tên>`.",
    "gateway": "Chỉ dùng được: `hermes gateway status`, `hermes gateway start`, `hermes gateway setup`.",
    "sessions": "Chỉ dùng được: `hermes sessions list [số]`.",
    "resume": ("Hermes không có `sessions resume`: mở lại phiên là `hermes --resume <id>` trong terminal.\n"
               "Xem mã phiên bằng `hermes sessions list`; tách phiên mới cho hội thoại này bằng `/new`."),
}


@dataclass(frozen=True)
class OwnerCommand:
    """Một câu lệnh đã nhận diện. ``command`` rỗng khi đây là câu hướng dẫn (``usage``)."""

    command: str
    display: str
    usage: str = ""

    @property
    def dangerous(self) -> bool:
        return self.command in DANGEROUS


def parse(text: str) -> Optional[OwnerCommand]:
    """Nhận diện câu lệnh chủ nhân. ``None`` nghĩa là tin thường — để trợ lý trả lời.

    Câu hướng dẫn (gõ sai cú pháp) trả ``OwnerCommand`` với ``usage`` có nội dung:
    bot trả đúng câu đó thay vì đẩy tin sang mô hình.
    """
    raw = (text or "").strip()
    # Bỏ tag bot đứng trước ("@Bot /new") — adapter đã bỏ phần tag, đây là lớp đệm
    # cho câu người dùng gõ tay.
    while raw.startswith("@"):
        head, _, tail = raw.partition(" ")
        if not head:
            break
        raw = tail.strip()

    if raw.startswith("/"):
        match = _SLASH.match(raw)
        if not match:
            return None
        cmd = match.group("cmd").lower()
        rest = (match.group("rest") or "").strip()
        args = rest.split() if rest else []
        if cmd in ("new", "reset"):
            return OwnerCommand(cmd, f"/{cmd}")
        if cmd == "clear":
            # Zalo không có màn hình để xoá: /clear ở đây là mở phiên mới.
            return OwnerCommand("new", "/clear")
        if cmd == "stop":
            return OwnerCommand("stop", "/stop")
        if cmd == "memory":
            return OwnerCommand("memory", f"/memory{' ' + rest if rest else ''}")
        if cmd == "remember":
            return OwnerCommand("remember", "/remember") if rest else OwnerCommand("", "", USAGE["remember"])
        if cmd == "model":
            if not rest:
                return OwnerCommand("model-list", "/model")
            if not _MODEL_ID.match(rest):
                return OwnerCommand("", "", USAGE["model"])
            return OwnerCommand("model-set", f"/model {rest}")
        if cmd == "skills":
            head = (args[0] if args else "list").lower()
            if not rest or head == "list":
                return OwnerCommand("skills-list", "/skills")
            if head not in ("search", "install", "inspect", "check", "update"):
                return OwnerCommand("", "", USAGE["skills"])
            return parse(f"hermes skills {rest}")
        # /help, /usage, /whoami… là lệnh của Hermes: để gateway tự xử lý.
        return None

    words = raw.split()
    if not words or words[0].lower() != "hermes":
        return None
    return _parse_hermes(words[1:])


def _parse_hermes(args: List[str]) -> Optional[OwnerCommand]:
    if args and args[0] in ("--profile", "-p"):
        name = args[1] if len(args) > 1 else ""
        rest = args[2:]
        if not _PROFILE.match(name):
            return OwnerCommand("", "", "Tên profile không hợp lệ (chữ thường, số, `-`, `_`).")
        inner = _parse_hermes(rest)
        if inner is None or not inner.command:
            return OwnerCommand("", "", "Sau `--profile <tên>` chỉ dùng được lệnh chỉ đọc: "
                                         "`hermes doctor`, `status`, `sessions list`, `skills check`, `gateway status`.")
        return OwnerCommand(inner.command, f"hermes --profile {name} {' '.join(rest)}")

    if not args:
        return None
    head = args[0].lower()
    rest = args[1:]
    sub = rest[0] if rest else ""
    detail = " ".join(rest[1:]).strip()

    if head in ("status", "doctor"):
        return OwnerCommand(head, f"hermes {head}")
    if head == "setup":
        return OwnerCommand("setup", "hermes setup")
    if head == "update":
        return OwnerCommand("update", "hermes update")
    if head == "model":
        if not rest:
            return OwnerCommand("", "", "Chọn model: `/model <tên>` hoặc `model list`.")
        target = " ".join(rest).strip()
        if sub == "list":
            return OwnerCommand("model-list", "hermes model list")
        if not _MODEL_ID.match(target):
            return OwnerCommand("", "", USAGE["model"])
        return OwnerCommand("model-set", f"hermes model {target}")
    if head == "sessions":
        if sub in ("", "list"):
            return OwnerCommand("sessions-list", "hermes sessions list")
        if sub == "resume":
            return OwnerCommand("", "", USAGE["resume"])
        return OwnerCommand("", "", USAGE["sessions"])
    if head == "profile":
        if sub == "list":
            return OwnerCommand("profile-list", "hermes profile list")
        if sub == "create":
            name = rest[1] if len(rest) > 1 else ""
            if not _PROFILE.match(name):
                return OwnerCommand("", "", USAGE["profile"])
            return OwnerCommand("profile-create", f"hermes profile create {name}")
        return OwnerCommand("", "", USAGE["profile"])
    if head == "gateway":
        if sub in ("status", "start", "setup"):
            return OwnerCommand(f"gateway-{sub}", f"hermes gateway {sub}")
        return OwnerCommand("", "", USAGE["gateway"])
    if head == "skills":
        action = sub.lower() or "list"
        if action == "list":
            return OwnerCommand("skills-list", "hermes skills list")
        if action in ("check", "update", "audit"):
            if detail and not _IDENT.match(detail):
                return OwnerCommand("", "", USAGE["skills"])
            return OwnerCommand(f"skills-{action}", f"hermes skills {action}{' ' + detail if detail else ''}")
        if action in ("search", "inspect"):
            if not detail or not _QUERY.match(detail):
                return OwnerCommand("", "", USAGE["skills"])
            return OwnerCommand(f"skills-{action}", f"hermes skills {action} {detail}")
        if action == "install":
            if not detail:
                return OwnerCommand("", "", "Cú pháp: `hermes skills install <tên> [--force]`.")
            name = re.sub(r"\s*--force\s*", " ", detail).strip() or detail.replace("--force", "").strip()
            if not _IDENT.match(name):
                return OwnerCommand("", "", "Tên hoặc link skill không hợp lệ.")
            return OwnerCommand("skills-install", f"hermes skills install {name}{' --force' if '--force' in detail.split() else ''}")
        return OwnerCommand("", "", USAGE["skills"])
    if head == "config":
        key = rest[1] if len(rest) > 1 else ""
        value = " ".join(rest[2:]).strip() if len(rest) > 2 else ""
        if sub != "set" or not _CONFIG_KEY.match(key) or not value:
            return OwnerCommand("", "", USAGE["config"])
        if not re.match(r"^[A-Za-z0-9._/:,-]+$", value):
            return OwnerCommand("", "", "Giá trị chỉ nhận chữ, số và `._/:,-`; khoảng trắng phải thay bằng dấu gạch dưới.")
        return OwnerCommand("config-set", f"hermes config set {key} {value}")
    return None


def owners() -> List[str]:
    """UID chủ nhân (``ZALO_ALLOWED_USERS``), đọc mỗi lần gọi.

    Adapter đã chép ``.env`` vào ``os.environ`` khi tệp đổi (live_settings), nên
    người vừa được thêm vào danh sách dùng được ngay, không phải khởi động lại.
    """
    raw = os.getenv("ZALO_ALLOWED_USERS", "") or ""
    out: List[str] = []
    for part in re.split(r"[,\s]+", raw):
        part = part.strip()
        # UID Zalo: 17–21 chữ số, không bắt đầu bằng 0 (số điện thoại thì ngược lại).
        if re.fullmatch(r"[1-9]\d{16,20}", part):
            out.append(part)
    return out


def main_owner() -> str:
    """UID chủ nhân chính: ``ZALO_MAIN_OWNER`` nếu có trong danh sách, không thì người đầu tiên."""
    current = owners()
    pinned = (os.getenv("ZALO_MAIN_OWNER", "") or "").strip()
    if pinned and pinned in current:
        return pinned
    return current[0] if current else ""


def role_for(sender_uid: str) -> Optional[str]:
    """``'main'`` / ``'owner'`` cho chủ nhân; ``None`` cho người khác."""
    uid = str(sender_uid or "")
    if uid not in owners():
        return None
    return "main" if uid == main_owner() else "owner"


def slash_admins(sender_uid: str) -> List[str]:
    """Danh sách admin gõ được lệnh Hermes cho gateway (``allow_admin_from``).

    Rỗng với người ngoài: họ chỉ còn ``/help`` và ``/whoami``. Ngay trong Trợ lý
    cũng không mở thêm gì — mọi lệnh đổi máy đi qua module này, nơi danh sách
    nguy hiểm nằm trong câu lệnh.
    """
    uid = str(sender_uid or "")
    return [uid] if uid in owners() else []


async def _request(bridge: Any, text: str, *, role: str, timeout: float) -> Any:
    """Gửi câu lệnh qua cầu nối, dùng đúng cửa có sẵn trên adapter.

    Hai tên đều tồn tại tuỳ bản: ``owner_command()`` là hàm chuyên dụng của adapter
    (một tham số ``role``), còn ``request()`` là cửa chung. Trước đây chỉ gọi
    ``request`` nên trên bản adapter có ``owner_command`` thì lệnh chủ nhân chết với
    ``'ZaloAdapter' object has no attribute 'request'`` (log 20/10 23:56:58).
    """
    dedicated = getattr(bridge, "owner_command", None)
    if callable(dedicated):
        return await dedicated(str(text), role=str(role))
    request = getattr(bridge, "request", None)
    if callable(request):
        return await request(BRIDGE_COMMAND, text=str(text), role=role, timeout=timeout)
    raise AttributeError("adapter không có owner_command() hay request()")


async def run(bridge: Any, text: str, *, role: str, timeout: float = 90.0) -> Dict[str, Any]:
    """Chạy câu lệnh qua cầu nối. Không ném lỗi: mọi trục trặc thành ``reply``.

    ``owner_command()`` của adapter trả nguyên khung ``ack`` của sidecar
    (``{"type": "ack", "ok": true, "result": {...}}``), không trả thẳng kết quả
    như cửa ``request()``. Trả khung đó cho người gọi thì adapter đọc
    ``reply`` ở cấp ngoài, không thấy gì, và chủ nhân nhận "(không có kết quả)"
    sau mỗi lần gõ ``/new`` (log 21/10 00:09–00:15). Gỡ đúng một lớp ``result``.
    """
    try:
        result = await _request(bridge, text, role=role, timeout=timeout)
    except Exception as exc:  # cầu nối chưa nối / quá hạn / lỗi giao thức
        logger.warning("[zalo] không chạy được lệnh chủ nhân %r: %s", text[:80], exc)
        return {"reply": f"⚠️ Không chạy được lệnh: {exc}", "handled": True}
    if not isinstance(result, dict):
        return {"reply": "⚠️ Cầu nối trả về kết quả không đọc được.", "handled": True}
    if result.get("type") == "ack":
        if result.get("ok") is False:
            reason = result.get("error") or result.get("errorCode") or "không rõ lý do"
            logger.warning("[zalo] cầu nối từ chối lệnh chủ nhân %r: %s", text[:80], reason)
            return {"reply": f"⚠️ Cầu nối từ chối lệnh: {reason}", "handled": True, "denied": True}
        payload = result.get("result")
        if not isinstance(payload, dict):
            return {"reply": "⚠️ Cầu nối trả về kết quả không đọc được.", "handled": True}
        return payload
    return result


__all__ = [
    "BRIDGE_COMMAND", "DANGEROUS", "OwnerCommand", "main_owner", "owners", "parse",
    "role_for", "run", "slash_admins",
]
