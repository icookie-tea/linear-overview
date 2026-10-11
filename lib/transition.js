// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
// Pin window content to a screen-space path. Frozen shell slots may still be
// enlarged at t == 0; release a closing correction only after overview hides.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {captureTransform, lerpBox, MIN_SIZE, parentTransform, restoreTransform, stageBox} from './geometry.js';
import * as Measure from './measure.js';

export class Corrector {
    constructor(config, logError) {
        this._config = config;
        this._logError = logError;
        this._records = new Map();
        this._layouts = new Map();
        this._pickerCaches = new Map(); // Meta.Workspace -> monitor -> cache
        this._sequence = 0;
        this._stats = {sample: 0, dropSession: 0, frozen: 0, hidden: 0};
        this._hidingId = Main.overview.connect('hiding', () => this._captureClosing());
        this._hiddenId = Main.overview.connect('hidden', () => this._releaseAll());
        this._shownId = Main.overview.connect('shown', () => {
            for (const state of this._layouts.values())
                state.container.queue_relayout();
        });
    }

    apply(layout, container) {
        const windows = layout._windows;
        const adjustment = layout._stateAdjustment;
        if (!windows || !adjustment)
            return;
        const config = this._config.values;
        const measure = Measure.isEnabled(this._config);
        if (!config.enabled && !measure) {
            this.clear();
            return;
        }
        const state = this._stateFor(layout, container);
        const signature = this._signature(layout);
        if (state.signature !== signature) {
            state.pickers.clear();
            state.signature = signature;
            this._stats.dropSession++;
        }
        const skip = config.scope !== 'all' && layout._metaWorkspace && !layout._metaWorkspace.active;
        const params = layout._overviewAdjustment?.getStateTransitionParams?.();
        const ctx = {
            layout, state, windows, measure,
            correcting: config.enabled && !skip,
            layoutFrozen: Boolean(layout._layoutFrozen),
            t: Math.clamp(adjustment.value, 0, 1),
            phase: this._phase(adjustment.value, params, config),
            closing: Main.overview.closing ||
                (params?.transitioning && params.initialState === 1 && params.finalState === 0),
            transform: parentTransform(container),
        };
        for (const [preview, windowInfo] of windows) {
            try {
                this._applyToPreview(ctx, preview, windowInfo);
            } catch (e) {
                this._logError('correcting a preview failed', e);
            }
        }
        // Only prune actors owned by this layout. Other workspaces may be empty.
        for (const [preview, record] of this._records) {
            if (record.layout === layout && !windows.has(preview))
                this._forgetPreview(preview);
        }
    }

    _phase(t, params, config) {
        if (!Main.overview.visible)
            return 'hidden';
        if (config.gate === 'any-transition' && t > 0 && t < 1)
            return 'transition';
        const sessionPicker = params?.transitioning &&
            ((params.initialState === 0 && params.finalState === 1) ||
             (params.initialState === 1 && params.finalState === 0));
        if (sessionPicker)
            return 'transition';
        if (t === 0)
            return 'session';
        if (t === 1 && (!params || params.currentState === 1))
            return 'picker';
        return 'other';
    }

    _applyToPreview(ctx, preview, windowInfo) {
        const record = this._recordFor(preview, ctx.layout);
        this._release(preview, record);
        const content = preview.window_container ?? preview;
        const raw = stageBox(content);
        const session = preview.boundingBox;
        const windowId = windowInfo.metaWindow.get_id();
        let shown = raw;
        let note = ctx.phase;
        let desired = null;
        const busy = preview.inDrag || windowInfo.currentTransition ||
            preview.get_transition('scale-x') || preview.get_transition('scale-y');
        const visibleWindow = windowInfo.metaWindow.showing_on_its_workspace();
        if (busy || !ctx.correcting || !visibleWindow) {
            record.close = null;
            note = busy ? 'busy' : !visibleWindow ? 'not-showing' : 'disabled';
        } else if (ctx.phase === 'picker' && !ctx.closing) {
            record.close = null;
            // A cached layout slot must not include the content hover enlargement.
            note = this._samplePicker(ctx, windowId, stageBox(preview), session) ? 'sample' : 'frozen';
        } else if (ctx.phase === 'transition' || (ctx.closing && ctx.t === 0)) {
            let picker = ctx.state.pickers.get(windowId)?.box ?? null;
            if (ctx.closing) {
                // Normal hide captures the rendered content before the timeline
                // moves; a gesture can arrive here without that signal snapshot.
                if (!record.close && picker)
                    record.close = {picker: {...picker}, session: {...session}};
                if (record.close) {
                    picker = record.close.picker;
                    record.close.session = {...session};
                }
            }
            if (picker) {
                desired = lerpBox(record.close?.session ?? session, picker, ctx.t);
                shown = this._correct(ctx, preview, record, content, desired) ?? raw;
                note = shown !== raw ? 'corrected' : 'degenerate';
            } else {
                note = 'no-picker';
            }
        } else {
            record.close = null;
        }
        this._record(ctx, preview, windowInfo, raw, shown, note, desired);
    }

