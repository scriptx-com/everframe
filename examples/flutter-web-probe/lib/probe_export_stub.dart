// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';

void emitSafeFrame(Uint8List bytes) {}

void installWebBridge({
  required Future<Uint8List?> Function() capture,
  required void Function() startReplay,
  required void Function() freezeReplay,
  required Uint8List? Function() takeReplay,
  required void Function() resetReplay,
  required void Function() stopReplay,
}) {}
