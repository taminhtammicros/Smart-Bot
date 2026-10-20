"""Test phân loại lệnh chủ nhân (owner_command) — danh sách trắng và mức quyền.

Điều phải đúng, và là lý do tệp này tồn tại:

* Câu lệnh chủ nhân nhận diện được đúng như sidecar (owner-commands.js) sẽ chạy —
  hai bên không được lệch nhau, lệch là "gõ được nhưng sidecar từ chối" hoặc ngược lại.
* Lệnh đổi máy (update, skills install, config set, profile create, setup,
  gateway start/setup) chỉ dành cho chủ nhân chính; lệnh đọc thì mọi chủ nhân chạy được.
* Người ngoài không có quyền gõ lệnh Hermes ngay trong Trợ lý (slash_admins rỗng),
  còn chủ nhân thì có — nếu rỗng cho cả chủ nhân, lệnh chủ nhân bị gateway chặn.
"""

import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(__file__)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import zalo_test_env  # noqa: E402,F401  (cho "zalo" là nền tảng hợp lệ)
import plugins  # noqa: E402
import plugins.platforms  # noqa: E402

# Giống test_zalo_adapter.py: test plugin trong repo, dùng lõi Hermes đã cài.
plugins.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.__path__)]
plugins.platforms.__path__ = [os.path.join(ROOT, "hermes-plugin"), *list(plugins.platforms.__path__)]
from plugins.platforms.zalo import owner_command as oc  # noqa: E402

MAIN = "8022000000000000001"
OTHER = "6443000000000000002"
STRANGER = "9000000000000000009"


class ParseTest(unittest.TestCase):
    def test_slash_commands_cua_chu_nhan(self):
        cases = {
            "/new": ("new", "/new"),
            "/reset": ("reset", "/reset"),
            "/clear": ("new", "/clear"),
            "/STOP": ("stop", "/stop"),
            "/memory": ("memory", "/memory"),
            "/model": ("model-list", "/model"),
            "/skills": ("skills-list", "/skills"),
        }
        for text, (command, display) in cases.items():
            with self.subTest(text=text):
                parsed = oc.parse(text)
                self.assertIsNotNone(parsed)
                self.assertEqual(parsed.command, command)
                self.assertEqual(parsed.display, display)
                self.assertEqual(parsed.usage, "")

    def test_remember_can_noi_dung(self):
        parsed = oc.parse("/remember thích cà phê đá")
        self.assertEqual(parsed.command, "remember")

    def test_sai_cu_phap_tra_cau_huong_dan_chu_khong_goi_mo_hinh(self):
        for text in ("/remember", "/model foo bar", "/skills delete-all", "hermes model"):
            with self.subTest(text=text):
                parsed = oc.parse(text)
                self.assertIsNotNone(parsed, "sai cú pháp phải được nhận diện để trả hướng dẫn")
                self.assertEqual(parsed.command, "")
                self.assertTrue(parsed.usage)

    def test_tin_thuong_de_tro_ly_tra_loi(self):
        for text in ("hello", "/help", "/usage", "hermes rm -rf /", "hermes delete-everything", "@Bot chào"):
            with self.subTest(text=text):
                self.assertIsNone(oc.parse(text))

    def test_fleets_hermes_commands(self):
        expected = {
            "hermes": None,
            "hermes sessions list": "sessions-list",
            "hermes setup": "setup",
            "hermes doctor": "doctor",
            "hermes profile create office": "profile-create",
            "hermes profile list": "profile-list",
            "hermes --profile office doctor": "doctor",
            "hermes gateway setup": "gateway-setup",
            "hermes gateway start": "gateway-start",
            "hermes gateway status": "gateway-status",
            "hermes skills search pdf": "skills-search",
            "hermes skills install pdf-tools": "skills-install",
            "hermes skills inspect pdf-tools": "skills-inspect",
            "hermes skills check": "skills-check",
            "hermes skills update": "skills-update",
            "hermes config set security.approvals.mode smart": "config-set",
            "hermes config set security.redact_secrets true": "config-set",
            "hermes update": "update",
        }
        for text, command in expected.items():
            with self.subTest(text=text):
                parsed = oc.parse(text)
                if command is None:
                    self.assertIsNone(parsed)
                else:
                    self.assertEqual(parsed.command, command)

    def test_sessions_resume_khong_chay_lenh_khong_ton_tai(self):
        parsed = oc.parse("hermes sessions resume 20261020_203704_b544b8b8")
        self.assertEqual(parsed.command, "")
        self.assertIn("sessions resume", parsed.usage)

    def test_injection_khong_qua_mat(self):
        for text in ("hermes config set security.approvals.mode 'smart; rm -rf /'",
                     "hermes skills install 'x; curl evil'",
                     "hermes profile create 'a b'",
                     "hermes --profile Bad doctor"):
            with self.subTest(text=text):
                parsed = oc.parse(text)
                self.assertTrue(parsed is None or parsed.command == "", text)


