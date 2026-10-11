// GNOME Shell 50 layout branch for the session <-> picker transition.
// Calculate final slots before the first frame, then allocate the previews
// directly. No preview transform and no cross-overview endpoint cache.
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsManager} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {FitMode, SecondaryMonitorDisplay} from 'resource:///org/gnome/shell/ui/workspacesView.js';

import {lerpBox, MIN_SIZE, parentTransform, stageBox} from './geometry.js';
import * as Measure from './measure.js';

export class NativeLayout {
    constructor(config, logError) {
        this._config = config;
        this._selected = config.values.engine !== 'transform';
        this._logError = logError;
        this._layouts = new Map();
        this._gestureSnapshots = new Map();
        this._sequence = 0;
        this._stats = {computed: 0, captured: 0};
        this._hidingId = Main.overview.connect('hiding', () => this.capturePicker());
        this._hiddenId = Main.overview.connect('hidden', () => {
            this._gestureSnapshots.clear();
            for (const state of this._layouts.values()) {
                state.path = null;
                state.snapshot = null;
            }
        });
    }

    get enabled() {
        return this._config.values.enabled && this._selected;
    }

    install(injections) {
        const engine = this;
        const controls = Main.overview._overview.controls;
        injections.overrideMethod(Object.getPrototypeOf(controls.layout_manager), '_computeWorkspacesBoxForState',
            original => function (state, box, searchHeight, dashHeight, thumbnailsHeight, spacing) {
                if (engine.enabled && state === 1 && engine._sessionTransition(this._stateAdjustment)) {
                    const thumbnails = this._workspacesThumbnails;
                    const fraction = thumbnails.should_show ? 1 : 0;
                    const [preferred] = thumbnails.get_preferred_height(box.get_width());
                    thumbnailsHeight = Math.min(preferred * fraction, box.get_height() * thumbnails.maxThumbnailScale);
                    // This method only reads these two fields from its receiver.
                    const context = {_workAreaBox: this._workAreaBox, _workspacesThumbnails: {expandFraction: fraction}};
                    return original.call(context, state, box, searchHeight, dashHeight, thumbnailsHeight, spacing);
                }
                return original.call(this, state, box, searchHeight, dashHeight, thumbnailsHeight, spacing);
            });
        injections.overrideMethod(SecondaryMonitorDisplay.prototype, '_getWorkspacesBoxForState',
            original => function (state, box, padding, thumbnailsHeight, spacing) {
                if (engine.enabled && state === 1 && engine._sessionTransition(this._overviewAdjustment)) {
                    const fraction = this._thumbnails.should_show ? 1 : 0;
                    const [preferred] = this._thumbnails.get_preferred_height(box.get_width());
                    thumbnailsHeight = Math.min(preferred * fraction, box.get_height() * this._thumbnails.maxThumbnailScale);
                    spacing = this.get_theme_node().get_length('spacing') * fraction;
                }
                return original.call(this, state, box, padding, thumbnailsHeight, spacing);
            });
        injections.overrideMethod(ControlsManager.prototype, 'gestureBegin', original => function (tracker) {
            // Gesture progress writes the adjustment directly; it does not use
            // the keyboard animation entry point or emit hiding at its start.
            engine.capturePicker(true);
            original.call(this, tracker);
        });
    }

    _sessionTransition(adjustment) {
        const params = adjustment.getStateTransitionParams();
        return Main.overview.visible && params.currentState <= 1 && params.initialState <= 1 && params.finalState <= 1 &&
            (params.transitioning || Main.overview.animationInProgress || Main.overview.closing);
    }

