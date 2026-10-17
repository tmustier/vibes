# Anthropic request gzip

Compresses large JSON POSTs to `https://api.anthropic.com/v1/messages` to reduce upload size, not token usage. Vibes enables it by default (agent default, not requested).

Only unencoded string bodies of at least 4,096 characters are compressed (agent default, matching Claude Code). Other endpoints and body formats pass through unchanged. Encoding rejections trigger one uncompressed retry and disable compression until reload.

The extension wraps standard `fetch`, leaving authentication, providers and response streams unchanged. It works with `pi-oauth` and fast mode; custom transports that bypass standard fetch also bypass compression. SDK hosts must emit `session_shutdown` to release it.

## Disable

Set this in `~/.pi/agent/vibes.json`, then reload:

```json
{ "features": { "anthropic-gzip": false } }
```

## Test

From the repository root:

```bash
npm run typecheck
npm run test:anthropic-gzip
```

For standalone use: `pi -e /absolute/path/to/packages/pi-anthropic-gzip`.
