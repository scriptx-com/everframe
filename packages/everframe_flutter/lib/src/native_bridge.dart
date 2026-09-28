// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'package:flutter/services.dart';

/// Android reporter bridge for the unreleased mobile dry run.
class EverframeNativeBridge {
  const EverframeNativeBridge();

  static const MethodChannel _channel = MethodChannel('dev.everframe/flutter');

  Future<void> start({
    required String appId,
    required String sdkKey,
    String environment = 'development',
  }) {
    if (appId.isEmpty || sdkKey.isEmpty) {
      throw ArgumentError('appId and sdkKey are required');
    }
    if (environment != 'development') {
      throw ArgumentError.value(
          environment, 'environment', 'dry-run bridge requires development');
    }
    return _channel.invokeMethod<void>('start', {
      'appId': appId,
      'sdkKey': sdkKey,
      'environment': environment,
    });
  }

  Future<EverframeReporterOutcome> openReporter() async {
    final result = await _channel.invokeMapMethod<String, Object?>(
      'openReporter',
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
