// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@TestOn('browser')
library;

import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web/web.dart' as web;

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

  test(
    'leaves debugBuild out of the web options when the host sets none',
    () async {
      await const EverframeWebBridge().start(
        sdkKey: 'evf_live_test',
        appVersion: '1.0.0',
      );
      // @everframe/web detects on `undefined`; an explicit null would not.
      expect(configs.single.has('debugBuild'), isFalse);
    },
  );

  test('passes an explicit debugBuild through to the web options', () async {
    await const EverframeWebBridge().start(
      sdkKey: 'evf_live_test',
      appVersion: '1.0.0',
      debugBuild: false,
    );
    expect((configs.single['debugBuild'] as JSBoolean).toDart, isFalse);
  });
  test(
    'enables release health by default and forwards an independent opt-out',
    () async {
      const bridge = EverframeWebBridge();
      await bridge.start(sdkKey: 'evf_live_test', appVersion: '1.0.0');
      expect(
        ((configs.single['releaseHealth'] as JSObject)['enabled'] as JSBoolean)
            .toDart,
        true,
      );
      bridge.kill();
      await bridge.start(
        sdkKey: 'evf_live_test',
        appVersion: '1.0.0',
        releaseHealth: false,
      );
      expect(
        ((configs.last['releaseHealth'] as JSObject)['enabled'] as JSBoolean)
            .toDart,
        false,
      );
      expect(configs.last.has('crashReporting'), false);
    },
  );
  test('repeated starts do not duplicate sessions but apply a changed health opt-out', () async {
    const bridge = EverframeWebBridge();
    await bridge.start(sdkKey: 'evf_live_test', appVersion: '1.0.0');
    await bridge.start(sdkKey: 'evf_live_test', appVersion: '1.0.0');
    expect(configs, hasLength(1));
    await bridge.start(
      sdkKey: 'evf_live_test',
      appVersion: '1.0.0',
      releaseHealth: false,
    );
    expect(configs, hasLength(2));
    expect(
      ((configs.last['releaseHealth'] as JSObject)['enabled'] as JSBoolean)
          .toDart,
      false,
    );
  });
  test('kill cancels a start waiting for the host SDK', () async {
    const bridge = EverframeWebBridge();
    final init = globalContext['everframeFlutterInit'];
    globalContext.delete('everframeFlutterInit'.toJS);
    final pending = bridge.start(sdkKey: 'evf_live_test', appVersion: '1.0.0');
    bridge.kill();
    globalContext['everframeFlutterInit'] = init;
    web.window.dispatchEvent(web.Event('everframe-flutter-web-sdk-ready'));
    await pending;
    expect(configs, isEmpty);
  });
}
