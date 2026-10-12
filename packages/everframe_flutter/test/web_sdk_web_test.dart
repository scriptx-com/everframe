// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@TestOn('browser')
library;

import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late List<JSObject> configs;

  setUp(() {
    configs = [];
    globalContext['everframeFlutterBridgeReady'] = true.toJS;
    globalContext['everframeFlutterInit'] = ((JSObject config) {
      configs.add(config);
      final handle = JSObject();
      handle['destroy'] = (() {}).toJS;
      return handle;
    }).toJS;
  });

  tearDown(() {
    const EverframeWebBridge().kill();
    globalContext.delete('everframeFlutterInit'.toJS);
    globalContext.delete('everframeFlutterBridgeReady'.toJS);
  });

  test('leaves debugBuild out of the web options when the host sets none',
      () async {
    await const EverframeWebBridge()
        .start(sdkKey: 'evf_live_test', appVersion: '1.0.0');
    // @everframe/web detects on `undefined`; an explicit null would not.
    expect(configs.single.has('debugBuild'), isFalse);
  });

  test('passes an explicit debugBuild through to the web options', () async {
    await const EverframeWebBridge().start(
        sdkKey: 'evf_live_test', appVersion: '1.0.0', debugBuild: false);
    expect((configs.single['debugBuild'] as JSBoolean).toDart, isFalse);
  });
}
