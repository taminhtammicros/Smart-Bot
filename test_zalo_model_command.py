import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = os.path.dirname(__file__)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gateway.config import PlatformConfig
import zalo_test_env  # noqa: E402,F401  (cho "zalo" là nền tảng hợp lệ)
import plugins
import plugins.platforms

# Giống test_zalo_adapter.py: test plugin trong repo, dùng lõi Hermes đã cài.
plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
plugins.platforms.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.platforms.__path__)]
from plugins.platforms.zalo import adapter as zalo_adapter
from plugins.platforms.zalo import model_command
from plugins.zalo_tools import tools as zalo_tools

CONFIG = (
    "# cấu hình viết tay\r\n"
    "model:\r\n"
    "  default: hermes  # combo chính\r\n"
    "  provider: custom\r\n"
    "  base_url: http://127.0.0.1:20128/v1\r\n"
    "  api_key: sk-test\r\n"
    "fallback:\r\n"
    "  default: khong-duoc-dung\r\n"
)
AVAILABLE = ["hermes", "ag/gemini-3.8-flash-medium", "ag/claude-opus-4-6-thinking", "cx/gpt-5.6-terra"]


class ModelCommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Path(self.tmp.name) / "config.yaml"
        self.config.write_bytes(CONFIG.encode("utf-8"))

    def tearDown(self):
        self.tmp.cleanup()

    def run_cmd(self, args, choices=(), default="hermes", fetch=lambda _p: list(AVAILABLE)):
        return model_command.handle(args, config_path=self.config, choices=list(choices),
                                    default=default, fetch=fetch)

    def test_parse_only_matches_model_command(self):
        self.assertEqual(model_command.parse(" /model "), "")
        self.assertEqual(model_command.parse("/MODEL list all"), "list all")
        self.assertIsNone(model_command.parse("/models"))
        self.assertIsNone(model_command.parse("đổi /model đi"))

    def test_show_current(self):
        self.assertIn("Model đang dùng: hermes", self.run_cmd(""))

    def test_switch_rewrites_only_model_default_line(self):
        reply = self.run_cmd("ag/claude-opus-4-6-thinking")
        self.assertIn("Đã đổi cả bot sang ag/claude-opus-4-6-thinking", reply)
        expected = CONFIG.replace("default: hermes  #", "default: ag/claude-opus-4-6-thinking  #")
        self.assertEqual(self.config.read_bytes().decode("utf-8"), expected)
        self.assertEqual(model_command.current_model(self.config), "ag/claude-opus-4-6-thinking")

    def test_default_goes_back(self):
        self.run_cmd("cx/gpt-5.6-terra")
        self.assertIn("Đã đổi cả bot sang hermes", self.run_cmd("default"))
        self.assertEqual(self.config.read_bytes().decode("utf-8"), CONFIG)

    def test_default_unset_explains(self):
        self.assertIn("ZALO_MODEL_DEFAULT", self.run_cmd("default", default=""))

    def test_unknown_model_is_refused_with_suggestion(self):
        reply = self.run_cmd("ag/gemini-3.8-flash-medum")
        self.assertIn("Không có model", reply)
        self.assertIn("ag/gemini-3.8-flash-medium", reply)
        self.assertEqual(self.config.read_bytes().decode("utf-8"), CONFIG)

    def test_endpoint_down_does_not_switch(self):
        def boom(_path):
            raise OSError("connection refused")
        self.assertIn("chưa đổi", self.run_cmd("cx/gpt-5.6-terra", fetch=boom))
        self.assertEqual(self.config.read_bytes().decode("utf-8"), CONFIG)

    def test_same_model_is_a_no_op(self):
        self.assertIn("đang dùng hermes rồi", self.run_cmd("hermes"))

    def test_list_uses_choices_and_marks_current_and_default(self):
        reply = self.run_cmd("list", choices=["hermes", "ag/claude-opus-4-6-thinking"])
        self.assertIn("1. hermes (đang dùng, mặc định)", reply)
        self.assertIn("2. ag/claude-opus-4-6-thinking", reply)
        self.assertNotIn("cx/gpt-5.6-terra", reply)

    def test_list_all_and_filter(self):
        self.assertIn("Tất cả model (4)", self.run_cmd("list all", choices=["hermes"]))
        reply = self.run_cmd("list claude")
        self.assertIn("ag/claude-opus-4-6-thinking", reply)
        self.assertNotIn("cx/gpt-5.6-terra", reply)

    def test_natural_phrases_for_owner(self):
        cases = {"model list": "list", "Danh sách model": "list", "@Lăng Tiêu ds model": "list",
                 "xem model claude": "list claude", "model 3": "3", "chọn model 3": "3", "Đổi model 12": "12",
                 "model mặc định": "default"}
        for text, args in cases.items():
            self.assertEqual(model_command.parse_natural(text), args, text)
        for text in ("model là gì", "danh sách học sinh", "giải thích model AI", "model"):
            self.assertIsNone(model_command.parse_natural(text), text)

    def test_pick_by_number_from_last_list(self):
        self.run_cmd("list claude")   # hiện: 1. ag/claude-opus-4-6-thinking
        self.assertIn("Đã đổi cả bot sang ag/claude-opus-4-6-thinking", self.run_cmd("1"))
        self.assertEqual(model_command.current_model(self.config), "ag/claude-opus-4-6-thinking")
        self.assertIn("Không có model số 9", self.run_cmd("9"))

    def test_pinned_note_names_groups_that_will_not_follow(self):
        """Nhóm ghim model riêng không đổi theo /model — câu trả lời phải nói ra, kèm mã nhóm và tên model."""
        with tempfile.TemporaryDirectory() as home:
            perm = Path(home, "permissions.json")
            perm.write_text(json.dumps({"version": 1, "groups": {
                "2054797107487294899": {"modelOverride": "Kira/glm-5.3"},
                "2054797107487294811": {"modelOverride": "hermes"},
            }}), encoding="utf-8")
            import os as _os
            with patch.dict(_os.environ, {"ZALO_PERMISSIONS_FILE": str(perm)}):
                # Đổi sang model X: nhóm ghim đúng X không được nhắc, nhóm ghim model khác thì phải nói ra.
                to_hermes = model_command._pinned_note("hermes")
                to_kira = model_command._pinned_note("Kira/glm-5.3")
                to_other = model_command._pinned_note("cx/gpt-5.4")
        self.assertIn("2054797107487294899", to_hermes)
        self.assertIn("Kira/glm-5.3", to_hermes)
        self.assertIn("KHÔNG đổi theo", to_hermes)
        self.assertNotIn("2054797107487294811", to_hermes, "nhóm ghim đúng model mới không cần nhắc")
        self.assertIn("2054797107487294811", to_kira, "đổi sang model khác thì nhóm kia cũng phải nhắc")
        self.assertNotIn("2054797107487294899", to_kira, "nhóm đang ghim đúng model mới không cần nhắc")
        self.assertIn("hermes", to_other)
        self.assertIn("2054797107487294899", to_other)

    def test_pinned_note_survives_a_broken_permissions_file(self):
        with tempfile.TemporaryDirectory() as home:
            perm = Path(home, "permissions.json")
            perm.write_text("{ hỏng", encoding="utf-8")
            import os as _os
            with patch.dict(_os.environ, {"ZALO_PERMISSIONS_FILE": str(perm)}):
                self.assertEqual(model_command._pinned_note("hermes"), "")

    def test_fetch_models_reads_endpoint_from_config(self):
        seen = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return json.dumps({"data": [{"id": "a"}, {"id": "b"}]}).encode()

        def fake_urlopen(request, timeout):
            seen["url"] = request.full_url
            seen["auth"] = request.get_header("Authorization")
            return FakeResponse()

        with patch.object(model_command.urllib.request, "urlopen", fake_urlopen):
            self.assertEqual(model_command.fetch_models(self.config), ["a", "b"])
        self.assertEqual(seen, {"url": "http://127.0.0.1:20128/v1/models", "auth": "Bearer sk-test"})


