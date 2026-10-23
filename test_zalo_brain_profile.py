"""Hồ sơ gộp tự động của bộ não SQLite (spec §21.3) — AI giả, không gọi mạng.

Chạy: npm run test:py  (hoặc: python -m unittest test_zalo_brain_profile)
"""

import os
import logging
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import plugins  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import brain_jobs as bj  # noqa: E402
from plugins.zalo_tools import store_writer as sw  # noqa: E402

SCOPE = "zalo-g-2054797107487294899"
OTHER = "zalo-g-999999999999999999"
ACCOUNT = "121443080539835174"


def _schema(db):
    con = sqlite3.connect(db)
    con.executescript("""
      CREATE TABLE messages (identity_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        thread_type INTEGER NOT NULL, msg_id TEXT, cli_msg_id TEXT, sender_uid TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', msg_type TEXT NOT NULL DEFAULT '',
        timestamp_ms INTEGER NOT NULL, is_self INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, topic_id INTEGER);
      CREATE TABLE facts (fact_id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, scope TEXT NOT NULL,
        kind TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
        source_msg_keys TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0.5,
        valid_from_ms INTEGER NOT NULL DEFAULT 0, valid_to_ms INTEGER, superseded_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active', topic_id INTEGER, origin TEXT NOT NULL DEFAULT 'extract',
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE profiles (account_id TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        source_fact_ids TEXT NOT NULL DEFAULT '[]', updated_at_ms INTEGER NOT NULL, PRIMARY KEY(account_id, scope));
      CREATE TABLE topics (topic_id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        thread_type INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', first_ts_ms INTEGER NOT NULL DEFAULT 0, last_ts_ms INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE kb_brain_progress (account_id TEXT NOT NULL, scope TEXT NOT NULL,
        last_msg_ms INTEGER NOT NULL DEFAULT 0, last_run_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account_id, scope));
    """)
    con.commit()
    con.close()


def _add_fact(db, scope, subject, content, *, at=None, origin="extract", status="active"):
    con = sqlite3.connect(db)
    # Mặc định lùi đủ lâu để lần gộp ĐẦU đã qua thời gian chờ tối thiểu.
    stamp = (int(time.time() * 1000) if at is None
             else at)
    if at is None:
        stamp -= (bj.PROFILE_MIN_FIRST_WAIT_MINUTES + 1) * 60_000
    con.execute(
        "INSERT INTO facts (account_id, scope, kind, subject, content, confidence, status, origin, "
        "created_at_ms, updated_at_ms) VALUES (?, ?, 'decision', ?, ?, 0.9, ?, ?, ?, ?)",
        (ACCOUNT, scope, subject, content, status, origin, stamp, stamp))
    con.commit()
    con.close()



def _add_msg(db, thread_id, *, topic_id=None, at=None, thread_type=1, text="xin chào"):
    """Một tin trong kho — cần cho các test đi qua `_topic_candidates`/`_fact_candidates`."""
    stamp = int(time.time() * 1000) if at is None else at
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO messages (identity_key, account_id, thread_id, thread_type, sender_uid, sender_name, "
        "text, msg_type, timestamp_ms, is_self, source, created_at_ms, updated_at_ms, topic_id) "
        "VALUES (?, ?, ?, ?, 'u1', 'Lan', ?, 'webchat', ?, 0, 'live', ?, ?, ?)",
        (f"{thread_id}-{stamp}-{text[:8]}", ACCOUNT, str(thread_id), thread_type, text, stamp, stamp, stamp, topic_id))
    con.commit()
    con.close()

class _Result:
    def __init__(self, text):
        self.text = text


class FakeLLM:
    """Trả chữ đúng như model thật hay trả: có khối ``` và tiêu đề thừa."""

    def __init__(self, text="```\n# Hồ sơ\n- Nhóm bàn kiến trúc bot.\n- Gọi bot là Nhi.\n```", fail=False):
        self.text, self.fail, self.calls = text, fail, []

    def complete(self, messages, **kwargs):
        self.calls.append(kwargs.get("purpose"))
        if self.fail:
            raise RuntimeError("cổng AI hỏng")
        return _Result(self.text)


class ProfileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="brain-profile-")
        self.db = os.path.join(self.dir, "zalo.sqlite")
        _schema(self.db)
        os.environ["ZALO_SQLITE_FILE"] = self.db
        # Cô lập cài đặt: không đặt thì `settings_path()` trỏ vào `<HERMES_HOME>/zalo/brain.json` thật,
        # nên một máy đang tắt worker (enabled:false) sẽ làm đỏ test chẳng liên quan tới cài đặt đó.
        os.environ["ZALO_BRAIN_FILE"] = os.path.join(self.dir, "absent-brain.json")
        bj._SETTINGS_CACHE["key"] = None

    def tearDown(self):
        os.environ.pop("ZALO_SQLITE_FILE", None)
        os.environ.pop("ZALO_BRAIN_FILE", None)
        bj._SETTINGS_CACHE["key"] = None

    def _bare(self):
        """Chữ hồ sơ sau khi bỏ vỏ bọc model hay thêm."""
        return bj._clip_multiline

    # -- bỏ vỏ bọc ---------------------------------------------------------

    def test_bo_vo_boc_model_hay_them(self):
        clip = self._bare()
        self.assertEqual(clip("```\n# Hồ sơ\n- A\n- B\n```", 200), "- A\n- B")
        self.assertEqual(clip("Hồ sơ\n- A\n- B", 200), "- A\n- B")
        self.assertEqual(clip("# Hồ sơ\n- A", 200), "- A")
        self.assertEqual(clip("- A\n- B", 200), "- A\n- B", "gạch đầu dòng thì giữ nguyên")
        self.assertEqual(clip("", 200), "")
        self.assertEqual(clip("```", 200), "")

    def test_giu_xuong_dong_va_cat_do_dai(self):
        clip = self._bare()
        out = clip("- một\n- hai\n- ba", 12)
        self.assertEqual(len(out), 12)
        self.assertIn("\n", out, "cắt độ dài không được làm mất xuống dòng còn lại")

    # -- chọn phạm vi ------------------------------------------------------

    def test_khong_co_fact_thi_khong_gop(self):
        con = bj.connect_ro()
        self.assertEqual(bj._profile_candidates(con, int(time.time() * 1000)), [])
        con.close()

    def test_co_fact_moi_thi_du_dieu_kien(self):
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        con = bj.connect_ro()
        cands = bj._profile_candidates(con, int(time.time() * 1000))
        con.close()
        self.assertEqual([c["scope"] for c in cands], [SCOPE])
        self.assertEqual(cands[0]["fresh"], 1)

    def test_vua_gop_xong_thi_chua_gop_lai(self):
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        con = bj.connect_ro()
        now = int(time.time() * 1000)
        self.assertTrue(bj._run_profile(con, FakeLLM(), bj._profile_candidates(con, now)[0]))
        self.assertEqual(bj._profile_candidates(con, now + 60_000), [], "chưa qua chu kỳ nghỉ thì đừng gọi model")
        con.close()

    def test_fact_moi_hon_lan_gop_truoc_thi_gop_lai(self):
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        con = bj.connect_ro()
        now = int(time.time() * 1000)
        bj._run_profile(con, FakeLLM(), bj._profile_candidates(con, now)[0])
        con.close()
        # Fact mới xuất hiện SAU lần gộp, và đã qua chu kỳ nghỉ
        later = now + bj.PROFILE_MIN_INTERVAL_MINUTES * 60_000 + 1000
        _add_fact(self.db, SCOPE, "xưng hô", "Gọi bot là Nhi", at=later)
        con = bj.connect_ro()
        self.assertEqual([c["scope"] for c in bj._profile_candidates(con, later)], [SCOPE])
        con.close()

    def test_fact_da_supersede_khong_tinh(self):
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k", status="superseded")
        con = bj.connect_ro()
        self.assertEqual(bj._profile_candidates(con, int(time.time() * 1000)), [])
        con.close()

    def test_gioi_han_so_pham_vi_moi_vong(self):
        for i in range(bj.PROFILE_MAX_PER_RUN + 2):
            _add_fact(self.db, f"zalo-g-20547971074872948{i:02d}", f"việc {i}", f"nội dung {i}")
        con = bj.connect_ro()
        cands = bj._profile_candidates(con, int(time.time() * 1000))
        con.close()
        self.assertEqual(len(cands), bj.PROFILE_MAX_PER_RUN)

    # -- gộp và ghi --------------------------------------------------------

    def test_gop_ghi_dung_pham_vi_kem_nguon_fact(self):
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        _add_fact(self.db, OTHER, "khác", "Không liên quan")
        con = bj.connect_ro()
        row = [c for c in bj._profile_candidates(con, int(time.time() * 1000)) if c["scope"] == SCOPE][0]
        self.assertTrue(bj._run_profile(con, FakeLLM(), row))
        con.close()

        con = sqlite3.connect(self.db)
        con.row_factory = sqlite3.Row
        rows = con.execute("SELECT scope, body, source_fact_ids FROM profiles").fetchall()
        con.close()
        self.assertEqual([r["scope"] for r in rows], [SCOPE], "chỉ gộp phạm vi được chọn")
        self.assertEqual(rows[0]["body"], "- Nhóm bàn kiến trúc bot.\n- Gọi bot là Nhi.")
        self.assertEqual(rows[0]["source_fact_ids"], "[1]", "ghi lại fact nào sinh ra hồ sơ")

    def test_hai_lan_gop_de_len_nhau_khong_tao_dong_moi(self):
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        con = bj.connect_ro()
        start = int(time.time() * 1000)
        for step in range(3):
            # Mỗi vòng phải có fact MỚI hơn lần gộp trước, và đã cách lần trước đủ chu kỳ nghỉ.
            if step:
                _add_fact(self.db, SCOPE, f"việc {step}", f"nội dung {step}", at=start + step * 1000)
            now = start + step * (bj.PROFILE_MIN_INTERVAL_MINUTES * 60_000 + 1000)
            cands = bj._profile_candidates(con, now)
            self.assertTrue(cands, f"lần {step + 1} phải đủ điều kiện gộp lại")
            bj._run_profile(con, FakeLLM(), cands[0])
        con.close()
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM profiles").fetchone()[0], 1, "3 lần gộp vẫn chỉ 1 dòng")
        con.close()

    def test_model_tra_rong_thi_giu_ho_so_cu(self):
        old_at = int(time.time() * 1000) - (bj.PROFILE_MIN_INTERVAL_MINUTES + 5) * 60_000
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO profiles (account_id, scope, body, source_fact_ids, updated_at_ms) VALUES (?, ?, ?, '[]', ?)",
                    (ACCOUNT, SCOPE, "- Hồ sơ cũ còn đúng", old_at))
        con.commit()
        con.close()
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        con = bj.connect_ro()
        row = bj._profile_candidates(con, int(time.time() * 1000))[0]
        self.assertFalse(bj._run_profile(con, FakeLLM(text="   "), row), "chữ rỗng → không ghi")
        con.close()
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT body FROM profiles").fetchone()[0], "- Hồ sơ cũ còn đúng")
        con.close()

    def test_model_loi_thi_khong_ghi_gi_va_khong_nem(self):
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        con = bj.connect_ro()
        row = bj._profile_candidates(con, int(time.time() * 1000))[0]
        self.assertFalse(bj._run_profile(con, FakeLLM(fail=True), row))
        con.close()
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM profiles").fetchone()[0], 0)
        con.close()

    def test_khong_co_fact_thi_khong_goi_model(self):
        llm = FakeLLM()
        con = bj.connect_ro()
        self.assertFalse(bj._run_profile(con, llm, {"scope": SCOPE, "account_id": ACCOUNT}))
        con.close()
        self.assertEqual(llm.calls, [], "không có gì để gộp thì đừng tốn lượt AI")

    # -- vòng chạy ---------------------------------------------------------

    def test_run_once_gop_ho_so_sau_khi_trich_tri_thuc(self):
        # Tin ĐÃ GÁN chủ đề (topic_id) — điều kiện vào `_fact_candidates`. Thiếu tin thì vòng chạy
        # không có gì để trích, nên hồ sơ cũng không được gộp.
        for i in range(3):
            _add_msg(self.db, "2054797107487294899", topic_id=7, text=f"tin {i}")
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        llm = FakeLLM()
        bj.run_once(lambda: llm)
        self.assertIn("zalo-brain-facts", llm.calls, "có tin chờ thì phải trích tri thức")
        self.assertIn("zalo-brain-profile", llm.calls, "vòng chạy phải gọi cả phần hồ sơ")
        con = sqlite3.connect(self.db)
        body = con.execute("SELECT body FROM profiles WHERE scope = ?", (SCOPE,)).fetchone()
        con.close()
        self.assertTrue(body and body[0].startswith("- "), f"hồ sơ phải được ghi: {body}")

    # -- chống lặp: mốc tiến độ ---------------------------------------------

    def test_moc_tien_do_chan_chon_lai_pham_vi_da_xem(self):
        """Thiếu mốc thì phạm vi đã xử lý vẫn được chọn lại mãi — vòng lặp gọi model mỗi 30 giây."""
        for i in range(3):
            _add_msg(self.db, "2054797107487294899", topic_id=7, text=f"tin {i}")
        con = bj.connect_ro()
        self.assertEqual(len(bj._fact_candidates(con)), 1, "lần đầu phải thấy phạm vi còn tin chưa xem")
        row = bj._fact_candidates(con)[0]
        # Lượt chạy xong: mốc được ghi kể cả khi model không trích được fact nào.
        bj._run_facts(con, FakeLLM(text='{"facts":[]}'), row, 25)
        con.close()
        con = bj.connect_ro()
        self.assertEqual(bj._fact_candidates(con), [], "đã xem hết thì đừng chọn lại")
        con.close()

    def test_tin_moi_hon_moc_thi_chon_lai(self):
        for i in range(3):
            _add_msg(self.db, "2054797107487294899", topic_id=7, text=f"tin {i}")
        con = bj.connect_ro()
        row = bj._fact_candidates(con)[0]
        seen = max(int(r["timestamp_ms"]) for r in con.execute(
            "SELECT timestamp_ms FROM messages WHERE topic_id IS NOT NULL"))
        bj._run_facts(con, FakeLLM(text='{"facts":[]}'), row, 25)
        con.close()
        for i in range(3):
            _add_msg(self.db, "2054797107487294899", topic_id=7, at=seen + 60_000, text=f"moi {i}")
        con = bj.connect_ro()
        self.assertEqual(len(bj._fact_candidates(con)), 1, "có tin mới hơn mốc thì phải trích tiếp")
        con.close()

    def test_hoi_thoai_co_chu_de_mo_van_duoc_goi_lai(self):
        """Chủ đề mở KHÔNG được chặn vòng sau: `_run_topic` tự đóng nó trước khi gói chủ đề mới.

        Luật cũ (loại hội thoại có chủ đề `open`) làm hội thoại đang hoạt động kẹt vĩnh viễn — đo 23/10:
        nhóm 3430869407275128341 tồn 743 tin bên cạnh một chủ đề mở từ hôm trước, tổng 1281 tin không
        bao giờ được học.
        """
        con = sqlite3.connect(self.db)
        con.execute(
            "INSERT INTO topics (account_id, thread_id, thread_type, title, status, created_at_ms, updated_at_ms) "
            "VALUES (?, '2054797107487294899', 1, 'Chủ đề đang mở', 'open', ?, ?)",
            (ACCOUNT, int(time.time() * 1000), int(time.time() * 1000)))
        con.commit()
        con.close()
        quiet = 20 * 60_000
        now = int(time.time() * 1000)
        for i in range(8):
            _add_msg(self.db, "2054797107487294899", at=now - quiet - 60_000 - i * 1000, text=f"tin {i}")
        con = bj.connect_ro()
        self.assertEqual(len(bj._topic_candidates(con, quiet, now)), 1,
                         "còn tin chờ thì phải gói tiếp, chủ đề mở không được chặn")
        row = bj._topic_candidates(con, quiet, now)[0]
        llm = FakeLLM(text='{"title":"Chủ đề mới","summary":"","message_ids":[]}')
        self.assertTrue(bj._run_topic(con, llm, row, now), "gói được chủ đề mới sau khi đóng chủ đề cũ")
        con.close()
        con = sqlite3.connect(self.db)
        opened = con.execute(
            "SELECT COUNT(*) FROM topics WHERE thread_id = '2054797107487294899' AND status = 'open'").fetchone()[0]
        all_topics = con.execute(
            "SELECT COUNT(*) FROM topics WHERE thread_id = '2054797107487294899'").fetchone()[0]
        unassigned = con.execute(
            "SELECT COUNT(*) FROM messages WHERE thread_id = '2054797107487294899' AND topic_id IS NULL").fetchone()[0]
        con.close()
        self.assertEqual(opened, 1, "chỉ một chủ đề mở tại một thời điểm")
        self.assertEqual(all_topics, 2, "chủ đề cũ phải được ĐÓNG, không xoá")
        self.assertEqual(unassigned, 0, "tin chờ phải được gán vào chủ đề mới")

    def test_nhom_dang_chat_van_duoc_goi_chu_de(self):
        """Nhóm sôi động không bao giờ 'im 120 phút' — luật cũ khiến nó không bao giờ được học.

        Nay chỉ cần lô tin đã lắng `TOPIC_LULL_MINUTES`; tin cuối cách đây 10 phút là đủ.
        """
        now = int(time.time() * 1000)
        quiet = 120 * 60_000                      # cài đặt người dùng: 120 phút
        for i in range(8):
            _add_msg(self.db, "8022259598120952176", at=now - 10 * 60_000 - i * 1000, text=f"tin {i}")
        con = bj.connect_ro()
        rows = bj._topic_candidates(con, quiet, now)
        con.close()
        self.assertEqual(len(rows), 1, "tin cuối cách 10 phút > TOPIC_LULL_MINUTES(5) thì phải gói được")

    def test_hoi_thoai_dang_noi_do_dang_thi_chua_goi(self):
        """Tin cuối mới 30 giây → còn đang nói dở, đừng cắt giữa lượt."""
        now = int(time.time() * 1000)
        for i in range(8):
            _add_msg(self.db, "8022259598120952176", at=now - 30_000 - i * 1000, text=f"tin {i}")
        con = bj.connect_ro()
        rows = bj._topic_candidates(con, 120 * 60_000, now)
        con.close()
        self.assertEqual(rows, [], "tin cuối mới 30 giây thì chờ thêm")

    def test_goi_chu_de_that_bai_khong_bi_goi_lai(self):
        """Model trả JSON sai dạng → tin vẫn `topic_id IS NULL`; không ghi mốc thì vòng sau gọi lại mãi."""
        now = int(time.time() * 1000)
        quiet = 120 * 60_000
        for i in range(8):
            _add_msg(self.db, "8022259598120952176", at=now - quiet - 60_000 - i * 1000, text=f"tin {i}")
        con = bj.connect_ro()
        self.assertEqual(len(bj._topic_candidates(con, quiet, now)), 1, "hội thoại đủ tin, im đủ lâu")
        row = bj._topic_candidates(con, quiet, now)[0]
        # Model trả rác: `_parse_json_object` không ra dict có title → lượt hỏng.
        self.assertFalse(bj._run_topic(con, FakeLLM(text="xin lỗi, tôi không trả JSON"), row, now))
        self.assertEqual(bj._topic_candidates(con, quiet, now), [], "đã xem xét thì đừng gọi model lại")
        con.close()

    def test_tat_bang_brain_json_thi_khong_lam_gi(self):
        import json
        _add_fact(self.db, SCOPE, "giá", "Chốt 60k")
        settings = os.path.join(self.dir, "brain.json")
        with open(settings, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "enabled": False}, fh)
        os.environ["ZALO_BRAIN_FILE"] = settings
        bj._SETTINGS_CACHE["key"] = None
        try:
            llm = FakeLLM()
            bj.run_once(lambda: llm)
            self.assertEqual(llm.calls, [])
        finally:
            os.environ.pop("ZALO_BRAIN_FILE", None)
            bj._SETTINGS_CACHE["key"] = None

    # -- store_writer ------------------------------------------------------

    def test_doc_ghi_ho_so_qua_store_writer(self):
        self.assertIsNone(sw.read_profile(SCOPE, ACCOUNT))
        self.assertTrue(sw.write_profile(SCOPE, ACCOUNT, "- A\n- B", [1, 2]))
        got = sw.read_profile(SCOPE, ACCOUNT)
        self.assertEqual(got["body"], "- A\n- B")
        self.assertEqual(got["sourceFactIds"], [1, 2])
        self.assertFalse(sw.write_profile(SCOPE, ACCOUNT, "   "), "chữ rỗng không ghi đè")
        self.assertEqual(sw.read_profile(SCOPE, ACCOUNT)["body"], "- A\n- B")

    def test_profile_khong_lan_sang_pham_vi_khac(self):
        sw.write_profile(SCOPE, ACCOUNT, "- của nhóm này", [])
        self.assertIsNone(sw.read_profile(OTHER, ACCOUNT))
        self.assertEqual(sw.read_profile(SCOPE, ACCOUNT)["body"], "- của nhóm này")


