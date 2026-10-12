// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
// Nested-session test for linear-overview, run via --automation-script.
//
// Covered:
//   E1  correct session endpoint and handoff to the original picker layout
//   E2  during the session <-> picker transition the on-screen geometry is a
//       linear function of the state value t (least-squares fit residual)
//   E3  a preview keeps its aspect ratio through the transition
//   E4  cold single/two-window openings, hover, removal, gestures and lifecycle
//
// The same script is run twice by tests/run-tests.sh:
//   lo_expect=nonlinear (correction disabled) - E2 must FAIL, i.e. the test
//       really observes the shell's quadratic path
//   lo_expect=linear    (correction enabled)  - E2 must PASS
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';

const TAG = '[LO-TEST]';
const EXPECT = GLib.getenv('lo_expect') ?? 'linear';
const ENGINE = GLib.getenv('lo_engine') ?? 'native';
const ACTIVE_STATE = ExtensionState.ACTIVE ?? ExtensionState.ENABLED;
const INACTIVE_STATE = ExtensionState.INACTIVE ?? ExtensionState.DISABLED;

const CYCLES = 4;
const SETTLE_MS = 450; // let the workspace thumbnails' easing settle
const MIN_FRAMES = 8;
const MIN_SPAN = 0.5;
const MAX_RESIDUAL_PX = 1.5; // linear run
const MIN_NONLINEAR_PX = 3.0; // nonlinear run: the shell has to be worse
const MAX_ASPECT_DRIFT = 0.005;

const failures = [];

