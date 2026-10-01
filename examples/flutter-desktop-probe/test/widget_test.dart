// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:everframe_flutter_desktop_probe/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('desktop scene shows public and sensitive tiles across A and B', (
    tester,
  ) async {
    await tester.pumpWidget(const FlutterDesktopProbeApp());

    final a = tester.widget<ColoredBox>(find.byKey(const Key('public-tile-a')));
    final sensitive = tester.widget<ColoredBox>(
      find.byKey(const Key('sensitive-tile')),
    );
    expect(a.color, const Color(0xFF00CC00));
    expect(sensitive.color, const Color(0xFFFF00FF));
    expect(find.text('Screen A'), findsOneWidget);
    expect(find.text('Capture safe frame'), findsOneWidget);

    await tester.tap(find.text('Next screen'));
    await tester.pump();

    final b = tester.widget<ColoredBox>(find.byKey(const Key('public-tile-b')));
    expect(b.color, const Color(0xFF0066FF));
    expect(find.text('Screen B'), findsOneWidget);
    expect(find.byKey(const Key('public-tile-a')), findsNothing);
  });
}
