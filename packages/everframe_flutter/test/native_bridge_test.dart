// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('dev.everframe/flutter');
  final calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return call.method == 'openReporter'
          ? {'status': 'cancelled', 'reason': 'dismissed'}
          : null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('starts native SDK and forwards context without changing arguments',
      () async {
    const bridge = EverframeNativeBridge();
    await bridge.start(
        appId: 'app_test', sdkKey: 'txx_dev_test', environment: 'development');
    await bridge.setUser(id: 'u1', email: 'a@example.com');
    await bridge.recordScreen('Checkout');
    await bridge.addBreadcrumb('Tapped pay', kind: 'ui');
    expect(calls.map((call) => call.method), [
      'start',
      'setUser',
      'recordScreen',
      'addBreadcrumb',
    ]);
    expect(calls.first.arguments, {
      'appId': 'app_test',
      'sdkKey': 'txx_dev_test',
      'environment': 'development',
    });
    expect(calls[1].arguments, {'id': 'u1', 'email': 'a@example.com'});
  });

  test('returns native reporter outcome', () async {
    const bridge = EverframeNativeBridge();
    expect(
        await bridge.openReporter(),
        const EverframeReporterOutcome(
            status: 'cancelled', reason: 'dismissed'));
  });

  test('rejects invalid configuration before crossing bridge', () async {
    const bridge = EverframeNativeBridge();
    expect(() => bridge.start(appId: '', sdkKey: 'txx_dev_test'),
        throwsArgumentError);
    expect(
        () => bridge.start(
            appId: 'app_test',
            sdkKey: 'txx_dev_test',
            environment: 'production'),
        throwsArgumentError);
    expect(calls, isEmpty);
  });

  test('requires a Flutter boundary when passing replay', () async {
    final buffer = SafeReplayBuffer(validate: (_) async => true);
    await buffer.append(Uint8List.fromList([1]));
    buffer.freeze();
    expect(
      () => const EverframeNativeBridge().openReporter(replayBuffer: buffer),
      throwsArgumentError,
    );
    expect(calls, isEmpty);
  });
}
