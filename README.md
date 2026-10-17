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

## Idle parking

Parking is optional and needs the launcher as well as the extension. To enable it, add this alias to `~/.zshrc`, adjusting the path if your clone lives elsewhere:

```zsh
alias pi="$HOME/projects/vibes/scripts/pi-park"
```

Open a new terminal and run `pi --help` to check for `--park-after`. `/park` parks a session, and a keypress resumes it. `/reload` cannot add the launcher to an existing session.

## Updates

`~/.local/bin/vibes` points to `scripts/home-vibes` in your clone. `vibes update` fast-forwards from this repository, installs dependencies, updates unchanged template settings, keeps Pi at the tested version and runs `vibes check`. It does not merge another repository or push commits. A dirty or diverged checkout needs manual review.

`scripts/home-install-job` installs the optional nightly macOS update job. `vibes status` reads its log. The home command does not run managed refresh or hotfix jobs, update other workspaces or install upload jobs.

`vibes check` starts Pi in a hidden tmux session. Behaviour changes also need a real prompt and tool call. If Granola times out despite a valid login, see the [compatibility fix](docs/granola-mcp.md).

## Privacy

There is no default telemetry destination. Inventory and usage tools can collect local data; remote uploads require an explicitly configured destination. Inventory can include the text of your own extensions, skills and prompts. Review it before choosing a destination, and use a private repository or receiver. See [telemetry destinations](docs/telemetry-destinations.md) and [usage telemetry](docs/usage-telemetry.md). Set `"vibesTelemetry": false` in personal settings to disable collection and uploads.

Papercut notes stay local by default. Publishing this repository does not make it an inbox for private setup data or workflow notes. `/papercuts-review` reviews local notes; any remote submission is a separate, explicit action.
