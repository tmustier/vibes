#!/usr/bin/env python3
"""Live startup-repair test in a private tmux server with synthetic updater dependencies.

Usage: python3 tests/home_update_acceptance.py /absolute/private-evidence-directory
Uses the existing Codex login. Never upgrades this Mac or writes to a remote repository.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

from test_home_update import HomeUpdateTests, ROOT


def entries(path):
    result = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # The running process may not have finished its latest line yet.
    return result


evidence = Path(sys.argv[1]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
fixture = HomeUpdateTests()
fixture.setUp()
socket = str(fixture.root / "tmux.sock")
try:
    (fixture.bin / "pi").unlink()  # Use the real installed Pi for the model and startup check.
    npm = fixture.bin / "npm"
    npm.write_text('#!/bin/bash\nif [ "${TEST_PACKAGES_EXIT:-0}" != 0 ]; then\n'
                   'echo "Synthetic transient package failure. A normal vibes update retry now succeeds; do not edit sources."\n'
                   'exit "$TEST_PACKAGES_EXIT"\nfi\nexit 0\n')
    wrapper = fixture.repo / "scripts/vibes"
    wrapper.write_text(wrapper.read_text().replace(
        'check) exit "${TEST_STARTUP_EXIT:-0}" ;;', 'check) cmd_check "${2:-}" ;;').replace(
        '*) exit 2 ;;', 'report) touch "$PI_CODING_AGENT_DIR/unwanted-report"; exit 2 ;;\n    *) exit 2 ;;'))
    fixture.git(fixture.repo, "add", "scripts/vibes")
    fixture.git(fixture.repo, "-c", "user.name=Vibes test fixture", "-c", "user.email=fixture@example.net",
                "commit", "-qm", "Use real Pi startup in live fixture")
    settings = json.loads((ROOT / "settings.template.json").read_text())
    settings["packages"] = [str(ROOT)]
    (fixture.agent / "settings.json").write_text(json.dumps(settings))
    (fixture.agent / "vibes.json").write_text((ROOT / "profiles/home.vibes.json").read_text())
    (fixture.agent / "auth.json").symlink_to(Path.home() / ".pi/agent/auth.json")
    (fixture.agent / "APPEND_SYSTEM.md").write_text(
        f"This is an isolated home-update repair fixture. HOME={fixture.home}; the scratch checkout is {fixture.repo}. "
        "The scratch vibes command uses local Git and synthetic npm dependencies; retrying it does not upgrade the host. "
        "The package error is intentionally transient. Run the scratch vibes update to repair it, verify vibes status, "
        "and do not edit package sources or change any real user settings. Keep reports local.\n")
    commands = fixture.home / ".local/bin"
    commands.mkdir(parents=True)
    (commands / "vibes").symlink_to(fixture.repo / "scripts/home-vibes")
    failed = fixture.update(TEST_PACKAGES_EXIT="23")
    assert failed.returncode == 23 and fixture.status()["ok"] is False
    (evidence / "failed-status.json").write_text(json.dumps(fixture.status(), indent=2))
    workspace = fixture.home / "workspace"
    workspace.mkdir()
    transcript = evidence / "session.jsonl"
    env = {**fixture.env, "PATH": str(commands) + os.pathsep + str(fixture.bin) + os.pathsep + os.environ["PATH"]}
    env.pop("TEST_PACKAGES_EXIT", None)
    env.pop("PI_SUBAGENT_CHILD", None)
    env.pop("VIBES_CHECK_READY", None)
    command = shlex.join(["pi", "--model", "openai-codex/gpt-6.1-sol", "--thinking", "medium", "--session", str(transcript)])
    subprocess.run(["tmux", "-S", socket, "new-session", "-d", "-s", "repair", "-x", "220", "-y", "80",
                    "-c", str(workspace), command], env=env, check=True)
    # agent-default (not a user rule): 2026-10-17. Bound this opt-in test to four minutes.
    deadline = time.monotonic() + 240
    observed = []
    while time.monotonic() < deadline:
        observed = entries(transcript)
        messages = [item.get("message", {}) for item in observed if item.get("type") == "message"]
        assistants = [m for m in messages if m.get("role") == "assistant"]
        if fixture.status()["ok"] and assistants and assistants[-1].get("stopReason") == "stop":
            break
        time.sleep(0.5)
    screen = subprocess.check_output(["tmux", "-S", socket, "capture-pane", "-p", "-J", "-S", "-", "-t", "repair"], text=True)
    (evidence / "screen.txt").write_text(screen)
    assert fixture.status()["ok"] is True, "Repair did not finish; inspect private evidence"
    triggers = [e for e in observed if e.get("type") == "custom_message" and e.get("customType") == "vibes-update-failed"]
    assert len(triggers) == 1, "Expected the real automatic startup repair trigger"
    assert "vibes report" not in triggers[0]["content"]
    tools = [m for m in messages if m.get("role") == "toolResult" and not m.get("isError")]
    assert any(m.get("toolName") in ("bash", "exec_command") for m in tools), "No successful real shell tool call"
    assert any(m.get("provider") == "openai-codex" and m.get("model") == "gpt-6.1-sol" for m in assistants)
    assert assistants[-1].get("stopReason") == "stop", "Model has not finished verification"
    assert any(s["name"] == "startup" and s["ok"] for s in fixture.status()["steps"])
    assert not (fixture.agent / "unwanted-report").exists()
    assert not (fixture.agent / "vibes-repair.lock").exists(), "Repair lock was not released after settlement"
    assert fixture.git(fixture.repo, "status", "--porcelain") == ""
    (evidence / "success-status.json").write_text(json.dumps(fixture.status(), indent=2))
    result = {"passed": True, "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "provider": "openai-codex", "model": "gpt-6.1-sol", "thinking": "medium",
              "trigger": "vibes-update-failed", "automaticRepair": True,
              "tools": [m.get("toolName") for m in tools], "statusVerified": True,
              "realPiStartupVerified": True, "remoteReportAttempted": False,
              "untested": ["live npm failure", "external connector sign-ins"]}
    (evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    subprocess.run(["git", "diff", "HEAD", "--output=" + str(evidence / "tested.patch")], cwd=ROOT, check=True)
    print(json.dumps(result))
finally:
    subprocess.run(["tmux", "-S", socket, "kill-server"], capture_output=True)
    fixture.doCleanups()
