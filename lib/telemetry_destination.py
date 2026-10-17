"""Resolve personal telemetry settings once; upload documents through GitHub or HTTP."""
from __future__ import annotations

import base64
from collections.abc import Callable
import hashlib
import json
import os
from pathlib import Path
import random
import re
import subprocess
import time
from typing import Literal, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

# agent-default (not a user rule): 2026-10-16
HTTP_TIMEOUT_SECONDS = 30
UPLOAD_ATTEMPTS = 5
IDENTITY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
Render = Callable[[Optional[str]], Optional[str]]


def read(path: Path):
    return json.loads(path.read_text()) if path.is_file() else {}


def gh(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True)


class Destination:
    def __init__(self, target: str, identity: str, field: Literal["githubLogin", "sender"]):
        self.target, self.identity, self.field = target, identity, field
        self.key = hashlib.sha256(json.dumps([target, identity]).encode()).hexdigest()


class GitHub(Destination):
    def upload(self, path: str, render: Render) -> int:
        endpoint = f"repos/{self.target}/contents/{path}"
        for attempt in range(1, UPLOAD_ATTEMPTS + 1):
            current = gh("api", endpoint)
            request = {"message": f"Update {path}"}
            existing_text = None
            if current.returncode == 0:
                existing = json.loads(current.stdout)
                request["sha"] = existing["sha"]
                if existing.get("content"):
                    existing_text = base64.b64decode(existing["content"]).decode()
                else:
                    # GitHub omits content above 1 MB.
                    current = gh("api", endpoint, "-H", "Accept: application/vnd.github.raw+json")
                    if current.returncode:
                        print(f"Not sent: could not read the existing {path} ({current.stderr.strip()}).")
                        return 1
                    existing_text = current.stdout
            body = render(existing_text)
            if body is None:
                print(f"{self.target}/{path} is already up to date.")
                return 0
            request["content"] = base64.b64encode(body.encode()).decode()
            put = gh("api", "-X", "PUT", endpoint, "--input", "-", stdin=json.dumps(request))
            if put.returncode == 0:
                print(f"Sent to {self.target}/{path}.")
                return 0
            print(f"Upload attempt {attempt} failed: {put.stderr.strip()}")
            if attempt < UPLOAD_ATTEMPTS:
                time.sleep(random.uniform(2, 10) * attempt)
        return 1


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Http(Destination):
    def __init__(self, url: str, identity: str, token: str | None):
        super().__init__(url.rstrip("/"), identity, "sender")
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def upload(self, path: str, render: Render) -> int:
        url = self.target + "/" + "/".join(quote(part, safe="") for part in path.split("/"))
        opener = build_opener(NoRedirect())
        for _ in range(UPLOAD_ATTEMPTS):
            try:
                try:
                    with opener.open(Request(url, headers=self.headers), timeout=HTTP_TIMEOUT_SECONDS) as response:
                        existing, etag = response.read().decode(), response.headers.get("ETag")
                except HTTPError as error:
                    error.close()
                    if error.code != 404:
                        raise
                    existing, etag = None, None
                body = render(existing)
                if body is None:
                    print(f"Telemetry {path} is already up to date.")
                    return 0
                headers = {**self.headers, "Content-Type": "application/json" if path.endswith(".json") else "text/markdown; charset=utf-8"}
                if etag:
                    headers["If-Match"] = etag
                elif existing is None:
                    headers["If-None-Match"] = "*"
                with opener.open(Request(url, data=body.encode(), headers=headers, method="PUT"), timeout=HTTP_TIMEOUT_SECONDS):
                    pass
                print(f"Sent telemetry {path} to the configured HTTP destination.")
                return 0
            except HTTPError as error:
                error.close()
                if error.code in (409, 412):
                    continue
                print(f"Not sent: HTTP telemetry returned {error.code}.")
                return 1
            except (URLError, OSError, ValueError):
                # Receiver errors must not expose credentials or response bodies.
                print("Not sent: HTTP telemetry request or response failed.")
                return 1
        print("Not sent: HTTP telemetry writes kept conflicting; retry later.")
        return 1


def destination(root: Path, agent: Path) -> GitHub | Http | None:
    settings = read(agent / "settings.json")
    if settings.get("vibesTelemetry") is False:
        return None
    config = settings["telemetryDestination"] if "telemetryDestination" in settings else read(root / "settings.template.json").get("telemetryDestination")
    if config is None:
        return None
    if not isinstance(config, dict):
        raise ValueError("telemetryDestination must be null or an object")
    kind, identity = config.get("type"), config.get("identity")
    allowed = {"type", "repository", "identity"} if kind == "github" else {"type", "url", "identity", "tokenEnv"}
    if kind not in ("github", "http") or set(config) - allowed:
        raise ValueError("telemetryDestination: expected type github or http and its documented fields")
    if "identity" in config and (not isinstance(identity, str) or not IDENTITY.fullmatch(identity)):
        raise ValueError("telemetryDestination.identity must contain letters, numbers, underscores or hyphens")
    if kind == "github":
        repo = config.get("repository")
        if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            raise ValueError("telemetryDestination.repository must be owner/repository")
        field: Literal["githubLogin", "sender"] = "sender" if identity else "githubLogin"
        if identity is None:
            login = gh("api", "user", "--jq", ".login")
            if login.returncode:
                error = login.stderr.strip()
                reason = ("GitHub CLI authentication required; run `gh auth login`" if login.returncode == 4 else
                          "GitHub authentication failed; check `gh auth status`" if "HTTP 401" in error else
                          "could not query GitHub for the current user")
                raise ValueError(f"{reason} ({error})")
            identity = login.stdout.strip()
            if not IDENTITY.fullmatch(identity):
                raise ValueError("GitHub returned an invalid login")
        return GitHub(repo, identity, field)
    url, token_env = config.get("url"), config.get("tokenEnv")
    if not isinstance(url, str):
        raise ValueError("telemetryDestination.url must be an HTTP(S) base URL")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("telemetryDestination.url must be an HTTP(S) base URL without credentials, query or fragment")
    if identity is None:
        raise ValueError("HTTP telemetry requires telemetryDestination.identity (no GitHub login is used)")
    token = None
    if "tokenEnv" in config:
        if not isinstance(token_env, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token_env):
            raise ValueError("telemetryDestination.tokenEnv must name an environment variable")
        token = os.environ.get(token_env)
        if not token:
            raise ValueError("the telemetry token environment variable is unset")
    return Http(url, identity, token)
