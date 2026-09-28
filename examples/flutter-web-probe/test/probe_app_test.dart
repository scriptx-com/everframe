// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:everframe_flutter_web_probe/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows public and sensitive tiles, then changes screens',
      (tester) async {
    await tester.pumpWidget(const FlutterProbeApp());

    expect(find.byKey(const Key('public-tile-a')), findsOneWidget);
    expect(find.byKey(const Key('sensitive-tile')), findsOneWidget);
    expect(find.text('Screen A'), findsOneWidget);

    await tester.tap(find.text('Next screen'));
    await tester.pump();

    expect(find.byKey(const Key('public-tile-a')), findsNothing);
    expect(find.byKey(const Key('public-tile-b')), findsOneWidget);
    expect(find.text('Screen B'), findsOneWidget);
  });
}
