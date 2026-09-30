// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

const { IMAGE } = vi.hoisted(() => ({
  IMAGE: {
    blob: new Blob(["i"], { type: "image/png" }),
    width: 4,
    height: 4,
    sha256: "d".repeat(64),
  },
}));
vi.mock("../../src/capture/tv-snapshot/tv-snapshot.js", () => ({
  captureTvShot: vi.fn(),
}));
vi.mock("../../src/capture/screenshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/capture/screenshot.js")>()),
  captureScreenshot: vi.fn(async () => IMAGE),
}));

import { createClient } from "@everframe/sdk-core";
import {
  RENDER_PATH,
  SCREENSHOT_RENDER_SDK_FEATURE,
} from "@everframe/protocol";
import {
  createWebPlatformAdapter,
  type WebPlatformAdapter,
} from "../../src/adapter.js";
import { captureTvShot } from "../../src/capture/tv-snapshot/tv-snapshot.js";

const WEBOS_UA =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const adapters: WebPlatformAdapter[] = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(captureTvShot).mockReset();
});

async function adapterFor(opts: { ua?: string; screenshotRender: boolean }) {
  if (opts.ua !== undefined)
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(opts.ua);
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          replayEnabled: false,
          replayDurationSec: 30,
          samplingRate: 1,
          screenshotRender: opts.screenshotRender,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  const adapter = createWebPlatformAdapter({ apiKey: "k" });
  adapters.push(adapter);
  const client = createClient(adapter);
  client.init({ apiKey: "k" });
  await adapter.__initReplay();
  return { adapter, client, fetchMock };
}

