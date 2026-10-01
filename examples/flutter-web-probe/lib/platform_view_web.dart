// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

const _viewType = 'everframe-flutter-probe-orange-tile';
bool _registered = false;

Widget buildPlatformView() {
  if (!_registered) {
    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId) {
      return web.HTMLDivElement()
        ..id = 'everframe-platform-view-$viewId'
        ..style.width = '100%'
        ..style.height = '100%'
        ..style.backgroundColor = '#ff8800';
    });
    _registered = true;
  }
  return const HtmlElementView(
      key: Key('platform-view-tile'), viewType: _viewType);
}
