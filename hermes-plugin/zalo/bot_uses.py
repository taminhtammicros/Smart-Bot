"""Sổ lượt dùng bot: mỗi lượt bot thực sự nhận xử lý (đã qua mọi bộ lọc: được tag, nhóm bật, được nhắn riêng…) ghi một
dòng JSON vào ``<HERMES_HOME>/zalo/bot-uses.jsonl`` — ``{"t": ms, "uid", "name", "thread", "group": bool, "owner": bool}``.

Dashboard (Tổng quan › Người dùng bot) đếm lượt trong nhóm / nhắn riêng và xếp hạng người dùng nhiều nhất. Giữ 40 ngày:
mỗi ngày dọn một lần. Cố hết sức — ghi lỗi thì bỏ qua, không bao giờ làm hỏng lượt trả lời.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

KEEP_DAYS = 40
_lock = threading.Lock()
_state = {"pruned_day": None}


def log_path() -> Path:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes")
    return home / "zalo" / "bot-uses.jsonl"


def _prune(path: Path, now_ms: int) -> None:
    cutoff = now_ms - KEEP_DAYS * 86_400_000
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    kept = []
    for line in lines:
        try:
            if int(json.loads(line).get("t") or 0) >= cutoff:
                kept.append(line)
        except (ValueError, AttributeError):
            continue
    if len(kept) == len(lines):
        return
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("".join(f"{line}\n" for line in kept), encoding="utf-8")
    os.replace(tmp, path)


def record(uid: str, name: str, thread_id: str, is_group: bool, is_owner: bool,
           *, now: Optional[float] = None, path: Optional[Path] = None) -> None:
    now_ms = int((now if now is not None else time.time()) * 1000)
    target = path or log_path()
    row = {"t": now_ms, "uid": str(uid or ""), "name": " ".join(str(name or "").split())[:80],
           "thread": str(thread_id or ""), "group": bool(is_group), "owner": bool(is_owner)}
    try:
        with _lock:
            target.parent.mkdir(parents=True, exist_ok=True)
            day = now_ms // 86_400_000
            if _state["pruned_day"] != day and target.exists():
                _state["pruned_day"] = day
                _prune(target, now_ms)
            with target.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        logger.debug("[zalo] không ghi được sổ lượt dùng bot", exc_info=True)
