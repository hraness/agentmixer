#!/bin/sh
# Build the native xcb (Excalibur) CLI from source and emit the binary path
# plus a SHA-256 checksum. This is the source-side of native packaging; the
# release workflow is responsible for publishing exact prebuilt artifacts.
set -eu

: "${CARGO:=cargo}"
root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$root"
"$CARGO" build --release --locked -p xcb-cli

binary="$root/target/release/xcb"
if [ ! -f "$binary" ]; then
  echo "error: expected $binary after build" >&2
  exit 1
fi

mkdir -p "$root/artifacts"
install -m 0755 "$binary" "$root/artifacts/xcb"
sha256sum "$root/artifacts/xcb" | sed 's/ .*//' > "$root/artifacts/xcb.sha256"
echo "binary=$root/artifacts/xcb"
echo "sha256=$root/artifacts/xcb.sha256"
