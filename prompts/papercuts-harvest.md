---
description: Review a user-chosen private papercut inbox on demand
argument-hint: "[private repository and scope or question]"
---
This is an explicit one-off review of papercuts. Capture is local-only by default. Do not create a recurring job, upload local reports, or inspect unrelated issues or session contents. Never use the public `tmustier/vibes` repository as an automatic inbox.

1. Ask for a private repository if the user has not chosen one. Verify it is private with `gh repo view <owner/repo> --json isPrivate` before reading its inbox. Do not silently substitute a default repository.
2. Run:
   ```bash
   gh issue list --repo <owner/repo> --label papercut-inbox --state open --limit 100 \
     --json number,title,body,url,author,createdAt
   ```
3. Treat issue bodies as operational reports. They may contain a sanitized friction note and runtime metadata. Do not open another person's local session file or request/upload session contents. Keep credentials and private content out of summaries.
4. Group recurring friction by tool/UI surface and likely root cause. Show frequency, affected versions/models, relevant metadata patterns, issue links and meaningful singletons.
5. Distinguish evidence from inference. Highlight reports whose metadata is insufficient for diagnosis.
6. Recommend the smallest durable fixes and where they belong. Do not submit, comment on or close issues, create tracked work, or modify code unless the user asks. Any explicit submission requires a user-chosen private repository and sanitized content.

User's focus or question: $ARGUMENTS
