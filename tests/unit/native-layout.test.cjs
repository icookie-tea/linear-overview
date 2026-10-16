// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');

class Signals {
    constructor() { this.handlers = new Map(); this.nextId = 1; this.queued = 0; }
    connect(name, callback) { const id = this.nextId++; this.handlers.set(id, {name, callback}); return id; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name) { for (const handler of [...this.handlers.values()]) if (handler.name === name) handler.callback(this); }
    queue_relayout() { this.queued++; }
}
class ActorBox {
    constructor(values = {}) { Object.assign(this, {x1: 0, y1: 0, x2: 0, y2: 0}, values); }
    get_width() { return this.x2 - this.x1; }
    get_height() { return this.y2 - this.y1; }
    get_size() { return [this.get_width(), this.get_height()]; }
    set_origin(x, y) { const [w, h] = this.get_size(); this.x1 = x; this.y1 = y; this.set_size(w, h); }
    set_size(w, h) { this.x2 = this.x1 + w; this.y2 = this.y1 + h; }
    copy() { return new ActorBox(this); }
    equal(other) { return ['x1', 'y1', 'x2', 'y2'].every(key => this[key] === other[key]); }
}
function fixture() {
    const overview = Object.assign(new Signals(), {visible: true, animationInProgress: true, closing: false});
    const frames = [];
    const math = Object.create(Math);
    math.clamp = (x, lower, upper) => Math.min(upper, Math.max(lower, x));
    const controls = {getWorkspacesBoxForState: () => new ActorBox({y1: 100, x2: 1280, y2: 700}),
        layout_manager: {},
        _thumbnailsBox: {should_show: true},
        apply_relative_transform_to_point: (_, point) => point,
        _workspacesDisplay: {get_theme_node: () => ({get_content_box: box => box.copy()})}};
    overview._overview = {controls};
    const context = vm.createContext({Math: math,
        Main: {overview, layoutManager: {primaryIndex: 0, monitors: [{x: 0, y: 0, width: 1280, height: 800}]}},
        Graphene: {Point3D: class {constructor(p = {}) {Object.assign(this, {x: 0, y: 0, z: 0}, p);}}},
        Clutter: {ActorBox, RequestMode: {WIDTH_FOR_HEIGHT: 1}, TextDirection: {RTL: 1}},
        ControlsManager: class {}, SecondaryMonitorDisplay: class {}, ThumbnailsBox: class {}, FitMode: {SINGLE: 0},
        global: {workspace_manager: {layout_rows: 1}},
        Measure: {isEnabled: () => true, push: frame => frames.push(frame)},
    });
    for (const file of ['geometry.js', 'nativeLayout.js']) {
        const source = fs.readFileSync(path.resolve(__dirname, '../../lib', file), 'utf8')
            .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
        vm.runInContext(source + (file === 'nativeLayout.js' ? '\nthis.NativeLayout = NativeLayout;' : ''), context);
    }
    const config = {values: {enabled: true, engine: 'native'}};
    const engine = new context.NativeLayout(config, (message, error) => {throw error ?? new Error(message);});
    const workspace = {request_mode: 1, visible: true, scale_x: 1, scale_y: 1,
        get_preferred_width: height => [0, height * 5 / 3], get_preferred_height: width => [0, width * 3 / 5],
        get_theme_node: () => ({get_content_box: box => box.copy()})};
    const view = {_workspaces: [workspace], text_direction: 0, _scrollAdjustment: {value: 0, upper: 1},
        allocation: new ActorBox({x2: 1280, y2: 600}), apply_relative_transform_to_point: (_, point) => ({x: point.x, y: 100 + point.y}),
        _getSpacing: () => 24, _getFirstFitSingleWorkspaceBox(box, spacing) {
            const width = box.get_height() * 5 / 3;
            const result = new ActorBox({x1: (box.get_width() - width) / 2 - this._scrollAdjustment.value * (width + spacing)});
            result.set_size(box.get_height() * 5 / 3, box.get_height());
            return result;
        }};
    workspace.get_parent = () => view;
    const container = Object.assign(new Signals(), {origin: {x: 0, y: 0}, scale: {x: 1, y: 1},
        allocation: new ActorBox({x2: 1280, y2: 768}), get_parent: () => workspace, remove_clip() {}});
    container.apply_relative_transform_to_point = (_, p) => ({x: container.origin.x + p.x * container.scale.x,
        y: container.origin.y + p.y * container.scale.y});
    container.get_transformed_position = () => [container.origin.x, container.origin.y];
    container.get_transformed_size = () => [container.allocation.get_width() * container.scale.x, container.allocation.get_height() * container.scale.y];
    const preview = {visible: true, inDrag: false, scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
        boundingBox: {x: 230, y: 176, width: 589, height: 336}, allocation: new ActorBox({x2: 589, y2: 336}),
        get_transition: () => null,
        chromeHeights: () => [10, 10], chromeWidths: () => [10, 10], overlapHeights: () => [0, 0],
        allocate(box) { this.allocation = box.copy(); },
        window_container: {scale_x: 1, scale_y: 1}};
    function geometry(content = true) {
        const box = preview.allocation;
        const sx = content ? preview.window_container.scale_x : 1;
        const sy = content ? preview.window_container.scale_y : 1;
        return {x: container.origin.x + (box.x1 + box.get_width() * (1 - sx) / 2) * container.scale.x,
            y: container.origin.y + (box.y1 + box.get_height() * (1 - sy) / 2) * container.scale.y,
            width: box.get_width() * sx * container.scale.x, height: box.get_height() * sy * container.scale.y};
    }
    for (const [actor, content] of [[preview, false], [preview.window_container, true]]) {
        actor.get_transformed_position = () => { const b = geometry(content); return [b.x, b.y]; };
        actor.get_transformed_size = () => { const b = geometry(content); return [b.width, b.height]; };
    }
    Object.defineProperty(preview.window_container, 'allocation', {get: () =>
        new ActorBox({x2: preview.allocation.get_width(), y2: preview.allocation.get_height()})});
    preview.window_container.apply_relative_transform_to_point = (_, point) => {
        const b = geometry();
        return {x: b.x + point.x * preview.window_container.scale_x * container.scale.x,
            y: b.y + point.y * preview.window_container.scale_y * container.scale.y};
    };
    const info = {metaWindow: {get_id: () => 1, showing_on_its_workspace: () => true}, currentTransition: null};
    const areas = [];
    const layout = {_metaWorkspace: {active: true}, _monitorIndex: 0, _needsLayout: true,
        _workarea: {x: 0, y: 32, width: 1280, height: 768}, _sortedWindows: [preview], _windows: new Map([[preview, info]]),
        _stateAdjustment: {value: 0}, params: {transitioning: true, currentState: 0, initialState: 0, finalState: 1},
        _createBestLayout: () => ({}), _layoutStrategy: {computeWindowSlots: (_, area) => {
            areas.push({...area}); return [[area.width / 2 - 250, area.height / 2 - 150, 500, 300, preview]];
        }}};
    layout._getWindowSlots = box => layout._layoutStrategy.computeWindowSlots(layout._layout,
        {x: box.x1, y: box.y1, width: box.get_width(), height: box.get_height()});
    layout.notify = () => {};
    layout._overviewAdjustment = {value: 0, getStateTransitionParams: () => layout.params};
    controls._stateAdjustment = layout._overviewAdjustment;
    function at(t, closing = false) {
        layout._stateAdjustment.value = t;
        layout._overviewAdjustment.value = t;
        layout.params = {transitioning: true, currentState: t, initialState: closing ? 1 : 0, finalState: closing ? 0 : 1};
        overview.closing = closing;
        assert.equal(engine.allocate(layout, container, container.allocation), true);
    }
    return {overview, controls, config, engine, frames, preview, layout, container, workspace, view, areas, at, geometry};
}
function equalBox(actual, expected) {
    for (const key of ['x', 'y', 'width', 'height'])
        assert(Math.abs(actual[key] - expected[key]) < 0.0001, `${key}: ${actual[key]} != ${expected[key]}`);
}
function interpolate(a, b, t) {
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, a[k] + (b[k] - a[k]) * t]));
}

