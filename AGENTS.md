# AGENTS.md — Linear Overview

Rules and project knowledge for AI agents and contributors working on this
extension. Read this before touching anything.

## Ground rules

1. **No silent catches.** A `catch` is only allowed for external destruction
   (a preview disposed under us) or a failed hook installation — and it must
   log through `rateLimitedErrorLogger` from `lib/log.js`. Never swallow.
2. **Never break the shell's allocation.** The extension runs inside
   `WorkspaceLayout.vfunc_allocate()`; anything thrown there leaves the
   workspace half-allocated. `extension.js` wraps `corrector.apply()` for that
   reason, and `apply()` wraps each preview. Keep both layers.
3. **`enable()`/`disable()` must be symmetric.** `disable()` restores the vfunc
   through `InjectionManager.clear()`, resets every transform it applied
   (`Corrector.clear()`), removes the measure globals and the config poll.
4. **Max line length 200 chars**, 4-space indent, no unused imports.
5. **The extension has no schema on purpose.** Tunables live in
   `dev-config.json`, re-read once per second; do not add settings keys without
   also adding a bundled `gschemas.compiled` (see the Frosted Overview rules for
   the stale-schema trap).

## The one hard fact to remember

**A `vfunc_*` can NOT be replaced by assigning to the prototype.**
`GObject.registerClass` captures each `vfunc_*` method at class registration
time, wraps it in a `GjsCallbackTrampoline` and writes the function pointer into
the C vtable (`gjs/gi/object.cpp`, `hook_up_vfunc_impl`). Patching
`WorkspaceLayout.prototype.vfunc_allocate` afterwards is silently ignored.

Overriding *does* work through `InjectionManager.overrideMethod()`: for
`vfunc_` names it calls `hook_up_vfunc` again on the class' own GI prototype
(`js/extensions/extension.js`, `_installMethod`), which overwrites the vtable
slot and is scoped to that one class. That is the only reason this extension is
possible in a shell extension.

Corollary: `InjectionManager._saveMethod()` stores the original *JS method*
(the prototype property is never modified), so `clear()` restores the original
vfunc cleanly and repeatedly.

## What the corrector must guarantee

For every preview, during the transition:

```
screenBox(t) = lerp(sessionBox, pickerBox, t)
```

* `sessionBox` = `preview.boundingBox` (stage coordinates, live window frame).
* `pickerBox` = measured from the shell's own allocation at a settled picker
  state, stored **per window id** (`window id -> {box, session, frame}`), never
  per preview: `Workspace` destroys and recreates previews, the window is the
  stable identity.
* The correction is applied with pivot `(0, 0)`, `set_scale()` and
  `translation_x/y` — those live in the *parent's* coordinate space, so the
  translation is `want_local - allocation.origin` and needs no scale division.
* Both endpoints must stay untouched: if the correction ever changes geometry
  at `t == 0` or `t == 1`, the shell's steady states change with it.

Dropping rules (all of them are load-bearing, each was found the hard way):

| situation | behaviour |
|---|---|
| `layout._layoutFrozen` | do not sample: the slots belong to an older window arrangement and change again when the shell unfreezes |
| overview not visible while `t >= 1` | do not sample: the state adjustment keeps its value while hidden, so there is no picker geometry to measure |
| window frame rect differs from the sampled one | drop the endpoint and fall back to the shell for one transition instead of aiming at a stale slot |
| `preview.inDrag`, `windowInfo.currentTransition`, running `scale-x/y` transition | skip the preview: the shell is animating it itself (entry animation, DND, layout change) |
| app grid / any other transition | do not correct: shrinking with the workspace is what the floating layout is for |

## Testing

```sh
tests/run-tests.sh                              # correction on, must be linear
ENABLED=0 EXPECT=nonlinear tests/run-tests.sh   # control, must be non-linear
```

The nested shell runs in the `fedora-toolbox-44` container (GNOME 50.4) through
`gnome-shell --devkit --automation-script`, exactly like the
`transparent-top-bar` tests. `KEEP=1` keeps logs and the scratch home in
`/tmp/linear-overview-tests`.

Lessons baked into the harness, do not undo them:

* **dconf goes through the session bus**, so `dconf-setup.sh` refuses to run
  outside a private `dbus-run-session` with `HOME == LO_TEST_HOME`
  (the same trap is documented in the transparent-top-bar repo).
* **A crashed nested shell leaves its Wayland socket behind** and the next
  nested shell re-uses the same name, which made the harness report "no nested
  display". `harness.sh` therefore removes sockets nobody is listening on
  (`connectable()` check) and only accepts a candidate socket it can connect to.
* **The expectation must cross into the container** as `lo_expect`, not
  `EXPECT`: `toolbox run env ... lo_expect=...` and
  `EXPECT="${lo_expect:-${EXPECT:-linear}}"` in the harness.
* **The nested shell sometimes leaves the overview stuck** after windows changed
  workspaces. That is a harness problem, not a result: `cycleOrSkip()` logs it,
  tries to recover, and the case continues with the frames it got.

The measurement itself: frames are pushed to `global.__linearOverviewFrames`
when `measure` is on (`global.__linearOverviewMeasure = true` also works). The
analysis fits `x, y, width, height` against `t` per monotonic run and reports the
largest residual. Easing cancels out because the fit is against `t`, not time.
A quadratic path leaves ~13–21 px, a linear one ~0.01 px, so the thresholds
(1.5 px / 3.0 px) are not delicate.

## Diagnosing a regression

1. `grep -a "LO-TEST" /tmp/linear-overview-tests/shell.log` for the per-run
   residuals and the note counters (`corrected`, `no-picker`, `busy`, …).
2. The frame dumps of the first two runs show `t`, note, record id, picker box,
   session box and shown box — enough to see which endpoint is wrong.
3. `stats` inside a frame counts samples and drops
   (`sample`, `dropSession`, `dropAge`, `frozen`, `hidden`); a growing
   `dropSession` means the window geometry moved under the sample.
4. To watch it by hand: `St.Settings.get().slow_down_factor = 5` does **not**
   slow the overview animation (`animateToOverview` uses `ANIMATION_TIME`
   directly), so use the test instead of eyeballing.

## Upstream

The extension is a testbed, not a fix. `docs/upstream.md` holds the portable
description of the invariant and of the two small shell-side changes it implies
(`!4035` as the base). Anything learned here should end up there, in the issue
or in a MR — not only in this repository.