    _samplePicker(ctx, windowId, box, session) {
        if (ctx.layoutFrozen || Main.overview.animationInProgress) {
            this._stats.frozen++;
        } else if (!Main.overview.visible) {
            this._stats.hidden++;
        } else {
            ctx.state.pickers.set(windowId, {box: {...box}, session: {...session}});
            this._stats.sample++;
            return true;
        }
        return false;
    }

    _captureClosing() {
        if (!this._config.values.enabled)
            return;
        for (const [layout] of this._layouts) {
            if (this._config.values.scope !== 'all' && layout._metaWorkspace && !layout._metaWorkspace.active)
                continue;
            if (layout._stateAdjustment.value !== 1 || layout._overviewAdjustment.value !== 1)
                continue;
            for (const [preview, windowInfo] of layout._windows) {
                try {
                    if (preview.inDrag || !windowInfo.metaWindow.showing_on_its_workspace())
                        continue;
                    const record = this._recordFor(preview, layout);
                    record.close = {picker: stageBox(preview.window_container ?? preview), session: {...preview.boundingBox}};
                } catch (e) {
                    this._logError('capturing a closing preview failed', e);
                }
            }
        }
    }

    _correct(ctx, preview, record, content, want) {
        const local = this._toContainer(ctx, want);
        if (!local || local.width < MIN_SIZE || local.height < MIN_SIZE)
            return null;
        record.transform = captureTransform(preview);
        preview.set_pivot_point(0, 0);
        preview.set_scale(1, 1);
        preview.translation_x = 0;
        preview.translation_y = 0;
        // Hover scales content around its center, changing its origin as well
        // as its size. Correct the content box, not just the outer allocation.
        const base = this._toContainer(ctx, stageBox(content));
        if (!base || base.width < MIN_SIZE || base.height < MIN_SIZE) {
            this._release(preview, record);
            return null;
        }
        const allocation = preview.allocation;
        const sx = local.width / base.width;
        const sy = local.height / base.height;
        preview.set_scale(sx, sy);
        preview.translation_x = local.x - allocation.x1 - (base.x - allocation.x1) * sx;
        preview.translation_y = local.y - allocation.y1 - (base.y - allocation.y1) * sy;
        return stageBox(content);
    }