test('cold opening calculates the final picker once and allocates content directly', () => {
    const f = fixture();
    const picker = {x: 390, y: 250, width: 500, height: 300};
    for (const t of [0, 0.1, 0.5, 0.9, 1]) {
        f.container.origin = {x: 100 * t, y: 60 * t};
        f.container.scale = {x: 1 - t * 0.2, y: 1 - t * 0.15};
        f.at(t);
        equalBox(f.geometry(), interpolate(f.preview.boundingBox, picker, t));
        assert.equal(f.preview.scale_x, 1);
        assert.equal(f.preview.translation_x, 0);
    }
    assert.equal(f.areas.length, 1);
    assert.deepEqual(f.areas[0], {x: 0, y: 0, width: 1000, height: 600});
});

test('outgoing workspace keeps its path and composes navigation when active changes mid-opening', () => {
    const f = fixture();
    const t = 0.35;
    const canonical = interpolate(f.preview.boundingBox, {x: 390, y: 250, width: 500, height: 300}, t);
    f.container.allocation.set_size(1000, 600);
    for (const scroll of [0, 0.25, 0.5, 0.75, 1, 0.5, 0]) {
        const scale = 1 - 0.05 * scroll;
        f.layout._metaWorkspace.active = scroll === 0;
        f.view._scrollAdjustment.value = scroll;
        f.workspace.scale_x = f.workspace.scale_y = scale;
        f.container.scale = {x: scale, y: scale};
        f.container.origin = {x: 140 - scroll * 1024 + 1000 * (1 - scale) / 2, y: 100 + 600 * (1 - scale) / 2};
        f.at(t);
        equalBox(f.geometry(), {x: f.container.origin.x + (canonical.x - 140) * scale,
            y: f.container.origin.y + (canonical.y - 100) * scale, width: canonical.width * scale, height: canonical.height * scale});
    }
    assert.equal(f.areas.length, 1, 'navigation never replaces the overview endpoints');
});

