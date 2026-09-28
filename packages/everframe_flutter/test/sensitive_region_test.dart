// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<List<int>> pixel(Uint8List png, int x, int y) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  final offset = (y * image.width + x) * 4;
  final rgba = data!.buffer.asUint8List().sublist(offset, offset + 4);
  image.dispose();
  codec.dispose();
  return rgba;
}

void main() {
  testWidgets('sensitive widget mask follows layout movement', (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    final moved = ValueNotifier(false);
    await tester.pumpWidget(MaterialApp(
      home: RepaintBoundary(
        key: boundary,
        child: SizedBox(
          width: 300,
          height: 200,
          child: ValueListenableBuilder<bool>(
            valueListenable: moved,
            builder: (_, second, __) => Stack(children: [
              const ColoredBox(color: Color(0xFFFFFFFF)),
              Positioned(
                left: second ? 100 : 10,
                top: 20,
                width: 40,
                height: 30,
                child: EverframeSensitive(
                  registry: registry,
                  child: const ColoredBox(color: Color(0xFFFF00FF)),
                ),
              ),
            ]),
          ),
        ),
      ),
    ));
    await tester.pump();

    final first =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(first, isNotNull);
    expect(await tester.runAsync(() => pixel(first!, 20, 30)), [0, 0, 0, 255]);

    moved.value = true;
    await tester.pump();
    final second =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(second, isNotNull);
    expect(
        await tester.runAsync(() => pixel(second!, 110, 30)), [0, 0, 0, 255]);
    expect(await tester.runAsync(() => pixel(second!, 20, 30)),
        [255, 255, 255, 255]);
  });

  testWidgets('out-of-bound sensitive region refuses capture', (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(MaterialApp(
      home: Center(
        child: RepaintBoundary(
          key: boundary,
          child: SizedBox(
            width: 300,
            height: 200,
            child: Stack(children: [
              Positioned(
                left: 280,
                top: 20,
                width: 40,
                height: 30,
                child: EverframeSensitive(
                  registry: registry,
                  child: const ColoredBox(color: Color(0xFFFF00FF)),
                ),
              ),
            ]),
          ),
        ),
      ),
    ));
    await tester.pump();
    expect(await captureRegisteredFrame(boundary, registry), isNull);
  });
}
