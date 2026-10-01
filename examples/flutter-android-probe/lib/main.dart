// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter/material.dart';

void main() => runApp(const FlutterAndroidProbeApp());

class FlutterAndroidProbeApp extends StatefulWidget {
  const FlutterAndroidProbeApp({
    super.key,
    this.bridge,
    this.boundaryKey,
    this.sensitiveRegions,
  });

  final EverframeNativeBridge? bridge;
  final GlobalKey? boundaryKey;
  final SensitiveRegionRegistry? sensitiveRegions;

  @override
  State<FlutterAndroidProbeApp> createState() => _FlutterAndroidProbeAppState();
}

class _FlutterAndroidProbeAppState extends State<FlutterAndroidProbeApp> {
  late final _boundaryKey = widget.boundaryKey ?? GlobalKey();
  late final _sensitiveRegions =
      widget.sensitiveRegions ?? SensitiveRegionRegistry();
  final _replay = SafeReplayBuffer();
  late final _bridge = widget.bridge ?? const EverframeNativeBridge();
  late final _recorder = SafeReplayRecorder(
    capture: () =>
        captureRegisteredFrameAfterFrame(_boundaryKey, _sensitiveRegions),
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
      await WidgetsBinding.instance.endOfFrame;
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

  Future<void> _recordContext() async {
    try {
      await _bridge.recordNetwork(
        method: 'GET',
        url: Uri.parse('https://api.example.com/orders/123?token=private'),
        statusCode: 503,
        durationMs: 93,
      );
      final accepted = await _bridge.captureException(
        StateError('probe checkout failure'),
        stackTrace: StackTrace.current,
      );
      if (mounted) setState(() => _status = 'Dart error stored: $accepted');
    } catch (error) {
      if (mounted) setState(() => _status = 'Context failed: $error');
    }
  }

  Future<void> _open() async {
    final wasRecording = _recorder.active;
    if (wasRecording) _recorder.freeze();
    debugPrint(
      'Flutter replay before reporter: active=$wasRecording '
      'frames=${_replay.frames.length} revoked=${_replay.revoked}',
    );
    try {
      final outcome = await _bridge.openReporter(
        boundaryKey: _boundaryKey,
        sensitiveRegions: _sensitiveRegions,
        replayBuffer: wasRecording ? _replay : null,
      );
      debugPrint(
        'Flutter reporter outcome: ${outcome.status} ${outcome.reason}',
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
      appBar: AppBar(title: const Text('Everframe Flutter Android probe')),
      body: SizedBox.expand(
        child: RepaintBoundary(
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
                ElevatedButton(
                  onPressed: _recordContext,
                  child: const Text('Record Dart context'),
                ),
                Text(_status),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
