// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:everframe_flutter_desktop_probe/safe_export.dart';
import 'package:flutter_test/flutter_test.dart';

Future<Uint8List> solidPng(ui.Color color) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawColor(color, ui.BlendMode.src);
  final picture = recorder.endRecording();
  final image = await picture.toImage(8, 8);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return Uint8List.fromList(bytes!.buffer.asUint8List());
}

void main() {
  testWidgets('writes only PNGs with no sensitive magenta pixels', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final dir = await Directory.systemTemp.createTemp(
        'everframe-safe-export-',
      );
      try {
        final unsafeFile = File('${dir.path}/unsafe.png');
        final safeFile = File('${dir.path}/safe.png');

        final unsafe = await solidPng(const ui.Color(0xFFFF00FF));
        expect(await writeSafePng(unsafe, unsafeFile), false);
        expect(await unsafeFile.exists(), false);

        final safe = await solidPng(const ui.Color(0xFF000000));
        expect(await writeSafePng(safe, safeFile), true);
        expect(await safeFile.readAsBytes(), safe);
      } finally {
        await dir.delete(recursive: true);
      }
    });
  });
}
