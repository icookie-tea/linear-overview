// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
// Execute the production modules with actor doubles. These tests cover
// lifecycle and geometry contracts; the nested shell suite checks real actors.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const root = process.env.LO_SOURCE_ROOT || path.resolve(__dirname, '../..');

class Signals {
    constructor() { this.handlers = new Map(); this.nextId = 1; }
    connect(name, callback) { const id = this.nextId++; this.handlers.set(id, {name, callback}); return id; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name) { for (const handler of [...this.handlers.values()]) if (handler.name === name) handler.callback(this); }
    queue_relayout() {}
}

function environment() {
    const overview = Object.assign(new Signals(), {visible: true, animationInProgress: false, closing: false});
    const frames = [];
    const math = Object.create(Math);
    math.clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));
    const ctx = vm.createContext({Math: math, console,
        Main: {overview, layoutManager: {monitors: [{x: 0, y: 0, width: 1280, height: 800}]}},
        Graphene: {Point3D: class {constructor(value = {}) {Object.assign(this, {x: 0, y: 0, z: 0}, value);}}},
        Measure: {isEnabled: () => true, push: frame => frames.push(frame)},
        global: {workspace_manager: {n_workspaces: 2}},
    });
    for (const file of ['geometry.js', 'transition.js']) {
        const source = fs.readFileSync(path.join(root, 'lib', file), 'utf8')
            .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
        vm.runInContext(source + (file === 'transition.js' ? '\nthis.Corrector = Corrector;' : ''), ctx);
    }
    const config = {values: {enabled: true, scope: 'active-workspace', gate: 'session-picker'}};
    const corrector = new ctx.Corrector(config, (message, error) => {throw error ?? new Error(message);});
    return {overview, frames, config, corrector};
}

function actors(session = {x: 230, y: 176, width: 589, height: 336}, id = 1) {
    const container = Object.assign(new Signals(), {allocation: {x1: 0, y1: 0}, origin: {x: 0, y: 0}, scale: {x: 1, y: 1}});
    container.apply_relative_transform_to_point = (_, p) => ({x: container.origin.x + container.scale.x * p.x,
        y: container.origin.y + container.scale.y * p.y});
    container.get_parent = () => ({apply_relative_transform_to_point: (_, p) => p});
    const preview = Object.assign(new Signals(), {boundingBox: {...session},
        box: {x: 359, y: 246.4, width: 559.55, height: 319.2},
        scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
        pivot: [0, 0], inDrag: false, transitions: new Map()});
    Object.defineProperty(preview, 'allocation', {get: () => ({x1: preview.box.x, y1: preview.box.y,
        get_width: () => preview.box.width, get_height: () => preview.box.height})});
    preview.get_pivot_point = () => preview.pivot;
    preview.set_pivot_point = (x, y) => {preview.pivot = [x, y];};
    preview.set_scale = (x, y) => {preview.scale_x = x; preview.scale_y = y;};
    preview.get_transition = name => preview.transitions.get(name) ?? null;
    preview.window_container = {scale_x: 1, scale_y: 1};
    function geometry(content) {
        const box = preview.box;
        const hx = content ? preview.window_container.scale_x : 1;
        const hy = content ? preview.window_container.scale_y : 1;
        const x = box.x + preview.translation_x + preview.pivot[0] * box.width * (1 - preview.scale_x) + preview.scale_x * (1 - hx) * box.width / 2;
        const y = box.y + preview.translation_y + preview.pivot[1] * box.height * (1 - preview.scale_y) + preview.scale_y * (1 - hy) * box.height / 2;
        return {x: container.origin.x + x * container.scale.x, y: container.origin.y + y * container.scale.y,
            width: box.width * preview.scale_x * hx * container.scale.x,
            height: box.height * preview.scale_y * hy * container.scale.y};
    }
    for (const [actor, content] of [[preview, false], [preview.window_container, true]]) {
        actor.get_transformed_position = () => {const b = geometry(content); return [b.x, b.y];};
        actor.get_transformed_size = () => {const b = geometry(content); return [b.width, b.height];};
    }
    const info = {metaWindow: {get_id: () => id, showing_on_its_workspace: () => true}, currentTransition: null};
    const layout = {_windows: new Map([[preview, info]]), _monitorIndex: 0,
        _metaWorkspace: {active: true}, _workarea: {x: 0, y: 32, width: 1280, height: 768},
        _layoutFrozen: false, _stateAdjustment: {value: 1},
        params: {transitioning: false, initialState: 1, finalState: 1, currentState: 1}};
    layout._overviewAdjustment = {value: 1, getStateTransitionParams: () => layout.params};
    return {preview, info, layout, container, geometry};
}

function setTransition(env, actors, t, closing = false) {
    env.overview.animationInProgress = true;
    env.overview.closing = closing;
    actors.layout._stateAdjustment.value = t;
    actors.layout.params = {transitioning: true, initialState: closing ? 1 : 0,
        finalState: closing ? 0 : 1, currentState: t};
    actors.layout._overviewAdjustment.value = t;
}
function close(env, actors) {
    env.overview.closing = true;
    env.overview.animationInProgress = true;
    env.overview.emit('hiding');
    actors.layout._layoutFrozen = true;
}
function equalBox(actual, expected) {
    for (const key of ['x', 'y', 'width', 'height'])
        assert(Math.abs(actual[key] - expected[key]) < 0.0001, `${key}: ${actual[key]} != ${expected[key]}`);
}
function interpolate(a, b, t) {
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, a[key] + (b[key] - a[key]) * t]));
}

