// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:ui' as ui;

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:everframe_flutter_ios_probe/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

Future<List<int>> centerPixel(Uint8List png, int y) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  final offset = (y * image.width + image.width ~/ 2) * 4;
  final rgba = data!.buffer.asUint8List().sublist(offset, offset + 4);
  image.dispose();
  codec.dispose();
  return rgba;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('retains masked Flutter A/B frames on iOS', (tester) async {
    final boundary = GlobalKey();
    final sensitive = SensitiveRegionRegistry();
    await tester.pumpWidget(
      FlutterIosProbeApp(boundaryKey: boundary, sensitiveRegions: sensitive),
    );
    await tester.pumpAndSettle();

    final buffer = SafeReplayBuffer();
    final recorder = SafeReplayRecorder(
      capture: () => captureRegisteredFrame(boundary, sensitive),
      buffer: buffer,
      interval: const Duration(seconds: 5),
    );
    expect(await recorder.start(), true);
    await tester.tap(find.text('Next screen'));
    await tester.pumpAndSettle();
    expect(await recorder.sampleNow(), true);
    final frames = recorder.freeze();
    expect(frames.length, 2);
    expect(await centerPixel(frames.first.png, 50), [0, 204, 0, 255]);
    expect(await centerPixel(frames.last.png, 50), [0, 102, 255, 255]);
    expect(await centerPixel(frames.first.png, 140), [0, 0, 0, 255]);
    expect(await centerPixel(frames.last.png, 140), [0, 0, 0, 255]);
    expect(buffer.revoked, false);
  });

  testWidgets('routes Flutter calls into the native SDK', (tester) async {
    const bridge = EverframeNativeBridge();
    await bridge.start(
      appId: '00000000-0000-0000-0000-000000000001',
      sdkKey: 'txx_live_00000000000000000000000000000000',
      environment: 'development',
    );
    await bridge.setUser(id: 'dry-run-user');
    await bridge.recordScreen('Flutter checkout');
    await bridge.addBreadcrumb('Tapped continue', kind: 'ui');
    await bridge.recordNetwork(
      method: 'GET',
      url: Uri.parse('https://api.example.com/orders/123?token=private'),
      statusCode: 503,
      durationMs: 93,
    );
    expect(
      await bridge.captureException(
        StateError('Flutter integration probe'),
        stackTrace: StackTrace.fromString('at checkout (lib/pay.dart:42:3)'),
      ),
      isTrue,
    );
    await bridge.kill();
    await expectLater(
      bridge.openReporter(),
      throwsA(
        isA<PlatformException>().having(
          (error) => error.code,
          'code',
          'not_started',
        ),
      ),
    );
  });
}
