#!/usr/bin/env bash
# Termux setup for tca.
#
#   bash setup.sh              install deps, create dirs, run checks
#   bash setup.sh --service    also install a runit service that survives reboot
#
# Safe to re-run: every step is idempotent and nothing is deleted.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WANT_SERVICE=0
[[ "${1:-}" == "--service" ]] && WANT_SERVICE=1

say()  { printf '\n=== %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

in_termux() { [[ -n "${TERMUX_VERSION:-}" ]]; }

# ---------------------------------------------------------------- dependencies

say "Dependencies"
if in_termux; then
  note "Termux $TERMUX_VERSION"
  missing=()
  command -v node >/dev/null || missing+=(nodejs)
  command -v git  >/dev/null || missing+=(git)
  # termux-api gives us termux-wake-lock, which is what stops Android from
  # killing the daemon the moment the screen turns off.
  command -v termux-wake-lock >/dev/null || missing+=(termux-api)
  if ((${#missing[@]})); then
    note "installing: ${missing[*]}"
    pkg install -y "${missing[@]}"
  else
    note "nodejs, git, termux-api already present"
  fi
else
  note "Not Termux. Skipping pkg install; make sure node 20+ and git are on PATH."
fi

# Three failure modes, and telling them apart matters: "node not installed",
# "node installed but its shared libraries do not match" (very common on Termux
# after a partial upgrade), and "node too old".
if ! command -v node >/dev/null; then
  echo "ERROR: node is not installed." >&2
  in_termux && echo "  pkg install nodejs" >&2
  exit 1
fi

node_probe="$(node -p 'process.versions.node' 2>&1)" || node_probe_failed=1
if [[ -n "${node_probe_failed:-}" ]]; then
  echo "ERROR: node is installed but will not run:" >&2
  echo "  $node_probe" >&2
  if [[ "$node_probe" == *"CANNOT LINK EXECUTABLE"* || "$node_probe" == *"cannot locate symbol"* ]]; then
    cat >&2 <<'DIAG'

  This is a Termux library mismatch, not a problem with this project. The node
  binary was built against a newer libc++ than the one installed, which happens
  when nodejs is installed without upgrading the rest of the system first.

  Fix:
    pkg update && pkg upgrade -y
    node -v

  If it still fails:
    pkg reinstall libc++ nodejs

  If it STILL fails, check where Termux came from:
    termux-info | head -20
  The Google Play build of Termux is abandoned and its repos are broken. Install
  Termux from F-Droid or from the GitHub releases page instead. Note that
  reinstalling Termux erases ~, so keep this zip; your config on /sdcard survives.
DIAG
  fi
  exit 1
fi

node_major="${node_probe%%.*}"
if (( node_major < 20 )); then
  echo "ERROR: node 20+ required, found $node_probe" >&2
  in_termux && echo "  pkg upgrade nodejs" >&2
  exit 1
fi
note "node v$node_probe"
note "no npm install needed - this project has zero dependencies"

# ------------------------------------------------------------- shared storage

if in_termux; then
  say "Shared storage"
  if [[ -d "$HOME/storage/shared" ]]; then
    note "already granted: $HOME/storage/shared"
  else
    note "Requesting it now so config.json can be edited with any text editor."
    note "Accept the Android permission dialog."
    termux-setup-storage || true
    sleep 2
    if [[ -d "$HOME/storage/shared" ]]; then
      note "granted"
    else
      note "not granted - config will live in ~/.tca/config.json instead (still fine)"
    fi
  fi
fi

# -------------------------------------------------------------------- workspace

say "Workspace"
WORKSPACE="${TCA_WORKSPACE:-$HOME/projects}"
mkdir -p "$WORKSPACE"
note "$WORKSPACE"

# ------------------------------------------------------------- first-run config

say "Config"
# Starting the CLI once creates the config file and picks up any API keys
# already exported in this shell.
node "$REPO_DIR/src/cli.js" token >/dev/null
node "$REPO_DIR/src/cli.js" doctor || true

# ---------------------------------------------------------------------- service

if (( WANT_SERVICE )); then
  say "Service (runit)"
  if ! in_termux; then
    note "Only supported under Termux. Skipped."
  else
    command -v sv >/dev/null || pkg install -y termux-services
    SV_DIR="$PREFIX/var/service/tca"
    mkdir -p "$SV_DIR/log"

    cat > "$SV_DIR/run" <<EOF
#!$PREFIX/bin/sh
# Managed by tca setup.sh. Regenerate with: bash setup.sh --service
exec 2>&1
# Without a wake lock Android suspends the process a few seconds after the
# screen goes off, and a long agent turn silently stalls mid-task.
termux-wake-lock 2>/dev/null || true
cd "$REPO_DIR"
exec node "$REPO_DIR/src/cli.js" serve
EOF
    chmod +x "$SV_DIR/run"

    cat > "$SV_DIR/log/run" <<EOF
#!$PREFIX/bin/sh
mkdir -p "$PREFIX/var/log/tca"
exec svlogd -tt "$PREFIX/var/log/tca"
EOF
    chmod +x "$SV_DIR/log/run"

    note "installed $SV_DIR/run"
    note "enable:  sv-enable tca"
    note "status:  sv status tca"
    note "logs:    tail -f $PREFIX/var/log/tca/current"
    note ""
    note "runit itself starts from ~/.bashrc, so the service comes back after a"
    note "reboot only once you open Termux. Android has no real boot service."
  fi
fi

# --------------------------------------------------------------- nhatnam cmd

if in_termux; then
  say "Shortcut command"
  BIN_DIR="$PREFIX/bin"
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/nhatnam" <<EOF
#!$PREFIX/bin/sh
# Installed by setup.sh. 'nhatnam' with no args starts the agent (same as
# 'tca serve'); 'nhatnam doctor', 'nhatnam token', etc. still work.
if [ "\$#" -eq 0 ]; then
  exec node "$REPO_DIR/src/cli.js" serve
else
  exec node "$REPO_DIR/src/cli.js" "\$@"
fi
EOF
  chmod +x "$BIN_DIR/nhatnam"
  # install.sh links `tca`; do the same here so both scripts leave the same
  # command available and the docs only have to teach one name.
  chmod +x "$REPO_DIR/src/cli.js"
  ln -sf "$REPO_DIR/src/cli.js" "$BIN_DIR/tca"
  note "installed: 'tca' (full CLI) and 'nhatnam' (no args = start the agent)"
  note "(also works: nhatnam doctor / nhatnam token / nhatnam adb-setup)"
fi

# ------------------------------------------------------------------ next steps

say "Next"
if in_termux; then
  note "Start it:   nhatnam"
else
  note "Start it:   node $REPO_DIR/src/cli.js serve"
fi
note "Then open the printed http://127.0.0.1:8787/?token=... in your browser."
note ""
note "Optional but recommended on Android 12+:"
note "  Battery: Settings > Apps > Termux > Battery > Unrestricted"
note "  Phantom process killer caps child processes at 32 and kills the rest,"
note "  which breaks long agent runs. From a PC with adb:"
note '    adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; \'
note '      /system/bin/device_config put activity_manager max_phantom_processes 2147483647"'
note ""
if in_termux; then
  note "Run 'nhatnam doctor' any time to re-check (also visible live in the web UI Settings tab)."
else
  note "Run 'node $REPO_DIR/src/cli.js doctor' any time to re-check."
fi
