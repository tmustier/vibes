---
name: unslop
description: Detect repetitive AI defaults for a domain and generate a reusable avoidance profile. Use when asked to "unslop", "de-slop", "remove AI patterns", "make less generic", generate an anti-slop profile, or analyze AI output patterns for any domain (writing, landing pages, emails, code, etc.).
---

# unslop

Empirically detect the repetitive defaults a model falls back on, then produce a reusable instruction file that makes future outputs less generic.

## Quickstart

```bash
# Text domains (writing, emails, tutorials, code)
python3 SKILL_DIR/unslop.py --domain "blog writing"

# Visual domains (websites, landing pages, HTML)
pip install playwright && playwright install chromium
python3 SKILL_DIR/unslop.py --domain "startup SaaS landing pages" --type visual --count 20 --concurrency 3
```

The script uses `pi -p` (non-interactive mode) to generate samples and run analysis. It works with whatever model/provider pi is configured for.

## Options

| Flag | Default | Description |
|---|---|---|
| `--domain` | required | What to analyze |
| `--type` | `text` | `text` for writing/code/prose, `visual` for websites/HTML |
| `--count` | `50` | Number of samples to generate |
| `--concurrency` | `5` | Parallel pi calls |
| `--model` | pi default | Model to use (passed through to `pi --model`) |
| `--thinking` | pi default | Thinking level: off, minimal, low, medium, high, xhigh |
| `--timeout` | `600` | Seconds per pi call |
| `--analysis-timeout` | `1800` | Seconds for the analysis pass |
| `--retries` | `1` | Retries per failed call |
| `--output` | `./unslop-output` | Where to put results |
| `--skip-comparison` | `false` | Skip the before/after step |

## Output

Results land in `./unslop-output/`:

```
unslop-output/
  skill.md          ← the reusable avoidance profile (main deliverable)
  analysis.md       ← detailed pattern analysis with counts
  prompts.json      ← generated prompt set
  samples/          ← raw AI outputs
  screenshots/      ← rendered pages (visual only)
  before-after/     ← vanilla vs. profile-guided comparison
```

## Prebuilt Profiles

Ready-to-use profiles are in `SKILL_DIR/profiles/`:

- `profiles/react-design.md` — anti-patterns for React/SaaS landing pages
- `profiles/writing.md` — anti-patterns for blog writing, essays, articles

These can be used immediately as pi skills or system prompt additions without running the full analysis.

## Workflow

1. **Generate prompts** — creates diverse, realistic prompts for the domain
2. **Run samples** — generates outputs in parallel via `pi -p`
3. **Render screenshots** — captures page renders (visual only, needs Playwright)
4. **Analyze patterns** — pi reads all samples and identifies repeated patterns
5. **Generate skill file** — produces `skill.md` with specific avoidance instructions
6. **Before/after comparison** — runs the same prompt with and without the profile

## Using the Output

The generated `skill.md` can be used as:
- A pi skill (copy into your skills directory)
- Prepended to any system prompt
- Added to project context files (AGENTS.md, etc.)

## Review Checklist

After running, verify:
- `analysis.md` is concrete, counted, and specific (not vague)
- `skill.md` mostly says what to **avoid**, not prescribing one new stock style
- For visual runs, `before-after/after.html` feels meaningfully less generic than `before.html`
- If the analysis is thin, rerun with more samples or a higher thinking level
