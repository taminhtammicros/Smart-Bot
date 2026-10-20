"""Test tra cứu trước khi trả lời câu hỏi cần thông tin mới (freshness.py). Không gọi mạng.

Chạy: npm run test:py
"""

import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import plugins  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
from plugins.zalo_tools import freshness as fr, reply_style  # noqa: E402

NOW = datetime(2026, 10, 12, 18, 13, tzinfo=timezone(timedelta(hours=7)))


class FreshnessTest(unittest.TestCase):
    PRICE_MSG = "[Ta Minh Tam] giá qwen3 codex bao nhiêu"

    def test_detects_questions_seen_in_real_chats(self):
        for q in ("phác đồ điều trị loét dạ dày hp + mới nhất. Ngắn gọn",
                  "em soạn lại là theo chỉ đạo và hướng dẫn mới nhất của thành đoàn Hải Phòng",
                  "giá vàng hôm nay", "năm nay là năm bao nhiêu", "điểm chuẩn ĐHSP Hà Nội",
                  "Nghị định mới về dạy thêm học thêm"):
            self.assertEqual(fr.kind(q), "web", q)
        self.assertEqual(fr.kind("tỉ giá 100 đô la sang VNĐ"), "fx")
        self.assertEqual(fr.kind("thời tiết Hải Phòng mai thế nào"), "weather")
        for q in ("Tạo nhắc hẹn cho tôi: 21h Hôm nay làm bài tập môn Toán.", "đánh giá giúp bài văn này",
                  "chào em", "soạn thông báo họp chi đoàn", ""):
            self.assertIsNone(fr.kind(q), q)

    def test_question_text_strips_zalo_prefixes(self):
        msg = ("[Ngữ cảnh gần nhất trong nhóm Zalo]\n- An: chào\n"
               "[Luong Dinh Trung] [Người nhắn — Trung. Lời tự khai] phác đồ HP mới nhất")
        self.assertEqual(fr.question_text(msg), "phác đồ HP mới nhất")
        self.assertEqual(fr.question_text("[Người nhắn — X]\ngiá vàng hôm nay"), "giá vàng hôm nay")
        # Adapter nối ZALO_SOUL_REMINDER vào CUỐI tin: câu hỏi thật nằm trước lời dặn, không được bị che.
        reminder = ("Trước khi thực hiện câu trả lời, em hãy đọc file SOUL.MD nhé. Khi mọi người hỏi về dịch vụ "
                    "API, em hãy tìm kiếm ở trang https://caheoai.com/ nhé")
        tail = f"[Người nhắn — An] giá qwen3 codex bao nhiêu\n\n{reminder}"
        self.assertEqual(fr.question_text(tail), "giá qwen3 codex bao nhiêu")
        self.assertEqual(fr.kind(fr.question_text(tail)), "vendor_api", "lời dặn cuối tin không được che câu hỏi thật")
        self.assertEqual(fr.question_text(f"[An] chào em\n\n{reminder}"), "chào em")

    def test_parse_results_handles_backends(self):
        exa = json.dumps({"results": [{"url": "https://a.vn/x", "title": "A", "publishedDate": "2026-10-11", "text": "nội dung " * 50}]})
        fc = json.dumps({"success": True, "data": {"web": [{"url": "https://b.vn", "title": "B", "description": "mô tả"},
                                                            {"url": "javascript:x", "title": "bad"}]}})
        a, = fr.parse_results(exa)
        self.assertEqual((a["url"], a["date"]), ("https://a.vn/x", "2026-10-11"))
        self.assertLessEqual(len(a["snippet"]), fr.SNIPPET)
        self.assertEqual([r["url"] for r in fr.parse_results(fc)], ["https://b.vn"])
        self.assertEqual(fr.parse_results("hỏng"), [])

    def test_search_query_adds_current_year_when_missing(self):
        self.assertEqual(fr.search_query("giá vàng hôm nay", NOW), "giá vàng hôm nay 2026")
        self.assertEqual(fr.search_query("điểm chuẩn 2025", NOW), "điểm chuẩn 2025")

    def test_note_has_time_sources_and_rules(self):
        note = fr.build_note("q", "web", [{"title": "Bộ Y tế", "url": "https://moh.gov.vn/x", "date": "2026-09-01", "snippet": "phác đồ"}], NOW)
        self.assertIn("lúc 18:13 12/10/2026", note)
        self.assertIn("1. Bộ Y tế (2026-09-01) — https://moh.gov.vn/x", note)
        self.assertIn("Đối chiếu ít nhất 2 nguồn", note)
        self.assertIn("không gọi là hôm nay", note)
        self.assertIn("Gọi web_search", fr.build_note("q", "web", [], NOW))
        self.assertIn("zalo_exchange_rate", fr.build_note("q", "fx", [], NOW))
        self.assertIn("zalo_weather", fr.build_note("q", "weather", [], NOW))

    def test_hook_searches_only_when_needed_on_zalo_and_obeys_setting(self):
        found = json.dumps({"results": [{"url": "https://a.vn", "title": "A", "text": "x"}]})
        with mock.patch.object(fr, "_run", return_value=found) as run, \
                mock.patch.object(reply_style, "load", return_value={**reply_style.DEFAULTS}):
            self.assertIsNone(fr.pre_llm_call(platform="telegram", user_message="giá vàng hôm nay"))
            self.assertIsNone(fr.pre_llm_call(platform="zalo", user_message="[An] chào em"))
            out = fr.pre_llm_call(platform="zalo", user_message="[An] giá vàng hôm nay")
            self.assertIn("https://a.vn", out["context"])
            self.assertEqual(run.call_count, 1)
            fr.pre_llm_call(platform="zalo", user_message="tỉ giá đô la")
            self.assertEqual(run.call_count, 1, "tỉ giá dùng công cụ riêng, không tra web")
        with mock.patch.object(reply_style, "load", return_value={**reply_style.DEFAULTS, "auto_lookup": False}):
            self.assertIsNone(fr.pre_llm_call(platform="zalo", user_message="giá vàng hôm nay"))

    def test_search_failure_still_demands_lookup(self):
        with mock.patch.object(fr, "_run", side_effect=TimeoutError()), \
                mock.patch.object(reply_style, "load", return_value={**reply_style.DEFAULTS}):
            self.assertIn("Gọi web_search", fr.pre_llm_call(platform="zalo", user_message="tin tức mới nhất về AI")["context"])

    def test_price_questions_about_ai_services_go_to_vendor_page(self):
        for q in ("check giá Qwen3 Codex", "giá claude sonnet 5 bao nhiêu", "chi phí API Gemini",
                  "bảng giá token bên mình thế nào", "how much does gpt cost"):
            self.assertEqual(fr.kind(q), "vendor_api", q)
        # Giá của thứ khác AI vẫn đi đường tra web thường, không đọc bảng giá dịch vụ.
        self.assertEqual(fr.kind("giá vàng hôm nay"), "web")
        self.assertEqual(fr.kind("giá xăng hôm nay"), "web")
        self.assertIsNone(fr.kind("đặt lịch nhắc giá token cho tôi"))

    LLMS = """# Caheo AI

## Models (113)

- `caheoai/qwen3-codex` — 2000 VND/1M tokens, ctx 256k
- `claude-sonnet-5-medium` — 14200 VND/1M tokens, ctx 1000k
- `gpt-5.6-luna` — 8800 VND/1M tokens, ctx 1050k
- `req/claude-fable-5` — 500 VND/request, ctx 1000k
- `google-omni-flash` — 3300 VND/request

- [cline](https://caheoai.com/docs/apps/cline): connect cline to Caheo AI
"""

    def test_parses_published_price_rows(self):
        rows = fr.parse_vendor_prices(self.LLMS)
        self.assertEqual([r["model"] for r in rows],
                         ["caheoai/qwen3-codex", "claude-sonnet-5-medium", "gpt-5.6-luna",
                          "req/claude-fable-5", "google-omni-flash"])
        self.assertEqual((rows[0]["price"], rows[0]["unit"], rows[0]["ctx"]), ("2000", "VND/1M tokens", "256k"))
        self.assertEqual(rows[3]["unit"], "VND/lượt", "giá theo lượt phải đọc ra đơn vị khác giá theo token")
        self.assertEqual(rows[4]["ctx"], "")

    def test_matches_the_model_asked_about(self):
        rows = fr.parse_vendor_prices(self.LLMS)
        hit, = fr.match_prices("check giá Qwen3 Codex", rows)
        self.assertEqual((hit["model"], hit["price"]), ("caheoai/qwen3-codex", "2000"))
        hit, = fr.match_prices("giá claude sonnet 5", rows)
        self.assertEqual(hit["model"], "claude-sonnet-5-medium")
        # Không nêu model → vài mức thấp nhất để trả lời "từ bao nhiêu tiền".
        cheapest = fr.match_prices("bảng giá thế nào", rows)
        self.assertEqual(cheapest[0]["price"], "500")
        self.assertLessEqual(len(cheapest), 3)

    def test_vendor_note_carries_prices_and_forbids_guessing(self):
        rows = fr.parse_vendor_prices(self.LLMS)
        note = fr.build_note("giá qwen3 codex", "vendor_api", fr.match_prices("giá qwen3 codex", rows), NOW)
        self.assertIn("lúc 18:13 12/10/2026", note)
        self.assertIn("caheoai/qwen3-codex — 2000 VND/1M tokens, ngữ cảnh 256k", note)
        self.assertIn("không suy ra giá", note)
        empty = fr.build_note("giá qwen3 codex", "vendor_api", [], NOW)
        self.assertIn("zalo_web_read", empty)

    def test_hook_attaches_live_prices_and_recovers_from_failure(self):
        with mock.patch.object(fr, "_read_vendor_pricing", return_value=self.LLMS) as read, \
                mock.patch.object(reply_style, "load", return_value={**reply_style.DEFAULTS}):
            out = fr.pre_llm_call(platform="zalo", user_message=self.PRICE_MSG)
            self.assertIn("caheoai/qwen3-codex — 2000 VND/1M tokens", out["context"])
            self.assertEqual(read.call_count, 1)
        with mock.patch.object(fr, "_read_vendor_pricing", side_effect=TimeoutError()), \
                mock.patch.object(reply_style, "load", return_value={**reply_style.DEFAULTS}):
            out = fr.pre_llm_call(platform="zalo", user_message=self.PRICE_MSG)
            self.assertIn("không đoán giá", out["context"])

    def test_reminder_tail_of_any_wording_does_not_bury_the_question(self):
        """Chủ bot đặt lời nhắc gì cũng được: câu hỏi lấy từ turn context, không phải dòng cuối tin."""
        reminders = (
            "PS: cần đọc kỹ file SOUL.MD trước khi suy nghĩ các câu trả lời",
            "Nhóm này là lớp 12A: xưng em, gọi các bạn là anh chị, không đưa đáp án bài kiểm tra",
            "Khi mọi người hỏi về dịch vụ API, em hãy tìm kiếm ở trang https://caheoai.com/ nhé",
        )
        with mock.patch.object(fr, "_read_vendor_pricing", return_value=self.LLMS), \
                mock.patch.object(fr, "_turn_question", return_value="giá qwen3 codex bao nhiêu"), \
                mock.patch.object(reply_style, "load", return_value={**reply_style.DEFAULTS}):
            for reminder in reminders:
                out = fr.pre_llm_call(platform="zalo", user_message=f"{self.PRICE_MSG}\n\n{reminder}")
                self.assertTrue(out, f"lời nhắc làm mất câu hỏi: {reminder[:40]}")
                self.assertIn("caheoai/qwen3-codex", out["context"])

    def test_question_falls_back_to_wording_when_turn_context_is_absent(self):
        with mock.patch.object(fr, "_read_vendor_pricing", return_value=self.LLMS), \
                mock.patch.object(fr, "_turn_question", return_value=""), \
                mock.patch.object(reply_style, "load", return_value={**reply_style.DEFAULTS}):
            out = fr.pre_llm_call(platform="zalo", user_message=self.PRICE_MSG)
            self.assertIn("caheoai/qwen3-codex", out["context"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
