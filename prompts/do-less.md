---
description: "Simplify recent work: cut defensiveness, verbosity, gross code and fake tests"
argument-hint: "[text]"
---
$ARGUMENTS
Review and simplify this for excessive defensiveness, verbosity and gross code. Reduce code without golfing.

Reduce complexity:
- Make impossible states unrepresentable in types and data shapes
- Keep types narrow: parse outside input once at the boundary, don't widen to unknown/any/broad records, remove casts you can't justify
- Ensure deep modules: prefer one small interface over many shallow helpers. Co-optimise multi-consumer functions with their callers. Inline every function used only once and tighten its former call sites.

Remove:
- Checks for impossible states; replace complex error handling with plain asserts. You can selectively keep guards before irreversible actions.
- Stale or redundant code

Improve code style:
- Make code clearer rather than adding comments
- Reduce nesting by merging and inverting conditionals

Tests:
- Test through the public interface, not the implementation
- Delete tests that could not fail against a real bug: ones that restate a constant or the implementation, read source text, or mock away the behaviour under test
- Delete tests for states that cannot happen

Finish by listing what you changed and, only if relevant, a finding worth turning into a lint rule or check.
