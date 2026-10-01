// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

Future<Uint8List> png(int color) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    const ui.Rect.fromLTWH(0, 0, 4, 2),
    ui.Paint()..color = ui.Color(color),
  );
  final image = await recorder.endRecording().toImage(4, 2);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('frozen masked frames export as a replayable VTree image timeline', () async {
    var elapsed = const Duration(milliseconds: 200);
    final buffer = SafeReplayBuffer(
      now: () => elapsed,
      validate: (_) async => true,
    );
    final first = await png(0xff00ff00);
    final second = await png(0xff0000ff);
    expect(await buffer.append(first), true);
    elapsed = const Duration(milliseconds: 400);
    expect(await buffer.append(second), true);
    buffer.freeze();

    final timeline = jsonDecode(utf8.decode(exportSafeReplayVTree(buffer, scale: 2)))
        as Map<String, dynamic>;
    expect(timeline['version'], 'everframe-vtree-v1');
    expect(timeline['originEpochMs'], isA<int>());
    expect(timeline['viewport'], {'width': 2, 'height': 1, 'scale': 2});
    final frames = timeline['frames'] as List<dynamic>;
    expect(frames.map((frame) => frame['timestamp']), [0, 200]);
    final root = frames.first['ops'][0]['node'] as Map<String, dynamic>;
    expect(root['role'], 'image');
    expect(root['children'], isEmpty);
    final assets = timeline['assets'] as Map<String, dynamic>;
    expect(assets.length, 2);
    expect(base64Decode(assets[root['imageRef']]['b64']), first);
    expect(frames.last['ops'][0], {
      'op': 'set',
      'id': 'flutter-root',
      'imageRef': isA<String>(),
    });
  });

  test('export requires frozen, consistent, bounded frames', () async {
    final buffer = SafeReplayBuffer(validate: (_) async => true);
    await buffer.append(await png(0xff00ff00));
    expect(() => exportSafeReplayVTree(buffer, scale: 1), throwsStateError);
    buffer.freeze();
    expect(() => exportSafeReplayVTree(buffer, scale: 0), throwsArgumentError);
    expect(() => exportSafeReplayVTree(buffer, scale: 1), returnsNormally);
  });

  test('empty or revoked replay cannot become an attachment', () async {
    final empty = SafeReplayBuffer(validate: (_) async => true);
    empty.freeze();
    expect(() => exportSafeReplayVTree(empty, scale: 1), throwsStateError);
    final revoked = SafeReplayBuffer(validate: (_) async => false);
    await revoked.append(await png(0xff00ff00));
    revoked.freeze();
    expect(() => exportSafeReplayVTree(revoked, scale: 1), throwsStateError);
  });

  test('rapid samples stay within the native VTree frame limit', () async {
    var elapsed = Duration.zero;
    final buffer = SafeReplayBuffer(
      now: () => elapsed,
      validate: (_) async => true,
    );
    final frame = await png(0xff00ff00);
    for (var i = 0; i < 200; i++) {
      elapsed = Duration(milliseconds: i * 100);
      expect(await buffer.append(frame), true);
    }

    expect(buffer.frames, hasLength(SafeReplayBuffer.maxFrames));
    buffer.freeze();
    final timeline = jsonDecode(utf8.decode(exportSafeReplayVTree(buffer, scale: 1)))
        as Map<String, dynamic>;
    expect(timeline['frames'], hasLength(SafeReplayBuffer.maxFrames));
  });
}
