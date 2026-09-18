#!/bin/sh
# Install the native xcb (Excalibur) CLI from source. This is the private,
# user-owned install path. It never needs sudo; it writes to ~/.local by
# default and appends the directory to PATH only when the user approves.
set -eu

: "${XCB_INSTALL_PREFIX:=$HOME/.local}"
: "${CARGO:=cargo}"
root="$(cd "$(dirname "$0")/.." && pwd)"
bin_dir="$XCB_INSTALL_PREFIX/bin"

cd "$root"
"$CARGO" build --release --locked -p xcb-cli

mkdir -p "$bin_dir"
install -m 0755 "$root/target/release/xcb" "$bin_dir/xcb"

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
