// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const channelName = 'dev.everframe/flutter';
const channel = MethodChannel(channelName);
const codec = StandardMethodCodec();

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

/// Delivers the native SDK's `quickCaptureEvidence` call to Dart, as the
/// plugin does on the platform thread, and decodes Dart's reply.
Future<Object?> nativeAsksForEvidence() async {
  final reply = Completer<ByteData?>();
  await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .handlePlatformMessage(
    channelName,
    codec.encodeMethodCall(const MethodCall('quickCaptureEvidence')),
    reply.complete,
  );
  final bytes = await reply.future;
  return bytes == null ? null : codec.decodeEnvelope(bytes);
}

Widget probe(GlobalKey boundary, SensitiveRegionRegistry registry,
        {double sensitiveLeft = 12}) =>
    MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Probe')),
        body: RepaintBoundary(
          key: boundary,
          child: SizedBox(
            width: 300,
            height: 200,
            child: Stack(children: [
              const Positioned.fill(
                child: ColoredBox(color: Color(0xFFFFFFFF)),
              ),
              Positioned(
                left: sensitiveLeft,
                top: 12,
                width: 40,
                height: 30,
                child: EverframeSensitive(
                  registry: registry,
                  child: const ColoredBox(
                    key: Key('secret'),
                    color: Color(0xFFFF00FF),
                  ),
                ),
              ),
            ]),
          ),
        ),
      ),
    );

/// Runs [onRead] when the capture reads sensitive geometry, which happens
/// after the frame and before the masked image is encoded.
class _ObservedRegistry extends SensitiveRegionRegistry {
  _ObservedRegistry(this.onRead);

  final void Function() onRead;

