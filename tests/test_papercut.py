from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "papercut"
HEADER = "# Papercuts\n\nAppend-only test file.\n"
METADATA = {
    "thinkingLevel": "xhigh",
    "sessionId": "session-123",
    "contextTokens": 12345,
    "contextWindow": 200000,
    "contextPercent": 6.1725,
    "sessionBytes": 45678,
    "sessionEntries": 90,
    "branchEntries": 70,
    "piVersion": "0.80.7",
}


class PapercutCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="papercut-tests-")
        self.root = Path(self.tempdir.name)
        self.agent_dir = self.root / "pi-agent"
        self.global_file = self.agent_dir / "PAPERCUTS.md"
        self.outside = self.root / "outside"
        self.outside.mkdir()
        self.env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent_dir), "HOME": str(self.root / "home")}

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_cli(self, *args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [str(SCRIPT), *args], cwd=cwd or self.outside, env=self.env, capture_output=True, text=True, timeout=10
        )
        if check:
            self.assertEqual(result.returncode, 0, f"{result.stderr}\n{result.stdout}")
        return result

    def add(self, note: str, *flags: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
        return self.run_cli(*flags, "--model", "test/model", "--", note, cwd=cwd, check=check)

    def make_repo(self) -> Path:
        repo = self.root / "repo"
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        return repo

    def fake_gh(self) -> Path:
        """A gh that finds no existing issue and logs the arguments of each one it creates."""
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        log = self.root / "gh.log"
        gh = bin_dir / "gh"
        gh.write_text(
            "#!/bin/sh\n"
            '[ "$1 $2" = "issue list" ] && exit 0\n'
            f"printf '%s\\n' \"$@\" >> {log}\n"
            "echo https://github.com/tmustier/vibes/issues/123\n"
        )
        gh.chmod(0o755)
        self.env["PATH"] = f"{bin_dir}:{self.env['PATH']}"
        return log

    def test_outside_git_records_to_the_private_global_file(self) -> None:
        self.add("The resolver used the global default outside Git.", "--context", "test:global-flow")

        content = self.global_file.read_text()
        self.assertRegex(content, r"## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}")
        self.assertIn("- Context: `test:global-flow`", content)
        self.assertIn("The resolver used the global default outside Git.", content)
        self.assertEqual(stat.S_IMODE(self.global_file.stat().st_mode), 0o600)

    def test_runtime_metadata_is_recorded_and_reviewable(self) -> None:
        self.add("The tool obscured the active session context estimate.", "--metadata-json", json.dumps(METADATA))

        self.assertIn("- Context usage: `12345 / 200000 (6.17%)`", self.global_file.read_text())
        entry = json.loads(self.run_cli("review", "--global", "--json").stdout)["entries"][0]
        self.assertEqual(
            (entry["thinking_level"], entry["context_tokens"], entry["session_bytes"], entry["branch_entries"]),
            ("xhigh", 12345, 45678, 70),
        )

    def test_explicit_local_creates_at_git_root(self) -> None:
        repo = self.make_repo()
        nested = repo / "one" / "two"
        nested.mkdir(parents=True)

        self.add("Explicit local capture created one file at the repository root.", "--local", cwd=nested)

        target = repo / "PAPERCUTS.md"
        self.assertIn("repo:repo/one/two", target.read_text())
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
        self.assertFalse(self.global_file.exists())

    def test_nearest_local_file_overrides_ancestor_and_global(self) -> None:
        repo = self.make_repo()
        root_file = repo / "PAPERCUTS.md"
        root_file.write_text(HEADER)
        nearest = repo / "area" / "PAPERCUTS.md"
        deep = repo / "area" / "feature" / "src"
        deep.mkdir(parents=True)
        nearest.write_text(HEADER)
        self.agent_dir.mkdir()
        self.global_file.write_text(HEADER)

        self.add("Automatic resolution selected the closest repository-local override.", cwd=deep)

        self.assertIn("Automatic resolution selected", nearest.read_text())
        self.assertEqual((root_file.read_text(), self.global_file.read_text()), (HEADER, HEADER))
        resolved = json.loads(self.run_cli("resolve", "--cwd", str(deep), "--json").stdout)
        self.assertEqual(Path(resolved["target"]).resolve(), nearest.resolve())

    def test_repo_without_local_file_falls_back_to_global(self) -> None:
        repo = self.make_repo()
        self.add("A repository without an opt-in file retained the global default.", cwd=repo)
        self.assertTrue(self.global_file.exists())
        self.assertFalse((repo / "PAPERCUTS.md").exists())

    def test_review_all_combines_global_and_effective_local(self) -> None:
        repo = self.make_repo()
        self.add("Global review evidence remained available.", "--global", cwd=repo)
        self.add("Local review evidence overrode automatic append resolution.", "--local", cwd=repo)

        payload = json.loads(self.run_cli("review", "--all", "--json", cwd=repo).stdout)
        self.assertEqual(sorted(entry["scope"] for entry in payload["entries"]), ["global", "local"])

    def test_submission_sends_metadata_only_and_never_twice(self) -> None:
        gh_log = self.fake_gh()
        auto = self.add(
            "Automatic submission retained a durable local copy.",
            "--json", "--submit-repo", "tmustier/vibes", "--metadata-json", json.dumps(METADATA),
        )
        self.assertEqual(json.loads(auto.stdout)["submissionUrl"], "https://github.com/tmustier/vibes/issues/123")
        self.add("The merge command returned a misleading local failure after remote success.")

        submit = ("submit", "--global", "--repo", "tmustier/vibes", "--json")
        self.assertEqual(json.loads(self.run_cli(*submit).stdout)["pendingBefore"], 1)
        sent = gh_log.read_text()
        self.assertIn("papercut-inbox", sent)
        self.assertIn("12345 / 200000 (6.17%)", sent)
        self.assertIn("No session messages, prompts, tool results, or JSONL contents were uploaded", sent)
        self.assertEqual(json.loads(self.run_cli(*submit).stdout)["pendingBefore"], 0)

    def test_secret_like_input_is_rejected_without_creating_file(self) -> None:
        result = self.add("The failing credential was sk-proj-abcdefghijklmnop1234567890.", check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("possible OpenAI or Anthropic API key detected", result.stderr)
        self.assertNotIn("sk-proj-", result.stderr)
        self.assertFalse(self.global_file.exists())

    def test_more_than_two_sentences_is_rejected(self) -> None:
        result = self.add("The first step was slow. The retry was unclear. The final output hid the cause.", check=False)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.global_file.exists())

    def test_dry_run_resolves_without_writing(self) -> None:
        repo = self.make_repo()
        self.add("Dry-run resolution did not mutate either target.", "--dry-run", cwd=repo)
        self.assertFalse(self.global_file.exists())
        self.assertFalse((repo / "PAPERCUTS.md").exists())

    def test_review_redacts_sensitive_preexisting_entry(self) -> None:
        token = "sk-proj-abcdefghijklmnop1234567890"
        self.agent_dir.mkdir()
        self.global_file.write_text(
            f"# Papercuts\n\n## 2026-07-10T09:00:00+01:00\n- Model: `test/model`\n- Friction: A fixture contained {token}.\n"
        )
        self.assertNotIn(token, self.run_cli("review", "--global").stdout)

    def test_symlink_target_is_refused_without_touching_destination(self) -> None:
        repo = self.make_repo()
        destination = self.root / "must-not-change.md"
        destination.write_text("sentinel\n")
        (repo / "PAPERCUTS.md").symlink_to(destination)

        result = self.add("A symlink should never redirect this append.", cwd=repo, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(destination.read_text(), "sentinel\n")

    def test_concurrent_appends_remain_complete(self) -> None:
        notes = [f"Concurrent append number {number} stayed intact." for number in range(12)]
        processes = [
            subprocess.Popen([str(SCRIPT), "--global", "--model", "test/model", "--", note], cwd=self.outside, env=self.env, stdout=subprocess.DEVNULL)
            for note in notes
        ]
        self.assertEqual([process.wait(timeout=10) for process in processes], [0] * len(notes))

        content = self.global_file.read_text()
        self.assertEqual(content.count("## "), len(notes))
        for note in notes:
            self.assertEqual(content.count(note), 1)


if __name__ == "__main__":
    unittest.main()
