#!/bin/sh
# tokio installer.
#
#   curl -fsSL https://raw.githubusercontent.com/mariomontecatine/tokio/main/install.sh | sh
#
# Safe to run again: a second run updates the copy you already have instead of
# starting over. Everything lands in two places and nowhere else —
# ~/.tokio for the program and ~/.local/bin/tokio for the command — so
# uninstalling is `rm -rf ~/.tokio ~/.local/bin/tokio`.
set -eu

REPO_URL="${TOKIO_REPO:-https://github.com/mariomontecatine/tokio.git}"
TARBALL_URL="${TOKIO_TARBALL:-https://codeload.github.com/mariomontecatine/tokio/tar.gz/refs/heads/main}"
HOME_DIR="${TOKIO_HOME:-$HOME/.tokio}"
BIN_DIR="${TOKIO_BIN:-$HOME/.local/bin}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m'); R=$(printf '\033[0m')
else
  B=''; DIM=''; GREEN=''; YELLOW=''; RED=''; R=''
fi

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$R" "$*"; }
die()  { printf '\n  %s✗%s %s\n\n' "$RED" "$R" "$*" >&2; exit 1; }

printf '\n  %stokio%s %s· installing%s\n\n' "$B" "$R" "$DIM" "$R"

# --- what we need -----------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer is required. Install it from https://nodejs.org and run this again."

NODE_VERSION=$(node -p 'process.versions.node')
NODE_MAJOR=${NODE_VERSION%%.*}
NODE_REST=${NODE_VERSION#*.}
NODE_MINOR=${NODE_REST%%.*}

# node:sqlite arrived in 22.5, and it is why tokio has no native dependencies.
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] ||
   { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node $NODE_VERSION is too old — tokio needs $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer for its built-in SQLite."
fi
ok "node $NODE_VERSION"

command -v npm >/dev/null 2>&1 || die "npm was not found. It normally ships with Node."

# Not fatal: tokio still reads your past transcripts and shows the dashboard.
# It just cannot run a queued job until `claude` is on the PATH.
if command -v claude >/dev/null 2>&1; then
  ok "claude found"
else
  warn "claude is not on your PATH — tokio will read your history, but cannot run queued jobs yet"
fi

# --- fetch ------------------------------------------------------------------

if [ -d "$HOME_DIR/.git" ] && command -v git >/dev/null 2>&1; then
  say "updating $HOME_DIR"
  git -C "$HOME_DIR" fetch --quiet origin main
  git -C "$HOME_DIR" reset --quiet --hard origin/main
  ok "updated"
elif command -v git >/dev/null 2>&1; then
  [ -e "$HOME_DIR" ] && die "$HOME_DIR already exists but is not a git checkout. Move it aside and run this again."
  say "downloading into $HOME_DIR"
  git clone --quiet --depth 1 "$REPO_URL" "$HOME_DIR"
  ok "downloaded"
else
  # No git: fall back to the tarball, which is enough to install but cannot be
  # updated in place later.
  say "downloading into $HOME_DIR"
  rm -rf "$HOME_DIR"
  mkdir -p "$HOME_DIR"
  curl -fsSL "$TARBALL_URL" | tar -xz -C "$HOME_DIR" --strip-components=1
  ok "downloaded (no git — re-run this script to update)"
fi

# --- build ------------------------------------------------------------------

say "building…"
cd "$HOME_DIR"
npm install --silent --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed. Run it by hand in $HOME_DIR to see why."
npm run build --silent >/dev/null 2>&1 || die "the build failed. Run 'npm run build' in $HOME_DIR to see why."
ok "built"

# --- put it on the PATH -----------------------------------------------------

mkdir -p "$BIN_DIR"
chmod +x "$HOME_DIR/dist/cli.js"

# A two-line shim rather than a symlink, for two reasons: it does not depend on
# `env -S` being available to honour the script's own shebang, and it silences
# the experimental-feature notice that node:sqlite prints on every start —
# addressed to whoever wrote this, not to whoever is running it. Only that
# warning; deprecations still get through.
cat > "$BIN_DIR/tokio" <<SHIM
#!/bin/sh
exec node --disable-warning=ExperimentalWarning "$HOME_DIR/dist/cli.js" "\$@"
SHIM
chmod +x "$BIN_DIR/tokio"
ok "tokio installed to $BIN_DIR"

ON_PATH=no
case ":${PATH}:" in
  *":$BIN_DIR:"*) ON_PATH=yes ;;
esac

printf '\n'
if [ "$ON_PATH" = yes ]; then
  printf '  %sReady.%s Run:  %stokio%s\n\n' "$B" "$R" "$B" "$R"
else
  # Say the exact line rather than "add it to your PATH", which is the kind of
  # instruction that means nothing until you already know the answer.
  case "${SHELL:-}" in
    */zsh) PROFILE="$HOME/.zshrc" ;;
    */fish) PROFILE="$HOME/.config/fish/config.fish" ;;
    *) PROFILE="$HOME/.bashrc" ;;
  esac
  printf '  %sReady%s — one thing left. %s is not on your PATH.\n\n' "$B" "$R" "$BIN_DIR"
  if [ "${PROFILE##*/}" = "config.fish" ]; then
    printf '    echo '\''fish_add_path %s'\'' >> %s\n' "$BIN_DIR" "$PROFILE"
  else
    printf '    echo '\''export PATH="%s:$PATH"'\'' >> %s\n' "$BIN_DIR" "$PROFILE"
  fi
  printf '\n  Then open a new terminal and run:  %stokio%s\n\n' "$B" "$R"
fi
