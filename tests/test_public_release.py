#!/usr/bin/env python3
"""Check the public tree's branding and local-only publication defaults."""
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]


class PublicReleaseTests(unittest.TestCase):
    def test_no_company_references(self):
        company = "nex" + "cade"
        paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
        matches = []
        for name in set(filter(None, paths)):
            path = ROOT / name
            if company in name.lower() or (path.is_file() and company in path.read_text().lower()):
                matches.append(name)
        self.assertEqual(sorted(matches), [])

    def test_local_only_defaults(self):
        settings = json.loads((ROOT / "settings.template.json").read_text())
        self.assertIsNone(settings["telemetryDestination"])
        extension = (ROOT / "extensions/papercut.ts").read_text()
        self.assertRegex(extension, r"const AUTO_SUBMIT_REPO: string \| undefined = undefined;")
        self.assertNotIn("skills/nex-hr", json.dumps(settings))
        self.assertFalse((ROOT / "skills/nex-hr").exists())

    def test_no_automatic_source_import_or_push(self):
        updater = (ROOT / "scripts/home-update").read_text()
        commands = "\n".join(line for line in updater.splitlines() if not line.startswith("#"))
        self.assertNotRegex(commands, r"\bgit\b[^\n]*\b(push|upstream)\b")
        self.assertIn('merge --ff-only origin/main', commands)
        managed = (ROOT / "scripts/vibes").read_text()
        self.assertNotRegex(managed, r"step commercial\b")

    def test_mit_license_and_third_party_notices(self):
        license_text = (ROOT / "LICENSE").read_text()
        self.assertIn("MIT License", license_text)
        self.assertIn("Copyright (c) 2026 Thomas Mustier", license_text)
        self.assertIn("Permission is hereby granted, free of charge", license_text)
        manifest = json.loads((ROOT / "package.json").read_text())
        lock = json.loads((ROOT / "package-lock.json").read_text())
        self.assertEqual(manifest["license"], "MIT")
        self.assertEqual(lock["packages"][""]["license"], "MIT")
        self.assertIn("Matt Shumer", (ROOT / "skills/unslop/LICENSE").read_text())
        self.assertTrue((ROOT / "skills/google-workspace-stack/LICENSE").is_file())

    def test_local_package_identity(self):
        manifest = json.loads((ROOT / "package.json").read_text())
        lock = json.loads((ROOT / "package-lock.json").read_text())
        self.assertEqual(manifest["name"], "personal-vibes")
        self.assertEqual(lock["name"], manifest["name"])
        for name in ("pi-browser", "pi-anthropic-gzip"):
            package = json.loads((ROOT / "packages" / name / "package.json").read_text())
            self.assertEqual(package["name"], f"@tmustier/{name}")
            self.assertEqual(manifest["dependencies"][package["name"]], f"file:packages/{name}")


if __name__ == "__main__":
    unittest.main()
