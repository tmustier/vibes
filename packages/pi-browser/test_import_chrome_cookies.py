#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "cryptography>=42.0.0",
# ]
# ///

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest import mock

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MODULE_PATH = Path(__file__).with_name("import_chrome_cookies.py")
SPEC = importlib.util.spec_from_file_location("import_chrome_cookies", MODULE_PATH)
assert SPEC and SPEC.loader
importer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(importer)

PASSWORD = b"test-safe-storage"


def encrypt_v10(value: str, host_key: str, key: bytes) -> bytes:
    plaintext = hashlib.sha256(host_key.encode()).digest() + value.encode()
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(importer.V10_IV)).encryptor()
    return b"v10" + encryptor.update(padded) + encryptor.finalize()


def create_cookie_db(path: Path) -> None:
    path.parent.mkdir(parents=True)
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
        INSERT INTO meta VALUES ('version', '24');
        CREATE TABLE cookies (
            host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
            expires_utc INTEGER, is_httponly INTEGER, is_secure INTEGER, samesite INTEGER
        );
        """
    )
    key = importer.derive_v10_key(PASSWORD)
    connection.executemany(
        "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                ".example.com",
                "session",
                "",
                encrypt_v10("super-secret", ".example.com", key),
                "/account",
                13_344_473_600_000_000,
                1,
                1,
                2,
            ),
            ("sub.example.com", "plain", "plain-secret", b"", "/", 0, 0, 0, 1),
            ("other.test", "other", "other-secret", b"", "/", 0, 0, 1, 0),
            (
                "broken.example.com",
                "broken",
                "",
                encrypt_v10("wrong-host-secret", "different.example.com", key),
                "/",
                0,
                0,
                1,
                -1,
            ),
        ],
    )
    connection.commit()
    connection.close()


class ChromeCookieImporterTests(unittest.TestCase):
    def test_imports_filtered_cookies_and_writes_private_storage_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Chrome"
            db_path = root / "Default" / "Network" / "Cookies"
            create_cookie_db(db_path)
            output = Path(temporary) / "nested" / "state.json"

            with mock.patch.object(importer, "get_safe_storage_password", return_value=PASSWORD):
                summary = importer.import_cookies(
                    "Default", output, ["example.com"], user_data_dir=root
                )

            state = json.loads(output.read_text())
            self.assertEqual([cookie["name"] for cookie in state["cookies"]], ["session", "plain"])
            encrypted = state["cookies"][0]
            self.assertEqual(encrypted["value"], "super-secret")
            self.assertEqual(encrypted["domain"], ".example.com")
            self.assertEqual(encrypted["path"], "/account")
            self.assertEqual(encrypted["expires"], 1_700_000_000)
            self.assertTrue(encrypted["httpOnly"])
            self.assertTrue(encrypted["secure"])
            self.assertEqual(encrypted["sameSite"], "Strict")
            self.assertEqual(state["cookies"][1]["expires"], -1)
            self.assertEqual(state["origins"], [])
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(
                summary["counts"], {"read": 4, "matched": 3, "imported": 2, "skipped": 1}
            )
            self.assertEqual(summary["domains"], [".example.com", "sub.example.com"])
            self.assertEqual(
                summary["errors"],
                [{"domain": "broken.example.com", "error": "cookie_import_failed"}],
            )
            self.assertNotIn("super-secret", json.dumps(summary))
            self.assertNotIn("wrong-host-secret", json.dumps(summary))

    def test_preserves_partition_key_when_chrome_schema_provides_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Chrome"
            db_path = root / "Default" / "Network" / "Cookies"
            create_cookie_db(db_path)
            connection = sqlite3.connect(db_path)
            connection.execute("ALTER TABLE cookies ADD COLUMN top_frame_site_key TEXT DEFAULT ''")
            connection.execute(
                "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (".example.com", "session", "partition-secret", b"", "/account", 0, 1, 1, 2, "https://container.test"),
            )
            connection.commit()
            connection.close()
            output = Path(temporary) / "state.json"

            with mock.patch.object(importer, "get_safe_storage_password", return_value=PASSWORD):
                importer.import_cookies("Default", output, ["example.com"], user_data_dir=root)

            cookies = json.loads(output.read_text())["cookies"]
            partitioned = [cookie for cookie in cookies if cookie["value"] == "partition-secret"]
            self.assertEqual(len(partitioned), 1)
            self.assertEqual(partitioned[0]["partitionKey"], "https://container.test")

    def test_read_only_connection_sees_wal_while_chrome_style_writer_is_open(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            db_path = Path(temporary) / "Cookies"
            connection = sqlite3.connect(db_path)
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                INSERT INTO meta VALUES ('version', '24');
                CREATE TABLE cookies (
                    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
                    expires_utc INTEGER, is_httponly INTEGER, is_secure INTEGER, samesite INTEGER
                );
                INSERT INTO cookies VALUES ('example.com', 'n', 'v', X'', '/', 0, 0, 0, 1);
                """
            )
            connection.commit()
            version, rows = importer.read_cookie_rows(db_path)
            self.assertEqual(version, 24)
            self.assertEqual(len(rows), 1)
            connection.close()

    def test_rejects_profile_traversal_and_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Chrome"
            root.mkdir()
            outside = Path(temporary) / "outside"
            outside.mkdir()
            (root / "linked").symlink_to(outside, target_is_directory=True)

            for profile in ("../Default", "a/b", "..", str(outside), "linked"):
                with self.subTest(profile=profile):
                    with self.assertRaises(importer.SafeImportError):
                        importer.validate_profile(profile, root)

    def test_host_digest_is_required_for_version_24(self) -> None:
        key = importer.derive_v10_key(PASSWORD)
        encrypted = encrypt_v10("secret", "one.example", key)
        self.assertEqual(importer.decrypt_v10(encrypted, key, "one.example", 24), "secret")
        with self.assertRaises(importer.SafeImportError):
            importer.decrypt_v10(encrypted, key, "two.example", 24)


if __name__ == "__main__":
    unittest.main()