test('workspace-count thumbnail decisions wait for transition completion and release actor state', () => {
    for (const release of ['shown', 'hidden', 'gesture', 'disable']) {
        const f = fixture();
        const hooks = new Map();
        f.engine.install({overrideMethod(_, name, create) {
            const original = name === '_updateShouldShow' ? function () { this._shouldShow = this.wanted; this.notify('should-show'); }
                : name === 'gestureEnd' ? function (_target, _duration, complete) { complete(); } : () => {};
            hooks.set(name, create(original));
        }});
        const actor = Object.assign(new Signals(), {_shouldShow: false, wanted: true, notifications: 0,
            notify() { this.notifications++; }});
        const update = hooks.get('_updateShouldShow');
        update.call(actor);
        assert.equal(actor._shouldShow, true, 'initial visibility is calculated before any geometry is fixed');
        f.controls._thumbnailsBox.should_show = false;
        f.at(0.35);
        update.call(actor);
        assert.equal(actor._shouldShow, false, 'a recreated thumbnail box adopts the fixed transition decision');
        assert.equal(f.engine._pendingThumbnails.size, 1);
        if (release === 'disable') {
            f.engine.destroy();
        } else if (release === 'gesture') {
            let completed = false;
            hooks.get('gestureEnd')(1, 180, () => { completed = true; });
            assert(completed, 'Shell completion callback still runs');
        } else {
            f.overview.emit(release);
        }
        assert.equal(actor._shouldShow, true, 'the original visibility decision is applied after completion');
        assert.equal(f.engine._pendingThumbnails.size, 0);
        assert.equal(f.engine._geometryStarted, false);
        if (release !== 'disable')
            f.engine.destroy();
        assert.equal(actor.handlers.size, 0);
        assert.equal(f.engine._thumbnailActors.size, 0);
    }
});

test('incoming visible workspace starts with centered targets before it becomes active', () => {
    const f = fixture();
    f.view._workspaces.unshift({...f.workspace});
    f.view._scrollAdjustment.upper = 2;
    f.container.allocation.set_size(1000, 600);
    const canonical = interpolate(f.preview.boundingBox, {x: 390, y: 250, width: 500, height: 300}, 0.35);
    for (const scroll of [0, 0.25, 0.5, 0.75, 1]) {
        const scale = 0.95 + 0.05 * scroll;
        f.layout._metaWorkspace.active = scroll === 1;
        f.view._scrollAdjustment.value = scroll;
        f.workspace.scale_x = f.workspace.scale_y = scale;
        f.container.scale = {x: scale, y: scale};
        f.container.origin = {x: 140 + (1 - scroll) * 1024 + 1000 * (1 - scale) / 2, y: 100 + 600 * (1 - scale) / 2};
        f.at(0.35);
        equalBox(f.geometry(), {x: f.container.origin.x + (canonical.x - 140) * scale,
            y: f.container.origin.y + (canonical.y - 100) * scale, width: canonical.width * scale, height: canonical.height * scale});
    }
    assert.equal(f.areas.length, 1);
});

