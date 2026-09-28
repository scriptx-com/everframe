// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:typed_data';

import 'safe_frame.dart';

class SafeReplayFrame {
  SafeReplayFrame(this.elapsed, Uint8List png) : png = Uint8List.fromList(png);

  final Duration elapsed;
  final Uint8List png;
}

/// Small in-memory proof of a bounded, privacy-checked Flutter frame replay.
/// Each frame must already be masked; validation runs before it enters the ring.
class SafeReplayBuffer {
  SafeReplayBuffer({
    this.maxAge = const Duration(seconds: 30),
    this.maxBytes = 8 * 1024 * 1024,
    this.now,
    Future<bool> Function(Uint8List)? validate,
  })  : assert(maxAge > Duration.zero),
        assert(maxBytes > 0),
        _validate = validate ?? isSafePng {
    _clock.start();
  }

  final Duration maxAge;
  final int maxBytes;
  final Duration Function()? now;
  final Future<bool> Function(Uint8List) _validate;
  final Stopwatch _clock = Stopwatch();
  final List<SafeReplayFrame> _frames = [];
  var _bytes = 0;
  var _generation = 0;
  bool _revoked = false;

  bool get revoked => _revoked;
  List<SafeReplayFrame> get frames => List.unmodifiable(
        _frames.map((frame) => SafeReplayFrame(frame.elapsed, frame.png)),
      );

  Future<bool> append(Uint8List? png) async {
    if (_revoked) return false;
    final generation = _generation;
    if (png == null || png.isEmpty || png.length > maxBytes) {
      _revoke();
      return false;
    }
    final copy = Uint8List.fromList(png);
    bool safe;
    try {
      safe = await _validate(copy);
    } catch (_) {
      safe = false;
    }
    if (generation != _generation || _revoked) return false;
    if (!safe) {
      _revoke();
      return false;
    }
    final timestamp = now?.call() ?? _clock.elapsed;
    _frames.add(SafeReplayFrame(timestamp, copy));
    _bytes += copy.length;
    while (_frames.isNotEmpty &&
        (_bytes > maxBytes || timestamp - _frames.first.elapsed > maxAge)) {
      _bytes -= _frames.removeAt(0).png.length;
    }
    return true;
  }

  void reset() {
    _generation++;
    _revoked = false;
    _frames.clear();
    _bytes = 0;
    _clock.reset();
  }

  void _revoke() {
    _generation++;
    _revoked = true;
    _frames.clear();
    _bytes = 0;
  }
}
