// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:convert';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

@JS('everframeFlutterProbeFrame')
external set _exportedFrame(JSString value);

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

void emitSafeFrame(Uint8List bytes) {
  _exportedFrame = base64Encode(bytes).toJS;
}

void installWebBridge({
  required Future<Uint8List?> Function() capture,
  required void Function() startReplay,
  required void Function() freezeReplay,
  required Uint8List? Function() takeReplay,
  required void Function() resetReplay,
  required void Function() stopReplay,
}) {
  _captureFrame = (() => capture()
      .then((bytes) => (bytes == null ? '' : base64Encode(bytes)).toJS)
      .toJS).toJS;
  _startReplay = (() => startReplay()).toJS;
  _freezeReplay = (() => freezeReplay()).toJS;
  _takeReplay = (() {
    try {
      final bytes = takeReplay();
      return (bytes == null ? '' : base64Encode(bytes)).toJS;
    } catch (_) {
      return ''.toJS;
    }
  }).toJS;
  _resetReplay = (() => resetReplay()).toJS;
  _stopReplay = (() => stopReplay()).toJS;
  _ready = true.toJS;
  web.window.dispatchEvent(web.Event('everframe-flutter-ready'));
}
