// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:convert';
import 'dart:js_interop';
import 'dart:typed_data';

@JS('everframeFlutterProbeFrame')
external set _exportedFrame(JSString value);

void emitSafeFrame(Uint8List bytes) {
  _exportedFrame = base64Encode(bytes).toJS;
}