    allocate(layout, container, box) {
        if (!this.enabled || !this._sessionTransition(layout._overviewAdjustment) ||
            (layout._metaWorkspace && !layout._metaWorkspace.active))
            return false;
        const state = this._stateFor(layout, container);
        const t = Math.clamp(layout._stateAdjustment.value, 0, 1);
        if (state.path && layout._needsLayout)
            state.pendingLayout = true;
        if (!state.path) {
            const targets = state.snapshot ?? this._computeTargets(layout, container);
            if (!targets)
                return false;
            state.path = new Map([...targets].map(([preview, picker]) => [preview, {picker, session: {...preview.boundingBox}}]));
            state.lastT = null;
            state.direction = state.snapshot ? 'close' : 'open';
        }
        if (state.lastT !== null && Math.abs(t - state.lastT) > 1e-6)
            state.direction = t > state.lastT ? 'open' : 'close';
        state.lastT = t;
        container.remove_clip();
        const transform = parentTransform(container);
        if (!Number.isFinite(transform.scale.x) || !Number.isFinite(transform.scale.y) || transform.scale.x <= 0 || transform.scale.y <= 0)
            return false;
        for (const [preview, info] of layout._windows) {
            try {
                if (!preview.visible)
                    continue;
                let endpoint = state.path.get(preview);
                if (!endpoint) {
                    // Newly mapped windows need a target too, but existing
                    // paths remain fixed until this transition finishes.
                    const target = this._computeTargets(layout, container)?.get(preview);
                    if (!target) {
                        preview.allocate(preview.allocation);
                        continue;
                    }
                    endpoint = {picker: target, session: {...preview.boundingBox}};
                    state.path.set(preview, endpoint);
                    state.pendingLayout = true;
                }
                const session = info.metaWindow.showing_on_its_workspace()
                    ? endpoint.session : {...endpoint.session, width: 0, height: 0};
                const desired = lerpBox(session, endpoint.picker, t);
                const childBox = this._allocationFor(preview, desired, transform);
                if (!childBox) {
                    preview.allocate(preview.allocation);
                    continue;
                }
                let note = 'allocated';
                if (preview.get_transition('scale-x') || preview.get_transition('scale-y'))
                    note = 'busy';
                if (preview.inDrag) {
                    preview.allocate(preview.allocation);
                    note = 'busy';
                } else if (info.currentTransition) {
                    info.currentTransition.get_interval().set_final(childBox);
                    preview.allocate(preview.allocation);
                    note = 'busy';
                } else {
                    preview.allocate(childBox);
                }
                this._record(layout, state, preview, info, 'transition', note, desired, endpoint.picker, session);
            } catch (e) {
                this._logError('allocating a native preview failed', e);
                preview.allocate(preview.allocation);
            }
        }
        layout._lastBox = container.allocation.copy();
        return true;
    }

