// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Which SDK an envelope says it came from — `envelope.sdk.name` + `.version`.
//
// This package hosts machinery shared by two published SDKs: `@traceitx/react`
// (whose Provider composes it) and `@traceitx/web` (whose `init()` uses it
// directly). They are independently versioned and have different names on the
// wire, so neither value can be read from this package's own constants: doing
// so would label every React host's crash report `@traceitx/web`'s version,
// and every Vue/Svelte/plain-HTML host's report `traceitx-react` — a silent
// telemetry-corruption bug, invisible in every test and every build.
//
// So the host passes both in, as ONE immutable argument to
// `createWebPlatformAdapter`, in the same synchronous step that installs the
// crash handlers — no crash can be observed under the wrong identity. (This
// replaces the earlier `__setHostSdkVersion` module global, which covered the
// version alone and could be written after the handlers were live.)
//
// The non-crash report paths take `sdkName`/`sdkVersion` from their caller
// explicitly for the same reason.
import type { ReportEnvelope } from '@traceitx/protocol';

/** The protocol's `sdk.name` enum — adding a value is a protocol change. */
export type HostSdkName = ReportEnvelope['sdk']['name'];

/** `@traceitx/react` — a React host, whose Provider passes this explicitly. */
export const REACT_SDK_NAME = 'traceitx-react' satisfies HostSdkName;

/** `@traceitx/web` — the framework-agnostic host mounted by `init()`. */
export const VANILLA_SDK_NAME = 'traceitx-web' satisfies HostSdkName;

/**
 * The SDK identity stamped onto envelopes built by this adapter's own paths.
 *
 * Both members default to the VANILLA pair — `traceitx-web` and THIS package's
 * `PKG_VERSION`. That is deliberate and was changed in codex round 2 (finding
 * 2): the previous default paired the React NAME with this package's VERSION,
 * a combination no legitimate host can produce, because `@traceitx/react` is
 * independently versioned and its Provider passes both values explicitly. A
 * non-React host calling the public `createWebPlatformAdapter` without this
 * argument was therefore billed to the React SDK under a version that SDK has
 * never shipped. The vanilla pair is at least internally coherent: it names
 * the package that actually owns this module.
 */
export interface HostSdkIdentity {
  /** Defaults to `traceitx-web` — this package. React passes its own name. */
  sdkName?: HostSdkName;
  /** Defaults to this package's own `PKG_VERSION`. */
  sdkVersion?: string;
}
