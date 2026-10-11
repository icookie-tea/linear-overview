// Screen-space linearisation of the session <-> window picker transition.
//
// The shell builds that transition from two *nested* linear interpolations:
// the workspaces view moves and shrinks the workspace actor, and inside it
// WorkspaceLayout interpolates every preview between its floating (real
// window) box and its picker slot. Both are driven by the same state value
// t, so the geometry on screen is quadratic in t: previews dip in size,
// grow back and travel along a curved path (gnome-shell#2968).
//
// This corrector does not re-derive any of that maths. It samples the two
// steady states and pins each preview to their linear interpolation:
//
//     screenBox(t) = lerp(sessionBox, pickerBox, t)
//
//   * sessionBox is the live frame rect of the real window. A preview's
//     :bounding-box is in stage coordinates (ShellWindowPreviewLayout unions
//     MetaWindow frame rects), and it is exactly the geometry the shell
//     produces at t == 0.
//   * pickerBox is *measured* from the shell's own output in the settled
//     picker state (t == 1, overview open, LayoutStrategy not frozen), so the
//     end state stays identical to stock gnome-shell - the extension is a
//     no-op at both endpoints.
//
// pickerBox is stored per *window*, not per preview: the picker geometry only
// depends on the window, and Workspace tears previews down when their window
// disappears. It is dropped again when the window's frame rect changes, so a
// resized window falls back to the shell for one transition instead of
// animating towards a stale slot.
//
// The correction is a plain actor transform (pivot at the top-left, scale and
// translation), so allocations, the picker layout, hit tests and the focus
// chain are untouched.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {lerpBox, MIN_SIZE, parentTransform, resetTransform, stageBox, T_EPSILON} from './geometry.js';
import * as Measure from './measure.js';

// WorkspaceLayout state adjustment: 0 = floating, 1 = picker layout.
const T_SESSION = 0;
const T_PICKER = 1;

// OverviewControls.ControlsState
const STATE_HIDDEN = 0;
const STATE_WINDOW_PICKER = 1;

// A picker box older than this many frames is forgotten again (window gone).
const PICKER_MAX_AGE_FRAMES = 600;
const SESSION_TOLERANCE = 0.5; // px

export class Corrector {
    constructor(config, logError) {
        this._config = config;
        this._logError = logError;
        this._records = new Map(); // preview -> {corrected, seq}
        this._pickers = new Map(); // window id -> {box, session, frame}
        this._frame = 0;
        this._sequence = 0;
        this._stats = {sample: 0, dropSession: 0, dropAge: 0, frozen: 0, hidden: 0};
    }

    // Called from the patched WorkspaceLayout.vfunc_allocate(), after the
    // original implementation allocated all previews of one layout.
    apply(layout, container, box) {
        const windows = layout._windows;
        const adjustment = layout._stateAdjustment;

        if (!windows || !adjustment) {
            this.clear();
            return;
        }

        const config = this._config.values;
        const measure = Measure.isEnabled(this._config);

        if (!config.enabled && !measure) {
            if (this._records.size > 0)
                this.clear();
            return;
        }

        this._frame++;

        // Windows on other workspaces float at a position that is offset by
        // the workspace scroll position, which this correction does not
        // track, so by default those are left to the shell.
        const metaWorkspace = layout._metaWorkspace;
        const skipOthers =
            config.scope !== 'all' && Boolean(metaWorkspace) && !metaWorkspace.active;

        const allocation = container.allocation;
        const ctx = {
            config,
            measure,
            correcting: config.enabled,
            layout,
            windows,
            layoutFrozen: Boolean(layout._layoutFrozen),
            t: adjustment.value,
            phase: this._phase(layout, adjustment.value, config),
            transform: parentTransform(container, allocation.x1, allocation.y1),
        };

        for (const [preview, windowInfo] of windows) {
            if (skipOthers)
                continue;

            try {
                this._applyToPreview(ctx, preview, windowInfo);
            } catch (e) {
                this._logError('correcting a preview failed', e);
            }
        }

        if (this._records.size > windows.size)
            this._pruneRecords(windows);
    }

    // Drops every corrective transform again.
    clear() {
        for (const [preview, record] of this._records) {
            if (!record.corrected)
                continue;

            try {
                resetTransform(preview);
            } catch (e) {
                this._logError('resetting a destroyed preview failed', e);
            }
        }

        this._records.clear();
        this._pickers.clear();
    }

    _phase(layout, t, config) {
        if (t <= T_SESSION + T_EPSILON)
            return 'session';
        if (t >= T_PICKER - T_EPSILON)
            return 'picker';

        if (config.gate === 'any-transition')
            return 'transition';

        // Only the session <-> window picker transition is linearised: in the
        // picker <-> app grid transition the windows legitimately shrink with
        // the workspace (which is what the floating layout is for).
        const params = layout._overviewAdjustment?.getStateTransitionParams?.();
        if (!params)
            return 'other';

        const {initialState, finalState} = params;
        const sessionToPicker =
            (initialState === STATE_HIDDEN && finalState === STATE_WINDOW_PICKER) ||
            (initialState === STATE_WINDOW_PICKER && finalState === STATE_HIDDEN);

        return sessionToPicker ? 'transition' : 'other';
    }

