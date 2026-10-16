# Native layout engine (GNOME Shell 50)

`lib/nativeLayout.js` implements the session/picker allocation branch in an
extension. It is injected JavaScript, not an installed Shell resource patch.
The current target is GNOME Shell 50.5; metadata advertises only version 50.

## Ownership

The engine supplies `WorkspaceLayout.vfunc_allocate` during visible
HIDDEN ⇄ WINDOW_PICKER transitions on visible workspaces. It removes the clip,
allocates each preview and updates `_lastBox`. The original vfunc handles
steady layouts, app-grid transitions and hidden workspaces. On an override
failure the outer wrapper logs and delegates to the original vfunc.

Five ordinary hooks accompany allocation:

* The primary controls layout's `_computeWorkspacesBoxForState` reserves the
  final thumbnail height and expansion fraction for the picker endpoint.
* `SecondaryMonitorDisplay._getWorkspacesBoxForState` does the equivalent for
  secondary displays.
* `ControlsManager.gestureBegin` captures displayed picker content before the
  original method rebuilds workspace views.
* `ThumbnailsBox._updateShouldShow` defers workspace-count visibility decisions
  after geometry is fixed, applying the original update when the transition
  completes. Fresh geometry still starts with the normal visibility decision.
* `ControlsManager.gestureEnd` releases deferred decisions after completion,
  including cancellation to an already shown picker that emits no `shown`.

Secondary thumbnail reservation respects `workspaces-only-on-primary`.
`should_show` only reflects workspace count, so it can remain true when the
monitor policy hides the secondary thumbnail bar. In that mode the reserved
height and spacing must both be zero. Using `should_show` alone caused the
secondary workspace and windows to jump when the original steady layout took
over. The regression keeps three dynamic workspaces alive; two workspaces
hide thumbnails and previously masked the error.

InjectionManager restores all six hooks on disable. Native mode never writes
outer preview pivot, scale or translation. Only the chosen engine is
constructed; changing `engine` requires disabling/enabling the extension.

## Opening targets

The controls layout already computes the final picker box. Native mode reads
it during the first allocation, determines the final workspace geometry using
Shell's fit-single/preferred-size methods, and uses the theme's content box to
find the window container. It matches both pixel-rounding stages:

1. WorkspacesDisplay's BinLayout rounds the filled view dimensions upward.
2. WorkspacesView centers the workspace with `allocate_align_fill`, selecting
   its preferred size and rounding the origin downward and extent upward.

Missing the first stage produced a reproducible one-pixel single-window
handoff error. The test now compares the prediction with independently rendered
Shell steady slots and checks the container rectangles too.

Shell's window-layout strategy computes slots in the final container. Bottom
chrome padding is evaluated against that final monitor position, not an
intermediate parent transform. The resulting screen-space endpoints are fixed
for the transition. New openings compute new endpoints; no earlier overview
sample is needed.

## Content allocation and closing

The desired centered-workspace rectangle is `lerp(sessionFrame, pickerContent, t)`.
Shell's workspace navigation translation and inactive scale are then applied.
The current container transform is inverted before allocation. The content's
centered hover scale is accounted for in the outer allocation size and origin,
so the extension does not fight Shell's scale timeline or leave transforms to
restore.

Changing the active workspace during overview entry previously handed the
outgoing workspace back to Shell and started the incoming path with a target
based on intermediate scroll position. Windows could jump or cancel their
parent's movement. Visible participants now keep centered endpoints throughout
the transition. The current workspace's navigation transform is composed after
interpolation and inverted out of closing snapshots before replay. Hidden
workspaces continue using the original allocator.

Dynamic workspace removal can also change thumbnail visibility mid-transition.
The visibility decision is held once geometry is fixed and released on shown,
hidden, gesture completion or disable. Shell then performs its usual smooth
thumbnail expansion/collapse. Actor destruction removes pending state.

Keyboard closing captures the currently displayed content on `hiding`, even
when removing another window froze the layout. The visible zero frame still
gets the real desktop endpoint. Hidden releases transition snapshots.

Selecting a minimized preview restores the window before `Main.overview.hide()`.
That restoration invalidates content size: `get_transformed_size()` can then
return the natural desktop dimensions, although the last allocated picker
rectangle is still visible. Closing snapshots therefore use the content's
allocation mapped through its current transform, including hover scale. This
prevents a size jump at activation without changing focus or unminimize order.

Gesture progress uses the same endpoints, including reversals. Starting a
picker gesture recreates views. A transient snapshot keyed by monitor,
workspace and window id bridges that recreation and is consumed by new actors.
Cancelling back to picker restores the captured hover state. An earlier
implementation lost ten pixels of hover enlargement in this case; the real
Shell regression reproduces and checks it.

Drag and existing allocation/entry transitions remain Shell-owned and are
marked busy in measurement. They are not claimed to follow the fixed path.
Layout changes queued during a fixed path are handed back before the first
steady allocation, allowing Shell to animate the reshuffle from that endpoint.

## Minimized previews

Non-showing windows use Shell's special allocation branch. Their floating
origin comes from the workarea, and during session transitions their floating
size is clamped to the current slot size. Shell animates opacity with picker
progress. The previous native implementation instead interpolated from the
saved desktop frame with zero width/height, changing both the origin and size.

The native engine now obtains current slots through Shell's `_getWindowSlots`
and preserves its cached slots while layout is frozen. It reproduces that
per-preview branch and leaves opacity and hover scaling to Shell. Normal
windows in the same layout keep the fixed linear path. Minimized paths are
marked `shell-minimized`, and are not claimed to be screen-space linear.
An all-minimized picker can have an empty closing snapshot; after gesture view
recreation the engine still builds the layout needed for these slots.

