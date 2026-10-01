// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<List<int>> pixel(Uint8List png, int x, int y) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  final offset = (y * image.width + x) * 4;
  final rgba = data!.buffer.asUint8List().sublist(offset, offset + 4);
  image.dispose();
  codec.dispose();
  return rgba;
}

void main() {
  testWidgets('native reporter receives sensitive bounds in view coordinates',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    const channel = MethodChannel('dev.everframe/flutter');
    MethodCall? sent;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      sent = call;
      return {'status': 'cancelled'};
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Probe')),
        body: RepaintBoundary(
          key: boundary,
          child: Align(
            alignment: Alignment.topLeft,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: EverframeSensitive(
                registry: registry,
                child: const SizedBox(
                  key: Key('secret'),
                  width: 40,
                  height: 30,
                ),
              ),
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
    final expected = tester.getRect(find.byKey(const Key('secret')));
    expect(expected.top, greaterThan(12));
    final replay = SafeReplayBuffer();
    final maskedFrame =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(maskedFrame, isNotNull);
    expect(await tester.runAsync(() => replay.append(maskedFrame)), true);
    replay.freeze();
    final pending =
        tester.runAsync(() => const EverframeNativeBridge().openReporter(
              boundaryKey: boundary,
              sensitiveRegions: registry,
              replayBuffer: replay,
            ));
    await tester.pump();
    await pending;
    expect(sent?.method, 'openReporter');
    final args = sent?.arguments as Map<Object?, Object?>;
    expect(args['pixelRatio'], tester.view.devicePixelRatio);
    expect(args['maskedPng'], isA<Uint8List>());
    final timeline = jsonDecode(utf8.decode(args['replayVTree'] as Uint8List))
        as Map<String, dynamic>;
    expect(timeline['version'], 'everframe-vtree-v1');
    expect((timeline['frames'] as List).length, 1);
    expect(args['sensitiveRects'], [
      {
        'left': expected.left,
        'top': expected.top,
        'right': expected.right,
        'bottom': expected.bottom,
      }
    ]);
  });

  testWidgets('sensitive widget mask follows layout movement', (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    final moved = ValueNotifier(false);
    await tester.pumpWidget(MaterialApp(
      home: RepaintBoundary(
        key: boundary,
        child: SizedBox(
          width: 300,
          height: 200,
          child: ValueListenableBuilder<bool>(
            valueListenable: moved,
            builder: (_, second, __) => Stack(children: [
              const ColoredBox(color: Color(0xFFFFFFFF)),
              Positioned(
                left: second ? 100 : 10,
                top: 20,
                width: 40,
                height: 30,
                child: EverframeSensitive(
                  registry: registry,
                  child: const ColoredBox(color: Color(0xFFFF00FF)),
                ),
              ),
            ]),
          ),
        ),
      ),
    ));
    await tester.pump();

    final first =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(first, isNotNull);
    expect(await tester.runAsync(() => pixel(first!, 20, 30)), [0, 0, 0, 255]);

    moved.value = true;
    await tester.pump();
    final second =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(second, isNotNull);
    expect(
        await tester.runAsync(() => pixel(second!, 110, 30)), [0, 0, 0, 255]);
    expect(await tester.runAsync(() => pixel(second!, 20, 30)),
        [255, 255, 255, 255]);
  });

  testWidgets(
      'replay waits for a new Flutter frame before masking moved content',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    final moved = ValueNotifier(false);
    await tester.pumpWidget(MaterialApp(
      home: RepaintBoundary(
        key: boundary,
        child: SizedBox(
          width: 200,
          height: 100,
          child: ValueListenableBuilder<bool>(
            valueListenable: moved,
            builder: (_, second, __) => Stack(children: [
              const ColoredBox(color: Color(0xFFFFFFFF)),
              Positioned(
                left: second ? 100 : 10,
                top: 20,
                width: 40,
                height: 30,
                child: EverframeSensitive(
                  registry: registry,
                  child: const ColoredBox(color: Color(0xFFFF00FF)),
                ),
              ),
            ]),
          ),
        ),
      ),
    ));
    await tester.pump();

    moved.value = true;
    final pending = tester
        .runAsync(() => captureRegisteredFrameAfterFrame(boundary, registry));
    await tester.pump();
    final frame = await pending;
    expect(frame, isNotNull);
    expect(await tester.runAsync(() => pixel(frame!, 110, 30)), [0, 0, 0, 255]);
    expect(await tester.runAsync(() => pixel(frame!, 20, 30)),
        [255, 255, 255, 255]);
  });

  testWidgets('out-of-bound sensitive region refuses capture', (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(MaterialApp(
      home: Center(
        child: RepaintBoundary(
          key: boundary,
          child: SizedBox(
            width: 300,
            height: 200,
            child: Stack(children: [
              Positioned(
                left: 280,
                top: 20,
                width: 40,
                height: 30,
                child: EverframeSensitive(
                  registry: registry,
                  child: const ColoredBox(color: Color(0xFFFF00FF)),
                ),
              ),
            ]),
          ),
        ),
      ),
    ));
    await tester.pump();
    expect(await captureRegisteredFrame(boundary, registry), isNull);
  });

  testWidgets('sensitive widget may reach an exact boundary edge',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(MaterialApp(
      home: Center(
        child: RepaintBoundary(
          key: boundary,
          child: SizedBox(
            width: 100,
            height: 100,
            child: EverframeSensitive(
              registry: registry,
              child: const ColoredBox(color: Color(0xFFFF00FF)),
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
    final frame =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(frame, isNotNull);
    expect(await tester.runAsync(() => pixel(frame!, 99, 99)), [0, 0, 0, 255]);
  });
}