test('closing snapshot removes navigation before replaying it on an inactive visible workspace', () => {
    const f = fixture();
    f.container.allocation.set_size(1000, 600);
    f.layout._metaWorkspace.active = false;
    f.view._scrollAdjustment.value = 0.5;
    f.workspace.scale_x = f.workspace.scale_y = 0.975;
    f.container.scale = {x: 0.975, y: 0.975};
    f.container.origin = {x: 140 - 512 + 12.5, y: 107.5};
    f.at(1);
    f.preview.window_container.scale_x = f.preview.window_container.scale_y = 1.03;
    const before = f.geometry();
    const picker = {x: 140 + (before.x - f.container.origin.x) / 0.975, y: 100 + (before.y - 107.5) / 0.975,
        width: before.width / 0.975, height: before.height / 0.975};
    f.overview.animationInProgress = false;
    f.layout.params = {transitioning: false, currentState: 1, initialState: 1, finalState: 1};
    f.engine.observe(f.layout, f.container);
    f.overview.emit('hiding');
    f.overview.animationInProgress = true;
    for (const t of [1, 0.7, 0.3, 0]) {
        const canonical = interpolate(f.preview.boundingBox, picker, t);
        f.at(t, true);
        equalBox(f.geometry(), {x: f.container.origin.x + (canonical.x - 140) * 0.975,
            y: f.container.origin.y + (canonical.y - 100) * 0.975, width: canonical.width * 0.975, height: canonical.height * 0.975});
    }
});

test('secondary picker respects primary-only policy even when thumbnails should_show is true', () => {
    for (const primaryOnly of [true, false]) {
        const f = fixture();
        const hooks = new Map();
        const original = function (state, box, padding, thumbnailsHeight, spacing) {
            const result = box.copy();
            if (state === 1) {
                result.set_origin(0, padding + thumbnailsHeight + spacing);
                result.set_size(box.get_width(), box.get_height() - 2 * padding - thumbnailsHeight - spacing);
            }
            return result;
        };
        f.engine.install({overrideMethod(_, name, create) { hooks.set(name, create(original)); }});
        const display = {_overviewAdjustment: f.layout._overviewAdjustment,
            _settings: {get_boolean: key => { assert.equal(key, 'workspaces-only-on-primary'); return primaryOnly; }},
            _thumbnails: {should_show: true, visible: !primaryOnly, maxThumbnailScale: 0.12, get_preferred_height: () => [108, 108]},
            get_theme_node: () => ({get_length: () => 12})};
        const hook = hooks.get('_getWorkspacesBoxForState');
        const box = new ActorBox({x2: 1600, y2: 900});
        const height = primaryOnly ? 0 : 108;
        const spacing = primaryOnly ? 0 : 12;
        const actual = hook.call(display, 1, box, 90, 0, 0);
        assert.equal(actual.y1, primaryOnly ? 90 : 210);
        assert.equal(actual.get_height(), primaryOnly ? 720 : 600);
        f.overview.animationInProgress = false;
        f.layout.params = {transitioning: false, currentState: 1, initialState: 1, finalState: 1};
        assert(actual.equal(hook.call(display, 1, box, 90, height, spacing)), 'the transition and original steady boxes must agree');
        f.overview.animationInProgress = true;
        f.layout.params.transitioning = true;
        f.config.values.enabled = false;
        assert(hook.call(display, 1, box, 90, 37, 5).equal(original(1, box, 90, 37, 5)), 'disabled allocation delegates unchanged');
    }
});

test('workspace measurement uses allocation even when hover invalidates the preferred size', () => {
    const f = fixture();
    f.container.allocation.set_size(1000, 600);
    f.container.origin = {x: 50, y: 30};
    f.container.scale = {x: 0.9, y: 0.8};
    f.container.get_transformed_size = () => [1280, 768];
    f.at(0.5);
    equalBox(f.frames.at(-1).container, {x: 50, y: 30, width: 900, height: 480});
});

