// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:async';
import 'dart:typed_data';

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('samples immediately and on ticks, then freezes a bounded replay',
      () async {
    void Function()? tick;
    var cancelled = false;
    var captures = 0;
    final secondStored = Completer<void>();
    final buffer = SafeReplayBuffer(validate: (_) async => true);
    final recorder = SafeReplayRecorder(
      capture: () async => Uint8List.fromList([++captures]),
      buffer: buffer,
      schedule: (_, callback) {
        tick = callback;
        return () => cancelled = true;
      },
      onFrame: () {
        if (buffer.frames.length == 2) secondStored.complete();
      },
    );

    expect(await recorder.start(), true);
    expect(buffer.frames.length, 1);
    tick!();
    await secondStored.future;
    final frozen = recorder.freeze();
    expect(frozen.map((frame) => frame.png.single), [1, 2]);
    expect(cancelled, true);
    expect(await recorder.sampleNow(), false);
  });

  test('freeze drops a capture still in flight', () async {
    void Function()? tick;
    final pending = Completer<Uint8List?>();
    var captures = 0;
    final buffer = SafeReplayBuffer(validate: (_) async => true);
    final recorder = SafeReplayRecorder(
      capture: () {
        captures++;
        return pending.future;
      },
      buffer: buffer,
      schedule: (_, callback) {
        tick = callback;
        return () {};
      },
    );

    final starting = recorder.start();
    tick!();
    expect(captures, 1);
    expect(recorder.freeze(), isEmpty);
    pending.complete(Uint8List.fromList([1]));
    expect(await starting, false);
    expect(buffer.frames, isEmpty);
  });

  test('unsafe frame clears earlier frames and stops sampling', () async {
    void Function()? tick;
    final revoked = Completer<void>();
    var captures = 0;
    final buffer = SafeReplayBuffer(validate: (bytes) async => bytes[0] != 0);
    final recorder = SafeReplayRecorder(
      capture: () async => Uint8List.fromList([captures++ == 0 ? 1 : 0]),
      buffer: buffer,
      schedule: (_, callback) {
        tick = callback;
        return () {};
      },
      onRevoked: revoked.complete,
    );

    expect(await recorder.start(), true);
    tick!();
    await revoked.future;
    expect(buffer.revoked, true);
    expect(buffer.frames, isEmpty);
    expect(await recorder.sampleNow(), false);
  });
}
