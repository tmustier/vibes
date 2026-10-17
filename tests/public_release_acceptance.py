#!/usr/bin/env python3
"""Live model/tool privacy smoke test. Uses the existing login, isolated settings and scratch data.

Usage: python3 tests/public_release_acceptance.py /absolute/private-evidence-directory
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
evidence = Path(sys.argv[1]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
prompt = (
    "Run this synthetic acceptance test using actual tools. First call papercut once with note "
    "'The synthetic fixture required a second lookup.' and context 'public-release-fixture'. "
    "Then use bash to run exactly: printf PUBLIC_RELEASE_OK > proof.txt. "
    "Do not invoke any other tools or submit anything remotely. Report the local capture result."
)
with tempfile.TemporaryDirectory(prefix="vibes-public-acceptance-") as scratch:
    scratch = Path(scratch)
    agent, workspace, bin_dir = (scratch / name for name in ("agent", "workspace", "bin"))
    for path in (agent, workspace, bin_dir):
        path.mkdir()
    (agent / "auth.json").symlink_to(Path.home() / ".pi/agent/auth.json")
    settings = json.loads((ROOT / "settings.template.json").read_text())
    settings["packages"] = [str(ROOT)]
    (agent / "settings.json").write_text(json.dumps(settings))
    features = json.loads((ROOT / "profiles/home.vibes.json").read_text())
    features["features"]["papercut"] = True
    (agent / "vibes.json").write_text(json.dumps(features))
    calls = scratch / "gh-calls"
    gh = bin_dir / "gh"
    gh.write_text('#!/bin/sh\nprintf "called\\n" >> "$PUBLIC_TEST_GH_CALLS"\nexit 91\n')
    gh.chmod(0o755)
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent),
           "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "PUBLIC_TEST_GH_CALLS": str(calls)}
    with (evidence / "events.jsonl").open("w") as stdout, (evidence / "stderr.log").open("w") as stderr:
        result = subprocess.run(["pi", "--mode", "json", "--model", "openai-codex/gpt-6.1-sol",
            "--thinking", "medium", "--session", str(agent / "sessions/acceptance.jsonl"), "-p", prompt],
            cwd=workspace, env=env, stdout=stdout, stderr=stderr, timeout=240)
    assert result.returncode == 0, "Pi failed; inspect private evidence"
    events = [json.loads(line) for line in (evidence / "events.jsonl").read_text().splitlines() if line.startswith("{")]
    executed = [event for event in events if event.get("type") == "tool_execution_end"]
    captures = [event for event in executed if event.get("toolName") == "papercut"]
    assert len(captures) == 1 and not captures[0].get("isError"), "Expected one successful real capture"
    assert any(event.get("toolName") in ("bash", "exec_command") and not event.get("isError") for event in executed)
    assert (workspace / "proof.txt").read_text() == "PUBLIC_RELEASE_OK"
    notes = list(scratch.rglob("PAPERCUTS.md"))
    assert len(notes) == 1 and "The synthetic fixture required a second lookup." in notes[0].read_text()
    assert not calls.exists(), "Local-only capture must not invoke GitHub"
    details = captures[0]["result"]["details"]
    assert not details.get("submissionUrl") and not details.get("submissionPending")
    record = {"passed": True, "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "provider": "openai-codex", "model": "gpt-6.1-sol", "thinking": "medium", "prompt": prompt,
        "tools": [event["toolName"] for event in executed], "filesystemVerified": True,
        "localCaptureVerified": True, "githubCalls": 0,
        "untested": ["nightly launchd installation", "live update of a personal checkout", "external connectors"]}
    (evidence / "result.json").write_text(json.dumps(record, indent=2) + "\n")
    subprocess.run(["git", "diff", "HEAD", "--output=" + str(evidence / "tested.patch")], cwd=ROOT, check=True)
    print(json.dumps(record))