    _applyToPreview(ctx, preview, windowInfo) {
        const record = this._recordFor(preview);

        // Never fight the shell's own animations: a preview of a window that
        // just appeared gets a 250ms scale ease (Workspace._doAddWindow), a
        // dragged preview is moved by the DND code, and a preview whose
        // allocation is animated carries its own transition.
        if (preview.inDrag ||
            Boolean(windowInfo.currentTransition) ||
            preview.get_transition('scale-x') ||
            preview.get_transition('scale-y')) {
            const box = stageBox(preview);
            this._record(ctx, preview, windowInfo, box, box, 'busy');
            return;
        }

        if (record.corrected)
            resetTransform(preview);
        record.corrected = false;

        const raw = stageBox(preview);
        const session = preview.boundingBox;
        const windowId = windowInfo.metaWindow.get_id();
        let shown = raw;
        let note = ctx.phase;

        if (ctx.phase === 'picker') {
            note = this._samplePicker(ctx, windowId, raw, session) ? 'sample' : 'frozen';
        } else if (ctx.phase === 'transition') {
            if (!ctx.correcting) {
                note = 'disabled';
            } else {
                const picker = this._pickerFor(windowId, session);
                if (!picker)
                    note = 'no-picker';
                else
                    shown = this._correct(ctx, preview, record, session, picker) ?? raw;
            }

            if (shown !== raw)
                note = 'corrected';
        } else {
            // Anything else (session, app grid, ...): keep the picker box in
            // sync with the live window geometry.
            this._pickerFor(windowId, session);
        }

        this._record(ctx, preview, windowInfo, raw, shown, note);
    }

    // Stores the picker geometry of a settled picker state. A frozen layout
    // is skipped: its slots belong to an older window arrangement and change
    // again as soon as the shell unfreezes them.
    _samplePicker(ctx, windowId, box, session) {
        // A frozen layout belongs to an older window arrangement (the shell
        // unfreezes it asynchronously), and a hidden overview has no picker
        // geometry at all - the state adjustment keeps its last value.
        if (ctx.layoutFrozen) {
            this._stats.frozen++;
        } else if (!Main.overview.visible) {
            this._stats.hidden++;
        } else {
            this._pickers.set(windowId, {box, session, frame: this._frame});
            this._stats.sample++;
            return true;
        }

        return false;
    }

    // Returns the picker box for a window, dropping it when the window has
    // been resized or moved in the meantime.
    _pickerFor(windowId, session) {
        const entry = this._pickers.get(windowId);
        if (!entry)
            return null;

        if (this._frame - entry.frame > PICKER_MAX_AGE_FRAMES) {
            this._pickers.delete(windowId);
            this._stats.dropAge++;
            return null;
        }

        if (Math.abs(entry.session.width - session.width) > SESSION_TOLERANCE ||
            Math.abs(entry.session.height - session.height) > SESSION_TOLERANCE) {
            this._pickers.delete(windowId);
            this._stats.dropSession++;
            return null;
        }

        return entry.box;
    }

    // Pins one preview to lerp(session, picker, t). Returns the resulting
    // stage-space box, or null when the correction cannot be applied.
    _correct(ctx, preview, record, session, picker) {
        const want = lerpBox(session, picker, ctx.t);
        const local = this._toContainer(ctx, want);
        const allocation = preview.allocation;
        const width = allocation.get_width();
        const height = allocation.get_height();

        if (local.width < MIN_SIZE || local.height < MIN_SIZE ||
            width < MIN_SIZE || height < MIN_SIZE)
            return null;

        // Pivot at the top-left, so the scale leaves the painted origin alone
        // and the translation below is the missing offset in the parent's
        // coordinate space (which is where :translation-x/y live).
        preview.set_pivot_point(0, 0);
        preview.set_scale(local.width / width, local.height / height);
        preview.translation_x = local.x - allocation.x1;
        preview.translation_y = local.y - allocation.y1;
        record.corrected = true;

        return stageBox(preview);
    }

    // Converts a stage-space box into the container's coordinate space.
    _toContainer(ctx, box) {
        const {origin, scale} = ctx.transform;
        return {
            x: (box.x - origin.x) / scale.x,
            y: (box.y - origin.y) / scale.y,
            width: box.width / scale.x,
            height: box.height / scale.y,
        };
    }

    _record(ctx, preview, windowInfo, raw, shown, note) {
        if (!ctx.measure)
            return;

        const windowId = windowInfo.metaWindow.get_id();
        const picker = this._pickers.get(windowId);

        Measure.push({
            t: ctx.t,
            phase: ctx.phase,
            win: windowId,
            monitor: ctx.layout._monitorIndex,
            rec: this._records.get(preview)?.seq ?? 0,
            applied: note === 'corrected',
            note,
            raw: roundBox(raw),
            shown: roundBox(shown),
            session: roundBox(preview.boundingBox),
            picker: picker ? roundBox(picker.box) : null,
            stats: {...this._stats},
        });
    }

    _recordFor(preview) {
        let record = this._records.get(preview);
        if (!record) {
            record = {corrected: false, seq: this._sequence++};
            this._records.set(preview, record);
        }
        return record;
    }

    _pruneRecords(windows) {
        for (const preview of [...this._records.keys()]) {
            if (!windows.has(preview))
                this._records.delete(preview);
        }
    }
}

function roundBox(box) {
    if (!box)
        return null;

    const round = value => Math.round(value * 100) / 100;
    return {
        x: round(box.x), y: round(box.y),
        width: round(box.width), height: round(box.height),
    };
}
