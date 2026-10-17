#!/usr/bin/env python3
"""Catch-up decisions use durable success, not the date of the latest attempt/upload."""
import datetime as dt
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("refresh", str(ROOT / "scripts/refresh"))
spec = importlib.util.spec_from_loader(loader.name, loader)
refresh = importlib.util.module_from_spec(spec)
loader.exec_module(refresh)


def date(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.agent = Path(self.folder.name)
        env = patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(self.agent), "TZ": "Europe/London"})
        env.start()
        time.tzset()
        self.addCleanup(lambda: (env.stop(), time.tzset()))
        self.now = date("2026-10-14T08:00:00Z")

    def status(self, steps, finished="2026-10-14T04:00:00Z"):
        (self.agent / "vibes-update.json").write_text(json.dumps({"finishedAt": finished,
            "steps": [{"name": name, "ok": ok} for name, ok in steps]}))

    def state(self):
        return refresh.read(self.agent / "vibes-refresh.json")

    def test_weekend_holiday_and_first_install_catch_up_once(self):
        for previous in [None, "2026-10-09T04:00:00Z", "2026-09-01T04:00:00Z"]:
            with self.subTest(previous=previous):
                refresh.save({"lastUpdateSuccessAt": previous})
                calls = []
                def execute(command):
                    calls.append(command)
                    self.status([("homebrew", True)])
                    refresh.record_update()
                    return 0
                refresh.run(self.now, execute)
                self.assertEqual([c[-1] for c in calls], ["update"])
                refresh.run(self.now, execute)
                self.assertEqual([c[-1] for c in calls], ["update", "send"])

    def test_failed_upload_does_not_repeat_update(self):
        refresh.begin_update(self.now)
        self.status([("homebrew", True), ("pi", True), ("telemetry", False), ("usage-telemetry", False)])
        refresh.record_update()
        state = self.state()
        self.assertEqual(state["lastUpdateSuccessAt"], "2026-10-14T04:00:00Z")
        (self.agent / "vibes-inventory.json").write_text("{}")
        calls = []
        self.assertEqual(refresh.run(self.now, lambda c: calls.append(c) or 1), 1)
        self.assertEqual([Path(c[0]).name for c in calls], ["inventory", "usage-telemetry"])
        self.assertEqual(self.state(), state)
        status = refresh.read(self.agent / "vibes-update.json")
        self.assertTrue(status["ok"])
        self.assertEqual(status["finishedAt"], "2026-10-14T04:00:00Z")
        self.assertEqual([s["name"] for s in status["steps"] if not s["ok"]], ["telemetry", "usage-telemetry"])

    def test_successful_upload_retry_clears_only_upload_failures(self):
        refresh.save({"lastUpdateSuccessAt": "2026-10-14T04:00:00Z"})
        self.status([("homebrew", True), ("usage-telemetry", False)])
        refresh.run(self.now, lambda c: 0)
        status = refresh.read(self.agent / "vibes-update.json")
        self.assertTrue(status["ok"])
        self.assertEqual(status["finishedAt"], "2026-10-14T04:00:00Z")
        self.status([("homebrew", False), ("usage-telemetry", False)])
        refresh.run(self.now, lambda c: 0)
        self.assertFalse(refresh.read(self.agent / "vibes-update.json")["ok"])

    def test_failed_update_and_crash_retry_after_hour_not_next_night(self):
        refresh.begin_update(self.now)
        self.status([("homebrew", True), ("pi", False)])
        refresh.record_update()
        self.assertNotIn("lastUpdateSuccessAt", self.state())
        self.assertFalse(refresh.due(self.state(), self.now + dt.timedelta(minutes=59)))
        self.assertTrue(refresh.due(self.state(), self.now + dt.timedelta(hours=1)))
        # A power-off leaves the attempt behind; it must not defer work indefinitely.
        refresh.begin_update(self.now)
        self.assertTrue(refresh.due(self.state(), self.now + dt.timedelta(days=20)))

    def test_existing_full_update_seeds_state_but_hotfix_does_not(self):
        self.status([("homebrew", True), ("telemetry", False)])
        calls = []
        refresh.run(self.now, lambda c: calls.append(c) or 0)
        self.assertNotIn("update", [c[-1] for c in calls])
        (self.agent / "vibes-refresh.json").unlink()
        self.status([("packages", True), ("pi", True)])
        calls.clear()
        refresh.run(self.now, lambda c: calls.append(c) or 0)
        self.assertEqual(calls[0][-1], "update")

    def test_first_upload_failure_is_visible_on_legacy_status(self):
        self.status([("homebrew", True)])
        path = self.agent / "vibes-update.json"
        previous = {**refresh.read(path), "ok": True, "notes": ["kept local work"], "agentsTemplateHash": "template"}
        path.write_text(json.dumps(previous))
        self.assertEqual(refresh.run(self.now, lambda c: 1), 1)
        status = refresh.read(self.agent / "vibes-update.json")
        self.assertTrue(status["ok"], "upload failure must not change installation success")
        self.assertEqual(status["steps"][-1], {"name": "usage-telemetry", "ok": False, "detail": "exit 1"})
        for key in ("finishedAt", "notes", "agentsTemplateHash"):
            self.assertEqual(status[key], previous[key])
        self.assertEqual(refresh.run(self.now, lambda c: 0), 0)
        self.assertTrue(all(s["ok"] for s in refresh.read(path)["steps"]))

    def test_local_nightly_boundary_and_dst(self):
        # October is BST until 25 October. The UTC equivalent of 04:04 changes on that date.
        for now, expected in [("2026-10-14T08:00:00Z", "2026-10-14T03:04:00Z"),
                              ("2026-10-14T02:00:00Z", "2026-10-13T03:04:00Z"),
                              ("2026-10-25T08:00:00Z", "2026-10-25T04:04:00Z"),
                              ("2026-10-25T02:00:00Z", "2026-10-24T03:04:00Z")]:
            self.assertEqual(refresh.latest_nightly(date(now)), date(expected).timestamp())

    def test_failed_attempt_still_runs_collect_upload(self):
        calls = []
        self.assertEqual(refresh.run(self.now, lambda c: calls.append(c) or 2), 2)
        self.assertEqual([c[-1] for c in calls], ["update", "send"])
        self.assertEqual(self.state()["lastUpdateAttemptAt"], refresh.stamp(self.now))


if __name__ == "__main__":
    unittest.main()
