// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'native_bridge.dart';

class EverframeWebBridge {
  const EverframeWebBridge();
  Future<void> start({required String sdkKey,
    required String appVersion}) async =>
      throw UnsupportedError('EverframeWebBridge requires Flutter web');
  Future<EverframeReporterOutcome> openReporter() async =>
      throw UnsupportedError('EverframeWebBridge requires Flutter web');
  void setUser({String? id, String? email, String? displayName}) =>
      throw UnsupportedError('EverframeWebBridge requires Flutter web');
  void recordScreen(String name) =>
      throw UnsupportedError('EverframeWebBridge requires Flutter web');
  void addBreadcrumb(String message, {String? kind, String? level}) =>
      throw UnsupportedError('EverframeWebBridge requires Flutter web');
  void captureException(Object error) =>
      throw UnsupportedError('EverframeWebBridge requires Flutter web');
  void kill() =>
      throw UnsupportedError('EverframeWebBridge requires Flutter web');
}
