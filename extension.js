// Linear Overview - screen-space linearisation of the session <-> window
// picker transition (testbed for gnome-shell#2968).
//
// The whole extension is one hook: WorkspaceLayout.vfunc_allocate() is
// wrapped after the original ran, and the corrector re-pins the previews to
// the linear interpolation of their session and picker geometry.
//
// The hook has to go through InjectionManager: GObject.registerClass installs
// the vfunc callable into the C vtable at class registration time, so a plain
// `WorkspaceLayout.prototype.vfunc_allocate = ...` assignment would simply be
// ignored by Clutter (see docs/analysis.md).
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';

import {Config} from './lib/config.js';
import {Corrector} from './lib/transition.js';
import {rateLimitedErrorLogger} from './lib/log.js';
import * as Measure from './lib/measure.js';

let logError = null;

export default class LinearOverviewExtension extends Extension {
    enable() {
        logError = rateLimitedErrorLogger('[linear-overview]');
        this._logError = logError;
        this._config = new Config(this, logError);
        this._corrector = new Corrector(this._config, logError);
        Measure.setup();

        const corrector = this._corrector;
        this._injections = new InjectionManager();

        try {
            this._injections.overrideMethod(
                WorkspaceLayout.prototype, 'vfunc_allocate',
                original => function (container, box) {
                    original.call(this, container, box);

                    // A failure in here must never break the shell's
                    // allocation, but it must not be swallowed either.
                    try {
                        corrector.apply(this, container, box);
                    } catch (e) {
                        logError('correction failed', e);
                    }
                });
        } catch (e) {
            logError('could not hook WorkspaceLayout.vfunc_allocate, extension inactive', e);
        }
    }

    disable() {
        try {
            this._injections?.clear();
        } catch (e) {
            logError('could not unhook WorkspaceLayout.vfunc_allocate', e);
        }
        this._injections = null;

        this._corrector?.clear();
        this._corrector = null;

        Measure.teardown();

        this._config?.destroy();
        this._config = null;

        logError = null;
    }
}
