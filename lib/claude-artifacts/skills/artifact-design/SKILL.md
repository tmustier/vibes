---
name: artifact-design
description: Page contract and design guidance for Claude artifacts published from Pi. Load before writing any page for the Artifact tool, including a Markdown one.
---

# Artifact design

Claude Code's Artifact tool tells Claude to load this skill before writing a page. Claude Code ships its own version, which `claude mcp serve` does not provide, so this is Pi's.

## Start from a type when one fits

For a deck, a document other people will read, a visual design, a design system or a dashboard, call the Artifact tool with `action: "quickstart"` and the matching `intent` before writing anything. If it returns a type, publish with its `type_url` and a `title` and follow the instructions in the result. Write your own page only when no type fits.

## Page contract

- Author HTML. Publish Markdown only when a loaded skill asks for it.
- Give the page a `<title>` of two to four words. Put the explanation in the publish `description`, not the title.
- Pass an `icon` on the first publish: one emoji that says what the page is.
- Define colours as custom properties on `:root`. Redefine them under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`. Give `body` an explicit background.
- Load scripts only from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com or code.jquery.com, each with an exact version at least two weeks old. Load stylesheets only from Google Fonts. Inline everything else, or publish it through `files`.
- Make the layout work at phone width, with a 16px side gutter and no horizontal page scroll.
- Keep the page at 16 MB or less. Prefer SVG, HTML and CSS to embedded raster images, and summarise large data rather than inlining all of it.
- Use browser storage only for per-viewer conveniences, wrapped in `try`/`catch`. Shared or durable state needs a runtime capability (the `artifact-capabilities` skill).

## Design

Match the effort to the request. A quick explanation needs clear structure and readable type. A page people will share or reuse needs a deliberate palette, typography and layout. Use the project's own design system when it has one, and the user's instructions over both.

Lead with the answer or the main view. Label every number with what it measures and where it came from. Use headings and in-page anchors for long pages, because relative links do not resolve.

## Check before you share the link

Pi cannot see the page from the tool result. After publishing, open the artifact URL with the `visual-verify` skill, check it at desktop and phone width in light and dark mode, then fix and republish with the same file path.
