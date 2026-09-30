// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

function bytesFromBase64(encoded) {
  if (!encoded || encoded.length > 12_000_000) return null;
  try {
    return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Dry-run bridge to the Flutter-owned masked renderer and replay buffer. */
export function flutterVisualCapture(host = window) {
  return {
    async captureScreenshot() {
      const bytes = bytesFromBase64(await host.everframeFlutterCaptureFrame());
      return bytes ? new Blob([bytes], { type: 'image/png' }) : null;
    },
    replay: {
      start() { host.everframeFlutterStartReplay(); },
      freeze() { host.everframeFlutterFreezeReplay(); },
      discardAndResume() { host.everframeFlutterResetReplay(); },
      async takeFrozen() {
        const bytes = bytesFromBase64(host.everframeFlutterTakeReplay());
        if (!bytes || bytes.byteLength > 8 * 1024 * 1024) return null;
        try {
          const replay = JSON.parse(new TextDecoder().decode(bytes));
          if (replay.version !== 'everframe-vtree-v1' || !Array.isArray(replay.frames) || replay.frames.length === 0) return null;
          const durationMs = replay.frames[replay.frames.length - 1].timestamp;
          if (!Number.isSafeInteger(durationMs) || durationMs < 0) return null;
          return { format: 'everframe-vtree-v1', bytes, contentType: 'application/json', durationMs };
        } catch {
          return null;
        }
      },
      stop() { host.everframeFlutterStopReplay(); },
      kill() { host.everframeFlutterStopReplay(); },
    },
  };
}
