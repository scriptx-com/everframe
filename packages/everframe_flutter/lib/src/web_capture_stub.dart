// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import 'safe_replay_buffer.dart';
import 'sensitive_region.dart';

/// Browser capture is available when this package runs on Flutter web.
class EverframeWebCapture {
  EverframeWebCapture({
    required GlobalKey boundaryKey,
    required SensitiveRegionRegistry sensitiveRegions,
    SafeReplayBuffer? replayBuffer,
    void Function(Uint8List)? onSafeFrame,
    bool allowUnmarked = false,
  });

  void install() => throw UnsupportedError('EverframeWebCapture requires Flutter web');
  void dispose() {}
}
