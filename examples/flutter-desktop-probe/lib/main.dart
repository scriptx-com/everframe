// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:io';

import 'package:flutter/material.dart';

import 'masked_capture.dart';
import 'platform_view.dart';
import 'safe_export.dart';

void main() => runApp(FlutterDesktopProbeApp(nativeView: buildPlatformView()));

class FlutterDesktopProbeApp extends StatefulWidget {
  const FlutterDesktopProbeApp({super.key, this.boundaryKey, this.nativeView});

  final GlobalKey? boundaryKey;
  final Widget? nativeView;

  @override
  State<FlutterDesktopProbeApp> createState() => _FlutterDesktopProbeAppState();
}

class _FlutterDesktopProbeAppState extends State<FlutterDesktopProbeApp> {
  late final GlobalKey _boundaryKey = widget.boundaryKey ?? GlobalKey();
  bool _secondScreen = false;

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: RepaintBoundary(
        key: _boundaryKey,
        child: SizedBox.expand(
          child: Stack(
            children: [
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
              const Positioned(
                left: 40,
                top: 140,
                width: 160,
                height: 80,
                child: ColoredBox(
                  key: Key('sensitive-tile'),
                  color: Color(0xFFFF00FF),
                ),
              ),
              Positioned(
                left: 40,
                top: 240,
                width: 160,
                height: 80,
                child:
                    widget.nativeView ??
                    const ColoredBox(color: Color(0xFFFF8800)),
              ),
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
                    final bytes = await captureMaskedFrame(_boundaryKey, [
                      const Rect.fromLTWH(40, 140, 160, 80),
                    ]);
                    if (bytes == null) return;
                    final destination = File(
                      '${Directory.systemTemp.path}/everframe-flutter-desktop-$pid-${_secondScreen ? 'b' : 'a'}.png',
                    );
                    if (await writeSafePng(bytes, destination)) {
                      debugPrint('Safe probe frame: ${destination.path}');
                    }
                  },
                  child: const Text('Capture safe frame'),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
