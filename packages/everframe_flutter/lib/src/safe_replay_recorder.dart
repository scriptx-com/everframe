// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:async';
import 'dart:typed_data';

import 'safe_replay_buffer.dart';

typedef ReplaySchedule = void Function() Function(
  Duration interval,
  void Function() tick,
);

void Function() _scheduleTimer(Duration interval, void Function() tick) {
  final timer = Timer.periodic(interval, (_) => tick());
  return timer.cancel;
}

/// Samples masked Flutter frames without overlapping capture operations.
/// A failed privacy check revokes the replay and stops future sampling.
class SafeReplayRecorder {
  SafeReplayRecorder({
    required this.capture,
    SafeReplayBuffer? buffer,
    this.interval = const Duration(milliseconds: 200),
    ReplaySchedule? schedule,
    this.onFrame,
    this.onRevoked,
  })  : assert(interval > Duration.zero),
        buffer = buffer ?? SafeReplayBuffer(),
        _schedule = schedule ?? _scheduleTimer;

  final Future<Uint8List?> Function() capture;
  final SafeReplayBuffer buffer;
  final Duration interval;
  final ReplaySchedule _schedule;
  final void Function()? onFrame;
  final void Function()? onRevoked;
  void Function()? _cancelTimer;
  var _generation = 0;
  int? _samplingGeneration;
  bool _active = false;

  bool get active => _active;

  Future<bool> start() async {
    if (_active) return false;
    buffer.reset();
    _active = true;
    _generation++;
    _cancelTimer = _schedule(interval, () => unawaited(sampleNow()));
    return sampleNow();
  }

  Future<bool> sampleNow() async {
    if (!_active || _samplingGeneration == _generation) return false;
    final generation = _generation;
    _samplingGeneration = generation;
    try {
      Uint8List? bytes;
      try {
        bytes = await capture();
      } catch (_) {
        bytes = null;
      }
      if (!_active || generation != _generation) return false;
      final accepted = await buffer.append(bytes);
      if (!_active || generation != _generation) return false;
      if (!accepted) {
        _active = false;
        _cancelTimer?.call();
        _cancelTimer = null;
        onRevoked?.call();
        return false;
      }
      onFrame?.call();
      return true;
    } finally {
      if (_samplingGeneration == generation) _samplingGeneration = null;
    }
  }

  List<SafeReplayFrame> freeze() {
    _active = false;
    _generation++;
    _cancelTimer?.call();
    _cancelTimer = null;
    return buffer.freeze();
  }

  void discard() {
    _active = false;
    _generation++;
    _cancelTimer?.call();
    _cancelTimer = null;
    buffer.reset();
  }
}
