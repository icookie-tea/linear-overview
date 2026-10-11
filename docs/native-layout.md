# Native layout engine (GNOME Shell 50)

`lib/nativeLayout.js` implements the session/picker allocation branch in an
extension. It is injected JavaScript, not an installed Shell resource patch.
The current target is GNOME Shell 50.5; metadata advertises only version 50.

## Ownership

The engine supplies `WorkspaceLayout.vfunc_allocate` during visible
HIDDEN ⇄ WINDOW_PICKER transitions on active workspaces. It removes the clip,
allocates each preview and updates `_lastBox`. The original vfunc handles
steady layouts, app-grid transitions and inactive workspaces. On an override
failure the outer wrapper logs and delegates to the original vfunc.

Three ordinary hooks accompany allocation:

* The primary controls layout's `_computeWorkspacesBoxForState` reserves the
  final thumbnail height and expansion fraction for the picker endpoint.
* `SecondaryMonitorDisplay._getWorkspacesBoxForState` does the equivalent for
  secondary displays.
* `ControlsManager.gestureBegin` captures displayed picker content before the
  original method rebuilds workspace views.

InjectionManager restores all four hooks on disable. Native mode never writes
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

The desired screen rectangle is `lerp(sessionFrame, pickerContent, t)`.
The current container transform is inverted before allocation. The content's
centered hover scale is accounted for in the outer allocation size and origin,
so the extension does not fight Shell's scale timeline or leave transforms to
restore.

Keyboard closing captures the currently displayed content on `hiding`, even
when removing another window froze the layout. The visible zero frame still
gets the real desktop endpoint. Hidden releases transition snapshots.

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
* Seven native unit regressions plus nine legacy transform regressions.

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

All 16 unit regressions pass (7 native, 9 legacy). These numbers are sampled
test results for the stated configurations, not a universal error bound.

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
```
