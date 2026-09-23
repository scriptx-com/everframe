// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Provider/runtime unit tests for the post D-05/D-07 surface (2026-05-11).
// The reporter UI is native; this suite exercises the slim JS bridge that
// remains: configure on mount, delegate open() to native openReporter,
// and the sensitive-rect registry passthrough.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import NativeEverframe from "../src/NativeEverframe.js";
import { createRuntime } from "../src/runtime.js";
import {
  __setCurrentContext,
  addBreadcrumb as topLevelAddBreadcrumb,
  captureException as topLevelCaptureException,
} from "../src/contextSeam.js";

interface MockedNative {
  configure: ReturnType<typeof vi.fn>;
  configureSync: ReturnType<typeof vi.fn>;
  captureHandledException: ReturnType<typeof vi.fn>;
  openReporter: ReturnType<typeof vi.fn>;
  registerSensitiveRect: ReturnType<typeof vi.fn>;
  addBreadcrumb: ReturnType<typeof vi.fn>;
}
const nativeMock = NativeEverframe as unknown as MockedNative;

describe("EverframeProvider — slim runtime (D-05/D-07 flip)", () => {
  beforeEach(() => {
    nativeMock.configure.mockReset();
    nativeMock.configureSync.mockReset();
    nativeMock.captureHandledException.mockReset().mockReturnValue(true);
    nativeMock.openReporter.mockReset();
    nativeMock.registerSensitiveRect.mockReset();
    nativeMock.addBreadcrumb.mockReset();
  });

  afterEach(() => {
    // A mid-test assertion failure can skip a test's own rt.unmount(),
    // leaking the module-level context and cascading "already mounted"
    // into every later test. Always clear it.
    __setCurrentContext(null);
  });

  it("mount() synchronously configures native before publishing the runtime", () => {
    const before = new Error("before native configuration completed");
    nativeMock.configureSync.mockImplementation(() => {
      topLevelCaptureException(before);
      expect(nativeMock.captureHandledException).not.toHaveBeenCalled();
      return true;
    });
    const rt = createRuntime({
      apiKey: "k",

      appName: "host",
      appVersion: "1.2.3",
    });
    rt.mount();
    expect(nativeMock.configure).not.toHaveBeenCalled();
    expect(nativeMock.configureSync).toHaveBeenCalledTimes(1);
    const opts = nativeMock.configureSync.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opts.apiKey).toBe("k");
    expect(opts).not.toHaveProperty("apiBase");
    expect(opts).not.toHaveProperty("appName");
    expect(opts).not.toHaveProperty("appVersion");
    const after = new Error("after native configuration completed");
    topLevelCaptureException(after);
    expect(nativeMock.captureHandledException).toHaveBeenCalledTimes(1);
    expect(nativeMock.captureHandledException.mock.calls[0]?.[0]).toContain(
      after.message,
    );
    rt.unmount();
  });

  it("uses legacy asynchronous configuration only when configureSync is absent", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      NativeEverframe,
      "configureSync",
    )!;
    let admitLegacyConfiguration: (() => void) | undefined;
    let legacyReady = false;
    nativeMock.configure.mockImplementation(() => {
      admitLegacyConfiguration = () => {
        legacyReady = true;
      };
    });
    nativeMock.captureHandledException.mockImplementation(() => legacyReady);
    Object.defineProperty(NativeEverframe, "configureSync", {
      configurable: true,
      value: undefined,
    });
    try {
      const rt = createRuntime({ apiKey: "legacy-key" });
      const thrown = new Error("legacy admission");
      rt.mount();

      expect(nativeMock.configure).toHaveBeenCalledExactlyOnceWith({
        apiKey: "legacy-key",
      });
      topLevelCaptureException(thrown);
      expect(nativeMock.captureHandledException).toHaveBeenCalledTimes(1);

      admitLegacyConfiguration?.();
      topLevelCaptureException(thrown);
      topLevelCaptureException(thrown);
      expect(nativeMock.captureHandledException).toHaveBeenCalledTimes(2);
      rt.unmount();
    } finally {
      Object.defineProperty(NativeEverframe, "configureSync", descriptor);
    }
  });

  it.each(["false", "throw"])(
    "never falls back to legacy configure after configureSync %s",
    (outcome) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      nativeMock.configureSync.mockImplementation(() => {
        if (outcome === "throw") throw new Error("sync configuration failed");
        return false;
      });
      const rt = createRuntime({ apiKey: "current-key" });
      rt.mount();
      expect(nativeMock.configureSync).toHaveBeenCalledTimes(1);
      expect(nativeMock.configure).not.toHaveBeenCalled();
      rt.unmount();
      warn.mockRestore();
    },
  );

  it("open() delegates to NativeEverframe.openReporter and returns its result", async () => {
    nativeMock.openReporter.mockResolvedValue({
      status: "submitted",
      reportId: "r-1",
    });
    const rt = createRuntime({ apiKey: "k" });
    rt.mount();
    const result = await rt.open();
    expect(nativeMock.openReporter).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "submitted", reportId: "r-1" });
    rt.unmount();
  });

  it("open() surfaces a cancelled result", async () => {
    nativeMock.openReporter.mockResolvedValue({
      status: "cancelled",
      reason: "user_back",
    });
    const rt = createRuntime({ apiKey: "k" });
    rt.mount();
    await expect(rt.open()).resolves.toMatchObject({ status: "cancelled" });
    rt.unmount();
  });

  it("sensitive.register forwards to NativeEverframe.registerSensitiveRect", () => {
    const rt = createRuntime({ apiKey: "k" });
    rt.mount();
    rt.sensitive.register(42, { x: 0, y: 0, width: 100, height: 50 });
    expect(nativeMock.registerSensitiveRect).toHaveBeenCalledWith(42, {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    rt.unmount();
  });

  it("open() never walks or attaches a React tree", async () => {
    // UI-tree capture was removed: `open()` used to walk the RN fiber tree and
    // push the result through `attachReactTree` before showing the reporter.
    // Nothing walks now, and the spec method itself is gone — the runtime
    // must not have grown a replacement.
    nativeMock.openReporter.mockResolvedValue({ status: "cancelled" });
    const rt = createRuntime({ apiKey: "k" });
    rt.mount();
    await rt.open();
    expect(nativeMock).not.toHaveProperty("attachReactTree");
    expect(nativeMock.openReporter).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("double-mount throws EverframeNotMountedError (single-instance enforcement)", () => {
    const rt1 = createRuntime({ apiKey: "k" });
    rt1.mount();
    const rt2 = createRuntime({ apiKey: "k" });
    expect(() => rt2.mount()).toThrow(/already mounted/);
    rt1.unmount();
  });

  // Task 14 — addBreadcrumb: object-form JS API → positional TurboModule
  // call. NO validation/coercion happens in this package; the native
  // singleton (Tasks 5/9) owns that — these tests only pin the forwarding
  // shape and the no-op-when-unmounted guard.
  describe("addBreadcrumb (Task 14)", () => {
    // Isolate this block from module-level `__currentContext` leakage: an
    // unrelated pre-existing failure earlier in this file ("open() walks the
    // RN fiber tree...", confirmed broken on this branch before Task 14 via
    // `git stash`) throws before reaching its own `rt.unmount()`, which
    // leaves a stale runtime mounted for whatever test runs next. Resetting
    // here keeps these 4 cases deterministic regardless of run order without
    // touching that unrelated test.
    beforeEach(() => {
      __setCurrentContext(null);
    });

    it("rt.addBreadcrumb forwards to NativeEverframe.addBreadcrumb with positional args in order", () => {
      const rt = createRuntime({ apiKey: "k" });
      rt.mount();
      rt.addBreadcrumb({
        message: "tapped checkout",
        kind: "tap",
        level: "info",
        data: { screen: "cart" },
      });
      expect(nativeMock.addBreadcrumb).toHaveBeenCalledTimes(1);
      expect(nativeMock.addBreadcrumb).toHaveBeenCalledWith(
        "tapped checkout",
        "tap",
        "info",
        { screen: "cart" },
      );
      rt.unmount();
    });

    it("rt.addBreadcrumb forwards undefined kind/level/data positionally when omitted", () => {
      const rt = createRuntime({ apiKey: "k" });
      rt.mount();
      rt.addBreadcrumb({ message: "bare crumb" });
      expect(nativeMock.addBreadcrumb).toHaveBeenCalledWith(
        "bare crumb",
        undefined,
        undefined,
        undefined,
      );
      rt.unmount();
    });

    it("top-level addBreadcrumb() no-ops when no provider is mounted", () => {
      __setCurrentContext(null);
      expect(() =>
        topLevelAddBreadcrumb({ message: "should not land" }),
      ).not.toThrow();
      expect(nativeMock.addBreadcrumb).not.toHaveBeenCalled();
    });

    it("top-level addBreadcrumb() forwards to the mounted runtime", () => {
      const rt = createRuntime({ apiKey: "k" });
      rt.mount();
      topLevelAddBreadcrumb({ message: "via top-level", kind: "custom" });
      expect(nativeMock.addBreadcrumb).toHaveBeenCalledWith(
        "via top-level",
        "custom",
        undefined,
        undefined,
      );
      rt.unmount();
    });
  });
});
