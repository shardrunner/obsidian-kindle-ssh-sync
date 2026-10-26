#!/usr/bin/env bash
# Recreate the private oracle fixtures from this plugin's own raw cache.
# See test/fixtures/README.md for what these are and why they are not
# committed. Replacing the fixture changes the measured counts the oracle
# tests pin; re-measure them rather than loosening the assertions.
set -euo pipefail

SRC_CACHE="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/kindle-ssh-sync}"
for p in cc.db vocab.db documents thumbnails; do
	[[ -e "$SRC_CACHE/$p" ]] || { echo "missing: $SRC_CACHE/$p (sync from the device first)" >&2; exit 1; }
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX="$ROOT/test/fixtures"
mkdir -p "$FIX"

echo "==> cache/ (live view only, from $SRC_CACHE)"
rm -rf "$FIX/cache"
mkdir -p "$FIX/cache"
for p in cc.db vocab.db fmcache.db archive.json documents thumbnails; do
	[[ -e "$SRC_CACHE/$p" ]] && cp -r "$SRC_CACHE/$p" "$FIX/cache/$p"
done

echo "==> ssh/host_ed25519"
if [[ ! -f "$FIX/ssh/host_ed25519" ]]; then
	mkdir -p "$FIX/ssh"
	ssh-keygen -t ed25519 -N "" -q -C "kindle-ssh-sync test host key" \
		-f "$FIX/ssh/host_ed25519"
fi

echo "==> pull.tar (device path layout, GNU format for LongName coverage)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/var/local" "$STAGE/mnt/us/system/vocabulary" "$STAGE/mnt/us/system"
cp "$FIX/cache/cc.db"                "$STAGE/var/local/cc.db"
cp "$FIX/cache/vocab.db"             "$STAGE/mnt/us/system/vocabulary/vocab.db"
cp -r "$FIX/cache/documents"         "$STAGE/mnt/us/documents"
cp -r "$FIX/cache/thumbnails"        "$STAGE/mnt/us/system/thumbnails"

# --format=gnu is required: these paths exceed ustar's 100-byte name field, so
# the majority of members must arrive as GNU LongName pseudo-entries. That is
# precisely the path src/device/tar.ts has to get right.
tar --format=gnu -cf "$FIX/pull.tar" -C "$STAGE" \
	var/local/cc.db \
	mnt/us/system/vocabulary/vocab.db \
	mnt/us/system/thumbnails \
	mnt/us/documents

echo "==> golden.json"
(cd "$ROOT" && npm run --silent fixtures:golden)

echo
echo "fixtures ready in $FIX"
du -sh "$FIX"
echo "run: npm run test:oracle"
