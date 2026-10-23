// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'sensitive_region.dart';
import 'safe_replay_buffer.dart';
import 'safe_replay_export.dart';

/// Native reporter bridge for Flutter Android and iOS hosts.
class EverframeNativeBridge {
  const EverframeNativeBridge();

  static const MethodChannel _channel = MethodChannel('dev.everframe/flutter');

  /// Dart answers the native evidence request within this bound, ahead of the
  /// native SDK's own 5 second limit.
  static const Duration _quickCaptureTimeout = Duration(seconds: 4);

  static _QuickCaptureRegistration? _quickCapture;

  /// Starts the native SDK. [crash] is its crash capture switch (`capture.crash`): on Android it
  /// covers JVM exceptions, native crashes and ANRs; on iOS native crashes. It also gates
  /// [captureException]. On by default, as in the native SDKs.
  /// [releaseHealth] counts native foreground sessions and native crashes, not Dart errors.
  /// Setting it false leaves crash/error reporting on. [crash] false also disables health.
  /// [debugBuild] overrides native detection when supplied; debug builds do not count.
  /// [quickCapture] false opts this app out of quick capture (⇧B in a debug simulator or
  /// emulator, shake on a real phone) and of device linking. It is on by default, but a Flutter
  /// app files quick captures only after [enableQuickCapture] supplies masked Flutter evidence;
  /// without it the native SDK files nothing.
  Future<void> start({
    required String appId,
    required String sdkKey,
    String environment = 'production',
    bool crash = true,
    bool releaseHealth = true,
    bool? debugBuild,
    bool quickCapture = true,
  }) {
    if (appId.isEmpty || sdkKey.isEmpty) {
      throw ArgumentError('appId and sdkKey are required');
    }
    if (!const {'development', 'staging', 'production'}.contains(environment)) {
      throw ArgumentError.value(
        environment,
        'environment',
        'unsupported environment',
      );
    }
    return _channel.invokeMethod<void>('start', {
      'appId': appId,
      'sdkKey': sdkKey,
      'environment': environment,
      'crash': crash,
      'releaseHealth': releaseHealth && crash,
      if (debugBuild != null) 'debugBuild': debugBuild,
      'quickCapture': quickCapture,
    });
  }

  Future<EverframeReporterOutcome> openReporter({
    GlobalKey? boundaryKey,
    SensitiveRegionRegistry? sensitiveRegions,
    SafeReplayBuffer? replayBuffer,
  }) async {
    if ((boundaryKey == null) != (sensitiveRegions == null)) {
      throw ArgumentError('boundaryKey and sensitiveRegions must be paired');
    }
    if (replayBuffer != null && boundaryKey == null) {
      throw ArgumentError('replayBuffer requires a Flutter boundary');
    }
    // captureMaskedFrame emits one pixel per logical Flutter point. A failed
    // replay export omits replay while preserving the manual bug report.
    final arguments = boundaryKey == null
        ? const <String, Object?>{}
        : await _maskedEvidence(
            boundaryKey,
            sensitiveRegions!,
            replayBuffer,
            exportReplay: (buffer) => exportSafeReplayVTree(buffer, scale: 1),
          );
    final result = await _channel.invokeMapMethod<String, Object?>(
      'openReporter',
      arguments,
    );
    final status = result?['status'];
    final reportId = result?['reportId'];
    final reason = result?['reason'];
    if (status is! String ||
        !const {'submitted', 'queued', 'cancelled'}.contains(status) ||
        (status != 'cancelled' && reportId is! String)) {
      throw const FormatException('Invalid native reporter result');
    }
    return EverframeReporterOutcome(
      status: status,
      reportId: reportId is String ? reportId : null,
      reason: reason is String ? reason : null,
    );
  }

  Future<void> setUser({String? id, String? email, String? displayName}) =>
      _channel.invokeMethod<void>('setUser', {
        if (id != null) 'id': id,
        if (email != null) 'email': email,
        if (displayName != null) 'displayName': displayName,
      });

  Future<void> recordScreen(String name) =>
      _channel.invokeMethod<void>('recordScreen', {'name': name});

  Future<void> addBreadcrumb(String message, {String? kind, String? level}) =>
      _channel.invokeMethod<void>('addBreadcrumb', {
        'message': message,
        'kind': kind,
        'level': level,
      });

  /// Persists a handled Dart error in the native SDK's encrypted error outbox.
  /// A true result acknowledges local storage, not delivery to the server.
  Future<bool> captureException(Object error, {StackTrace? stackTrace}) async {
    final frames = (stackTrace ?? StackTrace.current)
        .toString()
        .split('\n')
        .map((frame) => frame.trim())
        .where((frame) => frame.isNotEmpty)
        .take(256)
        .map((frame) => frame.length > 1024 ? frame.substring(0, 1024) : frame)
        .toList();
    final message = error.toString();
    return await _channel.invokeMethod<bool>('captureException', {
          'exceptionType': error.runtimeType.toString(),
          'message': message.length > 4096
              ? message.substring(0, 4096)
              : message,
          'framesRaw': frames,
        }) ??
        false;
  }

  /// Adds opt-in network context without request or response content.
  /// Paths, queries, fragments, credentials, headers, and bodies are omitted.
  Future<void> recordNetwork({
    required String method,
    required Uri url,
    required int statusCode,
    int? durationMs,
  }) {
    const methods = {
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    };
    if (!methods.contains(method)) throw ArgumentError.value(method, 'method');
    if (!const {'http', 'https'}.contains(url.scheme) || url.host.isEmpty) {
      throw ArgumentError.value(url, 'url', 'HTTP(S) URL required');
    }
    if (statusCode < 100 || statusCode > 599) {
      throw ArgumentError.value(statusCode, 'statusCode');
    }
    if (durationMs != null && (durationMs < 0 || durationMs > 86400000)) {
      throw ArgumentError.value(durationMs, 'durationMs');
    }
    final origin = url.origin;
    return _channel.invokeMethod<void>('addBreadcrumb', {
      'message': '$method $origin $statusCode',
      'kind': 'network',
      'level': statusCode >= 400 ? 'error' : 'info',
      'data': {
        'method': method,
        'origin': origin,
        'statusCode': statusCode,
        if (durationMs != null) 'durationMs': durationMs,
      },
    });
  }

