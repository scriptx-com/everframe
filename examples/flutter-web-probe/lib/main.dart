// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:flutter/material.dart';

import 'platform_view.dart';

void main() => runApp(const FlutterProbeApp());

class FlutterProbeApp extends StatefulWidget {
  const FlutterProbeApp({super.key, this.boundaryKey});

  final GlobalKey? boundaryKey;

  @override
  State<FlutterProbeApp> createState() => _FlutterProbeAppState();
}

class _FlutterProbeAppState extends State<FlutterProbeApp> {
  late final GlobalKey _boundaryKey = widget.boundaryKey ?? GlobalKey();
  bool _secondScreen = false;

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
                    child: buildPlatformView()),
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
              ]),
            ),
          ),
        ),
      );
}
