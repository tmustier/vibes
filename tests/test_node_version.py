#!/usr/bin/env python3
"""Keep CI rolling to the latest patch of the repository's Node major."""
import os
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = Path(os.environ.get("STARTUP_WORKFLOW_UNDER_TEST", ROOT / ".github/workflows/startup.yml"))


class NodeVersionTests(unittest.TestCase):
    def test_node_version_selects_a_major_not_a_patch(self):
        self.assertRegex((ROOT / ".node-version").read_text().strip(), r"^\d+$")

    def test_setup_node_checks_latest_patch(self):
        workflow = WORKFLOW.read_text()
        setups = re.findall(r"(?m)^      - uses: actions/setup-node@[^\n]+\n((?:        [^\n]*\n)+)", workflow)
        self.assertTrue(setups, "startup must set up Node")
        for setup in setups:
            self.assertRegex(setup, r"(?m)^          node-version-file: \.node-version$")
            self.assertRegex(setup, r"(?m)^          check-latest: true$")


if __name__ == "__main__":
    unittest.main()
