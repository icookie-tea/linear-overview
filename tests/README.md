# Linear Overview regression tests

## Commands

```sh
node tests/unit/native-layout.test.cjs
node tests/unit/corrector.test.cjs
CONTAINER=host KEEP=1 tests/run-tests.sh
CONTAINER=host ENABLED=0 EXPECT=nonlinear KEEP=1 tests/run-tests.sh
CONTAINER=host LO_ENGINE=transform KEEP=1 tests/run-tests.sh
CONTAINER=host LO_MONITORS=1280x800,1600x900 KEEP=1 tests/run-tests.sh
```

The default backend is the `fedora-toolbox-44` toolbox container, using
`gnome-shell --devkit`. `CONTAINER=host` uses a headless host Shell with
software rendering and `--force-animations`. It needs GNOME Shell 50+, GJS,
GTK4 and permission to create local sockets.

`LO_ENGINE=native` is the default. `LO_ENGINE=transform` selects the previous
implementation. `ENABLED=0 EXPECT=nonlinear` verifies that the measurement
actually detects the stock path. `LO_MONITORS` is a comma-separated list of
headless virtual-monitor dimensions; integer-scale monitors are tested.

## Isolation

Every run uses a throwaway HOME, private XDG config/data/cache/state/runtime
locations and a private D-Bus session. `dconf-setup.sh` checks `HOME ==
LO_TEST_HOME` and refuses to run outside that private bus. Never run its dconf
commands on the live desktop.

`WORKDIR` defaults to `/tmp/linear-overview-tests` and is recreated for a run;
use a dedicated scratch path. `KEEP=1` retains logs. The harness checks that a
Wayland socket is connectable, removes only stale test sockets, and forwards
`lo_expect`/`lo_engine` into the nested process. The host backend places all
sockets in the dedicated test runtime.

## Native cases and assertions

The native suite does **not** warm up past the first opening. It checks:

* Single/two-window cold opening and hovered closing.
* Removing another window and closing before the delayed layout unfreezes.
* Gesture opening, closing and reverse cancellation, including a hovered
  picker restored after its Workspace actors are rebuilt.
* A cold opening on a secondary virtual monitor when two monitors are supplied.
* Actual extension disable/enable in an open picker and geometry/global cleanup.

It fits x, y, width and height against state value t per monotonic segment.
This removes time easing from the fit. The linear threshold is 1.5 px; the
stock-control run must exceed 3 px. It also checks aspect drift, extrapolated
session/picker endpoints, and compares opening targets with Shell's separately
rendered steady picker slots. The slot comparison catches a straight path that
ends at the wrong place. Container predictions are logged for diagnosing
preferred-size or pixel-rounding mismatches.

Native window content is allocated through Clutter and can be rounded by a
pixel. Its residual is therefore not the 0.01 px measured by the old transform
engine. The old engine retains warm-up because it depends on sampled endpoints.

Gesture tests call the real `Overview._gestureBegin/Update/End` entry points
with controlled progress values. They verify the Shell state/lifecycle, not
physical touchpad event delivery.

## Measurement

`measure: true` or `global.__linearOverviewMeasure = true` records frames in
`global.__linearOverviewFrames`. Native records include:

* `t`, phase, direction, monitor and window identity.
* `shown` content geometry, `slot` outer preview geometry, desired geometry
  and the fixed session/picker endpoints.
* `projectedContainer` and actual `container` geometry.
* `allocated`, `busy`, steady-state or `disabled` notes.
* Counts of computed targets and captured closing snapshots.

Native `raw` equals shown geometry: it does not execute a second stock
allocation just to manufacture a comparison. Use the separate disabled run.
Legacy records retain the raw-versus-corrected same-frame comparison.

## Unit tests and limits

Native unit tests execute the production modules with actor/layout doubles:
first-opening target calculation, inverse parent transform, hovered visible
zero, gesture reversal, snapshot transfer across view recreation, scope/gating
and disable/destruction cleanup. Legacy unit tests exercise the old corrector.

A wedged nested overview may be retried only when the log explicitly says
`cycle aborted`; an assertion failure must never be retried away. Physical
input, fractional scale, monitor hotplug, attached dialogs, large multirow
layouts and custom themes need additional validation.
