# Personal Vibes

A personal Pi distribution published from `tmustier/vibes`.

- Keep bundled packages and stable extension wrapper names unless the user asks to remove them. Features use the `~/.pi/agent/vibes.json` boolean map. Preserve the user's choices.
- Preserve personal defaults in `settings.template.json`, `profiles/home.vibes.json`, `prompts/onboard.md` and `scripts/home-*`. Review any future source import before publication; do not automatically merge another distribution into the public branch.
- The home updater is `scripts/home-update`, exposed by `scripts/home-vibes`. It fast-forwards from this repository, verifies startup and never pushes commits. It does not install managed refresh, hotfix or telemetry jobs or update other workspaces.
- Keep credentials, personal MCP configuration and generated reports outside Git. Telemetry has no default remote destination. Papercuts stay local by default; do not redirect them to this public repository.
- Read complete files before editing, use a fresh task worktree or clone, test the diff and commit with the user's GitHub identity. Never publish private source history or configuration.
- Run `npm run typecheck`, the relevant tests and `python3 tests/test_public_release.py`. For behaviour changes, verify a real model prompt and actual tool use in an isolated Pi config. Startup alone is not proof.
