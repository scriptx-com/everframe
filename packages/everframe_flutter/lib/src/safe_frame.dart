// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';
import 'dart:ui' as ui;

/// Probe validator: rejects malformed images and the sample's magenta secret.
/// Production privacy needs a complete sensitive-widget registry as well.
Future<bool> isSafePng(Uint8List encoded) async {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (encoded.length < signature.length) return false;
  for (var i = 0; i < signature.length; i++) {
    if (encoded[i] != signature[i]) return false;
  }
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
    return true;
  } catch (_) {
    return false;
  } finally {
    image?.dispose();
    codec?.dispose();
  }
}
