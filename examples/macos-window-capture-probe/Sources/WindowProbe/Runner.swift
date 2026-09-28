// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import CoreGraphics
import Foundation
import ScreenCaptureKit

@main
struct Runner {
    static func main() async {
        do {
            try await run(Array(CommandLine.arguments.dropFirst()))
        } catch {
            fputs("BLOCKED:\(error)\n", stderr)
            exit(2)
        }
    }

    static func run(_ args: [String]) async throws {
        guard args.count == 8, args[0] == "--pid", let pid = Int32(args[1]), pid > 0,
              args[2] == "--title", !args[3].isEmpty,
              args[4] == "--state", ["a", "b"].contains(args[5]),
              args[6] == "--out", !args[7].isEmpty else {
            throw ProbeError.arguments
        }
        guard CGPreflightScreenCaptureAccess() else { throw ProbeError.permission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let records = content.windows.compactMap { window -> ProbeWindow? in
            guard let application = window.owningApplication else { return nil }
            return ProbeWindow(id: window.windowID, pid: application.processID, title: window.title ?? "")
        }
        guard let selected = selectWindow(records, pid: pid, title: args[3]),
              let window = content.windows.first(where: { $0.windowID == selected.id }) else {
            throw ProbeError.windowIdentity
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded())
        config.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded())
        config.showsCursor = false
        guard config.width >= 200, config.height >= 300 else { throw ProbeError.geometry }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let (png, metrics) = try validatedPng(image: image, state: args[5])
        guard metrics.publicCoverage >= 0.95, metrics.sensitiveCoverage >= 0.95 else {
            throw ProbeError.unsafeFrame
        }
        let output = URL(fileURLWithPath: args[7], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let pngURL = output.appendingPathComponent("window-\(args[5]).png")
        try png.write(to: pngURL, options: .atomic)
        let report = """
        {"state":"\(args[5])","windowID":\(selected.id),"size":[\(metrics.width),\(metrics.height)],"publicCoverage":\(metrics.publicCoverage),"sensitiveCoverage":\(metrics.sensitiveCoverage),"nativeCoverage":\(metrics.nativeCoverage)}
        """
        try report.write(to: output.appendingPathComponent("window-\(args[5]).json"), atomically: true, encoding: .utf8)
        print("PASS:\(pngURL.path)")
    }
}

private enum ProbeError: Error {
    case arguments, permission, windowIdentity, geometry, unsafeFrame
}
