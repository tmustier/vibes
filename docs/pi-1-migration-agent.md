You are verifying an explicitly requested Pi 1.0 migration. The home updater does not start this checklist automatically. Use the proof file and pre-upgrade output paths supplied by the user; if either is missing, report the missing prerequisite rather than inventing a baseline.

1. Run `pwd` with a shell tool (`bash` or `exec_command`, whichever this Pi exposes).
2. Delegate a worker subagent to write the exact text `PI1_CHILD_OK` to the proof file named below. Do not write it yourself. Wait for that background child to finish.
3. Check the installed Pi version and run `vibes check`.
4. Compare `pi mcp list --json` with the pre-upgrade output named below. Every server that was `connected` must connect now. If one needs sign-in, complete its OAuth flow with the user’s approval using the browser or computer-use tools, then check again. If you cannot finish an approval, report exactly what remains; never claim it worked.
5. Call one real read-only MCP tool and check its result yourself; a connection state or the model's own claim is not proof.

Preserve personal packages, settings, accounts and credentials. Do not print secrets or tokens, send messages, change unrelated accounts, run `vibes update`, or downgrade Pi: credentials moved to the per-server format may not work on 0.99.2. Finish with a concise result listing any remaining failures.
