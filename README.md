# Minimal OSK for GNOME Shell

A lightweight, beautiful, and highly responsive floating on-screen keyboard (OSK) designed for GNOME Shell.

GNOME's default on-screen keyboard lacks flexibility and customization. This extension provides a sleek, modern touch keyboard that can be dragged anywhere on the screen and stays out of your way.

## Features

- **Minimalist UI**: Clean, glassmorphism-inspired dark theme built using GNOME's native `St` and `Clutter` toolkits.
- **Draggable & Persistent**: Drag the keyboard anywhere on screen. Position coordinates automatically save and restore based on display orientation (portrait vs landscape).
- **Virtual Key Input**: Uses Clutter's native virtual input device interface for key presses.
- **Key Repeat**: Long-pressing a key automatically repeats input (ideal for Backspace/Delete).
- **Multi-Monitor Aware**: Automatically updates layout and keeps the keyboard within screen boundaries when monitors or orientations change.
- **Layout Support**: Toggle between alphabetic (`QWERTY`) and symbolic (`?123`) modes.

## Installation

### Manual Installation

1. Clone the repository into your GNOME Shell extensions directory:

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/
   git clone [https://github.com/alihassantahir/gnome-osk.git](https://github.com/alihassantahir/gnome-osk.git) ~/.local/share/gnome-shell/extensions/osk@aht.com
