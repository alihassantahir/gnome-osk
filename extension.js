import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import { VirtualKeyboardContainer } from './virtualKeyboardContainer.js';

/**
 * Panel Status Bar Indicator
 */
const Indicator = GObject.registerClass(
class Indicator extends St.Bin {
    _init(keyboardContainer) {
        super._init({
            style_class: 'panel-button',
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._keyboard = keyboardContainer;
        this._icon = new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            style_class: 'system-status-icon',
        });
        this.set_child(this._icon);

        this.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                this._keyboard.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }
});

/**
 * Extension Lifecycle Management
 */
export default class VirtualKeyboardExtension extends Extension {
    enable() {
        this._keyboard = new VirtualKeyboardContainer();
        Main.layoutManager.uiGroup.add_child(this._keyboard);

        const monitor = Main.layoutManager.primaryMonitor;
        const keyboardWidth = 970;
        const keyboardHeight = 420;
        const bottomOffset = 50;

        this._keyboard.set_position(
            monitor.x + Math.floor((monitor.width - keyboardWidth) / 2),
            monitor.y + monitor.height - keyboardHeight - bottomOffset
        );

        this._indicator = new Indicator(this._keyboard);

        // --- Placement Logic ---
        const rightBox = Main.panel._rightBox;
        const quickSettings = Main.panel.statusArea.quickSettings;

        if (quickSettings) {
            // Find the child index of Quick Settings within the rightBox container
            const children = rightBox.get_children();
            const qsIndex = children.indexOf(quickSettings.container || quickSettings);

            if (qsIndex !== -1) {
                // Insert right next to Quick Settings (to its left in LTR layouts)
                rightBox.insert_child_at_index(this._indicator, qsIndex);
            } else {
                // Fallback: place at the far right if index calculation fails
                rightBox.add_child(this._indicator);
            }
        } else {
            // Fallback for older GNOME versions where Quick Settings isn't present
            rightBox.insert_child_at_index(this._indicator, 0);
        }
    }

    disable() {
        if (this._indicator) {
            Main.panel._rightBox.remove_child(this._indicator);
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._keyboard) {
            Main.layoutManager.uiGroup.remove_child(this._keyboard);
            this._keyboard.destroy();
            this._keyboard = null;
        }
    }
}