    // Undo the content's own centered hover scale in the allocation geometry.
    // The scale animation remains Shell-owned; the outer actor is untouched.
    _allocationFor(preview, desired, transform) {
        const content = preview.window_container;
        const sx = content.scale_x;
        const sy = content.scale_y;
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0)
            return null;
        const local = {x: (desired.x - transform.origin.x) / transform.scale.x,
            y: (desired.y - transform.origin.y) / transform.scale.y,
            width: desired.width / transform.scale.x, height: desired.height / transform.scale.y};
        const width = Math.max(local.width / sx, MIN_SIZE);
        const height = Math.max(local.height / sy, MIN_SIZE);
        const box = new Clutter.ActorBox();
        box.set_origin(local.x + (local.width - width) / 2, local.y + (local.height - height) / 2);
        box.set_size(width, height);
        return box;
    }

    _computeTargets(layout, container) {
        const target = this._pickerContainer(layout, container);
        if (!target || target.width < MIN_SIZE || target.height < MIN_SIZE)
            return null;
        this._stateFor(layout, container).projectedContainer = target;
        if (layout._needsLayout || !layout._layout) {
            layout._layout = layout._createBestLayout(layout._workarea);
            layout._needsLayout = false;
        }
        const slotsBox = new Clutter.ActorBox({x2: target.width, y2: target.height});
        const first = layout._sortedWindows[0];
        if (first) {
            const oversize = Math.max(...first.chromeHeights(), ...first.chromeWidths());
            const [, overlap] = first.overlapHeights();
            const monitor = Main.layoutManager.monitors[layout._monitorIndex];
            const free = monitor.y + monitor.height - (target.y + target.height);
            slotsBox.y2 -= Math.max(0, overlap + oversize - free);
        }
        const area = {x: Math.trunc(slotsBox.x1), y: Math.trunc(slotsBox.y1),
            width: Math.trunc(slotsBox.get_width()), height: Math.trunc(slotsBox.get_height())};
        const slots = layout._layoutStrategy.computeWindowSlots(layout._layout, area);
        layout._windowSlotsBox = slotsBox;
        layout._windowSlots = slots;
        this._stats.computed++;
        return new Map(slots.map(([x, y, width, height, preview]) =>
            [preview, {x: target.x + x, y: target.y + y, width, height}]));
    }

    _pickerContainer(layout, container) {
        const workspace = container.get_parent();
        const view = workspace.get_parent();
        const controls = Main.overview._overview.controls;
        let viewBox;
        let transform;
        if (layout._monitorIndex === Main.layoutManager.primaryIndex) {
            viewBox = controls.getWorkspacesBoxForState(1)?.copy();
            transform = parentTransform(controls);
            if (viewBox) {
                // WorkspacesDisplay's BinLayout fills its view and rounds the
                // child size up. The cached controls box itself is fractional.
                const content = controls._workspacesDisplay.get_theme_node().get_content_box(
                    new Clutter.ActorBox({x2: viewBox.get_width(), y2: viewBox.get_height()}));
                viewBox.set_origin(viewBox.x1 + Math.floor(content.x1), viewBox.y1 + Math.floor(content.y1));
                viewBox.set_size(Math.ceil(content.get_width()), Math.ceil(content.get_height()));
            }
        } else {
            const display = view.get_parent();
            const content = display.get_theme_node().get_content_box(display.allocation);
            const padding = Math.round(0.1 * content.get_height());
            viewBox = display._getWorkspacesBoxForState(1, content, padding, 0, 0);
            transform = parentTransform(display);
        }
        if (!viewBox)
            return null;
        const offset = new Clutter.ActorBox({x2: viewBox.get_width(), y2: viewBox.get_height()});
        let workspaceBox;
        if (view._workspaces) {
            const vertical = global.workspace_manager.layout_rows === -1;
            const spacing = view._getSpacing(offset, FitMode.SINGLE, vertical);
            workspaceBox = view._getFirstFitSingleWorkspaceBox(offset, spacing, vertical);
            const rtl = view.text_direction === Clutter.TextDirection.RTL;
            const index = rtl ? view._workspaces.length - view._workspaces.indexOf(workspace) - 1 : view._workspaces.indexOf(workspace);
            workspaceBox.set_origin(workspaceBox.x1 + (vertical ? 0 : index * (workspaceBox.get_width() + spacing)),
                workspaceBox.y1 + (vertical ? index * (workspaceBox.get_height() + spacing) : 0));
            workspaceBox = alignedWorkspaceBox(workspace, workspaceBox);
        } else {
            const height = offset.get_height();
            const [, width] = workspace.get_preferred_width(height);
            workspaceBox = new Clutter.ActorBox({x1: Math.round((offset.get_width() - width) / 2)});
            workspaceBox.set_size(width, height);
        }
        const contentBox = workspace.get_theme_node().get_content_box(new Clutter.ActorBox({x2: workspaceBox.get_width(), y2: workspaceBox.get_height()}));
        return {x: transform.origin.x + (viewBox.x1 + workspaceBox.x1 + contentBox.x1) * transform.scale.x,
            y: transform.origin.y + (viewBox.y1 + workspaceBox.y1 + contentBox.y1) * transform.scale.y,
            width: contentBox.get_width() * transform.scale.x, height: contentBox.get_height() * transform.scale.y};
    }

    capturePicker(transfer = false) {
        if (!this.enabled)
            return;
        if (transfer)
            this._gestureSnapshots.clear();
        for (const [layout, state] of this._layouts) {
            if (layout._stateAdjustment.value !== 1 || layout._overviewAdjustment.value !== 1)
                continue;
            if (layout._metaWorkspace && !layout._metaWorkspace.active)
                continue;
            state.path = null;
            state.snapshot = new Map();
            const snapshots = new Map();
            for (const [preview, info] of layout._windows) {
                try {
                    if (preview.inDrag || !info.metaWindow.showing_on_its_workspace())
                        continue;
                    const picker = stageBox(preview.window_container);
                    state.snapshot.set(preview, picker);
                    snapshots.set(info.metaWindow.get_id(), {picker, hover: preview._overlayShown});
                } catch (e) {
                    this._logError('capturing a disposed native preview failed', e);
                }
            }
            if (transfer)
                this._gestureSnapshots.set(this._workspaceKey(layout), snapshots);
            this._stats.captured++;
        }
    }

    prepareOriginal(layout) {
        const state = this._layouts.get(layout);
        if (state?.pendingLayout) {
            // Let the original vfunc animate a queued reshuffle from the last
            // allocated endpoint, rather than first applying changed slots.
            state.pendingLayout = false;
            layout._needsLayout = true;
        }
    }

    observe(layout, container) {
        const state = this._stateFor(layout, container);
        state.path = null;
        state.snapshot = null;
        if (this.enabled && layout._stateAdjustment.value === 1 && !this._sessionTransition(layout._overviewAdjustment)) {
            for (const [preview, info] of layout._windows) {
                if (state.restoreHover?.has(info.metaWindow.get_id()))
                    preview.showOverlay(false);
            }
            state.restoreHover = null;
        }
        if (!Measure.isEnabled(this._config))
            return;
        const t = layout._stateAdjustment.value;
        const phase = this._sessionTransition(layout._overviewAdjustment) ? 'transition' : !Main.overview.visible ? 'hidden' : t === 1 ? 'picker' : 'session';
        state.direction = Main.overview.closing ? 'close' : 'open';
        for (const [preview, info] of layout._windows)
            this._record(layout, state, preview, info, phase, this.enabled ? phase : 'disabled', null, null, preview.boundingBox);
    }

    _stateFor(layout, container) {
        let state = this._layouts.get(layout);
        if (!state) {
            state = {container, path: null, snapshot: null, seq: this._sequence++, pendingLayout: false};
            state.destroyId = container.connect('destroy', () => this._layouts.delete(layout));
            // gestureBegin rebuilds Workspace views, even from a shown picker.
            // Transfer only this gesture's snapshot to the new preview actors.
            const snapshots = this._gestureSnapshots.get(this._workspaceKey(layout));
            if (snapshots) {
                state.snapshot = new Map();
                state.restoreHover = new Set();
                for (const [preview, info] of layout._windows) {
                    const snapshot = snapshots.get(info.metaWindow.get_id());
                    if (snapshot) {
                        state.snapshot.set(preview, snapshot.picker);
                        if (snapshot.hover)
                            state.restoreHover.add(info.metaWindow.get_id());
                    }
                }
                this._gestureSnapshots.delete(this._workspaceKey(layout));
            }
            this._layouts.set(layout, state);
        }
        return state;
    }

    _workspaceKey(layout) {
        return `${layout._monitorIndex}:${layout._metaWorkspace?.index?.() ?? 'extra'}`;
    }

    _record(layout, state, preview, info, phase, note, desired, picker, session) {
        if (!Measure.isEnabled(this._config))
            return;
        const shown = stageBox(preview.window_container);
        Measure.push({engine: 'native', t: layout._stateAdjustment.value, phase, direction: state.direction,
            win: info.metaWindow.get_id(), monitor: layout._monitorIndex, rec: state.seq, applied: note === 'allocated', note,
            raw: roundBox(shown), shown: roundBox(shown), desired: roundBox(desired), session: roundBox(session),
            picker: roundBox(picker), slot: roundBox(stageBox(preview)),
            projectedContainer: roundBox(state.projectedContainer), container: roundBox(stageBox(state.container)), stats: {...this._stats}});
    }

    clear() {
        for (const [layout, state] of this._layouts) {
            state.container.disconnect(state.destroyId);
            layout._needsLayout = true;
            state.container.queue_relayout();
        }
        this._layouts.clear();
        this._gestureSnapshots.clear();
    }

    destroy() {
        this.clear();
        Main.overview.disconnect(this._hidingId);
        Main.overview.disconnect(this._hiddenId);
    }
}

