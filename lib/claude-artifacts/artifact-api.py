#!/usr/bin/env python3
"""The parts of Claude artifacts that `claude mcp serve` does not cover.

  prompt [--contract V]       live runtime-capability guidance (the artifact-capabilities skill body)
  defs NAME [--contract V]    TypeScript definitions for one runtime capability
  connectors                  this account's claude.ai connectors, by display name
  live ID                     the version and file hashes claude.ai serves for an artifact now
  delete ID                   delete an artifact (Pi calls this only after the user confirms)

Auth uses Claude Code's stored claude.ai OAuth login (CLAUDE_CODE_OAUTH_TOKEN, its file
descriptor, the macOS Keychain item, or .credentials.json), refreshing it when it is about to
expire. Secrets are never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ORIGIN = "https://claude.ai"
API_ORIGIN = "https://api.anthropic.com"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"]
USER_AGENT = "claude-cli/2.1.302 (external, pi-claude-artifacts)"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CONTRACT_RE = re.compile(r"^(latest|(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5}))$")
CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9]{0,23}$")


class ApiError(RuntimeError):
    pass


def config_dir() -> Path:
    if "CLAUDE_SECURESTORAGE_CONFIG_DIR" in os.environ:
        return Path(os.environ["CLAUDE_SECURESTORAGE_CONFIG_DIR"] or str(Path.home() / ".claude")).expanduser()
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        return Path(os.environ["CLAUDE_CONFIG_DIR"]).expanduser()
    return Path.home() / ".claude"


def keychain_account() -> str:
    user = os.environ.get("USER") or "claude-code-user"
    return user if re.match(r"^[a-zA-Z0-9._-]+$", user) else "claude-code-user"


def read_credentials() -> tuple[dict[str, Any] | None, str | None]:
    """Return (credentials, Keychain service or None for the plaintext file)."""
    if sys.platform == "darwin":
        # Claude Code gives a custom config dir its own hashed Keychain item.
        secure = os.environ.get("CLAUDE_SECURESTORAGE_CONFIG_DIR", os.environ.get("CLAUDE_CONFIG_DIR"))
        suffix = f"-{hashlib.sha256(str(config_dir()).encode()).hexdigest()[:8]}" if secure else ""
        custom = "-custom-oauth" if os.environ.get("CLAUDE_CODE_CUSTOM_OAUTH_URL") else ""
        service = f"Claude Code{custom}-credentials{suffix}"
        try:
            raw = subprocess.check_output(
                ["security", "find-generic-password", "-a", keychain_account(), "-w", "-s", service],
                stderr=subprocess.DEVNULL, timeout=5, text=True,
            ).strip()
            return json.loads(raw), service
        except (subprocess.SubprocessError, json.JSONDecodeError):
            pass
    try:
        return json.loads((config_dir() / ".credentials.json").read_text()), None
    except FileNotFoundError:
        return None, None


def save_credentials(creds: dict[str, Any], service: str | None) -> None:
    raw = json.dumps(creds, separators=(",", ":"), ensure_ascii=False)
    if service is None:
        path = config_dir() / ".credentials.json"
        path.write_text(raw)
        path.chmod(0o600)
        return
    command = f'add-generic-password -U -a "{keychain_account()}" -s "{service}" -X "{raw.encode().hex()}"\n'
    if subprocess.run(["security", "-i"], input=command, capture_output=True, text=True, timeout=5).returncode:
        raise ApiError("refreshed the Claude login but could not save it to the Keychain")


def access_token() -> str:
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return os.environ["CLAUDE_CODE_OAUTH_TOKEN"]
    fd = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
    if fd and fd.isdigit():
        token = Path(f"/dev/fd/{fd}").read_text().strip()
        if token:
            return token
    creds, service = read_credentials()
    oauth = (creds or {}).get("claudeAiOauth")
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        raise ApiError("no Claude Code claude.ai login found; run `claude auth login`")
    expires = oauth.get("expiresAt")
    if isinstance(expires, (int, float)) and expires - time.time() * 1000 < 5 * 60 * 1000:
        if not oauth.get("refreshToken"):
            raise ApiError("the Claude Code login has expired; run `claude auth login`")
        scopes = oauth.get("scopes") if isinstance(oauth.get("scopes"), list) else SCOPES
        body = request("POST", TOKEN_URL, None, {
            "grant_type": "refresh_token",
            "refresh_token": oauth["refreshToken"],
            "client_id": oauth.get("clientId") or CLIENT_ID,
            "scope": " ".join(scopes),
        })
        oauth.update(
            accessToken=body["access_token"],
            refreshToken=body.get("refresh_token") or oauth["refreshToken"],
            expiresAt=int(time.time() * 1000) + int(body.get("expires_in", 3600)) * 1000,
            scopes=str(body.get("scope", " ".join(scopes))).split(),
        )
        save_credentials(creds, service)
    return str(oauth["accessToken"])


def request(method: str, url: str, token: str | None, payload: Any = None, *, text: bool = False, headers: dict[str, str] | None = None) -> Any:
    sent = {"User-Agent": USER_AGENT, **(headers or {})}
    if token:
        sent.update({"Authorization": f"Bearer {token}", "anthropic-beta": sent.get("anthropic-beta", "oauth-2025-04-20"), "X-Frame-CP": "go"})
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        sent["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=sent), timeout=30) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        raise ApiError(f"{method} {url.split('?')[0]} failed: HTTP {error.code} {error.read().decode('utf-8', 'replace')[:300]}") from error
    except urllib.error.URLError as error:
        raise ApiError(f"{method} {url.split('?')[0]} failed: {error.reason}") from error
    if text:
        return raw
    return json.loads(raw) if raw else {}


def contract(token: str, version: str) -> dict[str, Any]:
    if not CONTRACT_RE.fullmatch(version):
        raise ApiError(f"invalid contract {version!r}; use 'latest' or a version such as 0.2.91")
    return request("GET", f"{ORIGIN}/api/frame/contract/{version}", token)


def show_prompt(args: argparse.Namespace) -> None:
    token = access_token()
    meta = contract(token, args.contract)
    print(request("GET", f"{ORIGIN}/api/frame/contract/{meta['version']}/prompt", token, text=True))


def show_defs(args: argparse.Namespace) -> None:
    if not CAPABILITY_RE.fullmatch(args.name):
        raise ApiError(f"invalid capability name {args.name!r}")
    token = access_token()
    meta = contract(token, args.contract)
    if args.name not in meta["capabilities"]:
        raise ApiError(f"contract {meta['version']} has no capability {args.name!r}; it has {', '.join(meta['capabilities'])}")
    print(request("GET", f"{ORIGIN}/api/frame/contract/{meta['version']}/{args.name}.d.ts", token, text=True))


def show_connectors(_args: argparse.Namespace) -> None:
    data = request("GET", f"{API_ORIGIN}/v1/mcp_servers?limit=1000", access_token(),
                   headers={"anthropic-beta": "mcp-servers-2025-12-04", "anthropic-version": "2023-06-01"})
    print(json.dumps([{"displayName": row.get("display_name"), "url": row.get("url")} for row in data["data"]], indent=2))


def require_uuid(value: str) -> str:
    if not UUID_RE.fullmatch(value):
        raise ApiError(f"expected an artifact UUID, got {value!r}")
    return value


def show_live(args: argparse.Namespace) -> None:
    boot = request("GET", f"{ORIGIN}/api/frame/{require_uuid(args.id)}", access_token())
    # A single-page artifact lists index.html without a hash.
    files = {row["path"]: row["sha256"] for row in boot.get("files") or [] if "sha256" in row}
    print(json.dumps({"artifact_id": args.id, "version": boot["ver"], "files": files}))


def delete(args: argparse.Namespace) -> None:
    require_uuid(args.id)
    token = access_token()
    request("DELETE", f"{ORIGIN}/api/frame/{args.id}", token)
    try:
        request("GET", f"{ORIGIN}/api/frame/{args.id}", token)
    except ApiError as error:
        if "HTTP 404" in str(error):
            print(json.dumps({"deleted": True, "artifact_id": args.id}))
            return
        raise
    raise ApiError("the delete was accepted, but the artifact can still be read")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    prompt = commands.add_parser("prompt", help="live runtime-capability guidance")
    prompt.add_argument("--contract", default="latest")
    prompt.set_defaults(run=show_prompt)
    defs = commands.add_parser("defs", help="TypeScript definitions for one capability")
    defs.add_argument("name")
    defs.add_argument("--contract", default="latest")
    defs.set_defaults(run=show_defs)
    commands.add_parser("connectors", help="this account's claude.ai connectors").set_defaults(run=show_connectors)
    live = commands.add_parser("live", help="the version and file hashes claude.ai serves for an artifact")
    live.add_argument("id")
    live.set_defaults(run=show_live)
    remove = commands.add_parser("delete", help="delete an artifact by UUID")
    remove.add_argument("id")
    remove.set_defaults(run=delete)
    args = parser.parse_args()
    try:
        args.run(args)
    except ApiError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
