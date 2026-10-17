---
name: visual-verify
description: Verify visual changes by screenshotting rendered output and reviewing it before claiming done. Use after any change to visual output (HTML, CSS, JSX/TSX, PDF generation, email templates, one-pagers). Also use when the user asks "does this look right?", wants a design review, or provides a reference to compare against. Do NOT use for backend-only, config, or non-rendered file changes.
---

# Visual Verify

You cannot evaluate visual changes by reading code. You must screenshot the rendered output and look at it.

## When this applies

After completing any change to files that produce visual output:
- CSS, HTML, JSX, TSX, Vue, Svelte, Astro files
- Tailwind classes, style objects, design tokens
- Email templates, PDF generation code
- Standalone HTML assets (one-pagers, presentations)

Also when the user asks: "does this look right?", "review the UI", "check this page", or provides a reference image to match.

Does NOT apply to: backend logic, config files, scripts, tests, markdown, AGENTS.md.

## Capture

Load the `surf` skill, then create one unfocused Chrome window for this verification and record the returned window and tab IDs as `WIN` and `TAB`:

```bash
surf window.new "<url>" --unfocused
# Output: Window <WIN> (tab <TAB>)
```

Pass both `--window-id "$WIN"` and `--tab-id "$TAB"` on every later page command. Never target the user's active tab. Close only this window when verification finishes.

### What to screenshot

Take **two screenshots** — one for detail, one for context:

1. **Element screenshot** — the specific thing that changed. Higher effective resolution because it is smaller than the whole viewport.
   ```bash
   surf --window-id "$WIN" --tab-id "$TAB" screenshot --selector ".review-tab-table" --output /tmp/vv-element.png
   ```

2. **Full viewport screenshot** — the whole page at the working viewport. Shows layout relationships.
   ```bash
   surf --window-id "$WIN" --tab-id "$TAB" screenshot --output /tmp/vv-full.png
   ```

Read both with the Read tool to analyze them.

### How to capture

```bash
# 1. Set viewport (1440x900 default, adjust if you know the user's setup)
surf --window-id "$WIN" --tab-id "$TAB" emulate.viewport --width 1440 --height 900

# 2. Wait for the page
surf --window-id "$WIN" --tab-id "$TAB" wait.network

# 3. Element screenshot (the changed thing)
surf --window-id "$WIN" --tab-id "$TAB" screenshot --selector "<css-selector>" --output /tmp/vv-element.png

# 4. Full viewport screenshot
surf --window-id "$WIN" --tab-id "$TAB" screenshot --output /tmp/vv-full.png
```

If the change is inside a **modal or dialog**, open it first before screenshotting. If the change is inside an **iframe** (common for email rendering), switch to that frame before capturing it.

### When you cannot determine the URL

For standalone HTML files not served by a development server, open the absolute `file://` URL in the Surf window. If Chrome has not granted Surf access to file URLs, serve the directory locally instead.

For changes where you do not know which page to check, ask.

### Annotated screenshots

For complex pages with many interactive elements, use `--annotate` to label elements with numbered references:
```bash
surf --window-id "$WIN" --tab-id "$TAB" screenshot --annotate --output /tmp/vv-annotated.png
```
This overlays labels on interactive elements and prints a legend. Use it to verify that expected controls are present and visible.

## Review

After capturing, Read the screenshots and evaluate. There are two review modes.

### Self-verify (after your own changes)

Check in this priority order — calibrated to the most common real-world visual bugs:

**1. Rendering correctness** — does it render at all?
- Content visible? Not blank, not raw HTML source, not escaped characters (`\n` showing as literal text)?
- Images loading? Not broken image icons or empty boxes?
- Text wrapping within containers? Not overflowing or clipped?
- Fonts loaded? Not falling back to Times New Roman or system sans-serif?
- Content inside iframes rendering? (check the iframe content, not just the container)

**2. Layout integrity** — does the structure hold?
- Changed element looks as intended?
- No unexpected overflow, truncation, or wrapping?
- Spacing consistent with surrounding elements?
- No elements pushed off-screen, overlapping, or misaligned?
- Column widths, row heights, grid alignment intact?

**3. Consistency with surroundings** — does it fit the page?
- Colors, fonts, border-radius consistent with adjacent components?
- Spacing rhythm consistent (not 24px gap next to an 8px gap)?
- Interactive elements (buttons, links) styled consistently?

**4. Unintended side effects** — did you break something else?
- Check the full viewport screenshot for anything that looks wrong outside the changed area.
- Scroll down if the change could affect below-the-fold content.

After checking, apply the **"actually" test**: If the person who requested this change saw this screenshot right now, would they say "actually..." and correct something? What would that correction be? If you can anticipate a likely correction, fix it proactively.

#### Self-verify output

If everything passes:
```
✅ Visual verify passed: [what was changed]
- [1-2 sentence summary of what you confirmed]
```

If issues found — fix them, then re-verify. Don't report issues to the user if you can fix them yourself. Only report if you're unsure about the intended behavior.

### QA review (user-invoked, or full page review)

Run through all seven categories when the user explicitly asks for a review or when shipping a major feature:

