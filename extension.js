// Linear Overview - screen-space linearisation of the session <-> window
// picker transition (testbed for gnome-shell#2968).
//
// Native mode supplies the session/picker layout before allocation. The old
// transform corrector remains available as an explicit comparison engine.
//
// The hook has to go through InjectionManager: GObject.registerClass installs
// the vfunc callable into the C vtable at class registration time, so a plain
// `WorkspaceLayout.prototype.vfunc_allocate = ...` assignment would simply be
// ignored by Clutter (see docs/analysis.md).
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';

import {Config} from './lib/config.js';
import {Corrector} from './lib/transition.js';
import {NativeLayout} from './lib/nativeLayout.js';
import {rateLimitedErrorLogger} from './lib/log.js';
import * as Measure from './lib/measure.js';

let logError = null;

export default class LinearOverviewExtension extends Extension {
    enable() {
        logError = rateLimitedErrorLogger('[linear-overview]');
        this._logError = logError;
        this._config = new Config(this, logError);
        const engine = this._config.values.engine;
        this._corrector = engine === 'transform' ? new Corrector(this._config, logError) : null;
        this._native = engine === 'native' ? new NativeLayout(this._config, logError) : null;
        Measure.setup();

        const corrector = this._corrector;
        const native = this._native;
        this._injections = new InjectionManager();

        try {
            native?.install(this._injections);
            this._injections.overrideMethod(
                WorkspaceLayout.prototype, 'vfunc_allocate',
                original => function (container, box) {
                    // A failure in here must never break the shell's
                    // allocation, but it must not be swallowed either.
                    try {
                        if (engine === 'transform') {
                            original.call(this, container, box);
                            corrector.apply(this, container, box);
                        } else if (!native.allocate(this, container, box)) {
                            native.prepareOriginal(this);
                            original.call(this, container, box);
                            native.observe(this, container);
                        }
                    } catch (e) {
                        logError('layout override failed, using the shell allocation', e);
                        original.call(this, container, box);
                    }
                });
        } catch (e) {
            logError('could not hook WorkspaceLayout.vfunc_allocate, extension inactive', e);
            this._injections.clear();
        }
    }

    disable() {
        try {
            this._injections?.clear();
        } catch (e) {
            logError('could not unhook WorkspaceLayout.vfunc_allocate', e);
        }
        this._injections = null;

        this._corrector?.destroy();
        this._corrector = null;
        this._native?.destroy();
        this._native = null;

        Measure.teardown();

        this._config?.destroy();
        this._config = null;

        logError = null;
    }
}
