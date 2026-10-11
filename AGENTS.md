# AGENTS.md — Linear Overview

## Ground rules

* GNOME Shell 50 private JS API; current real-shell validation uses 50.5.
  Do not advertise another version before validating its layout and lifecycle.
* Four-space indent, maximum line length 200, no unused imports.
* No silent catches. Log destroyed-actor, failed-hook and allocation-boundary
  failures through `rateLimitedErrorLogger`. The vfunc wrapper must fall back
  to Shell's original allocation on failure; retain the per-preview guard.
* Keep enable/disable symmetric. Restore every injected method, disconnect
  signals, release per-layout and gesture state, restore legacy transforms,
  tear down measurement globals and stop the config poll.
* Settings are schema-less, in `dev-config.json`. Preserve installed personal
  settings when updating code.
* Never change live desktop settings from tests. Run settings operations only
  on the harness's private D-Bus session and isolated HOME/XDG runtime.

## Native layout contract

`lib/nativeLayout.js` is the default engine. It replaces allocation only during
visible HIDDEN ⇄ WINDOW_PICKER transitions on active workspaces. All other
branches use the original vfunc. It allocates once instead of correcting an
allocation with outer preview transforms.

* Opening targets are calculated from the final picker container and Shell's
  layout strategy before the first frame; no cross-overview sampling cache.
* Freeze target thumbnails height/fraction for the session transition. Their
  independent animation must not move the target rectangle.
* Account for WorkspacesDisplay's BinLayout rounding, Workspace's preferred
  sizes, fit-single placement, theme content box and window chrome padding.
* Interpolate in stage space, then invert the current container transform.
  Allocate the outer rectangle accounting for the centered content hover scale.
* Closing snapshots use displayed `window_container` geometry, including hover.
  Keep the correct desktop endpoint through visible zero.
* Gesture progress writes the adjustment directly. `gestureBegin` rebuilds
  Workspace views: transfer the current gesture snapshot by monitor/workspace/
  window id, and restore hover when cancelling to the picker.
* Per-layout state follows container destruction. Transient gesture snapshots
  expire when consumed, on hidden and on disable.
* Preserve Shell-owned drag, entry and allocation animations. Native geometry
  measurement marks these previews busy instead of claiming linearity.

## InjectionManager is required

Assigning `WorkspaceLayout.prototype.vfunc_allocate` does not replace its C
vtable callable. `GObject.registerClass` installs the original at registration.
Use `InjectionManager.overrideMethod`; `clear()` restores the vfunc and the
ordinary method hooks. Hook installation is atomic: undo any partial hooks on
failure. No system resource or Mutter modification is required.

## Legacy comparison

`lib/transition.js` retains the previous transform corrector under
`engine: transform`. Its endpoint/lifecycle tests remain useful as a baseline.
It samples picker endpoints and changes outer transforms; never let these
transforms remain active while switching to native mode. `scope` and `gate`
are legacy-engine controls, not native configuration.

## Verification

```sh
node tests/unit/native-layout.test.cjs
node tests/unit/corrector.test.cjs
CONTAINER=host KEEP=1 tests/run-tests.sh
CONTAINER=host ENABLED=0 EXPECT=nonlinear KEEP=1 tests/run-tests.sh
CONTAINER=host LO_ENGINE=transform KEEP=1 tests/run-tests.sh
CONTAINER=host LO_MONITORS=1280x800,1600x900 KEEP=1 tests/run-tests.sh
```

The native nested suite must not warm up away a cold-opening failure. Verify
both the path and its handoff to an independently rendered Shell picker.
Native content allocations are rounded by Clutter, so subpixel residuals are
expected; the old transform engine's 0.01 px results are not native metrics.
Gesture tests invoke real Shell callbacks, not physical touchpad hardware.
Test enable/disable in a shown overview to exercise restoration of the hooks.

The harness retries only an explicitly wedged nested overview, never genuine
geometry assertion failures. Keep isolated socket detection, XDG directories,
private D-Bus setup and forwarding of `lo_expect`/`lo_engine` intact.

`docs/native-layout.md` records the current architecture and validation.
`docs/analysis.md` describes the original transform experiments.
`docs/upstream.md` is historical upstream discussion; its early pseudocode is
not the current implementation and its endpoint no-op assumptions were wrong.
