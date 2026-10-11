// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
// Per-frame geometry recorder for the linearity test.
//
// The frames are exposed as global.__linearOverviewFrames instead of being
// exported through this module, because the shell loads the extension in its
// own module registry: an automation script that imports this file would get
// a second, empty instance.
import GLib from 'gi://GLib';

const MAX_FRAMES = 4000;

export function isEnabled(config) {
    return config.values.measure || global.__linearOverviewMeasure === true;
}

export function setup() {
    if (!global.__linearOverviewFrames)
        global.__linearOverviewFrames = [];
}

export function push(frame) {
    if (!global.__linearOverviewFrames)
        global.__linearOverviewFrames = [];

    const frames = global.__linearOverviewFrames;
    frames.push({ms: Math.round(GLib.get_monotonic_time() / 1000), ...frame});

    if (frames.length > MAX_FRAMES)
        frames.splice(0, frames.length - MAX_FRAMES);
}

export function teardown() {
    delete global.__linearOverviewFrames;
    delete global.__linearOverviewMeasure;
}
