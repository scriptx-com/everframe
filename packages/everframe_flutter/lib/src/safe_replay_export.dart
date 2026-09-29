// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'safe_replay_buffer.dart';

/// Exports already validated, frozen Flutter frames as the existing native
/// replay format. The image assets contain only the buffer's masked PNGs.
Uint8List exportSafeReplayVTree(
  SafeReplayBuffer buffer, {
  required double scale,
  int maxEncodedBytes = 8 * 1024 * 1024,
}) {
  if (!scale.isFinite || scale <= 0) {
    throw ArgumentError.value(scale, 'scale', 'must be positive and finite');
  }
  if (maxEncodedBytes <= 0) {
    throw ArgumentError.value(maxEncodedBytes, 'maxEncodedBytes');
  }
  if (!buffer.frozen || buffer.revoked) {
    throw StateError('Only a frozen, privacy-validated replay can be exported');
  }
  final frames = buffer.frames;
  if (frames.isEmpty) throw StateError('Replay contains no frames');

  final firstSize = _pngSize(frames.first.png);
  final assets = <String, Object?>{};
  final outputFrames = <Map<String, Object?>>[];
  String? previousRef;
  var previousTimestamp = -1;
  for (final frame in frames) {
    final size = _pngSize(frame.png);
    if (size.$1 != firstSize.$1 || size.$2 != firstSize.$2) {
      throw StateError('Replay frame dimensions changed');
    }
    final timestamp = (frame.elapsed - frames.first.elapsed).inMilliseconds;
    if (timestamp < 0 || timestamp < previousTimestamp) {
      throw StateError('Replay timestamps are not monotonic');
    }
    previousTimestamp = timestamp;
    final ref = sha256.convert(frame.png).toString().substring(0, 16);
    assets.putIfAbsent(
        ref,
        () => {
              'mime': 'image/png',
              'w': size.$1,
              'h': size.$2,
              'b64': base64Encode(frame.png),
            });
    outputFrames.add({
      'timestamp': timestamp,
      'ops': outputFrames.isEmpty
          ? [
              {
                'op': 'add',
                'parent': '',
                'index': 0,
                'node': {
                  'id': 'flutter-root',
                  'role': 'image',
                  'frame': {
                    'x': 0,
                    'y': 0,
                    'w': firstSize.$1 / scale,
                    'h': firstSize.$2 / scale,
                  },
                  'imageRef': ref,
                  'children': <Object>[],
                },
              },
            ]
          : ref == previousRef
              ? <Object>[]
              : [
                  {'op': 'set', 'id': 'flutter-root', 'imageRef': ref},
                ],
    });
    previousRef = ref;
  }
  final bytes = Uint8List.fromList(utf8.encode(jsonEncode({
    'version': 'everframe-vtree-v1',
    'viewport': {
      'width': firstSize.$1 / scale,
      'height': firstSize.$2 / scale,
      'scale': scale,
    },
    'frames': outputFrames,
    'originEpochMs': buffer.startEpochMs + frames.first.elapsed.inMilliseconds,
    'assets': assets,
  })));
  if (bytes.length > maxEncodedBytes) {
    throw StateError('Replay exceeds the attachment budget');
  }
  return bytes;
}

(int, int) _pngSize(Uint8List png) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 24) {
    throw StateError('Replay contains invalid PNG bytes');
  }
  for (var index = 0; index < signature.length; index++) {
    if (png[index] != signature[index]) {
      throw StateError('Replay contains invalid PNG bytes');
    }
  }
  final data = ByteData.sublistView(png);
  final width = data.getUint32(16);
  final height = data.getUint32(20);
  if (width == 0 || height == 0 || width > 2048 || height > 2048) {
    throw StateError('Replay contains invalid PNG dimensions');
  }
  return (width, height);
}
