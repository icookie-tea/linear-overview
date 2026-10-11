# Linear Overview

A GNOME Shell 50 extension implementing a screen-space layout branch for the
session ⇄ window picker transition in [gnome-shell#2968][issue]. The default
engine calculates final slots and allocates previews directly. It does not
apply scale or translation to the outer preview actors.

[issue]: https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/2968

## Authorship

This extension — its implementation, its test harness and its documentation —
was written by **ChatGPT 6.1 Sol**. The repository owner is only responsible
for the project direction, the real-shell validation and the releases.

## License

Copyright (C) 2026 icookie-tea

Licensed under the **GNU General Public License, version 2 or later**
(`GPL-2.0-or-later`), matching what GNOME Shell itself is licensed under. See
[LICENSE](LICENSE) for the full text. Every source file carries a short
`SPDX-License-Identifier` header; there is no separate per-file copyright
assignment.

## How the native engine works

1. Reserve the final workspace-thumbnails geometry during the session/picker
   transition, so its independent expansion animation cannot move the target.
2. Calculate the final workspace/container rectangle using Shell's preferred
   sizes, fit-single layout, theme padding and Clutter's pixel alignment.
3. Use Shell's own window-layout strategy to calculate picker slots in that
   final rectangle, including the bottom space needed for window chrome.
4. Interpolate each window's desktop frame and picker rectangle in screen
   coordinates. Convert the result into the current container's coordinates
   and call `preview.allocate()` once.

```
screenBox(t) = lerp(sessionBox, pickerBox, t)
```

The first opening works without a warm-up or a persistent picker cache. Moving
or resizing windows while the overview is closed generates fresh targets on
the next opening.

Closing starts from the currently rendered window content, including hover
zoom and frozen layouts after removing a window. The allocation accounts for
Shell's centered content scale without modifying that scale animation. A
visible closing frame remains allocated to the desktop endpoint at `t == 0`.

Gestures use the same path. `gestureBegin()` recreates workspace views, so the
extension transfers only that gesture's displayed snapshot by monitor,
workspace and window identity. Cancelling back to the picker restores hover.
Snapshots expire at the end of the transition; they are not opening caches.

Steady picker layout, app-grid transitions, inactive workspaces, background
motion and input handling stay with Shell. Existing window-entry, drag and
allocation transitions also stay with Shell. The extension uses
`InjectionManager` for the allocation vfunc and three ordinary method hooks;
disabling restores all hooks and schedules a fresh Shell layout.

## Requirements and boundaries

* GNOME Shell **50**. Development and real-shell checks use **50.5**.
* Other extensions overriding the same layout methods may conflict.
* Uses private JS API and Clutter allocation behavior; each new Shell version
  needs validation. Metadata deliberately does not advertise GNOME 51 yet.
* Native mode handles the active workspace on each monitor. Inactive
  workspaces retain Shell's animation.
* Physical touchpad events, fractional scaling, monitor hotplug, custom themes,
  attached dialogs and large multirow window sets are not fully covered yet.

## Install

```sh
./install.sh          # copy into ~/.local/share/gnome-shell/extensions
./install.sh --dev    # symlink the repository (development)
./install.sh --uninstall
```

Log out and back in after a code update on Wayland. Disabling and enabling an
extension does not reload JavaScript modules already loaded in that session.

## Configuration and comparison engine

Configuration lives in `dev-config.json`, checked once per second. No GSettings
schema is needed. Changing `engine` takes effect after disabling and enabling
the extension; only one engine is constructed at a time. Other settings are live.

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | enable the selected implementation |
| `engine` | `native` | `native` allocates the transition; `transform` runs the previous sampled-endpoint corrector |
| `measure` | `false` | record geometry for the isolated tests |
| `scope` | `active-workspace` | legacy transform engine only; `all` includes inactive workspaces |
| `gate` | `session-picker` | legacy transform engine only; `any-transition` is its experimental broader gate |
| `debug` | `false` | reserved |

The transform engine is retained in `lib/transition.js` as a comparison. It
uses cross-overview endpoint samples and outer actor transforms, and still
needs an initial uncorrected opening when targets are missing or invalidated.
The previous 0.01 px measurements describe that implementation, not native
allocation. Native content allocation is subject to Clutter's pixel rounding.

## Test

```sh
node tests/unit/native-layout.test.cjs
node tests/unit/corrector.test.cjs
CONTAINER=host KEEP=1 tests/run-tests.sh
CONTAINER=host ENABLED=0 EXPECT=nonlinear KEEP=1 tests/run-tests.sh
CONTAINER=host LO_ENGINE=transform KEEP=1 tests/run-tests.sh
CONTAINER=host LO_MONITORS=1280x800,1600x900 KEEP=1 tests/run-tests.sh
```

The harness uses a private HOME, XDG directories, runtime and D-Bus session.
It never changes the live desktop's settings. The default container backend is
`fedora-toolbox-44`; `CONTAINER=host` uses headless GNOME Shell and software
rendering.

Checks cover cold opening, single/two-window layouts, hover, removal before
exit, simulated Shell gesture callbacks with reversals/cancellation, and
actual extension disable/enable. Opening targets are compared with the
independently rendered Shell steady layout, not just their own fitted line.
See [tests/README.md](tests/README.md) and [docs/native-layout.md](docs/native-layout.md)
for validation and limits.
