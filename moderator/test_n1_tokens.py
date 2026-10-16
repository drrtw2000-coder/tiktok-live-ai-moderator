"""Offline regression tests for N1: placeholder tokens must authenticate nobody.

Run from the repo root:  py -m unittest moderator/test_n1_tokens.py
(or: python moderator/test_n1_tokens.py). No network, no sockets, no repo
writes - every case runs in a temp directory.
"""
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PLACEHOLDER = "changeme-generate-with-secrets-token_hex-32"
STRONG_A = "a" * 32 + "1" * 32
STRONG_B = "b" * 32 + "2" * 32
HEX64 = r"^[0-9a-f]{64}$"
SAMPLES = ["", "   ", PLACEHOLDER, "changeme-use-same-value-in-bridge-env",
           "CHANGEME-but-long-enough-to-pass-length", "short-token", STRONG_A]


def _load(path, name, env=None):
    saved = {k: os.environ.get(k) for k in (env or {})}
    os.environ.update(env or {})
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class TestServerTokenRule(unittest.TestCase):
    """Imports a private copy of server.py (its flags.db and .env live in a temp dir)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="n1srv-")
        for name in os.listdir(HERE):  # server.py + its sibling modules
            if name.endswith(".py") and not name.startswith("test_"):
                shutil.copy(os.path.join(HERE, name), cls.tmp)
        sys.path.insert(0, cls.tmp)
        cls.srv = _load(os.path.join(cls.tmp, "server.py"), "n1_server_copy",
                        {"API_TOKEN": PLACEHOLDER, "MOD_TOKEN": PLACEHOLDER,
                         "REQUIRE_AUTH": "1"})

    @classmethod
    def tearDownClass(cls):
        try:
            cls.srv.db.close()
        except Exception:
            pass
        if cls.tmp in sys.path:
            sys.path.remove(cls.tmp)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_weak_values(self):
        for tok in SAMPLES[:-1]:
            self.assertTrue(self.srv._weak_token(tok), repr(tok))
        self.assertFalse(self.srv._weak_token(STRONG_A))

    def test_placeholder_authenticates_nobody(self):
        # The N1 regression: before the fix this was True for anyone who
        # copied the placeholder out of the public repo.
        self.assertFalse(self.srv._check_token(PLACEHOLDER, PLACEHOLDER))
        self.assertFalse(self.srv._check_token(PLACEHOLDER, self.srv.API_TOKEN))
        self.assertFalse(self.srv._check_token(PLACEHOLDER, self.srv.MOD_TOKEN))

    def test_strong_token_still_authenticates(self):
        self.assertTrue(self.srv._check_token(STRONG_A, STRONG_A))
        self.assertFalse(self.srv._check_token(STRONG_B, STRONG_A))
        self.assertFalse(self.srv._check_token("", STRONG_A))

    def test_equal_tokens_fail_self_check(self):
        tmp = tempfile.mkdtemp(prefix="n1eq-")
        try:
            for name in os.listdir(HERE):
                if name.endswith(".py") and not name.startswith("test_"):
                    shutil.copy(os.path.join(HERE, name), tmp)
            sys.path.insert(0, tmp)
            srv2 = _load(os.path.join(tmp, "server.py"), "n1_server_eq",
                         {"API_TOKEN": STRONG_A, "MOD_TOKEN": STRONG_A,
                          "REQUIRE_AUTH": "1"})
            self.assertEqual(srv2.self_check(), 2)
        finally:
            try:
                srv2.db.close()
            except Exception:
                pass
            if tmp in sys.path:
                sys.path.remove(tmp)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_init_env_uses_the_same_rule(self):
        ie = _load(os.path.join(HERE, "init_env.py"), "n1_init_env_copy")
        for tok in SAMPLES:
            self.assertEqual(ie.weak(tok), self.srv._weak_token(tok), repr(tok))


class TestInitEnv(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="n1env-")
        self.mod = os.path.join(self.tmp, "moderator")
        self.up = os.path.join(self.tmp, "upstream")
        os.makedirs(self.mod)
        os.makedirs(self.up)
        shutil.copy(os.path.join(HERE, "init_env.py"), self.mod)
        shutil.copy(os.path.join(HERE, ".env.example"), self.path("mod"))
        shutil.copy(os.path.join(ROOT, "upstream", ".env.example"), self.path("up"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, which):
        return os.path.join(self.mod if which == "mod" else self.up, ".env")

    def raw(self, which):
        with open(self.path(which), encoding="utf-8") as f:
            return f.read()

    def vals(self, which):
        out = {}
        for line in self.raw(which).splitlines():
            s = line.strip()
            if s and not s.startswith("#") and "=" in s:
                k, _, v = s.partition("=")
                out.setdefault(k.strip(), v.strip())
        return out

    def put(self, which, **kv):
        text = self.raw(which)
        for k, v in kv.items():
            text, n = re.subn(rf"(?m)^{k}=.*$", f"{k}={v}", text)
            self.assertEqual(n, 1, k)
        with open(self.path(which), "w", encoding="utf-8") as f:
            f.write(text)

    def run_init(self):
        p = subprocess.run([sys.executable, os.path.join(self.mod, "init_env.py")],
                           capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

    def test_fresh_install_gets_real_synced_secrets(self):
        rc, out = self.run_init()
        self.assertEqual(rc, 0, out)
        m, u = self.vals("mod"), self.vals("up")
        self.assertRegex(m["API_TOKEN"], HEX64)
        self.assertRegex(m["MOD_TOKEN"], HEX64)
        self.assertNotEqual(m["API_TOKEN"], m["MOD_TOKEN"])
        self.assertEqual(u["API_TOKEN"], m["API_TOKEN"])
        self.assertEqual(u["TTLIVE_API_TOKEN"], m["API_TOKEN"])
        for secret in (m["API_TOKEN"], m["MOD_TOKEN"]):
            self.assertNotIn(secret, out)  # key names only, never values

    def test_idempotent_and_only_token_lines_change(self):
        before = self.raw("mod").splitlines()
        self.assertEqual(self.run_init()[0], 0)
        after = self.raw("mod").splitlines()
        self.assertEqual(len(before), len(after))
        changed = sorted(a.partition("=")[0] for a, b in zip(before, after) if a != b)
        self.assertEqual(changed, ["API_TOKEN", "MOD_TOKEN"])
        snapshot = (self.raw("mod"), self.raw("up"))
        rc, out = self.run_init()
        self.assertEqual(rc, 0, out)
        self.assertEqual((self.raw("mod"), self.raw("up")), snapshot)
        self.assertIn("nothing to do", out)

    def test_strong_values_are_kept(self):
        self.put("mod", API_TOKEN=STRONG_A, MOD_TOKEN=STRONG_B)
        self.put("up", API_TOKEN=STRONG_A, TTLIVE_API_TOKEN=STRONG_A)
        snapshot = (self.raw("mod"), self.raw("up"))
        rc, out = self.run_init()
        self.assertEqual(rc, 0, out)
        self.assertEqual((self.raw("mod"), self.raw("up")), snapshot)

    def test_moderator_adopts_strong_bridge_token(self):
        self.put("up", API_TOKEN=STRONG_A, TTLIVE_API_TOKEN=STRONG_A)
        rc, out = self.run_init()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.vals("mod")["API_TOKEN"], STRONG_A)
        self.assertRegex(self.vals("mod")["MOD_TOKEN"], HEX64)

    def test_mismatch_is_an_error(self):
        self.put("mod", API_TOKEN=STRONG_A, MOD_TOKEN=STRONG_B)
        self.put("up", API_TOKEN=STRONG_B)
        rc, out = self.run_init()
        self.assertEqual(rc, 2, out)
        self.assertEqual(self.vals("up")["API_TOKEN"], STRONG_B)  # user's value kept
        self.assertIn("conflict", out)

    def test_equal_tokens_get_mod_regenerated(self):
        self.put("mod", API_TOKEN=STRONG_A, MOD_TOKEN=STRONG_A)
        rc, out = self.run_init()
        self.assertEqual(rc, 0, out)
        m = self.vals("mod")
        self.assertRegex(m["MOD_TOKEN"], HEX64)
        self.assertNotEqual(m["MOD_TOKEN"], m["API_TOKEN"])
        self.assertIn("equal to API_TOKEN", out)

    def test_missing_moderator_env_is_an_error(self):
        os.remove(self.path("mod"))
        self.assertEqual(self.run_init()[0], 1)


if __name__ == "__main__":
    unittest.main()
