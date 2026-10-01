// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flutterVisualCapture } from '../assets/visual_capture.js';

test('uses Flutter-owned PNG bytes and rejects absent frames', async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const host = { everframeFlutterCaptureFrame: async () => Buffer.from(png).toString('base64') };
  const capture = flutterVisualCapture(host);
  const screenshot = await capture.captureScreenshot();
  assert.equal(screenshot.type, 'image/png');
  assert.deepEqual(new Uint8Array(await screenshot.arrayBuffer()), png);
  host.everframeFlutterCaptureFrame = async () => '';
  assert.equal(await capture.captureScreenshot(), null);
});

test('returns only valid bounded Flutter replay', async () => {
  const replay = { version: 'everframe-vtree-v1', frames: [{ timestamp: 25 }] };
  const host = { everframeFlutterTakeReplay: () => Buffer.from(JSON.stringify(replay)).toString('base64') };
  const capture = flutterVisualCapture(host);
  assert.equal((await capture.replay.takeFrozen()).durationMs, 25);
  host.everframeFlutterTakeReplay = () => Buffer.from(JSON.stringify({ frames: [] })).toString('base64');
  assert.equal(await capture.replay.takeFrozen(), null);
});
