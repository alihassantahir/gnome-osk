import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';


const SimpleKeyButton = GObject.registerClass(
class SimpleKeyButton extends St.Button {
    _init(config, container) {
        // --- SIZED FOR 864px PORTRAIT SCREEN WIDTH ---
        const baseWidth = 64;   // Fits 11.5 key units + margins inside ~800px
        const minHeight = 60;   // Well-proportioned touch target height
        
        const unitMultiplier = config.unit || 1;
        const calculatedWidth = (baseWidth * unitMultiplier) + ((unitMultiplier - 1) * 4);

        super._init({
            style_class: 'keyboard-key',
            can_focus: false,
            reactive: true,
            x_expand: true,
            y_expand: true,
            style: `
                min-width: ${calculatedWidth}px;
                min-height: ${minHeight}px;
                background-color: ${config.special ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.18)'};
                border-radius: 8px;
                margin: 2px;
                
                font-size: 20px;
                font-family: system-ui, -apple-system, Cantarell, "GNOME Sans", sans-serif;
                font-weight: 600;
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.05);
            `,
        });

        this._container = container;
        this.config = config;

        this._defaultBg = config.special ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.18)';
        this._pressedBg = 'rgba(255, 255, 255, 0.38)';
        this._activeBg  = '#3584e4';

        if (config.iconName) {
            this._icon = new St.Icon({
                icon_name: config.iconName,
                icon_size: 20,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.set_child(this._icon);
        }
        else {
            this._label = new St.Label({
                text: config.label || '',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.set_child(this._label);
        }

        this.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                this._setBackground(this._pressedBg);
                this._container.startKeyPress(this.config);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('button-release-event', (actor, event) => {
            if (event.get_button() === 1) {
                this._restoreBackground();
                this._container.stopKeyPress();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('leave-event', () => {
            this._restoreBackground();
            this._container.stopKeyPress();
        });
    }

    setLabel(text) {
        if (this._label) {
            this._label.set_text(text);
        }
    }

    setActiveState(active) {
        this._setBackground(active ? this._activeBg : this._defaultBg);
    }

    _setBackground(color) {
        this.set_style(this.get_style().replace(/background-color: [^;]+;/, `background-color: ${color};`));
    }

    _restoreBackground() {
        const isShiftActive = this.config.action === 'shift' && this._container._shiftActive;
        this._setBackground(isShiftActive ? this._activeBg : this._defaultBg);
    }
});


// -----------------------------------------------------------------------------
// GNOME Native OSK Layout Container
// -----------------------------------------------------------------------------
export const VirtualKeyboardContainer = GObject.registerClass(
class VirtualKeyboardContainer extends St.BoxLayout {
    _init() {
        super._init({
            name: 'virtual-keyboard-window',
            vertical: true,
            reactive: true,
            visible: false,
            opacity: 0,
            style: `
                padding: 6px 8px 10px 8px;
                border-radius: 16px;
                background-color: rgba(30, 30, 30, 0.98);
                border: 1px solid rgba(255, 255, 255, 0.1);
            `,
        });

        this.set_pivot_point(0.5, 0.5);

        this._shiftActive = false;
        this._symbolsMode = false;

        this._repeatTimeoutId = 0;
        this._repeatIntervalId = 0;
        this._activeKeyConfig = null;
        this._isAnimating = false;

        this.draggable = true;
        this._dragging = false;
        this._grab = null;
        this._grabbedSequence = null;
        this.delta = [];

        // Persistence setup file path
        this._configFile = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_config_dir(), 'osk-position.json'])
        );

        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE
        );

        this._buildHeader();

        this._rowsBox = new St.BoxLayout({ vertical: true, x_expand: true });
        this.add_child(this._rowsBox);
        this._buildLayout();

        // Recalculate layout/position once allocated on stage
        this.connect('notify::allocation', () => {
            if (this.width > 0 && this.height > 0) {
                if (!this._initialPositionSet) {
                    this._initialPositionSet = true;
                    this._restoreOrCenterPosition();
                } else {
                    this._ensureVisibleOnScreen();
                }
            }
        });

        // Safely resolve the Monitor Manager across different GNOME versions
        this._monitorManager = global.backend?.get_monitor_manager() || Meta.MonitorManager?.get();

        const handleMonitorsChanged = () => {
            if (this.visible) {
                this.hideAnimated();
            }
            if (this.width > 0 && this.height > 0) {
                this._restoreOrCenterPosition();
            }
        };

        if (this._monitorManager) {
            this._monitorsChangedId = this._monitorManager.connect('monitors-changed', handleMonitorsChanged);
        } else {
            // Fallback for older Mutter implementations
            this._monitorsChangedId = global.display.connect('monitors-changed', handleMonitorsChanged);
        }
    }

    _getOrientationKey() {
        const monitor = global.display.get_primary_monitor();
        const geometry = global.display.get_monitor_geometry(monitor);
        return geometry.height > geometry.width ? 'portrait' : 'landscape';
    }

    _getBounds() {
        const monitor = global.display.get_primary_monitor();
        const geometry = global.display.get_monitor_geometry(monitor);

        const margin = 10;
        const minX = geometry.x + margin;
        const minY = geometry.y + margin;

        const maxX = Math.max(minX, geometry.x + geometry.width - this.width - margin);
        const maxY = Math.max(minY, geometry.y + geometry.height - this.height - margin);

        return { minX, minY, maxX, maxY, geometry };
    }

    _clampPosition(x, y) {
        const { minX, minY, maxX, maxY } = this._getBounds();
        return [
            Math.max(minX, Math.min(x, maxX)),
            Math.max(minY, Math.min(y, maxY))
        ];
    }

    _ensureVisibleOnScreen() {
        if (this.width <= 0 || this.height <= 0) return;
        const [currX, currY] = this.get_position();
        const [clampedX, clampedY] = this._clampPosition(currX, currY);
        
        if (currX !== clampedX || currY !== clampedY) {
            this.set_position(clampedX, clampedY);
            this._savePosition(clampedX, clampedY);
        }
    }

    _savePosition(x, y) {
        try {
            let configData = {};
            if (this._configFile.query_exists(null)) {
                const [success, contents] = this._configFile.load_contents(null);
                if (success) {
                    try {
                        configData = JSON.parse(new TextDecoder().decode(contents));
                    } catch (e) {
                        configData = {};
                    }
                }
            }

            const orientation = this._getOrientationKey();
            configData[orientation] = { x, y };

            const data = JSON.stringify(configData, null, 2);
            this._configFile.replace_contents(
                data,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            logError(e, 'Failed to save keyboard position');
        }
    }

    _restoreOrCenterPosition() {
        let restored = false;
        const orientation = this._getOrientationKey();

        if (this._configFile.query_exists(null)) {
            try {
                const [success, contents] = this._configFile.load_contents(null);
                if (success) {
                    const configData = JSON.parse(new TextDecoder().decode(contents));
                    if (configData[orientation] && typeof configData[orientation].x === 'number') {
                        const pos = configData[orientation];
                        const [clampedX, clampedY] = this._clampPosition(pos.x, pos.y);
                        this.set_position(clampedX, clampedY);
                        restored = true;
                    }
                }
            } catch (e) {
                logError(e, 'Failed to restore keyboard position');
            }
        }

        if (!restored) {
            const { geometry } = this._getBounds();
            const centerX = geometry.x + (geometry.width - this.width) / 2;
            const centerY = geometry.y + (geometry.height - this.height) / 2;
            const [clampedX, clampedY] = this._clampPosition(centerX, centerY);
            this.set_position(clampedX, clampedY);
        }
    }

    _buildHeader() {
        const headerBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            reactive: true,
            style: `padding: 4px 6px 4px 6px; min-height: 25px;`
        });

        const dragHandle = new St.Widget({
            x_expand: true,
            y_expand: true,
            reactive: true,
        });

        headerBox.add_child(dragHandle);
        this.add_child(headerBox);

        this._setupDrag(dragHandle);
    }

    _setupDrag(dragHandleActor) {
        dragHandleActor.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                const [absX, absY] = event.get_coords();
                const [currX, currY] = this.get_position();
                this.delta = [absX - currX, absY - currY];
                return this.startDragging(event, this.delta);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        dragHandleActor.connect('motion-event', (actor, event) => {
            return this.motionEvent(event);
        });

        dragHandleActor.connect('button-release-event', (actor, event) => {
            if (event.get_button() === 1) {
                return this.endDragging();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    snapMovement(targetX, targetY) {
        const [clampedX, clampedY] = this._clampPosition(targetX, targetY);
        this.set_position(clampedX, clampedY);
    }

    startDragging(event, delta) {
        if (this.draggable) {
            if (this._dragging)
                return Clutter.EVENT_PROPAGATE;

            this._dragging = true;
            this.set_opacity(255);
            this.ease({
                opacity: 200,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => { }
            });

            let sequence = event.get_event_sequence();
            this._grab = global.stage.grab(this);
            this._grabbedSequence = sequence;

            let [absX, absY] = event.get_coords();
            this.snapMovement(absX - delta[0], absY - delta[1]);
            return Clutter.EVENT_STOP;
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
    }

    endDragging() {
        if (this.draggable) {
            if (this._dragging) {
                if (this._grab) {
                    this._grab.dismiss();
                    this._grab = null;
                }

                this.set_opacity(200);
                this.ease({
                    opacity: 255,
                    duration: 100,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => { }
                });

                this._grabbedSequence = null;
                this._dragging = false;

                const [currX, currY] = this.get_position();
                this._savePosition(currX, currY);

                this.delta = [];
            }
            return Clutter.EVENT_STOP;
        } else {
            return Clutter.EVENT_STOP;
        }
    }

    motionEvent(event) {
        if (this.draggable && this._dragging) {
            let [absX, absY] = event.get_coords();
            this.snapMovement(absX - this.delta[0], absY - this.delta[1]);
            return Clutter.EVENT_STOP;
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _getAlphaLayout() {
        return [
            [
                { label: 'q', shiftLabel: 'Q', key: Clutter.KEY_q },
                { label: 'w', shiftLabel: 'W', key: Clutter.KEY_w },
                { label: 'e', shiftLabel: 'E', key: Clutter.KEY_e },
                { label: 'r', shiftLabel: 'R', key: Clutter.KEY_r },
                { label: 't', shiftLabel: 'T', key: Clutter.KEY_t },
                { label: 'y', shiftLabel: 'Y', key: Clutter.KEY_y },
                { label: 'u', shiftLabel: 'U', key: Clutter.KEY_u },
                { label: 'i', shiftLabel: 'I', key: Clutter.KEY_i },
                { label: 'o', shiftLabel: 'O', key: Clutter.KEY_o },
                { label: 'p', shiftLabel: 'P', key: Clutter.KEY_p },
                { label: '⌫', key: Clutter.KEY_BackSpace, action: 'backspace', special: true, unit: 1.5 },
            ],
            [
                { label: 'a', shiftLabel: 'A', key: Clutter.KEY_a },
                { label: 's', shiftLabel: 'S', key: Clutter.KEY_s },
                { label: 'd', shiftLabel: 'D', key: Clutter.KEY_d },
                { label: 'f', shiftLabel: 'F', key: Clutter.KEY_f },
                { label: 'g', shiftLabel: 'G', key: Clutter.KEY_g },
                { label: 'h', shiftLabel: 'H', key: Clutter.KEY_h },
                { label: 'j', shiftLabel: 'J', key: Clutter.KEY_j },
                { label: 'k', shiftLabel: 'K', key: Clutter.KEY_k },
                { label: 'l', shiftLabel: 'L', key: Clutter.KEY_l },
                { label: '↵', key: Clutter.KEY_Return, action: 'enter', special: true, unit: 1.5 },
            ],
            [
                { label: '⇧', key: Clutter.KEY_Shift_L, action: 'shift', special: true, unit: 1.25 },
                { label: 'z', shiftLabel: 'Z', key: Clutter.KEY_z },
                { label: 'x', shiftLabel: 'X', key: Clutter.KEY_x },
                { label: 'c', shiftLabel: 'C', key: Clutter.KEY_c },
                { label: 'v', shiftLabel: 'V', key: Clutter.KEY_v },
                { label: 'b', shiftLabel: 'B', key: Clutter.KEY_b },
                { label: 'n', shiftLabel: 'N', key: Clutter.KEY_n },
                { label: 'm', shiftLabel: 'M', key: Clutter.KEY_m },
                { label: ',', shiftLabel: '<', key: Clutter.KEY_comma },
                { label: '.', shiftLabel: '>', key: Clutter.KEY_period },
                { label: '⇧', key: Clutter.KEY_Shift_R, action: 'shift', special: true, unit: 1.25 },
            ],        
            [
                { label: '?123', action: 'toggle_symbols', special: true, unit: 1.25 },
                { label: '/', shiftLabel: '\\', key: Clutter.KEY_slash },
                { label: 'Space', key: Clutter.KEY_space, unit: 5 },
                { label: '?', shiftLabel: '!', key: Clutter.KEY_question },
                { label: '?123', action: 'toggle_symbols', special: true, unit: 1.25 },
                { action: 'hide_keyboard', iconName: 'go-down-symbolic', special: true, unit: 1 },
            ],
        ];
    }

    _getSymbolsLayout() {
        return [
            [
                { label: '1', key: Clutter.KEY_1 },
                { label: '2', key: Clutter.KEY_2 },
                { label: '3', key: Clutter.KEY_3 },
                { label: '4', key: Clutter.KEY_4 },
                { label: '5', key: Clutter.KEY_5 },
                { label: '6', key: Clutter.KEY_6 },
                { label: '7', key: Clutter.KEY_7 },
                { label: '8', key: Clutter.KEY_8 },
                { label: '9', key: Clutter.KEY_9 },
                { label: '0', key: Clutter.KEY_0 },
                { label: '⌫', key: Clutter.KEY_BackSpace, action: 'backspace', special: true, unit: 1.5 },
            ],
            [
                { label: '@', key: Clutter.KEY_at },
                { label: '#', key: Clutter.KEY_numbersign },
                { label: '$', key: Clutter.KEY_dollar },
                { label: '%', key: Clutter.KEY_percent },
                { label: '&', key: Clutter.KEY_ampersand },
                { label: '-', key: Clutter.KEY_minus },
                { label: '+', key: Clutter.KEY_plus },
                { label: '(', key: Clutter.KEY_parenleft },
                { label: ')', key: Clutter.KEY_parenright },
                { label: '↵', key: Clutter.KEY_Return, action: 'enter', special: true, unit: 1.5 },
            ],
            [
                { label: '*', key: Clutter.KEY_asterisk, special: true, unit: 1.25 },
                { label: '"', key: Clutter.KEY_quotedbl },
                { label: '\'', key: Clutter.KEY_apostrophe },
                { label: ':', key: Clutter.KEY_colon },
                { label: ';', key: Clutter.KEY_semicolon },
                { label: '!', key: Clutter.KEY_exclam },
                { label: '?', key: Clutter.KEY_question },
                { label: '/', key: Clutter.KEY_slash },
                { label: '\\', key: Clutter.KEY_backslash },
                { label: '|', key: Clutter.KEY_bar },
                { label: '⇧', key: Clutter.KEY_Shift_R, action: 'shift', special: true, unit: 1.25 },
            ],
            [
                { label: 'ABC', action: 'toggle_symbols', special: true, unit: 1.5 },
                { label: 'Space', key: Clutter.KEY_space, unit: 6 },
                { label: 'ABC', action: 'toggle_symbols', special: true, unit: 1.5 },
                { action: 'hide_keyboard', iconName: 'go-down-symbolic', special: true, unit: 1 },
            ],
        ];
    }

    _buildLayout() {
        this._rowsBox.destroy_all_children();
        this._keyButtons = [];

        const keyLayout = this._symbolsMode ? this._getSymbolsLayout() : this._getAlphaLayout();

        keyLayout.forEach(rowKeys => {
            const rowBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });

            rowKeys.forEach(keyConfig => {
                const btn = new SimpleKeyButton(keyConfig, this);
                this._keyButtons.push(btn);
                rowBox.add_child(btn);
            });

            this._rowsBox.add_child(rowBox);
        });

        this._updateLabelsAndStates();
    }

    _updateLabelsAndStates() {
        this._keyButtons.forEach(btn => {
            if (!this._symbolsMode && btn.config.shiftLabel) {
                btn.setLabel(this._shiftActive ? btn.config.shiftLabel : btn.config.label);
            }
            if (btn.config.action === 'shift') {
                btn.setActiveState(this._shiftActive);
            }
        });
    }

    showAnimated() {
        this._isAnimating = true;
        this._ensureVisibleOnScreen();
        this.show();
        this.remove_all_transitions();
        this.opacity = 0;
        this.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { 
                this._isAnimating = false; 
            },
        });
    }

    hideAnimated() {
        this._isAnimating = true;
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this.hide();
                this._isAnimating = false;
            },
        });
    }

    toggle() {
        if (this._isAnimating) {
            this.remove_all_transitions();
            this._isAnimating = false;
        }

        if (this.visible && this.opacity > 0) {
            this.hideAnimated();
        } else {
            this.showAnimated();
        }
    }

    _sendSingleKey(keyval) {
        if (!this._virtualDevice || !keyval) return;

        const now = GLib.get_monotonic_time();

        if (this._shiftActive && !this._symbolsMode) {
            this._virtualDevice.notify_keyval(now, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        }

        this._virtualDevice.notify_keyval(now + 1000, keyval, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(now + 20000, keyval, Clutter.KeyState.RELEASED);

        if (this._shiftActive && !this._symbolsMode) {
            this._virtualDevice.notify_keyval(now + 21000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            this._shiftActive = false;
            this._updateLabelsAndStates();
        }
    }

    startKeyPress(config) {
        this._activeKeyConfig = config;

        if (config.action === 'shift') {
            this._shiftActive = !this._shiftActive;
            this._updateLabelsAndStates();
            return;
        }

        if (config.action === 'toggle_symbols') {
            this._symbolsMode = !this._symbolsMode;
            this._buildLayout();
            return;
        }

        if (config.action === 'hide_keyboard') {
            this.hideAnimated();
            return;
        }

        this._repeatTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            400,
            () => {
                this._sendSingleKey(this._activeKeyConfig.key);
                this._repeatIntervalId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    50,
                    () => {
                        this._sendSingleKey(this._activeKeyConfig.key);
                        return GLib.SOURCE_CONTINUE;
                    }
                );
                this._repeatTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    stopKeyPress() {
        if (!this._activeKeyConfig) return;
        const config = this._activeKeyConfig;

        const wasTap = this._repeatTimeoutId !== 0;
        this._clearTimers();

        if (wasTap && config.key && !config.action) {
            this._sendSingleKey(config.key);
        } else if (wasTap && (config.action === 'backspace' || config.action === 'enter')) {
            this._sendSingleKey(config.key);
        }

        this._activeKeyConfig = null;
    }

    _clearTimers() {
        if (this._repeatTimeoutId) {
            GLib.Source.remove(this._repeatTimeoutId);
            this._repeatTimeoutId = 0;
        }
        if (this._repeatIntervalId) {
            GLib.Source.remove(this._repeatIntervalId);
            this._repeatIntervalId = 0;
        }
    }

    destroy() {
        if (this._monitorsChangedId) {
            if (this._monitorManager) {
                this._monitorManager.disconnect(this._monitorsChangedId);
            } else {
                global.display.disconnect(this._monitorsChangedId);
            }
            this._monitorsChangedId = 0;
        }
        this.remove_all_transitions();
        this.stopKeyPress();
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }
        super.destroy();
    } 
});
