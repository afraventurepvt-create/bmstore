# tls-ask

Tiny zero-dependency HTTP service that answers Caddy's on-demand TLS `ask` check
(`GET /ask?domain=<host>`). It approves (200) only hosts that resolve to an existing tenant,
by calling the API's `GET /health` with `Host: <domain>` (200 with a tenant slug, or 403 for a
suspended/expired tenant). Everything else is denied (403), so the server never requests
certificates for names it does not serve. Reserved platform sub-domains (`api`, `admin`,
`console`, `www`, `media`, `minio`, ...) are denied here because Caddy has explicit sites for them.

Local test (no Docker needed): `node test.js` starts a fake API and asserts the decisions.
