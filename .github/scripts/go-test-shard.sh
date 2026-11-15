#!/usr/bin/env bash
# Runs one shard of the module's Go tests: go-test-shard.sh INDEX COUNT (INDEX from 1).
#
# Every top-level test, fuzz seed and example name in the module is sorted and dealt round-robin
# into COUNT shards, and the shard runs `go test ./... -run '^(its names)$'`. A name belongs to one
# shard only, so each test of each package runs exactly once across the shards, with all its
# subtests and its package's TestMain. A new test needs no setup: the next run deals it in.
set -euo pipefail

index=${1:?usage: go-test-shard.sh INDEX COUNT}
count=${2:?usage: go-test-shard.sh INDEX COUNT}
if ! [[ "$index" =~ ^[1-9][0-9]*$ && "$count" =~ ^[1-9][0-9]*$ ]] || ((index > count)); then
  echo "go-test-shard.sh: want 1 <= INDEX <= COUNT, got $index of $count" >&2
  exit 2
fi

# `go test -list` prints each package's names, then an "ok" line; a build failure fails here.
names=$(go test -list '.*' ./... | grep -E '^(Test|Fuzz|Example)[A-Za-z0-9_]*$' | LC_ALL=C sort -u)
mine=$(awk -v i="$index" -v n="$count" '(NR - 1) % n == i - 1' <<<"$names" | paste -sd '|' -)
total=$(grep -c . <<<"$names" || true)
echo "shard $index/$count: $(grep -c . <<<"${mine//|/$'\n'}" || true) of $total test names"

if [ -z "$mine" ]; then
  echo "shard $index/$count has no tests"
  exit 0
fi
go test ./... -run "^($mine)\$"
