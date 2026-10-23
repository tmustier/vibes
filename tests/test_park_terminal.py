"""Real-PTY launcher checks. Run with python3 -m unittest discover -s tests -p test_park_terminal.py."""
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import sys
import tempfile
import time
import unittest

WRAPPER = Path(__file__).resolve().parents[1] / "scripts/pi-park"


class ParkTerminalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="park-terminal-")
        self.root = Path(self.temp.name)
        self.log = self.root / "runs.jsonl"
        self.startup_log = self.root / "startup"
        (self.root / ".zshenv").write_text(f"print env >> {shlex.quote(str(self.startup_log))}\n")
        (self.root / ".zshrc").write_text("exit 99\n")
        (self.root / ".zprofile").write_text("exit 99\n")
        fake = self.root / "pi"
        fake.write_text(f"#!{sys.executable}\n" + '''import json, os, signal, sys, termios, tty
from pathlib import Path
log = Path(os.environ["PARK_TEST_LOG"])
old = termios.tcgetattr(0)
tty.setcbreak(0)
# Like Pi's TUI, restore input mode when the parent shell resumes us.
def continued(*_):
    tty.setcbreak(0)
    print("PI-CONTINUED", flush=True)
signal.signal(signal.SIGCONT, continued)
with log.open("a") as f:
    f.write(json.dumps(dict(pid=os.getpid(), ppid=os.getppid(), group=os.getpgrp(),
        foreground=os.tcgetpgrp(0), wrapper=os.environ["PI_PARK_WRAPPER_PID"],
        park=os.environ["PI_PARK_FILE"], args=sys.argv[1:], cwd=os.getcwd())) + "\\n")
print("\\033]0;pi - transparent-test\\007", end="", flush=True)
try:
    key = os.read(0, 1)
finally:
    termios.tcsetattr(0, termios.TCSANOW, old)
if key == b"p":
    Path(os.environ["PI_PARK_FILE"]).write_bytes(b"\\0".join(
        s.encode() for s in [os.getcwd(), "transparent-test", "/test-session.jsonl",
                            "--session", "/test-session.jsonl"]))
elif key == b"e":
    sys.exit(7)
''')
        fake.chmod(0o755)
        # A real parent shell is needed to exercise Ctrl-Z and fg, not an orphaned
        # session-leader wrapper whose SIGTSTP the kernel would ignore.
        self.shell, self.fd = pty.fork()
        if self.shell == 0:
            env = {**os.environ, "PATH": f"{self.root}:{os.environ['PATH']}",
                   "PARK_TEST_LOG": str(self.log), "ZDOTDIR": str(self.root),
                   "TERM": "xterm", "PS1": "PARK-TEST> "}
            os.execve("/bin/zsh", ["zsh", "-d", "-f", "-i"], env)
        self.output = b""
        self.addCleanup(self.close_terminal)
        self.wait_for(lambda: b"PARK-TEST> " in self.output)
        self.send(f"{shlex.quote(str(WRAPPER))} --test-flag 'two words'; print WRAPPER-EXIT:$?\n".encode())
        self.wait_for(lambda: len(self.runs()) == 1)

    def runs(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def send(self, data):
        os.write(self.fd, data)

    def wait_for(self, predicate):
        # agent-default (not a user rule): 2026-10-23. Bound a stuck PTY test.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.output += os.read(self.fd, 65536)
                except OSError:
                    break
            if predicate():
                return
        self.fail(f"PTY condition timed out: {self.output!r}")

    def close_terminal(self):
        for run in self.runs():
            for pid in (run["pid"], int(run["wrapper"])):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for suffix in ("", ".wake", ".draft"):
                Path(run["park"] + suffix).unlink(missing_ok=True)
        try:
            os.kill(self.shell, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(self.fd)
        os.waitpid(self.shell, 0)
        self.temp.cleanup()

    def assert_foreground(self, run):
        self.assertEqual(run["ppid"], int(run["wrapper"]), "park parent-PID guard must still work")
        self.assertEqual(run["foreground"], run["group"])
        self.assertEqual(run["group"], run["pid"], "Pi, not the wrapper, must lead the foreground group")
        self.assertEqual(self.startup_log.read_text(), "env\n", "re-entry must not load user startup files again")

    def test_foreground_input_and_exit_status(self):
        self.assert_foreground(self.runs()[0])
        self.assertEqual(self.runs()[0]["args"], ["--test-flag", "two words"])
        self.send(b"e")
        self.wait_for(lambda: b"WRAPPER-EXIT:7" in self.output)

    def test_park_and_wake_by_key_or_file(self):
        self.assert_foreground(self.runs()[0])
        for wake in ("key", "file"):
            count = len(self.runs())
            self.send(b"p")
            previous = self.output.count(b"parked ")
            self.wait_for(lambda: self.output.count(b"parked ") > previous)
            wrapper = int(self.runs()[-1]["wrapper"])
            self.assertEqual(os.tcgetpgrp(self.fd), wrapper, "wrapper owns terminal only while parked")
            if wake == "key":
                self.send(b"x")
            else:
                Path(self.runs()[-1]["park"] + ".wake").touch()
            self.wait_for(lambda: len(self.runs()) == count + 1)
            self.assert_foreground(self.runs()[-1])
            self.assertEqual(self.runs()[-1]["args"], ["--session", "/test-session.jsonl"])
        self.send(b"e")
        self.wait_for(lambda: b"WRAPPER-EXIT:7" in self.output)

    def test_control_c_reaches_pi(self):
        self.assert_foreground(self.runs()[0])
        self.send(b"\x03")
        self.wait_for(lambda: b"WRAPPER-EXIT:130" in self.output)

    def test_control_z_and_fg_resume_the_same_pi(self):
        run = self.runs()[0]
        self.assert_foreground(run)
        for count in (1, 2):
            self.send(b"\x1a")
            self.wait_for(lambda: b"suspended" in self.output and os.tcgetpgrp(self.fd) == self.shell)
            self.send(b"fg; print RESUMED-EXIT:$?\n")
            self.wait_for(lambda: self.output.count(b"PI-CONTINUED") == count
                          and os.tcgetpgrp(self.fd) == run["group"])
        self.send(b"e")
        self.wait_for(lambda: b"RESUMED-EXIT:7" in self.output)
        self.assertEqual(len(self.runs()), 1)


if __name__ == "__main__":
    unittest.main()
