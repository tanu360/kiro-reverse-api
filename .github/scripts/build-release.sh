#!/usr/bin/env bash
# Cross-compiles kiro-proxy for every release target and packages each one with its license
# files and README, then writes SHA256SUMS.txt. The release workflow runs this exact script, so a
# local run proves what CI will publish.
#
# Each target also gets the public-link helper, kiro-tunnel-<platform>.gz (helper/kiro-tunnel, its
# own Go module). The proxy downloads it only when its "Public link" switch goes on, and checks it
# against the helper's SHA-256, which this script builds into that platform's kiro-proxy. The
# helper needs a newer Go than the proxy: it builds with GOTOOLCHAIN=$TUNNEL_GOTOOLCHAIN, or the
# version its go.mod names, which the go command downloads when it is not installed.
#
# Usage: build-release.sh <out-dir>
#
# Build the admin UI first (cd ui && pnpm build): the binary embeds ui/dist. The script refuses to
# package a binary without it, unless ALLOW_MISSING_UI=1, which is for local compile checks only.
# Needs Go, GNU tar, gzip, zip, sha256sum and jq (a Linux host, as on the GitHub runner).
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
version="$(jq -r .version version.json)"
helper_go="go$(awk '$1 == "go" { print $2; exit }' helper/kiro-tunnel/go.mod)"
helper_toolchain="${TUNNEL_GOTOOLCHAIN:-$helper_go}"
targets=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64)

# Every archive entry gets the release commit's time, so two builds of one commit give the same
# archives and checksums.
epoch="$(git log -1 --format=%ct 2>/dev/null || date +%s)"

stage="$out/.stage"
trap 'rm -rf "$stage"' EXIT

for target in "${targets[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  # Plain platform names in place of GOOS/GOARCH: "darwin_amd64" told people little.
  case "$target" in
    darwin/arm64) platform=macos-apple-silicon ;;
    darwin/amd64) platform=macos-intel ;;
    */amd64) platform="$os-x64" ;;
    *) platform="$os-$arch" ;;
  esac
  name="kiro-proxy-$platform"
  bin=kiro-proxy
  [ "$os" = windows ] && bin=kiro-proxy.exe

  echo "building kiro-tunnel-$platform"
  helper="$stage/kiro-tunnel-$platform"
  (cd helper/kiro-tunnel && GOTOOLCHAIN="$helper_toolchain" GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w -X main.version=$version" -o "$helper" .)
  helper_sum="$(sha256sum "$helper" | cut -d' ' -f1)"
  # gzip -n leaves out the name and time, so the asset's checksum depends on the bytes only.
  gzip -9n <"$helper" >"$out/kiro-tunnel-$platform.gz"

  echo "building $name"
  mkdir -p "$stage/$name"
  # Same build as the Docker image (CGO_ENABLED=0, version from config.Version), minus debug
  # symbols and local paths, plus the checksum of this platform's helper.
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w -X kiro-proxy/tunnel.helperSHA256=$helper_sum" -o "$stage/$name/$bin" .
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

(cd "$out" && sha256sum kiro-proxy-* kiro-tunnel-* >SHA256SUMS.txt)

echo
echo "release assets in $out:"
(cd "$out" && ls -l kiro-proxy-* kiro-tunnel-* SHA256SUMS.txt)
