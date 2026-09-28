// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

Future<bool> writeSafePng(Uint8List encoded, File destination) async {
  ui.Codec? codec;
  ui.Image? image;
  try {
    codec = await ui.instantiateImageCodec(encoded);
    image = (await codec.getNextFrame()).image;
    if (image.width == 0 || image.height == 0) return false;
    final rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    if (rgba == null) return false;
    final pixels = rgba.buffer.asUint8List();
    for (var i = 0; i < pixels.length; i += 4) {
      if (pixels[i] >= 239 && pixels[i + 1] <= 16 && pixels[i + 2] >= 239) {
        return false;
      }
    }
    await destination.writeAsBytes(encoded, flush: true);
    return true;
  } catch (_) {
    return false;
  } finally {
    image?.dispose();
    codec?.dispose();
  }
}
