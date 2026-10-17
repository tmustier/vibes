#!/usr/bin/env python3
"""Explicit live model/tool test against a local HTTP receiver, never a production destination.

Run: python3 tests/telemetry_destination_acceptance.py /absolute/evidence-directory
Uses the existing openai-codex login and model quota. No personal settings change.
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

from test_telemetry_destination import DestinationTests

ROOT = Path(__file__).resolve().parents[1]
evidence = Path(sys.argv[1]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
fixture = DestinationTests()
fixture.setUp()
workspace = fixture.agent.parent / "workspace"
workspace.mkdir()
try:
    (fixture.agent / "auth.json").unlink()
    (fixture.agent / "auth.json").symlink_to(Path.home() / ".pi/agent/auth.json")
    settings = json.loads((ROOT / "settings.template.json").read_text())
    settings["packages"] = [{"source": str(ROOT)}]
    settings["telemetryDestination"] = fixture.http(tokenEnv="TEST_TELEMETRY_TOKEN")
    (fixture.agent / "settings.json").write_text(json.dumps(settings))
    shutil.copy2(ROOT / "profiles/home.vibes.json", fixture.agent / "vibes.json")
    script = shlex.quote(str(ROOT / "scripts/usage-telemetry"))
    prompt = ("Use your shell tool once to run this exact command in the current directory, "
              "then report whether it succeeded. This is synthetic acceptance data.\n"
              f"printf TELEMETRY_ROUTE_OK > proof.txt && python3 {script} send && python3 {script} send")
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(fixture.agent),
           "TEST_TELEMETRY_TOKEN": "synthetic-test-credential"}
    with (evidence / "events.jsonl").open("w") as stdout, (evidence / "stderr.log").open("w") as stderr:
        result = subprocess.run(["pi", "--mode", "json", "--model", "openai-codex/gpt-6.1-sol",
            "--thinking", "medium", "--session", str(fixture.agent / "sessions/acceptance.jsonl"), prompt],
            cwd=workspace, env=env, stdout=stdout, stderr=stderr, timeout=180)
    assert result.returncode == 0, "Pi failed; inspect private stderr evidence"
    assert (workspace / "proof.txt").read_text() == "TELEMETRY_ROUTE_OK"
    puts = [r for r in fixture.requests if r[0] == "PUT"]
    assert len(puts) == 1, f"Expected one acknowledged upload and no second PUT, got {len(puts)}"
    method, path, headers, body = puts[0]
    document = json.loads(body)
    assert document["sender"] == "home-user"
    assert path.startswith("/telemetry/usage/home-user/")
    assert headers["Authorization"] == "Bearer synthetic-test-credential"
    assert "TELEMETRY_ROUTE_OK" not in body.decode()
    assert str(workspace) not in body.decode()
    assert "synthetic-test-credential" not in body.decode()
    assert sum(row["records"] for bucket in document["days"].values() for row in bucket["models"]) > 0
    assert not fixture.gh_calls.exists(), "HTTP telemetry must never query GitHub"
    events = [json.loads(line) for line in (evidence / "events.jsonl").read_text().splitlines() if line.startswith("{")]
    tools = [e["toolName"] for e in events if e.get("type") == "tool_execution_end" and not e.get("isError")]
    assert any(t in ("bash", "exec_command") for t in tools)
    (evidence / "uploaded.json").write_bytes(body)
    (evidence / "result.json").write_text(json.dumps({"passed": True,
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "provider": "openai-codex", "model": "gpt-6.1-sol", "thinking": "medium", "prompt": prompt,
        "tools": tools, "uploads": len(puts), "filesystemVerified": True, "receiverVerified": True,
        "untested": ["production HTTP receiver", "live GitHub repository writes"]}, indent=2))
    subprocess.run(["git", "diff", "HEAD", "--output=" + str(evidence / "tested.patch")], cwd=ROOT, check=True)
    print(json.dumps({"passed": True, "tools": tools, "uploads": len(puts), "evidence": str(evidence)}))
finally:
    fixture.tearDown()
