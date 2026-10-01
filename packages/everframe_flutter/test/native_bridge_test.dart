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
          : call.method == 'captureException'
              ? true
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

  test('passes production configuration to the native bridge', () async {
    const bridge = EverframeNativeBridge();
    await bridge.start(appId: 'app_test', sdkKey: 'evf_live_test');
    expect(calls.single.arguments, {
      'appId': 'app_test',
      'sdkKey': 'evf_live_test',
      'environment': 'production',
    });
  });

  test('passes staging configuration to the native bridge', () async {
    const bridge = EverframeNativeBridge();
    await bridge.start(
        appId: 'app_test', sdkKey: 'evf_live_test', environment: 'staging');
    expect(calls.single.arguments['environment'], 'staging');
  });

  test('rejects invalid configuration before crossing bridge', () async {
    const bridge = EverframeNativeBridge();
    expect(() => bridge.start(appId: '', sdkKey: 'txx_dev_test'),
        throwsArgumentError);
    expect(
        () => bridge.start(
            appId: 'app_test',
            sdkKey: 'txx_dev_test',
            environment: 'unknown'),
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

  test('forwards a handled Dart error with its original Dart stack', () async {
    const bridge = EverframeNativeBridge();
    final accepted = await bridge.captureException(
      StateError('checkout failed'),
      stackTrace: StackTrace.fromString('at checkout (lib/pay.dart:42:3)\n'),
    );
    expect(accepted, isTrue);
    expect(calls.single.method, 'captureException');
    expect(calls.single.arguments, {
      'exceptionType': 'StateError',
      'message': 'Bad state: checkout failed',
      'framesRaw': ['at checkout (lib/pay.dart:42:3)'],
    });
  });

  test('network context strips credentials, path, query, and fragment',
      () async {
    const bridge = EverframeNativeBridge();
    await bridge.recordNetwork(
      method: 'POST',
      url: Uri.parse(
          'https://alice:secret@api.example.com/private/customer/123?token=secret#frag'),
      statusCode: 201,
      durationMs: 93,
    );
    expect(calls.single.method, 'addBreadcrumb');
    expect(calls.single.arguments, {
      'message': 'POST https://api.example.com 201',
      'kind': 'network',
      'level': 'info',
      'data': {
        'method': 'POST',
        'origin': 'https://api.example.com',
        'statusCode': 201,
        'durationMs': 93,
      },
    });
  });

  test('invalid network input never crosses the native bridge', () async {
    const bridge = EverframeNativeBridge();
    expect(
      () => bridge.recordNetwork(
        method: 'POST /secret',
        url: Uri.parse('https://example.com'),
        statusCode: 200,
      ),
      throwsArgumentError,
    );
    expect(
      () => bridge.recordNetwork(
        method: 'GET',
        url: Uri.parse('file:///private/secret'),
        statusCode: 200,
      ),
      throwsArgumentError,
    );
    expect(calls, isEmpty);
  });
}
