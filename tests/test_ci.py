"""Exercise the CI runner with real concurrent child processes, logs and exit codes."""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import sys
import tempfile
import unittest

from ci import SUITES, run_checks


class CiRunnerTests(unittest.TestCase):
    def test_failure_keeps_other_checks_running_and_prints_both_logs(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            # agent-default (not a user rule): 2026-10-22. Bound a broken parallel runner.
            child = """
import sys, time
from pathlib import Path
root, name, other, code = sys.argv[1:]
root = Path(root)
(root / name).touch()
deadline = time.monotonic() + 5
while not (root / other).exists():
    assert time.monotonic() < deadline, 'the other check never started'
    time.sleep(0.01)
(root / (name + '.done')).write_text(name)
print(name + ' output')
raise SystemExit(int(code))
"""
            output = StringIO()
            with redirect_stdout(output):
                result = run_checks([
                    [sys.executable, "-c", child, scratch, "first", "second", "7"],
                    [sys.executable, "-c", child, scratch, "second", "first", "0"],
                ])
            self.assertEqual(result, 1)
            for name in ("first", "second"):
                self.assertEqual((root / (name + ".done")).read_text(), name)
                self.assertIn(name + " output", output.getvalue())
            self.assertIn("FAILED (7)", output.getvalue())
            self.assertIn("passed", output.getvalue())

    def test_artifact_and_terminal_regressions_remain_in_the_suites(self):
        self.assertIn("npx --no-install jiti tests/test_claude_artifacts.mjs", SUITES["portable"])
        self.assertIn("python3 -m unittest discover -s tests -p test_park_terminal.py", SUITES["macos"])

    def test_personal_checks_remain_in_the_portable_suite(self):
        for command in (
            "python3 tests/test_public_release.py",
            "node --test tests/test_granola_mcp_fetch.mjs",
            "bash tests/test_home_command.sh",
            "python3 tests/test_home_update.py",
        ):
            self.assertIn(command, SUITES["portable"])

    def test_successful_checks_return_success(self):
        output = StringIO()
        with redirect_stdout(output):
            result = run_checks([[sys.executable, "-c", "print('completed')"]])
        self.assertEqual(result, 0)
        self.assertIn("completed", output.getvalue())


if __name__ == "__main__":
    unittest.main()
