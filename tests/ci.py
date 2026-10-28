#!/usr/bin/env python3
"""Run independent CI checks in separate processes, retaining every failure and log."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import ExitStack
from pathlib import Path
import shlex
import subprocess
import tempfile

# agent-default (not a user rule): 2026-10-22. Avoid oversubscribing hosted runners.
WORKERS = 4

SUITES = {
    "portable": [
        "npm run typecheck",
        "python3 tests/test_ci.py",
        "python3 tests/test_node_version.py",
        "python3 tests/test_public_release.py",
        "node --test tests/test_granola_mcp_fetch.mjs",
        "bash tests/test_home_command.sh",
        "python3 tests/test_home_update.py",
        "npx --no-install jiti tests/test_bundled.mjs",
        "npx --no-install jiti tests/test_features.mjs",
        "node --test tests/test_amp_orbs.mjs",
        "npx --no-install jiti tests/test_amp_orbs_extension.mjs",
        "npx --no-install jiti tests/test_claude_artifacts.mjs",
        "node tests/test_tips.mjs",
        "node tests/test_send_approval.mjs",
        "node tests/test_update_status.mjs",
        "node tests/test_sync_settings.mjs",
        "node tests/test_oracle_context.mjs",
        "node tests/test_cache_safe_prompts.mjs",
        "node tests/test_wut.mjs",
        "node tests/test_fast_mode.mjs",
        "npm run test:anthropic-gzip",
        "python3 tests/test_inventory.py",
        "python3 tests/test_telemetry_destination.py",
        "python3 tests/test_usage_telemetry.py",
        "python3 tests/test_refresh.py",
        "python3 tests/test_papercut.py",
        "bash tests/test_update_repo.sh",
        "node tests/test_pi_1_migration.mjs",
        "node tests/test_rolling_packages.mjs",
    ],
    "macos": [
        "bash tests/test_vibes_check.sh",
        "bash tests/test_vibes_inventory.sh",
        "env PATH=/usr/bin:/bin:/usr/sbin /usr/bin/python3 tests/test_telemetry_destination.py",
        "bash tests/test_update_steps.sh",
        "bash tests/test_refresh_job.sh",
        "bash tests/test_hotfix.sh",
        "bash tests/test_install_pinned_pi.sh",
        "bash tests/test_vibes_sources.sh",
        "node tests/test_park.mjs",
        "python3 -m unittest discover -s tests -p test_park_terminal.py",
        "python3 tests/test_chrome_cookies.py",
    ],
}


def run_checks(commands: list[list[str]]) -> int:
    failed = False
    with tempfile.TemporaryDirectory(prefix="vibes-ci-") as scratch, ExitStack() as files, ThreadPoolExecutor(max_workers=WORKERS) as pool:
        pending = {}
        for index, command in enumerate(commands):
            log = files.enter_context(Path(scratch, f"{index}.log").open("w+"))
            future = pool.submit(subprocess.run, command, stdout=log, stderr=subprocess.STDOUT)
            pending[future] = (command, log)
        for future in as_completed(pending):
            command, log = pending[future]
            result = future.result()
            failed |= result.returncode != 0
            status = "passed" if result.returncode == 0 else f"FAILED ({result.returncode})"
            print(f"::group::{shlex.join(command)}: {status}", flush=True)
            log.seek(0)
            print(log.read(), end="", flush=True)
            print("::endgroup::", flush=True)
    return int(failed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", choices=SUITES)
    args = parser.parse_args()
    raise SystemExit(run_checks([shlex.split(command) for command in SUITES[args.suite]]))
