#!/usr/bin/env python3
"""Durable native-update deadlines, warnings and recovery, independent of launchd ticks."""
import datetime as dt
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("chatgpt_update", str(ROOT / "scripts/chatgpt-update"))
spec = importlib.util.spec_from_loader(loader.name, loader)
u = importlib.util.module_from_spec(spec)
loader.exec_module(u)


def date(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


class Native:
    def __init__(self):
        self.available, self.open, self.exists = True, True, True
        self.is_classic = False
        self.calls = []
        self.fail = None

    def action(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise RuntimeError("offline or native failure")

    def present(self):
        return self.exists

    def install(self):
        self.action("install")
        self.exists = True

    def classic(self):
        return self.is_classic

    def replace_classic(self):
        self.action("replace")
        self.is_classic, self.open = False, False

    def probe(self):
        self.action("probe")
        return self.available

    def running(self):
        return self.open

    def version(self):
        return "24614" if not self.available else "24141"

    def stage(self):
        self.action("stage")

    def enforce(self):
        self.action("enforce")
        self.available = False

    def verify(self, restore_running=False):
        self.action("verify")
        if restore_running:
            self.open = True


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.path = Path(self.scratch.name) / "state.json"
        self.native = Native()
        self.notices = []
        env = patch.dict(os.environ, {"TZ": "Europe/London"})
        env.start()
        time.tzset()
        self.addCleanup(lambda: (env.stop(), time.tzset()))
        self.saturday = date("2026-11-07T04:00:00Z")
        self.awake = None
        self.last_wall = None

    def run_at(self, now, boot="one", notice=None, slept=False, clock=None):
        # Without sleep, monotonic time advances with the wall clock; sleep pauses it.
        if self.awake is None:
            self.awake = 1000.0
        elif not slept:
            self.awake += now.timestamp() - self.last_wall
        self.last_wall = now.timestamp()
        return u.run(self.path, self.native, now, boot, notice or self.notices.append, clock, lambda: self.awake)

    def state(self):
        return u.read_state(self.path)

    def covered(self):
        self.awake = self.last_wall = None
        u.save_state(self.path, {"completedSlot": u.weekly_slot(self.saturday-dt.timedelta(days=1)),
                                "boot": "one"})

    def tick(self, start, minutes):
        for minute in range(5, minutes+1, 5):
            self.run_at(start + dt.timedelta(minutes=minute))

    def test_saturday_four_local_before_and_after_dst(self):
        for now, boundary in [("2026-10-24T03:00:00Z", "2026-10-24T03:00:00Z"),
                              ("2026-10-24T02:59:00Z", "2026-10-17T03:00:00Z"),
                              ("2026-10-31T04:00:00Z", "2026-10-31T04:00:00Z"),
                              ("2026-03-28T04:00:00Z", "2026-03-28T04:00:00Z"),
                              ("2026-04-04T03:00:00Z", "2026-04-04T03:00:00Z")]:
            self.assertEqual(u.weekly_slot(date(now)), date(boundary).timestamp())
        self.assertEqual(u.next_weekly_slot(date("2026-10-24T03:00:00Z")), date("2026-10-31T04:00:00Z").timestamp())
        with patch.dict(os.environ, {"TZ": "America/Los_Angeles"}):
            time.tzset()
            self.assertEqual(u.weekly_slot(date("2026-11-07T12:00:00Z")), date("2026-11-07T12:00:00Z").timestamp())
        time.tzset()

    def test_closed_classic_app_is_replaced_at_once(self):
        self.covered()
        self.native.is_classic, self.native.open = True, False
        wed = self.saturday - dt.timedelta(days=3)
        self.assertEqual(self.run_at(wed), 0)
        self.assertEqual(self.native.calls, ["replace", "probe", "stage"])
        self.assertEqual(self.notices, [])

    def test_open_classic_app_is_replaced_ten_minutes_after_warning(self):
        self.covered()
        wed = self.saturday - dt.timedelta(days=3)
        u.save_state(self.path, {**self.state(), "lastCheckAt": wed.timestamp() - 3600})  # checked an hour ago
        self.native.is_classic = True
        self.run_at(wed)
        self.assertEqual(len(self.notices), 1)
        self.assertIn("ChatGPT for Work", self.notices[0])
        self.tick(wed, 5)
        self.assertEqual(self.native.calls, [])
        self.tick(wed + dt.timedelta(minutes=5), 5)
        self.assertEqual(self.native.calls, ["replace", "verify", "probe", "stage"])
        self.assertTrue(self.native.open)
        self.assertNotIn("replaceWarningAt", self.state())
        self.assertEqual(len(self.notices), 1)

    def test_failed_reopen_after_replacement_is_retried_then_stops(self):
        self.covered()
        wed = self.saturday - dt.timedelta(days=3)
        self.native.is_classic = True
        u.save_state(self.path, {**self.state(), "replaceWarningAt": wed.timestamp() - 900})  # warned 15 minutes ago
        self.native.fail = "verify"
        self.assertEqual(self.run_at(wed), 1)
        self.assertEqual(self.native.calls, ["replace", "verify"])
        self.assertTrue(self.state()["enforcementWasRunning"])
        self.native.fail = None
        self.native.calls.clear()
        self.run_at(wed + dt.timedelta(minutes=5))
        self.assertEqual(self.native.calls, ["verify", "probe", "stage"])
        self.assertTrue(self.native.open)
        self.assertNotIn("enforcementWasRunning", self.state())
        self.assertNotIn("replaceWarningAt", self.state())
        self.native.calls.clear()
        self.tick(wed + dt.timedelta(minutes=5), 30)
        self.assertEqual(self.native.calls, [])

    def test_daily_staging_does_not_close_app_or_satisfy_next_week(self):
        self.covered()
        wed = self.saturday - dt.timedelta(days=3)
        self.run_at(wed)
        self.assertEqual(self.native.calls, ["probe", "stage"])
        self.run_at(wed + dt.timedelta(hours=1))
        self.assertEqual(self.native.calls, ["probe", "stage"])
        self.assertTrue(self.native.open)
        self.run_at(wed + dt.timedelta(days=1))
        self.assertEqual(self.native.calls, ["probe", "stage", "probe", "stage"])

    def test_advance_warning_enforces_at_four_not_ten_minutes_after(self):
        self.covered()
        early = self.saturday-dt.timedelta(minutes=10)
        self.run_at(early)
        self.assertEqual(len(self.notices), 1)
        self.assertEqual(self.native.calls, ["probe", "stage"])
        self.tick(early, 10)
        self.assertIn("enforce", self.native.calls)
        self.assertEqual(self.state()["completedSlot"], self.saturday.timestamp())
        self.assertEqual(self.state()["status"], "updated")
        self.assertEqual(len(self.notices), 1)

    def test_power_off_for_weeks_catches_up_once_after_fresh_warning(self):
        self.covered()
        monday = self.saturday+dt.timedelta(days=16, hours=5)
        self.run_at(monday, boot="new-boot", slept=True)
        self.assertNotIn("enforce", self.native.calls)
        self.run_at(monday+dt.timedelta(minutes=5), boot="new-boot")
        self.run_at(monday+dt.timedelta(minutes=10), boot="new-boot")
        self.assertEqual(self.native.calls.count("enforce"), 1)
        self.assertEqual(self.state()["completedSlot"], u.weekly_slot(monday))
        self.run_at(monday+dt.timedelta(minutes=15), boot="new-boot")
        self.assertEqual(self.native.calls.count("enforce"), 1)

    def test_offline_at_deadline_and_after_countdown_does_not_complete(self):
        self.covered()
        self.native.fail = "probe"
        self.assertEqual(self.run_at(self.saturday), 1)
        self.assertLess(self.state()["completedSlot"], self.saturday.timestamp())
        self.native.fail = None
        online = self.saturday+dt.timedelta(hours=8)
        self.run_at(online, slept=True)
        self.assertEqual(self.state()["warningAt"], online.timestamp())
        self.assertNotIn("enforce", self.native.calls)
        self.run_at(online+dt.timedelta(minutes=5))
        self.native.fail = "probe"
        self.run_at(online+dt.timedelta(minutes=10))
        self.assertNotIn("warningAt", self.state())
        self.native.fail = None
        self.run_at(online+dt.timedelta(minutes=15))
        self.assertEqual(len(self.notices), 2)
        self.assertNotIn("enforce", self.native.calls)
        self.run_at(online+dt.timedelta(minutes=25))
        self.assertEqual(self.native.calls.count("enforce"), 1)

    def test_sleep_and_reboot_reset_old_warning(self):
        for boot in ["one", "reboot"]:
            with self.subTest(boot=boot):
                self.covered()
                self.notices.clear()
                self.run_at(self.saturday)
                self.run_at(self.saturday+dt.timedelta(minutes=10), boot=boot, slept=boot == "one")
                self.assertEqual(len(self.notices), 2)
                self.assertNotIn("enforce", self.native.calls)

    def test_warning_from_per_process_clock_gets_fresh_countdown(self):
        # State from the old per-process clock: warned overnight, then the laptop slept.
        warned = self.saturday.timestamp() - 8*3600
        u.save_state(self.path, {"boot": "one", "lastTickAt": warned, "lastMonotonic": 0.07,
                                "warningAt": warned, "warningSlot": u.weekly_slot(self.saturday)})
        self.awake, self.last_wall = 300000.0, warned
        self.run_at(self.saturday)
        self.assertEqual(len(self.notices), 1)
        self.assertNotIn("enforce", self.native.calls)
        self.assertNotIn("lastMonotonic", self.state())
        self.tick(self.saturday, 10)
        self.assertEqual(len(self.notices), 1)
        self.assertEqual(self.native.calls.count("enforce"), 1)

    def test_short_sleep_after_advance_warning_requires_fresh_countdown(self):
        self.covered()
        warning = self.saturday-dt.timedelta(minutes=10)
        self.run_at(warning)
        self.run_at(warning+dt.timedelta(minutes=5))
        self.run_at(self.saturday+dt.timedelta(minutes=4), slept=True)
        self.assertEqual(len(self.notices), 2)
        self.assertNotIn("enforce", self.native.calls)

    def test_warning_time_is_after_slow_probe_and_notification(self):
        self.covered()
        times = iter([self.saturday.timestamp()+480, self.saturday.timestamp()+600])
        self.run_at(self.saturday, clock=lambda: next(times))
        self.assertEqual(self.state()["warningAt"], self.saturday.timestamp()+480)
        self.run_at(self.saturday+dt.timedelta(minutes=10), clock=lambda: self.saturday.timestamp()+600)
        self.assertNotIn("enforce", self.native.calls)

    def test_notification_failure_never_starts_countdown(self):
        self.covered()
        def failed(message):
            raise RuntimeError("notification failed")
        self.assertEqual(self.run_at(self.saturday, notice=failed), 1)
        self.assertNotIn("warningAt", self.state())
        self.assertNotIn("stage", self.native.calls)
        self.assertNotIn("enforce", self.native.calls)

    def test_download_and_install_failure_remain_pending(self):
        for failure in ["stage", "enforce", "verify"]:
            with self.subTest(failure=failure):
                self.covered()
                self.native = Native()
                if failure == "stage":
                    self.native.fail = "stage"
                    self.assertEqual(self.run_at(self.saturday), 1)
                else:
                    self.run_at(self.saturday)
                    self.native.fail = failure
                    self.assertEqual(self.run_at(self.saturday+dt.timedelta(minutes=10)), 1)
                self.assertLess(self.state()["completedSlot"], self.saturday.timestamp())

    def test_relaunch_recovery_precedes_network_probe(self):
        self.covered()
        self.run_at(self.saturday)
        self.native.fail = "verify"
        self.run_at(self.saturday+dt.timedelta(minutes=10))
        self.assertTrue(self.state()["enforcementWasRunning"])
        self.native.open = False
        self.native.calls.clear()
        self.native.fail = "probe"
        self.assertEqual(self.run_at(self.saturday+dt.timedelta(minutes=15)), 1)
        self.assertEqual(self.native.calls[:2], ["verify", "probe"])
        self.assertTrue(self.native.open)
        self.assertNotIn("enforcementWasRunning", self.state())
        self.assertLess(self.state()["completedSlot"], self.saturday.timestamp())

    def test_closed_app_defers_without_warning_or_launch(self):
        self.covered()
        self.native.open = False
        self.run_at(self.saturday)
        self.assertFalse(self.native.open)
        self.assertEqual(self.notices, [])
        self.assertEqual(self.native.calls, ["probe", "stage"])
        self.assertEqual(self.state()["status"], "staged")
        self.native.available = False  # Sparkle installs immediately because the app is closed.
        self.run_at(self.saturday+dt.timedelta(minutes=5))
        self.assertFalse(self.native.open)
        self.assertEqual(self.state()["completedSlot"], self.saturday.timestamp())

    def test_no_update_is_verified_and_completes_only_latest_slot(self):
        self.native.available = False
        self.run_at(self.saturday+dt.timedelta(weeks=4))
        self.assertEqual(self.native.calls, ["probe", "verify"])
        self.assertEqual(self.state()["completedSlot"], (self.saturday+dt.timedelta(weeks=4)).timestamp())
        self.assertEqual(self.notices, [])

    def test_initial_install_only_when_missing(self):
        self.native.exists = False
        self.native.available = False
        self.run_at(self.saturday)
        self.assertEqual(self.native.calls.count("install"), 1)
        self.run_at(self.saturday+dt.timedelta(days=7))
        self.assertEqual(self.native.calls.count("install"), 1)

    def test_corrupt_state_fails_instead_of_silently_forgetting_deadline(self):
        self.path.write_text("broken")
        with self.assertRaises(ValueError):
            self.run_at(self.saturday)
        self.assertEqual(self.native.calls, [])


class NativeTests(unittest.TestCase):
    def test_probe_codes_and_native_flags(self):
        native = u.NativeUpdater(Path("/Applications/ChatGPT.app"), Path("/cache"))
        with patch.object(native, "invoke", return_value=0) as invoke:
            self.assertTrue(native.probe())
            invoke.assert_called_with(["--probe"])
        with patch.object(native, "invoke", return_value=4):
            self.assertFalse(native.probe())
        for code in [1, 3, 6, 8]:
            with patch.object(native, "invoke", return_value=code), self.assertRaises(RuntimeError):
                native.probe()
        with patch.object(native, "invoke", return_value=0) as invoke:
            native.stage()
            invoke.assert_called_once_with(["--check-immediately", "--defer-install"])
        with patch.object(native, "invoke", return_value=3), self.assertRaises(RuntimeError):
            native.enforce()

    def test_app_published_feed_from_asar(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            resources = app/"Contents/Resources"
            resources.mkdir(parents=True)
            with (app/"Contents/Info.plist").open("wb") as out:
                plistlib.dump({}, out)
            package = json.dumps({"codexSparkleFeedUrl": "https://publisher.example/appcast.xml"}).encode()
            tree = json.dumps({"files": {"package.json": {"offset": "0", "size": len(package)}}}).encode()
            header = struct.pack("<4I", 4, len(tree)+8, len(tree)+4, len(tree))
            (resources/"app.asar").write_bytes(header+tree+package)
            self.assertEqual(u.feed_url(app), "https://publisher.example/appcast.xml")

    def test_vendored_source_checksum_mismatch_stops_before_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root/"vendor/sparkle-cli"
            vendor.mkdir(parents=True)
            for name in u.CLI_SHA256:
                (vendor/name).write_text("tampered")
            with patch.object(u, "ROOT", root), patch.object(u, "checked") as checked, self.assertRaisesRegex(RuntimeError, "source checksum"):
                u.build_helper(root/"cache")
            checked.assert_not_called()

    def test_awake_clock_is_shared_by_separate_launchd_ticks(self):
        # launchd runs each tick as a new /usr/bin/python3 process. A per-process clock makes every
        # tick look like a sleep, so the warning restarts forever and the update never happens.
        python = "/usr/bin/python3" if Path("/usr/bin/python3").exists() else sys.executable
        probe = ("import importlib.machinery as m, importlib.util as i, inspect, sys;"
                 "l = m.SourceFileLoader('c', sys.argv[1]); s = i.spec_from_loader('c', l);"
                 "u = i.module_from_spec(s); l.exec_module(u);"
                 "print(inspect.signature(u.run).parameters['monotonic'].default())")
        def tick():
            return float(subprocess.check_output([python, "-c", probe, str(ROOT/"scripts/chatgpt-update")], text=True))
        first = tick()
        time.sleep(1)
        self.assertGreaterEqual(tick() - first, 0.9)

    def test_active_timeout_terminates_child_and_returns(self):
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            u.command(["sleep", "10"], timeout=0.1)
        self.assertLess(time.monotonic()-started, 5)

    def test_checksum_mismatch_does_not_compile_or_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            calls = []
            def checked(args, **kwargs):
                calls.append(args)
                if args[0]=="curl":
                    Path(args[-1]).write_bytes(b"tampered archive")
            with patch.object(u, "checked", side_effect=checked), self.assertRaisesRegex(RuntimeError, "checksum"):
                u.build_helper(cache)
            self.assertEqual(len(calls), 1)
            self.assertEqual(list(cache.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