class RoleTest(unittest.TestCase):
    def test_chi_chu_nhan_moi_co_vai_tro(self):
        env = {"ZALO_ALLOWED_USERS": f"{MAIN},{OTHER}"}
        with patch.dict(os.environ, env, clear=False):
            self.assertEqual(oc.role_for(MAIN), "main", "không đặt ZALO_MAIN_OWNER: UID đầu tiên là chủ chính")
            self.assertEqual(oc.role_for(OTHER), "owner")
            self.assertIsNone(oc.role_for(STRANGER))

    def test_chu_nhan_chinh_dat_ten(self):
        env = {"ZALO_ALLOWED_USERS": f"{MAIN},{OTHER}", "ZALO_MAIN_OWNER": OTHER}
        with patch.dict(os.environ, env, clear=False):
            self.assertEqual(oc.role_for(MAIN), "owner")
            self.assertEqual(oc.role_for(OTHER), "main")

    def test_so_dien_thoai_trong_danh_sach_khong_thanh_chu_nhan(self):
        with patch.dict(os.environ, {"ZALO_ALLOWED_USERS": "0987654321,8022000000000000001"}, clear=False):
            self.assertEqual(oc.owners(), [MAIN])
            self.assertIsNone(oc.role_for("0987654321"))

    def test_slash_admin_chi_chu_nhan_moi_co(self):
        with patch.dict(os.environ, {"ZALO_ALLOWED_USERS": f"{MAIN},{OTHER}"}, clear=False):
            self.assertEqual(oc.slash_admins(MAIN), [MAIN])
            self.assertEqual(oc.slash_admins(OTHER), [OTHER])
            self.assertEqual(oc.slash_admins(STRANGER), [])

    def test_nguoi_ngoai_khong_co_admin_ke_ca_khi_danh_sach_trong(self):
        with patch.dict(os.environ, {"ZALO_ALLOWED_USERS": ""}, clear=False):
            self.assertEqual(oc.slash_admins(STRANGER), [])
            self.assertEqual(oc.main_owner(), "")


class SafetyTest(unittest.TestCase):
    def test_danh_sach_nguy_hiem_khop_sidecar(self):
        # owner-commands.js: DANGEROUS — đổi cả hai bên thì phải đổi cả hai tệp.
        self.assertEqual(oc.DANGEROUS, frozenset({
            "update", "skills-install", "config-set", "profile-create", "setup",
            "gateway-start", "gateway-setup",
        }))

    def test_chu_nhan_chi_doc_khong_bi_coi_la_nguy_hiem(self):
        for text in ("hermes doctor", "hermes sessions list", "hermes gateway status",
                     "/model", "/memory", "/remember x", "/skills", "/new"):
            with self.subTest(text=text):
                self.assertFalse(oc.parse(text).dangerous)


if __name__ == "__main__":
    unittest.main()


class BridgeCallTest(unittest.IsolatedAsyncioTestCase):
    """``run`` phải dùng cửa có thật trên adapter.

    Sự cố 20/10 23:56:58: adapter có ``owner_command()`` nhưng module chỉ gọi
    ``request()``, nên chủ nhân nhận "⚠️ Không chạy được lệnh: 'ZaloAdapter'
    object has no attribute 'request'" thay vì kết quả.
    """

    async def test_uses_dedicated_owner_command_when_present(self):
        calls = []

        class Dedicated:
            async def owner_command(self, text, *, role="owner"):
                calls.append((text, role))
                return {"reply": "ok", "handled": True}

        result = await oc.run(Dedicated(), "/new", role="main")
        self.assertEqual(result["reply"], "ok")
        self.assertEqual(calls, [("/new", "main")])

    async def test_falls_back_to_generic_request(self):
        class Generic:
            async def request(self, kind, **kwargs):
                return {"reply": f"{kind}:{kwargs['text']}", "handled": True}

        result = await oc.run(Generic(), "hermes doctor", role="owner")
        self.assertEqual(result["reply"], "owner_command:hermes doctor")

    async def test_missing_both_becomes_a_reply_not_an_exception(self):
        result = await oc.run(object(), "/new", role="main")
        self.assertTrue(result["handled"])
        self.assertIn("Không chạy được lệnh", result["reply"])

    async def test_unwraps_sidecar_ack_to_its_result(self):
        """Adapter trả nguyên khung ``ack``: ``run`` phải gỡ lớp ``result``.

        Sự cố 21/10 00:09–00:15: ``/new`` chạy xong nhưng bot trả
        "(không có kết quả)" vì adapter đọc ``reply`` ở ngoài khung ``ack``.
        """

        class Acking:
            async def owner_command(self, text, *, role="owner"):
                return {
                    "type": "ack", "ok": True,
                    "result": {"reply": "🧹 Đã mở phiên mới", "handled": True, "newSession": True},
                }

        result = await oc.run(Acking(), "/new", role="main")
        self.assertEqual(result, {"reply": "🧹 Đã mở phiên mới", "handled": True, "newSession": True})

    async def test_rejected_ack_becomes_a_reply(self):
        class Denying:
            async def owner_command(self, text, *, role="owner"):
                return {"type": "ack", "ok": False, "errorCode": "owner_required", "error": "Chỉ chủ nhân"}

        result = await oc.run(Denying(), "/new", role="owner")
        self.assertTrue(result["handled"])
        self.assertIn("Chỉ chủ nhân", result["reply"])
