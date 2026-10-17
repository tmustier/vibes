#!/usr/bin/env python3
"""Start Pi on the Vibes bundle in an isolated agent directory and fail on any load error.

Usage: tests/startup_check.py [package-source]   (default: this checkout, which needs
`npm install --omit=dev` first). Catches duplicate tools, broken wrappers and missing
dependencies before they reach teammates.
"""

import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = {
    "onboard", "mcp", "search", "computer-use-status", "fast", "hud",
    "contextimate", "drill", "codex", "read-agent-instructions:stats",
    "papercuts-review", "do-less", "skill:bro", "skill:surf", "skill:extending-pi", "skill:google-workspace-stack",
    "skill:linkedin-lookup", "skill:unslop", "skill:visual-verify", "skill:tmux",
    "goal", "create-goal", "subagents", "wut", "paste", "code", "usage", "ysk",
    "browser-import", "browser-status", "browser-reset",
    "readfiles", "open", "voice-settings", "skill:chrome-cookies",
    "skill:radius-api", "skill:ask-granola",
}

source = sys.argv[1] if len(sys.argv) > 1 else str(ROOT)
agent_dir = tempfile.mkdtemp(prefix="vibes-startup-")
Path(agent_dir, "settings.json").write_text(json.dumps({"packages": [source]}))
env = {**os.environ, "PI_CODING_AGENT_DIR": agent_dir}

if not Path(source).exists():
    subprocess.run(["pi", "update", "--extensions"], env=env, cwd=agent_dir, check=True)

pi = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"], env=env, cwd=agent_dir,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
pi.stdin.write(json.dumps({"id": "commands", "type": "get_commands"}) + "\n")
pi.stdin.flush()

commands, errors, deadline = None, [], time.time() + 90
mcp_source = None
while commands is None and time.time() < deadline and pi.poll() is None:
    ready, _, _ = select.select([pi.stdout, pi.stderr], [], [], 1)
    for stream in ready:
        line = stream.readline().strip()
        if not line:
            continue
        if stream is pi.stderr:
            if line.startswith("Error") or "conflicts with" in line:
                errors.append(line)
            continue
        event = json.loads(line)
        if event.get("type") == "extension_error":
            errors.append(json.dumps(event))
        if event.get("id") == "commands":
            listed = event["data"]["commands"]
            commands = {c["name"] for c in listed}
            mcp_source = next((c.get("sourceInfo", {}).get("path") for c in listed if c["name"] == "mcp"), None)
pi.kill()
shutil.rmtree(agent_dir, ignore_errors=True)

if errors:
    sys.exit("Pi reported load errors:\n" + "\n".join(errors))
if commands is None:
    sys.exit("Pi did not answer get_commands (it may have failed to start)")
if "skill:nex-hr" in commands:
    sys.exit("Work-only HR skill must not be bundled")
missing = REQUIRED - commands
if missing:
    sys.exit(f"Missing commands: {sorted(missing)}")
if mcp_source != "builtin:mcp":
    sys.exit(f"/mcp is not Pi's built-in MCP command: {mcp_source}")
print(f"ok: {len(commands)} commands, no load errors")
