#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography>=49.0.0"]
# ///
"""Extract cookies from Chrome on macOS by decrypting the cookie SQLite DB.

Uses the Chrome Safe Storage key from macOS Keychain to decrypt AES-128-CBC
encrypted cookies (v10 format, Chrome 80+).

Requirements: uv (cryptography is provisioned from the inline script metadata)

Usage:
    # Extract all cookies for a domain
    ./extract.py --domain app.example.com

    # Extract specific cookie names
    ./extract.py --domain app.example.com --names session_id csrf_token

    # Output as JSON (default)
    ./extract.py --domain github.com --json

    # Output as env vars (KEY=VALUE)
    ./extract.py --domain github.com --env

    # Output as curl cookie header
    ./extract.py --domain github.com --curl

    # Specify Chrome profile (default: auto-detect)
    ./extract.py --domain app.example.com --profile "Profile 1"

    # Include subdomains (e.g., .example.com matches app.example.com)
    ./extract.py --domain example.com --include-subdomains
"""
import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path


DOMAIN_PATTERN = re.compile(r"^[a-z0-9.-]+$")


def cookie_domain_filter(domain, include_subdomains=False):
    """Return an exact SQL host filter and parameters for a cookie domain."""
    normalized = domain.strip().lower().lstrip(".").rstrip(".")
    if not normalized or not DOMAIN_PATTERN.fullmatch(normalized) or ".." in normalized:
        raise ValueError(f"Invalid cookie domain: {domain!r}")

    if include_subdomains:
        return (
            "(host_key = ? OR host_key = ? OR host_key LIKE ?)",
            [normalized, f".{normalized}", f"%.{normalized}"],
        )
    return "(host_key = ? OR host_key = ?)", [normalized, f".{normalized}"]


def get_chrome_key():
    """Get Chrome's cookie encryption key from macOS Keychain."""
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "Chrome Safe Storage", "-w"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError("Could not read Chrome Safe Storage from Keychain. Is Chrome installed?")
    password = result.stdout.strip()
    return hashlib.pbkdf2_hmac('sha1', password.encode(), b'saltysalt', 1003, dklen=16)


def find_chrome_profile(domain, profile_hint=None, include_subdomains=False):
    """Find the Chrome profile that has cookies for the exact domain scope."""
    chrome_dir = Path.home() / "Library/Application Support/Google/Chrome"

    if profile_hint:
        candidate = chrome_dir / profile_hint / "Cookies"
        if candidate.exists():
            return candidate
        raise FileNotFoundError(f"Chrome profile '{profile_hint}' not found or has no Cookies DB")

    where, params = cookie_domain_filter(domain, include_subdomains)

    # Auto-detect: check all profiles for cookies matching the domain scope
    profiles = ["Default"] + [f"Profile {i}" for i in range(1, 10)]
    for profile in profiles:
        candidate = chrome_dir / profile / "Cookies"
        if not candidate.exists():
            continue
        try:
            conn = sqlite3.connect(f"file:{candidate}?mode=ro", uri=True)
            count = conn.execute(
                f"SELECT COUNT(*) FROM cookies WHERE {where}", params
            ).fetchone()[0]
            conn.close()
            if count > 0:
                return candidate
        except sqlite3.OperationalError:
            continue  # DB locked by Chrome — skip

    raise FileNotFoundError(f"No Chrome profile found with cookies for {domain}")


def decrypt_cookie(enc_value, key):
    """Decrypt a Chrome v10 encrypted cookie value."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    if enc_value[:3] != b'v10':
        raise ValueError(f"Unknown encryption format: {enc_value[:3]}")

    payload = enc_value[3:]
    iv = b' ' * 16
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    dec = cipher.decryptor()
    pt = dec.update(payload) + dec.finalize()

    # Remove PKCS7 padding
    pad_len = pt[-1]
    if pad_len <= 16:
        pt = pt[:-pad_len]

    raw = pt.decode('latin-1')

    # CBC first-block decrypts to garbage when using Chrome's static IV.
    # Find the actual value by looking for common patterns.

    # JWT tokens start with 'eyJ'
    if 'eyJ' in raw:
        return raw[raw.index('eyJ'):]

    # For non-JWT values, skip the 32-byte garbage prefix
    clean = pt[32:].decode('latin-1').rstrip('\x00')
    if clean:
        return clean

    # Fallback: skip 16 bytes
    clean = pt[16:].decode('latin-1').rstrip('\x00')
    return clean


def extract_cookies(domain, names=None, profile=None, include_subdomains=False):
    """Extract and decrypt cookies for a domain from Chrome.

    Args:
        domain: Domain to match (e.g., 'app.example.com')
        names: Optional list of cookie names to filter by
        profile: Optional Chrome profile name (e.g., 'Profile 1')
        include_subdomains: If True, match .domain as well

    Returns:
        dict of {cookie_name: decrypted_value}
    """
    where, params = cookie_domain_filter(domain, include_subdomains)
    key = get_chrome_key()
    cookie_db = find_chrome_profile(domain, profile, include_subdomains)

    conn = sqlite3.connect(f"file:{cookie_db}?mode=ro", uri=True)

    if names:
        placeholders = ",".join("?" * len(names))
        where += f" AND name IN ({placeholders})"
        params.extend(names)

    results = {}
    errors = []
    for host, name, enc_value in conn.execute(
        f"SELECT host_key, name, encrypted_value FROM cookies WHERE {where}",
        params
    ):
        try:
            if len(enc_value) == 0:
                continue
            value = decrypt_cookie(enc_value, key)
            results[name] = value
        except Exception as e:
            errors.append(f"{name}: {e}")

    conn.close()

    if errors:
        print(f"⚠️  Failed to decrypt: {'; '.join(errors)}", file=sys.stderr)

    return results


def main():
    parser = argparse.ArgumentParser(description="Extract cookies from Chrome on macOS")
    parser.add_argument("--domain", required=True, help="Domain to extract cookies for")
    parser.add_argument("--names", nargs="+", help="Specific cookie names to extract")
    parser.add_argument("--profile", help="Chrome profile name (default: auto-detect)")
    parser.add_argument("--include-subdomains", action="store_true", help="Match subdomains too")

    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true", default=True, help="Output as JSON (default)")
    output.add_argument("--env", action="store_true", help="Output as KEY=VALUE")
    output.add_argument("--curl", action="store_true", help="Output as curl cookie header")
    output.add_argument("--value", action="store_true", help="Output raw value (single cookie only)")

    args = parser.parse_args()

    try:
        cookies = extract_cookies(
            domain=args.domain,
            names=args.names,
            profile=args.profile,
            include_subdomains=args.include_subdomains
        )
    except (RuntimeError, FileNotFoundError, ValueError) as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)

    if not cookies:
        print(f"❌ No cookies found for {args.domain}", file=sys.stderr)
        sys.exit(1)

    if args.value:
        if len(cookies) != 1:
            print(f"❌ --value requires exactly 1 cookie, got {len(cookies)}: {list(cookies.keys())}", file=sys.stderr)
            sys.exit(1)
        print(list(cookies.values())[0])
    elif args.env:
        for name, value in cookies.items():
            safe_name = name.upper().replace("-", "_").replace(".", "_")
            print(f"{safe_name}={value}")
    elif args.curl:
        cookie_str = "; ".join(f"{name}={value}" for name, value in cookies.items())
        print(cookie_str)
    else:
        print(json.dumps(cookies, indent=2))


if __name__ == "__main__":
    main()