test('activating a minimized preview closes from its allocated content after preferred-size invalidation', () => {
    for (const hover of [1, 1.04]) {
        const f = fixture();
        f.layout._stateAdjustment.value = 1;
        f.layout._overviewAdjustment.value = 1;
        f.overview.animationInProgress = false;
        f.layout.params = {transitioning: false, currentState: 1, initialState: 1, finalState: 1};
        f.preview.allocate(new ActorBox({x1: 390, y1: 250, x2: 890, y2: 550}));
        f.preview.window_container.scale_x = hover;
        f.preview.window_container.scale_y = hover;
        f.engine.observe(f.layout, f.container);
        const picker = f.geometry();
        // Mutter restores the selected window before Main.overview.hide().
        // The allocation still shows the picker, but a size query now returns
        // the larger natural desktop dimensions until Clutter allocates again.
        f.preview.window_container.get_transformed_size = () => [589 * hover, 336 * hover];
        f.overview.emit('hiding');
        f.overview.animationInProgress = true;
        for (const t of [1, 0.9, 0.5, 0.1, 0]) {
            f.preview.window_container.scale_x = 1 + (hover - 1) * t;
            f.preview.window_container.scale_y = 1 + (hover - 1) * t;
            f.at(t, true);
            equalBox(f.geometry(), interpolate(f.preview.boundingBox, picker, t));
        }
        assert.equal(f.areas.length, 0, 'activation uses the displayed snapshot, not a recomputed picker');
    }
});

test('minimized previews start at the workarea origin with slot size, not at their saved frame', () => {
    const f = fixture();
    f.layout._windows.get(f.preview).metaWindow.showing_on_its_workspace = () => false;
    f.layout._workarea.x = 1280;
    f.layout._workarea.y = 48;
    for (const t of [0, 0.1, 0.5, 0.9, 1, 0.7, 0]) {
        f.container.allocation.set_size(1280 - 280 * t, 768 - 168 * t);
        f.at(t);
        const allocationScale = f.container.allocation.get_width() / 1280;
        // Shell's original vfunc lerps the workarea origin to a current slot
        // and clamps the floating size to that slot before interpolation.
        const origin = {x: 1280 * allocationScale, y: 48 * allocationScale, width: 500, height: 300};
        const slot = {x: f.container.allocation.get_width() / 2 - 250,
            y: f.container.allocation.get_height() / 2 - 150, width: 500, height: 300};
        const box = f.preview.allocation;
        equalBox({x: box.x1, y: box.y1, width: box.get_width(), height: box.get_height()}, interpolate(origin, slot, t));
        assert.equal(f.frames.at(-1).note, 'shell-minimized');
        assert.equal(f.frames.at(-1).session, null);
    }
});

test('minimized closing retains frozen shell slots and unfreezes on gesture allocation changes', () => {
    const f = fixture();
    f.layout._windows.get(f.preview).metaWindow.showing_on_its_workspace = () => false;
    f.layout._layoutFrozen = true;
    f.layout._lastBox = f.container.allocation.copy();
    f.layout._windowSlotsBox = f.container.allocation.copy();
    f.layout._windowSlots = [[120, 80, 400, 240, f.preview]];
    f.at(1, true);
    equalBox(f.geometry(), {x: 120, y: 80, width: 400, height: 240});
    f.container.allocation.set_size(1408, 844.8);
    f.at(0, true);
    equalBox(f.geometry(), {x: 0, y: 35.2, width: 440, height: 264});
    assert.equal(f.layout._layoutFrozen, true);
    f.overview.animationInProgress = false;
    f.container.allocation.set_size(1280, 768);
    f.at(0.4, true);
    assert.equal(f.layout._layoutFrozen, false);
    assert.equal(f.preview.allocation.get_width(), 500);
});

test('an all-minimized picker gesture builds slots after workspace views are recreated', () => {
    const f = fixture();
    f.layout._metaWorkspace.index = () => 0;
    f.layout._windows.get(f.preview).metaWindow.showing_on_its_workspace = () => false;
    f.at(1);
    f.engine.capturePicker(true);
    f.container.emit('destroy');
    const replacement = fixture();
    replacement.layout._metaWorkspace.index = () => 0;
    replacement.layout._windows.get(replacement.preview).metaWindow.showing_on_its_workspace = () => false;
    replacement.layout._stateAdjustment.value = 0.6;
    replacement.layout._overviewAdjustment.value = 0.6;
    replacement.layout.params = {transitioning: true, currentState: 0.6, initialState: 1, finalState: 0};
    f.engine.allocate(replacement.layout, replacement.container, replacement.container.allocation);
    equalBox(replacement.geometry(), {x: 234, y: 153.2, width: 500, height: 300});
    assert(replacement.layout._layout, 'the empty closing snapshot still needs a shell layout');
    assert.equal(f.engine._gestureSnapshots.size, 0);
});

