// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)
    let registrar = flutterViewController.registrar(forPlugin: "EverframeDesktopProbe")
    registrar.register(ProbeNativeViewFactory(), withId: "everframe-probe-native-tile")

    super.awakeFromNib()
  }
}

private class ProbeNativeViewFactory: NSObject, FlutterPlatformViewFactory {
  func create(withViewIdentifier viewId: Int64, arguments args: Any?) -> NSView {
    let view = NSView(frame: .zero)
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor(srgbRed: 1, green: 136.0 / 255.0, blue: 0, alpha: 1).cgColor
    return view
  }
}
