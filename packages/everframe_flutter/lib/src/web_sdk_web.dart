// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'native_bridge.dart';

@JS('everframeFlutterInit')
external JSFunction? get _initializer;
@JS('everframeFlutterBridgeReady')
external JSBoolean? get _captureReady;

extension type _WebConfig._(JSObject _) implements JSObject {
  external factory _WebConfig({
    JSString sdkKey,
    JSString appVersion,
    JSString sdkName,
    JSString sdkVersion,
  });
  // Set only when the host chose a value: @everframe/web detects on `undefined`, not on `null`.
  external set debugBuild(JSBoolean value);
  external set releaseHealth(_WebReleaseHealth value);
}

extension type _WebReleaseHealth._(JSObject _) implements JSObject {
  external factory _WebReleaseHealth({JSBoolean enabled});
}

extension type _WebUser._(JSObject _) implements JSObject {
  external factory _WebUser({
    JSString? id,
    JSString? email,
    JSString? displayName,
  });
}

extension type _WebBreadcrumb._(JSObject _) implements JSObject {
  external factory _WebBreadcrumb({
    JSString message,
    JSString? kind,
    JSString? level,
  });
}

@JS('Error')
extension type _WebError._(JSObject _) implements JSObject {
  external factory _WebError(JSString message);
}

extension type _WebOutcome._(JSObject _) implements JSObject {
  external JSString get status;
  external JSString? get reportId;
  external JSString? get reason;
}

extension type _WebHandle._(JSObject _) implements JSObject {
  external JSPromise<_WebOutcome> open();
  external void setUser(_WebUser? user);
  external void recordScreen(JSString name);
  external void addBreadcrumb(_WebBreadcrumb breadcrumb);
  external void captureException(_WebError error);
  external void destroy();
}

/// Flutter web reporter facade backed by @everframe/web and a masked Flutter boundary.
class EverframeWebBridge {
  const EverframeWebBridge();
  static _WebHandle? _handle;
  static (String, String, bool?, bool)? _settings;
  static int _generation = 0;
  static void Function()? _cancelPendingStart;

  /// [debugBuild] overrides @everframe/web's own debug-build detection; null leaves it to the SDK.
  Future<void> start({
    required String sdkKey,
    required String appVersion,
    bool? debugBuild,
    bool releaseHealth = true,
  }) async {
    if (sdkKey.trim().isEmpty || appVersion.trim().isEmpty) {
      throw ArgumentError('sdkKey and appVersion are required');
    }
    if (_captureReady?.toDart != true) {
      throw StateError(
        'Install EverframeWebCapture before starting the web reporter',
      );
    }
    final settings = (sdkKey, appVersion, debugBuild, releaseHealth);
    if (_handle != null && _settings == settings) return;
    final generation = ++_generation;
    _cancelPendingStart?.call();
    if (_initializer == null) {
      final ready = Completer<void>();
      late JSFunction callback;
      final finishWaiting = () {
        web.window.removeEventListener(
          'everframe-flutter-web-sdk-ready',
          callback,
        );
        if (!ready.isCompleted) ready.complete();
      };
      callback = ((web.Event _) => finishWaiting()).toJS;
      _cancelPendingStart = finishWaiting;
      web.window.addEventListener('everframe-flutter-web-sdk-ready', callback);
      try {
        if (_initializer == null) {
          await ready.future.timeout(const Duration(seconds: 10));
        }
      } finally {
        if (identical(_cancelPendingStart, finishWaiting)) {
          _cancelPendingStart = null;
        }
        web.window.removeEventListener(
          'everframe-flutter-web-sdk-ready',
          callback,
        );
      }
    }
    if (generation != _generation) return;
    final init = _initializer;
    if (init == null)
      throw StateError('Load @everframe/web in the browser host');
    // Another start may have completed while this one waited for the host SDK.
    if (_handle != null && _settings == settings) return;
    kill();
    final config = _WebConfig(
      sdkKey: sdkKey.toJS,
      appVersion: appVersion.toJS,
      sdkName: 'everframe-flutter'.toJS,
      sdkVersion: '1.3.0'.toJS,
    );
    if (debugBuild != null) config.debugBuild = debugBuild.toJS;
    config.releaseHealth = _WebReleaseHealth(enabled: releaseHealth.toJS);
    _handle = init.callAsFunction(null, config) as _WebHandle;
    _settings = settings;
  }

  Future<EverframeReporterOutcome> openReporter() async {
    final handle = _handle;
    if (handle == null) throw StateError('Everframe web is not started');
    final result = await handle.open().toDart;
    final status = result.status.toDart;
    final reportId = result.reportId?.toDart;
    final reason = result.reason?.toDart;
    if (!const {'submitted', 'queued', 'cancelled'}.contains(status) ||
        (status != 'cancelled' && reportId == null)) {
      throw const FormatException('Invalid web reporter result');
    }
    return EverframeReporterOutcome(
      status: status,
      reportId: reportId,
      reason: reason,
    );
  }

  void setUser({String? id, String? email, String? displayName}) {
    final handle = _handle;
    if (handle == null) throw StateError('Everframe web is not started');
    handle.setUser(
      id == null && email == null && displayName == null
          ? null
          : _WebUser(
              id: id?.toJS,
              email: email?.toJS,
              displayName: displayName?.toJS,
            ),
    );
  }

  void recordScreen(String name) {
    final handle = _handle;
    if (handle == null) throw StateError('Everframe web is not started');
    if (name.isEmpty) throw ArgumentError.value(name, 'name');
    handle.recordScreen(name.toJS);
  }

  void addBreadcrumb(String message, {String? kind, String? level}) {
    final handle = _handle;
    if (handle == null) throw StateError('Everframe web is not started');
    if (message.isEmpty) throw ArgumentError.value(message, 'message');
    handle.addBreadcrumb(
      _WebBreadcrumb(
        message: message.toJS,
        kind: kind?.toJS,
        level: level?.toJS,
      ),
    );
  }

  void captureException(Object error) {
    final handle = _handle;
    if (handle == null) throw StateError('Everframe web is not started');
    handle.captureException(_WebError(error.toString().toJS));
  }

  void kill() {
    _generation++;
    _cancelPendingStart?.call();
    _cancelPendingStart = null;
    _handle?.destroy();
    _handle = null;
    _settings = null;
  }
}
