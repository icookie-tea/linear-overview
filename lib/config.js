// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
// Developer configuration (dev-config.json).
//
// The extension deliberately ships no GSettings schema: it is a personal
// testbed, and every knob lives in a small JSON file next to extension.js.
// The file is re-read when its modification time changes (checked once per
// second). Runtime toggles apply immediately; the engine is selected at enable.
import GLib from 'gi://GLib';

const POLL_INTERVAL_S = 1;

export const DEFAULTS = Object.freeze({
    // Enable the selected implementation.
    enabled: true,
    // 'native' allocates the transition directly; 'transform' is the previous
    // sampled-endpoint implementation, retained for comparisons.
    engine: 'native',
    // Legacy transform engine only. 'active-workspace' leaves other workspaces
    // to the shell:
    // their floating geometry is offset by the workspace scroll position,
    // which this extension does not track. 'all' corrects every workspace.
    scope: 'active-workspace',
    // Legacy transform engine only. 'session-picker' corrects between the session
    // and the window picker (the transition gnome-shell#2968 is about).
    // 'any-transition' corrects whenever 0 < t < 1.
    gate: 'session-picker',
    // Log every correction (very noisy, only for debugging).
    debug: false,
    // Record per-frame geometry for the linearity test; the frames are
    // exposed as global.__linearOverviewFrames.
    measure: false,
});

export class Config {
    constructor(extension, logError) {
        this._path = GLib.build_filenamev([extension.path, 'dev-config.json']);
        this._logError = logError;
        this._values = {...DEFAULTS};
        this._signature = '';
        this._contents = null;
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_S, () => {
            this._read();
            return GLib.SOURCE_CONTINUE;
        });

        this._read(true);
    }

    get values() {
        return this._values;
    }

    get path() {
        return this._path;
    }

    _read(force = false) {
        let contents = null;

        try {
            const [ok, bytes] = GLib.file_get_contents(this._path);
            if (ok)
                contents = new TextDecoder().decode(bytes);
        } catch (e) {
            this._logError(`cannot read ${this._path}, keeping the previous settings`, e);
            return;
        }

        if (!force && contents === this._contents)
            return;

        this._contents = contents;

        let parsed = null;
        if (contents !== null) {
            try {
                parsed = JSON.parse(contents);
            } catch (e) {
                this._logError(`${this._path} is not valid JSON, keeping the previous settings`, e);
                return;
            }
        }

        const values = {...DEFAULTS, ...(parsed ?? {})};
        if (!['native', 'transform'].includes(values.engine)) {
            this._logError(`unknown engine ${values.engine}, keeping the previous settings`);
            return;
        }
        const signature = JSON.stringify(values);
        if (signature === this._signature)
            return;

        this._signature = signature;
        this._values = values;
    }

    destroy() {
        if (this._pollId > 0) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }
}
