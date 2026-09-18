#!/bin/sh
# Build the native xcb (Excalibur) CLI from source and emit a packaged
# tarball plus a SHA-256 checksum. The tarball name includes the version,
# OS, and architecture so the install script can fetch exact release assets.
set -eu

: "${CARGO:=cargo}"
root="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${XCB_VERSION:-}" ]; then
  version="${XCB_VERSION#v}"
else
  version=$(grep -m1 '^version = ' "$root/Cargo.toml" | sed 's/.*"\(.*\)".*/\1/')
  if [ -z "$version" ]; then
    echo "error: could not read version from workspace Cargo.toml" >&2
    exit 1
  fi
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

cd "$root"
"$CARGO" build --release --locked -p xcb-cli

binary="$root/target/release/xcb"
if [ ! -f "$binary" ]; then
  echo "error: expected $binary after build" >&2
  exit 1
fi

sha256_cmd=$(command -v sha256sum || command -v shasum || true)
if [ -z "$sha256_cmd" ]; then
  echo "error: neither sha256sum nor shasum found" >&2
  exit 1
fi
if [ "$sha256_cmd" != "${sha256_cmd%shasum}" ]; then
  sha256_cmd="$sha256_cmd -a 256"
fi

mkdir -p "$root/artifacts"
name="xcb-${version}-${os}-${arch}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
install -m 0755 "$binary" "$work/xcb"
tar -czf "$root/artifacts/${name}.tar.gz" -C "$work" xcb
$sha256_cmd "$root/artifacts/${name}.tar.gz" | sed 's/ .*//' > "$root/artifacts/${name}.tar.gz.sha256"
echo "tarball=$root/artifacts/${name}.tar.gz"
echo "sha256=$root/artifacts/${name}.tar.gz.sha256"
