# Homebound WeChat Bridge

Cloud bridge for one private WeChat ClawBot conversation and one ChatGPT Work chat.

It uses:

- WeChat's official iLink/ClawBot QR login and long polling;
- ChatGPT Custom MCP with MCP Events (`2026-07-28`);
- a private, unguessable MCP URL instead of an API model key;
- encrypted on-disk storage for WeChat credentials and routing context.

No OpenAI model API key is used. ChatGPT remains the model and conversation surface; this service only transports messages.

## Flow

1. A private WeChat message reaches ClawBot.
2. The bridge queues it and sends a signed MCP Event to ChatGPT.
3. ChatGPT reads the exact queued message with `homebound_read_wechat_message`.
4. ChatGPT sends the completed answer back with `homebound_reply_wechat`.

Replies are ordered and idempotent. Text is the initial supported message type.

## Local development

Requires Node.js 22+.

```bash
npm ci
npm run typecheck
npm test
npm run build
MCP_AUTH_MODE=none npm run dev
```

Open the private setup path configured by `SETUP_PATH_TOKEN`, scan the WeChat QR code, and bind the first private message to the configured target alias.

## Required production configuration

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Enables production checks. |
| `HTTP_HOST=0.0.0.0` | Listens on the Render interface. |
| `HTTP_PORT=8080` | Web service port. |
| `DATA_DIR=/data` | Persistent credential and subscription storage. |
| `WEIXIN_ENCRYPTION_KEY` | Base64 32-byte key for encrypted WeChat state. |
| `MCP_EVENTS_PATH_TOKEN` | Random URL-safe token (20+ chars) used only in the private MCP URL. |
| `SETUP_PATH_TOKEN` | Separate random URL-safe token (20+ chars) used only in the setup URL. |
| `MCP_AUTH_MODE=token` | Protects the legacy admin API. |
| `MCP_ACCESS_TOKENS` | JSON map for the legacy admin API; never commit its value. |
| `MCP_ALLOWED_TARGETS=xuanxuan` | Stable alias for the bound private conversation. |
| `BOOTSTRAP_ENABLED=true` | Allows first-time target binding. |
| `TRUSTED_HOSTS=*` | Required behind Render's dynamic host in this single-tenant, secret-path deployment. |

For reliable 24/7 use on Render, attach a persistent disk at `/data` and use a service plan that does not spin down. A free service is suitable only for a smoke test: it can sleep and its filesystem is ephemeral.

## Private endpoints

- Setup page: `/setup/<SETUP_PATH_TOKEN>`
- ChatGPT Custom MCP: `/mcp/events/<MCP_EVENTS_PATH_TOKEN>`
- Health: `/health/live`

Never post either private URL publicly. Rotate the corresponding token if a URL is exposed.

## Attribution

The iLink gateway layer is derived from `sephymartin-lab/wechat-personal-gateway` (MIT). The MCP Events subscription and signed webhook design is adapted from `yanceydaisy/cove-wechat-relay` (Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