class FindStoreTest(unittest.TestCase):
    """Tìm kho: biến môi trường trước, rồi mới dò; và nói thẳng khi không thấy (spec §21.2)."""

    KEYS = ("ZALO_SQLITE_FILE", "ZALO_SIDECAR_ROOT", "ZALO_SIDECAR_DIR", "HERMES_HOME")

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="brain-find-")
        self.saved = {k: os.environ.pop(k, None) for k in self.KEYS}

    def tearDown(self):
        for k, v in self.saved.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)

    def _fake_sidecar(self):
        """Thư mục giống bản cài thật: server.js + data/zalo.sqlite + hermes-plugin/zalo_tools."""
        root = Path(self.dir) / "bot"
        (root / "data").mkdir(parents=True)
        (root / "hermes-plugin" / "zalo_tools").mkdir(parents=True)
        (root / "server.js").write_text("// giả", encoding="utf-8")
        db = root / "data" / "zalo.sqlite"
        db.write_text("", encoding="utf-8")
        return root, db

    def test_u_tien_bien_moi_truong(self):
        explicit = Path(self.dir) / "rieng.sqlite"
        os.environ["ZALO_SQLITE_FILE"] = str(explicit)
        self.assertEqual(bj.sqlite_path(), explicit, "ZALO_SQLITE_FILE thắng mọi thứ")
        os.environ.pop("ZALO_SQLITE_FILE")
        _, db = self._fake_sidecar()
        os.environ["ZALO_SIDECAR_ROOT"] = str(db.parent.parent)
        self.assertEqual(bj.sqlite_path(), db)

    def test_do_nguoc_tim_thay_kho_khong_can_bien(self):
        root, db = self._fake_sidecar()
        # Dò đúng như lúc chạy thật: bắt đầu từ trong thư mục plugin của bản cài đó
        self.assertEqual(bj._discover_sqlite_path(start=root / "hermes-plugin" / "zalo_tools").resolve(), db.resolve())
        self.assertEqual(bj._discover_sqlite_path(start=root).resolve(), db.resolve(), "đứng ngay thư mục cài cũng nhận")

    def test_do_nguoc_chi_tim_thay_khi_o_duoi_that(self):
        # Gốc tạm KHÔNG có server.js → không thấy gì, không dính tới kho thật của máy này.
        self.assertIsNone(bj._discover_sqlite_path(start=Path(self.dir), levels=1))

    def test_do_nguoc_khong_thay_thi_tra_none(self):
        root = Path(self.dir) / "khong-co-gi"
        root.mkdir()
        self.assertIsNone(bj._discover_sqlite_path(start=root, levels=1))
        self.assertIsNone(bj._discover_sqlite_path(start=Path(self.dir) / "khong-ton-tai"))

    def test_do_nguoc_can_co_ca_server_va_kho(self):
        root = Path(self.dir) / "thieu-kho"
        root.mkdir()
        (root / "server.js").write_text("// giả", encoding="utf-8")   # có server.js, thiếu data/
        self.assertIsNone(bj._discover_sqlite_path(start=root))
        root2 = Path(self.dir) / "thieu-server"
        (root2 / "data").mkdir(parents=True)
        (root2 / "data" / "zalo.sqlite").write_text("", encoding="utf-8")
        self.assertIsNone(bj._discover_sqlite_path(start=root2))

    def _capture(self, fn):
        """Bắt log của brain_jobs theo cách không phụ thuộc cấu hình logging toàn cục."""
        records = []

        class Cap(logging.Handler):
            def emit(self, record):
                records.append((record.levelname, record.getMessage()))

        logger = bj.logger   # tên thật tuỳ cách nạp (plugins.zalo_tools.* / zalo_tools.*) — dùng chính module
        handler = Cap()
        old_level, old_propagate = logger.level, logger.propagate
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
        try:
            fn()
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)
            logger.propagate = old_propagate
        return records

    def test_canh_bao_ro_khi_thieu_bien(self):
        # gọi thẳng hàm cảnh báo: nó là chỗ quyết định câu chữ, không phụ thuộc máy này có kho hay không
        bj._WARNED_STORE.clear()
        records = self._capture(bj._warn_store_missing)
        self.assertEqual([level for level, _ in records], ["WARNING"])
        text = records[0][1]
        self.assertIn("ZALO_SIDECAR_ROOT", text, "phải chỉ đúng biến còn thiếu")
        self.assertIn("install:hermes", text, "phải nói cách sửa")

    def test_canh_bao_chi_mot_lan(self):
        # Nhánh "có biến nhưng chưa có tệp": lần đầu WARNING, lần sau DEBUG (không spam mỗi vòng 30 s).
        os.environ["HERMES_HOME"] = self.dir
        bj._WARNED_STORE.clear()
        first = self._capture(bj._warn_store_missing)
        self.assertEqual([level for level, _ in first], ["WARNING"])
        self.assertIn("chưa chạy lần nào", first[0][1], "phải nói đây là bình thường")
        second = self._capture(bj._warn_store_missing)
        self.assertEqual([level for level, _ in second], ["DEBUG"])

    def test_provider_dung_cung_luat_tim_kho(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "zm_isolated", Path(__file__).parent / "hermes-plugin" / "zalo_memory" / "__init__.py")
        zm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(zm)
        _, db = self._fake_sidecar()
        os.environ["ZALO_SIDECAR_ROOT"] = str(db.parent.parent)
        self.assertEqual(zm.sqlite_path(), db)


if __name__ == "__main__":
    unittest.main()