test('closing a hovered preview reaches the real frame at visible zero', () => {
    const f = fixture();
    f.at(1);
    f.overview.animationInProgress = false;
    f.layout.params = {transitioning: false, currentState: 1, initialState: 1, finalState: 1};
    f.engine.observe(f.layout, f.container);
    f.preview.window_container.scale_x = 1.07;
    f.preview.window_container.scale_y = 1.07;
    const picker = f.geometry();
    f.overview.emit('hiding');
    f.overview.animationInProgress = true;
    for (const t of [1, 0.8, 0.4, 0.004, 0]) {
        f.preview.window_container.scale_x = 1 + 0.07 * t;
        f.preview.window_container.scale_y = 1 + 0.07 * t;
        f.at(t, true);
        equalBox(f.geometry(), interpolate(f.preview.boundingBox, picker, t));
    }
    assert.equal(f.areas.length, 1, 'close uses the displayed snapshot, not a recomputed layout');
});

test('gesture reversal keeps the same endpoints in both directions', () => {
    const f = fixture();
    const picker = {x: 390, y: 250, width: 500, height: 300};
    for (const t of [0.1, 0.4, 0.8, 0.4, 0.1, 0]) {
        f.at(t);
        equalBox(f.geometry(), interpolate(f.preview.boundingBox, picker, t));
    }
    assert.equal(f.areas.length, 1);
    assert.equal(f.frames.at(-1).direction, 'close');
});

test('picker gesture snapshot survives view recreation and restores hover on cancellation', () => {
    const f = fixture();
    f.at(1);
    f.layout._metaWorkspace.index = () => 0;
    f.overview.animationInProgress = false;
    f.layout.params = {transitioning: false, currentState: 1, initialState: 1, finalState: 1};
    f.preview._overlayShown = true;
    f.preview.window_container.scale_x = 1.02;
    f.preview.window_container.scale_y = 1.02;
    const picker = f.geometry();
    f.engine.capturePicker(true);
    f.container.emit('destroy');
    const replacement = fixture();
    replacement.layout._metaWorkspace.index = () => 0;
    replacement.layout._stateAdjustment.value = 0.6;
    replacement.layout._overviewAdjustment.value = 0.6;
    replacement.layout.params.currentState = 0.6;
    f.overview.animationInProgress = true;
    f.engine.allocate(replacement.layout, replacement.container, replacement.container.allocation);
    equalBox(replacement.geometry(), interpolate(replacement.preview.boundingBox, picker, 0.6));
    assert.equal(f.engine._gestureSnapshots.size, 0);
    replacement.layout._stateAdjustment.value = 1;
    replacement.layout.params = {transitioning: false, currentState: 1, initialState: 1, finalState: 1};
    f.overview.animationInProgress = false;
    replacement.preview.allocate(new ActorBox({x1: 390, y1: 250, x2: 890, y2: 550}));
    replacement.preview.showOverlay = () => {
        replacement.preview.window_container.scale_x = 1.02;
        replacement.preview.window_container.scale_y = 1.02;
    };
    f.engine.observe(replacement.layout, replacement.container);
    equalBox(replacement.geometry(), picker);
});

test('hidden workspace, app grid and disabled engine retain shell allocation', () => {
    for (const reason of ['hidden-workspace', 'app-grid', 'disabled', 'hidden']) {
        const f = fixture();
        if (reason === 'hidden-workspace') f.workspace.visible = false;
        if (reason === 'app-grid') f.layout.params.finalState = 2;
        if (reason === 'disabled') f.config.values.enabled = false;
        if (reason === 'hidden') f.overview.visible = false;
        assert.equal(f.engine.allocate(f.layout, f.container, f.container.allocation), false);
        assert.equal(f.areas.length, 0);
    }
});

test('layout changes during a path are handed to the shell before its steady allocation', () => {
    const f = fixture();
    f.at(0.1);
    f.layout._needsLayout = true;
    f.at(0.8);
    assert.equal(f.areas.length, 1, 'existing transition endpoints remain fixed');
    f.layout._needsLayout = false;
    f.engine.prepareOriginal(f.layout);
    assert.equal(f.layout._needsLayout, true);
    assert.equal(f.engine._layouts.get(f.layout).pendingLayout, false);
});

test('layout destruction and disable release state and schedule stock layout', () => {
    const f = fixture();
    f.at(0.5);
    assert.equal(f.engine._layouts.size, 1);
    f.container.emit('destroy');
    assert.equal(f.engine._layouts.size, 0);
    f.at(0.5);
    f.engine.destroy();
    assert.equal(f.engine._layouts.size, 0);
    assert.equal(f.overview.handlers.size, 0);
    assert.equal(f.layout._needsLayout, true);
    assert.equal(f.container.queued, 1);
});
