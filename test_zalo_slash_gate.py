"""Sự cố 20/10 23:33 — thành viên nhóm gõ ``/new`` và phiên của chính họ bị xoá.

Log ghi: ``Cá Heo - Ai (4518453571817811773): @Minh Luan /new`` → gateway xoá phiên.
UID đó không có trong ``ZALO_ALLOWED_USERS``, nên nguyên nhân là bộ lọc lệnh gạch chéo
của Hermes: gating chỉ bật khi ``allow_admin_from`` không rỗng, mà adapter lại trả danh
sách rỗng cho người ngoài — thành ra gating tắt và ai cũng là admin.

Tệp này giữ cả hai lớp: cấu hình gửi cho gateway (phải luôn có danh sách admin khác
rỗng, hoặc danh sách lệnh khác rỗng, để gating bật) và cửa chặn ngay tại adapter
(không phụ thuộc bản cấu hình mà tiến trình gateway đang giữ).
"""

import os
import sys
import unittest

ROOT = os.path.dirname(__file__)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gateway.config import PlatformConfig  # noqa: E402
from gateway.slash_access import policy_from_extra  # noqa: E402
import zalo_test_env  # noqa: E402,F401
import plugins  # noqa: E402
import plugins.platforms  # noqa: E402

plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
plugins.platforms.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.platforms.__path__)]
from plugins.platforms.zalo import adapter as zalo_adapter  # noqa: E402

OWNER = "8022000000000000001"
STRANGER = "4518453571817811773"


class SlashGateTest(unittest.TestCase):
    def setUp(self):
        self._prev = os.environ.get("ZALO_ALLOWED_USERS")
        os.environ["ZALO_ALLOWED_USERS"] = OWNER

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("ZALO_ALLOWED_USERS", None)
        else:
            os.environ["ZALO_ALLOWED_USERS"] = self._prev

    def make_adapter(self, extra=None):
        config = PlatformConfig(enabled=True, extra=extra or {"bridge_url": "ws://127.0.0.1:9"})
        adapter = zalo_adapter.ZaloAdapter(config)
        adapter._self_profile = {"user_id": "bot-uid", "display_name": "Lăng Tiêu"}
        return adapter, config

    def test_config_sent_to_gateway_never_leaves_gating_off(self):
        # Chỉ có danh sách chủ nhân: người ngoài không được coi là admin, và danh sách
        # lệnh cho họ không rỗng (rỗng thì Hermes tắt gating ở scope đó).
        _, config = self.make_adapter()
        extra = config.extra
        self.assertEqual(extra["allow_admin_from"](), [OWNER])
        self.assertEqual(sorted(extra["user_allowed_commands"]()), ["help", "whoami"])
        self.assertEqual(sorted(extra["group_user_allowed_commands"]()), ["help", "whoami"])

        group_policy = policy_from_extra(
            {
                "group_allow_admin_from": extra["group_allow_admin_from"](),
                "group_user_allowed_commands": extra["group_user_allowed_commands"](),
            },
            "group",
        )
        self.assertTrue(group_policy.enabled)
        self.assertFalse(group_policy.can_run(STRANGER, "new"), "/new của người ngoài bị chặn")
        self.assertTrue(group_policy.can_run(OWNER, "new"), "chủ nhân vẫn dùng /new")

    def test_adapter_blocks_hermes_slash_commands_from_non_owners(self):
        adapter, _ = self.make_adapter()
        for text in ("/new", "/clear", "/reset", "/stop", "/compress"):
            reply = adapter._blocked_slash(text, STRANGER)
            self.assertTrue(reply, f"{text} phải bị chặn")
            self.assertIn("chủ nhân", reply)
        self.assertIn("không có quyền", adapter._blocked_slash("/model gpt", STRANGER))
        self.assertIn("không có quyền", adapter._blocked_slash("/remember uống nước", STRANGER))

    def test_adapter_lets_read_only_commands_and_owners_through(self):
        adapter, _ = self.make_adapter()
        for text in ("/help", "/whoami", "/status", "/context"):
            self.assertIsNone(adapter._blocked_slash(text, STRANGER), text)
        self.assertIsNone(adapter._blocked_slash("/new", OWNER), "chủ nhân vẫn mở phiên mới được")
        self.assertIsNone(adapter._blocked_slash("hôm nay thế nào", STRANGER), "câu thường không bị đụng")


if __name__ == "__main__":
    unittest.main()
