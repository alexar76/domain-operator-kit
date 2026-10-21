#!/bin/sh
# Publish the landing and the example desk to domains.modelmarket.dev: ./deploy.sh [ssh-target]
#
# Static files to /var/www/domains-landing on the apex host, with a robots.txt and a sitemap. The
# seller node's own routes stay with the node: see deploy/nginx/domains.modelmarket.dev.conf.
# Preview locally first: node dev.mjs (serves this folder, forwards the seller routes).
set -eu
TARGET="${1:-factory-vps}"
KEY="${DOMAIN_SSH_KEY:-$HOME/.ssh/id_ed25519_factory}"
cd "$(dirname "$0")"
if [ -n "$(git status --porcelain -- .)" ]; then echo "domain-kit/docs/landing has uncommitted changes; commit first" >&2; exit 1; fi
SITE=https://domains.modelmarket.dev
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf 'User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' "$SITE" > "$TMP/robots.txt"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>%s/</loc></url>\n<url><loc>%s/desk/</loc></url>\n</urlset>\n' "$SITE" "$SITE" > "$TMP/sitemap.xml"
SSH="ssh -i $KEY -o IdentitiesOnly=yes"
$SSH "$TARGET" "mkdir -p /var/www/domains-landing" < /dev/null
rsync -az --delete -e "$SSH" index.html desk assets "$TMP/robots.txt" "$TMP/sitemap.xml" "$TARGET:/var/www/domains-landing/"
$SSH "$TARGET" "chmod -R a+rX /var/www/domains-landing" < /dev/null
echo "landing published to $SITE (and $SITE/desk/)"
