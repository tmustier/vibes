#!/usr/bin/env python3
"""Inline a static HTML page's local assets so it renders as ONE self-contained
file. Required for Claude Code artifacts: they run under a strict CSP that blocks
every relative/external request (images, CSS, JS, fonts), so anything not inlined
shows up blank/broken.

Usage:  inline-assets.py INPUT.html [OUTPUT.html]
Leaves INPUT untouched. Default OUTPUT: <stem>.selfcontained.html (same dir).

Inlines: <img>/<source>/<link>/<a> refs to local raster+svg images as data URIs,
local <link rel=stylesheet> and <script src> as inline tags, and url(...) refs
inside inline <style> and inlined CSS. Skips http(s)://, //, data:, #, mailto:.
srcset and @font-face files are NOT handled — inline those by hand if used.
"""
import base64, mimetypes, os, re, sys

IMG_EXT = r"png|jpe?g|gif|webp|svg|ico|avif|bmp"


def is_remote(u):
    return u.strip().lower().startswith(("http://", "https://", "//", "data:", "#", "mailto:"))


def data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: inline-assets.py INPUT.html [OUTPUT.html]")
    inp = sys.argv[1]
    base = os.path.dirname(os.path.abspath(inp))
    out = sys.argv[2] if len(sys.argv) > 2 else re.sub(r"\.html?$", "", inp) + ".selfcontained.html"
    html = open(inp, encoding="utf-8").read()
    missing = []

    def resolve(u, root):
        p = os.path.normpath(os.path.join(root, u.split("?")[0].split("#")[0]))
        return p if os.path.isfile(p) else None

    def inline_css(css, css_dir):
        def urlrepl(m):
            u = m.group(1).strip().strip("'\"")
            if is_remote(u):
                return m.group(0)
            p = resolve(u, css_dir)
            if not p:
                missing.append(u)
                return m.group(0)
            return f"url({data_uri(p)})"
        return re.sub(r"url\(([^)]+)\)", urlrepl, css)

    def linkrepl(m):
        href = m.group(1)
        if is_remote(href):
            return m.group(0)
        p = resolve(href, base)
        if not p:
            missing.append(href)
            return m.group(0)
        return "<style>\n" + inline_css(open(p, encoding="utf-8").read(), os.path.dirname(p)) + "\n</style>"

    # <link rel=stylesheet href=...> in either attribute order
    html = re.sub(r'<link\b[^>]*\brel=["\']?stylesheet["\']?[^>]*\bhref=["\']([^"\']+)["\'][^>]*>', linkrepl, html, flags=re.I)
    html = re.sub(r'<link\b[^>]*\bhref=["\']([^"\']+)["\'][^>]*\brel=["\']?stylesheet["\']?[^>]*>', linkrepl, html, flags=re.I)

    # url() inside inline <style>
    html = re.sub(r'(<style[^>]*>)(.*?)(</style>)', lambda m: m.group(1) + inline_css(m.group(2), base) + m.group(3), html, flags=re.I | re.S)

    # <script src=local.js></script>
    def scriptrepl(m):
        src = m.group(1)
        if is_remote(src):
            return m.group(0)
        p = resolve(src, base)
        if not p:
            missing.append(src)
            return m.group(0)
        return "<script>\n" + open(p, encoding="utf-8").read() + "\n</script>"
    html = re.sub(r'<script\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script>', scriptrepl, html, flags=re.I)

    # src=/href= to a local image file
    def srcrepl(m):
        attr, q, u = m.group(1), m.group(2), m.group(3)
        if is_remote(u):
            return m.group(0)
        p = resolve(u, base)
        if not p:
            missing.append(u)
            return m.group(0)
        return f"{attr}={q}{data_uri(p)}{q}"
    html = re.sub(r'\b(src|href)=(["\'])([^"\']+\.(?:' + IMG_EXT + r'))\2', srcrepl, html, flags=re.I)

    open(out, "w", encoding="utf-8").write(html)
    size = len(html.encode())
    print(f"wrote {out}  ({size/1048576:.2f} MiB)")
    if missing:
        print("WARNING missing/skipped refs:", sorted(set(missing)))
    if size > 16 * 1048576:
        print("WARNING: over 16 MiB native-artifact limit -> recompress images (downscale ~1400px, WebP q80)")
    elif size > 5 * 1048576:
        print("NOTE: over 5 MiB -> only the interactive native Artifact tool (<=16 MiB) accepts it; print-mode/DesignSync caps at 5 MiB")


if __name__ == "__main__":
    main()
