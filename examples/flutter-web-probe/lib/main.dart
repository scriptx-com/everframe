// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';
import 'dart:async';

import 'package:everframe_flutter/everframe_flutter.dart'
    show
        EverframeSensitive,
        EverframeWebCapture,
        EverframeWebBridge,
        SafeReplayBuffer,
        SensitiveRegionRegistry,
        captureRegisteredFrameAfterFrame;
import 'package:flutter/material.dart';

import 'platform_view.dart';
import 'probe_export.dart';

void main() => runApp(FlutterProbeApp(
      safeVisualMode: Uri.base.queryParameters['safe'] == '1',
      onSafeFrame: emitSafeFrame,
    ));

class FlutterProbeApp extends StatefulWidget {
  const FlutterProbeApp(
      {super.key,
      this.boundaryKey,
      this.safeVisualMode = false,
      this.onSafeFrame,
      this.replayBuffer,
      this.sensitiveRegions});

  final GlobalKey? boundaryKey;
  final bool safeVisualMode;
  final void Function(Uint8List)? onSafeFrame;
  final SafeReplayBuffer? replayBuffer;
  final SensitiveRegionRegistry? sensitiveRegions;

  @override
  State<FlutterProbeApp> createState() => _FlutterProbeAppState();
}

class _FlutterProbeAppState extends State<FlutterProbeApp> {
  late final GlobalKey _boundaryKey = widget.boundaryKey ?? GlobalKey();
  late final SafeReplayBuffer _replay =
      widget.replayBuffer ?? SafeReplayBuffer();
  late final SensitiveRegionRegistry _sensitiveRegions =
      widget.sensitiveRegions ?? SensitiveRegionRegistry();
  late final EverframeWebCapture _webCapture = EverframeWebCapture(
    boundaryKey: _boundaryKey,
    sensitiveRegions: _sensitiveRegions,
    replayBuffer: _replay,
    onSafeFrame: widget.onSafeFrame,
  );
  final EverframeWebBridge _webBridge = const EverframeWebBridge();
  bool _secondScreen = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _webCapture.install();
      unawaited(_webBridge.start(
        sdkKey: 'pk_flutter_probe',
        appVersion: '0.0.0-probe',
      ));
    });
  }

  @override
  void dispose() {
    _webCapture.dispose();
    _webBridge.kill();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: RepaintBoundary(
            key: _boundaryKey,
            child: SizedBox.expand(
              child: Stack(children: [
                Positioned(
                  left: 40,
                  top: 40,
                  width: 160,
                  height: 80,
                  child: ColoredBox(
                    key: Key(_secondScreen ? 'public-tile-b' : 'public-tile-a'),
                    color: _secondScreen
                        ? const Color(0xFF0066FF)
                        : const Color(0xFF00CC00),
                  ),
                ),
                Positioned(
                  left: 40,
                  top: 140,
                  width: 160,
                  height: 80,
                  child: EverframeSensitive(
                    registry: _sensitiveRegions,
                    child: ColoredBox(
                      key: const Key('sensitive-tile'),
                      color: widget.safeVisualMode
                          ? const Color(0xFF000000)
                          : const Color(0xFFFF00FF),
                    ),
                  ),
                ),
                Positioned(
                    left: 40,
                    top: 240,
                    width: 160,
                    height: 80,
                    child: EverframeSensitive(
                      registry: _sensitiveRegions,
                      child: buildPlatformView(),
                    )),
                Positioned(
                  left: 300,
                  top: 40,
                  child: Text(_secondScreen ? 'Screen B' : 'Screen A'),
                ),
                Positioned(
                  left: 300,
                  top: 100,
                  child: ElevatedButton(
                    onPressed: () =>
                        setState(() => _secondScreen = !_secondScreen),
                    child: const Text('Next screen'),
                  ),
                ),
                Positioned(
                  left: 300,
                  top: 170,
                  child: ElevatedButton(
                    onPressed: () async {
                      final bytes = await captureRegisteredFrameAfterFrame(
                          _boundaryKey, _sensitiveRegions);
                      final accepted = await _replay.append(bytes);
                      if (accepted && bytes != null) {
                        widget.onSafeFrame?.call(bytes);
                      }
                    },
                    child: const Text('Capture safe frame'),
                  ),
                ),
                Positioned(
                  left: 300,
                  top: 230,
                  child: ElevatedButton(
                    onPressed: () => unawaited(_webBridge.openReporter()),
                    child: const Text('Open Dart reporter'),
                  ),
                ),
              ]),
            ),
          ),
        ),
      );
}
