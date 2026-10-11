#!/usr/bin/env bash
#
# Behaviour test for linear-overview.
#
# Runs a *nested* GNOME Shell (gnome-shell --devkit) inside a toolbox
# container, drives the session <-> window picker transition and checks that
# the preview geometry is linear in the state value - measured, not eyeballed.
#
# Usage:
#   tests/run-tests.sh                      # correction enabled, expect linear
#   ENABLED=0 EXPECT=nonlinear tests/run-tests.sh   # control run
#   CONTAINER=host tests/run-tests.sh        # isolated headless host shell
#
# Environment:
#   CONTAINER   toolbox container name or host (default: fedora-toolbox-44)
#   WORKDIR     scratch directory shared with the container
#                                       (default: /tmp/linear-overview-tests)
#   ENABLED     1 = dev-config.json "enabled": true   (default: 1)
#   EXPECT      linear | nonlinear      (default: linear)
#   KEEP        1 = keep logs and the scratch directory
#   ATTEMPTS    retries when the *nested shell* wedges (default: 2)
#
# Requirements:
#   - a running graphical session (the nested shell appears in a
#     mutter-devkit window on the host)
#   - toolbox + a container with gnome-shell >= 50 (for --devkit), gjs, GTK4
#     and /usr/libexec/mutter-devkit
#
# WARNING: everything runs against a throwaway HOME and a private dbus
# session.  Never call dconf on the live session bus from here, see
# dconf-setup.sh.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

UUID="$(sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$REPO_DIR/metadata.json" | head -n 1)"

CONTAINER="${CONTAINER:-fedora-toolbox-44}"
WORKDIR="${WORKDIR:-/tmp/linear-overview-tests}"
ENABLED="${ENABLED:-1}"
EXPECT="${EXPECT:-linear}"
LO_ENGINE="${LO_ENGINE:-native}"
case "$LO_ENGINE" in
    native|transform) ;;
    *) echo "error: LO_ENGINE must be native or transform" >&2; exit 1 ;;
esac
TESTHOME="$WORKDIR/home"
EXTDIR="$TESTHOME/.local/share/gnome-shell/extensions/$UUID"

if [ "$CONTAINER" != "host" ]; then
    command -v toolbox >/dev/null || {
        echo "error: toolbox is not installed" >&2
        exit 1
    }
fi

echo "[run] container: $CONTAINER"
echo "[run] workdir:   $WORKDIR"
echo "[run] enabled:   $ENABLED (expect $EXPECT)"

# 1. fresh isolated home with a copy of the extension
rm -rf "$WORKDIR"
mkdir -p "$EXTDIR/lib"

for file in extension.js metadata.json; do
    cp "$REPO_DIR/$file" "$EXTDIR/$file"
done
cp "$REPO_DIR"/lib/*.js "$EXTDIR/lib/"

# Isolate runtime and all XDG locations too; changing HOME alone is insufficient
# when the caller has explicit XDG paths. Dconf must never use the live runtime.
export XDG_CONFIG_HOME="$TESTHOME/.config"
export XDG_DATA_HOME="$TESTHOME/.local/share"
export XDG_CACHE_HOME="$TESTHOME/.cache"
export XDG_STATE_HOME="$TESTHOME/.local/state"
if [ "$CONTAINER" = "host" ]; then
    export XDG_RUNTIME_DIR="$WORKDIR/runtime"
    mkdir -p "$XDG_RUNTIME_DIR"
    chmod 700 "$XDG_RUNTIME_DIR"
    export GTK_A11Y=none
    export GSK_RENDERER=cairo
fi

if [ "$ENABLED" = "1" ]; then
    sed -e 's/"enabled": false/"enabled": true/' -e "s/\"engine\": \"native\"/\"engine\": \"$LO_ENGINE\"/" "$REPO_DIR/dev-config.json" > "$EXTDIR/dev-config.json"
else
    sed -e 's/"enabled": true/"enabled": false/' -e "s/\"engine\": \"native\"/\"engine\": \"$LO_ENGINE\"/" "$REPO_DIR/dev-config.json" > "$EXTDIR/dev-config.json"
fi

# the scripts run inside the container, so copy them to the shared workdir
for file in dconf-setup.sh harness.sh automation.js test-window.js; do
    cp "$SCRIPT_DIR/nested/$file" "$WORKDIR/$file"
done

# 2. populate the isolated dconf from a private dbus session
env HOME="$TESTHOME" LO_TEST_HOME="$TESTHOME" \
    dbus-run-session -- bash "$WORKDIR/dconf-setup.sh"

# 3. run the nested shell in the container
#
# Nested mutter occasionally leaves the overview animation wedged, which makes
# the automation skip cycles and can leave a case without analysable data.
# That is an environment problem, not a result, so retry it - but only when the
# log actually shows an aborted cycle, never after a genuine assertion failure.
ATTEMPTS="${ATTEMPTS:-2}"
status=1

for attempt in $(seq 1 "$ATTEMPTS"); do
    set +e
    if [ "$CONTAINER" = "host" ]; then
        env HOME="$TESTHOME" LO_TEST_HOME="$TESTHOME" lo_expect="$EXPECT" lo_engine="$LO_ENGINE" \
            LO_HEADLESS=1 dbus-run-session -- bash "$WORKDIR/harness.sh"
    else
        toolbox run --container "$CONTAINER" -- \
            env HOME="$TESTHOME" LO_TEST_HOME="$TESTHOME" lo_expect="$EXPECT" lo_engine="$LO_ENGINE" \
            dbus-run-session -- bash "$WORKDIR/harness.sh"
    fi
    status=$?
    set -e

    if [ "$status" -eq 0 ]; then
        break
    fi
    if ! grep -q "cycle aborted" "$WORKDIR/shell.log"; then
        break
    fi
    if [ "$attempt" -lt "$ATTEMPTS" ]; then
        echo "[run] nested shell wedged (attempt $attempt/$ATTEMPTS), retrying"
    fi
done

echo
echo "=== measurement ==="
grep -E "LO-TEST\] (INFO|PASS|FAIL|SUMMARY)" "$WORKDIR/shell.log" || true

if [ "${KEEP:-0}" = "1" ]; then
    echo
    echo "[run] logs kept in $WORKDIR"
else
    rm -rf "$WORKDIR"
fi

if [ "$status" -eq 0 ]; then
    echo "[run] OK"
else
    echo "[run] FAILED (status $status)"
fi
exit "$status"
