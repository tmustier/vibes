#!/usr/bin/env python3
"""Publish or fetch Claude Code Artifacts directly.

Publishing uses the same private frame deploy endpoint that Claude Code's
built-in Artifact tool calls. Fetching uses the same boot + asset-token path
that Claude Code's WebFetch tool uses for artifact URLs. This avoids driving the
interactive Claude TUI through tmux.

Auth is resolved from (in order):
  1. CLAUDE_CODE_OAUTH_TOKEN
  2. CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  3. Claude Code's macOS Keychain secure-storage item
  4. Claude Code's plaintext fallback .credentials.json

Secrets are never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_FETCH_BYTES = MAX_ARTIFACT_BYTES + 4096
DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
DEFAULT_ORIGIN = "https://claude.ai"
DEFAULT_API_ORIGIN = "https://api.anthropic.com"
OAUTH_BETA_HEADER = "oauth-2025-04-20"
MCP_SERVERS_BETA_HEADER = "mcp-servers-2025-12-04"
ANTHROPIC_VERSION = "2023-06-01"
MAX_MCP_SERVERS = 32
MAX_MCP_TOOLS_PER_SERVER = 128
DEFAULT_SCOPES = [
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
]
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)
CONTRACT_VERSION_RE = re.compile(r"^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$")
CAPABILITY_NAME_RE = re.compile(r"^[a-z][a-z0-9]{0,23}$")


class PublishError(RuntimeError):
    pass


class OrgVisibilityError(PublishError):
    pass


def eprint(*parts: object) -> None:
    print(*parts, file=sys.stderr)


def config_dir() -> Path:
    if "CLAUDE_SECURESTORAGE_CONFIG_DIR" in os.environ:
        value = os.environ.get("CLAUDE_SECURESTORAGE_CONFIG_DIR") or str(Path.home() / ".claude")
        return Path(value).expanduser()
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        return Path(os.environ["CLAUDE_CONFIG_DIR"]).expanduser()
    return Path.home() / ".claude"


def oauth_suffix() -> str:
    # Claude Code's production build returns "" unless a custom OAuth URL is configured.
    if os.environ.get("CLAUDE_CODE_CUSTOM_OAUTH_URL"):
        return "-custom-oauth"
    return ""


def keychain_account() -> str:
    user = os.environ.get("USER") or "claude-code-user"
    return user if re.match(r"^[a-zA-Z0-9._-]+$", user) else "claude-code-user"


def keychain_service() -> str:
    secure_dir_env_present = "CLAUDE_SECURESTORAGE_CONFIG_DIR" in os.environ
    secure_dir_value = os.environ.get("CLAUDE_SECURESTORAGE_CONFIG_DIR")
    include_hash = False
    if secure_dir_env_present:
        include_hash = bool(secure_dir_value)
    elif os.environ.get("CLAUDE_CONFIG_DIR"):
        include_hash = True

    suffix = ""
    if include_hash:
        digest = hashlib.sha256(str(config_dir()).encode()).hexdigest()[:8]
        suffix = f"-{digest}"
    return f"Claude Code{oauth_suffix()}-credentials{suffix}"


def read_fd_token() -> str | None:
    fd = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
    if not fd:
        return None
    try:
        num = int(fd)
    except ValueError:
        return None
    try:
        return Path(f"/dev/fd/{num}").read_text().strip() or None
    except OSError:
        return None


def read_keychain_credentials() -> tuple[dict[str, Any] | None, str | None]:
    if sys.platform != "darwin":
        return None, None
    service = keychain_service()
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-a", keychain_account(), "-w", "-s", service],
            stderr=subprocess.DEVNULL,
            timeout=5,
            text=True,
        ).strip()
    except Exception:
        return None, service
    try:
        return json.loads(raw), service
    except json.JSONDecodeError as exc:
        raise PublishError(f"Claude Code keychain item {service!r} is not valid JSON") from exc


def write_keychain_credentials(service: str, data: dict[str, Any]) -> None:
    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    command = f'add-generic-password -U -a "{keychain_account()}" -s "{service}" -X "{raw.encode("utf-8").hex()}"\n'
    proc = subprocess.run(
        ["security", "-i"],
        input=command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=5,
    )
    if proc.returncode != 0:
        raise PublishError("refreshed OAuth token but failed to write Claude Code keychain credentials")


def read_plaintext_credentials() -> dict[str, Any] | None:
    path = config_dir() / ".credentials.json"
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        raise PublishError(f"{path} is not valid JSON") from exc


def write_plaintext_credentials(data: dict[str, Any]) -> None:
    path = config_dir() / ".credentials.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    path.chmod(0o600)


def refresh_oauth_token(creds: dict[str, Any], storage: tuple[str, str | None] | None) -> dict[str, Any]:
    oauth = creds.get("claudeAiOauth") if isinstance(creds, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("refreshToken"):
        raise PublishError("stored Claude Code OAuth token is expired and has no refresh token; run `claude auth login`")

    scopes = oauth.get("scopes") if isinstance(oauth.get("scopes"), list) else DEFAULT_SCOPES
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": oauth["refreshToken"],
        "client_id": oauth.get("clientId") or os.environ.get("CLAUDE_CODE_OAUTH_CLIENT_ID") or DEFAULT_CLIENT_ID,
        "scope": " ".join(str(s) for s in scopes),
    }
    req = urllib.request.Request(
        os.environ.get("CLAUDE_CODE_TOKEN_URL", DEFAULT_TOKEN_URL),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": user_agent()},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:240]
        raise PublishError(f"OAuth refresh failed: HTTP {exc.code} {detail}") from exc
    except Exception as exc:
        raise PublishError(f"OAuth refresh failed: {exc}") from exc

    oauth.update(
        accessToken=body["access_token"],
        refreshToken=body.get("refresh_token") or oauth["refreshToken"],
        expiresAt=int(time.time() * 1000) + int(body.get("expires_in", 3600)) * 1000,
        scopes=str(body.get("scope", " ".join(scopes))).split(),
    )
    creds["claudeAiOauth"] = oauth

    if storage:
        kind, service = storage
        if kind == "keychain" and service:
            write_keychain_credentials(service, creds)
        elif kind == "plaintext":
            write_plaintext_credentials(creds)
    return oauth


def get_access_token() -> str:
    env_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if env_token:
        return env_token
    fd_token = read_fd_token()
    if fd_token:
        return fd_token

    creds, service = read_keychain_credentials()
    storage: tuple[str, str | None] | None = None
    if creds is not None:
        storage = ("keychain", service)
    else:
        creds = read_plaintext_credentials()
        if creds is not None:
            storage = ("plaintext", None)

    if not creds:
        raise PublishError("no Claude Code OAuth credentials found; run `claude auth login` or set CLAUDE_CODE_OAUTH_TOKEN")
    oauth = creds.get("claudeAiOauth")
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        raise PublishError("Claude Code credentials do not contain a claudeAiOauth accessToken; run `claude auth login`")

    expires_at = oauth.get("expiresAt")
    if isinstance(expires_at, (int, float)) and expires_at - int(time.time() * 1000) < 5 * 60 * 1000:
        oauth = refresh_oauth_token(creds, storage)
    return str(oauth["accessToken"])


def extract_title(text: str) -> str | None:
    match = re.search(r"<title[^>]*>([\s\S]*?)</title>", text, re.I)
    if not match:
        return None
    value = html.unescape(re.sub(r"\s+", " ", match.group(1))).strip()
    return value[:280] or None


def looks_like_full_html(text: str) -> bool:
    head = text[:4096].lower()
    return "<html" in head or "<!doctype" in head or "<head" in head or "<body" in head


def markdown_to_html(md: str, title: str) -> str:
    # Small dependency-free renderer for Artifact convenience. For rich documents,
    # convert markdown to HTML yourself before publishing.
    out: list[str] = []
    in_code = False
    code_lines: list[str] = []
    in_ul = False

    def close_ul() -> None:
        nonlocal in_ul
        if in_ul:
            out.append("</ul>")
            in_ul = False

    def close_code() -> None:
        nonlocal in_code, code_lines
        if in_code:
            out.append("<pre><code>" + html.escape("\n".join(code_lines)) + "</code></pre>")
            code_lines = []
            in_code = False

    for raw in md.splitlines():
        line = raw.rstrip("\n")
        if line.strip().startswith("```"):
            if in_code:
                close_code()
            else:
                close_ul()
                in_code = True
                code_lines = []
            continue
        if in_code:
            code_lines.append(line)
            continue
        if not line.strip():
            close_ul()
            continue
        h = re.match(r"^(#{1,6})\s+(.+)$", line)
        if h:
            close_ul()
            level = len(h.group(1))
            out.append(f"<h{level}>{html.escape(h.group(2).strip())}</h{level}>")
            continue
        li = re.match(r"^\s*[-*]\s+(.+)$", line)
        if li:
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{html.escape(li.group(1).strip())}</li>")
            continue
        close_ul()
        out.append(f"<p>{html.escape(line.strip())}</p>")
    close_code()
    close_ul()
    body = "\n".join(out)
    return f"""<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{html.escape(title)}</title><style>body{{font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:860px;margin:0 auto;padding:2rem;color:#141413;background:#faf9f5}}pre{{overflow:auto;background:#111;color:#fafafa;padding:1rem;border-radius:12px}}code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}</style></head><body>{body}</body></html>"""


def prepare_content(path: Path, title: str | None, body_only: bool) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    effective_title = title or extract_title(text) or path.stem.replace("-", " ").replace("_", " ").strip() or "Artifact"

    if body_only:
        text = f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(effective_title)}</title><style>:root{{color-scheme:light}}body{{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}}img{{max-width:100%}}</style></head><body>\n{text}\n</body></html>'
    elif path.suffix.lower() in {".md", ".markdown"} and not looks_like_full_html(text):
        text = markdown_to_html(text, effective_title)
    elif not looks_like_full_html(text):
        # Treat raw fragments as body content.
        text = f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(effective_title)}</title></head><body>\n{text}\n</body></html>'

    size = len(text.encode("utf-8"))
    if size > MAX_ARTIFACT_BYTES:
        raise PublishError(f"rendered artifact is {size / 1024 / 1024:.1f} MiB; max is 16 MiB")
    return text, effective_title


