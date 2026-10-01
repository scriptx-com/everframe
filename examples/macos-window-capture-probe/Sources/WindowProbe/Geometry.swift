// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

struct ProbeWindow: Equatable {
    let id: UInt32
    let pid: Int32
    let title: String
}

func selectWindow(_ windows: [ProbeWindow], pid: Int32, title: String) -> ProbeWindow? {
    let matching = windows.filter { $0.pid == pid && $0.title == title }
    return matching.count == 1 ? matching[0] : nil
}

struct PixelRect: Equatable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    var maxX: Int { x + width }
    var maxY: Int { y + height }
}

/// Calibrates the sample's sensitive tile against its visible public tile.
/// The marker is 160x80 points; the sensitive tile begins 100 points below it.
func maskRect(marker: PixelRect, imageWidth: Int, imageHeight: Int) -> PixelRect? {
    guard marker.x >= 0, marker.y >= 0, marker.maxX <= imageWidth,
          marker.maxY <= imageHeight, marker.width >= 80, marker.height >= 40 else { return nil }
    let xScale = Double(marker.width) / 160.0
    let yScale = Double(marker.height) / 80.0
    guard abs(xScale - yScale) <= 0.02, xScale >= 0.5, xScale <= 4 else { return nil }
    let inset = 4
    let y = marker.y + Int((100.0 * yScale).rounded()) - inset
    let rect = PixelRect(x: marker.x - inset, y: y,
                         width: marker.width + 2 * inset,
                         height: marker.height + 2 * inset)
    guard rect.x >= 0, rect.y >= 0, rect.maxX <= imageWidth,
          rect.maxY <= imageHeight else { return nil }
    return rect
}
