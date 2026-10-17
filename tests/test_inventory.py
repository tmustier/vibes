"""scripts/inventory: what leaves the Mac. Personal files go with credentials and emails removed,
package files go as a fingerprint only, and "vibesTelemetry": false stops the upload."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "inventory"
API_KEY = "sk-ant-" + "a1b2c3d4e5f6g7h8i9j0k1l2"
EMAIL = "someone@" + "example.com"


class InventoryFixture:
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="inventory-tests-")
        root = Path(self.tempdir.name)
        self.agent = root / "agent"
        self.agent.mkdir()
        (self.agent / "settings.json").write_text(json.dumps({"telemetryDestination": {
            "type": "github", "repository": "example/setup-telemetry"}}))
        (self.agent / "AGENTS.md").write_text("# My own guidance\n")
        (self.agent / "auth.json").write_text(json.dumps({"anthropic": {"key": API_KEY}}))
        (self.agent / "mcp.json").write_text(json.dumps({"mcpServers": {"linear": {"url": "https://example.com/mcp"}}}))

        self.personal = self.agent / "skills" / "mine" / "SKILL.md"
        self.personal.parent.mkdir(parents=True)
        self.personal.write_text(f"---\nname: mine\ndescription: Mine\n---\nUse {API_KEY} and write to {EMAIL}.\n")
        package = root / "npm" / "node_modules" / "their-package"
        (package / "skills").mkdir(parents=True)
        (package / "skills" / "SKILL.md").write_text("---\nname: theirs\ndescription: Theirs\n---\nPackaged body.\n")

        self.raw = root / "raw.json"
        self.raw.write_text(
            json.dumps(
                {
                    "generatedAt": "2026-09-28T00:00:00Z",
                    "pi": "0.0.0",
                    "model": "openai-codex/gpt-6-sol",
                    "thinking": "medium",
                    "packages": [{"source": "npm:their-package", "scope": "user", "filtered": False, "installedPath": str(package)}],
                    "extensions": [],
                    "skills": [
                        {"name": "mine", "path": str(self.personal), "enabled": True, "loaded": True, "inContext": True},
                        {"name": "theirs", "path": str(package / "skills" / "SKILL.md"), "enabled": True, "loaded": True, "inContext": True},
                    ],
                    "prompts": [],
                    "themes": [],
                    "tools": [],
                    "commands": [],
                    "context": {"sections": []},
                }
            )
        )
        self.bin = root / "bin"
        self.bin.mkdir()
        self.gh_calls = root / "gh-calls"
        (self.bin / "gh").write_text(f"#!/bin/sh\necho \"$@\" >> {self.gh_calls}\nexit 1\n")
        (self.bin / "gh").chmod(0o755)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_cli(self, command: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent), "PATH": f"{self.bin}:{os.environ['PATH']}"}
        return subprocess.run([str(SCRIPT), command, str(self.raw)], env=env, capture_output=True, text=True, check=False)


class InventoryTests(InventoryFixture, unittest.TestCase):
    def test_show_redacts_personal_text_and_sends_packages_as_fingerprints(self) -> None:
        result = self.run_cli("show")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(API_KEY, result.stdout)
        self.assertNotIn(EMAIL, result.stdout)
        inventory = json.loads(result.stdout)

        mine, theirs = inventory["skills"]
        self.assertEqual(mine["from"], "personal")
        self.assertIn("[redacted OpenAI or Anthropic API key]", mine["text"])
        self.assertIn("[redacted email]", mine["text"])
        self.assertEqual((theirs["from"], theirs["path"]), ("npm:their-package", "skills/SKILL.md"))
        self.assertNotIn("text", theirs)
        self.assertIn("sha256", theirs)

        self.assertIn("+# My own guidance", inventory["agentsDiff"])
        self.assertEqual(inventory["providers"], ["anthropic"])
        self.assertEqual(inventory["mcpServers"], ["linear"])

    def test_redacts_before_truncating_personal_text(self) -> None:
        self.personal.write_text("x" * 19_989 + " " + API_KEY)
        result = self.run_cli("show")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("sk-ant-", json.loads(result.stdout)["skills"][0]["text"][-100:])

    def test_send_does_nothing_when_telemetry_is_off(self) -> None:
        (self.agent / "settings.json").write_text(json.dumps({"vibesTelemetry": False}))
        self.raw.unlink()
        result = self.run_cli("send")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Not sent", result.stdout)
        self.assertFalse(self.gh_calls.exists())

    def test_login_errors_do_not_confuse_connection_and_authentication(self) -> None:
        cases = [
            ("error connecting to api.github.com", 1, "could not query GitHub"),
            ("dial tcp: lookup api.github.com: no such host", 1, "could not query GitHub"),
            ("TLS handshake timeout", 1, "could not query GitHub"),
            ("gh: Bad credentials (HTTP 401)", 1, "authentication failed"),
            ("To get started with GitHub CLI, please run: gh auth login", 4, "authentication required"),
            ("gh: API rate limit exceeded (HTTP 403)", 1, "could not query GitHub"),
            ("gh: Service Unavailable (HTTP 503)", 1, "could not query GitHub"),
        ]
        for error, code, expected in cases:
            with self.subTest(error=error):
                (self.bin / "gh").write_text(
                    f"#!/usr/bin/env python3\nimport sys\nprint({error!r}, file=sys.stderr)\nsys.exit({code})\n")
                result = self.run_cli("send")
                self.assertEqual(result.returncode, 1)
                self.assertIn(expected, result.stdout)
                self.assertIn(error, result.stdout)
                self.assertNotIn("not logged in", result.stdout)

    def test_uploads_setup_changes_but_not_timestamps(self) -> None:
        stored = self.agent / "uploaded.json"
        (self.bin / "gh").write_text(f'''#!/usr/bin/env python3
import base64, json, sys
from pathlib import Path
stored = Path({str(stored)!r})
if sys.argv[2] == "user":
    print("test-user")
elif "PUT" in sys.argv:
    request = json.load(sys.stdin)
    stored.write_bytes(base64.b64decode(request["content"]))
    with open({str(self.gh_calls)!r}, "a") as calls:
        calls.write("PUT\\n")
elif "-H" in sys.argv:
    print(stored.read_text())
elif stored.exists():
    print(json.dumps({{"sha": "existing-blob", "content": ""}}))
else:
    sys.exit(1)
''')
        status = {"finishedAt": "2026-09-27T00:00:00Z", "ok": True, "steps": []}
        (self.agent / "vibes-update.json").write_text(json.dumps(status))
        result = self.run_cli("send")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(API_KEY, stored.read_text())

        raw = json.loads(self.raw.read_text())
        raw["generatedAt"] = "2026-09-29T00:00:00Z"
        self.raw.write_text(json.dumps(raw))
        status["finishedAt"] = "2026-09-28T00:00:00Z"
        (self.agent / "vibes-update.json").write_text(json.dumps(status))
        result = self.run_cli("send")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already up to date", result.stdout)
        self.assertEqual(self.gh_calls.read_text().splitlines(), ["PUT"])

        raw["thinking"] = "high"
        self.raw.write_text(json.dumps(raw))
        result = self.run_cli("send")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(stored.read_text())["thinking"], "high")
        self.assertEqual(self.gh_calls.read_text().splitlines(), ["PUT", "PUT"])

    def test_report_appends_a_redacted_entry_with_the_session_file(self) -> None:
        stored = self.agent / "report.md"
        (self.bin / "gh").write_text(f'''#!/usr/bin/env python3
import base64, json, sys
from pathlib import Path
stored = Path({str(stored)!r})
if sys.argv[2] == "user":
    print("test-user")
elif "PUT" in sys.argv:
    request = json.load(sys.stdin)
    assert request["sha"] == "blob" if stored.exists() else "sha" not in request
    stored.write_bytes(base64.b64decode(request["content"]))
elif stored.exists():
    print(json.dumps({{"sha": "blob", "content": base64.b64encode(stored.read_bytes()).decode()}}))
else:
    sys.exit(1)
''')
        env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent), "PATH": f"{self.bin}:{os.environ['PATH']}"}
        session = str(Path.home() / ".pi" / "agent" / "sessions" / "one.jsonl")
        for summary in (f"Startup failed on an ask-granola clash; kept theirs. Key {API_KEY}.", "Second fix."):
            result = subprocess.run([str(SCRIPT), "report", session, summary], env=env, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        text = stored.read_text()
        self.assertEqual(text.count("Session: ~/.pi/agent/sessions/one.jsonl"), 2)
        self.assertIn("kept theirs", text)
        self.assertIn("Second fix.", text)
        self.assertNotIn(API_KEY, text)


if __name__ == "__main__":
    unittest.main()
