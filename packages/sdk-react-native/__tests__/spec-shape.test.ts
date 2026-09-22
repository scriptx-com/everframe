// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Locks the TurboModule surface for the JS↔native bridge. After the D-05/D-07
// flip (2026-05-11) the bridge is THREE methods — native owns the report UI.
// Plan 4 / Task 14 adds a 6th (non-companion) report method — `addBreadcrumb`
// — a deliberate, documented D-decision (see NativeTraceItX.ts header).
// `reportCrash` (spec 2026-07-18) is the 8th — the ONLY sync method on the
// spec at that time (non-void return forces sync codegen; see errors.ts). `setUser`
// (spec 2026-08-12) is the self-declared identity surface. The distinct
// captureHandledException method supplies explicit capture acknowledgement.
import { describe, it, expect, expectTypeOf } from "vitest";
import type { UnsafeObject } from "../src/codegen-types.js";
import NativeTraceItX from "../src/NativeTraceItX.js";
import {
  captureException,
  type CaptureExceptionOptions,
  type TraceItXContextValue,
} from "../src/index.js";
import type { Spec, ConfigOpts } from "../src/NativeTraceItX.js";

describe("NativeTraceItX TurboModule spec (post D-05/D-07 flip)", () => {
  it("exposes exactly the 17 locked methods — no more, no fewer", () => {
    expect(Object.keys(NativeTraceItX).sort()).toEqual([
      "addBreadcrumb",
      "captureHandledException",
      "configure",
      "configureSync",
      "detachPlayer",
      "openReporter",
      "recordPlayerEvent",
      "recordScreen",
      "registerSensitiveRect",
      "reportCrash",
      "setExtra",
      "setExtraResolverActive",
      "setUser",
      "signalExtraResolverReady",
      "trackPlayer",
      "trackVitals",
      "updatePlayerStats",
    ]);
  });

  it("public and hook captureException accept shared options and return void", () => {
    expectTypeOf<typeof captureException>().parameters.toEqualTypeOf<
      [unknown, CaptureExceptionOptions?]
    >();
    expectTypeOf<typeof captureException>().returns.toBeVoid();
    expectTypeOf<
      TraceItXContextValue["captureException"]
    >().parameters.toEqualTypeOf<[unknown, CaptureExceptionOptions?]>();
    expectTypeOf<TraceItXContextValue["captureException"]>().returns.toBeVoid();
  });

  it("retains configure void compatibility and adds a synchronous configure acknowledgement", () => {
    expectTypeOf<Spec["configure"]>().parameters.toMatchTypeOf<
      [Record<string, unknown>]
    >();
    expectTypeOf<Spec["configure"]>().returns.toBeVoid();
    expectTypeOf<Spec["configureSync"]>().parameters.toMatchTypeOf<
      [Record<string, unknown>]
    >();
    expectTypeOf<Spec["configureSync"]>().returns.toEqualTypeOf<boolean>();
  });

  it("Spec.openReporter takes nothing and returns Promise<UnsafeObject>", () => {
    expectTypeOf<Spec["openReporter"]>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<Spec["openReporter"]>().returns.toEqualTypeOf<
      Promise<UnsafeObject>
    >();
  });

  it("Spec.registerSensitiveRect takes (number, Rect) and returns void", () => {
    expectTypeOf<Spec["registerSensitiveRect"]>().parameters.toMatchTypeOf<
      [number, { x: number; y: number; width: number; height: number }]
    >();
    expectTypeOf<Spec["registerSensitiveRect"]>().returns.toBeVoid();
  });

  it("Spec.setExtra takes a single string and returns void", () => {
    expectTypeOf<Spec["setExtra"]>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<Spec["setExtra"]>().returns.toBeVoid();
  });

  it("Spec.setExtraResolverActive takes a single boolean and returns void (spec 2026-09-17 setExtra-resolver)", () => {
    expectTypeOf<Spec["setExtraResolverActive"]>().parameters.toEqualTypeOf<
      [boolean]
    >();
    expectTypeOf<Spec["setExtraResolverActive"]>().returns.toBeVoid();
  });

  it("Spec.signalExtraResolverReady takes a single string and returns void (spec 2026-09-17 setExtra-resolver)", () => {
    expectTypeOf<Spec["signalExtraResolverReady"]>().parameters.toEqualTypeOf<
      [string]
    >();
    expectTypeOf<Spec["signalExtraResolverReady"]>().returns.toBeVoid();
  });

  it("Spec.addBreadcrumb takes (message, kind?, level?, data?) positionally and returns void", () => {
    expectTypeOf<Spec["addBreadcrumb"]>().parameters.toEqualTypeOf<
      [string, string?, string?, UnsafeObject?]
    >();
    expectTypeOf<Spec["addBreadcrumb"]>().returns.toBeVoid();
  });

  it("Spec.recordScreen takes (name, data?) positionally and returns void", () => {
    expectTypeOf<Spec["recordScreen"]>().parameters.toEqualTypeOf<
      [string, UnsafeObject?]
    >();
    expectTypeOf<Spec["recordScreen"]>().returns.toBeVoid();
  });

  it("Spec.reportCrash takes a JSON string and returns boolean (sync)", () => {
    expectTypeOf<Spec["reportCrash"]>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<Spec["reportCrash"]>().returns.toEqualTypeOf<boolean>();
  });

  it("Spec.captureHandledException takes a JSON string and returns boolean (sync)", () => {
    expectTypeOf<Spec["captureHandledException"]>().parameters.toEqualTypeOf<
      [string]
    >();
    expectTypeOf<
      Spec["captureHandledException"]
    >().returns.toEqualTypeOf<boolean>();
  });

  it("Spec.setUser takes an optional UnsafeObject and returns void — NOT the named TXUserSpec alias, whose optionality codegen ignores", () => {
    expectTypeOf<Spec["setUser"]>().parameters.toEqualTypeOf<[UnsafeObject?]>();
    expectTypeOf<Spec["setUser"]>().returns.toBeVoid();
  });

  it("Spec.trackPlayer takes (token, library, name?, libraryVersion?) and returns void", () => {
    expectTypeOf<Spec["trackPlayer"]>().parameters.toEqualTypeOf<
      [string, string, string?, string?]
    >();
    expectTypeOf<Spec["trackPlayer"]>().returns.toBeVoid();
  });
  it("Spec.detachPlayer takes (token) and returns void", () => {
    expectTypeOf<Spec["detachPlayer"]>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<Spec["detachPlayer"]>().returns.toBeVoid();
  });
  it("Spec.recordPlayerEvent takes (token, type, t, data?) — t is REQUIRED", () => {
    expectTypeOf<Spec["recordPlayerEvent"]>().parameters.toEqualTypeOf<
      [string, string, number, UnsafeObject?]
    >();
    expectTypeOf<Spec["recordPlayerEvent"]>().returns.toBeVoid();
  });
  it("Spec.updatePlayerStats takes (token, stats) and returns void", () => {
    expectTypeOf<Spec["updatePlayerStats"]>().parameters.toEqualTypeOf<
      [string, UnsafeObject]
    >();
    expectTypeOf<Spec["updatePlayerStats"]>().returns.toBeVoid();
  });
  it("Spec.trackVitals takes (name, dataJson?, token?) — data crosses as a JSON string", () => {
    expectTypeOf<Spec["trackVitals"]>().parameters.toEqualTypeOf<
      [string, string?, string?]
    >();
    expectTypeOf<Spec["trackVitals"]>().returns.toBeVoid();
  });
  it("ConfigOpts carries the three flat vitals fields", () => {
    expectTypeOf<ConfigOpts["vitalsEnabled"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<ConfigOpts["vitalsSampleRate"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<ConfigOpts["vitalsCaptureSourceQuery"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });
});
