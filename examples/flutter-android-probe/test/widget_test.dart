// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:everframe_flutter_android_probe/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('capture boundary spans the full Flutter viewport', (
    tester,
  ) async {
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(FlutterAndroidProbeApp(boundaryKey: boundaryKey));

    expect(
      tester.getSize(find.byKey(boundaryKey)).width,
      tester.getSize(find.byType(Scaffold)).width,
    );
  });

  testWidgets('shows a sensitive tile and changes Flutter screens', (
    tester,
  ) async {
    await tester.pumpWidget(const FlutterAndroidProbeApp());
    expect(find.byKey(const Key('sensitive-tile')), findsOneWidget);
    expect(find.byKey(const Key('public-tile-a')), findsOneWidget);
    await tester.tap(find.text('Next screen'));
    await tester.pump();
    expect(find.byKey(const Key('public-tile-b')), findsOneWidget);
  });
}
