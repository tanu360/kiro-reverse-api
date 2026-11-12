#!/usr/bin/env sh
# Checks that a running Kiro Proxy serves the embedded admin UI, not the "UI not built" page.
# Usage: admin-ui-smoke.sh [base-url]   (default http://127.0.0.1:8080)
set -eu

base="${1:-http://127.0.0.1:8080}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Wait up to 30 s for the server to answer.
i=0
until curl -fs -o /dev/null "$base/health"; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "server did not answer $base/health" >&2
    exit 1
  fi
  sleep 1
done

# The app is served at the root, but only to a client that asks for HTML, as a browser does: a
# plain probe of / gets the health JSON. The "UI not built" page answers 503, so -f fails on it.
html="Accept: text/html"
curl -fsS -H "$html" -o "$tmp/index.html" "$base/"
grep -q 'id="root"' "$tmp/index.html" || {
  echo "/ is not the admin UI document" >&2
  exit 1
}

# Every script and stylesheet the document references is served.
assets="$(grep -o '"/assets/[^"]*' "$tmp/index.html" | tr -d '"' | sort -u)"
if [ -z "$assets" ]; then
  echo "/ references no /assets/ files" >&2
  exit 1
fi
for asset in $assets; do
  curl -fsS -o /dev/null "$base$asset"
done

# A deep link falls back to the SPA document.
curl -fsS -H "$html" -o "$tmp/deep.html" "$base/accounts"
grep -q 'id="root"' "$tmp/deep.html"

# An old /admin/ page link moves to the same page at the root.
location="$(curl -fsS -o /dev/null -w '%{redirect_url}' -H "$html" "$base/admin/accounts")"
[ "$location" = "$base/accounts" ] || {
  echo "/admin/accounts redirects to '$location', not $base/accounts" >&2
  exit 1
}

echo "admin UI ok: $(echo "$assets" | wc -l | tr -d ' ') assets served from $base"
