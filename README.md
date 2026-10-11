# Linear Overview

A GNOME Shell extension that makes the window previews move and resize
**linearly in screen space** during the session ⇄ window picker transition —
a fix/testbed for [gnome-shell#2968][issue] ("Window size change in overview
transition is non-linear and windows move in a curved path").

It is not a patch to gnome-shell: it pins the previews from the outside, by
overriding `WorkspaceLayout.vfunc_allocate()` and correcting the geometry the
shell already allocated.

[issue]: https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/2968

## The problem, measured

The shell animates the transition with two *nested* linear interpolations: the
workspaces view moves and shrinks the workspace actor, and inside it
`WorkspaceLayout` interpolates every preview between its floating (real window)
box and its picker slot. Both run on the same state value `t`, so the geometry
on screen is quadratic in `t`, and the `Math.max()` size clamp added in 2020
turns the size into a piecewise function on top of that.

Measured in a nested GNOME Shell 50.4 (1280×800, single window, least-squares
fit of the geometry against `t`, so easing cancels out):

| transition | stock gnome-shell | with this extension |
|---|---|---|
| session → picker | 13.3 – 20.8 px off the straight line | **0.01 px** |
| picker → session | 0.6 – 5.3 px | **0.01 px** |
| aspect ratio drift | ≤ 0.01 % | **0.01 %** |

The opening transition is the visibly broken one; the closing one is nearly
linear already because the shell freezes its slots while leaving the overview.
Raw numbers and how to reproduce them: [`docs/analysis.md`](docs/analysis.md).

## How it works

`lib/transition.js` does not re-derive the shell's layout maths. It samples the
two steady states and pins every preview to their linear interpolation:

```
screenBox(t) = lerp(sessionBox, pickerBox, t)
```

* `sessionBox` is the live frame rect of the real window. A preview's
  `:bounding-box` is in stage coordinates and is exactly what the shell
  produces at `t == 0`.
* `pickerBox` is *measured* from the shell's own output in the settled picker
  state (`t == 1`, overview visible, layout not frozen) — so the end state
  stays identical to stock gnome-shell. **The extension is a no-op at both
  endpoints**; only the path in between changes.

The correction itself is a plain actor transform (pivot at the top-left, scale
and translation), applied after the original allocation ran:

```js
const picker = {x, y, width, height}, session = windowInfo.boundingBox, t = stateAdjustment.value;
const want = Clutter.ActorBox-like lerp(session, picker, t);
```

Allocations, the picker layout, hit tests, the focus chain and the app-grid
transition are untouched — the latter is deliberately excluded, because there
the windows are *supposed* to shrink with the workspace.

Because of that, the extension can be enabled and disabled at any time without
leaving the overview in a different state than stock.

## Requirements

* GNOME Shell **50** or **51** (developed and measured against 50.4/50.5;
  `js/ui/workspace.js` is byte-identical in 50.4 and 51.rc)
* No other extension that also overrides `WorkspaceLayout.vfunc_allocate()`

It uses private shell API (`WorkspaceLayout`, `_windows`,
`_stateAdjustment`, `_layoutFrozen`). Each new shell release may need a check;
`tests/` is meant to make that cheap.

## Install

```sh
./install.sh          # copy into ~/.local/share/gnome-shell/extensions
./install.sh --dev    # symlink the repository instead (development)
./install.sh --uninstall
```

Then log out and back in (Wayland cannot restart the shell in place), or run
the changes through `tests/` instead.

## Configuration

No GSettings schema: everything lives in [`dev-config.json`](dev-config.json)
next to `extension.js` and is re-read within a second after a change.

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | apply the screen-space correction at all |
| `scope` | `active-workspace` | `all` also corrects previews on other workspaces (they float at scroll-offset positions, which this extension does not track) |
| `gate` | `session-picker` | `any-transition` corrects whenever `0 < t < 1` instead of only the session ⇄ picker pair |
| `debug` | `false` | reserved for verbose logging |
| `measure` | `false` | record per-frame geometry to `global.__linearOverviewFrames` for the tests |

With `enabled: false` the extension still measures but never touches the
geometry — that is the control run of the test suite.

## Test

```sh
tests/run-tests.sh                 # fix: geometry must be linear in t
ENABLED=0 EXPECT=nonlinear tests/run-tests.sh   # control: the shell must fail
```

The tests run a nested GNOME Shell (`gnome-shell --devkit`) inside a toolbox
container, drive real transitions, fit the preview geometry against the state
value and compare the residuals. See [`tests/README.md`](tests/README.md),
including the isolated-dconf warning.

## Limitations

* Previews on **non-active workspaces** are left to the shell by default
  (`scope`), because their floating geometry is offset by the workspace scroll
  position.
* A window that was **resized or moved while the overview was closed** gets one
  un-corrected transition: the stale picker endpoint is dropped instead of
  animating towards a slot that no longer exists.
* A preview whose *window* changes while the transition runs (new window,
  window closed, drag and drop) is left alone for those frames, so the shell's
  own animations are never fought.
* The **workspace/background** motion, the dash and the search entry keep the
  shell's own curves. Only the previews are linearised.

## Related upstream work

* [!4010](https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4010) —
  the original attempt, still open; the review established the "linear in
  screen space" requirement but the implementation fudges unrelated numbers and
  reverts a 2014 freeze fix.
* [!4035](https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4035) —
  skeller's "More linear overview transition", smaller and closer to the root
  cause, also open.

[`docs/upstream.md`](docs/upstream.md) collects what this testbed learned and
how it would translate into a patch on top of !4035.
