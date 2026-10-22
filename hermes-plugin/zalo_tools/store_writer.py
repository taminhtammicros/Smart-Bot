"""Ghi xuống kho SQLite của sidecar cho tầng 'Trợ lý biết chuyện' (spec §20.2–20.4).

Plugin Python GHI thẳng tệp `zalo.sqlite` (WAL nên đọc song song được; `busy_timeout` 5 s cùng phía sidecar
nên không deadlock). Mọi câu UPDATE/INSERT đều khoá theo `(account_id, thread_id)` của đúng hội thoại —
không bao giờ lấy từ tham số model. Kế này song hành với `store-reader.js` của dashboard (chỉ đọc).
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from .brain_jobs import sqlite_path

SCOPE_RE = re.compile(r"^zalo-(g|u)-\d{1,32}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_VN = timezone(timedelta(hours=7))
PROFILE_MAX_CHARS = 2000   # cùng trần với `PROFILE_MAX_CHARS` trong zalo-store.js


def _now() -> int:
    return int(time.time() * 1000)


def _scope_for(thread_id: str, thread_type: int) -> str:
    return f"zalo-g-{thread_id}" if thread_type == 1 else f"zalo-u-{thread_id}"


def _connect() -> Optional[sqlite3.Connection]:
    path = sqlite_path()
    if path is None or not path.exists():
        return None
    con = sqlite3.connect(str(path), timeout=5)
    con.execute("PRAGMA busy_timeout = 5000")
    con.row_factory = sqlite3.Row
    return con



def package_topic(account_id: str, thread_id: str, thread_type: int, title: str, summary: str, ids: set) -> bool:
    """Mở topic mới cho hội thoại rồi gán tin đã chọn. Nếu hội thoại đã có topic 'open' thì bỏ qua (im)."""
    con = _connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT topic_id FROM topics WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND status = 'open'",
            (account_id, thread_id, thread_type)).fetchone()
        if row:
            con.execute("ROLLBACK")
            return False
        cur = con.execute(
            "INSERT INTO topics (account_id, thread_id, thread_type, title, abstract, status, "
            "first_ts_ms, last_ts_ms, message_count, created_at_ms, updated_at_ms) "
            "VALUES (?, ?, ?, ?, ?, 'open', 0, 0, 0, ?, ?)",
            (account_id, thread_id, thread_type, title, summary, int(_now()), int(_now())))
        topic_id = int(cur.lastrowid)
        if ids:
            con.execute(
                "UPDATE messages SET topic_id = ? WHERE account_id = ? AND thread_id = ? AND thread_type = ? "
                "AND rowid IN (" + ",".join("?" for _ in ids) + ")",
                (topic_id, account_id, thread_id, thread_type, *ids))
            con.execute(
                "UPDATE topics SET message_count = (SELECT COUNT(*) FROM messages WHERE topic_id = ?), "
                "first_ts_ms = COALESCE((SELECT MIN(timestamp_ms) FROM messages WHERE topic_id = ?),0), "
                "last_ts_ms = COALESCE((SELECT MAX(timestamp_ms) FROM messages WHERE topic_id = ?),0), "
                "updated_at_ms = ? WHERE topic_id = ?",
                (topic_id, topic_id, topic_id, int(_now()), topic_id))
        con.commit()
        return True
    except sqlite3.Error as exc:
        try:
            con.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise exc
    finally:
        con.close()


def _now() -> int:
    import time
    return int(time.time() * 1000)


def active_facts(scope: str, account_id: str, *, limit: int = 12) -> List[Dict[str, Any]]:
    con = _connect()
    if con is None:
        return []
    try:
        rows = con.execute(
            "SELECT fact_id, kind, subject, content, origin FROM facts "
            "WHERE scope = ? AND account_id = ? AND status = 'active' "
            "AND (valid_to_ms IS NULL OR valid_to_ms > ?) "
            "ORDER BY confidence DESC, created_at_ms DESC LIMIT ?",
            (scope, account_id, _now(), int(limit))).fetchall()
        return [{"factId": r["fact_id"], "kind": r["kind"], "subject": r["subject"],
                 "content": r["content"], "origin": str(r["origin"] or "")} for r in rows]
    finally:
        con.close()


def accept_facts(scope: str, account_id: str, raw_facts: Iterable[Any], cap: int, kinds: tuple) -> int:
    """Kiểm tra schema rồi ghi fact; supersede/thêm mâu thuẫn nếu cần. Trả số fact mới ghi."""
    if not SCOPE_RE.match(str(scope or "")):
        return 0
    con = _connect()
    if con is None:
        return 0
    try:
        con.execute("BEGIN IMMEDIATE")
        written = 0
        for item in (raw_facts or []):
            if written >= cap:
                break
            if not isinstance(item, dict):
                continue
            kind = str(item.get("kind") or "")
            if kind not in kinds:
                continue
            subject = str(item.get("subject") or "").strip()[:200]
            content = str(item.get("content") or "").strip()[:300]
            if not content:
                continue
            try:
                confidence = float(item.get("confidence") or 0.6)
            except (TypeError, ValueError):
                confidence = 0.6
            confidence = max(0.0, min(1.0, confidence))
            valid_to = item.get("valid_to")
            valid_to_ms = _parse_date_ms(valid_to) if valid_to not in (None, "", "null") else None
            ids = item.get("message_ids") or []
            source_keys = [str(i) for i in ids if str(i).lstrip("-").isdigit()][:20]
            supersedes = str(item.get("supersedes") or "").strip()[:80]
            cur = con.execute(
                "INSERT INTO facts (account_id, scope, kind, subject, content, source_msg_keys, "
                "confidence, valid_from_ms, valid_to_ms, superseded_by, status, origin, created_at_ms, updated_at_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', 'extract', ?, ?)",
                (account_id, scope, kind, subject, content, json.dumps(source_keys), confidence,
                 _now(), valid_to_ms, _now(), _now()))
            new_id = int(cur.lastrowid)
            written += 1
            # Nếu model ghi supersedes → tìm fact đang hiệu lực cùng (kind, subject) và supersede.
            if supersedes:
                old = con.execute(
                    "SELECT fact_id FROM facts WHERE scope = ? AND account_id = ? AND status = 'active' "
                    "AND kind = ? AND subject = ? AND fact_id <> ?",
                    (scope, account_id, kind, subject, new_id)).fetchone()
                if old:
                    con.execute(
                        "UPDATE facts SET valid_to_ms = ?, status = 'superseded', superseded_by = ?, updated_at_ms = ? "
                        "WHERE fact_id = ?",
                        (_now(), new_id, _now(), old["fact_id"]))
        con.commit()
        return written
    except sqlite3.Error:
        try:
            con.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        return 0
    finally:
        con.close()


def read_profile(scope: str, account_id: str) -> Optional[Dict[str, Any]]:
    """Hồ sơ hiện có của phạm vi: ``{body, updatedAtMs, sourceFactIds}`` hoặc None."""
    con = _connect()
    if con is None:
        return None
    try:
        row = con.execute(
            'SELECT body, source_fact_ids, updated_at_ms FROM profiles WHERE scope = ? AND account_id = ?',
            (str(scope), str(account_id))).fetchone()
        if row is None:
            return None
        try:
            ids = json.loads(str(row['source_fact_ids'] or '[]'))
        except ValueError:
            ids = []
        return {'body': str(row['body'] or ''), 'updatedAtMs': int(row['updated_at_ms']),
                'sourceFactIds': [int(i) for i in ids if str(i).lstrip('-').isdigit()]}
    except sqlite3.Error:
        return None
    finally:
        con.close()


def write_profile(scope: str, account_id: str, body: str, source_fact_ids: Optional[List[int]] = None) -> bool:
    """Ghi/đè hồ sơ gộp của phạm vi. Chữ rỗng → không ghi (giữ hồ sơ cũ, tránh xoá oan)."""
    text = str(body or '').strip()
    if not text:
        return False
    con = _connect()
    if con is None:
        return False
    try:
        ids = [int(i) for i in (source_fact_ids or []) if str(i).lstrip('-').isdigit()][:200]
        con.execute(
            'INSERT INTO profiles (account_id, scope, body, source_fact_ids, updated_at_ms) VALUES (?, ?, ?, ?, ?) '
            'ON CONFLICT(account_id, scope) DO UPDATE SET body = excluded.body, '
            'source_fact_ids = excluded.source_fact_ids, updated_at_ms = excluded.updated_at_ms',
            (str(account_id), str(scope), text[:PROFILE_MAX_CHARS], json.dumps(ids), _now()))
        con.commit()
        return True
    except sqlite3.Error:
        return False
    finally:
        con.close()


def _parse_date_ms(value: Any) -> Optional[int]:
    """Hết hạn vào cuối ngày VN đó (hạn ("2026-10-25" → 00:00 ngày 26). Sai dạng → None, không hết hạn."""
    text = str(value or "").strip()
    if not _DATE_RE.match(text):
        return None
    try:
        d = date.fromisoformat(text)
        return int(datetime(d.year, d.month, d.day, tzinfo=_VN).timestamp() * 1000 + 86_400_000)
    except (ValueError, OSError):
        return None