function roundBox(box) {
    return box && Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(box[key] * 100) / 100]));
}

// WorkspacesView uses clutter_actor_allocate_align_fill(..., .5, .5, false,
// false). Match its preferred-size selection and pixel alignment, otherwise
// a fractional workspace width shifts the endpoint at the steady-state handoff.
function alignedWorkspaceBox(actor, box) {
    const availableWidth = box.get_width();
    const availableHeight = box.get_height();
    let width;
    let height;
    if (actor.request_mode === Clutter.RequestMode.WIDTH_FOR_HEIGHT) {
        const [minHeight, naturalHeight] = actor.get_preferred_height(availableWidth);
        height = Math.clamp(naturalHeight, minHeight, availableHeight);
        const [minWidth, naturalWidth] = actor.get_preferred_width(height);
        width = Math.clamp(naturalWidth, minWidth, availableWidth);
    } else {
        const [minWidth, naturalWidth] = actor.get_preferred_width(availableHeight);
        width = Math.clamp(naturalWidth, minWidth, availableWidth);
        const [minHeight, naturalHeight] = actor.get_preferred_height(width);
        height = Math.clamp(naturalHeight, minHeight, availableHeight);
    }
    const x = Math.floor(Math.fround(box.x1 + Math.fround((availableWidth - width) / 2)));
    const y = Math.floor(Math.fround(box.y1 + Math.fround((availableHeight - height) / 2)));
    return new Clutter.ActorBox({x1: x, y1: y,
        x2: Math.ceil(Math.fround(x + width)), y2: Math.ceil(Math.fround(y + height))});
}
