"""Kho tri thức: tìm tệp theo tên và theo nội dung (tools.py `_kb_match`, `zalo_kb_list`).

Hai lỗi thật đã gặp trên kho có tệp tải lên từ dashboard:
  1. Tên tệp macOS ghi ở dạng NFD ("TOA\\u0301N"), người dùng gõ NFC ("toán") —
     so thẳng chuỗi thì trượt sạch, `zalo_kb_list` trả rỗng và bot tưởng kho trống.
  2. Tên tệp viết tắt ("TOÁN 7-BỘ 10 ĐỀ…") còn người hỏi gõ cụm trong bài
     ("toán lớp 7") — lọc theo tên không bao giờ thấy, phải tìm trong nội dung.

Chạy: npm run test:py
"""

import json
import os
import shutil
import sys
import tempfile
import unicodedata
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import plugins  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import tools as zalo_tools  # noqa: E402

NFD_NAME = unicodedata.normalize("NFD", "TOÁN 7-BỘ 10 ĐỀ ÔN TẬP GIỮA KÌ 1-26-27-CÓ ĐA.docx")


class KbSearchTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="zalo-kb-search-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        upload = os.path.join(self.dir, "tai-len-dashboard")
        os.makedirs(upload)
        # Tên NFD đúng như macOS ghi khi tải lên từ dashboard.
        self.docx = os.path.join(upload, NFD_NAME)
        with open(self.docx, "wb") as fh:
            fh.write(b"PK\x03\x04....word/document.xml....")
        with open(os.path.join(upload, "noi-quy.md"), "w", encoding="utf-8") as fh:
            fh.write("Nội quy nhóm\nĐiều 1: lịch sự\n")
        self.enterContext(mock.patch.dict(os.environ, {"ZALO_KB_DIR": self.dir}))
        # Đệm danh sách là biến toàn cục — mỗi test phải bắt đầu từ cây thật.
        zalo_tools._KB_CACHE.update(root=None, at=0.0, files=None, skipped=0)
        zalo_tools._KB_TEXT_CACHE.clear()

    def list_files(self, query=""):
        payload = json.loads(self._run(zalo_tools.zalo_kb_list({"query": query})))
        self.assertTrue(payload["success"], payload)
        return payload["result"]

    @staticmethod
    def _run(coro):
        import asyncio
        return asyncio.run(coro)

    def test_nfd_ten_tep_khop_query_nfc(self):
        """Tên tệp NFD + query NFC vẫn khớp — trước đây trả rỗng."""
        result = self.list_files("toán")
        self.assertEqual(result["count"], 1, result)
        self.assertEqual(os.path.basename(result["files"][0]["path"]), NFD_NAME)

    def test_query_nhieu_tu_khop_moi_tu_trong_ten(self):
        result = self.list_files("TOÁN 7")
        self.assertEqual(result["count"], 1, result)

    def test_token_phai_khop_tron_tu_khong_khop_mau(self):
        """"toán 6" không được khớp nhờ mẩu "6" trong "26" của tên tệp."""
        self.assertEqual(self.list_files("toán 6")["count"], 0)
        self.assertEqual(self.list_files("toán 8")["count"], 0)

    def test_ten_khong_khop_thi_tim_trong_noi_dung(self):
        """Tên tệp không chứa "lớp 7" nhưng nội dung có — phải trả tệp kèm snippet."""
        with mock.patch.object(zalo_tools, "_kb_extract", return_value="MÔN: TOÁN – LỚP 7\nĐỀ 1\n"):
            result = self.list_files("toán lớp 7")
        self.assertEqual(result["count"], 1, result)
        self.assertEqual(result["matched"], "content")
        self.assertIn("lớp 7", result["files"][0]["snippet"].lower())

    def test_noi_dung_khop_roi_rac_khong_tinh_la_khop(self):
        """"toán 9" chỉ có "toán" và "9" nằm cách xa nhau — không được khớp."""
        with mock.patch.object(zalo_tools, "_kb_extract", return_value=("MÔN: TOÁN – LỚP 7\n" + "x" * 400 + "\n9\n")):
            self.assertEqual(self.list_files("toán 9")["count"], 0)

    def test_doc_tep_theo_duong_dan_nfd_va_nfc(self):
        """zalo_kb_read nhận cả hai dạng đường dẫn — dashboard trả về NFD, mô hình có thể gõ NFC."""
        rel = f"tai-len-dashboard/{NFD_NAME}"
        for path in (rel, unicodedata.normalize("NFC", rel)):
            with mock.patch.object(zalo_tools, "_kb_extract", return_value="nội dung"):
                payload = json.loads(self._run(zalo_tools.zalo_kb_read({"path": path})))
            self.assertTrue(payload["success"], payload)
            self.assertEqual(payload["result"]["content"], "nội dung")


if __name__ == "__main__":
    unittest.main()
