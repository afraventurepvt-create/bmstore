# DNS runbook — `store.bmtechx.in`

Applies to any provider (GoDaddy, Namecheap, Hostinger, Cloudflare, BigRock…). Log in → DNS management
for `bmtechx.in`. Replace `SERVER_IP` with the VPS IPv4.

## 1. Platform records (one time)

| Type | Host / Name | Value | TTL |
|------|-------------|-------|-----|
| A | `store` | `SERVER_IP` | 300 (5 min) |
| A | `*.store` | `SERVER_IP` | 300 |
| AAAA | `store` / `*.store` | server IPv6 (only if the VPS has one and ufw allows it) | 300 |

How the host field is written differs per provider: some want `store`, others the full `store.bmtechx.in`.
The wildcard row is literally an asterisk: `*.store`. Both are needed: the first serves `store.bmtechx.in`, the
wildcard serves every `<anything>.store.bmtechx.in` (`api.`, `admin.`, `console.`, `media.`, `minio.` and every tenant).

If the zone is on **Cloudflare**: create the records with the cloud icon **grey (DNS only)** — Caddy must receive the
TLS handshake itself to issue certificates. (Orange/proxied can be enabled later per record once you understand
Cloudflare's "Full (strict)" mode; on-demand certificates for tenant hosts need DNS-only.)

Do **not** create records for individual tenants; the wildcard covers them.

### Verify
```bash
dig +short store.bmtechx.in
```
```bash
dig +short demo.store.bmtechx.in api.store.bmtechx.in
```
All print `SERVER_IP`. Without `dig`: https://dnschecker.org → type the name → every location shows `SERVER_IP`.
Propagation: 5–60 minutes normally; up to 48 h if the old record had a long TTL.

Then, once the stack is deployed:
```bash
curl -i https://api.store.bmtechx.in/health
```
`HTTP/2 200` and `{"ok":true,"tenant":null}`.

## 2. A client points their own domain (CNAME)

The client owns `client.com` and wants their store on `shop.client.com`.

1. **Client, at their DNS provider**, adds:

   | Type | Host | Value |
   |------|------|-------|
   | CNAME | `shop` | `store.bmtechx.in` |

   The value is the **platform root**, not the server IP, so the server can move later without touching clients.
   On Cloudflare: grey cloud (DNS only).

2. **You, as superadmin**, make sure the tenant row carries that host. In Phase 1 the custom domain is set when
   the tenant is **created** (`POST /superadmin/tenants` with `"customDomain": "shop.client.com"` — exactly the host
   the browser will use, lower-case, no `https://`). There is no update endpoint yet; for an existing tenant use the
   SQL stopgap below (as the owner role) until Phase 2 adds `PATCH /superadmin/tenants/:id`:
   ```bash
   ./deploy/compose.sh exec postgres psql -U bmstore -d bmstore -c "update tenants set custom_domain = 'shop.client.com' where slug = 'their-slug'"
   ```
   ```bash
   ./deploy/compose.sh exec redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning del tenant:host:shop.client.com
   ```
   (The second command drops the 60-second negative cache so the first visit resolves immediately.)
   The API resolves custom domains by exact Host match — `www.shop.client.com` is a different host.

3. **First visit issues the certificate**: open `https://shop.client.com`. Caddy asks `tls-ask`, which asks the API
   whether `shop.client.com` is a tenant; it is, so a Let's Encrypt certificate is issued in ~2–5 s and cached.

### Verify
```bash
dig +short CNAME shop.client.com
```
→ `store.bmtechx.in.`
```bash
curl -i https://shop.client.com/api/health
```
→ `200` and `"tenant":"<their slug>"`.
```bash
./deploy/compose.sh logs tls-ask | grep shop.client.com
```
→ a line with `"decision":"allow"`. A `deny` with `unknown-host` means the custom domain is not saved on the tenant
(or the tenant cache — up to 5 min — has not refreshed; wait or restart `api`).

### Apex / root domains (`client.com` without `www`)
Most registrars cannot CNAME an apex. Options, in order of preference:
1. Use `shop.client.com` or `www.client.com` and have the registrar's "domain forwarding" redirect `client.com` → it.
2. Providers with ALIAS/ANAME/"CNAME flattening" (Cloudflare, DNSimple, Namecheap "ALIAS"): `ALIAS @ → store.bmtechx.in`.
3. Last resort: `A @ → SERVER_IP` (document it: it must be changed if the server IP changes).

## 3. Email records are untouched
Nothing here affects `bmtechx.in` mail (MX/SPF/DKIM) — only the `store` sub-tree is used.

## 4. Changing the server IP later
Change the two A records (platform) — clients' CNAMEs keep working. Let's Encrypt certificates are stored in the
`caddy_data` volume; copy it to the new server (`docker run --rm -v bmstore_caddy_data:/d -v $PWD:/b alpine tar czf /b/caddy_data.tgz -C /d .`)
to avoid re-issuing everything at once and hitting rate limits (50 certificates per registered domain per week).
