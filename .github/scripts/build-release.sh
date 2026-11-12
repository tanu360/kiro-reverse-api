#!/usr/bin/env bash
# Cross-compiles kiro-proxy for every release target and packages each one with its license
# files and README, then writes SHA256SUMS.txt. The release workflow runs this exact script, so a
# local run proves what CI will publish.
#
# Usage: build-release.sh <out-dir>
#
# Build the admin UI first (cd ui && pnpm build): the binary embeds ui/dist. The script refuses to
# package a binary without it, unless ALLOW_MISSING_UI=1, which is for local compile checks only.
# Needs Go, GNU tar, gzip, zip and sha256sum (a Linux host, as on the GitHub runner).
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi

mkdir -p "$1"
out="$(cd "$1" && pwd)"
# Never clear a caller's directory: an old archive left in it would end up in the checksums.
if [ -n "$(ls -A "$out")" ]; then
  echo "$out is not empty; give an empty or new directory" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."

if [ ! -f ui/dist/index.html ] && [ "${ALLOW_MISSING_UI:-}" != 1 ]; then
  echo "ui/dist/index.html is missing: build the admin UI first (cd ui && pnpm build)" >&2
  exit 1
fi

docs=(LICENSE THIRD_PARTY_NOTICES.md README.md)
targets=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64)

# Every archive entry gets the release commit's time, so two builds of one commit give the same
# archives and checksums.
epoch="$(git log -1 --format=%ct 2>/dev/null || date +%s)"

stage="$out/.stage"
trap 'rm -rf "$stage"' EXIT

for target in "${targets[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  name="kiro-proxy_${os}_${arch}"
  bin=kiro-proxy
  [ "$os" = windows ] && bin=kiro-proxy.exe

  echo "building $name"
  mkdir -p "$stage/$name"
  # Same build as the Docker image (CGO_ENABLED=0, version from config.Version), minus debug
  # symbols and local paths.
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$stage/$name/$bin" .
  cp "${docs[@]}" "$stage/$name/"
  chmod 0755 "$stage/$name" "$stage/$name/$bin"
  chmod 0644 "${docs[@]/#/$stage/$name/}"
  touch -d "@$epoch" "$stage/$name" "$stage/$name"/*

  # One top-level folder per archive, so extracting it never scatters files into the current
  # directory.
  if [ "$os" = windows ]; then
    (cd "$stage" && find "$name" | LC_ALL=C sort | TZ=UTC zip -q -X -@ "$out/$name.zip")
  else
    tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" \
      -cf - "$name" | gzip -9n >"$out/$name.tar.gz"
  fi
done

(cd "$out" && sha256sum kiro-proxy_* >SHA256SUMS.txt)

echo
echo "release assets in $out:"
(cd "$out" && ls -l kiro-proxy_* SHA256SUMS.txt)