def parse_slug(value: str | None) -> str | None:
    if not value:
        return None
    match = UUID_RE.search(value)
    if not match:
        raise PublishError(f"could not parse artifact UUID from {value!r}")
    return match.group(0).lower()


def parse_artifact_ref(value: str, default_origin: str = DEFAULT_ORIGIN) -> dict[str, str]:
    slug = parse_slug(value)
    if not slug:
        raise PublishError(f"could not parse artifact UUID from {value!r}")

    env = "staging" if "staging" in default_origin else "prod"
    origin = default_origin.rstrip("/")
    try:
        parsed = urllib.parse.urlparse(value)
    except Exception:
        parsed = urllib.parse.urlparse("")
    host = (parsed.hostname or "").lower()
    if host:
        if host == "staging.claude.ai" or host.endswith(".staging.claude.ai"):
            env = "staging"
            origin = f"{parsed.scheme or 'https'}://staging.claude.ai"
        elif host == "claude.ai" or host.endswith(".claude.ai"):
            env = "prod"
            origin = f"{parsed.scheme or 'https'}://claude.ai"
    return {"slug": slug, "env": env, "origin": origin}


def user_agent() -> str:
    return "claude-cli/2.1.211 (external, pi-direct-artifact)"


def auth_headers(token: str, *, content_type: str | None = None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "anthropic-beta": OAUTH_BETA_HEADER,
        "X-Frame-CP": "go",
        "User-Agent": user_agent(),
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def get_json(
    url: str,
    token: str,
    *,
    label: str,
    timeout: int = 15,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    headers = auth_headers(token)
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            data = json.loads(raw) if raw else {}
            if resp.status < 200 or resp.status >= 300:
                raise PublishError(f"{label} failed: HTTP {resp.status} {raw[:240]}")
            return data
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise PublishError(f"{label} failed: HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise PublishError(f"{label} failed: {exc.reason}") from exc


def get_text(url: str, token: str, *, label: str, timeout: int = 15) -> str:
    req = urllib.request.Request(url, method="GET", headers=auth_headers(token))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            if resp.status < 200 or resp.status >= 300:
                raise PublishError(f"{label} failed: HTTP {resp.status} {raw[:240]}")
            if not raw.strip():
                raise PublishError(f"{label} returned an empty response")
            return raw
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise PublishError(f"{label} failed: HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise PublishError(f"{label} failed: {exc.reason}") from exc


def fetch_bytes(url: str, *, label: str, timeout: int = 30, max_bytes: int = MAX_FETCH_BYTES) -> tuple[bytes, int, str]:
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": user_agent()})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise PublishError(f"{label} exceeded {max_bytes / 1024 / 1024:.1f} MiB")
            if resp.status < 200 or resp.status >= 300:
                detail = data[:500].decode("utf-8", "replace")
                raise PublishError(f"{label} failed: HTTP {resp.status} {detail}")
            return data, resp.status, resp.headers.get("content-type", "")
    except urllib.error.HTTPError as exc:
        detail = exc.read(500).decode("utf-8", "replace")
        raise PublishError(f"{label} failed: HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise PublishError(f"{label} failed: {exc.reason}") from exc


def post_json(url: str, payload: dict[str, Any], token: str) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=auth_headers(token, content_type="application/json"),
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", "replace")
            data = json.loads(raw) if raw else {}
            if resp.status < 200 or resp.status >= 300:
                raise PublishError(f"deploy failed: HTTP {resp.status} {raw[:240]}")
            return data
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise PublishError(f"deploy failed: HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise PublishError(f"deploy failed: {exc.reason}") from exc


def fetch_contract(origin: str, token: str, requested: str = "latest") -> dict[str, Any]:
    if requested != "latest" and not CONTRACT_VERSION_RE.fullmatch(requested):
        raise PublishError(
            f"invalid artifact contract {requested!r}; use 'latest' or a version such as 0.1.12"
        )
    data = get_json(
        f"{origin}/api/frame/contract/{requested}",
        token,
        label="artifact capability contract",
    )
    version = data.get("version")
    capabilities = data.get("capabilities")
    if not isinstance(version, str) or not CONTRACT_VERSION_RE.fullmatch(version):
        raise PublishError("artifact capability contract response did not include a valid version")
    if not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities):
        raise PublishError("artifact capability contract response did not include a valid capability list")
    return {"version": version, "capabilities": capabilities}


def fetch_capability_defs(origin: str, token: str, contract: str, capability: str) -> tuple[dict[str, Any], str]:
    if not CAPABILITY_NAME_RE.fullmatch(capability):
        raise PublishError(f"invalid artifact capability name {capability!r}")
    metadata = fetch_contract(origin, token, contract)
    if capability not in metadata["capabilities"]:
        raise PublishError(
            f"artifact contract {metadata['version']} does not advertise capability {capability!r}"
        )
    defs = get_text(
        f"{origin}/api/frame/contract/{metadata['version']}/{capability}.d.ts",
        token,
        label=f"artifact {capability} capability definitions",
    )
    return metadata, defs


def build_mcp_capabilities(specs: list[list[str]]) -> dict[str, Any]:
    servers: dict[str, list[str]] = {}
    for server_raw, tool_raw in specs:
        server = server_raw.strip()
        tool = tool_raw.strip()
        if not server or not tool:
            raise PublishError("--mcp SERVER TOOL requires non-empty connector and tool names")
        tools = servers.setdefault(server, [])
        if tool not in tools:
            tools.append(tool)

    if len(servers) > MAX_MCP_SERVERS:
        raise PublishError(f"MCP manifest has {len(servers)} connectors; max is {MAX_MCP_SERVERS}")
    for server, tools in servers.items():
        if len(tools) > MAX_MCP_TOOLS_PER_SERVER:
            raise PublishError(
                f"MCP connector {server!r} declares {len(tools)} tools; max is {MAX_MCP_TOOLS_PER_SERVER}"
            )

    return {
        "mcp": {
            "servers": [
                {"server": server, "tools": tools}
                for server, tools in servers.items()
            ]
        }
    }


def runtime_fields(args: argparse.Namespace, token: str, origin: str) -> dict[str, Any]:
    if args.clear_capabilities and args.mcp:
        raise PublishError("pass either --clear-capabilities or one or more --mcp declarations, not both")

    declares_capabilities = bool(args.mcp) or args.clear_capabilities
    if not declares_capabilities and not args.contract:
        return {}

    contract = fetch_contract(origin, token, args.contract or "latest")
    fields: dict[str, Any] = {"contract": contract["version"]}
    if args.clear_capabilities:
        fields["capabilities"] = {}
    elif args.mcp:
        if "mcp" not in contract["capabilities"]:
            raise PublishError(
                f"artifact contract {contract['version']} does not advertise the MCP capability"
            )
        fields["capabilities"] = build_mcp_capabilities(args.mcp)
    return fields


def list_connectors(args: argparse.Namespace) -> dict[str, Any]:
    token = get_access_token()
    data = get_json(
        f"{args.api_origin.rstrip('/')}/v1/mcp_servers?limit=1000",
        token,
        label="Claude connector roster",
        extra_headers={
            "anthropic-beta": MCP_SERVERS_BETA_HEADER,
            "anthropic-version": ANTHROPIC_VERSION,
        },
    )
    rows = data.get("data")
    if not isinstance(rows, list):
        raise PublishError("Claude connector roster response did not include a data array")

    connectors: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        tools = row.get("tools")
        tool_names = [
            tool.get("name")
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)
        ] if isinstance(tools, list) else []
        connectors.append(
            {
                "id": row.get("id"),
                "displayName": row.get("display_name"),
                "url": row.get("url"),
                "stateless": row.get("stateless"),
                "tools": tool_names,
            }
        )
    return {"count": len(connectors), "connectors": connectors}


def set_org_visibility(origin: str, slug: str, token: str) -> dict[str, str]:
    try:
        boot = get_json(f"{origin}/api/frame/{slug}", token, label="artifact permission read")
    except PublishError as exc:
        raise OrgVisibilityError(
            f"org visibility not set: {exc}; use the Share UI fallback"
        ) from exc

    perm = boot.get("perm") if isinstance(boot.get("perm"), dict) else {}
    if perm.get("role") != "owner":
        raise OrgVisibilityError("org visibility not set: current account is not the artifact owner")
    version = perm.get("version")
    if not isinstance(version, str) or not version:
        raise OrgVisibilityError("org visibility not set: artifact permission version missing")

    headers = auth_headers(token, content_type="application/json")
    headers["If-Match"] = version
    req = urllib.request.Request(
        f"{origin}/api/frame/perm/{slug}",
        data=json.dumps({"read": {"mode": "org", "users": []}}).encode("utf-8"),
        method="PATCH",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
            if resp.status < 200 or resp.status >= 300:
                raise OrgVisibilityError(f"org visibility not set: HTTP {resp.status} {raw[:240]}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:240]
        fallback = "; use the artifact Share UI fallback" if exc.code in {401, 403, 404, 412} else ""
        raise OrgVisibilityError(
            f"org visibility not set: HTTP {exc.code} {detail}{fallback}"
        ) from exc
    except urllib.error.URLError as exc:
        raise OrgVisibilityError(f"org visibility not set: {exc.reason}") from exc

    try:
        confirm = get_json(f"{origin}/api/frame/{slug}", token, label="artifact permission confirm")
    except PublishError as exc:
        raise OrgVisibilityError(f"org visibility may be unset: {exc}; verify in the Share UI") from exc
    confirm_perm = confirm.get("perm") if isinstance(confirm.get("perm"), dict) else {}
    if confirm_perm.get("mode") != "org":
        raise OrgVisibilityError("org visibility not confirmed: permission mode was not org")
    result = {"visibility": "org"}
    confirm_version = confirm_perm.get("version")
    if isinstance(confirm_version, str) and confirm_version:
        result["visibilityPermVersion"] = confirm_version
    return result


def publish(args: argparse.Namespace) -> dict[str, Any]:
    if not args.file:
        raise PublishError("missing file to publish")
    path = Path(args.file).expanduser().resolve()
    if not path.exists() or not path.is_file():
        raise PublishError(f"file not found: {path}")
    content, title = prepare_content(path, args.title, args.body_only)
    token = get_access_token()
    slug = parse_slug(args.url or args.slug)
    origin = args.origin.rstrip("/")
    payload: dict[str, Any] = {
        "title": title,
        "favicon": args.favicon,
        "content": content,
    }
    if slug:
        payload["slug"] = slug
    if args.label:
        payload["label"] = args.label
    if args.base_version:
        payload["baseVersion"] = args.base_version
    payload.update(runtime_fields(args, token, origin))

    data = post_json(f"{origin}/api/frame/deploy/direct", payload, token)
    if not data.get("slug") or not data.get("version"):
        raise PublishError(f"deploy returned incomplete response: {json.dumps(data)[:240]}")
    data["url"] = f"{origin}/code/artifact/{data['slug']}"
    if args.share_org:
        try:
            data.update(set_org_visibility(origin, str(data["slug"]), token))
        except OrgVisibilityError as exc:
            data["visibility"] = "not-set"
            data["visibilityError"] = str(exc)
            eprint(f"warning: {exc}")
    return data


def fetch_artifact(args: argparse.Namespace) -> dict[str, Any]:
    ref = parse_artifact_ref(args.fetch, args.origin)
    token = get_access_token()
    boot = get_json(f"{ref['origin']}/api/frame/{ref['slug']}", token, label="artifact boot")
    version = boot.get("ver")
    asset_token = boot.get("assetToken")
    if not version or not asset_token:
        raise PublishError("artifact boot response did not include ver and assetToken")

    asset_host = f"{ref['slug']}.frame.{'staging.' if ref['env'] == 'staging' else ''}claudeusercontent.com"
    asset_url = f"https://{asset_host}/_f/{version}/?__frame_t={urllib.parse.quote(str(asset_token), safe='')}"
    raw, status, content_type = fetch_bytes(asset_url, label="artifact content")
    html_text = raw.decode("utf-8", "replace").replace(f'<base href="/_f/{version}/">', "")
    perm = boot.get("perm") if isinstance(boot.get("perm"), dict) else {}
    role = "owner" if perm.get("role") == "owner" else "reader"

    return {
        "html": html_text,
        "slug": ref["slug"],
        "url": f"{ref['origin']}/code/artifact/{ref['slug']}",
        "version": version,
        "title": boot.get("title") or "",
        "role": role,
        "shared": boot.get("shared"),
        "bytes": len(raw),
        "status": status,
        "contentType": content_type,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish or fetch Claude Code Artifacts without tmux/TUI.")
    parser.add_argument("file", nargs="?", help="HTML or Markdown file to publish. Inline external/relative assets first.")
    parser.add_argument("--fetch", metavar="URL", help="Fetch an existing artifact's current HTML instead of publishing.")
    parser.add_argument(
        "--list-connectors",
        action="store_true",
        help="List claude.ai connectors configured for this account, without launching Claude Code.",
    )
    parser.add_argument(
        "--show-contract",
        action="store_true",
        help="Show the current artifact runtime contract and supported capability names.",
    )
    parser.add_argument(
        "--show-capability",
        metavar="NAME",
        help="Print the current TypeScript definitions for an artifact capability such as mcp.",
    )
    parser.add_argument("--output", "-o", help="Output path for --fetch. If omitted, raw HTML is written to stdout.")
    parser.add_argument("--title", help="Artifact title. Defaults to <title> or file basename.")
    parser.add_argument("--favicon", default="📄", help="One or two emoji for the artifact favicon/tab icon.")
    parser.add_argument("--url", help="Existing Claude artifact URL to update.")
    parser.add_argument("--slug", help="Existing artifact UUID to update.")
    parser.add_argument("--label", help="Short version label shown in the version picker.")
    parser.add_argument("--base-version", help="Optional optimistic-concurrency base version, usually from --fetch metadata.")
    parser.add_argument("--origin", default=DEFAULT_ORIGIN, help="Claude origin, default https://claude.ai")
    parser.add_argument("--api-origin", default=DEFAULT_API_ORIGIN, help="Claude API origin used by --list-connectors.")
    parser.add_argument(
        "--mcp",
        action="append",
        nargs=2,
        metavar=("SERVER", "TOOL"),
        default=[],
        help="Declare one callable claude.ai connector tool; repeat for more tools/connectors.",
    )
    parser.add_argument(
        "--contract",
        help="Artifact runtime contract version, or 'latest'. With --mcp, defaults to the current contract.",
    )
    parser.add_argument(
        "--clear-capabilities",
        action="store_true",
        help="Clear the artifact's stored runtime capability declaration on this publish.",
    )
    parser.add_argument("--body-only", action="store_true", help="Wrap file contents in Claude Code's minimal HTML skeleton before publishing.")
    parser.add_argument(
        "--share-org",
        action="store_true",
        help="After publishing/updating, allow everyone in the Claude organization to view the artifact.",
    )
    args = parser.parse_args()

    try:
        if args.show_contract or args.show_capability:
            if args.file or args.fetch or args.list_connectors:
                raise PublishError("contract inspection cannot be combined with publishing, --fetch, or --list-connectors")
            if args.mcp or args.clear_capabilities:
                raise PublishError("contract inspection cannot be combined with artifact capability declarations")
            token = get_access_token()
            requested_contract = args.contract or "latest"
            if args.show_capability:
                metadata, defs = fetch_capability_defs(
                    args.origin.rstrip("/"), token, requested_contract, args.show_capability
                )
                if args.output:
                    out = Path(args.output).expanduser().resolve()
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_text(defs, encoding="utf-8")
                    print(json.dumps({**metadata, "capability": args.show_capability, "path": str(out)}, indent=2))
                else:
                    eprint(json.dumps({**metadata, "capability": args.show_capability}, indent=2))
                    sys.stdout.write(defs)
            else:
                print(json.dumps(fetch_contract(args.origin.rstrip("/"), token, requested_contract), indent=2))
        elif args.list_connectors:
            if args.file or args.fetch:
                raise PublishError("--list-connectors cannot be combined with publishing or --fetch")
            if args.mcp or args.contract or args.clear_capabilities:
                raise PublishError("--list-connectors cannot be combined with artifact runtime options")
            print(json.dumps(list_connectors(args), indent=2))
        elif args.fetch:
            if args.file:
                raise PublishError("pass either --fetch URL or a file to publish, not both")
            if args.mcp or args.contract or args.clear_capabilities:
                raise PublishError("artifact runtime options apply only when publishing, not with --fetch")
            result = fetch_artifact(args)
            meta = {
                k: result.get(k)
                for k in (
                    "slug",
                    "version",
                    "title",
                    "role",
                    "shared",
                    "bytes",
                    "contentType",
                    "url",
                )
                if k in result
            }
            if args.output:
                out = Path(args.output).expanduser().resolve()
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(result["html"], encoding="utf-8")
                meta["path"] = str(out)
                print(json.dumps(meta, indent=2))
            else:
                eprint(json.dumps(meta, indent=2))
                sys.stdout.write(result["html"])
        else:
            result = publish(args)
            print(result["url"])
            print(json.dumps({
                k: result.get(k)
                for k in (
                    "slug",
                    "version",
                    "read",
                    "shared",
                    "visibility",
                    "visibilityPermVersion",
                    "visibilityError",
                    "contract",
                    "capabilities",
                    "url",
                )
                if k in result
            }, indent=2))
    except PublishError as exc:
        eprint(f"error: {exc}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
