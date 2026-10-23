"""Build-time release snapshot and authenticated timeline regression."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_tasks import app_module
from deploy.site_updates_snapshot import create_snapshot
from modules import site_updates


class SiteUpdatesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "site-release.json"
        self.path_patch = patch.object(site_updates, "SNAPSHOT_PATH", self.path)
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)
        self.client = app_module.app.test_client()
        result = self.client.post("/login", json={"username": "admin", "password": "ci-test-password-only"})
        self.assertTrue(result.get_json()["ok"])

    def save(self, subject="feat: <script>alert(1)</script>", sha="a" * 40):
        self.path.write_text(json.dumps({
            "format": 1, "commit": sha, "built_at": "2026-10-23T08:00:00+00:00",
            "commits": [{"sha": sha, "date": "2026-10-23T09:22:00+08:00",
                         "subject": subject, "author": "Tester"}],
        }), encoding="utf-8")

    def test_anonymous_access_is_protected(self):
        guest = app_module.app.test_client()
        self.assertEqual(guest.get("/api/site-release").status_code, 401)
        self.assertEqual(guest.get("/updates").status_code, 302)

    def test_missing_and_invalid_snapshot_are_safe(self):
        for content in (None, "{invalid-json", '{"format":1,"commit":"bad","commits":[]}'):
            with self.subTest(content=content):
                if content is None:
                    self.path.unlink(missing_ok=True)
                else:
                    self.path.write_text(content, encoding="utf-8")
                resp = self.client.get("/api/site-release")
                self.assertEqual(resp.status_code, 200)
                self.assertFalse(resp.get_json()["available"])
                self.assertIn("no-store", resp.headers["Cache-Control"])
                self.assertEqual(self.client.get("/updates").status_code, 200)

    def test_timeline_escapes_commit_messages_and_links_to_commit(self):
        self.save()
        resp = self.client.get("/updates")
        body = resp.get_data(as_text=True)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", body)
        self.assertNotIn("<script>alert(1)</script>", body)
        self.assertIn("https://github.com/SHM-white/xtyf-manager/commit/" + "a" * 40, body)
        self.assertIn("2026-10-23", body)
        data = self.client.get("/api/site-release").get_json()
        self.assertTrue(data["available"])
        self.assertEqual(data["commit"], "a" * 40)

    def test_announcement_is_present_in_shared_shell(self):
        self.save()
        response = self.client.get("/")
        body = response.get_data(as_text=True)
        self.assertIn("data-site-update-banner", body)
        self.assertIn("/static/site-updates.js", body)
        self.assertIn('href="/updates"', body)


class BuildSnapshotTest(unittest.TestCase):
    def test_git_history_is_bounded_and_belongs_to_release_head(self):
        sha = "a" * 40
        line = sha + "\x1f2026-10-23T10:00:00+08:00\x1fTest author\x1ffeat: update banner\x1e\n"
        with patch("deploy.site_updates_snapshot.subprocess.check_output", return_value=line.encode()) as execute:
            payload = json.loads(create_snapshot(Path("/fake"), sha))
        self.assertEqual(payload["format"], 1)
        self.assertEqual(payload["commit"], sha)
        self.assertEqual(payload["commits"][0]["subject"], "feat: update banner")
        self.assertIn("--max-count=200", execute.call_args.args[0])
        self.assertEqual(execute.call_args.kwargs["cwd"], Path("/fake"))

    def test_mismatched_history_fails_closed(self):
        sha = "b" * 40
        other = "a" * 40
        line = other + "\x1f2026-10-23T10:00:00+08:00\x1fTest\x1ffix\x1e"
        with patch("deploy.site_updates_snapshot.subprocess.check_output", return_value=line.encode()):
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                create_snapshot(Path("/fake"), sha)


if __name__ == "__main__":
    unittest.main()
