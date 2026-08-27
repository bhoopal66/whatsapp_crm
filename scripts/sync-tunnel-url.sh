#!/usr/bin/env bash
#
# Re-point this deployment at the Cloudflare quick tunnel's CURRENT
# hostname, then rebuild and restart.
#
# Why this exists
# ---------------
# A Cloudflare *quick* tunnel gets a brand-new hostname every time
# cloudflared restarts. Two things then go stale at once:
#
#   1. NEXT_PUBLIC_SITE_URL. Next.js inlines NEXT_PUBLIC_* into the
#      client bundle AT BUILD TIME, so editing .env.local alone changes
#      nothing — the old host stays baked into the JS until a rebuild.
#
#   2. The callback URL registered on the Whapi channel, which still
#      points at the dead hostname.
#
# This script fixes (1). Fixing (2) needs the channel token, so it is
# left to a human: open Settings -> WhatsApp and press "Save & connect".
#
# The failure this prevents is a quiet one: outbound messages keep
# working perfectly while nothing a customer writes ever arrives.
#
# For an unattended deployment, use a NAMED tunnel or your own domain
# instead — then the hostname is stable and this script is unnecessary.
#
# Related: run cloudflared with `--protocol http2`. Its QUIC default is
# dropped by many networks, which makes the tunnel flap and eventually
# lose its DNS record — a failure that looks like this script's job but
# isn't.
#
# Usage:  sudo bash scripts/sync-tunnel-url.sh
set -euo pipefail

APP_DIR="/home/ubuntu/wacrm"
TUNNEL_LOG="/var/log/wacrm-tunnel.log"
ENV_FILE="$APP_DIR/.env.local"

command -v node >/dev/null || { echo "node not on PATH" >&2; exit 1; }

if [[ ! -f "$TUNNEL_LOG" ]]; then
  echo "No tunnel log at $TUNNEL_LOG — is wacrm-tunnel.service running?" >&2
  exit 1
fi

# The banner is printed once at startup, so the LAST match is current.
URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" | tail -1 || true)"
if [[ -z "$URL" ]]; then
  echo "Could not find a trycloudflare.com URL in $TUNNEL_LOG." >&2
  echo "Check: systemctl status wacrm-tunnel" >&2
  exit 1
fi

CURRENT="$(grep -E '^NEXT_PUBLIC_SITE_URL=' "$ENV_FILE" | cut -d= -f2- || true)"
if [[ "$CURRENT" == "$URL" ]]; then
  echo "Already pointing at $URL — nothing to do."
  exit 0
fi

echo "Tunnel hostname changed:"
echo "  was: ${CURRENT:-<unset>}"
echo "  now: $URL"

sed -i "s#^NEXT_PUBLIC_SITE_URL=.*#NEXT_PUBLIC_SITE_URL=$URL#" "$ENV_FILE"

echo "Rebuilding (NEXT_PUBLIC_SITE_URL is inlined at build time)…"
cd "$APP_DIR"
NODE_OPTIONS="--max-old-space-size=1536" npm run build

# `output: standalone` emits a self-contained server that does NOT
# include the static assets or public/ — they have to be placed beside
# it or every page loads without CSS.
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

systemctl restart wacrm
sleep 4
systemctl is-active --quiet wacrm && echo "wacrm restarted." || {
  echo "wacrm failed to restart — see /var/log/wacrm.log" >&2
  exit 1
}

cat <<EOF

Done. This deployment is now $URL

ONE MANUAL STEP REMAINS: the Whapi channel still points its webhook at
the old hostname. Open $URL/settings -> WhatsApp and press
"Save & connect" to re-register it. Until you do, outbound messages
send fine and inbound ones never arrive.
EOF
