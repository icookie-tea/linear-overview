#!/usr/bin/env bash
#
# Runs inside the toolbox container, inside a private dbus session whose
# HOME/LO_TEST_HOME point at the throwaway test home.  Starts a nested GNOME
# Shell (--devkit) that executes automation.js, connects a plain GTK4 client
# to the nested Wayland socket and reports the test result.
#
# EXPECT (linear|nonlinear) is forwarded to the automation script and decides
# which result counts as a pass.
set -u

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HERE/shell.log"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# run-tests.sh passes the expectation into the container as lo_expect.
EXPECT="${lo_expect:-${EXPECT:-linear}}"

# A Wayland socket is only usable when its compositor is still listening.
connectable() {
    gjs -c "
        const Gio = imports.gi.Gio;
        try {
            new Gio.SocketClient().connect(Gio.UnixSocketAddress.new('$1'), null);
            print('ok');
        } catch (e) {
            imports.system.exit(1);
        }
    " 2>/dev/null | grep -q ok
}

# A crashed nested shell leaves its socket (and lock file) behind, and the
# next nested shell re-uses the very same name - which would look like "no new
# display" to the detection below.  Drop anything that nobody is listening on;
# wayland-0 is the real session, never touch it.
for sock in "$RUNTIME"/wayland-*; do
    [ -S "$sock" ] || continue
    case "$(basename "$sock")" in wayland-0) continue ;; esac
    if ! connectable "$sock"; then
        echo "[harness] removing stale socket $(basename "$sock")"
        rm -f "$sock" "$sock.lock"
    fi
done

echo "[harness] HOME=$HOME EXPECT=$EXPECT"

before=$(ls "$RUNTIME"/wayland-* 2>/dev/null | grep -v '\.lock$' || true)

lo_expect="$EXPECT" gnome-shell --devkit --unsafe-mode \
    --automation-script "$HERE/automation.js" \
    >"$LOG" 2>&1 &
SHELL_PID=$!

nested=""
for _ in $(seq 1 120); do
    for sock in "$RUNTIME"/wayland-*; do
        [ -S "$sock" ] || continue
        case "$sock" in *.lock) continue ;; esac
        if printf '%s\n' "$before" | grep -qxF "$sock"; then
            continue
        fi
        if connectable "$sock"; then
            nested="$sock"
            break
        fi
    done
    [ -n "$nested" ] && break
    kill -0 "$SHELL_PID" 2>/dev/null || break
    sleep 0.5
done

echo "[harness] nested display: ${nested:-<none>}"

WIN_PID=""
if [ -n "$nested" ]; then
    WAYLAND_DISPLAY="$(basename "$nested")" GDK_BACKEND=wayland \
        gjs -m "$HERE/test-window.js" >"$HERE/window.log" 2>&1 &
    WIN_PID=$!
fi

wait "$SHELL_PID"
status=$?
echo "[harness] gnome-shell exited with status $status"

if [ -n "$WIN_PID" ]; then
    kill "$WIN_PID" 2>/dev/null
fi

if grep -q "LO-TEST] SUMMARY ALL PASS" "$LOG"; then
    echo "[harness] RESULT: ALL PASS"
    exit 0
fi

echo "[harness] RESULT: FAILED"
grep -E "LO-TEST (FAIL|ERROR|SUMMARY)" "$LOG" || true
grep -E "JS ERROR|linear-overview" "$LOG" | head -20 || true
exit 1
