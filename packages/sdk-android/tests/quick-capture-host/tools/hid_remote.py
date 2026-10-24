#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Writes a script for Android's `hid` shell command that plays timed presses on a virtual remote.

The emulator's `emu event send` does not reach a virtio input device, and `adb shell input keyevent`
cannot hold a key (its `--longpress` sends one repeat at 400 ms and an UP stamped with the DOWN's time).
`/system/bin/hid` registers a uhid device (the shell user is in the `uhid` group), so its keys take the
same path as a Bluetooth remote's: the kernel, the InputReader, and the InputDispatcher's own key repeat.

    hid_remote.py out.json down:PLAYPAUSE wait:1600 up:PLAYPAUSE
    adb -s emulator-<port> push out.json /data/local/tmp/remote.json
    adb -s emulator-<port> shell hid /data/local/tmp/remote.json

Actions: `down:KEY`, `up:KEY`, `tap:KEY[:holdMs]` (default 80 ms) and `wait:MS`. Keys: UP DOWN LEFT RIGHT
ENTER B SHIFT (keyboard usages) and PLAYPAUSE PLAY PAUSE FF RW MENU BACK SELECT (consumer usages).
"""
import json
import sys

# Report 1: a boot-style keyboard (modifier byte, reserved byte, six key slots).
KEYBOARD = [0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01, 0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00,
            0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x01, 0x75, 0x08, 0x81, 0x01, 0x95, 0x06,
            0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, 0xC0]
# Report 2: consumer control, one 16-bit usage.
CONSUMER = [0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x02, 0x19, 0x00, 0x2A, 0xFF, 0x03, 0x15, 0x00, 0x26,
            0xFF, 0x03, 0x75, 0x10, 0x95, 0x01, 0x81, 0x00, 0xC0]
KEYS = {
    'UP': ('key', 0x52), 'DOWN': ('key', 0x51), 'LEFT': ('key', 0x50), 'RIGHT': ('key', 0x4F),
    'ENTER': ('key', 0x28), 'B': ('key', 0x05), 'SHIFT': ('mod', 0x02),
    'PLAYPAUSE': ('consumer', 0xCD), 'PLAY': ('consumer', 0xB0), 'PAUSE': ('consumer', 0xB1),
    'FF': ('consumer', 0xB3), 'RW': ('consumer', 0xB4), 'MENU': ('consumer', 0x40),
    'BACK': ('consumer', 0x224), 'SELECT': ('consumer', 0x41),
}


def main(argv):
    out = [
        {"id": 1, "command": "register", "name": "Everframe test remote", "vid": 0x1234, "pid": 0x5678,
         "bus": "bluetooth", "descriptor": KEYBOARD + CONSUMER},
        # Give the InputReader time to add the device before the first report.
        {"id": 1, "command": "delay", "duration": 2500},
    ]
    state = {"mods": 0, "held": [], "consumer": 0}

    def report(kind):
        if kind == 'consumer':
            usage = state["consumer"]
            return {"id": 1, "command": "report", "report": [2, usage & 0xFF, (usage >> 8) & 0xFF]}
        return {"id": 1, "command": "report", "report": [1, state["mods"], 0] + (state["held"] + [0] * 6)[:6]}

    def press(down, name):
        kind, code = KEYS[name]
        if kind == 'mod':
            state["mods"] = state["mods"] | code if down else state["mods"] & ~code
        elif kind == 'key':
            if down:
                state["held"].append(code)
            else:
                state["held"].remove(code)
        else:
            state["consumer"] = code if down else 0
        out.append(report(kind))

    for action in argv[2:]:
        parts = action.split(':')
        if parts[0] in ('down', 'up'):
            press(parts[0] == 'down', parts[1])
        elif parts[0] == 'wait':
            out.append({"id": 1, "command": "delay", "duration": int(parts[1])})
        elif parts[0] == 'tap':
            press(True, parts[1])
            out.append({"id": 1, "command": "delay", "duration": int(parts[2]) if len(parts) > 2 else 80})
            press(False, parts[1])
        else:
            raise SystemExit(f"unknown action: {action}")
    # Keep the device registered long enough for the last key-up to be dispatched.
    out.append({"id": 1, "command": "delay", "duration": 1500})
    with open(argv[1], 'w') as f:
        f.write('\n'.join(json.dumps(o) for o in out) + '\n')


if __name__ == '__main__':
    main(sys.argv)
