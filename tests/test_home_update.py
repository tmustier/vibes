#!/usr/bin/env python3
"""Exercise the real home updater with local Git and synthetic package/Pi commands."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
UPDATER = Path(os.environ.get("HOME_UPDATER_UNDER_TEST", ROOT / "scripts/home-update"))


class HomeUpdateTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="vibes-home-update-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.home = self.root / "home"
        self.agent = self.home / ".pi/agent"
        self.bin = self.root / "bin"
        self.repo = self.root / "repo"
        seed = self.root / "seed"
        self.seed = seed
        for directory in (self.agent, self.bin, seed / "scripts", self.home / ".nvm"):
            directory.mkdir(parents=True, exist_ok=True)
        self.env = {**os.environ, "HOME": str(self.home), "PI_CODING_AGENT_DIR": str(self.agent),
                    "TEST_BIN": str(self.bin), "TEST_NODE_BIN": str(Path(shutil.which("node")).parent),
                    "TEST_TRACE": str(self.root / "trace")}
        self.env.pop("VIBES_UPDATE_LOCKED", None)
        self.env.pop("VIBES_CHECK_READY", None)
        (self.home / ".nvm/nvm.sh").write_text(
            '''export PATH="$TEST_BIN:$TEST_NODE_BIN:$PATH"
nvm() {
  printf 'nvm %s\\n' "$*" >>"$TEST_TRACE"
  if [ "${TEST_NVM_FAIL:-}" = "$1" ]; then return 23; fi
  case $1 in
    version-remote) printf 'v%s.12.1\\n' "$2" ;;
    version) echo v26.12.0 ;;
    install) return 0 ;;
    alias) export TEST_NODE_ALIASED=1 ;;
    use)
      if [ -n "${TEST_NODE_ALIASED:-}" ]; then
        [ "${TEST_NVM_FAIL:-}" != use-updated ] || return 23
        export TEST_NODE_SELECTED=v26.12.1
      else
        export TEST_NODE_SELECTED=v26.12.0
      fi ;;
  esac
}
''')
        pinned_pi = json.loads((ROOT / "package.json").read_text())["devDependencies"]["@earendil-works/pi-coding-agent"]
        for name, content in {
            "npm": '#!/bin/bash\nprintf "npm %s node=%s\\n" "$*" "$TEST_NODE_SELECTED" >>"$TEST_TRACE"\nexit "${TEST_PACKAGES_EXIT:-0}"\n',
            "pi": f'#!/bin/bash\nprintf "{pinned_pi}\\n"\n',
            "launchctl": '#!/bin/bash\nexit 1\n',
        }.items():
            path = self.bin / name
            path.write_text(content)
            path.chmod(0o755)
        shutil.copy2(UPDATER, seed / "scripts/home-update")
        shutil.copy2(ROOT / "scripts/home-vibes", seed / "scripts/home-vibes")
        (seed / "scripts/vibes").write_text(
            '#!/bin/bash\nsource ' + repr(str(ROOT / "scripts/vibes")) + '\n'
            'VIBES="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'
            'if [ "${BASH_SOURCE[0]}" = "$0" ]; then\n'
            '  case "$1" in\n'
            '    check) exit "${TEST_STARTUP_EXIT:-0}" ;;\n'
            '    status) cmd_status ;;\n'
            '    *) exit 2 ;;\n'
            '  esac\nfi\n')
        for path in (seed / "scripts").iterdir():
            path.chmod(0o755)
        (seed / "scripts/sync-settings.mjs").write_text(
            'import { writeFileSync } from "node:fs";\n'
            'writeFileSync(process.argv[4] + "/sync-proof", "ok");\n')
        for name in (".node-version", "package.json", "settings.template.json", "subagent-config.template.json", "web-search.template.json"):
            shutil.copy2(ROOT / name, seed / name)
        self.git(seed, "init", "-q", "-b", "main")
        self.git(seed, "config", "user.name", "Vibes test fixture")
        self.git(seed, "config", "user.email", "fixture@example.net")
        self.git(seed, "add", ".")
        self.git(seed, "commit", "-qm", "Fixture")
        self.git(self.root, "clone", "--quiet", "--bare", str(seed), str(self.root / "origin.git"))
        self.git(self.root, "clone", "--quiet", str(self.root / "origin.git"), str(self.repo))
        self.file = self.agent / "vibes-update.json"

    def git(self, cwd, *args):
        return subprocess.check_output(["git", "-C", str(cwd), *args], text=True, stderr=subprocess.STDOUT)

    def update(self, **env):
        return subprocess.run(["bash", str(self.repo / "scripts/home-vibes"), "update"],
                              env=self.env | env, capture_output=True, text=True, timeout=20)

    def status(self):
        return json.loads(self.file.read_text())

    def test_success_records_home_steps_and_cli_result(self):
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        status = self.status()
        self.assertEqual(status["updater"], "home")
        self.assertTrue(status["ok"])
        self.assertTrue(all(step["ok"] for step in status["steps"]))
        self.assertIn("startup", [step["name"] for step in status["steps"]])
        self.assertEqual(status["log"], str(self.home / "Library/Logs/pi-personal-update.log"))
        self.assertNotIn("agentsTemplateHash", status)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.agent / "sync-proof").read_text(), "ok")
        self.assertEqual(self.git(self.repo, "status", "--porcelain"), "")
        cli = subprocess.run(["bash", str(self.repo / "scripts/home-vibes"), "status"],
                             env=self.env | {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"]},
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertIn("succeeded", cli.stdout)
        self.assertIn("startup", cli.stdout)
        self.assertIn(status["log"], cli.stdout)

    def test_node_update_follows_merge_and_precedes_packages(self):
        # The helper must read the just-fast-forwarded major, not the pre-fetch file.
        (self.repo / ".node-version").write_text("24\n")
        self.git(self.repo, "add", ".node-version")
        self.git(self.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.net",
                 "commit", "-qm", "Old major")
        self.git(self.seed, "fetch", str(self.repo), "main")
        self.git(self.seed, "merge", "--ff-only", "FETCH_HEAD")
        (self.seed / ".node-version").write_text("26\n")
        self.git(self.seed, "add", ".node-version")
        self.git(self.seed, "commit", "-qm", "Roll forward major")
        self.git(self.seed, "push", "--quiet", str(self.root / "origin.git"), "main")
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        names = [s["name"] for s in self.status()["steps"]]
        self.assertIn("node", names)
        self.assertLess(names.index("merge"), names.index("node"))
        self.assertLess(names.index("node"), names.index("packages"))
        trace = (self.root / "trace").read_text().splitlines()
        self.assertEqual(trace[:6], ["nvm use --silent default", "nvm version-remote 26",
            "nvm version default", "nvm install 26 --reinstall-packages-from=v26.12.0",
            "nvm alias default 26", "nvm use --silent default"])
        installs = [line for line in trace if line.startswith("npm ")]
        self.assertEqual(len(installs), 2)
        self.assertTrue(all(line.endswith("node=v26.12.1") for line in installs), trace)

    def test_actual_node_helper_failure_stops_before_packages(self):
        # update_node maps these nvm errors to 1, not the boundary's 23. In particular,
        # run_step must not conditionally invoke the helper and then mask its return.
        for operation in ("version-remote", "install", "alias", "use-updated"):
            with self.subTest(operation=operation):
                (self.root / "trace").write_text("")
                result = self.update(TEST_NVM_FAIL=operation)
                self.assertEqual(result.returncode, 1, result.stderr)
                status = self.status()
                self.assertFalse(status["ok"])
                self.assertEqual(status["steps"][-1],
                                 {"name": "node", "ok": False, "detail": "exit 1"})
                self.assertNotIn("packages", [s["name"] for s in status["steps"]])
                self.assertFalse(any(line.startswith("npm ") for line in
                                     (self.root / "trace").read_text().splitlines()))

    def test_logging_failure_replaces_the_previous_success(self):
        self.assertEqual(self.update().returncode, 0)
        log = self.home / "Library/Logs/pi-personal-update.log"
        log.unlink()
        log.mkdir()
        self.assertNotEqual(self.update().returncode, 0)
        self.assertFalse(self.status()["ok"])
        self.assertEqual(self.status()["steps"][-1]["name"], "logging")

    def test_status_remains_readable_without_node_or_nvm(self):
        self.assertEqual(self.update().returncode, 0)
        (self.home / ".nvm/nvm.sh").unlink()
        env = self.env | {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "NVM_DIR": str(self.home / ".nvm")}
        if subprocess.run(["bash", "-c", "command -v node"], env=env, capture_output=True).returncode == 0:
            self.skipTest("This host provides system Node on the restricted test PATH")
        cli = subprocess.run(["bash", str(self.repo / "scripts/home-vibes"), "status"], env=env,
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertIn("succeeded", cli.stdout)
        self.assertIn("pi-personal-update.log", cli.stdout)

    def test_self_update_keeps_the_running_script_parsed(self):
        script = self.seed / "scripts/home-update"
        script.write_text(script.read_text().replace("#!/bin/bash\n", "#!/bin/bash\n" + "# Updated fixture header\n" * 150, 1))
        self.git(self.seed, "add", "scripts/home-update")
        self.git(self.seed, "commit", "-qm", "Change updater layout")
        self.git(self.seed, "push", "--quiet", str(self.root / "origin.git"), "main")
        expected = self.git(self.seed, "rev-parse", "HEAD")
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), expected)
        self.assertTrue(self.status()["ok"])
        self.assertTrue(any(s["name"] == "startup" and s["ok"] for s in self.status()["steps"]))

    def test_package_failure_is_recorded_then_cleared_by_success(self):
        result = self.update(TEST_PACKAGES_EXIT="23")
        self.assertEqual(result.returncode, 23)
        status = self.status()
        self.assertFalse(status["ok"])
        self.assertEqual(status["steps"][-1], {"name": "packages", "ok": False, "detail": "exit 23"})
        self.assertNotIn("startup", [step["name"] for step in status["steps"]])
        self.assertEqual(self.update().returncode, 0)
        self.assertTrue(self.status()["ok"])
        self.assertNotEqual(self.status()["finishedAt"], status["finishedAt"])

    def test_startup_failure_is_recorded(self):
        self.assertEqual(self.update(TEST_STARTUP_EXIT="7").returncode, 7)
        self.assertEqual(self.status()["steps"][-1], {"name": "startup", "ok": False, "detail": "exit 7"})
        self.assertFalse(self.status()["ok"])

    def test_node_setup_failure_is_recorded_without_node_on_path(self):
        (self.home / ".nvm/nvm.sh").unlink()
        self.assertNotEqual(self.update().returncode, 0)
        self.assertEqual(self.status()["steps"][-1]["name"], "node-env")
        self.assertFalse(self.status()["ok"])

    def test_dirty_checkout_is_not_changed(self):
        path = self.repo / "settings.template.json"
        path.write_text(path.read_text() + "\n")
        before = path.read_bytes()
        self.assertNotEqual(self.update().returncode, 0)
        self.assertEqual(self.status()["steps"][-1]["name"], "checkout")
        self.assertEqual(path.read_bytes(), before)

    def test_lock_skips_second_update_without_overwriting_status(self):
        self.assertEqual(self.update().returncode, 0)
        before = self.file.read_bytes()
        holder = subprocess.Popen(["/usr/bin/perl", "-MFcntl=:flock", "-e",
            'open(my $l, ">>", $ARGV[0]) or die $!; flock($l, LOCK_EX) or die $!; $|=1; print "ready\\n"; sleep 60;',
            str(self.agent / "vibes-update.flock")], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "ready")
            self.assertEqual(self.update().returncode, 75)
            self.assertEqual(self.file.read_bytes(), before)
        finally:
            holder.kill()
            holder.wait(timeout=5)
            holder.stdout.close()


if __name__ == "__main__":
    unittest.main()
