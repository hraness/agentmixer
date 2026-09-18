#!/bin/sh
# Install the native xcb (Excalibur) CLI. When XCB_VERSION is set, the script
# downloads the matching release artifact and verifies its SHA-256 checksum.
# Otherwise it builds from the local source tree with Cargo.
set -eu

: "${XCB_INSTALL_PREFIX:=$HOME/.local}"
: "${CARGO:=cargo}"
: "${XCB_VERSION:=}"
: "${XCB_GITHUB:=hraness/xcb}"

bin_dir="$XCB_INSTALL_PREFIX/bin"
mkdir -p "$bin_dir"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

install_from_release() {
  tag="v$XCB_VERSION"
  asset="xcb-${XCB_VERSION}-${os}-${arch}.tar.gz"
  checksum="$asset.sha256"
  base_url="https://github.com/$XCB_GITHUB/releases/download/$tag"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fsSL -o "$work/$asset" "$base_url/$asset"
  curl -fsSL -o "$work/$checksum" "$base_url/$checksum"
  expected=$(tr -d '[:space:]' < "$work/$checksum")
  actual=$(sha256sum "$work/$asset" | cut -d' ' -f1)
  if [ "$expected" != "$actual" ]; then
    echo "error: checksum mismatch for $asset" >&2
    exit 1
  fi
  tar -xzf "$work/$asset" -C "$work"
  install -m 0755 "$work/xcb" "$bin_dir/xcb"
}

install_from_source() {
  root="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$root"
  "$CARGO" build --release --locked -p xcb-cli
  install -m 0755 "$root/target/release/xcb" "$bin_dir/xcb"
}

XCB_VERSION="${XCB_VERSION#v}"
if [ -n "$XCB_VERSION" ]; then
  install_from_release
else
  install_from_source
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    if [ "${XCB_ADD_PATH:-ask}" = "yes" ]; then
      printf '\nexport PATH="%s:$PATH"\n' "$bin_dir" >> "$HOME/.profile"
      echo "Added $bin_dir to PATH in $HOME/.profile"
    else
      echo "$bin_dir is not on PATH. Add it with:"
      echo "  export PATH=\"$bin_dir:\$PATH\""
    fi
    ;;
esac

echo "Installed $bin_dir/xcb"
"$bin_dir/xcb" --version
