// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:everframe_flutter_desktop_probe/main.dart';
import 'package:everframe_flutter_desktop_probe/masked_capture.dart';
import 'package:everframe_flutter_desktop_probe/platform_view.dart';
import 'package:everframe_flutter_desktop_probe/safe_export.dart';
import 'package:everframe_flutter_desktop_probe/safe_replay_buffer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

Future<(int, int, Uint8List)> rgba(Uint8List png) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final bytes = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  final result = (image.width, image.height, bytes!.buffer.asUint8List());
  image.dispose();
  codec.dispose();
  return result;
}

double fraction((int, int, Uint8List) frame, int top, List<int> rgb) {
  var matches = 0;
  var total = 0;
  for (var y = top + 8; y < top + 72; y++) {
    for (var x = 48; x < 192; x++) {
      final i = (y * frame.$1 + x) * 4;
      if ((frame.$3[i] - rgb[0]).abs() <= 16 &&
          (frame.$3[i + 1] - rgb[1]).abs() <= 16 &&
          (frame.$3[i + 2] - rgb[2]).abs() <= 16) {
        matches++;
      }
      total++;
    }
  }
  return matches / total;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('measures live masked macOS frames and native view', (
    tester,
  ) async {
    final key = GlobalKey();
    await tester.pumpWidget(
      FlutterDesktopProbeApp(boundaryKey: key, nativeView: buildPlatformView()),
    );
    await tester.pumpAndSettle();

    const sensitive = Rect.fromLTWH(40, 140, 160, 80);
    final replay = SafeReplayBuffer();
    final a = await captureMaskedFrame(key, [sensitive]);
    expect(a, isNotNull);
    expect(await replay.append(a), true);
    final first = await rgba(a!);
    expect(fraction(first, 40, [0, 204, 0]), greaterThan(0.8));
    expect(fraction(first, 140, [0, 0, 0]), greaterThan(0.95));

    await tester.tap(find.text('Next screen'));
    await tester.pumpAndSettle();
    final b = await captureMaskedFrame(key, [sensitive]);
    expect(b, isNotNull);
    expect(await replay.append(b), true);
    expect(replay.frames.length, 2);
    final second = await rgba(b!);
    expect(fraction(second, 40, [0, 102, 255]), greaterThan(0.8));
    expect(fraction(second, 140, [0, 0, 0]), greaterThan(0.95));

    final dir = await Directory.systemTemp.createTemp(
      'everframe-flutter-macos-',
    );
    final firstFile = File('${dir.path}/renderer-a.png');
    final secondFile = File('${dir.path}/renderer-b.png');
    expect(await writeSafePng(a, firstFile), true);
    expect(await writeSafePng(b, secondFile), true);
    final evidence = {
      'size': [first.$1, first.$2],
      'publicA': fraction(first, 40, [0, 204, 0]),
      'publicB': fraction(second, 40, [0, 102, 255]),
      'sensitiveA': fraction(first, 140, [0, 0, 0]),
      'sensitiveB': fraction(second, 140, [0, 0, 0]),
      'nativeA': fraction(first, 240, [255, 136, 0]),
      'nativeB': fraction(second, 240, [255, 136, 0]),
      'replayFrames': replay.frames.length,
      'replayRevoked': replay.revoked,
    };
    await File('${dir.path}/renderer-evidence.json')
        .writeAsString(const JsonEncoder.withIndent('  ').convert(evidence));
    // ignore: avoid_print
    print('EVERFRAME_MACOS_PROBE_DIR=${dir.path}');
  });
}
