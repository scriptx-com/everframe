// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'masked_capture.dart';

/// Tracks widgets whose rendered pixels must be removed from replay frames.
class SensitiveRegionRegistry {
  final Set<GlobalKey> _keys = {};

  void _register(GlobalKey key) => _keys.add(key);
  void _unregister(GlobalKey key) => _keys.remove(key);

  /// Returns null when a registered widget cannot be safely located.
  List<ui.Rect>? rectsRelativeTo(GlobalKey boundaryKey) {
    final boundary = boundaryKey.currentContext?.findRenderObject();
    if (boundary is! RenderRepaintBoundary || !boundary.hasSize) return null;

    final bounds = ui.Offset.zero & boundary.size;
    final rects = <ui.Rect>[];
    for (final key in _keys) {
      final box = key.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.hasSize) return null;
      try {
        final corners = <ui.Offset>[
          ui.Offset.zero,
          ui.Offset(box.size.width, 0),
          ui.Offset(0, box.size.height),
          box.size.bottomRight(ui.Offset.zero),
        ]
            .map((corner) => box.localToGlobal(corner, ancestor: boundary))
            .toList();
        final rect = ui.Rect.fromLTRB(
          corners.map((point) => point.dx).reduce(math.min),
          corners.map((point) => point.dy).reduce(math.min),
          corners.map((point) => point.dx).reduce(math.max),
          corners.map((point) => point.dy).reduce(math.max),
        );
        if (!rect.isFinite ||
            rect.isEmpty ||
            !bounds.contains(rect.topLeft) ||
            !bounds.contains(rect.bottomRight)) return null;
        rects.add(rect);
      } catch (_) {
        return null;
      }
    }
    return rects;
  }
}

/// Registers a widget's current layout bounds for frame masking.
class EverframeSensitive extends StatefulWidget {
  const EverframeSensitive(
      {super.key, required this.registry, required this.child});

  final SensitiveRegionRegistry registry;
  final Widget child;

  @override
  State<EverframeSensitive> createState() => _EverframeSensitiveState();
}

class _EverframeSensitiveState extends State<EverframeSensitive> {
  final GlobalKey _regionKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    widget.registry._register(_regionKey);
  }

  @override
  void didUpdateWidget(covariant EverframeSensitive oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.registry != widget.registry) {
      oldWidget.registry._unregister(_regionKey);
      widget.registry._register(_regionKey);
    }
  }

  @override
  void dispose() {
    widget.registry._unregister(_regionKey);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      RepaintBoundary(key: _regionKey, child: widget.child);
}

/// Captures a frame using current registered bounds, refusing uncertain masks.
Future<Uint8List?> captureRegisteredFrame(
  GlobalKey boundaryKey,
  SensitiveRegionRegistry registry,
) async {
  final rects = registry.rectsRelativeTo(boundaryKey);
  if (rects == null) return null;
  return captureMaskedFrame(boundaryKey, rects);
}
