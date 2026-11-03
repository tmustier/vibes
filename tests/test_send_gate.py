"""Exercise send-gate's help boundary without sending email or waiting."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "send-gate"


class SendGateTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="send-gate-tests-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.log = self.root / "calls"
        self.env = {key: value for key, value in os.environ.items() if key != "SEND_GATE_GRACE"}
        self.env.update(PATH=f"{self.root}:{self.env['PATH']}", CALLS=str(self.log))
        # Record countdowns and command execution; neither is allowed for help.
        for name in ("sleep", "gog", "--help", "-h"):
            stub = self.root / name
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "${0##*/} $*" >> "$CALLS"\n')
            stub.chmod(0o755)

    def run_gate(self, *args):
        return subprocess.run([str(SCRIPT), *args], env=self.env, capture_output=True, text=True, timeout=5)

    def test_standalone_help_never_counts_down_or_executes(self):
        for grace in (None, "0"):
            if grace is not None:
                self.env["SEND_GATE_GRACE"] = grace
            for flag in ("--help", "-h"):
                with self.subTest(grace=grace, flag=flag):
                    result = self.run_gate(flag)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Usage: send-gate <command> [args...]", result.stdout)
                    self.assertIn(f"{grace or '60'}s grace period", result.stdout)
                    self.assertNotIn("OUTBOUND EMAIL", result.stdout)
                    self.assertFalse(self.log.exists(), result.stdout)

    def test_no_arguments_still_prints_usage_and_fails(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Usage: send-gate <command> [args...]", result.stdout)
        self.assertFalse(self.log.exists())

    def test_command_help_still_previews_counts_down_and_executes(self):
        self.env["SEND_GATE_GRACE"] = "2"
        for flag in ("--help", "-h"):
            with self.subTest(flag=flag):
                result = self.run_gate("gog", "gmail", "send", flag)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("OUTBOUND EMAIL", result.stdout)
                self.assertIn("Will send in 2 seconds.", result.stdout)
                self.assertEqual(self.log.read_text().splitlines(), [
                    f"gog gmail send {flag} --dry-run", "sleep 1", "sleep 1", f"gog gmail send {flag}",
                ])
                self.log.unlink()


if __name__ == "__main__":
    unittest.main()
