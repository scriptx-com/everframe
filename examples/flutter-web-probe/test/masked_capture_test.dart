// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:everframe_flutter/everframe_flutter.dart'
    show SensitiveRegionRegistry, captureRegisteredFrame;
import 'package:everframe_flutter_web_probe/main.dart';
import 'package:everframe_flutter_web_probe/masked_capture.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<(int, int, Uint8List)> decodePng(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  final frame = await codec.getNextFrame();
  final image = frame.image;
  final rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  final result = (image.width, image.height, rgba!.buffer.asUint8List());
  image.dispose();
  codec.dispose();
  return result;
}

List<int> pixel((int, int, Uint8List) image, int x, int y) {
  final offset = (y * image.$1 + x) * 4;
  return image.$3.sublist(offset, offset + 4);
}

void main() {
  testWidgets(
      'masks every secret tile pixel before PNG encoding and keeps public tile',
      (tester) async {
    final key = GlobalKey();
    final sensitiveRegions = SensitiveRegionRegistry();
    await tester.pumpWidget(FlutterProbeApp(
        boundaryKey: key,
        sensitiveRegions: sensitiveRegions,
        startReporter: false));
    await tester.pump();

    final a = await tester
        .runAsync(() => captureRegisteredFrame(key, sensitiveRegions));
    expect(a, isNotNull);
    final first = (await tester.runAsync(() => decodePng(a!)))!;
    expect(first.$1, greaterThanOrEqualTo(640));
    expect(first.$2, greaterThanOrEqualTo(360));
    expect(pixel(first, 50, 50), [0, 204, 0, 255]);
    expect(pixel(first, 250, 300), [255, 255, 255, 255]);
    var nonBlackPixels = 0;
    for (var y = 148; y < 212; y++) {
      for (var x = 48; x < 192; x++) {
        final offset = (y * first.$1 + x) * 4;
        if (first.$3[offset] != 0 ||
            first.$3[offset + 1] != 0 ||
            first.$3[offset + 2] != 0 ||
            first.$3[offset + 3] != 255) {
          nonBlackPixels++;
        }
      }
    }
    expect(nonBlackPixels, 0);

    await tester.tap(find.text('Next screen'));
    await tester.pump();
    final b = await tester
        .runAsync(() => captureRegisteredFrame(key, sensitiveRegions));
    expect(b, isNotNull);
    final second = (await tester.runAsync(() => decodePng(b!)))!;
    expect(pixel(second, 50, 50), [0, 102, 255, 255]);
    expect(b, isNot(equals(a)));
  });

  testWidgets(
      'fails closed when the boundary is missing or a mask is outside it',
      (tester) async {
    final key = GlobalKey();
    expect(
        await captureMaskedFrame(key, [const Rect.fromLTWH(40, 140, 160, 80)]),
        isNull);

    await tester
        .pumpWidget(FlutterProbeApp(boundaryKey: key, startReporter: false));
    await tester.pump();
    expect(
        await captureMaskedFrame(key, [const Rect.fromLTWH(-1, 140, 160, 80)]),
        isNull);
  });
}