  @override
  List<ui.Rect>? rectsInView(GlobalKey boundaryKey) {
    onRead();
    return super.rectsInView(boundaryKey);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return null;
    });
  });

  tearDown(() async {
    await const EverframeNativeBridge().disableQuickCapture();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('start forwards quickCapture (default true, false when set)', () async {
    const bridge = EverframeNativeBridge();
    await bridge.start(appId: 'app_test', sdkKey: 'evf_live_test');
    await bridge.start(
      appId: 'app_test',
      sdkKey: 'evf_live_test',
      quickCapture: false,
    );
    expect(calls.map((call) => call.method), ['start', 'start']);
    expect(calls[0].arguments['quickCapture'], true);
    expect(calls[1].arguments['quickCapture'], false);
  });

  testWidgets('quickCaptureEvidence returns the masked frame map',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(probe(boundary, registry));
    await tester.pump();
    final expected = tester.getRect(find.byKey(const Key('secret')));

    // A live recording buffer: quick capture snapshots it without freezing it.
    final replay = SafeReplayBuffer();
    final frame =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(await tester.runAsync(() => replay.append(frame)), true);

    await const EverframeNativeBridge().enableQuickCapture(
      boundaryKey: boundary,
      sensitiveRegions: registry,
      replayBuffer: replay,
    );
    expect(calls.single.method, 'setQuickCaptureHost');
    expect(calls.single.arguments, {'enabled': true});

    final pending = tester.runAsync(nativeAsksForEvidence);
    await tester.pump();
    final evidence = await pending as Map<Object?, Object?>;

    expect(evidence['pixelRatio'], tester.view.devicePixelRatio);
    final png = evidence['maskedPng'] as Uint8List;
    expect(await tester.runAsync(() => isSafePng(png)), true);
    // The sensitive widget is blacked out in the image itself.
    expect(await tester.runAsync(() => pixel(png, 20, 20)), [0, 0, 0, 255]);
    expect(await tester.runAsync(() => pixel(png, 200, 150)),
        [255, 255, 255, 255]);
    expect(evidence['sensitiveRects'], [
      {
        'left': expected.left,
        'top': expected.top,
        'right': expected.right,
        'bottom': expected.bottom,
      }
    ]);
    final timeline =
        jsonDecode(utf8.decode(evidence['replayVTree'] as Uint8List))
            as Map<String, dynamic>;
    expect(timeline['version'], 'everframe-vtree-v1');
    expect((timeline['frames'] as List).length, 1);
    expect(replay.frozen, false, reason: 'recording must keep running');
  });

  testWidgets('quickCaptureEvidence returns null when the boundary is detached',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(probe(boundary, registry));
    await const EverframeNativeBridge().enableQuickCapture(
      boundaryKey: boundary,
      sensitiveRegions: registry,
    );
    await tester.pumpWidget(const SizedBox());

    final pending = tester.runAsync(nativeAsksForEvidence);
    await tester.pump();
    expect(await pending, isNull);
  });

  testWidgets('quickCaptureEvidence returns null when the mask is uncertain',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    // The sensitive widget overhangs the boundary, so no mask can be trusted.
    await tester.pumpWidget(probe(boundary, registry, sensitiveLeft: 280));
    await const EverframeNativeBridge().enableQuickCapture(
      boundaryKey: boundary,
      sensitiveRegions: registry,
    );

    final pending = tester.runAsync(nativeAsksForEvidence);
    await tester.pump();
    expect(await pending, isNull);
  });

  test('quickCaptureEvidence returns null without a registration', () async {
    expect(await nativeAsksForEvidence(), isNull);
  });

  testWidgets('disableQuickCapture sends enabled false', (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(probe(boundary, registry));
    const bridge = EverframeNativeBridge();
    await bridge.enableQuickCapture(
      boundaryKey: boundary,
      sensitiveRegions: registry,
    );
    await bridge.disableQuickCapture();
    expect(calls.map((call) => call.arguments), [
      {'enabled': true},
      {'enabled': false},
    ]);
    expect(calls.map((call) => call.method).toSet(), {'setQuickCaptureHost'});
    // A late native request after disabling gets no image.
    expect(await nativeAsksForEvidence(), isNull);
  });

  testWidgets('a revoked replay buffer sends the masked frame without replay',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(probe(boundary, registry));
    final replay = SafeReplayBuffer();
    final frame =
        await tester.runAsync(() => captureRegisteredFrame(boundary, registry));
    expect(await tester.runAsync(() => replay.append(frame)), true);
    // A failed mask revokes the replay.
    expect(await tester.runAsync(() => replay.append(null)), false);
    expect(replay.revoked, true);
    await const EverframeNativeBridge().enableQuickCapture(
      boundaryKey: boundary,
      sensitiveRegions: registry,
      replayBuffer: replay,
    );

    final pending = tester.runAsync(nativeAsksForEvidence);
    await tester.pump();
    final evidence = await pending as Map<Object?, Object?>;
    expect(evidence['maskedPng'], isA<Uint8List>());
    expect(evidence.containsKey('replayVTree'), false);
  });

  testWidgets('quickCaptureEvidence answers null after 4 s without a frame',
      (tester) async {
    final registry = SensitiveRegionRegistry();
    final boundary = GlobalKey();
    await tester.pumpWidget(probe(boundary, registry));
    await const EverframeNativeBridge().enableQuickCapture(
      boundaryKey: boundary,
      sensitiveRegions: registry,
    );
    // A paused app renders no frames, so the capture never gets one.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);

    var answered = false;
    Object? answer = 'pending';
    unawaited(nativeAsksForEvidence().then((value) {
      answered = true;
      answer = value;
    }));
    await tester.pump(const Duration(milliseconds: 3900));
    expect(answered, false);
    await tester.pump(const Duration(milliseconds: 200));
    expect(answered, true);
    expect(answer, isNull);

    // Let the abandoned capture's frame wait finish inside this test; with
    // the boundary gone it fails closed.
    await tester.pumpWidget(const SizedBox());
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
  });

  testWidgets('a registration replaced during a capture gets no image',
      (tester) async {
    const bridge = EverframeNativeBridge();
    final boundary = GlobalKey();
    var replace = true;
    late final _ObservedRegistry registry;
    registry = _ObservedRegistry(() {
      if (!replace) return;
      replace = false;
      unawaited(bridge.enableQuickCapture(
        boundaryKey: boundary,
        sensitiveRegions: registry,
      ));
    });
    await tester.pumpWidget(probe(boundary, registry));
    await bridge.enableQuickCapture(
      boundaryKey: boundary,
      sensitiveRegions: registry,
    );

    final first = tester.runAsync(nativeAsksForEvidence);
    await tester.pump();
    expect(await first, isNull);
    expect(calls.map((call) => call.arguments), [
      {'enabled': true},
      {'enabled': true},
    ]);

    // The replacement registration answers the next capture.
    final second = tester.runAsync(nativeAsksForEvidence);
    await tester.pump();
    expect(await second, isA<Map<Object?, Object?>>());
  });
}
