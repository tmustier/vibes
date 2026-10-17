"""Real CLI uploads to an isolated HTTP receiver; no external services or credentials."""
import hashlib
import json
import os
import shutil
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import test_inventory

SCRIPT = test_inventory.SCRIPT


class DestinationTests(test_inventory.InventoryFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.documents, self.requests, self.failures = {}, [], {}
        self.conflict_once = False
        self.use_etag = True
        owner = self

        class Receiver(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, data=b"", **headers):
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                owner.requests.append(("GET", self.path, dict(self.headers), b""))
                failure = owner.failures.get(self.path, owner.failures.get("*"))
                if failure:
                    self.reply(failure, Location=owner.url + "/redirected")
                elif self.path in owner.documents:
                    data = owner.documents[self.path]
                    self.reply(200, data, **({"ETag": hashlib.sha256(data).hexdigest()} if owner.use_etag else {}))
                else:
                    self.reply(404)

            def do_PUT(self):
                data = self.rfile.read(int(self.headers["Content-Length"]))
                owner.requests.append(("PUT", self.path, dict(self.headers), data))
                if owner.conflict_once:
                    owner.conflict_once = False
                    owner.documents[self.path] += b"Concurrent entry.\n"
                    self.reply(412)
                    return
                current = owner.documents.get(self.path)
                if self.headers.get("If-None-Match") == "*" and current is not None:
                    self.reply(412)
                elif self.headers.get("If-Match") and self.headers["If-Match"] != hashlib.sha256(current).hexdigest():
                    self.reply(412)
                else:
                    owner.documents[self.path] = data
                    self.reply(204)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        super().tearDown()

    def configure(self, config):
        (self.agent / "settings.json").write_text(json.dumps({"telemetryDestination": config}))

    def http(self, **fields):
        return {"type": "http", "url": self.url + "/telemetry", "identity": "home-user", **fields}

    def command(self, *args):
        return subprocess.run(args, env={**os.environ, "PI_CODING_AGENT_DIR": str(self.agent),
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"]}, text=True, capture_output=True)

    def test_null_destination_never_queries_github(self):
        self.configure(None)
        result = self.run_cli("send")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("local-only", result.stdout)
        self.assertFalse(self.gh_calls.exists())
        self.assertFalse(self.requests)

    def session(self, date="2026-01-01"):
        sessions = self.agent / "sessions"
        sessions.mkdir(exist_ok=True)
        path = sessions / f"{date}.jsonl"
        path.write_text(json.dumps({"type": "session", "id": date, "version": 3}) + "\n" + json.dumps({
            "type": "message", "id": "a", "timestamp": date + "T00:00:00Z", "message": {
                "role": "assistant", "provider": "openai-codex", "model": "gpt-6.1-sol",
                "content": [{"type": "text", "text": "PRIVATE_SYNTHETIC_PROMPT"}],
                "usage": {"input": 10, "output": 2, "totalTokens": 12}}}) + "\n")

    def test_distribution_default_and_personal_override(self):
        distribution = self.agent.parent / "distribution"
        (distribution / "scripts").mkdir(parents=True)
        (distribution / "lib").mkdir()
        shutil.copy2(SCRIPT.parent / "usage-telemetry", distribution / "scripts/usage-telemetry")
        shutil.copy2(SCRIPT.parent.parent / "lib/telemetry_destination.py", distribution / "lib")
        template = distribution / "settings.template.json"
        self.session()
        script = str(distribution / "scripts/usage-telemetry")
        (self.agent / "settings.json").write_text("{}")
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertFalse(self.requests)
        template.write_text(json.dumps({"telemetryDestination": self.http()}))
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertEqual(len(self.documents), 1)
        self.configure(self.http(url=self.url + "/personal"))
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertEqual(len(self.documents), 2)
        self.configure(None)
        self.requests.clear()
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertFalse(self.requests)
        self.assertFalse(self.gh_calls.exists())

    def test_http_inventory_is_redacted_and_deduplicated_without_github(self):
        self.configure(self.http(tokenEnv="TEST_TELEMETRY_TOKEN"))
        with patch.dict(os.environ, TEST_TELEMETRY_TOKEN="synthetic-test-credential"):
            for _ in range(2):
                result = self.run_cli("send")
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        puts = [r for r in self.requests if r[0] == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0][1], "/telemetry/people/home-user.json")
        self.assertEqual(puts[0][2]["Authorization"], "Bearer synthetic-test-credential")
        body = json.loads(puts[0][3])
        self.assertIn("[redacted email]", body["skills"][0]["text"])
        self.assertNotIn("synthetic-test-credential", puts[0][3].decode())
        self.assertFalse(self.gh_calls.exists())

    def test_reports_append_and_preserve_concurrent_writes(self):
        self.configure(self.http())
        for summary in ("First fix.", "Second fix."):
            self.conflict_once = summary.startswith("Second")
            result = self.command(str(SCRIPT), "report", "/synthetic/session.jsonl", summary)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        text = self.documents["/telemetry/reports/home-user.md"].decode()
        for value in ("First fix.", "Second fix.", "Concurrent entry."):
            self.assertEqual(text.count(value), 1)
        self.assertFalse(self.gh_calls.exists())

    def test_auth_failure_and_redirect_never_fall_back_or_leak_credentials(self):
        self.configure(self.http(tokenEnv="TEST_TELEMETRY_TOKEN"))
        with patch.dict(os.environ, TEST_TELEMETRY_TOKEN="synthetic-test-credential"):
            for status in (401, 403, 302, 503):
                self.failures["/telemetry/people/home-user.json"] = status
                result = self.run_cli("send")
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("synthetic-test-credential", result.stdout + result.stderr)
        self.assertFalse(self.gh_calls.exists())
        self.assertFalse(any(r[1] == "/redirected" or r[0] == "PUT" for r in self.requests))

    def test_existing_receiver_without_etags_updates_sequentially(self):
        self.configure(self.http())
        self.use_etag = False
        self.assertEqual(self.run_cli("send").returncode, 0)
        raw = json.loads(self.raw.read_text())
        raw["thinking"] = "high"
        self.raw.write_text(json.dumps(raw))
        self.assertEqual(self.run_cli("send").returncode, 0)
        puts = [r for r in self.requests if r[0] == "PUT"]
        self.assertEqual(len(puts), 2)
        self.assertNotIn("If-Match", puts[-1][2])
        self.assertEqual(json.loads(puts[-1][3])["thinking"], "high")

    def test_github_repository_and_identity_are_configurable(self):
        self.configure({"type": "github", "repository": "example/personal", "identity": "home-user"})
        stored = self.agent / "uploaded.json"
        (self.bin / "gh").write_text(f'''#!/usr/bin/env python3
import base64, json, sys
from pathlib import Path
assert "user" not in sys.argv
assert any(arg.startswith("repos/example/personal/contents/usage/home-user/") for arg in sys.argv)
if "PUT" in sys.argv:
    Path({str(stored)!r}).write_bytes(base64.b64decode(json.load(sys.stdin)["content"]))
else:
    sys.exit(1)
''')
        self.session()
        result = self.command(str(SCRIPT.parent / "usage-telemetry"), "send")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("example/personal/usage/home-user/", result.stdout)
        document = json.loads(stored.read_text())
        self.assertEqual(document["sender"], "home-user")
        self.assertNotIn("githubLogin", document)
        self.assertFalse(self.requests)

    def test_unset_token_invalid_config_and_opt_out_send_nothing(self):
        configs = [self.http(tokenEnv="UNSET_TELEMETRY_TEST_TOKEN"), self.http(identity="../escape"),
            self.http(url=12), self.http(identity=""), {"type": "http"}, {"type": "github"},
            {"type": "unknown"}, self.http(token="do-not-store-inline")]
        for config in configs:
            self.configure(config)
            result = self.run_cli("send")
            self.assertNotEqual(result.returncode, 0, repr(config))
        self.configure(self.http())
        settings = json.loads((self.agent / "settings.json").read_text())
        settings["vibesTelemetry"] = False
        (self.agent / "settings.json").write_text(json.dumps(settings))
        self.assertEqual(self.run_cli("send").returncode, 0)
        self.assertFalse(self.requests)
        self.assertFalse(self.gh_calls.exists())

    def test_usage_retries_dirty_months_and_separates_installations(self):
        script = str(SCRIPT.parent / "usage-telemetry")
        self.configure(self.http())
        for date in ("2020-01-01", "2026-01-01"):
            self.session(date)
        self.failures["*"] = 503
        self.assertNotEqual(self.command(script, "send").returncode, 0)
        paths = {request[1] for request in self.requests}
        self.assertEqual(len(paths), 2)
        self.failures = {next(path for path in paths if path.endswith("2020-01.json")): 503}
        self.assertNotEqual(self.command(script, "send").returncode, 0)
        self.assertEqual(len(self.documents), 1)
        self.failures.clear()
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertEqual(set(self.documents), paths)
        self.requests.clear()
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertFalse(self.requests)
        self.agent = self.agent.parent / "second-agent"
        self.agent.mkdir()
        self.configure(self.http())
        self.session("2020-01-01")
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertEqual(len(self.documents), 3)
        self.assertEqual(len({json.loads(body)["installationId"] for body in self.documents.values()}), 2)

    def test_late_usage_updates_an_acknowledged_month(self):
        self.configure(self.http())
        self.session()
        script = str(SCRIPT.parent / "usage-telemetry")
        self.assertEqual(self.command(script, "send").returncode, 0)
        path = next(iter(self.documents))
        with (self.agent / "sessions/2026-01-01.jsonl").open("a") as session:
            session.write(json.dumps({"type": "message", "id": "late", "timestamp": "2026-01-01T00:01:00Z",
                "message": {"role": "assistant", "usage": {"input": 5, "output": 1}}}) + "\n")
        self.assertEqual(self.command(script, "send").returncode, 0)
        models = json.loads(self.documents[path])["days"]["2026-01-01"]["models"]
        self.assertEqual(sum(row["records"] for row in models), 2)
        self.assertEqual(len([r for r in self.requests if r[0] == "PUT"]), 2)

    def test_usage_http_retry_deduplication_and_destination_change(self):
        self.session()
        script = str(SCRIPT.parent / "usage-telemetry")
        self.configure(self.http())
        self.failures["*"] = 503
        self.assertNotEqual(self.command(script, "send").returncode, 0)
        path = self.requests[-1][1]
        self.failures.clear()
        for _ in range(2):
            result = self.command(script, "send")
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(len([r for r in self.requests if r[0] == "PUT"]), 1)
        document = json.loads(self.documents[path])
        self.assertEqual(document["sender"], "home-user")
        self.assertNotIn("githubLogin", document)
        self.assertNotIn("PRIVATE_SYNTHETIC_PROMPT", self.documents[path].decode())
        self.configure(self.http(url=self.url + "/other"))
        self.assertEqual(self.command(script, "send").returncode, 0)
        self.assertIn(path.replace("/telemetry/", "/other/"), self.documents)
        self.assertFalse(self.gh_calls.exists())


if __name__ == "__main__":
    unittest.main()