The nested regression invokes Shell's original JavaScript allocator on shadow
previews and compares allocations frame by frame without moving live actors.
It covers opening, hovered closing, gesture opening/closing/cancellation,
near-zero progress, mixed layouts and secondary-monitor coordinates.

## Verification

The harness isolates HOME, all XDG locations, runtime sockets and D-Bus. It
uses real GNOME Shell 50.5 with software rendering and forced animation. The
control run disables the implementation. A separate legacy transform run
checks that the comparison engine still works.

Covered cases:

* Cold opening after window placement/size changes, without warm-up.
* Single-window and two-window layouts, closing at the desktop endpoint.
* Hovered exit; removing a window and immediately exiting while layout is frozen.
* Real Shell gesture callbacks: opening, closing, reversal, cancellation back
  to desktop, and hovered cancellation back to picker.
* Two virtual displays with different dimensions, including a window moved to
  the secondary monitor and a fresh opening there.
* Actual disable/enable in a shown overview, geometry preservation, measurement
  teardown and a fresh native opening after re-enable.
* Seventeen native unit regressions plus nine legacy transform regressions.

Opening predictions match Shell's independently rendered steady slots in the
single/two-window and secondary-display cases. Direct content allocation has
pixel-rounding noise (approximately half a pixel per sample in these runs),
so the legacy transform engine's 0.01-pixel figure does not apply. Tests fit
paths against state progress, extrapolate both endpoints and compare the
opening target with the independently rendered steady layout.

2026-10-11 validation on GNOME Shell 50.5:

| Run | Maximum path residual | Maximum extrapolated endpoint error | Predicted-slot handoff error | Result |
|---|---|---|---|---|
| Native, 1280×800, including disable/enable | 0.58 px | 0.49 px | 0.00 px | All pass |
| Native, 1280×800 + 1600×900 virtual monitors | 0.61 px | 0.28 px | 0.00 px | All pass |
| Disabled stock control | 21.99 px | — | — | Nonlinearity detected |
| Legacy transform comparison | 0.01 px | 0.01 px | — | All pass |

The minimized follow-up on the same Shell version, with 1280×800 + 1600×900
virtual monitors, passes all single/mixed/secondary-monitor and gesture cases.
Each minimized case compares 111 allocations with the original Shell function,
including 16 near the opening start. Maximum allocation error is 0.01 px;
opacity quantization differs by at most one level. Normal-window path,
endpoint, steady-layout handoff and extension lifecycle checks also pass.

All 26 unit regressions pass (17 native, 9 legacy). The three added minimized
unit regressions fail against the previous implementation. These numbers are sampled
test results for the stated configurations, not a universal error bound.

The secondary-policy follow-up on 2026-10-12 checks both primary-only and
all-monitor workspaces, including cold opening, hovered exit and gesture
cancellation. Workspace rectangles are measured from allocation plus parent
transform: a hover-triggered relayout can make `get_transformed_size()` report
the preferred desktop size while the current allocation is still smaller.
The suite waits for extension startup before collecting frames.

The previous primary-only implementation reproduces a 26 px window handoff
error and an approximately 83 px workspace handoff error with three dynamic
workspaces. The policy regression also fails against that implementation.
With the fix, both complete dual-monitor suites pass on GNOME Shell 50.5:

| Workspace policy | Predicted window/allocated container endpoint error | Maximum workspace handoff error |
|---|---|---|
| Primary monitor only | 0.00 px | 0.24 px |
| All monitors | 0.00 px | 0.63 px |

The activation follow-up on 2026-10-13 invokes the real preview `_activate()`
entry point, checks restoration and focus, and compares the closing path's
start with the independently measured preview before selection. It covers
single-window activation with/without hover, a small minimized window in a
mixed layout, and hovered activation on a secondary monitor. The old code
reproduces a 29 px starting-width jump and additional hover discontinuity;
the allocated-content snapshot unit regression also fails against it.
Both complete 1280×800 + 1600×900 suites pass with primary-only and all-monitor
workspaces. Maximum activation-start error is 0.14 px across the four cases;
restoration, focus, linear path and desktop endpoint checks all pass.

Workspace-switch regressions hold overview progress at 0.35 while switching
back and forth, checking both windows relative to their moving workspaces.
Automatic entry is interrupted at progress 0.2 and 0.7, then the resulting
picker is compared with the real original allocator on shadow previews.
The test also runs with a window on the secondary monitor and exercises
dynamic removal of an empty primary workspace. Deferred thumbnail animation
is allowed to finish before the final picker comparison; `shown` precedes
the final allocation. Normal screen-space linearity assertions apply when
workspace navigation is stationary.
On GNOME Shell 50.5, both full dual-monitor policies pass these cases. Held
progress keeps relative window geometry unchanged within sampled precision;
the settled incoming picker differs from the original allocator by 0.10 px.
The pre-fix held-progress regression reproduces offsets of 878.69/966.93 px.

Physical touchpad event delivery, fractional scaling, hotplug, attached dialogs,
large multirow sets and custom themes remain outside the verified matrix.
This is a version-specific implementation; passing these cases is not proof
that every interaction in #2968 is resolved.

## Reproduction

```sh
node tests/unit/native-layout.test.cjs
node tests/unit/corrector.test.cjs
CONTAINER=host KEEP=1 tests/run-tests.sh
CONTAINER=host ENABLED=0 EXPECT=nonlinear KEEP=1 tests/run-tests.sh
CONTAINER=host LO_ENGINE=transform KEEP=1 tests/run-tests.sh
CONTAINER=host LO_MONITORS=1280x800,1600x900 KEEP=1 tests/run-tests.sh
CONTAINER=host LO_MONITORS=1280x800,1600x900 LO_PRIMARY_ONLY=true KEEP=1 bash tests/run-tests.sh
```
