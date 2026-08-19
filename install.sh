#!/usr/bin/env bash
#
# install.sh — one-command installer for the Resources Node (macOS).
#
# A newsroom runs ONE line in the built-in Terminal app — nothing to install by hand:
#
#     curl -fsSL https://grounded.developai.co.za/nodes/resources/mac | bash
#
# What it does — no admin password, no Xcode tools, no Homebrew, no git, no VS Code:
#   1. Uses the Node already on the Mac if it's new enough; otherwise downloads a
#      private, app-only copy of Node (nothing system-wide changes).
#   2. Downloads the latest app code from GitHub over plain HTTPS (no git).
#   3. Installs the app's parts, starts it, and opens the dashboard in the browser.
#
# Re-running the same line later just relaunches on the latest version. The
# newsroom's API key (.env) and uploaded data (data/) are ALWAYS preserved.
#
# Everything below is for Develop AI, not the newsroom — they only ever see the
# friendly messages this prints.

set -euo pipefail

# ── Settings (defaults are the real values; env vars override them for testing) ──
REPO="${GROUNDED_REPO:-pauldevelopai/node-resources}"
REF="${GROUNDED_REF:-main}"
NODE_VERSION="${GROUNDED_NODE_VERSION:-20.18.1}"
GROUNDED_HOME="${GROUNDED_HOME:-$HOME/GROUNDED}"
APP_DIR="$GROUNDED_HOME/node-resources"
DISPLAY_NAME="Resources"
PORT="${PORT:-3000}"

say() { printf "  %s\n" "$*"; }
ok()  { printf "  ✓ %s\n" "$*"; }
die() {
  printf "\n  ✗ %s\n\n  Email Paul a screenshot of this window — he'll get you unstuck.\n\n" "$*" >&2
  exit 1
}

printf "\n  ╭─ %s · Setup ─╮\n\n" "$DISPLAY_NAME"

# ── 1. Make sure we have Node ≥ 20 ───────────────────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -ge 20 ]; then
    need_node=0
    ok "Using the Node already on this Mac ($(node -v))."
  fi
fi

if [ "$need_node" -eq 1 ]; then
  case "$(uname -m)" in
    arm64)  nbuild="node-v${NODE_VERSION}-darwin-arm64" ;;
    x86_64) nbuild="node-v${NODE_VERSION}-darwin-x64" ;;
    *)      die "Unrecognised Mac processor type: $(uname -m)." ;;
  esac
  node_home="$APP_DIR/.node"
  if [ ! -x "$node_home/$nbuild/bin/node" ]; then
    say "Setting up a private copy of Node just for this app (one-time, ~40 MB)..."
    mkdir -p "$node_home"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${nbuild}.tar.gz" \
      | tar -xz -C "$node_home" \
      || die "Couldn't download Node. Check your internet connection and run the command again."
  fi
  export PATH="$node_home/$nbuild/bin:$PATH"
  ok "Node ready ($(node -v))."
fi

# ── 2. Download the latest app code (plain HTTPS, no git) ────────────────────
fresh=1
[ -f "$APP_DIR/package.json" ] && fresh=0

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

got_code=0
if [ -n "${GROUNDED_SRC_DIR:-}" ]; then
  # Test hook: assemble from a local checkout instead of downloading.
  mkdir -p "$tmp/src" && cp -R "$GROUNDED_SRC_DIR/." "$tmp/src/" && got_code=1
else
  say "Downloading the latest $DISPLAY_NAME..."
  if curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" | tar -xz -C "$tmp" 2>/dev/null; then
    # The tarball unpacks to a single <repo>-<ref> directory.
    extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
    [ -n "$extracted" ] && mv "$extracted" "$tmp/src" && got_code=1
  fi
fi

if [ "$got_code" -eq 0 ]; then
  [ "$fresh" -eq 1 ] && die "Couldn't download the app. Check your internet connection and run the command again."
  say "(Couldn't reach GitHub — launching the version already installed.)"
fi

mkdir -p "$APP_DIR"
# Remember the dependency fingerprint before we sync, so we only reinstall if it
# changed. Hash package.json only — npm rewrites package-lock.json on install, so
# including the lock would make every re-run look "changed" and reinstall needlessly.
pre_sig=""
[ -f "$APP_DIR/package.json" ] && pre_sig="$(shasum "$APP_DIR/package.json" 2>/dev/null | awk '{print $1}')"

if [ "$got_code" -eq 1 ]; then
  # Copy code in, but NEVER touch the newsroom's key (.env) or data (data/).
  # --exclude protects those paths from --delete too, so nothing of theirs is removed.
  rsync -a --delete \
    --exclude='.env' --exclude='.env.local' \
    --exclude='data/' --exclude='node_modules/' \
    --exclude='.node/' --exclude='.git/' \
    "$tmp/src/" "$APP_DIR/"
  ok "App code is up to date."
fi
mkdir -p "$APP_DIR/data/processed" "$APP_DIR/data/raw"

cd "$APP_DIR"

# ── 3. Install the app's parts (only when something changed) ─────────────────
post_sig="$(shasum "$APP_DIR/package.json" 2>/dev/null | awk '{print $1}')"
if [ ! -d node_modules ] || [ "$pre_sig" != "$post_sig" ]; then
  say "Installing the app's parts (the first time takes a minute)..."
  npm install --no-audit --no-fund --loglevel=error \
    || die "Couldn't install the app's parts. Run the command again; if it keeps failing, email Paul."
  ok "Parts installed."
fi

# ── 4. Launch ────────────────────────────────────────────────────────────────
rm -rf "$tmp"; trap - EXIT
ok "Starting $DISPLAY_NAME..."
printf "\n  Your dashboard will open at  http://localhost:%s\n" "$PORT"
printf "  Leave this Terminal window open while you use the app.\n"
printf "  To stop the app: press Ctrl+C here, or just close this window.\n"
printf "  To use it again another day: paste the same command.\n\n"
( sleep 3; open "http://localhost:$PORT" >/dev/null 2>&1 || true ) &
exec npm start
