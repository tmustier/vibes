import importlib.util
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "chrome-cookies" / "extract.py"
SPEC = importlib.util.spec_from_file_location("chrome_cookie_extract", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ChromeCookieDomainTests(unittest.TestCase):
    def test_executable_provisions_its_runtime(self) -> None:
        result = subprocess.run(
            [str(SCRIPT), "--help"], check=True, capture_output=True, text=True
        )
        self.assertIn("--domain", result.stdout)

    def matching_hosts(self, domain: str, include_subdomains: bool) -> list[str]:
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE cookies (host_key TEXT)")
        hosts = [
            "example.com",
            ".example.com",
            "app.example.com",
            ".deep.example.com",
            "notexample.com",
            "example.com.evil.test",
        ]
        conn.executemany("INSERT INTO cookies VALUES (?)", [(host,) for host in hosts])
        where, params = MODULE.cookie_domain_filter(domain, include_subdomains)
        matched = [row[0] for row in conn.execute(f"SELECT host_key FROM cookies WHERE {where}", params)]
        conn.close()
        return matched

    def test_exact_domain_does_not_match_substrings_or_subdomains(self) -> None:
        self.assertEqual(
            self.matching_hosts("example.com", False),
            ["example.com", ".example.com"],
        )

    def test_subdomain_matching_respects_label_boundary(self) -> None:
        self.assertEqual(
            self.matching_hosts("example.com", True),
            ["example.com", ".example.com", "app.example.com", ".deep.example.com"],
        )

    def test_invalid_domain_is_rejected(self) -> None:
        for domain in ("", "%example.com", "example_com", "https://example.com"):
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                MODULE.cookie_domain_filter(domain, True)

    def test_profile_autodetection_uses_same_domain_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            chrome = Path(tempdir) / "Library/Application Support/Google/Chrome"
            for profile, host in (("Default", "notexample.com"), ("Profile 1", "app.example.com")):
                db = chrome / profile / "Cookies"
                db.parent.mkdir(parents=True)
                conn = sqlite3.connect(db)
                conn.execute("CREATE TABLE cookies (host_key TEXT)")
                conn.execute("INSERT INTO cookies VALUES (?)", (host,))
                conn.commit()
                conn.close()

            with patch.object(MODULE.Path, "home", return_value=Path(tempdir)):
                found = MODULE.find_chrome_profile("example.com", include_subdomains=True)
            self.assertEqual(found, chrome / "Profile 1" / "Cookies")


if __name__ == "__main__":
    unittest.main()
