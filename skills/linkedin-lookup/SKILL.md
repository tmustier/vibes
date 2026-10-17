---
name: linkedin-lookup
description: Look up people and companies on LinkedIn. Use when the user asks to research a person, look someone up, find out what someone does, check a LinkedIn profile, prep for a call, or needs professional background on a person or company.
---

# LinkedIn lookup

Use the `linkedin` MCP server ([stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server)). It browses LinkedIn as the user, with their own logged-in account.

## Setup

If the `linkedin` server is missing from `pi mcp list`, set it up:

```bash
uvx patchright install chromium
uvx linkedin-scraper-mcp --login
```

Then run `pi mcp add linkedin -- uvx linkedin-scraper-mcp` (or add the same entry under `mcpServers` in `~/.pi/agent/mcp.json`, keeping other entries). Run `pi mcp list` and reload Pi to connect.

## Use

- People: `search_people` to find someone, then `get_person_profile`.
- Companies: `search_companies`, `get_company_profile`, `get_company_posts`, `get_company_employees`.
- Posts and jobs: `search_posts`, `search_jobs`, `get_job_details`.
- Call `close_session` when finished.

With Pi's default MCP exposure, use `codemode`: discover tools with `searchTools("linkedin profile")`, inspect a schema with `describeTool("mcp__linkedin__get_person_profile")`, then call `await tools.mcp__linkedin__get_person_profile(args)` and `text()` the relevant result. Direct calls use names such as `mcp__linkedin__search_people` when that tool is exposed directly.

## Rules

- This is the user's personal LinkedIn account. Look up specific people and companies on request; never bulk-scrape.
- Check the user's existing contact records and meeting notes first when available.
- `send_message` and `connect_with_person` act as the user. Use them only when the user explicitly asks to send that exact message or connection request.
