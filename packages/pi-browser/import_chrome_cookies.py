#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "cryptography>=42.0.0",
# ]
# ///
"""Import cookies from a local macOS Chrome profile into Playwright storage state."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from typing import Any, Sequence

from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

CHROME_USER_DATA = Path.home() / "Library/Application Support/Google/Chrome"
KEYCHAIN_SERVICE = "Chrome Safe Storage"
V10_PREFIX = b"v10"
V10_IV = b" " * 16
CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600
SAME_SITE = {-1: "Lax", 0: "None", 1: "Lax", 2: "Strict"}


class SafeImportError(Exception):
    """An error message that is safe to include in command JSON output."""


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise SafeImportError(f"invalid_arguments: {message}")


def validate_profile(profile: str, user_data_dir: Path = CHROME_USER_DATA) -> Path:
    """Return a profile directory, rejecting paths and symlink traversal."""
    if (
        not profile
        or profile in {".", ".."}
        or Path(profile).name != profile
        or "/" in profile
        or "\\" in profile
        or "\x00" in profile
    ):
        raise SafeImportError("invalid_profile_name")

    root = user_data_dir.expanduser().resolve(strict=False)
    candidate = (root / profile).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise SafeImportError("invalid_profile_name") from exc
    if not candidate.is_dir():
        raise SafeImportError("profile_not_found")
    return candidate


def find_cookie_db(profile_dir: Path) -> Path:
    for relative in (Path("Network/Cookies"), Path("Cookies")):
        candidate = profile_dir / relative
        if candidate.is_file():
            return candidate
    raise SafeImportError("cookie_database_not_found")


def get_safe_storage_password() -> bytes:
    """Read Chrome Safe Storage from Keychain without requesting a login password."""
    if sys.platform != "darwin":
        raise SafeImportError("macos_only")
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-w", "-s", KEYCHAIN_SERVICE],
            check=True,
            capture_output=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise SafeImportError("chrome_safe_storage_unavailable") from exc
    password = result.stdout.rstrip(b"\r\n")
    if not password:
        raise SafeImportError("chrome_safe_storage_unavailable")
    return password


def derive_v10_key(password: bytes) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA1(),
        length=16,
        salt=b"saltysalt",
        iterations=1003,
    ).derive(password)


def decrypt_v10(encrypted_value: bytes, key: bytes, host_key: str, meta_version: int) -> str:
    if not encrypted_value.startswith(V10_PREFIX):
        raise SafeImportError("unsupported_encryption")
    ciphertext = encrypted_value[len(V10_PREFIX) :]
    if not ciphertext or len(ciphertext) % 16:
        raise SafeImportError("invalid_ciphertext")

    decryptor = Cipher(algorithms.AES(key), modes.CBC(V10_IV)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    try:
        plaintext = unpadder.update(padded) + unpadder.finalize()
    except ValueError as exc:
        raise SafeImportError("decryption_failed") from exc

    if meta_version >= 24:
        expected = hashlib.sha256(host_key.encode("utf-8")).digest()
        digest, plaintext = plaintext[:32], plaintext[32:]
        if len(digest) != 32 or not hmac.compare_digest(digest, expected):
            raise SafeImportError("host_digest_mismatch")
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SafeImportError("cookie_value_not_utf8") from exc


def normalize_domain_filter(domain: str) -> str:
    normalized = domain.strip().lower().lstrip(".").rstrip(".")
    if not normalized or "/" in normalized or "\\" in normalized or "\x00" in normalized:
        raise SafeImportError("invalid_domain_filter")
    return normalized


def domain_matches(host_key: str, filters: set[str]) -> bool:
    if not filters:
        return True
    host = host_key.lower().lstrip(".").rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in filters)


def chrome_expires_to_unix(expires_utc: int) -> float | int:
    if expires_utc == 0:
        return -1
    return expires_utc / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS


def read_cookie_rows(db_path: Path) -> tuple[int, list[sqlite3.Row]]:
    # mode=ro reads Chrome's WAL without taking a write lock, so Chrome may remain open.
    connection = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only = ON")
        meta_row = connection.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()
        if meta_row is None:
            raise SafeImportError("cookie_database_version_missing")
        try:
            meta_version = int(meta_row[0])
        except (TypeError, ValueError) as exc:
            raise SafeImportError("cookie_database_version_invalid") from exc
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(cookies)")}
        partition_column = (
            "top_frame_site_key" if "top_frame_site_key" in columns else "'' AS top_frame_site_key"
        )
        rows = connection.execute(
            f"""
            SELECT host_key, name, value, encrypted_value, path, expires_utc,
                   is_httponly, is_secure, samesite, {partition_column}
            FROM cookies
            """
        ).fetchall()
        return meta_version, rows
    except sqlite3.Error as exc:
        raise SafeImportError("cookie_database_read_failed") from exc
    finally:
        connection.close()


def atomic_write_json(output: Path, state: dict[str, Any]) -> None:
    output = output.expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as temporary:
            json.dump(state, temporary, ensure_ascii=False, separators=(",", ":"))
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, output)
        os.chmod(output, 0o600)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def import_cookies(
    profile: str,
    output: Path,
    domains: Sequence[str] = (),
    *,
    user_data_dir: Path = CHROME_USER_DATA,
) -> dict[str, Any]:
    profile_dir = validate_profile(profile, user_data_dir)
    db_path = find_cookie_db(profile_dir)
    filters = {normalize_domain_filter(domain) for domain in domains}
    meta_version, rows = read_cookie_rows(db_path)
    key = derive_v10_key(get_safe_storage_password())

    cookies: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    matched = 0
    for row in rows:
        host_key = str(row["host_key"])
        if not domain_matches(host_key, filters):
            continue
        matched += 1
        try:
            if row["encrypted_value"]:
                value = decrypt_v10(bytes(row["encrypted_value"]), key, host_key, meta_version)
            else:
                value = str(row["value"])
            same_site = SAME_SITE.get(int(row["samesite"]))
            if same_site is None:
                raise SafeImportError("unsupported_same_site")
            cookie = {
                "name": str(row["name"]),
                "value": value,
                "domain": host_key,
                "path": str(row["path"]),
                "expires": chrome_expires_to_unix(int(row["expires_utc"])),
                "httpOnly": bool(row["is_httponly"]),
                "secure": bool(row["is_secure"]),
                "sameSite": same_site,
            }
            partition_key = str(row["top_frame_site_key"] or "")
            if partition_key:
                cookie["partitionKey"] = partition_key
            cookies.append(cookie)
        except (SafeImportError, TypeError, ValueError):
            errors.append({"domain": host_key, "error": "cookie_import_failed"})

    atomic_write_json(output, {"cookies": cookies, "origins": []})
    imported_domains = sorted({cookie["domain"] for cookie in cookies})
    return {
        "counts": {
            "read": len(rows),
            "matched": matched,
            "imported": len(cookies),
            "skipped": matched - len(cookies),
        },
        "domains": imported_domains,
        "errors": errors,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="Default", help="Chrome profile directory name")
    parser.add_argument("--output", type=Path, default=Path("storage-state.json"))
    parser.add_argument("--domain", action="append", default=[], help="Domain suffix to include; repeatable")
    return parser


def error_summary(error: str) -> dict[str, Any]:
    return {
        "counts": {"read": 0, "matched": 0, "imported": 0, "skipped": 0},
        "domains": [],
        "errors": [{"error": error}],
    }


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        summary = import_cookies(args.profile, args.output, args.domain)
    except SafeImportError as exc:
        print(json.dumps(error_summary(str(exc)), separators=(",", ":")))
        return 1
    except Exception:
        # Do not expose paths, database contents, subprocess output, or other secrets.
        print(json.dumps(error_summary("unexpected_import_failure"), separators=(",", ":")))
        return 1
    print(json.dumps(summary, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
