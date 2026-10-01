// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

import 'safe_replay_buffer.dart';
import 'safe_replay_export.dart';
import 'safe_replay_recorder.dart';
import 'sensitive_region.dart';

@JS('everframeFlutterCaptureFrame')
external set _captureFrame(JSFunction value);
@JS('everframeFlutterStartReplay')
external set _startReplay(JSFunction value);
@JS('everframeFlutterFreezeReplay')
external set _freezeReplay(JSFunction value);
@JS('everframeFlutterTakeReplay')
external set _takeReplay(JSFunction value);
@JS('everframeFlutterResetReplay')
external set _resetReplay(JSFunction value);
@JS('everframeFlutterStopReplay')
external set _stopReplay(JSFunction value);
@JS('everframeFlutterBridgeReady')
external set _ready(JSBoolean value);

/// Installs the masked Flutter renderer as the Web SDK's visual provider.
/// Call after the first frame and dispose when the boundary leaves the tree.
class EverframeWebCapture {
  EverframeWebCapture({
    required this.boundaryKey,
    required this.sensitiveRegions,
    SafeReplayBuffer? replayBuffer,
    this.onSafeFrame,
    this.allowUnmarked = false,
  }) : replayBuffer = replayBuffer ?? SafeReplayBuffer() {
    _recorder = SafeReplayRecorder(
      capture: _capture,
      buffer: this.replayBuffer,
      interval: const Duration(milliseconds: 500),
      onFrame: () {
        final frames = this.replayBuffer.frames;
        if (frames.isNotEmpty) onSafeFrame?.call(frames.last.png);
      },
    );
  }

  final GlobalKey boundaryKey;
  final SensitiveRegionRegistry sensitiveRegions;
  final SafeReplayBuffer replayBuffer;
  final void Function(Uint8List)? onSafeFrame;
  final bool allowUnmarked;
  late final SafeReplayRecorder _recorder;
  bool _installed = false;

  Future<Uint8List?> _capture() async {
    await WidgetsBinding.instance.endOfFrame;
    if (!allowUnmarked && !sensitiveRegions.hasRegisteredRegions) return null;
    return captureRegisteredFrame(boundaryKey, sensitiveRegions);
  }

  void install() {
    if (_installed) return;
    _captureFrame = (() => _capture()
        .then((bytes) => (bytes == null ? '' : base64Encode(bytes)).toJS)
        .toJS).toJS;
    _startReplay = (() => unawaited(_recorder.start())).toJS;
    _freezeReplay = (() { _recorder.freeze(); }).toJS;
    _takeReplay = (() {
      try {
        final bytes = exportSafeReplayVTree(replayBuffer, scale: 1);
        return base64Encode(bytes).toJS;
      } catch (_) {
        return ''.toJS;
      }
    }).toJS;
    _resetReplay = (() {
      _recorder.discard();
      unawaited(_recorder.start());
    }).toJS;
    _stopReplay = (() => _recorder.discard()).toJS;
    _ready = true.toJS;
    _installed = true;
    web.window.dispatchEvent(web.Event('everframe-flutter-ready'));
  }

  void dispose() {
    if (!_installed) return;
    _recorder.discard();
    _captureFrame = (() => Future.value(''.toJS).toJS).toJS;
    _startReplay = (() {}).toJS;
    _freezeReplay = (() {}).toJS;
    _takeReplay = (() => ''.toJS).toJS;
    _resetReplay = (() {}).toJS;
    _stopReplay = (() {}).toJS;
    _ready = false.toJS;
    _installed = false;
  }
}
