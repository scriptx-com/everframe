// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `hotkey` used to run a macOS helper that listened for a global shortcut and
// sent the capture broadcast to the emulator in front. The SDKs now take
// Shift+B inside the app on both platforms, so the command only says so. It
// still accepts its old `--key` flag so existing scripts keep exiting 0.

export const HOTKEY_RETIRED_MESSAGE =
  'The hotkey command is no longer needed: press Shift+B in the emulator (outside a text field) to capture. npx @everframe/cli capture still works.';

export function hotkeyCommand(deps: { out: (line: string) => void }): number {
  deps.out(HOTKEY_RETIRED_MESSAGE);
  return 0;
}
