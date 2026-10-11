// Two plain GTK4 windows used as preview subjects.
//
// The exact geometry does not matter: automation.js moves and resizes both
// windows through Meta so that every test case is deterministic.  The second
// window exists so the picker layout is non-trivial (two previews in one row),
// and it is moved to another workspace for the single-window case.
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

const app = new Gtk.Application({application_id: 'org.linearoverview.Window'});

function createWindow(title, width, height) {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title,
        default_width: width,
        default_height: height,
    });
    window.set_child(new Gtk.Label({label: title, vexpand: true}));
    return window;
}

app.connect('activate', () => {
    const display = Gdk.Display.get_default();
    const provider = new Gtk.CssProvider();
    provider.load_from_string(
        'window, window > .titlebar, headerbar {' +
        '  background-color: #202020;' +
        '  background-image: none;' +
        '  color: #f0f0f0;' +
        '}');
    Gtk.StyleContext.add_provider_for_display(
        display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    createWindow('LO Test Window A', 520, 360).present();
    createWindow('LO Test Window B', 260, 200).present();
});

app.run([]);
