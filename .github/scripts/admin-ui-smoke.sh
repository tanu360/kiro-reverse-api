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

# The "UI not built" page answers 503, so -f fails on it.
curl -fsS -o "$tmp/index.html" "$base/admin/"
grep -q 'id="root"' "$tmp/index.html" || {
  echo "/admin/ is not the admin UI document" >&2
  exit 1
}

# Every script and stylesheet the document references is served.
assets="$(grep -o '/admin/assets/[^"]*' "$tmp/index.html" | sort -u)"
if [ -z "$assets" ]; then
  echo "/admin/ references no /admin/assets/ files" >&2
  exit 1
fi
for asset in $assets; do
  curl -fsS -o /dev/null "$base$asset"
done

# A deep link falls back to the SPA document.
curl -fsS -o "$tmp/deep.html" "$base/admin/accounts"
grep -q 'id="root"' "$tmp/deep.html"

echo "admin UI ok: $(echo "$assets" | wc -l | tr -d ' ') assets served from $base"
