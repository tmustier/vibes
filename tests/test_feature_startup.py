#!/usr/bin/env python3
"""Real Pi resource selection, including migration; no credentials or model call needed."""
import json
import os
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def commands(agent, project):
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "HOME": str(agent.parent / "home")}
    pi = subprocess.Popen(["pi", "--mode", "rpc", "--no-session"], cwd=project, env=env,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        pi.stdin.write('{"id":"commands","type":"get_commands"}\n')
        pi.stdin.flush()
        deadline = time.time() + 90
        while time.time() < deadline and pi.poll() is None:
            for stream in select.select([pi.stdout, pi.stderr], [], [], 1)[0]:
                line = stream.readline().strip()
                if not line:
                    continue
                if stream is pi.stderr:
                    assert "Error" not in line and "conflicts with" not in line, line
                    continue
                event = json.loads(line)
                assert event.get("type") != "extension_error", event
                if event.get("id") == "commands":
                    return {c["name"] for c in event["data"]["commands"]}
        raise AssertionError("Pi did not answer get_commands")
    finally:
        pi.kill()
        pi.wait()


with tempfile.TemporaryDirectory(prefix="vibes-feature-startup-") as scratch:
    agent = Path(scratch, "agent")
    project = Path(scratch, "project")
    agent.mkdir()
    project.mkdir()
    Path(scratch, "home").mkdir()
    settings = agent / "settings.json"
    config = agent / "vibes.json"
    settings.write_text(json.dumps({"packages": [str(ROOT)]}))
    default = commands(agent, project)
    assert "cache" not in default and "pace" not in default
    assert {"skill:surf", "open", "ysk"} <= default
    settings.write_text(json.dumps({"packages": [str(ROOT), str(ROOT / "node_modules/pi-you-should-know")]}))
    assert "ysk" in commands(agent, project), "a separately installed copy must not register /ysk twice"
    settings.write_text(json.dumps({"packages": [str(ROOT)]}))
    config.write_text(json.dumps({"features": {"cachemire": True, "meantime": True, "surf": False, "open": False, "you-should-know": False}}))
    opted = commands(agent, project)
    assert "cache" in opted and "pace" not in opted and "skill:surf" not in opted, "Vibes must not bypass the Meantime experimental flag"
    assert "open" not in opted and "ysk" not in opted, "named opt-outs also disable Vibes-owned extensions"
    config.write_text(json.dumps({"features": {"typo": True}}))
    try:
        commands(agent, project)
    except AssertionError as error:
        assert "Unknown Vibes feature 'typo'" in str(error)
    else:
        raise AssertionError("Pi accepted an unknown feature")
    config.write_text(json.dumps({"features": {"cachemire": True, "meantime": True, "surf": False}}))
    native_config = Path(scratch, "home", ".pi", "agent", "pi-meantime.json")
    native_config.parent.mkdir(parents=True)
    native_config.write_text(json.dumps({"enabled": True}))
    activated = commands(agent, project)
    assert {"cache", "pace"} <= activated
    native_config.write_text(json.dumps({"enabled": False}))
    assert "pace" not in commands(agent, project), "explicit extension opt-out remains authoritative"
    native_config.write_text(json.dumps({"enabled": True}))
    settings.write_text(json.dumps({"packages": [{"source": str(ROOT), "extensions": ["!extensions/cachemire.ts", "-extensions/meantime.ts"]}]}))
    native = commands(agent, project)
    assert "cache" not in native and "pace" not in native, "native exclusions beat true"

    # Actual scratch personal migration, then Pi loads the same installed Vibes copy.
    config.write_text(json.dumps({"features": {"cachemire": True, "meantime": True}}))
    settings.write_text(json.dumps({"packages": [{"source": str(ROOT), "extensions": ["!extensions/surf.ts"]}]}))
    before = commands(agent, project)
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent)}
    result = subprocess.run(["bash", str(ROOT / "scripts/vibes"), "features", "migrate", "--source", str(ROOT), "--apply"],
                            env=env, text=True, capture_output=True, check=True)
    assert "Applied. Backups:" in result.stdout
    assert json.loads(config.read_text())["features"]["surf"] is False
    assert json.loads(settings.read_text())["packages"] == [{"source": str(ROOT)}]
    after = commands(agent, project)
    assert before == after, "migration must preserve actual Pi command/resource selection"
    assert {"cache", "pace"} <= after and "skill:surf" not in after
    native_config.unlink()
    # A previous separate selected copy keeps ownership. Meantime selection alone was inert.
    observers = {"source": str(ROOT / "node_modules/pine-of-glass"),
                 "extensions": ["extensions/pi-cachemire/index.ts", "extensions/pi-meantime/index.ts"], "skills": [], "prompts": []}
    settings.write_text(json.dumps({"packages": [str(ROOT), observers]}))
    previous = commands(agent, project)
    assert "cache" in previous and "pace" not in previous, "separate copy retains its own default-off Meantime gate"
    # Explicit reviewed migration: keep old inert Meantime choice; remove only redundant observers.
    settings.write_text(json.dumps({"packages": [str(ROOT)]}))
    config.write_text(json.dumps({"features": {"cachemire": True, "meantime": False, "surf": False}}))
    reviewed = commands(agent, project)
    assert previous == reviewed, "reviewed separate-resource migration preserves actual command selection"
    print(f"ok: real Pi defaults ({len(default)} commands), opt-ins, native precedence, scratch migration ({len(after)} commands), reviewed observer migration")
