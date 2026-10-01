// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'sensitive_region.dart';
import 'safe_replay_buffer.dart';
import 'safe_replay_export.dart';

/// Native reporter bridge for Flutter Android and iOS hosts.
class EverframeNativeBridge {
  const EverframeNativeBridge();

  static const MethodChannel _channel = MethodChannel('dev.everframe/flutter');

  Future<void> start({
    required String appId,
    required String sdkKey,
    String environment = 'production',
  }) {
    if (appId.isEmpty || sdkKey.isEmpty) {
      throw ArgumentError('appId and sdkKey are required');
    }
    if (!const {'development', 'staging', 'production'}
        .contains(environment)) {
      throw ArgumentError.value(
          environment, 'environment', 'unsupported environment');
    }
    return _channel.invokeMethod<void>('start', {
      'appId': appId,
      'sdkKey': sdkKey,
      'environment': environment,
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
    if (boundaryKey != null) {
      await WidgetsBinding.instance.endOfFrame;
    }
    final rects =
        boundaryKey == null ? null : sensitiveRegions!.rectsInView(boundaryKey);
    if (boundaryKey != null && rects == null) {
      throw StateError('Sensitive widget geometry is unavailable');
    }
    final maskedPng = boundaryKey == null
        ? null
        : await captureRegisteredFrame(boundaryKey, sensitiveRegions!);
    if (boundaryKey != null && maskedPng == null) {
      throw StateError('Masked Flutter screenshot is unavailable');
    }
    final context = boundaryKey?.currentContext;
    final pixelRatio =
        context == null ? null : View.of(context).devicePixelRatio;
    // captureMaskedFrame emits one pixel per logical Flutter point. A failed
    // replay export omits replay while preserving the manual bug report.
    Uint8List? replayVTree;
    if (replayBuffer != null) {
      try {
        replayVTree = exportSafeReplayVTree(replayBuffer, scale: 1);
      } on StateError {
        replayVTree = null;
      }
    }
    final result = await _channel.invokeMapMethod<String, Object?>(
      'openReporter',
      {
        if (pixelRatio != null) 'pixelRatio': pixelRatio,
        if (maskedPng != null) 'maskedPng': maskedPng,
        if (replayVTree != null) 'replayVTree': replayVTree,
        if (rects != null)
          'sensitiveRects': rects
              .map((rect) => {
                    'left': rect.left,
                    'top': rect.top,
                    'right': rect.right,
                    'bottom': rect.bottom,
                  })
              .toList(),
      },
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
          'message':
              message.length > 4096 ? message.substring(0, 4096) : message,
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
      'OPTIONS'
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
