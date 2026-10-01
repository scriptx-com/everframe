// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:io';
import 'dart:typed_data';

import 'package:everframe_flutter/everframe_flutter.dart' show isSafePng;

Future<bool> writeSafePng(Uint8List encoded, File destination) async {
  if (!await isSafePng(encoded)) return false;
  try {
    await destination.writeAsBytes(encoded, flush: true);
    return true;
  } catch (_) {
    return false;
  }
}
