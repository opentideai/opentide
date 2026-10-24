#!/bin/sh
# Installs the opentide command.
#
#   curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh
#
# Needs curl, tar and unzip. Nothing else: OpenTide brings its own runtime and
# never uses one already on the machine. Everything goes under ~/.opentide:
#   versions/<version>/   the release
#   runtime/<name>/       the runtime it runs on, pinned by the release
#   bin/opentide          the launcher
#
# Environment:
#   OPENTIDE_INSTALL_VERSION   version to install (default: the latest release)
#   OPENTIDE_INSTALL_TARBALL   install from this local tarball instead of downloading
#   OPENTIDE_INSTALL_REPO      GitHub owner/repo to download from
#   OPENTIDE_HOME              where everything goes (default: ~/.opentide)
#   OPENTIDE_NO_MODIFY_PATH=1  don't add the launcher to your shell's PATH
set -eu

REPO="${OPENTIDE_INSTALL_REPO:-opentideai/opentide}"
OPENTIDE_HOME="${OPENTIDE_HOME:-$HOME/.opentide}"
VERSION="${OPENTIDE_INSTALL_VERSION:-}"
TARBALL="${OPENTIDE_INSTALL_TARBALL:-}"
RUNTIME_RELEASES="https://github.com/denoland/deno/releases/download"

fail() {
  echo "opentide install: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not on PATH."
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Downloads $1 to $2 and checks it against the sha256 published at $1.sha256
# or $1.sha256sum (first field).
fetch_verified() {
  curl -fsSL -o "$2" "$1" || fail "download failed: $1"
  sum="$(curl -fsSL "$1.sha256" 2>/dev/null || curl -fsSL "$1.sha256sum" 2>/dev/null)" ||
    fail "no checksum published for $1"
  [ "$(sha256 "$2")" = "$(echo "$sum" | cut -d ' ' -f 1)" ] ||
    fail "checksum mismatch for $1"
}

# The shell config file that puts $1 on PATH for new terminals, for the user's
# login shell. Empty for a shell we don't know.
shell_config() {
  case "$(basename "${SHELL:-}")" in
    zsh) echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bashrc" ] || [ "$(uname -s)" != Darwin ]; then
        echo "$HOME/.bashrc"
      else
        echo "$HOME/.bash_profile"
      fi
      ;;
    fish) echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/opentide.fish" ;;
  esac
}

# Adds $1 to PATH in the user's shell config, once.
add_to_path() {
  config="$(shell_config)"
  if [ -z "$config" ]; then
    echo "Add $1 to your PATH to run opentide."
    return
  fi
  if [ -f "$config" ] && grep -qF "$1" "$config"; then
    return
  fi
  mkdir -p "$(dirname "$config")"
  case "$config" in
    *.fish) line="fish_add_path \"$1\"" ;;
    *) line="export PATH=\"$1:\$PATH\"" ;;
  esac
  printf '\n# opentide\n%s\n' "$line" >>"$config"
  echo "Added $1 to your PATH in $config."
}

runtime_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo aarch64-apple-darwin ;;
    Darwin-x86_64) echo x86_64-apple-darwin ;;
    Linux-x86_64) echo x86_64-unknown-linux-gnu ;;
    Linux-aarch64 | Linux-arm64) echo aarch64-unknown-linux-gnu ;;
    *) fail "unsupported platform $(uname -s) $(uname -m). On Windows, use WSL." ;;
  esac
}

need curl
need tar
need unzip

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- The release ---
if [ -z "$TARBALL" ]; then
  if [ -z "$VERSION" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
      sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$VERSION" ] || fail "could not find the latest release of $REPO."
  fi
  echo "Downloading OpenTide $VERSION..."
  TARBALL="$work/opentide-$VERSION.tar.gz"
  fetch_verified \
    "https://github.com/$REPO/releases/download/v$VERSION/opentide-$VERSION.tar.gz" \
    "$TARBALL"
fi

[ -f "$TARBALL" ] || fail "no such tarball: $TARBALL"
tar -xzf "$TARBALL" -C "$work"
unpacked="$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'opentide-*' | head -n 1)"
[ -n "$unpacked" ] || fail "the tarball has no opentide-<version>/ directory."
VERSION="${unpacked##*/opentide-}"

dest="$OPENTIDE_HOME/versions/$VERSION"
rm -rf "$dest"
mkdir -p "$OPENTIDE_HOME/versions"
mv "$unpacked" "$dest"

# --- The runtime the release pins ---
runtime_version="$(tr -d ' \n' <"$dest/.deno-version")"
[ -n "$runtime_version" ] || fail "the release does not name its runtime version."
runtime_dir="$OPENTIDE_HOME/runtime/deno-$runtime_version"
runtime="$runtime_dir/deno"
if [ ! -x "$runtime" ]; then
  echo "Downloading the runtime..."
  target="$(runtime_target)"
  fetch_verified "$RUNTIME_RELEASES/v$runtime_version/deno-$target.zip" "$work/runtime.zip"
  mkdir -p "$runtime_dir"
  unzip -q -o "$work/runtime.zip" -d "$runtime_dir"
  chmod +x "$runtime"
fi
"$runtime" --version >/dev/null 2>&1 || fail "the runtime at $runtime does not run."

# The launcher gets the permissions of the `opentide` task in the release's
# deno.json, minus `--env`: an installed command must not load whatever .env
# sits in the directory it is run from.
flags="$("$runtime" eval --no-config '
  const task = JSON.parse(Deno.readTextFileSync(Deno.args[0])).tasks.opentide;
  const tokens = task.split(/\s+/).filter((t) => t.startsWith("--") && t !== "--env");
  console.log(tokens.join(" "));
' "$dest/deno.json")"
[ -n "$flags" ] || fail "no permission flags in the opentide task of $dest/deno.json."

echo "Downloading dependencies (once per version; this takes a minute)..."
log="$OPENTIDE_HOME/install.log"
"$runtime" cache --config "$dest/deno.json" --lock "$dest/deno.lock" \
  "$dest/cli/cli.ts" >"$log" 2>&1 ||
  fail "dependency download failed; see $log"

# --- The launcher ---
# It runs the release in place, against the lockfile it shipped with, on the
# runtime installed above. OPENTIDE_LAUNCHER lets a spawned server and the
# generated client configs call this launcher back.
bin_dir="$OPENTIDE_HOME/bin"
launcher="$bin_dir/opentide"
mkdir -p "$bin_dir"
cat >"$launcher" <<LAUNCHER
#!/bin/sh
# opentide $VERSION, written by install.sh
OPENTIDE_LAUNCHER="$launcher" exec "$runtime" run $flags \\
  --config "$dest/deno.json" --lock "$dest/deno.lock" \\
  "$dest/cli/cli.ts" "\$@"
LAUNCHER
chmod +x "$launcher"

installed="$("$launcher" --version 2>>"$log")" ||
  fail "the installed opentide does not run; see $log"
echo "Installed: $launcher ($installed)"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    if [ "${OPENTIDE_NO_MODIFY_PATH:-}" = 1 ]; then
      echo "Add $bin_dir to your PATH to run opentide."
    else
      add_to_path "$bin_dir"
      echo "Open a new terminal, or run this one now:"
      echo "  export PATH=\"$bin_dir:\$PATH\""
    fi
    ;;
esac
