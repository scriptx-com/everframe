// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type {
  PlatformAdapter,
  ScreenshotResult,
  LogEntry,
  NetworkEntry,
  ReportDraft,
  Rect,
} from '../types/platform.js';
import type { FocusedNode } from '@everframe/protocol';

export interface FakePlatformAdapter extends PlatformAdapter {
  __calls: {
    captureScreenshot: number;
    captureFocusedNode: number;
    captureRecentLogs: number;
    captureRecentNetwork: number;
    getDeviceMetadata: number;
    registerTrigger: number;
    showReporterUI: number;
    resolveSensitiveRects: number;
    applyMaskPlan: number;
  };
  __setScreenshot: (s: ScreenshotResult) => void;
  __setFocus: (f: FocusedNode | null) => void;
  __setLogs: (l: LogEntry[]) => void;
  __setNetwork: (n: NetworkEntry[]) => void;
  __setSensitiveRects: (r: Rect[]) => void;
  __setReporterDraft: (d: ReportDraft | null) => void;
}

export function createFakePlatformAdapter(): FakePlatformAdapter {
  const calls = {
    captureScreenshot: 0,
    captureFocusedNode: 0,
    captureRecentLogs: 0,
    captureRecentNetwork: 0,
    getDeviceMetadata: 0,
    registerTrigger: 0,
    showReporterUI: 0,
    resolveSensitiveRects: 0,
    applyMaskPlan: 0,
  };
  let screenshot: ScreenshotResult = {
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    width: 100,
    height: 100,
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  };
  let focus: FocusedNode | null = null;
  let logs: LogEntry[] = [];
  let network: NetworkEntry[] = [];
  let sensitiveRects: Rect[] = [];
  let reporterDraft: ReportDraft | null = {
    title: 'Fixture title',
    description: 'Fixture description',
    excludedArtifacts: [],
    annotations: [],
    redactions: [],
  };

  return {
    __calls: calls,
    __setScreenshot: (s) => {
      screenshot = s;
    },
    __setFocus: (f) => {
      focus = f;
    },
    __setLogs: (l) => {
      logs = l;
    },
    __setNetwork: (n) => {
      network = n;
    },
    __setSensitiveRects: (r) => {
      sensitiveRects = r;
    },
    __setReporterDraft: (d) => {
      reporterDraft = d;
    },

    async captureScreenshot() {
      calls.captureScreenshot += 1;
      return screenshot;
    },
    captureFocusedNode() {
      calls.captureFocusedNode += 1;
      return focus;
    },
    captureRecentLogs() {
      calls.captureRecentLogs += 1;
      return logs;
    },
    captureRecentNetwork() {
      calls.captureRecentNetwork += 1;
      return network;
    },
    getDeviceMetadata() {
      calls.getDeviceMetadata += 1;
      return {
        os: 'macos',
        osVersion: '14.4',
        screenSize: { width: 1920, height: 1080 },
        pixelRatio: 2,
        locale: 'en-US',
        timezone: 'America/New_York',
      };
    },
    registerTrigger(_handler) {
      calls.registerTrigger += 1;
      return () => {};
    },
    async showReporterUI(_draft) {
      calls.showReporterUI += 1;
      return reporterDraft;
    },
    resolveSensitiveRects() {
      calls.resolveSensitiveRects += 1;
      return sensitiveRects;
    },
    async applyMaskPlan(image, _plan) {
      calls.applyMaskPlan += 1;
      return image;
    },
  };
}
