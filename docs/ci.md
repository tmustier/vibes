# CI checks

The `startup` workflow runs portable checks and macOS integration checks in parallel.
Both test jobs use macOS because the locked dependency tree includes a macOS-only
Computer Use package. No dependencies are removed or bypassed to run on another OS.

The portable job installs the locked development dependencies once, then checks types,
extensions, configuration, publication privacy and the home updater. The macOS job
installs the pinned Pi at its publication cutoff, checks startup and feature selection
with production dependencies, then adds development dependencies for integration tests.

`tests/ci.py` runs up to four independent commands at once. Each has its own process and
log, so tests that patch process globals stay isolated. Every failure is reported before
the suite exits. Add checks to the appropriate suite and keep the public-release,
Granola compatibility and home-updater tests.

The final `startup` job preserves the required check name and succeeds only when both
suites succeed. A failed, cancelled or skipped suite cannot produce a green gate.