  Future<void> kill() => _channel.invokeMethod<void>('kill');

  /// Lets quick capture file reports from this app: ⇧B or `npx @everframe/cli capture` in a
  /// debug simulator or emulator, and a shake on a real phone that is linked on the dashboard
  /// (any build) or runs a debug build. Flutter masks sensitive widgets in Dart, so the native
  /// SDK never takes its own screenshot here: on each capture it asks for the masked frame of
  /// [boundaryKey], exactly as [openReporter] would send it, with a snapshot of [replayBuffer]
  /// when supplied. When the masked frame cannot be produced safely the capture fails and no
  /// image is sent.
  ///
  /// Without this registration nothing uploads: a shake on a linked or debug phone shows
  /// `Capture failed` on iOS and is ignored on Android. Unlinked release builds on end users'
  /// phones never arm quick capture, so this is inert there.
  ///
  /// Call after [start]. The registration survives [kill] and a later [start].
  Future<void> enableQuickCapture({
    required GlobalKey boundaryKey,
    required SensitiveRegionRegistry sensitiveRegions,
    SafeReplayBuffer? replayBuffer,
  }) {
    _quickCapture = _QuickCaptureRegistration(
      boundaryKey,
      sensitiveRegions,
      replayBuffer,
    );
    _channel.setMethodCallHandler(_handleNativeCall);
    return _channel.invokeMethod<void>('setQuickCaptureHost', {
      'enabled': true,
    });
  }

  /// Removes the [enableQuickCapture] registration. Quick capture then files nothing again.
  Future<void> disableQuickCapture() {
    _quickCapture = null;
    _channel.setMethodCallHandler(null);
    return _channel.invokeMethod<void>('setQuickCaptureHost', {
      'enabled': false,
    });
  }

  static Future<Object?> _handleNativeCall(MethodCall call) async {
    if (call.method != 'quickCaptureEvidence') {
      throw MissingPluginException('No Dart handler for ${call.method}');
    }
    final registration = _quickCapture;
    if (registration == null) return null;
    Future<Map<String, Object?>?> evidence() async {
      try {
        final arguments = await _maskedEvidence(
          registration.boundaryKey,
          registration.sensitiveRegions,
          registration.replayBuffer,
          exportReplay: (buffer) => exportSafeReplaySnapshot(buffer, scale: 1),
        );
        // Disabled or replaced while capturing: send nothing.
        return identical(_quickCapture, registration) ? arguments : null;
      } catch (_) {
        return null;
      }
    }

    return evidence().timeout(_quickCaptureTimeout, onTimeout: () => null);
  }

  /// The masked Flutter evidence the native reporter and quick capture take: the
  /// masked PNG, the view's pixel ratio, sensitive bounds in view coordinates and
  /// an optional replay timeline. Throws [StateError] when the geometry or the
  /// masked image is unavailable, so an unmasked image is never returned.
  static Future<Map<String, Object?>> _maskedEvidence(
    GlobalKey boundaryKey,
    SensitiveRegionRegistry sensitiveRegions,
    SafeReplayBuffer? replayBuffer, {
    required Uint8List Function(SafeReplayBuffer buffer) exportReplay,
  }) async {
    await WidgetsBinding.instance.endOfFrame;
    final rects = sensitiveRegions.rectsInView(boundaryKey);
    if (rects == null) {
      throw StateError('Sensitive widget geometry is unavailable');
    }
    final maskedPng = await captureRegisteredFrame(
      boundaryKey,
      sensitiveRegions,
    );
    if (maskedPng == null) {
      throw StateError('Masked Flutter screenshot is unavailable');
    }
    final context = boundaryKey.currentContext;
    final pixelRatio = context == null
        ? null
        : View.of(context).devicePixelRatio;
    Uint8List? replayVTree;
    if (replayBuffer != null) {
      try {
        replayVTree = exportReplay(replayBuffer);
      } on StateError {
        replayVTree = null;
      }
    }
    return {
      if (pixelRatio != null) 'pixelRatio': pixelRatio,
      'maskedPng': maskedPng,
      if (replayVTree != null) 'replayVTree': replayVTree,
      'sensitiveRects': rects
          .map(
            (rect) => {
              'left': rect.left,
              'top': rect.top,
              'right': rect.right,
              'bottom': rect.bottom,
            },
          )
          .toList(),
    };
  }
}

class _QuickCaptureRegistration {
  const _QuickCaptureRegistration(
    this.boundaryKey,
    this.sensitiveRegions,
    this.replayBuffer,
  );

  final GlobalKey boundaryKey;
  final SensitiveRegionRegistry sensitiveRegions;
  final SafeReplayBuffer? replayBuffer;
}

class EverframeReporterOutcome {
  const EverframeReporterOutcome({
    required this.status,
    this.reportId,
    this.reason,
  });

  final String status;
  final String? reportId;
  final String? reason;

  @override
  bool operator ==(Object other) =>
      other is EverframeReporterOutcome &&
      status == other.status &&
      reportId == other.reportId &&
      reason == other.reason;

  @override
  int get hashCode => Object.hash(status, reportId, reason);
}