1. **Layout & spacing** — spacing grid consistency, alignment, padding, container widths
2. **Typography** — hierarchy clarity, line length (45–75 chars), line height, font weight consistency
3. **Color & contrast** — readability, brand color consistency, meaning consistency (same color ≠ different meanings)
4. **Visual hierarchy** — eye flow, CTA prominence, information density, grouping
5. **Component quality** — button/input/card consistency, icon alignment, image aspect ratios
6. **Polish** — hover/focus states, loading/empty states, transitions
7. **Responsive** (if checking multiple viewports) — text readability on mobile, touch target size ≥44px, no horizontal scroll

#### QA review output

```
## Visual QA: [Page/Component Name]

**Overall:** [One sentence gut reaction]
**Score:** [X]/10

### 🔴 Critical (fix before shipping)
1. **[Category]:** [Specific issue with details]
   → Fix: [Actionable recommendation]

### 🟡 Should fix
1. **[Category]:** [Issue]
   → Fix: [Recommendation]

### 🟢 Minor polish
1. **[Category]:** [Issue]

### ✅ Working well
- [What's well-executed]
```

## Comparison

When the user provides a reference ("make it look like X", provides a screenshot, or points to a reference URL):

1. Navigate the owned Surf window to the reference and capture it:
   ```bash
   surf --window-id "$WIN" --tab-id "$TAB" navigate "<reference-url>"
   surf --window-id "$WIN" --tab-id "$TAB" wait.network
   surf --window-id "$WIN" --tab-id "$TAB" screenshot --output /tmp/vv-reference.png
   ```
   Or accept the user-provided image directly.

2. Screenshot the implementation at the same viewport size.

3. Read both images and compare systematically:
   - Layout structure (same arrangement of elements?)
   - Spacing and sizing (similar proportions?)
   - Typography (same font family, hierarchy, weights?)
   - Colors (same palette, same accent usage?)
   - Components (same style treatment — borders, shadows, radius?)
   - Content (anything missing or extra?)

4. Output a deviation list ordered by visual impact. Prefer semantic comparison by reading both images; use a project-provided pixel-diff tool only when exact pixel matching is a requirement.

## Context scan (required)

On every visual verify, run this context scan. It catches bugs that are invisible to screenshots alone.

```bash
surf --window-id "$WIN" --tab-id "$TAB" js "return JSON.stringify({
  fonts: Array.from(document.fonts).map(f => f.family + ' ' + f.weight).slice(0, 10),
  fontsLoaded: document.fonts.size,
  rootStyles: (() => {
    const s = getComputedStyle(document.documentElement);
    return { bg: s.backgroundColor, color: s.color, fontFamily: s.fontFamily };
  })(),
  brokenImages: Array.from(document.images).filter(i => !i.naturalWidth).map(i => i.src).slice(0, 10),
  interactiveStates: (() => {
    const rules = Array.from(document.styleSheets).flatMap(s => {
      try { return Array.from(s.cssRules) } catch(e) { return [] }
    });
    return {
      hover: rules.filter(r => r.selectorText && r.selectorText.includes(':hover')).map(r => r.selectorText).slice(0, 15),
      focus: rules.filter(r => r.selectorText && (r.selectorText.includes(':focus') || r.selectorText.includes(':focus-visible'))).map(r => r.selectorText).slice(0, 15)
    };
  })()
})"
```

Check the results:
- `fontsLoaded: 0` or empty fonts array → web fonts aren't loading
- `brokenImages` has entries → images with broken src paths
- `fontFamily` is "Times" or generic → CSS font stack is falling back
- `interactiveStates.hover` is empty but the page has buttons/links/table rows → hover states likely missing (regression or oversight)
- `interactiveStates.focus` is empty → keyboard accessibility gap

If the project has a `.visual-context.md` in its root, read it for project-specific standards. This file is optional.

## Viewport reference

| Name | Size | When |
|------|------|------|
| Desktop (default) | 1440×900 | Always — primary verify viewport |
| Laptop | 1280×800 | For demo rehearsal |
| Tablet | 768×1024 | QA review if responsive matters |
| Mobile | 375×812 | QA review if responsive matters |

For self-verify, use desktop only. For changes to tables or grids, also check at 1024×768 — column truncation bugs often only manifest at narrower widths. For QA review, add mobile. Only do all four when explicitly asked.

## PDF and static HTML assets

For one-pagers and HTML→PDF assets (a common workflow):

1. Screenshot the HTML in the browser first.
2. If the output is a PDF, navigate the owned Surf window to its absolute `file://` URL and capture it:
   ```bash
   surf --window-id "$WIN" --tab-id "$TAB" navigate "file:///path/to/output.pdf"
   surf --window-id "$WIN" --tab-id "$TAB" screenshot --output /tmp/vv-pdf.png
   ```
3. Compare the HTML render to the PDF render — fonts, spacing, and page breaks often differ between them.

## What not to do

- Don't skip verification because "the code change was small" — small CSS changes cause big visual bugs
- Don't report a verbose QA review for routine self-verification — keep it concise
- Don't screenshot at arbitrary viewports — use the viewport table above
- Don't verify non-visual changes (backend, config, markdown, tests)
- Don't ask the user "should I verify?" — just do it as part of completing the change
- Don't leave the verification window open; close only the owned window with `surf window.close "$WIN"`
