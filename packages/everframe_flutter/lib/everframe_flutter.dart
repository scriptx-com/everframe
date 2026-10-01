// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export 'src/masked_capture.dart' show captureMaskedFrame;
export 'src/native_bridge.dart'
    show EverframeNativeBridge, EverframeReporterOutcome;
export 'src/safe_frame.dart' show isSafePng;
export 'src/safe_replay_buffer.dart' show SafeReplayBuffer, SafeReplayFrame;
export 'src/safe_replay_export.dart' show exportSafeReplayVTree;
export 'src/safe_replay_recorder.dart' show SafeReplayRecorder, ReplaySchedule;
export 'src/sensitive_region.dart'
    show
        EverframeSensitive,
        SensitiveRegionRegistry,
        captureRegisteredFrame,
        captureRegisteredFrameAfterFrame;
export 'src/web_capture_stub.dart'
    if (dart.library.js_interop) 'src/web_capture_web.dart'
    show EverframeWebCapture;
export 'src/web_sdk_stub.dart'
    if (dart.library.js_interop) 'src/web_sdk_web.dart'
    show EverframeWebBridge;
