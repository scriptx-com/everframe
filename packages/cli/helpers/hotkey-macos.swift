// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Global hotkey helper for `npx @everframe/cli hotkey` (macOS).
//
// The CLI compiles this file locally with `xcrun swiftc -O` and runs it as:
//
//   hotkey-<hash> --keycode <n> --modifiers <n>
//
// It registers a Carbon hotkey (no Accessibility permission needed) only while
// the frontmost app is a standalone Android emulator window, i.e. a process
// whose executable name starts with `qemu-system-`, and unregisters it as soon
// as another app comes to the front, so the combo stays free everywhere else.
//
// It writes one JSON object per line to stdout:
//   {"event":"ready"}
//   {"event":"armed","pid":N}      hotkey registered for emulator process N
//   {"event":"disarmed"}           hotkey released
//   {"event":"pressed","pid":N}    hotkey pressed while emulator N was in front
//   {"event":"error","message":"…"}  then exits with status 1 or 2

import AppKit
import Carbon.HIToolbox

func emit(_ fields: [String: Any]) {
  guard
    let data = try? JSONSerialization.data(
      withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes]),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
  fflush(stdout)
}

func uintArgument(_ name: String) -> UInt32? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return UInt32(args[index + 1])
}

let keyNames: [Int: String] = [
  kVK_ANSI_A: "A", kVK_ANSI_B: "B", kVK_ANSI_C: "C", kVK_ANSI_D: "D", kVK_ANSI_E: "E",
  kVK_ANSI_F: "F", kVK_ANSI_G: "G", kVK_ANSI_H: "H", kVK_ANSI_I: "I", kVK_ANSI_J: "J",
  kVK_ANSI_K: "K", kVK_ANSI_L: "L", kVK_ANSI_M: "M", kVK_ANSI_N: "N", kVK_ANSI_O: "O",
  kVK_ANSI_P: "P", kVK_ANSI_Q: "Q", kVK_ANSI_R: "R", kVK_ANSI_S: "S", kVK_ANSI_T: "T",
  kVK_ANSI_U: "U", kVK_ANSI_V: "V", kVK_ANSI_W: "W", kVK_ANSI_X: "X", kVK_ANSI_Y: "Y",
  kVK_ANSI_Z: "Z", kVK_ANSI_0: "0", kVK_ANSI_1: "1", kVK_ANSI_2: "2", kVK_ANSI_3: "3",
  kVK_ANSI_4: "4", kVK_ANSI_5: "5", kVK_ANSI_6: "6", kVK_ANSI_7: "7", kVK_ANSI_8: "8",
  kVK_ANSI_9: "9", kVK_F1: "F1", kVK_F2: "F2", kVK_F3: "F3", kVK_F4: "F4", kVK_F5: "F5",
  kVK_F6: "F6", kVK_F7: "F7", kVK_F8: "F8", kVK_F9: "F9", kVK_F10: "F10", kVK_F11: "F11",
  kVK_F12: "F12",
]

/// The combo in macOS symbols, matching the CLI's own formatting (⌘⌃⌥⇧ then the key).
func comboLabel(keyCode: UInt32, modifiers: UInt32) -> String {
  var label = ""
  if modifiers & UInt32(cmdKey) != 0 { label += "⌘" }
  if modifiers & UInt32(controlKey) != 0 { label += "⌃" }
  if modifiers & UInt32(optionKey) != 0 { label += "⌥" }
  if modifiers & UInt32(shiftKey) != 0 { label += "⇧" }
  return label + (keyNames[Int(keyCode)] ?? "key \(keyCode)")
}

/// Emulators launched from a terminal can inherit the terminal's bundle name and
/// identifier, so the executable is the only reliable signal.
func executableName(_ app: NSRunningApplication) -> String {
  if let name = app.executableURL?.lastPathComponent { return name }
  var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  guard proc_pidpath(app.processIdentifier, &buffer, UInt32(buffer.count)) > 0 else { return "" }
  let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
  return URL(fileURLWithPath: String(decoding: bytes, as: UTF8.self)).lastPathComponent
}

@MainActor
final class HotkeyHelper {
  /// Reached from the Carbon C callback, which cannot capture context.
  static var shared: HotkeyHelper?

  let keyCode: UInt32
  let modifiers: UInt32
  private var hotKeyRef: EventHotKeyRef?
  private var armedPid: pid_t?

  init(keyCode: UInt32, modifiers: UInt32) {
    self.keyCode = keyCode
    self.modifiers = modifiers
  }

  func start() {
    var pressedSpec = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let status = InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, _ in
        // Carbon delivers hotkey events on the main thread's event loop.
        MainActor.assumeIsolated { HotkeyHelper.shared?.pressed() }
        return noErr
      }, 1, &pressedSpec, nil, nil)
    if status != noErr {
      emit(["event": "error", "message": "Couldn't install the hotkey handler (error \(status))."])
      exit(1)
    }

    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] note in
      let front = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      MainActor.assumeIsolated { self?.update(front) }
    }

    // Exit when the CLI that started us is gone (we get reparented to launchd),
    // so a killed CLI never leaves the helper and its hotkey behind.
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
      if getppid() == 1 { exit(0) }
    }

    emit(["event": "ready"])
    update(NSWorkspace.shared.frontmostApplication)
  }

  private func pressed() {
    if let pid = armedPid { emit(["event": "pressed", "pid": Int(pid)]) }
  }

  private func update(_ front: NSRunningApplication?) {
    if let front, executableName(front).hasPrefix("qemu-system-") {
      if hotKeyRef == nil {
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
          keyCode, modifiers, EventHotKeyID(signature: OSType(0x4556_4652), id: 1),  // 'EVFR'
          GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
          let combo = comboLabel(keyCode: keyCode, modifiers: modifiers)
          let message =
            status == OSStatus(eventHotKeyExistsErr)
            ? "\(combo) is already in use by another app. Choose another with --key."
            : "Couldn't register \(combo) (error \(status)). Choose another with --key."
          emit(["event": "error", "message": message])
          exit(1)
        }
        hotKeyRef = ref
      }
      if armedPid != front.processIdentifier {
        armedPid = front.processIdentifier
        emit(["event": "armed", "pid": Int(front.processIdentifier)])
      }
    } else if let ref = hotKeyRef {
      UnregisterEventHotKey(ref)
      hotKeyRef = nil
      armedPid = nil
      emit(["event": "disarmed"])
    }
  }
}

setvbuf(stdout, nil, _IOLBF, 0)

guard let keyCode = uintArgument("--keycode"), let modifiers = uintArgument("--modifiers") else {
  emit(["event": "error", "message": "Usage: hotkey --keycode <n> --modifiers <n>"])
  exit(2)
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  // .accessory: no Dock icon or menu bar, and the most widely used setup for
  // RegisterEventHotKey plus NSWorkspace activation notifications.
  app.setActivationPolicy(.accessory)
  let helper = HotkeyHelper(keyCode: keyCode, modifiers: modifiers)
  HotkeyHelper.shared = helper
  helper.start()
  app.run()
}
