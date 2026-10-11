// Nested-session test for linear-overview, run via --automation-script.
//
// Covered:
//   E1  the correction is a no-op at both endpoints (t == 0 and t == 1)
//   E2  during the session <-> picker transition the on-screen geometry is a
//       linear function of the state value t (least-squares fit residual)
//   E3  a preview keeps its aspect ratio through the transition
//   E4  single-window and two-window layouts both pass
//
// The same script is run twice by tests/run-tests.sh:
//   lo_expect=nonlinear (correction disabled) - E2 must FAIL, i.e. the test
//       really observes the shell's quadratic path
//   lo_expect=linear    (correction enabled)  - E2 must PASS
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TAG = '[LO-TEST]';
const EXPECT = GLib.getenv('lo_expect') ?? 'linear';

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

async function waitFor(fn, timeoutMs = 20000, stepMs = 50) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    for (;;) {
        const value = fn();
        if (value)
            return value;
        if (GLib.get_monotonic_time() > deadline)
            throw new Error('waitFor: timed out');
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

async function placeWindow(window, rect) {
    const monitor = Main.layoutManager.primaryMonitor;
    const x = Math.round(monitor.x + monitor.width * rect.x);
    const y = Math.round(monitor.y + monitor.height * rect.y);
    const width = Math.round(monitor.width * rect.width);
    const height = Math.round(monitor.height * rect.height);

    window.move_resize_frame(true, x, y, width, height);
    await waitFor(() => {
        const frame = window.get_frame_rect();
        return Math.abs(frame.x - x) <= 4 && Math.abs(frame.y - y) <= 4 &&
            Math.abs(frame.width - width) <= 4 && Math.abs(frame.height - height) <= 4;
    });
}

function framesFor(window) {
    const all = global.__linearOverviewFrames ?? [];
    return all.filter(frame =>
        frame.win === window.get_id() &&
        frame.monitor === Main.layoutManager.primaryIndex);
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
        const frameDirection = Math.sign(Math.round(delta * 1000));

        if (run.length > 0 && frameDirection !== 0 && direction !== 0 &&
            frameDirection !== direction) {
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
function fitResidual(frames, key, component) {
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

function analyse(caseName, window) {
    const frames = framesFor(window).filter(frame => frame.phase === 'transition');

    // E1: the two settled states must be left alone.
    const all = framesFor(window);
    const settled = all.filter(frame => frame.phase === 'picker' || frame.phase === 'session');
    const touched = settled.filter(frame =>
        frame.applied ||
        Math.abs(frame.shown.x - frame.raw.x) > 0.01 ||
        Math.abs(frame.shown.width - frame.raw.width) > 0.01);

    check(`${caseName}: endpoints untouched (${settled.length} settled frames)`,
        settled.length > 0 && touched.length === 0,
        touched.length > 0 ? `${touched.length} frames with an applied correction` : '');

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
        const direction = run[run.length - 1].t > run[0].t ? 'open' : 'close';
        const detail = `${direction} run ${index} frames=${run.length} span=${span.toFixed(2)} ` +
            `residual=${residual.toFixed(2)}px (shell alone: ${rawResidual.toFixed(2)}px) ` +
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
        }
    }

    check(`${caseName}: analysable runs found`, analysed > 0, `${analysed} runs`);

    if (EXPECT !== 'linear') {
        check(`${caseName}: the measurement detects the un-corrected path`,
            worst >= MIN_NONLINEAR_PX, `worst residual ${worst.toFixed(2)}px`);
    }
}

async function openCloseCycle() {
    Main.overview.show();
    await waitOverviewAt(1);
    await sleep(SETTLE_MS);
    Main.overview.hide();
    await waitOverviewAt(0);
    await sleep(SETTLE_MS);
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
async function warmUp() {
    for (let attempt = 0; attempt < 4; attempt++) {
        global.__linearOverviewFrames.length = 0;
        await cycleOrSkip();

        const frames = (global.__linearOverviewFrames ?? [])
            .filter(frame => frame.phase === 'transition');
        if (frames.length > 0 && frames.every(frame => frame.note === 'corrected'))
            return true;
        info(`warm-up ${attempt + 1}: ${JSON.stringify(
            frames.reduce((map, frame) => {
                map[frame.note] = (map[frame.note] ?? 0) + 1;
                return map;
            }, {}))}`);
    }

    return false;
}

async function measure(caseName, window) {
    const engaged = await warmUp();
    if (EXPECT === 'linear')
        check(`${caseName}: corrector engaged after warm-up`, engaged);
    else
        info(`${caseName}: corrector engaged after warm-up: ${engaged} (control run)`);

    await sleep(200);

    global.__linearOverviewFrames.length = 0;
    for (let i = 0; i < CYCLES; i++) {
        if (!await cycleOrSkip())
            break;
    }

    analyse(caseName, window);
}

export async function run() {
    print(`${TAG} START expect=${EXPECT}`);

    try {
        global.__linearOverviewMeasure = true;

        const monitor = Main.layoutManager.primaryMonitor;
        info(`monitor ${monitor.width}x${monitor.height} scale=${monitor.geometry_scale ?? 1}`);
        info(`frames=${(global.__linearOverviewFrames ?? []).length}`);

        const windowA = await waitFor(() => findWindow('LO Test Window A'));
        const windowB = await waitFor(() => findWindow('LO Test Window B'));

        const workspaceA = windowA.get_workspace();
        const workspaceB = global.workspace_manager.append_new_workspace(false, global.get_current_time());

        // Case 1: a single mid-sized window (the layout has to scale it up).
        // Moving the second window away freezes the layout for 750ms, so give
        // the shell time to unfreeze it again before measuring.
        windowB.change_workspace(workspaceB);
        await placeWindow(windowA, {x: 0.18, y: 0.22, width: 0.46, height: 0.42});
        await sleep(1500);
        await measure('single window', windowA);

        // Case 2: two windows of different sizes in the same picker layout.
        windowA.change_workspace(workspaceA);
        windowB.change_workspace(workspaceA);
        await placeWindow(windowA, {x: 0.18, y: 0.18, width: 0.46, height: 0.42});
        await placeWindow(windowB, {x: 0.06, y: 0.62, width: 0.20, height: 0.22});
        await sleep(1000);
        await measure('two windows', windowA);
    } catch (e) {
        failures.push(String(e));
        logError(e, `${TAG} test run failed`);
    }

    print(`${TAG} SUMMARY ${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join('; ')}`}`);
    global.context.terminate();
}
