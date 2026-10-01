// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:everframe_flutter_desktop_probe/main.dart';
import 'package:everframe_flutter_desktop_probe/masked_capture.dart';
import 'package:everframe_flutter_desktop_probe/safe_replay_buffer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('retains only validated copies, bounded by age and bytes', () async {
    var now = const Duration(seconds: 0);
    final replay = SafeReplayBuffer(
      maxAge: const Duration(seconds: 3),
      maxBytes: 5,
      now: () => now,
      validate: (_) async => true,
    );
    final first = Uint8List.fromList([1, 2, 3]);
    expect(await replay.append(first), true);
    first[0] = 99;
    now = const Duration(seconds: 1);
    expect(await replay.append(Uint8List.fromList([4, 5, 6])), true);
    expect(replay.frames.length, 1);
    expect(replay.frames.single.png, [4, 5, 6]);
    now = const Duration(seconds: 5);
    expect(await replay.append(Uint8List.fromList([7, 8])), true);
    expect(replay.frames.length, 1);
    expect(replay.frames.single.png, [7, 8]);
  });

  test('invalid capture revokes the whole replay', () async {
    final replay = SafeReplayBuffer(
      now: () => Duration.zero,
      validate: (bytes) async => bytes[0] != 0,
    );
    expect(await replay.append(Uint8List.fromList([1])), true);
    expect(await replay.append(Uint8List.fromList([0])), false);
    expect(replay.frames, isEmpty);
    expect(replay.revoked, true);
    expect(await replay.append(Uint8List.fromList([2])), false);
    replay.reset();
    expect(await replay.append(Uint8List.fromList([2])), true);
  });

  testWidgets('an unmasked Flutter frame revokes earlier safe frames', (
    tester,
  ) async {
    final key = GlobalKey();
    await tester.pumpWidget(FlutterDesktopProbeApp(boundaryKey: key));
    await tester.pump();
    final replay = SafeReplayBuffer();
    final safe = await tester.runAsync(
      () => captureMaskedFrame(key, [const ui.Rect.fromLTWH(40, 140, 160, 80)]),
    );
    expect(await tester.runAsync(() => replay.append(safe)), true);
    expect(replay.frames.length, 1);

    final unsafe = await tester.runAsync(() => captureMaskedFrame(key, []));
    expect(await tester.runAsync(() => replay.append(unsafe)), false);
    expect(replay.frames, isEmpty);
    expect(replay.revoked, true);
  });
}