describe("smart-TV snapshot gate", () => {
  it("routes __captureShot through the lazy TV module when the UA is a TV and the server renders", async () => {
    const shot = {
      snapshot: {
        bytes: new Uint8Array([1]),
        sha256: "e".repeat(64),
        byteLength: 1,
      },
      degradedReason: "screenshot_render_failed",
    };
    vi.mocked(captureTvShot).mockReturnValue({
      snapshotted: Promise.resolve(),
      shot: Promise.resolve(shot),
    });
    const { adapter } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    expect(adapter.__tvSnapshotPathActive!()).toBe(true);
    await expect(adapter.__captureShot!()).resolves.toBe(shot);
    const deps = vi.mocked(captureTvShot).mock.calls[0]![0];
    expect(deps.render.url).toBe("http://localhost:8787/api/render");
    expect(deps.render.sdkKey).toBe("k");
    expect(deps.userAgent).toBe(WEBOS_UA);
    expect(adapter.__lastDegradedReason).toBe("screenshot_render_failed");
  });

  it("stays on the on-device path when the server does not render (kill switch) or the UA is not a TV", async () => {
    const off = await adapterFor({ ua: WEBOS_UA, screenshotRender: false });
    expect(off.adapter.__tvSnapshotPathActive!()).toBe(false);
    await expect(off.adapter.__captureShot!()).resolves.toEqual({
      image: IMAGE,
    });
    const desktop = await adapterFor({
      ua: DESKTOP_UA,
      screenshotRender: true,
    });
    expect(desktop.adapter.__tvSnapshotPathActive!()).toBe(false);
    expect(captureTvShot).not.toHaveBeenCalled();
  });

  it("declares the screenshotrender capability on /api/config (the protocol token)", async () => {
    const { fetchMock } = await adapterFor({
      ua: DESKTOP_UA,
      screenshotRender: false,
    });
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(
      (init.headers as Record<string, string>)["X-Everframe-SDK-Features"]
    ).toContain(SCREENSHOT_RENDER_SDK_FEATURE);
  });

  it("renders at the protocol path", async () => {
    vi.mocked(captureTvShot).mockReturnValue({
      snapshotted: Promise.resolve(),
      shot: Promise.resolve({ image: IMAGE }),
    });
    const { adapter } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    await adapter.__captureShot!();
    expect(
      vi
        .mocked(captureTvShot)
        .mock.calls[0]![0].render.url.endsWith(RENDER_PATH)
    ).toBe(true);
  });

  it("falls back to the on-device capture when the TV module fails", async () => {
    vi.mocked(captureTvShot).mockImplementation(() => {
      throw new Error("chunk failed");
    });
    const { adapter } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    await expect(adapter.__captureShot!()).resolves.toEqual({ image: IMAGE });
  });

  it("opens the reporter only after the snapshot is taken, and hands the dialog that same capture", async () => {
    let snapshotTaken!: () => void;
    const snapshotted = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    vi.mocked(captureTvShot).mockReturnValue({
      snapshotted,
      shot: Promise.resolve({ image: IMAGE }),
    });
    const { adapter } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    const showModal = vi.fn();
    adapter.__registerShowModal(showModal);
    void adapter.__openReporter();
    await new Promise((r) => setTimeout(r, 0));
    expect(showModal).not.toHaveBeenCalled();
    snapshotTaken();
    await vi.waitFor(() => expect(showModal).toHaveBeenCalledTimes(1));
    await expect(
      adapter.__captureShot!({ consumePreCapture: true })
    ).resolves.toEqual({ image: IMAGE });
    expect(captureTvShot).toHaveBeenCalledTimes(1);
  });

  it("never hands the pre-capture to a capture that did not ask for it (add-a-shot, companion)", async () => {
    const pre = { image: IMAGE, degradedReason: "screenshot_blank" };
    const fresh = { image: IMAGE };
    vi.mocked(captureTvShot)
      .mockReturnValueOnce({ snapshotted: Promise.resolve(), shot: Promise.resolve(pre) })
      .mockReturnValue({ snapshotted: Promise.resolve(), shot: Promise.resolve(fresh) });
    const { adapter } = await adapterFor({ ua: WEBOS_UA, screenshotRender: true });
    const showModal = vi.fn();
    adapter.__registerShowModal(showModal);
    void adapter.__openReporter();
    await vi.waitFor(() => expect(showModal).toHaveBeenCalledTimes(1));
    await expect(adapter.__captureShot!()).resolves.toBe(fresh);
    // ...and the dialog's own open-time capture still gets it.
    await expect(
      adapter.__captureShot!({ consumePreCapture: true })
    ).resolves.toBe(pre);
  });

  it("clears the pre-capture when the dialog is cancelled, so a capture within 30 s is fresh", async () => {
    const pre = { image: IMAGE, degradedReason: "screenshot_blank" };
    const fresh = { image: IMAGE };
    vi.mocked(captureTvShot)
      .mockReturnValueOnce({ snapshotted: Promise.resolve(), shot: Promise.resolve(pre) })
      .mockReturnValue({ snapshotted: Promise.resolve(), shot: Promise.resolve(fresh) });
    const { adapter } = await adapterFor({ ua: WEBOS_UA, screenshotRender: true });
    const showModal = vi.fn();
    adapter.__registerShowModal(showModal);
    const opened = adapter.__openReporter();
    await vi.waitFor(() => expect(showModal).toHaveBeenCalledTimes(1));
    // The dialog is cancelled before its open-time capture consumed the slot.
    adapter.__resolveReporterUI(null);
    adapter.__resolveOpen({ status: "cancelled" });
    await opened;
    await expect(
      adapter.__captureShot!({ consumePreCapture: true })
    ).resolves.toBe(fresh);
    expect(captureTvShot).toHaveBeenCalledTimes(2);
  });

  it("does not open the reporter when reporting ownership changed while the snapshot was being taken", async () => {
    let snapshotTaken!: () => void;
    const snapshotted = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    vi.mocked(captureTvShot).mockReturnValue({
      snapshotted,
      shot: Promise.resolve({ image: IMAGE }),
    });
    const { adapter, client } = await adapterFor({ ua: WEBOS_UA, screenshotRender: true });
    const showModal = vi.fn();
    adapter.__registerShowModal(showModal);
    void adapter.__openReporter();
    await new Promise((r) => setTimeout(r, 0));
    // kill() then a revive: `reportingKilled` is false again, but this open
    // belongs to the previous owner.
    client.kill();
    adapter.__rebindCrumbHooks();
    snapshotTaken();
    await new Promise((r) => setTimeout(r, 0));
    expect(showModal).not.toHaveBeenCalled();
  });

  it("opens anyway at the 3 s ceiling when the snapshot never reports back", async () => {
    vi.mocked(captureTvShot).mockReturnValue({
      snapshotted: new Promise<void>(() => {}),
      shot: new Promise(() => {}),
    });
    const { adapter } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    const showModal = vi.fn();
    adapter.__registerShowModal(showModal);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    void adapter.__openReporter();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(showModal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it("refuses a pending pre-capture after kill() (Review Focus 5)", async () => {
    vi.mocked(captureTvShot).mockReturnValue({
      snapshotted: Promise.resolve(),
      shot: Promise.resolve({ image: IMAGE }),
    });
    const { adapter, client } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    adapter.__registerShowModal(() => {});
    void adapter.__openReporter();
    client.kill();
    await expect(
      adapter.__captureShot!({ consumePreCapture: true })
    ).rejects.toThrow(/kill\(\)/);
  });
  it("does not open the reporter when kill() lands while the snapshot is being taken", async () => {
    let snapshotTaken!: () => void;
    const snapshotted = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    vi.mocked(captureTvShot).mockReturnValue({
      snapshotted,
      shot: Promise.resolve({ image: IMAGE }),
    });
    const { adapter, client } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    const showModal = vi.fn();
    adapter.__registerShowModal(showModal);
    void adapter.__openReporter();
    await new Promise((r) => setTimeout(r, 0));
    client.kill();
    snapshotTaken();
    await new Promise((r) => setTimeout(r, 0));
    expect(showModal).not.toHaveBeenCalled();
  });

  it("drops a pre-capture taken before kill(), so a revived client captures afresh", async () => {
    const stale = { image: IMAGE, degradedReason: "screenshot_blank" };
    const fresh = { image: IMAGE };
    vi.mocked(captureTvShot)
      .mockReturnValueOnce({
        snapshotted: Promise.resolve(),
        shot: Promise.resolve(stale),
      })
      .mockReturnValueOnce({
        snapshotted: Promise.resolve(),
        shot: Promise.resolve(fresh),
      });
    const { adapter, client } = await adapterFor({
      ua: WEBOS_UA,
      screenshotRender: true,
    });
    adapter.__registerShowModal(() => {});
    void adapter.__openReporter();
    await vi.waitFor(() => expect(captureTvShot).toHaveBeenCalledTimes(1));
    client.kill();
    adapter.__rebindCrumbHooks();
    await expect(
      adapter.__captureShot!({ consumePreCapture: true })
    ).resolves.toBe(fresh);
    expect(captureTvShot).toHaveBeenCalledTimes(2);
  });
});
