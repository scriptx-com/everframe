// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals demo (tvOS): same recipe as SampleApp/Screens/PlaybackScreen.swift
// — AVKit's VideoPlayer over an AVPlayer this screen owns, attached with
// trackPlayer(). "Open reporter" is dropped here: reporting on tvOS is
// companion-only (see SampleAppTV/ContentView.swift), there is no on-device
// modal reporter to open. onDisappear detaches explicitly (the recommended
// path) and then drops the player, which would also self-detach via the
// release sentinel.
import AVKit
import SwiftUI
import EverframeKit

private let mainStream = URL(string: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8")!

struct TVPlaybackScreen: View {
    @State private var player = AVPlayer(url: mainStream)
    @State private var handle: PlayerHandle?
    @State private var throttled = false
    @State private var adBreaks = 0

    var body: some View {
        VStack(spacing: 16) {
            VideoPlayer(player: player)
                .aspectRatio(16 / 9, contentMode: .fit)
            HStack(spacing: 12) {
                Button(throttled ? "Restore quality" : "Throttle") {
                    throttled.toggle()
                    player.currentItem?.preferredPeakBitRate = throttled ? 600_000 : 0
                }
                Button("Log ad break") {
                    adBreaks += 1
                    let positionMs = Int((player.currentTime().seconds * 1000).rounded())
                    Everframe.shared.trackVitals("ad_break", data: ["position": "midroll", "index": adBreaks, "positionMs": positionMs])
                }
            }
            .buttonStyle(.bordered)
            Text("Session Vitals — playback").font(.footnote).foregroundStyle(.secondary)
        }
        .padding()
        .navigationTitle("Playback")
        .onAppear {
            handle = Everframe.shared.trackPlayer(player, name: "main")
            player.play()
        }
        .onDisappear {
            player.pause()
            handle?.detach()
            handle = nil
        }
    }
}