for (const hover of [1, 1.07]) {
    test(`closing content matches desktop through zero (hover scale ${hover})`, () => {
        const e = environment(); const a = actors();
        e.corrector.apply(a.layout, a.container, {});
        a.preview.window_container.scale_x = hover;
        a.preview.window_container.scale_y = hover;
        const picker = a.geometry(true);
        close(e, a);
        for (const t of [0.98, 0.5, 0.006, 0.004, 0]) {
            setTransition(e, a, t, true);
            a.preview.box = {x: 230 + 129 * t, y: 176 + 70.4 * t, width: 804 - 244.45 * t, height: 458 - 138.8 * t};
            a.preview.window_container.scale_x = 1 + (hover - 1) * t;
            a.preview.window_container.scale_y = 1 + (hover - 1) * t;
            e.corrector.apply(a.layout, a.container, {});
            equalBox(a.geometry(true), interpolate(a.preview.boundingBox, picker, t));
        }
        e.overview.visible = false;
        e.overview.closing = false;
        e.overview.emit('hidden');
        assert.equal(a.preview.scale_x, 1);
        assert.equal(a.preview.translation_x, 0);
        e.corrector.destroy?.();
    });
}

test('empty other workspace cannot forget an active correction or corrupt picker', () => {
    const e = environment(); const a = actors();
    const picker = a.geometry(false);
    e.corrector.apply(a.layout, a.container, {});
    setTransition(e, a, 0.5);
    a.preview.box = {x: 300, y: 200, width: 500, height: 300};
    e.corrector.apply(a.layout, a.container, {});
    const empty = {...a.layout, _windows: new Map()};
    e.corrector.apply(empty, a.container, {});
    e.overview.animationInProgress = false;
    a.layout.params = {transitioning: false, initialState: 1, finalState: 1, currentState: 1};
    a.layout._stateAdjustment.value = 1;
    a.preview.box = picker;
    e.corrector.apply(a.layout, a.container, {});
    equalBox(a.geometry(false), picker);
    e.corrector.clear();
    assert.equal(a.preview.scale_x, 1);
});

test('moving a frame invalidates cached picker even when its size is unchanged', () => {
    const e = environment(); const a = actors();
    e.corrector.apply(a.layout, a.container, {});
    a.preview.boundingBox.x += 200;
    setTransition(e, a, 0.5);
    const raw = a.geometry(true);
    e.corrector.apply(a.layout, a.container, {});
    equalBox(a.geometry(true), raw);
    assert.equal(e.frames.at(-1).note, 'no-picker');
});

test('same window on distinct layouts has separate picker endpoints', () => {
    const e = environment(); const a = actors(); const b = actors(undefined, 1);
    e.corrector.apply(a.layout, a.container, {});
    b.preview.box.x += 600;
    e.corrector.apply(b.layout, b.container, {});
    const pickerA = a.geometry(true);
    setTransition(e, a, 0.5);
    e.corrector.apply(a.layout, a.container, {});
    equalBox(a.geometry(true), interpolate(a.preview.boundingBox, pickerA, 0.5));
});

test('cache survives layout and preview recreation on the same workspace', () => {
    const e = environment(); const a = actors();
    e.corrector.apply(a.layout, a.container, {});
    const picker = a.geometry(true);
    a.preview.emit('destroy');
    a.container.emit('destroy');
    const b = actors();
    b.layout._metaWorkspace = a.layout._metaWorkspace;
    setTransition(e, b, 0.5);
    e.corrector.apply(b.layout, b.container, {});
    equalBox(b.geometry(true), interpolate(b.preview.boundingBox, picker, 0.5));
});

test('leaving scope or entering drag restores the transform', () => {
    for (const reason of ['scope', 'drag']) {
        const e = environment(); const a = actors();
        e.corrector.apply(a.layout, a.container, {});
        setTransition(e, a, 0.5);
        e.corrector.apply(a.layout, a.container, {});
        if (reason === 'scope') a.layout._metaWorkspace.active = false;
        else a.preview.inDrag = true;
        e.corrector.apply(a.layout, a.container, {});
        assert.equal(a.preview.scale_x, 1);
        assert.equal(a.preview.translation_x, 0);
    }
});

test('container scale and translation are included in the inverse transform', () => {
    const e = environment(); const a = actors();
    a.container.origin = {x: 1300, y: 70};
    a.container.scale = {x: 0.8, y: 0.75};
    e.corrector.apply(a.layout, a.container, {});
    const picker = a.geometry(true);
    setTransition(e, a, 0.5);
    e.corrector.apply(a.layout, a.container, {});
    equalBox(a.geometry(true), interpolate(a.preview.boundingBox, picker, 0.5));
});

test('disable restores original static scale, translation and pivot', () => {
    const e = environment(); const a = actors();
    a.preview.set_scale(0.98, 0.98); a.preview.set_pivot_point(0.5, 0.5);
    a.preview.translation_x = 4;
    e.corrector.apply(a.layout, a.container, {});
    setTransition(e, a, 0.5);
    e.corrector.apply(a.layout, a.container, {});
    e.corrector.clear();
    assert.equal(a.preview.scale_x, 0.98);
    assert.equal(a.preview.translation_x, 4);
    assert.deepEqual(a.preview.pivot, [0.5, 0.5]);
});
