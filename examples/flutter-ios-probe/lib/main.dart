// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter/material.dart';

void main() => runApp(const FlutterIosProbeApp());

class FlutterIosProbeApp extends StatefulWidget {
  const FlutterIosProbeApp({
    super.key,
    this.bridge,
    this.boundaryKey,
    this.sensitiveRegions,
  });

  final EverframeNativeBridge? bridge;
  final GlobalKey? boundaryKey;
  final SensitiveRegionRegistry? sensitiveRegions;

  @override
  State<FlutterIosProbeApp> createState() => _FlutterIosProbeAppState();
}

class _FlutterIosProbeAppState extends State<FlutterIosProbeApp> {
  late final _boundaryKey = widget.boundaryKey ?? GlobalKey();
  late final _sensitiveRegions =
      widget.sensitiveRegions ?? SensitiveRegionRegistry();
  final _replay = SafeReplayBuffer();
  late final _bridge = widget.bridge ?? const EverframeNativeBridge();
  late final _recorder = SafeReplayRecorder(
    capture: () => captureRegisteredFrame(_boundaryKey, _sensitiveRegions),
    buffer: _replay,
  );
  bool _secondScreen = false;
  String _status = 'Ready';

  @override
  void dispose() {
    _recorder.discard();
    super.dispose();
  }

  Future<void> _start() async {
    try {
      await _bridge.start(
        appId: const String.fromEnvironment(
          'EVERFRAME_APP_ID',
          defaultValue: '00000000-0000-0000-0000-000000000001',
        ),
        sdkKey: const String.fromEnvironment(
          'EVERFRAME_SDK_KEY',
          defaultValue: 'txx_live_00000000000000000000000000000000',
        ),
        environment: 'development',
      );
      await _bridge.recordScreen('Screen A');
      await _recorder.start();
      if (mounted) setState(() => _status = 'Native SDK started');
    } catch (error) {
      if (mounted) setState(() => _status = 'Start failed: $error');
    }
  }

  Future<void> _next() async {
    setState(() => _secondScreen = !_secondScreen);
    await WidgetsBinding.instance.endOfFrame;
    await _recorder.sampleNow();
    try {
      await _bridge.recordScreen(_secondScreen ? 'Screen B' : 'Screen A');
    } catch (_) {
      // Screen changes also work before the native SDK is configured.
    }
  }

  Future<void> _open() async {
    final wasRecording = _recorder.active;
    if (wasRecording) _recorder.freeze();
    try {
      final outcome = await _bridge.openReporter(
        boundaryKey: _boundaryKey,
        sensitiveRegions: _sensitiveRegions,
      );
      if (mounted) setState(() => _status = 'Reporter: ${outcome.status}');
    } catch (error) {
      if (mounted) setState(() => _status = 'Reporter failed: $error');
    } finally {
      if (wasRecording && mounted) await _recorder.start();
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      appBar: AppBar(title: const Text('Everframe Flutter iOS probe')),
      body: RepaintBoundary(
        key: _boundaryKey,
        child: ColoredBox(
          color: Colors.white,
          child: Column(
            children: [
              const SizedBox(height: 24),
              Container(
                key: Key(_secondScreen ? 'public-tile-b' : 'public-tile-a'),
                height: 70,
                width: 160,
                color: _secondScreen
                    ? const Color(0xFF0066FF)
                    : const Color(0xFF00CC00),
              ),
              const SizedBox(height: 16),
              EverframeSensitive(
                registry: _sensitiveRegions,
                child: const SizedBox(
                  height: 70,
                  width: 160,
                  child: ColoredBox(
                    key: Key('sensitive-tile'),
                    color: Color(0xFFFF00FF),
                  ),
                ),
              ),
              Text(_secondScreen ? 'Screen B' : 'Screen A'),
              ElevatedButton(
                onPressed: _start,
                child: const Text('Start dry run'),
              ),
              ElevatedButton(
                onPressed: _next,
                child: const Text('Next screen'),
              ),
              ElevatedButton(
                onPressed: _open,
                child: const Text('Open reporter'),
              ),
              Text(_status),
            ],
          ),
        ),
      ),
    ),
  );
}
