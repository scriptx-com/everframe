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
  external factory _WebConfig({JSString sdkKey, JSString appVersion,
    JSString sdkName, JSString sdkVersion});
}

extension type _WebUser._(JSObject _) implements JSObject {
  external factory _WebUser({JSString? id, JSString? email, JSString? displayName});
}

extension type _WebBreadcrumb._(JSObject _) implements JSObject {
  external factory _WebBreadcrumb({JSString message, JSString? kind, JSString? level});
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

  Future<void> start({
    required String sdkKey,
    required String appVersion,
  }) async {
    if (sdkKey.isEmpty || appVersion.isEmpty) {
      throw ArgumentError('sdkKey and appVersion are required');
    }
    if (_captureReady?.toDart != true) {
      throw StateError('Install EverframeWebCapture before starting the web reporter');
    }
    if (_handle != null) return;
    if (_initializer == null) {
      final ready = Completer<void>();
      late JSFunction callback;
      callback = ((web.Event _) {
        web.window.removeEventListener('everframe-flutter-web-sdk-ready', callback);
        ready.complete();
      }).toJS;
      web.window.addEventListener('everframe-flutter-web-sdk-ready', callback);
      try {
        if (_initializer == null) {
          await ready.future.timeout(const Duration(seconds: 10));
        }
      } finally {
        web.window.removeEventListener('everframe-flutter-web-sdk-ready', callback);
      }
    }
    final init = _initializer;
    if (init == null) throw StateError('Load @everframe/web in the browser host');
    final config = _WebConfig(
      sdkKey: sdkKey.toJS,
      appVersion: appVersion.toJS,
      sdkName: 'everframe-flutter'.toJS,
      sdkVersion: '1.0.0'.toJS,
    );
    _handle = init.callAsFunction(null, config) as _WebHandle;
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
    return EverframeReporterOutcome(status: status, reportId: reportId, reason: reason);
  }

  void setUser({String? id, String? email, String? displayName}) {
    final handle = _handle;
    if (handle == null) throw StateError('Everframe web is not started');
    handle.setUser(id == null && email == null && displayName == null
        ? null : _WebUser(id: id?.toJS, email: email?.toJS, displayName: displayName?.toJS));
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
    handle.addBreadcrumb(_WebBreadcrumb(
      message: message.toJS, kind: kind?.toJS, level: level?.toJS));
  }

  void captureException(Object error) {
    final handle = _handle;
    if (handle == null) throw StateError('Everframe web is not started');
    handle.captureException(_WebError(error.toString().toJS));
  }

  void kill() {
    _handle?.destroy();
    _handle = null;
  }
}