    _toContainer(ctx, box) {
        const {origin, scale} = ctx.transform;
        if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y) || scale.x <= 0 || scale.y <= 0)
            return null;
        return {x: (box.x - origin.x) / scale.x, y: (box.y - origin.y) / scale.y,
            width: box.width / scale.x, height: box.height / scale.y};
    }

    _signature(layout) {
        const monitor = Main.layoutManager.monitors[layout._monitorIndex];
        const workarea = layout._workarea;
        const windows = [...layout._windows].map(([preview, info]) => [
            info.metaWindow.get_id(), ...Object.values(preview.boundingBox), info.metaWindow.showing_on_its_workspace(),
        ]).sort((a, b) => a[0] - b[0]);
        return JSON.stringify([windows,
            workarea && [workarea.x, workarea.y, workarea.width, workarea.height],
            monitor && [monitor.x, monitor.y, monitor.width, monitor.height,
                global.display?.get_monitor_scale?.(layout._monitorIndex) ?? monitor.geometry_scale],
            global.workspace_manager.n_workspaces, layout._metaWorkspace?.active, layout._spacing,
            layout._sortedWindows?.[0]?.chromeHeights(), layout._sortedWindows?.[0]?.chromeWidths()]);
    }

    _stateFor(layout, container) {
        let state = this._layouts.get(layout);
        if (!state) {
            const manager = global.workspace_manager;
            if (typeof manager.get_workspace_by_index === 'function') {
                const workspaces = new Set(Array.from({length: manager.n_workspaces}, (_, i) => manager.get_workspace_by_index(i)));
                for (const workspace of this._pickerCaches.keys()) {
                    if (workspace && !workspaces.has(workspace))
                        this._pickerCaches.delete(workspace);
                }
            }
            const workspace = layout._metaWorkspace ?? null;
            let monitors = this._pickerCaches.get(workspace);
            if (!monitors) {
                monitors = new Map();
                this._pickerCaches.set(workspace, monitors);
            }
            let cache = monitors.get(layout._monitorIndex);
            if (!cache) {
                cache = {pickers: new Map(), signature: null};
                monitors.set(layout._monitorIndex, cache);
            }
            // Workspace views (and layout/preview actors) are recreated after
            // every hide. Keep endpoints under stable workspace+monitor ids.
            state = {pickers: cache.pickers, container, destroyId: 0,
                get signature() { return cache.signature; },
                set signature(value) { cache.signature = value; }};
            state.destroyId = container.connect('destroy', () => this._dropLayout(layout, true));
            this._layouts.set(layout, state);
        }
        return state;
    }

    _recordFor(preview, layout) {
        let record = this._records.get(preview);
        if (!record) {
            record = {layout, transform: null, close: null, seq: this._sequence++, destroyId: 0};
            record.destroyId = preview.connect('destroy', () => this._forgetPreview(preview, true));
            this._records.set(preview, record);
        }
        return record;
    }

    _release(preview, record) {
        if (record.transform) {
            restoreTransform(preview, record.transform);
            record.transform = null;
        }
    }

    _forgetPreview(preview, destroyed = false) {
        const record = this._records.get(preview);
        if (!record)
            return;
        if (!destroyed) {
            this._release(preview, record);
            preview.disconnect(record.destroyId);
        }
        this._records.delete(preview);
    }

    _dropLayout(layout, destroyed = false) {
        for (const [preview, record] of this._records) {
            if (record.layout === layout)
                this._forgetPreview(preview, destroyed);
        }
        const state = this._layouts.get(layout);
        if (state && !destroyed)
            state.container.disconnect(state.destroyId);
        this._layouts.delete(layout);
    }

    _releaseAll() {
        for (const [preview, record] of this._records) {
            try {
                this._release(preview, record);
                record.close = null;
            } catch (e) {
                this._logError('resetting a destroyed preview failed', e);
            }
        }
    }

    clear() {
        this._releaseAll();
        for (const preview of this._records.keys())
            this._forgetPreview(preview);
        for (const layout of this._layouts.keys())
            this._dropLayout(layout);
        this._pickerCaches.clear();
    }

    destroy() {
        this.clear();
        Main.overview.disconnect(this._hidingId);
        Main.overview.disconnect(this._hiddenId);
        Main.overview.disconnect(this._shownId);
    }

    _record(ctx, preview, windowInfo, raw, shown, note, desired) {
        if (!ctx.measure)
            return;
        const record = this._records.get(preview);
        Measure.push({t: ctx.t, phase: ctx.phase, direction: ctx.closing ? 'close' : 'open', win: windowInfo.metaWindow.get_id(),
            monitor: ctx.layout._monitorIndex, rec: record.seq, applied: record.transform !== null, note,
            raw: roundBox(raw), shown: roundBox(shown), desired: roundBox(desired), session: roundBox(preview.boundingBox),
            picker: roundBox(record.close?.picker ?? ctx.state.pickers.get(windowInfo.metaWindow.get_id())?.box), stats: {...this._stats}});
    }
}

function roundBox(box) {
    if (!box)
        return null;
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(box[key] * 100) / 100]));
}
