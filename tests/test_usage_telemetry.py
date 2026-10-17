"""Persisted Pi v3 shapes, offline/retry behavior, and aggregate-only output contracts."""
import copy
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/usage-telemetry"
loader = importlib.machinery.SourceFileLoader("usage_telemetry_test", str(SCRIPT))
usage = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(usage)


def tokens(input=10, output=7, cacheRead=30, cacheWrite=10):
    return dict(input=input, output=output, cacheRead=cacheRead, cacheWrite=cacheWrite,
                reasoning=3, totalTokens=input + output + cacheRead + cacheWrite,
                cost=dict(input=.01, output=.02, cacheRead=.003, cacheWrite=.004, total=.037))


def entry(id, type="message", date="2026-01-01", parentId=None, **fields):
    return dict(id=id, type=type, timestamp=date + "T12:00:00Z", parentId=parentId, **fields)


def assistant(id, date="2026-01-01", parentId=None, **fields):
    return entry(id, date=date, parentId=parentId, message=dict(role="assistant", content=[],
        provider="anthropic", model="claude-sonnet-4-5", usage=tokens(), **fields))


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.agent = self.root / "agent"
        self.agent.mkdir()
        self.collector = usage.Collector(self.agent)

    def tearDown(self):
        self.collector.db.close()
        self.temp.cleanup()

    def restart(self):
        self.collector.db.close()
        self.collector = usage.Collector(self.agent)

    def session(self, name, entries, **header):
        path = self.agent / name
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [dict(type="session", version=3, id=name, timestamp="2026-01-01T00:00:00Z",
                     cwd=str(self.root), **header), *entries]
        path.write_text("".join(json.dumps(e) + "\n" for e in rows))
        return path

    def bucket(self, date="2026-01-01"):
        return self.collector.collect()[date[:7]]["days"][date]

    def test_weighted_cache_usage_kinds_and_effort_dimensions(self):
        a = assistant("a", thinkingLevel="high", providerThinkingLevel="medium", responseModel="claude-sonnet-4-5-20250929")
        b = copy.deepcopy(a)
        b["id"] = "b"
        b["message"]["usage"] = tokens(input=90, cacheRead=10, cacheWrite=0)
        self.session("sessions/a.jsonl", [a, b, assistant("legacy"),
            entry("u", "usage", kind="cache_warm", provider="openai", model="gpt-5", usage=tokens(0, 0, 0, 0)),
            entry("c", "compaction", summary="SECRET", tokensBefore=900000, usage=tokens()),
            entry("s", "branch_summary", summary="SECRET", usage=tokens())])
        models = self.bucket()["models"]
        row = next(r for r in models if r["thinkingLevel"] == "high")
        self.assertEqual(row["records"], 2)
        self.assertAlmostEqual(row["cacheHitPercent"], 40 / 150 * 100)
        self.assertEqual((row["output"], row["reasoning"], row["totalTokens"]), (14, 6, 164))
        self.assertAlmostEqual(row["cost"]["total"], .074)
        self.assertEqual(row["model"], "claude-sonnet-4-5")
        self.assertEqual(row["responseModel"], "claude-sonnet-4-5-20250929")
        self.assertEqual(row["providerThinkingLevel"], "medium")
        self.assertEqual({r["kind"] for r in models}, {"assistant", "cache_warm", "compaction", "branch_summary"})
        self.assertIsNone(next(r for r in models if r["kind"] == "cache_warm")["cacheHitPercent"])
        self.assertTrue(any(r["kind"] == "assistant" and r["thinkingLevel"] == "unknown" for r in models))

    def test_all_branches_use_ancestral_metadata_not_active_branch(self):
        rows = [entry("m", "model_change", provider="anthropic", modelId="claude-sonnet-4-5"),
                entry("low", "thinking_level_change", parentId="m", thinkingLevel="low"),
                assistant("a", parentId="low"),
                entry("high", "thinking_level_change", parentId="a", thinkingLevel="high"),
                assistant("b", parentId="high"), assistant("c", parentId="low")]
        for row in (rows[2], rows[4], rows[5]):
            del row["message"]["provider"]
            del row["message"]["model"]
        self.session("sessions/branches.jsonl", rows)
        self.assertEqual({r["thinkingLevel"]: r["records"] for r in self.bucket()["models"]}, {"low": 2, "high": 1})

    def test_forks_mirrors_id_collisions_and_child_summaries(self):
        inherited = assistant("original")
        parent = self.session("sessions/main.jsonl", [inherited])
        child = self.session("sessions/main/forks/child.jsonl", [inherited, assistant("child")], parentSession=str(parent))
        self.session("custom-session-dir/copy.jsonl", [inherited, assistant("child")])
        self.session("sessions/unrelated.jsonl", [assistant("original", date="2026-01-02")])
        details = dict(mode="single", results=[dict(runId="r1", sessionFile=str(child), usage=tokens())])
        result = entry("result", message=dict(role="toolResult", toolName="subagent", toolCallId="call", details=details, usage=tokens()))
        with parent.open("a") as f:
            f.write(json.dumps(result) + "\n")
        self.session("sessions/debug.jsonl", []).write_text(json.dumps(dict(recordType="message", message=inherited["message"])) + "\n")
        periods = self.collector.collect()
        self.assertEqual(sum(r["records"] for r in periods["2026-01"]["days"]["2026-01-01"]["models"]), 2)
        self.assertEqual(sum(r["records"] for r in periods["2026-01"]["days"]["2026-01-02"]["models"]), 1)
        self.assertEqual(periods, self.collector.collect())

    def test_missing_child_summary_reconciles_when_child_appears(self):
        child = self.agent / "custom/run/session.jsonl"
        result = entry("r", message=dict(role="toolResult", toolName="bg_wait", toolCallId="c",
            details=dict(mode="single", results=[], completions=[dict(results=[dict(runId="r", sessionFile=str(child), usage=tokens())])])) )
        self.session("sessions/parent.jsonl", [result])
        self.assertEqual(self.bucket()["models"][0]["kind"], "subagent_summary")
        self.session("custom/run/session.jsonl", [assistant("child")])
        rows = self.bucket()["models"]
        self.assertEqual([(r["kind"], r["records"]) for r in rows], [("assistant", 1)])

    def test_repeated_child_receipts_use_latest_usage_and_utc_date(self):
        early = entry("early", message=dict(role="toolResult", toolName="bg_wait", toolCallId="c",
            details=dict(mode="single", results=[dict(runId="run", usage=dict(input=2, cost=.01))])))
        late = copy.deepcopy(early)
        late.update(id="late", timestamp="2026-02-01T00:30:00+01:00")
        late["message"]["details"]["results"][0]["usage"] = dict(input=20, cost=.10)
        self.session("sessions/receipts.jsonl", [early, late])
        periods = self.collector.collect()
        self.assertEqual(set(periods), {"2026-01"})
        rows = [r for bucket in periods["2026-01"]["days"].values() for r in bucket["models"]]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["input"], rows[0]["cost"]["total"]), (20, .10))
        self.assertEqual(periods["2026-01"]["days"]["2026-01-31"]["models"], rows)

    def test_usage_v6_child_presence_boundaries_and_missing_child_policy(self):
        first = assistant("first")
        first["message"]["usage"] = dict(input=100, output=10, cost=dict(total=1))
        second = assistant("second")
        second["message"]["usage"] = dict(input=200, output=20, cost=dict(total=2))
        parent = entry("report", message=dict(role="toolResult", toolName="subagent_wait", toolCallId="c",
            usage=dict(input=300, output=30, cost=dict(total=3)), details=dict(runId="run", results=[
                dict(usage=dict(input=100, output=10, cost=1)), dict(usage=dict(input=200, output=20, cost=2))])))
        self.session("sessions/parent.jsonl", [parent])
        self.session("sessions/parent/run/run-0/dated-name.jsonl", [first])
        # Unlike v6's full canonical aggregate + child (cost 4), use missing child only.
        self.assertEqual(sum(r["cost"]["total"] for r in self.bucket()["models"]), 3)
        self.session("sessions/parent/run/run-1/session.jsonl", [second])
        self.assertEqual([(r["kind"], r["cost"]["total"]) for r in self.bucket()["models"]], [("assistant", 3)])
        # A copied parent whose derived child paths dangle must not reintroduce usage.
        self.session("sessions/stale-copy.jsonl", [parent])
        self.assertEqual(sum(r["cost"]["total"] for r in self.bucket()["models"]), 3)
        self.restart()
        self.assertEqual(sum(r["cost"]["total"] for r in self.bucket()["models"]), 3)

    def test_usage_v6_truncated_child_and_unlinked_generic_tool(self):
        self.session("sessions/empty.jsonl", [])
        linked = entry("linked", message=dict(role="toolResult", toolName="subagent", toolCallId="a",
            usage=tokens(), details=dict(results=[dict(sessionFile="empty.jsonl", usage=tokens())])))
        generic = entry("generic", message=dict(role="toolResult", toolName="nested_llm", toolCallId="b", usage=tokens()))
        unrelated = entry("other", message=dict(role="toolResult", toolName="other", toolCallId="c",
            details=dict(results=[dict(usage=tokens())])))
        self.session("sessions/parent.jsonl", [linked, generic, unrelated])
        self.assertEqual([(r["kind"], r["records"]) for r in self.bucket()["models"]], [("tool", 1)])

    def test_equal_timestamp_token_vectors_are_not_event_identity(self):
        a, b = assistant("a"), assistant("b")
        b["message"]["usage"] = tokens(input=9, output=8)
        self.session("sessions/parent.jsonl", [a, b])
        self.session("sessions/fork.jsonl", [a])
        row = self.bucket()["models"][0]
        self.assertEqual((row["records"], row["input"], row["output"]), (2, 19, 15))

    def test_restart_partial_truncation_replacement_and_no_retention_cutoff(self):
        path = self.session("sessions/a.jsonl", [assistant("old", date="2020-01-01")])
        initial = self.collector.collect()
        install = self.collector.installation
        text = json.dumps(assistant("new", date="2026-10-14"))
        with path.open("a") as f:
            f.write(text[:70])
        self.assertEqual(initial, self.collector.collect())
        self.restart()
        with path.open("a") as f:
            f.write(text[70:] + "\n")
        self.assertEqual(set(self.collector.collect()), {"2020-01", "2026-10"})
        self.assertEqual(self.collector.installation, install)
        self.session("sessions/a.jsonl", [assistant("replacement", date="2024-05-01")])
        self.assertEqual(set(self.collector.collect()), {"2020-01", "2024-05", "2026-10"})
        path.unlink()
        self.assertEqual(set(self.collector.collect()), {"2020-01", "2024-05", "2026-10"})

    def test_late_result_updates_old_month_without_matching_another_sessions_call(self):
        a = assistant("a")
        a["message"]["content"] = [dict(type="toolCall", id="call_1", name="read", arguments={})]
        b = copy.deepcopy(a)
        b["id"] = "b"
        path = self.session("sessions/a.jsonl", [a])
        self.session("sessions/b.jsonl", [b])
        self.assertEqual(self.bucket()["tools"][0]["unfinished"], 2)
        with path.open("a") as f:
            f.write(json.dumps(entry("r", date="2026-10-14", message=dict(role="toolResult",
                toolCallId="call_1", toolName="read", isError=False, nestedCalls=dict(calls=[], complete=True)))) + "\n")
        self.restart()
        bucket = self.bucket()
        self.assertEqual((bucket["tools"][0]["results"], bucket["tools"][0]["unfinished"]), (1, 1))
        self.assertEqual(self.bucket("2026-10-14")["nestedCoverage"]["complete"], 1)

    def test_cli_send_uses_github_login_and_payload(self):
        (self.agent / "settings.json").write_text(json.dumps({"telemetryDestination": {
            "type": "github", "repository": "example/setup-telemetry"}}))
        self.session("sessions/a.jsonl", [assistant("a")])
        binary = self.root / "bin"
        binary.mkdir()
        stored = self.root / "uploaded.json"
        (binary / "gh").write_text(f'''#!/usr/bin/env python3
import base64, json, sys
from pathlib import Path
stored = Path({str(stored)!r})
if sys.argv[2] == "user":
    print("test-user")
elif "PUT" in sys.argv:
    request = json.load(sys.stdin)
    stored.write_bytes(base64.b64decode(request["content"]))
elif stored.exists():
    print(json.dumps({{"sha":"existing", "content":base64.b64encode(stored.read_bytes()).decode()}}))
else:
    sys.exit(1)
''')
        (binary / "gh").chmod(0o755)
        env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent), "PATH": str(binary) + os.pathsep + os.environ["PATH"]}
        result = subprocess.run([str(SCRIPT), "send"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(stored.read_text())
        self.assertEqual(document["githubLogin"], "test-user")
        self.assertEqual(document["days"]["2026-01-01"]["models"][0]["records"], 1)
        self.assertIn("example/setup-telemetry/usage/test-user/", result.stdout)

    def test_tools_nested_coverage_skills_mapping_and_privacy(self):
        secret = "private@example.com /work/project prompt SECRET"
        skill = self.root / "secret-project/skills/private/SKILL.md"
        wrapper = self.root / "ext.ts"
        (self.agent / "vibes-inventory.json").write_text(json.dumps(dict(generatedAt="2026-01-01T00:00:00Z",
            extensions=[dict(path=str(wrapper), enabled=True, bundles=dict(package="pi-subagents"))],
            skills=[dict(path=str(skill), name=secret)], tools=[dict(name=secret, path=str(wrapper))])))
        a = assistant("a")
        a["message"]["content"] = [dict(type="text", text=secret),
            dict(type="toolCall", id="read1", name="read", arguments=dict(path=str(skill))),
            dict(type="toolCall", id="error", name=secret, arguments=dict(secret=secret)),
            dict(type="toolCall", id="unfinished", name="bash", arguments=dict(command=secret))]
        r = entry("r", message=dict(role="toolResult", toolName="read", toolCallId="read1", isError=False, content=[dict(type="text", text=secret)]))
        n = entry("n", message=dict(role="toolResult", toolName=secret, toolCallId="error", isError=True,
            usage=tokens(), nestedCalls=dict(complete=False, calls=[dict(id="nested1", name="read", status="ok", arguments=dict(path=str(skill))),
                dict(id="nested2", name="bash", status="error"), dict(id="nested3", name="bash", status="unfinished")])) )
        self.session("sessions/a.jsonl", [a, r, n])
        bucket = self.bucket()
        self.assertEqual(sum(bucket["skills"].values()), 2)
        self.assertEqual(sum(t["attempts"] for t in bucket["tools"]), 6)
        self.assertEqual(sum(t["results"] for t in bucket["tools"]), 4)
        self.assertEqual(sum(t["errors"] for t in bucket["tools"]), 2)
        self.assertEqual(sum(t["unfinished"] for t in bucket["tools"]), 2)
        self.assertEqual(bucket["nestedCoverage"], dict(complete=0, incomplete=1, unrecorded=1))
        self.assertEqual(sum(bucket["loadedResources"].values()), 1)
        sent = json.dumps(self.collector.collect())
        for private in (secret, str(skill), str(wrapper), "arguments", "toolCallId", "content", "sessionFile"):
            self.assertNotIn(private, sent)
        (self.agent / "vibes-inventory.json").unlink()
        self.restart()
        self.assertEqual(bucket, self.bucket())

    def test_readable_structured_names_and_normalized_extension_sources(self):
        skill = self.agent / "skills/unslop/SKILL.md"
        wrapper = self.root / "extensions/subagents.ts"
        web = self.root / "web-package"
        mcp = self.root / "mcp-package"
        snapshot = dict(generatedAt="2026-01-01T00:00:00Z", extensions=[
            dict(path=str(wrapper), enabled=True, bundles=dict(package="pi-subagents"))],
            packages=[dict(source="npm:@example/web-tools@1.0.0", installedPath=str(web)),
                      dict(source="git:https://github.com/example/mcp-tools.git#main", installedPath=str(mcp))],
            skills=[dict(path=str(skill), name="unslop")], tools=[
                dict(name="subagent", path=str(wrapper)), dict(name="web_enable", path=str(web / "index.ts")),
                dict(name="fetch_content", path=str(web / "index.ts")),
                dict(name="mcp__linear__list_issues", path=str(mcp / "index.ts"))])
        (self.agent / "vibes-inventory.json").write_text(json.dumps(snapshot))
        a = assistant("a", thinkingLevel="high", providerThinkingLevel="medium")
        a["message"]["model"] = "claude-fable-5-1"
        a["message"]["responseModel"] = "anthropic/claude-fable-5-1"
        names = ["read", "subagent", "web_enable", "fetch_content", "mcp__linear__list_issues"]
        a["message"]["content"] = [dict(type="toolCall", id=name, name=name, arguments=dict(path=str(skill))) for name in names]
        result = entry("result", message=dict(role="toolResult", toolName="read", toolCallId="read", isError=False))
        self.session("sessions/readable.jsonl", [a, result])
        bucket = self.bucket()
        self.assertEqual(bucket["skills"], {"unslop": 1})
        self.assertEqual({t["tool"] for t in bucket["tools"]}, set(names))
        self.assertEqual(bucket["extensions"], {"builtin": 1, "pi-subagents": 1, "@example/web-tools": 2, "github:example/mcp-tools": 1})
        self.assertEqual(bucket["models"][0]["model"], "claude-fable-5-1")
        self.assertEqual(bucket["models"][0]["responseModel"], "anthropic/claude-fable-5-1")
        sent = json.dumps(self.collector.collect())
        self.assertNotIn("https://", sent)
        self.assertNotIn(str(self.root), sent)

    def test_discovery_excludes_package_fixtures_and_requires_custom_references(self):
        self.session("sessions/real.jsonl", [assistant("real")])
        self.session("vibes-pi-1-ABC123/sessions/migration.jsonl", [assistant("migration")])
        custom = self.session("custom-dir/child.jsonl", [assistant("child")])
        for directory in ("git/package/tests", "npm/package", "extensions/package", "node_modules/package", "other"):
            self.session(directory + "/fixture.jsonl", [assistant(directory)])
        self.assertEqual(self.bucket()["models"][0]["records"], 2)
        result = entry("child-ref", message=dict(role="toolResult", toolName="subagent", toolCallId="c",
            details=dict(results=[dict(sessionFile=str(custom), usage=tokens())])))
        self.session("sessions/reference.jsonl", [result])
        self.assertEqual(self.bucket()["models"][0]["records"], 3)
        self.restart()
        self.assertEqual(self.bucket()["models"][0]["records"], 3)

    def test_builtin_source_labels_are_not_paths_relative_to_collector_cwd(self):
        (self.agent / "vibes-inventory.json").write_text(json.dumps({
            "packages": [{"source": "npm:sample-tools", "installedPath": str(Path.cwd())}],
            "tools": [{"name": "read", "source": "builtin", "path": "builtin:read"}],
        }))
        a = assistant("a")
        a["message"]["content"] = [{"type": "toolCall", "id": "c", "name": "read", "arguments": {}}]
        self.session("sessions/main.jsonl", [a])
        self.assertEqual(self.bucket()["tools"][0]["extension"], "builtin")

    def test_symlinked_session_root_and_files_are_supported_without_duplicates(self):
        actual = self.session("external-session-root/real.jsonl", [assistant("real")])
        (self.agent / "sessions").symlink_to(actual.parent, target_is_directory=True)
        (actual.parent / "linked.jsonl").symlink_to(actual)
        self.assertEqual(self.bucket()["models"][0]["records"], 1)
        self.assertEqual(self.bucket()["models"][0]["records"], 1)

    def test_collect_is_local_and_opt_out_touches_no_state(self):
        self.session("sessions/a.jsonl", [assistant("a")])
        env = {**os.environ, "PI_CODING_AGENT_DIR": str(self.agent)}
        result = subprocess.run([str(SCRIPT), "collect"], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["enabled"])
        other = self.root / "opt-out"
        other.mkdir()
        (other / "settings.json").write_text('{"vibesTelemetry":false}')
        for command in ("collect", "send"):
            result = subprocess.run([str(SCRIPT), command, "--inventory", "/nonexistent"],
                env={**env, "PI_CODING_AGENT_DIR": str(other)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)["enabled"])
        self.assertFalse((other / "usage-telemetry").exists())

    def test_report_combines_users_installations_inclusive_period_weighted_rates(self):
        self.session("sessions/a.jsonl", [assistant("a"), assistant("b", date="2026-02-01"), assistant("outside", date="2026-02-02")])
        documents = self.collector.collect()
        checkout = self.root / "checkout"
        for user, installation in (("alice", "one"), ("alice", "two"), ("bob", "three")):
            for month, original in documents.items():
                doc = copy.deepcopy(original)
                doc["installationId"] = installation
                if installation == "two":
                    for bucket in doc["days"].values():
                        bucket["models"][0].update(input=90, cacheRead=10, cacheWrite=0)
                path = checkout / "usage" / user / installation / (month + ".json")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(doc))
        result = subprocess.run([str(ROOT / "scripts/usage-report"), str(checkout), "--from", "2026-01-01", "--to", "2026-02-01"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        users = json.loads(result.stdout)["users"]
        self.assertEqual(set(users), {"alice", "bob"})
        alice = users["alice"]["models"][0]
        self.assertEqual(alice["records"], 4)
        self.assertAlmostEqual(alice["cacheHitPercent"], 80 / 300 * 100)
        self.assertEqual(users["bob"]["models"][0]["records"], 2)
        self.assertEqual(users["bob"]["models"][0]["cacheHitPercent"], 60)


if __name__ == "__main__":
    unittest.main()
