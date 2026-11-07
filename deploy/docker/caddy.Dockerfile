# syntax=docker/dockerfile:1.7
# Caddy with the rate-limit module (and optionally a DNS provider module for wildcard certs).
#   CADDY_DNS_PLUGIN=""           -> on-demand TLS only (default)
#   CADDY_DNS_PLUGIN=cloudflare   -> also builds github.com/caddy-dns/cloudflare for Caddyfile.wildcard
ARG CADDY_VERSION=2.10
FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_DNS_PLUGIN=""
RUN set -eux; \
    extra=""; \
    if [ -n "$CADDY_DNS_PLUGIN" ]; then extra="--with github.com/caddy-dns/${CADDY_DNS_PLUGIN}"; fi; \
    xcaddy build \
      --with github.com/mholt/caddy-ratelimit \
      $extra

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# Caddyfile is bind-mounted at /etc/caddy/Caddyfile by compose.
