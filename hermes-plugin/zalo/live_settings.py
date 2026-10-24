"""Áp dụng cài đặt ở trang Cấu hình của dashboard NGAY, không cần khởi động lại trợ lý.

Gateway của Hermes chỉ đọc ``.env`` một lần lúc khởi động. Adapter gọi :meth:`SettingsWatcher.poll` khi có tin tới
(tối đa mỗi vài giây một lần): nếu ``<HERMES_HOME>/.env`` hoặc ``config.yaml`` vừa đổi thì
  - chép lại đúng các khoá trong ``HOT_KEYS`` (không bao giờ khoá bí mật) từ ``.env`` vào ``os.environ`` —
    công cụ đọc ``os.environ`` mỗi lần gọi (xác nhận thao tác nguy hiểm, kho tài liệu mở, MCP mở cho thành viên);
  - trả ``platforms.zalo.extra`` mới để adapter đặt lại các thuộc tính của nó (chỉ trả lời khi tag, nhắn riêng,
    báo đã xem, thả cảm xúc, nhóm chỉ chủ nhân, chống nhắn dồn, số tin xem lại tìm ảnh).
Khoá đã biến khỏi ``.env`` (chọn lại mặc định trên dashboard) thì bỏ khỏi ``os.environ`` — chỉ khi chính tệp này
đã đặt nó trước đó, không đụng biến hệ thống đặt từ ngoài.
"""

import logging
import os
import time
from pathlib import Path
from typing import Callable, Dict, Optional, Set, Tuple

logger = logging.getLogger(__name__)

HOT_KEYS = (
    "ZALO_GROUP_REPLY_ONLY_TAGGED", "ZALO_DM_POLICY", "ZALO_ACK_GESTURES", "ZALO_AUTO_REACT",
    "ZALO_OWNER_ONLY_GROUPS", "ZALO_FLOOD_THRESHOLD", "ZALO_FLOOD_WINDOW_S", "ZALO_FLOOD_MUTE_S",
    "ZALO_MEDIA_LOOKBACK", "ZALO_CONFIRM_DANGEROUS", "ZALO_PUBLIC_MCP",
    "ZALO_SOUL_REMINDER",
    # Ai là chủ nhân bot và ai là chủ nhân chính — dashboard sửa xong là có hiệu lực
    # ở tin kế tiếp, không phải khởi động lại kết nối Zalo (adapter và cầu nối đều
    # đọc os.environ mỗi lượt).
    "ZALO_ALLOWED_USERS", "ZALO_MAIN_OWNER",
)


def parse_env(text: str) -> Dict[str, str]:
    """``KEY=VALUE`` / ``export KEY=VALUE`` (bỏ nháy, bỏ dòng chú thích) — đủ cho .env của Hermes."""
    out: Dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


class SettingsWatcher:
    def __init__(self, home: Callable[[], Path], interval_s: float = 3.0, clock: Callable[[], float] = time.monotonic):
        self._home = home
        self._interval = interval_s
        self._clock = clock
        self._next = 0.0
        self._stamp: Optional[Tuple[float, float]] = None
        self._from_file: Set[str] = set()

    def _paths(self) -> Tuple[Path, Path]:
        home = self._home()
        return home / ".env", home / "config.yaml"

    @staticmethod
    def _mtime(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:
            return 0.0

    def poll(self, force: bool = False) -> Tuple[bool, Optional[Dict]]:
        """(đã đổi?, extra mới). extra = None khi không đọc được config.yaml (giữ extra cũ).

        Chưa tới lượt, tệp không đổi, hoặc lần đầu (chỉ ghi nhận) → (False, None).
        """
        now = self._clock()
        if not force and now < self._next:
            return False, None
        self._next = now + self._interval
        try:
            env_path, cfg_path = self._paths()
        except Exception:
            return False, None
        stamp = (self._mtime(env_path), self._mtime(cfg_path))
        first = self._stamp is None
        if stamp == self._stamp:
            return False, None
        self._stamp = stamp
        try:
            env = parse_env(env_path.read_text(encoding="utf-8-sig")) if stamp[0] else {}
        except OSError:
            env = {}
        present = {k for k in HOT_KEYS if k in env}
        if first:
            # Lần đầu chỉ ghi nhận: gateway vừa nạp .env lúc khởi động, cấu hình đang dùng đã đúng.
            self._from_file = present
            return False, None
        for key in HOT_KEYS:
            if key in env:
                os.environ[key] = env[key]
            elif key in self._from_file:
                os.environ.pop(key, None)
        self._from_file = present
        extra: Optional[Dict] = {}
        try:
            import yaml
            cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) if stamp[1] else {}
            zalo = ((cfg or {}).get("platforms") or {}).get("zalo") or {}
            extra = zalo.get("extra") or {}
            if not isinstance(extra, dict):
                extra = {}
        except Exception:
            extra = None
            logger.warning("[zalo] không đọc lại được config.yaml — chỉ áp dụng phần .env", exc_info=True)
        logger.info("[zalo] cấu hình vừa đổi — đã áp dụng ngay, không cần khởi động lại")
        return True, extra
