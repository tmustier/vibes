#!/usr/bin/env python3
"""Independent claude.ai checks for the claude-artifacts live test. Prints JSON, never secrets.

  state UUID    whether the artifact exists, with its title, version, access, capabilities and HTML
"""
import importlib.util
import json
import sys
import urllib.parse
from pathlib import Path

spec = importlib.util.spec_from_file_location("api", Path(__file__).resolve().parent.parent / "lib/claude-artifacts/artifact-api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def state(uuid: str) -> dict:
    token = api.access_token()
    try:
        boot = api.request("GET", f"{api.ORIGIN}/api/frame/{uuid}", token)
    except api.ApiError as error:
        if "HTTP 404" in str(error):
            return {"exists": False}
        raise
    runtime = api.request("GET", f"{api.ORIGIN}/api/frame/read/{uuid}", token)
    version, asset = boot["ver"], urllib.parse.quote(str(boot["assetToken"]), safe="")
    html = api.request("GET", f"https://{uuid}.frame.claudeusercontent.com/_f/{version}/?__frame_t={asset}", None, text=True)
    return {
        "exists": True,
        "title": boot.get("title"),
        "version": version,
        "role": (boot.get("perm") or {}).get("role"),
        "audience": (boot.get("perm") or {}).get("mode"),
        "capabilities": runtime.get("capabilities"),
        "html": html,
    }


if __name__ == "__main__":
    assert len(sys.argv) == 3 and sys.argv[1] == "state" and api.UUID_RE.fullmatch(sys.argv[2]), __doc__
    print(json.dumps(state(sys.argv[2])))
