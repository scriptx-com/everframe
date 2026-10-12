// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation
import EverframeKit

/// Opt-in handled error for the "error with replay" end-to-end case. With
/// REPLAY_TV_ERROR_AFTER=<seconds> the fixture reports one handled error that
/// long after the SDK starts; REPLAY_TV_RUN goes into the message so every run
/// reports its own. Without the variable nothing is scheduled. The variable
/// carries no credential: the SDK key still arrives only through the launch
/// environment.
enum ErrorProbe {
    @MainActor static func scheduleIfRequested(env: [String: String]) {
        guard let raw = env["REPLAY_TV_ERROR_AFTER"], let seconds = Double(raw), seconds > 0 else { return }
        let run = env["REPLAY_TV_RUN"] ?? "manual"
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            let error = NSError(domain: "dev.everframe.replaytv", code: 7,
                                userInfo: [NSLocalizedDescriptionKey: "Replay fixture handled error \(run)"])
            Everframe.shared.captureException(error)
            NSLog("EVERFRAME_REPLAY_ERROR_SENT run=%@", run)
        }
    }
}
