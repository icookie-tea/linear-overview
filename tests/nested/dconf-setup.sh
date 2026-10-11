#!/usr/bin/env bash
#
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 icookie-tea
#
# Populate the isolated test dconf database.
#
# dconf talks to the *session bus*, not just to $HOME: a plain `dconf write`
# would modify the live user settings instead of the isolated test home.
# This script therefore refuses to run unless it is inside a private dbus
# session started with HOME (and LO_TEST_HOME) pointing at the throwaway home.
#
#   env HOME=$LO_TEST_HOME LO_TEST_HOME=$LO_TEST_HOME \
#       dbus-run-session -- bash dconf-setup.sh
set -eu

: "${LO_TEST_HOME:?LO_TEST_HOME must point to the isolated test home}"

if [ "$HOME" != "$LO_TEST_HOME" ]; then
    echo "refusing to run: HOME ($HOME) != LO_TEST_HOME ($LO_TEST_HOME)" >&2
    exit 1
fi

if [ "${DBUS_SESSION_BUS_ADDRESS:-}" = "unix:path=${XDG_RUNTIME_DIR:-}/bus" ]; then
    echo "refusing to run: this is the live session bus, not a private one" >&2
    exit 1
fi

UUID='linear-overview@icookie'

# only our extension is enabled
dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
dconf write /org/gnome/shell/disable-user-extensions false

# the transition has to animate for the test to observe it
dconf write /org/gnome/desktop/interface/enable-animations true
dconf write /org/gnome/desktop/interface/color-scheme "'prefer-dark'"

# a solid background, so the nested shell needs no wallpaper file
dconf write /org/gnome/desktop/background/picture-options "'none'"
dconf write /org/gnome/desktop/background/primary-color "'#335577'"
dconf write /org/gnome/desktop/background/color-shading-type "'solid'"

# keep the window picker geometry stable (no workspace switcher surprises)
dconf write /org/gnome/mutter/workspaces-only-on-primary false
