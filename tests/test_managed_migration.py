#!/usr/bin/env python3
"""Opt-in live-model regression: python3 tests/test_managed_migration.py.

Runs automatic startup migration in isolated homes, using the real Pi tools,
resource loader, startup check and inventory. It does not run Homebrew updates
or upload reports: the scratch `vibes update` only checks the migrated setup.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
MODEL = "gpt-6-sol"


def run_case(case, evidence):
    revision = subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="vibes-migration-") as temp:
        home = Path(temp)
        agent = home / ".pi/agent"
        agent.mkdir(parents=True)
        shutil.copyfile(Path.home() / ".pi/agent/auth.json", agent / "auth.json")
        kit = home / "ops-kit"
        extra = kit / "skills/fixture-extra/SKILL.md"
        extra.parent.mkdir(parents=True)
        extra.write_text("---\nname: fixture-extra\ndescription: Unrelated fixture skill\n---\nKeep this resource.\n")
        if case == "package":
            duplicate = kit / "code-actions/index.ts"
            duplicate.parent.mkdir(parents=True)
            duplicate.write_text('export default (pi) => pi.registerCommand("code", { description: "Personal differing code menu", handler: async () => {} });\n')
            manifest = {"name": "pi-extensions", "pi": {"extensions": ["code-actions/index.ts"], "skills": ["skills"]}}
        else:
            duplicate = kit / "skills/ask-granola/SKILL.md"
            duplicate.parent.mkdir(parents=True)
            duplicate.write_text("---\nname: ask-granola\ndescription: Personal Granola scope and evidence rules\n---\nKeep fixture meeting evidence separate from fixture sales notes.\n")
            manifest = {"name": "fixture-ops-kit", "pi": {"skills": ["skills"]}}
            log = home / "pi-update.log"
            log.write_text("=== fixture vibes update\nStartup failed: ops-kit and Vibes both provide ask-granola.\n")
            (agent / "vibes-update.json").write_text(json.dumps({"finishedAt": "2026-10-01T12:00:00Z", "ok": False, "log": str(log), "steps": [{"name": "startup", "ok": False, "detail": "skill conflict"}]}))
        original = hashlib.sha256(duplicate.read_bytes()).hexdigest()
        (kit / "package.json").write_text(json.dumps(manifest))
        settings = {
            "defaultProvider": "openai", "defaultModel": MODEL, "defaultThinkingLevel": "medium",
            "packages": [
                {"source": str(kit), "skills": ["!skills/unused/SKILL.md"]},
                {"source": str(REPO), "extensions": ["extensions/code-actions.ts", "extensions/update-status.ts", "extensions/inventory.ts", "extensions/vibes-check.ts", "extensions/non-interactive-bash.ts"], "skills": ["skills/ask-granola/SKILL.md"]},
            ],
            "fixturePersonalSetting": "keep",
        }
        (agent / "settings.json").write_text(json.dumps(settings, indent=2))
        (agent / "vibes.json").write_text('{"features":{"surf":false}}\n')
        bindir = home / ".local/bin"
        bindir.mkdir(parents=True)
        # Real checking/inventory; deliberately no machine upgrades or remote reports in a fixture.
        (bindir / "vibes").write_text(f'''#!/bin/bash
case "$1" in
 check|inventory) exec {shlex.quote(str(REPO / "scripts/vibes"))} "$@" ;;
 update) {shlex.quote(str(REPO / "scripts/vibes"))} check ;;
 report) printf '%s\\n' "$*" >> {shlex.quote(str(home / "reports.log"))} ;;
 *) exit 2 ;;
esac
''')
        (bindir / "vibes").chmod(0o755)
        (agent / "APPEND_SYSTEM.md").write_text(
            f"This is an isolated migration fixture, not a live laptop. HOME={home}; PI_CODING_AGENT_DIR={agent}. "
            "Use the installed scratch vibes command for verification. Its check and inventory use real Pi; update only reruns that check, and report stays local. "
            "Keep changes inside this fixture; do not commit changes to the package sources. Preserve unrelated resources and existing filters. "
            "After finishing verification, write MIGRATION_DONE to ~/migration-done.\n"
        )
        sock = str(home / "tmux.sock")
        session = "migration"
        def tm(*args):
            return subprocess.check_output(["tmux", "-S", sock, *args], text=True)
        env = os.environ.copy()
        env.update(HOME=str(home), PI_CODING_AGENT_DIR=str(agent), PATH=str(bindir) + ":" + env["PATH"])
        env.pop("PI_SUBAGENT_CHILD", None)
        transcript = evidence / f"{case}.jsonl"
        command = f"pi --provider openai --model {MODEL} --thinking medium --session {shlex.quote(str(transcript))}"
        subprocess.run(["tmux", "-S", sock, "new-session", "-d", "-s", session, "-x", "220", "-y", "80", "-c", str(home), command], env=env, check=True)
        try:
            deadline = time.monotonic() + 600  # agent-default (not a user rule): 2026-10-01
            while time.monotonic() < deadline and not (home / "migration-done").exists():
                time.sleep(2)
            screen = tm("capture-pane", "-p", "-J", "-S", "-", "-t", session)
            (evidence / f"{case}-screen.txt").write_text(screen)
            assert (home / "migration-done").read_text().strip() == "MIGRATION_DONE", screen[-4000:]
            changed = json.loads((agent / "settings.json").read_text())
            assert changed["fixturePersonalSetting"] == "keep"
            assert json.loads((agent / "vibes.json").read_text()) == {"features": {"surf": False}}
            assert hashlib.sha256(duplicate.read_bytes()).hexdigest() == original, "source edits must remain recoverable"
            assert any(p.get("source") == str(kit) for p in changed["packages"] if isinstance(p, dict)), "mixed package retained"
            kit_entry = next(p for p in changed["packages"] if isinstance(p, dict) and p.get("source") == str(kit))
            assert "!skills/unused/SKILL.md" in kit_entry["skills"], "existing exclusion retained"
            backups = []
            for p in home.rglob("*settings*"):
                if not p.is_file() or p == agent / "settings.json":
                    continue
                try:
                    saved = json.loads(p.read_text())
                except json.JSONDecodeError:
                    continue
                # Pi adds runtime preferences such as lastChangelogVersion before migration.
                if all(saved.get(key) == value for key, value in settings.items()):
                    backups.append(p)
            assert backups, "original settings must be recoverable"
            tm("send-keys", "-t", session, "Escape")
            time.sleep(1)
            # Reload the actual runtime, then inspect resource origins independently of model claims.
            raw = home / "asserted-inventory.json"
            tm("kill-session", "-t", session)
            check_env = env | {"INVENTORY": str(raw)}
            subprocess.run(["bash", "-c", f"source {shlex.quote(str(REPO / 'scripts/vibes'))}; cmd_check"], env=check_env, check=True, timeout=160)
            inventory = json.loads(raw.read_text())
            shutil.copyfile(raw, evidence / f"{case}-inventory.json")
            assert any(s.get("name") == "fixture-extra" and s.get("loaded") for s in inventory["skills"])
            if case == "skill":
                loaded = [s for s in inventory["skills"] if s.get("name") == "ask-granola" and s.get("loaded")]
                assert len(loaded) == 1 and loaded[0]["path"].startswith(str(REPO)), loaded
                assert any(s["path"] == str(duplicate) and not s["loaded"] for s in inventory["skills"])
            else:
                code = [c for c in inventory["commands"] if c["name"] == "code"]
                assert len(code) == 1 and code[0]["path"].startswith(str(REPO)), code
                assert not any(e["path"] == str(duplicate) and e["enabled"] for e in inventory["extensions"])
            events = [json.loads(line) for line in transcript.read_text().splitlines()]
            messages = [e.get("message", {}) for e in events if e.get("type") == "message"]
            trigger = "vibes-resource-migration" if case == "package" else "vibes-update-failed"
            assert any(e.get("type") == "custom_message" and e.get("customType") == trigger for e in events), "automatic trigger required"
            assert any(m.get("role") == "assistant" and m.get("provider") == "openai" and m.get("model") == MODEL for m in messages)
            assert any(m.get("role") == "toolResult" and not m.get("isError") for m in messages)
            (evidence / f"{case}-assertions.json").write_text(json.dumps({"revision": revision, "model": "openai/" + MODEL, "thinking": "medium", "trigger": trigger, "vibesOwnership": True, "unrelatedResourcesPreserved": True, "sourceAndSettingsRecoverable": True}, indent=2))
            print(f"PASS {case}: automatic migration, Vibes ownership and recoverable custom work", flush=True)
        finally:
            subprocess.run(["tmux", "-S", sock, "kill-server"], capture_output=True)


if __name__ == "__main__":
    evidence = Path(tempfile.mkdtemp(prefix="vibes-migration-evidence-"))
    print("Evidence:", evidence, flush=True)
    for case in ["skill", "package"]:
        run_case(case, evidence)
    print("Scratch homes and credential copies removed.", flush=True)
