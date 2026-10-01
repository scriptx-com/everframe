// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:everframe_flutter_web_probe/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('safe submit scene contains no magenta sensitive tile',
      (tester) async {
    await tester.pumpWidget(
        const FlutterProbeApp(safeVisualMode: true, startReporter: false));

    final tile =
        tester.widget<ColoredBox>(find.byKey(const Key('sensitive-tile')));
    expect(tile.color, const Color(0xFF000000));
  });

  testWidgets('shows public and sensitive tiles, then changes screens',
      (tester) async {
    await tester.pumpWidget(const FlutterProbeApp(startReporter: false));

    expect(find.byKey(const Key('public-tile-a')), findsOneWidget);
    expect(find.byKey(const Key('sensitive-tile')), findsOneWidget);
    expect(find.text('Screen A'), findsOneWidget);

    await tester.tap(find.text('Next screen'));
    await tester.pump();

    expect(find.byKey(const Key('public-tile-a')), findsNothing);
    expect(find.byKey(const Key('public-tile-b')), findsOneWidget);
    expect(find.text('Screen B'), findsOneWidget);
  });

  testWidgets('capture button retains two safe frames around a tap',
      (tester) async {
    final replay = SafeReplayBuffer();
    var exported = 0;
    await tester.pumpWidget(FlutterProbeApp(
      startReporter: false,
      replayBuffer: replay,
      onSafeFrame: (_) {
        exported++;
      },
    ));
    await tester.pump();
    Future<void> captureAndWait(int count) async {
      await tester.runAsync(() async {
        await tester.tap(find.text('Capture safe frame'));
        await tester.pump();
        final deadline = DateTime.now().add(const Duration(seconds: 5));
        while (
            replay.frames.length < count && DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
      });
      expect(replay.frames.length, count);
    }

    await captureAndWait(1);
    await tester.tap(find.text('Next screen'));
    await tester.pump();
    await captureAndWait(2);
    expect(replay.frames.length, 2);
    expect(replay.revoked, false);
    expect(exported, 2);
  });
}
