# Personal Vibes

A personal [Pi](https://pi.dev) setup with bundled extensions, skills and prompts. Features include browser tools, background subagents, voice, image generation, fast mode, context tools and Anthropic request compression. [Amp orbs](docs/amp-orbs.md) are optional.

## Install on a Mac

Install Node through [nvm](https://github.com/nvm-sh/nvm), using the major version in `.node-version`. Then clone the repository, install the pinned Pi version and load the package:

```sh
mkdir -p ~/projects
git clone https://github.com/tmustier/vibes.git ~/projects/vibes
cd ~/projects/vibes
npm ci --omit=dev --ignore-scripts
npm install -g --ignore-scripts \
  --before "$(node -p 'require("./package.json").piDependencyCutoff')" \
  "@earendil-works/pi-coding-agent@$(node -p 'require("./package.json").devDependencies["@earendil-works/pi-coding-agent"]')"
pi install "$HOME/projects/vibes"
pi
```

Run `/onboard` in Pi. It preserves your settings and credentials, applies the initial profile in `profiles/home.vibes.json`, offers the nightly updater and checks startup and real tool use. The setup uses `openai-codex` and `anthropic` logins. Connect your own accounts and keep credentials and MCP configuration outside Git.

## Choose features

Your choices live in `~/.pi/agent/vibes.json`:

```json
{ "features": { "surf": false, "cachemire": true } }
```

Run `vibes features` to list feature names and defaults. The initial home profile is not an overwrite policy: later choices stay yours. Dependencies remain installed when their features are off.

See [existing setups](docs/existing-setups.md), [fast mode](docs/fast-mode.md) and the package guides for [browser tools](packages/pi-browser/README.md) and [request compression](packages/pi-anthropic-gzip/README.md).

## Claude artifacts

Ask Pi to publish a page on claude.ai, update an existing artifact, read its comments or use its shared database. The tools load when needed and require Claude Code on `PATH`, signed in with `claude auth login` to an account with artifacts enabled. Without Claude Code, the feature adds nothing.

Set `"claude-artifacts": false` in your feature choices to disable it. See [Claude artifact tools](docs/claude-artifacts.md) for details and limitations, or [existing setups](docs/existing-setups.md#claude-artifact-skill-from-an-older-vibes) if you used the old publishing skill.

## Idle parking

Parking is optional and needs the launcher as well as the extension. To enable it, add this alias to `~/.zshrc`, adjusting the path if your clone lives elsewhere:

```zsh
alias pi="$HOME/projects/vibes/scripts/pi-park"
```

Open a new terminal and run `pi --help` to check for `--park-after`. `/park` parks a session, and a keypress resumes it. `/reload` cannot add the launcher to an existing session.

## Updates

`~/.local/bin/vibes` points to `scripts/home-vibes` in your clone. `vibes update` fast-forwards from this repository, installs dependencies, updates unchanged template settings, keeps Pi at the tested version and runs `vibes check`. It does not merge another repository or push commits. A dirty or diverged checkout needs manual review.

The home updater writes `~/.pi/agent/vibes-update.json` with `updater: "home"`, a success or failure result and step details, plus a personal update log. `vibes status` shows the structured result and launchd state. The update-status extension warns about failed or stale updates and recommends `vibes update`, not managed refresh. Home repairs stay local, create no central report and do not ask you to synchronize an AGENTS template.

`scripts/home-install-job` installs the optional nightly macOS update job. The home command does not run managed refresh or hotfix jobs, update other workspaces or install upload jobs.

`vibes check` starts Pi in a hidden tmux session. Behaviour changes also need a real prompt and tool call. If Granola times out despite a valid login, see the [compatibility fix](docs/granola-mcp.md).

### Codex Notes migration

Codex Conversion 4.0.5 removes its built-in Notes/history and legacy Remote mode. Existing Notes configurations can block turns, including in voice-only mode. Follow the upgrade message: install and enable `@howaboua/pi-notes-compaction`, or explicitly choose ordinary compaction in the indicated configuration file. The updater does not make that choice for you.

## Privacy

There is no default telemetry destination. Inventory and usage tools can collect local data; remote uploads require an explicitly configured destination. Inventory can include the text of your own extensions, skills and prompts. Review it before choosing a destination, and use a private repository or receiver. See [telemetry destinations](docs/telemetry-destinations.md) and [usage telemetry](docs/usage-telemetry.md). Set `"vibesTelemetry": false` in personal settings to disable collection and uploads.

Papercut notes stay local by default. Publishing this repository does not make it an inbox for private setup data or workflow notes. `/papercuts-review` reviews local notes; any remote submission is a separate, explicit action.

## License

[MIT](LICENSE). Third-party code and dependencies retain their own license terms.