class ZaloModelCommandAdapterTest(unittest.IsolatedAsyncioTestCase):
    OWNER = "1111111111111111111"

    def make_adapter(self):
        adapter = zalo_adapter.ZaloAdapter(PlatformConfig(enabled=True, extra={
            "bridge_url": "ws://127.0.0.1:9", "reply_only_tagged": True, "ack_gestures": False,
            "model_choices": ["hermes", "ag/claude-opus-4-6-thinking"], "model_default": "hermes",
        }))
        adapter._self_profile = {"user_id": "bot-uid", "display_name": "Lăng Tiêu"}
        adapter._flood.check = lambda _uid: None
        self.forwarded, self.sent = [], []

        async def handle(event):
            self.forwarded.append(event)

        async def fake_command(command, expect_ack=False):
            self.sent.append(command)
            return {"ok": True, "msgId": "reply-1"}

        adapter.handle_message = handle
        adapter._command = fake_command
        return adapter

    def frame(self, uid, text):
        return {"type": "message", "id": f"m-{uid}-{len(text)}", "threadId": "group-1",
                "threadType": zalo_adapter.THREAD_TYPE_GROUP, "senderUid": uid,
                "senderName": uid, "text": text, "mentions": [{"uid": "bot-uid"}]}

    async def run_frame(self, uid, text, home):
        adapter = self.make_adapter()
        with patch.object(adapter, "_is_owner", side_effect=lambda u: u == self.OWNER), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools), \
                patch("hermes_constants.get_hermes_home", return_value=Path(home)):
            await adapter._on_message(self.frame(uid, text))

    async def test_owner_gets_answer_and_command_never_reaches_hermes(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, "config.yaml").write_text(CONFIG, encoding="utf-8")
            await self.run_frame(self.OWNER, "@Lăng Tiêu /model list", home)
        self.assertEqual(self.forwarded, [])
        self.assertEqual(len(self.sent), 1)
        self.assertIn("ag/claude-opus-4-6-thinking", self.sent[0]["text"])

    async def test_stranger_model_command_is_dropped(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, "config.yaml").write_text(CONFIG, encoding="utf-8")
            await self.run_frame("2222222222222222222", "@Lăng Tiêu /model ag/claude-opus-4-6-thinking", home)
            self.assertEqual(model_command.current_model(Path(home, "config.yaml")), "hermes")
        self.assertEqual(self.forwarded, [])
        self.assertEqual(self.sent, [])


    async def test_owner_natural_list_and_stranger_natural_goes_to_assistant(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, "config.yaml").write_text(CONFIG, encoding="utf-8")
            await self.run_frame(self.OWNER, "danh sách model", home)
        self.assertEqual(self.forwarded, [])
        self.assertIn("1. hermes", self.sent[-1]["text"])
        sent_before = len(self.sent)
        with tempfile.TemporaryDirectory() as home:
            Path(home, "config.yaml").write_text(CONFIG, encoding="utf-8")
            await self.run_frame("2222222222222222222", "danh sách model", home)
        self.assertEqual(len(self.forwarded), 1, "người khác hỏi thì trợ lý trả lời như tin thường")
        self.assertEqual(len([c for c in self.sent[sent_before:] if "1. hermes" in str(c.get("text"))]), 0)

if __name__ == "__main__":
    unittest.main()
