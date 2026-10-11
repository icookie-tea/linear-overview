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
}
function fixture() {
    const overview = Object.assign(new Signals(), {visible: true, animationInProgress: true, closing: false});
    const frames = [];
    const math = Object.create(Math);
    math.clamp = (x, lower, upper) => Math.min(upper, Math.max(lower, x));
    const controls = {getWorkspacesBoxForState: () => new ActorBox({y1: 100, x2: 1280, y2: 700}),
        apply_relative_transform_to_point: (_, point) => point,
        _workspacesDisplay: {get_theme_node: () => ({get_content_box: box => box.copy()})}};
    overview._overview = {controls};
    const context = vm.createContext({Math: math,
        Main: {overview, layoutManager: {primaryIndex: 0, monitors: [{x: 0, y: 0, width: 1280, height: 800}]}},
        Graphene: {Point3D: class {constructor(p = {}) {Object.assign(this, {x: 0, y: 0, z: 0}, p);}}},
        Clutter: {ActorBox, RequestMode: {WIDTH_FOR_HEIGHT: 1}, TextDirection: {RTL: 1}},
        ControlsManager: class {}, SecondaryMonitorDisplay: class {}, FitMode: {SINGLE: 0},
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
    const workspace = {request_mode: 1,
        get_preferred_width: height => [0, height * 5 / 3], get_preferred_height: width => [0, width * 3 / 5],
        get_theme_node: () => ({get_content_box: box => box.copy()})};
    const view = {_workspaces: [workspace], text_direction: 0,
        _getSpacing: () => 24, _getFirstFitSingleWorkspaceBox: box => {
            const result = new ActorBox({x1: (box.get_width() - box.get_height() * 5 / 3) / 2});
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
    const info = {metaWindow: {get_id: () => 1, showing_on_its_workspace: () => true}, currentTransition: null};
    const areas = [];
    const layout = {_metaWorkspace: {active: true}, _monitorIndex: 0, _needsLayout: true,
        _workarea: {x: 0, y: 32, width: 1280, height: 768}, _sortedWindows: [preview], _windows: new Map([[preview, info]]),
        _stateAdjustment: {value: 0}, params: {transitioning: true, currentState: 0, initialState: 0, finalState: 1},
        _createBestLayout: () => ({}), _layoutStrategy: {computeWindowSlots: (_, area) => {
            areas.push({...area}); return [[area.width / 2 - 250, area.height / 2 - 150, 500, 300, preview]];
        }}};
    layout._overviewAdjustment = {value: 0, getStateTransitionParams: () => layout.params};
    function at(t, closing = false) {
        layout._stateAdjustment.value = t;
        layout._overviewAdjustment.value = t;
        layout.params = {transitioning: true, currentState: t, initialState: closing ? 1 : 0, finalState: closing ? 0 : 1};
        overview.closing = closing;
        assert.equal(engine.allocate(layout, container, container.allocation), true);
    }
    return {overview, config, engine, frames, preview, layout, container, areas, at, geometry};
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

test('inactive workspace, app grid and disabled engine retain shell allocation', () => {
    for (const reason of ['inactive', 'app-grid', 'disabled', 'hidden']) {
        const f = fixture();
        if (reason === 'inactive') f.layout._metaWorkspace.active = false;
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
