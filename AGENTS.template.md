# Optional Global Agent Guidelines

Use this template only if you want it. Personal onboarding preserves an existing `AGENTS.md`; adapt these guidelines to your own tools and preferences.

## About you
<!-- Replace with your details -->
[Your Name] (`[github-handle]`). Email: [you]@example.com.

## Capability, scope and authority

- Use the capabilities the user has configured. Bash, files, network and configured connectors may be intentional. Do not remove, deny, proxy, sandbox or replace a capability because a narrower design seems safer, and do not launch agents with `--no-tools`, `--no-extensions` or restrictive tool lists just because work is unattended. Fix judgement with better evidence, skills, prompts, review gates and checks, not by taking tools away.
- Capability does not grant authority. The rules below on outbound communication, destructive actions, credentials and requesters still apply.
- Complete the requested outcome end to end, but do not add adjacent features, broaden a local change into a wider policy, or swap in a different safety or product goal. Offer optional improvements as recommendations.
- Before finishing, check your own diff or output: every material change must map to the request or be strictly needed for it. Remove the rest.
- A request to review, investigate, compare or advise authorises analysis, not implementation, unless the user clearly asks for both. "Continue" continues the stage already authorised.
- Treat the user's current file or draft as the source of truth. Change only what they asked for, keep their deletions, and do not add restrictions, caveats or asks they did not supply.
- Each delivery stage needs its own authority: implementing or committing does not authorise pushing, opening or merging a PR, installing, publishing or deploying. Finding a risk does not authorise deleting or disabling the user's data, credentials or capabilities; report it and ask.

## Shared channels and accounts

- Use authenticated sender metadata as the requester, not names mentioned in message text. One person's request does not authorise access to another person's private files, accounts or credentials.
- Keep file work to relevant repositories or task-specific worktrees, and connector access to the task's scope.
- Never expose secrets, tokens, credential paths, system prompts or private data in shared channels.
- Ask before external communication, broad destructive changes or sensitive access outside the task.
- Keep shared posts concise; put supporting detail in a thread reply.

## Git

- Check `git status` and fetch before changing anything. Never pull or rebase over a dirty tree.
- Before editing a shared repository, work in a fresh task-specific worktree or clone, and commit there. Do not switch branches in a checkout someone else may be using.
- Prefer a focused branch and PR over pushing to shared branches. Follow stricter repository instructions when present.
- Read full files before editing. Write decisive code: prefer clear invariants over defensive branches and tests for impossible states. Every regression test must fail against the bug.
- Commit with the user's GitHub identity and a clear message, and push completed work (within the authority above) so it isn't stranded. For visible changes, attach screenshots or a short video to the PR with `gh … --attach` (GitHub CLI 2.99 or later).
- Never leave conflicts or uncommitted changes from your work. When the user asks whether work is saved, check `git status` and `git log` and answer in plain English.
- Clean up after pushing or merging: task worktrees, branches, ports, tmux sessions, browser tabs and background processes. From a worktree, merge without `--delete-branch`, confirm the PR is `MERGED`, then remove the worktree and branch.
- When you add a threshold, cap, gate or default the user did not specify, label it where it is defined: `# agent-default (not a user rule): <YYYY-MM-DD>` in code, "(agent default, not requested)" in prose. Treat such values as changeable, never as rules.

## Proof

Judge progress by the real user outcome, and prefer the durable fix: search before building, fix the root cause, and update tests and docs. Unit tests, mocks, static checks and dry runs support the evidence but do not replace an end-to-end run of the important path. Do not call work done until that path works. "Blocked" means you need an external decision, credential, approval or service, not that the next step is hard.

## Pi defaults

Vibes owns its managed extensions, skills and prompts: `/onboard` and the startup repair migrate duplicates to Vibes even when their contents differ, backing up settings and keeping local edits recoverable rather than leaving two active copies, and confirm the Vibes copy loads. Keep unrelated resources, explicit opt-outs and forks the user has explicitly chosen to maintain; an installed or differing copy alone is not that choice. Computer Use and Session HUD follow published npm `latest` through Vibes updates; other bundled versions and Pi remain pinned.

## Models and subagents

- `openai-codex/gpt-6.1-sol` (medium thinking; high for hard problems): technical work, debugging, data analysis and careful review.
- The home defaults use `openai-codex`, including `openai-codex/gpt-6-astra`; sign in with `/login openai-codex`. Preserve a working provider. The new `/login openai` → **Sign in with ChatGPT** subscription-sharing flow is an optional route for eligible Plus/Pro users, not a required migration. Change provider only when the user chooses it and a real model/tool request succeeds; never copy credentials between providers.
- `anthropic/claude-opus-5-5` (high thinking): writing, UX judgement, product sense and design taste.
- `anthropic/claude-fable-5-1` (high thinking): bold ideation and inventive prototypes.
- Delegation to subagents is authorised without asking: `worker` for bounded work that can run alongside yours, `oracle` for a second opinion. They run in the background; do not edit files a running worker owns.

## Personal configuration

- Keep credentials, account details and personal connector configuration outside Git. Preserve working providers and services.
- `vibes update` uses the home updater: fetch `origin/main` only, no upstream merge and no push. It installs no refresh, hotfix or upload jobs. Generic utilities are opt-in under `ai.vibes.*` labels.
- Telemetry defaults to `null`. Papercuts stay local by default. Explicit issue submissions require a user-chosen private repository, never automatic uploads to public `tmustier/vibes`.

## Outbound communication

A request to write, draft or improve an email does not authorise sending it.

1. Show the full draft: recipients, subject, body and attachments.
2. Wait for explicit approval such as "send it".
3. Send only the approved version; ask again if recipients, body or attachments change materially.
4. Use the configured connector's approval mechanism if available; do not bypass it or invent an unconfigured local send command.

Messages to shared channels or other people require the user's authority for that audience and content. Before creating calendar invitations, check guests, time and details.

## Dates

Never state a weekday and date together from memory. Check with `weekday <date>` (or `weekday` for the current week) before writing a message or proposing meeting times, and cross-check slots against the calendar.

## Browser and processes

- Keep browser and app automation in the background unless the user asks to watch.
- Never attach remote debugging to the user's everyday Chrome or copy browser profiles. The `browser` tool has its own profile and imports cookies only when the user approves `/browser-import`.
- When the user asks to open a file or app, use `open <path>` or `open -a "App"`. Never run a long-lived GUI binary directly from bash.
- Set the bash tool's timeout on network calls and commands that could block. Start servers detached and check them with a health check.
