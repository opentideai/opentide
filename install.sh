#!/bin/sh
# Installs the opentide command.
#
#   curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh
#
# Needs Deno 2 on PATH. Unpacks the release into ~/.opentide/versions/<version>
# and puts an `opentide` launcher in Deno's bin directory (~/.deno/bin).
#
# Environment:
#   OPENTIDE_INSTALL_VERSION   version to install (default: the latest release)
#   OPENTIDE_INSTALL_TARBALL   install from this local tarball instead of downloading
#   OPENTIDE_INSTALL_REPO      GitHub owner/repo to download from
#   OPENTIDE_HOME              where releases are unpacked (default: ~/.opentide)
#   DENO_INSTALL_ROOT          where the launcher goes (Deno's own setting)
set -eu

REPO="${OPENTIDE_INSTALL_REPO:-opentideai/opentide}"
OPENTIDE_HOME="${OPENTIDE_HOME:-$HOME/.opentide}"
VERSION="${OPENTIDE_INSTALL_VERSION:-}"
TARBALL="${OPENTIDE_INSTALL_TARBALL:-}"

fail() {
  echo "opentide install: $*" >&2
  exit 1
}

command -v deno >/dev/null 2>&1 ||
  fail "Deno is not on PATH. Install it first:
  curl -fsSL https://deno.land/install.sh | sh"

case "$(deno --version | head -n 1)" in
  "deno 2."*) ;;
  *) fail "OpenTide needs Deno 2; found: $(deno --version | head -n 1)" ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -z "$TARBALL" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl is not on PATH."
  if [ -z "$VERSION" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
      sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$VERSION" ] || fail "could not find the latest release of $REPO."
  fi
  base="https://github.com/$REPO/releases/download/v$VERSION"
  TARBALL="$work/opentide-$VERSION.tar.gz"
  echo "Downloading OpenTide $VERSION..."
  curl -fsSL -o "$TARBALL" "$base/opentide-$VERSION.tar.gz" ||
    fail "download failed: $base/opentide-$VERSION.tar.gz"
  curl -fsSL -o "$TARBALL.sha256" "$base/opentide-$VERSION.tar.gz.sha256" ||
    fail "checksum download failed."
  expected="$(cut -d ' ' -f 1 <"$TARBALL.sha256")"
  [ "$(sha256 "$TARBALL")" = "$expected" ] ||
    fail "checksum mismatch for opentide-$VERSION.tar.gz."
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

# The launcher gets the permissions of the `opentide` task in the release's
# deno.json, minus `--env`: an installed command must not load whatever .env
# sits in the directory it is run from.
flags="$(deno eval --no-config '
  const task = JSON.parse(Deno.readTextFileSync(Deno.args[0])).tasks.opentide;
  const tokens = task.split(/\s+/).filter((t) => t.startsWith("--") && t !== "--env");
  console.log(tokens.join(" "));
' "$dest/deno.json")"
[ -n "$flags" ] || fail "no permission flags in the opentide task of $dest/deno.json."

echo "Downloading dependencies (once per version; this takes a minute)..."
log="$OPENTIDE_HOME/install.log"
deno cache --config "$dest/deno.json" --lock "$dest/deno.lock" \
  "$dest/cli/cli.ts" >"$log" 2>&1 ||
  fail "dependency download failed; see $log"

# Not `deno install`: it copies the config next to the launcher and resolves a
# fresh lockfile there, so every dependency floats to its newest version. This
# runs the release in place, against the lockfile it shipped with.
bin_dir="${DENO_INSTALL_ROOT:-$HOME/.deno}/bin"
launcher="$bin_dir/opentide"
# By absolute path: MCP clients started from a desktop app often lack the
# shell's PATH.
deno_bin="$(command -v deno)"
mkdir -p "$bin_dir"
cat >"$launcher" <<LAUNCHER
#!/bin/sh
# opentide $VERSION, written by install.sh
OPENTIDE_LAUNCHER="$launcher" exec "$deno_bin" run $flags \\
  --config "$dest/deno.json" --lock "$dest/deno.lock" \\
  "$dest/cli/cli.ts" "\$@"
LAUNCHER
chmod +x "$launcher"

installed="$("$launcher" --version 2>>"$log")" ||
  fail "the installed opentide does not run; see $log"
echo "Installed: $launcher ($installed)"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to your PATH to run opentide." ;;
esac