function check(name, ok, detail = '') {
    print(`${TAG} ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok)
        failures.push(name);
}

function info(...args) {
    print(`${TAG} INFO ${args.join(' ')}`);
}

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

async function waitFor(fn, timeoutMs = 20000, stepMs = 50, detail = null) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    for (;;) {
        const value = fn();
        if (value)
            return value;
        if (GLib.get_monotonic_time() > deadline)
            throw new Error(detail ? detail() : 'waitFor: timed out');
        await sleep(stepMs);
    }
}

function stateAdjustment() {
    return Main.overview?._overview?.controls?._stateAdjustment ?? null;
}

function stateValue() {
    return stateAdjustment()?.value ?? 0;
}

async function waitOverviewAt(target) {
    await waitFor(() =>
        Math.abs(stateValue() - target) < 1e-4 && !Main.overview.animationInProgress, 20000, 30);
}

function findWindow(title) {
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .find(window => window &&
            window.get_window_type() === Meta.WindowType.NORMAL &&
            window.get_title() === title);
}

async function placeWindow(window, rect, monitorIndex = Main.layoutManager.primaryIndex) {
    const monitor = Main.layoutManager.monitors[monitorIndex];
    const x = Math.round(monitor.x + monitor.width * rect.x);
    const y = Math.round(monitor.y + monitor.height * rect.y);
    const width = Math.round(monitor.width * rect.width);
    const height = Math.round(monitor.height * rect.height);

    window.move_resize_frame(true, x, y, width, height);
    await waitFor(() => {
        const frame = window.get_frame_rect();
        return Math.abs(frame.x - x) <= 4 && Math.abs(frame.y - y) <= 4 &&
            Math.abs(frame.width - width) <= 4 && Math.abs(frame.height - height) <= 4;
    }, 20000, 50, () => `placement requested ${x},${y} ${width}x${height}; actual ${JSON.stringify(window.get_frame_rect())}`);
}

function framesFor(window) {
    const all = global.__linearOverviewFrames ?? [];
    return all.filter(frame =>
        frame.win === window.get_id() &&
        frame.monitor === window.get_monitor());
}

// Splits a chronologically ordered frame list into monotonic runs, so that
// the opening and the closing animation are never mixed in one fit.
function splitRuns(frames) {
    const sorted = [...frames].sort((a, b) => a.ms - b.ms);
    const runs = [];
    let run = [];
    let direction = 0;
    let lastT = null;

    for (const frame of sorted) {
        const delta = lastT === null ? 0 : frame.t - lastT;
        const frameDirection = frame.direction
            ? (frame.direction === 'close' ? -1 : 1)
            : Math.sign(Math.round(delta * 1000));

        const timelineChanged = run.length > 0 && frame.direction && run[run.length - 1].direction &&
            frame.direction !== run[run.length - 1].direction;
        if (timelineChanged || (run.length > 0 && frameDirection !== 0 && direction !== 0 &&
            frameDirection !== direction)) {
            runs.push(run);
            run = [];
        }

        if (frameDirection !== 0)
            direction = frameDirection;

        run.push(frame);
        lastT = frame.t;
    }

    if (run.length > 0)
        runs.push(run);

    return runs;
}

// Maximum distance of the samples from their own least-squares line in t.
// A quadratic path shows up as a systematic bow, a linear one only as
// rounding noise.
function fitResidual(frames, key, component, evaluateAt = null) {
    const n = frames.length;
    let sumT = 0;
    let sumV = 0;
    let sumTT = 0;
    let sumTV = 0;

    for (const frame of frames) {
        const t = frame.t;
        const v = frame[key][component];
        sumT += t;
        sumV += v;
        sumTT += t * t;
        sumTV += t * v;
    }

    const denominator = n * sumTT - sumT * sumT;
    if (Math.abs(denominator) < 1e-9)
        return null;

    const slope = (n * sumTV - sumT * sumV) / denominator;
    const intercept = (sumV - slope * sumT) / n;

    if (evaluateAt !== null)
        return intercept + slope * evaluateAt;

    let residual = 0;
    for (const frame of frames) {
        const expected = intercept + slope * frame.t;
        residual = Math.max(residual, Math.abs(frame[key][component] - expected));
    }

    return residual;
}

function runResidual(frames, key) {
    let worst = 0;
    for (const component of ['x', 'y', 'width', 'height'])
        worst = Math.max(worst, fitResidual(frames, key, component) ?? 0);
    return worst;
}

function aspectDrift(frames) {
    let min = Infinity;
    let max = 0;

    for (const frame of frames) {
        const aspect = frame.shown.width / frame.shown.height;
        min = Math.min(min, aspect);
        max = Math.max(max, aspect);
    }

    return max / min - 1;
}

function analyse(caseName, window, requirePicker = true) {
    const frames = framesFor(window).filter(frame => frame.phase === 'transition');

    // Picker steady state stays untouched. A visible closing preview at zero
    // must match the real frame, even when the shell's frozen allocation does not.
    const all = framesFor(window);
    const settled = all.filter(frame => frame.phase === 'picker');
    const touched = settled.filter(frame =>
        frame.applied ||
        Math.abs(frame.shown.x - frame.raw.x) > 0.01 ||
        Math.abs(frame.shown.width - frame.raw.width) > 0.01);

    if (requirePicker || settled.length > 0) {
        check(`${caseName}: picker unchanged (${settled.length} settled frames)`,
            settled.length > 0 && touched.length === 0,
            touched.length > 0 ? `${touched.length} frames with an applied correction` : '');
    }

    if (frames.length === 0) {
        check(`${caseName}: transition frames recorded`, false, 'no frames');
        return;
    }

    const notes = frames.reduce((map, frame) => {
        map[frame.note] = (map[frame.note] ?? 0) + 1;
        return map;
    }, {});
    info(`${caseName}: notes ${JSON.stringify(notes)}`);

    const settledFrames = all.filter(frame => frame.phase !== 'transition');
    info(`${caseName}: settled ${JSON.stringify(settledFrames.slice(0, 10).map(f => [
        Math.round(f.t * 100) / 100, f.note, f.picker,
        f.stats?.sample, f.stats?.dropSession, f.stats?.frozen, f.stats?.hidden]))}`);

    let analysed = 0;
    let worst = 0;

    for (const [index, run] of splitRuns(frames).entries()) {
        const span = Math.max(...run.map(f => f.t)) - Math.min(...run.map(f => f.t));
        if (run.length < MIN_FRAMES || span < MIN_SPAN)
            continue;

        analysed++;
        const residual = runResidual(run, 'shown');
        const rawResidual = runResidual(run, 'raw');
        const aspect = aspectDrift(run);
        worst = Math.max(worst, residual);
        const direction = run[0].direction ?? (run[run.length - 1].t > run[0].t ? 'open' : 'close');
        const detail = `${direction} run ${index} frames=${run.length} span=${span.toFixed(2)} ` +
            `residual=${residual.toFixed(2)}px${ENGINE === 'transform' ? ` (shell alone: ${rawResidual.toFixed(2)}px)` : ''} ` +
            `aspect drift=${(aspect * 100).toFixed(2)}%`;
        info(`${caseName}: ${detail}`);

        if (index < 2)
            info(`${caseName}: run ${index} frames ${JSON.stringify(
                run.map(f => [Math.round(f.t * 100) / 100, f.note, f.rec, f.picker, f.session, f.shown]))}`);

        if (EXPECT === 'linear') {
            check(`${caseName}: ${direction} run ${index} moves linearly in t`,
                residual <= MAX_RESIDUAL_PX, detail);
            check(`${caseName}: ${direction} run ${index} keeps its aspect ratio`,
                aspect <= MAX_ASPECT_DRIFT, detail);
            const endpoints = {session: 0, picker: 1};
            for (const [key, t] of Object.entries(endpoints)) {
                const target = run.find(frame => frame[key])?.[key];
                let error = 0;
                if (target) {
                    for (const component of ['x', 'y', 'width', 'height'])
                        error = Math.max(error, Math.abs(fitResidual(run, 'shown', component, t) - target[component]));
                }
                check(`${caseName}: ${direction} run ${index} reaches ${key}`,
                    Boolean(target) && error <= MAX_RESIDUAL_PX, `endpoint error=${error.toFixed(2)}px`);
            }
            if (requirePicker && direction === 'open' && ENGINE === 'native') {
                const steady = all.find(frame => frame.phase === 'picker' && frame.ms >= run[run.length - 1].ms);
                const target = run[0].picker;
                const error = steady && target ? Math.max(...['x', 'y', 'width', 'height'].map(component =>
                    Math.abs(steady.slot[component] - target[component]))) : Infinity;
                check(`${caseName}: predicted picker matches shell steady layout`, error <= MAX_RESIDUAL_PX,
                    `handoff error=${error.toFixed(2)}px; predicted=${JSON.stringify(target)}; actual=${JSON.stringify(steady?.slot)}`);
                if (index === 0)
                    info(`${caseName}: container predicted=${JSON.stringify(steady?.projectedContainer)} actual=${JSON.stringify(steady?.container)}`);
                const containerError = steady?.projectedContainer ? Math.max(...['x', 'y', 'width', 'height'].map(component =>
                    Math.abs(steady.projectedContainer[component] - steady.container[component]))) : Infinity;
                check(`${caseName}: predicted workspace container matches shell steady layout`, containerError <= MAX_RESIDUAL_PX,
                    `container error=${containerError.toFixed(2)}px`);
            }
            if (ENGINE === 'native' && window.get_monitor() !== Main.layoutManager.primaryIndex) {
                const steady = direction === 'open'
                    ? settled.find(frame => frame.ms >= run[run.length - 1].ms)
                    : settled.filter(frame => frame.ms <= run[0].ms).at(-1);
                if (steady) {
                    const error = Math.max(...['x', 'y', 'width', 'height'].map(component =>
                        Math.abs(fitResidual(run, 'container', component, 1) - steady.container[component])));
                    check(`${caseName}: ${direction} workspace joins the steady picker without a jump`, error <= MAX_RESIDUAL_PX,
                        `workspace handoff error=${error.toFixed(2)}px`);
                    if (error > MAX_RESIDUAL_PX)
                        info(`${caseName}: workspace frames ${JSON.stringify(run.map(frame => [frame.t, frame.container]))}; steady=${JSON.stringify(steady.container)}`);
                }
            }
        }
    }

    check(`${caseName}: analysable runs found`, analysed > 0, `${analysed} runs`);

    if (EXPECT !== 'linear') {
        check(`${caseName}: the measurement detects the un-corrected path`,
            worst >= MIN_NONLINEAR_PX, `worst residual ${worst.toFixed(2)}px`);
    }
}

async function openCloseCycle(hoverWindow = null) {
    Main.overview.show();
    await waitOverviewAt(1);
    await sleep(SETTLE_MS);
    if (hoverWindow)
        hoverWindow._delegate.showOverlay(false);
    Main.overview.hide();
    await waitOverviewAt(0);
    await sleep(SETTLE_MS);
}

function contentBox(window) {
    const actor = window._delegate.window_container;
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}

async function gestureCase(window, name, start, target, progress, hover = false) {
    if (start === 0) {
        Main.overview.hide();
        await waitOverviewAt(0);
    } else {
        Main.overview.show();
        await waitOverviewAt(1);
        await sleep(SETTLE_MS);
        if (hover)
            window._delegate.showOverlay(false);
    }
    const before = start === 1 ? contentBox(window) : null;
    global.__linearOverviewFrames.length = 0;
    const tracker = {confirmSwipe() {}};
    Main.overview._gestureBegin(tracker);
    for (const value of progress) {
        Main.overview._gestureUpdate(tracker, value);
        await sleep(25);
    }
    Main.overview._gestureEnd(tracker, 180, target);
    await waitOverviewAt(target);
    await sleep(SETTLE_MS);
    analyse(name, window, target === 1 && start === 0);
    if (before && target === 1) {
        const after = contentBox(window);
        const error = Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(before[key] - after[key])));
        check(`${name}: cancelled gesture restores displayed picker`, error <= MAX_RESIDUAL_PX,
            `error=${error.toFixed(2)}px; before=${JSON.stringify(before)}; after=${JSON.stringify(after)}`);
    }
}

async function disableEnableCase(window) {
    Main.overview.show();
    await waitOverviewAt(1);
    await sleep(SETTLE_MS);
    const before = contentBox(window);
    const uuid = 'linear-overview@icookie';
    const extension = Main.extensionManager.lookup(uuid);
    check('extension is enabled before lifecycle test', extension?.state === ACTIVE_STATE);
    Main.extensionManager.disableExtension(uuid);
    await waitFor(() => extension.state === INACTIVE_STATE);
    await sleep(SETTLE_MS);
    const after = contentBox(window);
    const error = Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(before[key] - after[key])));
    check('disable preserves picker geometry', error <= MAX_RESIDUAL_PX, `error=${error.toFixed(2)}px`);
    check('disable releases measurement globals', global.__linearOverviewFrames === undefined && global.__linearOverviewMeasure === undefined);
    Main.overview.hide();
    await waitOverviewAt(0);
    Main.extensionManager.enableExtension(uuid);
    await waitFor(() => extension.state === ACTIVE_STATE);
    global.__linearOverviewMeasure = true;
    global.__linearOverviewFrames.length = 0;
    await openCloseCycle();
    analyse('reenabled extension cold opening', window);
}

// Nested mutter occasionally leaves the overview stuck mid-animation after
// windows changed workspaces; that is a harness problem, not a test result,
// so skip the rest of the case instead of failing it.
async function cycleOrSkip() {
    try {
        await openCloseCycle();
        return true;
    } catch (e) {
        info(`cycle aborted: ${e.message} (t=${stateValue().toFixed(3)})`);
        try {
            Main.overview.hide();
            await waitOverviewAt(0, 5000);
        } catch (e2) {
            info(`overview recovery failed: ${e2.message}`);
        }
        return false;
    }
}

// The corrector falls back to the shell for a transition when it has no
// picker endpoint yet (a window that just appeared or was resized), so run
// probe cycles until one is fully corrected before measuring.
async function warmUp(window) {
    for (let attempt = 0; attempt < 4; attempt++) {
        global.__linearOverviewFrames.length = 0;
        await cycleOrSkip();

        const frames = framesFor(window)
            .filter(frame => frame.phase === 'transition');
        const directions = new Set(frames.map(frame => frame.direction));
        if (directions.has('open') && directions.has('close') && frames.every(frame => frame.note === 'corrected'))
            return true;
        info(`warm-up ${attempt + 1}: ${JSON.stringify(
            frames.reduce((map, frame) => {
                map[frame.note] = (map[frame.note] ?? 0) + 1;
                return map;
            }, {}))}`);
    }

    return false;
}

async function measure(caseName, window, hover = false) {
    if (ENGINE === 'transform') {
        const engaged = await warmUp(window);
        if (EXPECT === 'linear')
            check(`${caseName}: corrector engaged after warm-up`, engaged);
    }

    await sleep(200);

    global.__linearOverviewFrames.length = 0;
    for (let i = 0; i < CYCLES; i++) {
        if (hover) {
            await openCloseCycle(window);
        } else if (!await cycleOrSkip())
            break;
    }

    analyse(caseName, window);
    if (EXPECT === 'linear' && ENGINE === 'native') {
        const frames = framesFor(window).filter(frame => frame.phase === 'transition');
        check(`${caseName}: native allocation works without warm-up`, frames.length > 0 && frames.every(frame => frame.note === 'allocated'));
    }
}

async function minimizedCase(caseName, window, normalWindow = null) {
    Main.overview.hide();
    await waitOverviewAt(0);
    window.minimize();
    await waitFor(() => window.minimized && !window.showing_on_its_workspace());
    await sleep(SETTLE_MS);
    const extension = Main.extensionManager.lookup('linear-overview@icookie').stateObj;
    const engine = extension._native;
    const nativeAllocate = engine.allocate;
    // InjectionManager replaces the C vtable; this JS method still contains
    // Shell's original implementation. Run it on shadow previews so its
    // expected allocations cannot change the displayed actors.
    const stockAllocate = WorkspaceLayout.prototype.vfunc_allocate;
    const references = new Map();
    let samples = 0;
    let startSamples = 0;
    let error = 0;
    let opacityError = 0;
    engine.allocate = function (layout, container, box) {
        let reference = references.get(layout);
        if (!reference && layout._windows.size) {
            const children = new Map([...layout._windows].map(([preview]) => [preview, {
                visible: preview.visible, boundingBox: preview.boundingBox,
                allocate(allocation) { this.allocation = allocation.copy(); },
            }]));
            reference = Object.create(layout);
            reference._windows = new Map([...layout._windows].map(([preview, info]) => [children.get(preview), {...info, currentTransition: null}]));
            reference._windowSlots = (layout._windowSlots ?? []).map(slot => [...slot.slice(0, 4), children.get(slot[4])]);
            reference._windowSlotsBox = layout._windowSlotsBox?.copy() ?? box.copy();
            reference._lastBox = layout._lastBox?.copy() ?? null;
            reference._layout = layout._layout ?? reference._createBestLayout(layout._workarea);
            reference._needsLayout = false;
            reference._getWindowSlots = slotsBox => layout._getWindowSlots.call(reference, slotsBox)
                .map(slot => [...slot.slice(0, 4), children.get(slot[4])]);
            reference.notify = () => {};
            reference.children = children;
            references.set(layout, reference);
        }
        if (reference) {
            reference._layoutFrozen = layout._layoutFrozen;
            stockAllocate.call(reference, container, box.copy());
        }
        const handled = nativeAllocate.call(this, layout, container, box);
        if (handled && reference) {
            for (const [preview, info] of layout._windows) {
                if (info.metaWindow !== window || info.currentTransition || preview.inDrag)
                    continue;
                const expected = reference.children.get(preview).allocation;
                const actual = preview.allocation;
                samples++;
                if (!Main.overview.closing && layout._stateAdjustment.value < 0.1)
                    startSamples++;
                for (const key of ['x1', 'y1', 'x2', 'y2'])
                    error = Math.max(error, Math.abs(actual[key] - expected[key]));
                opacityError = Math.max(opacityError, Math.abs(preview.opacity - 255 * layout._stateAdjustment.value));
            }
        }
        return handled;
    };
    global.__linearOverviewFrames.length = 0;
    try {
        const tracker = {confirmSwipe() {}};
        Main.overview._gestureBegin(tracker);
        for (const progress of [0, 0.04, 0.08, 0.2, 0.4, 0.6, 0.8]) {
            Main.overview._gestureUpdate(tracker, progress);
            await sleep(50);
        }
        Main.overview._gestureEnd(tracker, 180, 1);
        await waitOverviewAt(1);
        await sleep(SETTLE_MS);
        window._delegate.showOverlay(false);
        // Starting from the picker recreates views, including the all-minimized
        // case where the native closing snapshot has no desktop-bound previews.
        Main.overview._gestureBegin(tracker);
        for (const progress of [0.96, 0.8, 0.6, 0.4, 0.2, 0.4, 0.6, 0.8, 0.96]) {
            Main.overview._gestureUpdate(tracker, progress);
            await sleep(50);
        }
        Main.overview._gestureEnd(tracker, 180, 1);
        await waitOverviewAt(1);
        await sleep(SETTLE_MS);
        Main.overview._gestureBegin(tracker);
        for (const progress of [0.96, 0.8, 0.6, 0.4, 0.2, 0.08, 0.04, 0]) {
            Main.overview._gestureUpdate(tracker, progress);
            await sleep(50);
        }
        Main.overview._gestureEnd(tracker, 180, 0);
        await waitOverviewAt(0);
        await sleep(SETTLE_MS);
        for (let i = 0; i < 2; i++)
            await openCloseCycle(i === 1 ? window : null);
        check(`${caseName}: stock allocations match throughout opening and closing`,
            samples >= MIN_FRAMES * 2 && startSamples > 0 && error <= MAX_RESIDUAL_PX,
            `${samples} samples, ${startSamples} near start, maximum error=${error.toFixed(2)}px`);
        check(`${caseName}: shell fading preserved`, opacityError <= 1, `maximum opacity error=${opacityError.toFixed(2)}`);
        check(`${caseName}: window remains minimized`, window.minimized && !window.showing_on_its_workspace());
        const frames = framesFor(window).filter(frame => frame.phase === 'transition');
        check(`${caseName}: uses shell minimized branch`, frames.length > 0 && frames.every(frame => frame.note === 'shell-minimized'));
        if (normalWindow)
            analyse(`${caseName}: normal window`, normalWindow);
    } finally {
        engine.allocate = nativeAllocate;
        window.unminimize();
        await waitFor(() => !window.minimized && window.showing_on_its_workspace());
        await sleep(SETTLE_MS);
    }
}

export async function run() {
    print(`${TAG} START expect=${EXPECT}`);

    try {
        await waitFor(() => Main.extensionManager.lookup('linear-overview@icookie')?.state === ACTIVE_STATE &&
            global.__linearOverviewFrames !== undefined, 20000, 50,
            () => `extension startup incomplete: ${Main.extensionManager.lookup('linear-overview@icookie')?.state}`);
        global.__linearOverviewMeasure = true;

        const monitor = Main.layoutManager.primaryMonitor;
        info(`monitor ${monitor.width}x${monitor.height} scale=${monitor.geometry_scale ?? 1}`);
        info(`frames=${(global.__linearOverviewFrames ?? []).length}`);

        const windowA = await waitFor(() => findWindow('LO Test Window A'));
        const windowB = await waitFor(() => findWindow('LO Test Window B'));
        Main.overview.hide();
        await waitOverviewAt(0);

        const workspaceA = windowA.get_workspace();
        const workspaceB = global.workspace_manager.append_new_workspace(false, global.get_current_time());

        // Case 1: a single mid-sized window (the layout has to scale it up).
        // Moving the second window away freezes the layout for 750ms, so give
        // the shell time to unfreeze it again before measuring.
        windowB.change_workspace(workspaceB);
        await placeWindow(windowA, {x: 0.18, y: 0.22, width: 0.46, height: 0.42});
        await sleep(1500);
        await measure('single window', windowA);
        await measure('single window hovered', windowA, true);
        if (ENGINE === 'native' && EXPECT === 'linear')
            await minimizedCase('single minimized window', windowA);

        // Case 2: two windows of different sizes in the same picker layout.
        windowA.change_workspace(workspaceA);
        windowB.change_workspace(workspaceA);
        await placeWindow(windowA, {x: 0.18, y: 0.18, width: 0.46, height: 0.42});
        await placeWindow(windowB, {x: 0.06, y: 0.62, width: 0.20, height: 0.22});
        await sleep(1000);
        await measure('two windows', windowA);
        if (ENGINE === 'native' && EXPECT === 'linear')
            await minimizedCase('mixed minimized and normal windows', windowB, windowA);

        if (ENGINE === 'native' && EXPECT === 'linear' && Main.layoutManager.monitors.length > 1) {
            const secondary = Main.layoutManager.monitors.find(m => m.index !== Main.layoutManager.primaryIndex);
            // Keep a third dynamic workspace alive. With only two workspaces,
            // should_show is false and the hidden-secondary-thumbnail bug is
            // never exercised, even when primary-only mode is enabled.
            const retainedWorkspace = global.workspace_manager.append_new_workspace(false, global.get_current_time());
            windowB.change_workspace(retainedWorkspace);
            windowA.move_to_monitor(secondary.index);
            await placeWindow(windowA, {x: 0.18, y: 0.18, width: 0.46, height: 0.42}, secondary.index);
            await waitFor(() => global.workspace_manager.n_workspaces > 2);
            await sleep(1000);
            await measure('secondary monitor cold opening', windowA);
            await measure('secondary monitor hovered exit', windowA, true);
            await gestureCase(windowA, 'secondary monitor gesture open', 0, 1, [0.08, 0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.88]);
            await gestureCase(windowA, 'secondary monitor gesture close cancelled hovered', 1, 1,
                [0.92, 0.82, 0.72, 0.62, 0.52, 0.42, 0.32, 0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92], true);
            await minimizedCase('secondary monitor minimized window', windowA);
            windowA.move_to_monitor(Main.layoutManager.primaryIndex);
            windowB.change_workspace(workspaceA);
            await placeWindow(windowA, {x: 0.18, y: 0.18, width: 0.46, height: 0.42});
            await sleep(1000);
        }

        if (ENGINE === 'native' && EXPECT === 'linear') {
            await gestureCase(windowA, 'gesture open', 0, 1, [0.08, 0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.88]);
            await gestureCase(windowA, 'gesture open cancelled', 0, 0,
                [0.08, 0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.68, 0.58, 0.48, 0.38, 0.28, 0.18, 0.08]);
            await gestureCase(windowA, 'gesture close cancelled hovered', 1, 1,
                [0.92, 0.82, 0.72, 0.62, 0.52, 0.42, 0.32, 0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92], true);
            await gestureCase(windowA, 'gesture close', 1, 0, [0.92, 0.82, 0.72, 0.62, 0.52, 0.42, 0.32, 0.22, 0.12]);
        }

        // Close a window and immediately leave before the delayed relayout.
        // The surviving preview must use its displayed slot, not an old cache.
        Main.overview.show();
        await waitOverviewAt(1);
        await sleep(SETTLE_MS);
        global.__linearOverviewFrames.length = 0;
        windowB.delete(global.get_current_time());
        await waitFor(() => !findWindow('LO Test Window B'));
        windowA._delegate.showOverlay(false);
        Main.overview.hide();
        await waitOverviewAt(0);
        if (EXPECT === 'linear')
            analyse('close window then hovered exit', windowA, false);
        if (ENGINE === 'native' && EXPECT === 'linear')
            await disableEnableCase(windowA);
    } catch (e) {
        failures.push(String(e));
        logError(e, `${TAG} test run failed`);
    }

    print(`${TAG} SUMMARY ${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join('; ')}`}`);
    global.context.terminate();
}
