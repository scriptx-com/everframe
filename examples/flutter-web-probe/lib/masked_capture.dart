// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

Future<Uint8List?> captureMaskedFrame(
    GlobalKey boundaryKey, List<ui.Rect> sensitiveRects) async {
  final renderObject = boundaryKey.currentContext?.findRenderObject();
  if (renderObject is! RenderRepaintBoundary || !renderObject.hasSize)
    return null;
  final bounds = ui.Offset.zero & renderObject.size;
  if (sensitiveRects.any((rect) =>
      !rect.isFinite ||
      rect.isEmpty ||
      !bounds.contains(rect.topLeft) ||
      !bounds.contains(rect.bottomRight))) {
    return null;
  }

  ui.Image? source;
  ui.Image? masked;
  ui.Picture? picture;
  try {
    source = await renderObject.toImage(pixelRatio: 1);
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawColor(const ui.Color(0xFFFFFFFF), ui.BlendMode.src);
    canvas.drawImage(source, ui.Offset.zero, ui.Paint());
    for (final rect in sensitiveRects) {
      canvas.drawRect(rect, ui.Paint()..color = const ui.Color(0xFF000000));
    }
    picture = recorder.endRecording();
    masked = await picture.toImage(source.width, source.height);
    final encoded = await masked.toByteData(format: ui.ImageByteFormat.png);
    return encoded == null
        ? null
        : Uint8List.fromList(encoded.buffer.asUint8List());
  } catch (_) {
    return null;
  } finally {
    source?.dispose();
    masked?.dispose();
    picture?.dispose();
  }
}
