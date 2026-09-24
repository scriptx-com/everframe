// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Source-level gates on the two NATIVE halves of the companion bridge.
//
// WHY THESE ARE SOURCE GATES AND NOT BEHAVIOURAL TESTS
// Neither native half of the RN bridge has a runnable test host in this repo:
//
//   • iOS — `packages/sdk-react-native/ios/Tests/*.swift` compile only under
//     the podspec's `test_spec`. No `Package.swift` declares a
//     `Everframe_ReactNative` target, and no CI workflow runs `pod lib lint`,
//     so those files are never built by anything. `.github/workflows/swift.yml`
//     does not even glob `packages/sdk-react-native/**`.
//   • Android — `packages/sdk-react-native/android` ships no Gradle wrapper
//     and is not a module of `packages/sdk-android/android/settings.gradle.kts`;
//     it is only ever configured through the Expo example app's composite
//     build. `EverframeCompanionModuleTest.kt` is additionally excluded from
//     `compileDebugUnitTestKotlin` (see that module's build.gradle.kts).
//
// So these assertions read the native sources as text. That is weaker than
// executing them — but each one still goes red the moment the wiring it names
// is deleted, which is the property that matters here: before this change
// NOTHING passed an SDK key to either relay client, so neither native ever
// announced and no React Native TV could appear in the dashboard.
//
// See the task report for the full list of what remains unverified.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const read = (rel: string): string => readFileSync(path.join(__dirname, '..', rel), 'utf8');

const IOS_MODULE = 'ios/Sources/EverframeModule.mm';
const iosModuleSrc = read(IOS_MODULE);

const FACADE = 'src/companion.ts';
// `runtime.ts` is the JS facade for the non-companion event this shared
// emitter grew (spec 2026-09-17 setExtra-resolver's
// `everframe.extra.resolveRequested`) — read alongside `companion.ts` so the
// three-file lock-step check below covers EVERY event, not just the
// companion ones (finding F7).
const RUNTIME_FACADE = 'src/runtime.ts';
const IOS_EMITTER = 'ios/Sources/EverframeEventEmitter.swift';
const IOS_BRIDGE = 'ios/Sources/EverframeBridge.swift';
const ANDROID_MODULE =
  'android/src/main/java/dev/everframe/rn/EverframeModule.kt';

const facadeSrc = read(FACADE);
const runtimeFacadeSrc = read(RUNTIME_FACADE);
const iosEmitterSrc = read(IOS_EMITTER);
const iosBridgeSrc = read(IOS_BRIDGE);
const androidSrc = read(ANDROID_MODULE);

const NEW_EVENTS = [
  'everframe.companion.code',
  'everframe.companion.attachedUserName',
  'everframe.companion.resolvedName',
] as const;

/** `const FOO_EVENT = 'everframe.companion.foo';` in the JS facade. */
function facadeEventNames(): string[] {
  return [
    ...facadeSrc.matchAll(
      /^const\s+\w+\s*=\s*'(everframe\.companion\.[^']+)';$/gm,
    ),
  ].map((m) => m[1]!);
}

/**
 * Every `const FOO_EVENT = 'everframe....';` / `"everframe....";` declared
 * across BOTH JS event-declaring facades — `companion.ts` (single-quoted)
 * and `runtime.ts` (double-quoted; `EXTRA_RESOLVE_REQUESTED_EVENT`, spec
 * 2026-09-17 setExtra-resolver). Unlike `facadeEventNames()` above, not
 * scoped to the `everframe.companion.` prefix — this feeds the full
 * three-file lock-step check (finding F7), which must catch a drift on
 * ANY event this shared native emitter carries, not just the companion
 * ones.
 */
function allFacadeEventNames(): string[] {
  const pattern = /^const\s+\w+\s*=\s*['"](everframe\.[^'"]+)['"];$/gm;
  return [
    ...[...facadeSrc.matchAll(pattern)].map((m) => m[1]!),
    ...[...runtimeFacadeSrc.matchAll(pattern)].map((m) => m[1]!),
  ];
}

/**
 * `public static let fooEvent = "everframe.foo.bar"` — name → value. NOT
 * scoped to `everframe.companion.*`: `supportedEvents()`'s silent-drop trap
 * (below) applies to EVERY event this shared emitter declares, companion or
 * not — spec 2026-09-17 setExtra-resolver added the first non-companion one
 * (`extraResolveRequestedEvent`, fired for the plain in-app openReporter()
 * path and native shake too, not just the phone-companion flow). The
 * companion-only lock-step comparison further down filters this map's
 * values back down to the `everframe.companion.` prefix itself, since THAT
 * check is deliberately companion-scoped (three-file parity), not a
 * general "is this constant declared" gate.
 */
function iosEventConstants(): Map<string, string> {
  return new Map(
    [
      ...iosEmitterSrc.matchAll(
        /^\s*public static let (\w+) = "(everframe\.[^"]+)"$/gm,
      ),
    ].map((m) => [m[1]!, m[2]!]),
  );
}

/** The `Self.xxx` identifiers returned from `supportedEvents()`. */
function iosSupportedEventIdentifiers(): string[] {
  const body = /func supportedEvents\(\) -> \[String\] \{([\s\S]*?)\n {4}\}/.exec(
    iosEmitterSrc,
  );
  if (body === null) {
    throw new Error(
      `could not locate supportedEvents() in ${IOS_EMITTER} — the parser in this spec needs updating`,
    );
  }
  return [...body[1]!.matchAll(/Self\.(\w+)/g)].map((m) => m[1]!);
}

/** `internal const val FOO: String = "everframe.companion.foo"` (Kotlin). */
function androidEventNames(): string[] {
  return [
    ...androidSrc.matchAll(
      /const val\s+\w+\s*:\s*String\s*=\s*\n?\s*"(everframe\.companion\.[^"]+)"/g,
    ),
  ].map((m) => m[1]!);
}

/**
 * Every `const val FOO: String = "everframe...."` declared in the Android
 * module — not scoped to `everframe.companion.`, mirrors
 * `allFacadeEventNames()` above (finding F7).
 */
function allAndroidEventNames(): string[] {
  return [
    ...androidSrc.matchAll(
      /const val\s+\w+\s*:\s*String\s*=\s*\n?\s*"(everframe\.[^"]+)"/g,
    ),
  ].map((m) => m[1]!);
}

/**
 * Drop comments so a gate reads CODE, not prose. Both native files discuss the
 * APIs they deliberately avoid, and a naive substring match would fire on the
 * comment explaining the avoidance.
 *
 * Handles `//` line comments AND `/* … *\/` block comments — Kotlin's
 * `EverframeModule.kt` documents nearly every declaration with a `/** … *\/`
 * KDoc block, so a line-only stripper leaves most of that file's prose in play.
 * Today's gates were checked and are unaffected either way; this closes the
 * trap for whatever gate is added next.
 *
 * Block comments are replaced with newlines rather than removed outright, so
 * line-spanning `[\s\S]{0,N}` proximity gates keep measuring roughly the same
 * distance and do not start matching across a stripped block.
 *
 * Kept deliberately simple: neither file has a `//` or a `/*` inside a string
 * literal, and the stripped text is only ever pattern-matched, never parsed.
 */
function stripLineComments(src: string): string {
  const blocksBlanked = src.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    '\n'.repeat((block.match(/\n/g) ?? []).length),
  );
  return blocksBlanked
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * The argument text of the sole `RelayWSClient(` construction in `src`.
 *
 * Comment-stripped for the same reason the Part B gates are: a prose mention of
 * `RelayWSClient(` in a KDoc/`//` comment would anchor this at the comment and
 * every assertion built on it would then be reading documentation. No comment
 * contains that text today — this keeps it that way by construction.
 */
function constructionArgs(rawSrc: string, ctor: string, where: string): string {
  const src = stripLineComments(rawSrc);
  const start = src.indexOf(`${ctor}(`);
  expect(start, `${where} must construct a ${ctor}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start + ctor.length; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${ctor}( ... ) in ${where}`);
}

function relayClientConstructionArgs(rawSrc: string, where: string): string {
  return constructionArgs(rawSrc, 'RelayWSClient', where);
}

describe('the comment stripper this file\'s gates depend on', () => {
  // Every gate below is only as trustworthy as this helper: if it leaves prose
  // in, a gate can pass on a comment while the code it names is gone. That is
  // the exact trap that bit the first draft of the deviceLabel gate, so the
  // stripper gets its own tests rather than being taken on faith.
  it('strips // line comments', () => {
    expect(stripLineComments('val x = 1 // sdkKey = configuredSdkKey()')).not.toContain(
      'configuredSdkKey',
    );
  });

  it('strips Kotlin KDoc blocks, which EverframeModule.kt uses on nearly every declaration', () => {
    const src = ['/**', ' * sdkKey = configuredSdkKey()', ' */', 'val real = 1'].join('\n');
    const stripped = stripLineComments(src);
    expect(stripped).not.toContain('configuredSdkKey');
    expect(stripped).toContain('val real = 1');
  });

  it('preserves line count so proximity gates keep measuring the same distance', () => {
    const src = ['a', '/* one', ' two */', 'b'].join('\n');
    expect(stripLineComments(src).split('\n')).toHaveLength(4);
  });

  it('leaves real code untouched', () => {
    expect(stripLineComments('sdkKey = configuredSdkKey(),')).toContain('configuredSdkKey()');
  });
});

describe('iOS supportedEvents() — the silent-drop trap', () => {
  // RN's RCTEventEmitter drops sendEvent(withName:) for any name missing from
  // supportedEvents(): no throw, no JS-side warning, the listener just never
  // fires. This is the exact failure mode Task 18/19's addendum flagged.
  it('lists EVERY event constant declared on the emitter', () => {
    const declared = iosEventConstants();
    const supported = new Set(iosSupportedEventIdentifiers());
    expect(declared.size).toBeGreaterThan(0);
    const missing = [...declared.keys()].filter((n) => !supported.has(n));
    expect(
      missing,
      `${IOS_EMITTER}: these event constants are declared but absent from supportedEvents() — RN will silently drop them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('supportedEvents() references no constant that does not exist', () => {
    const declared = iosEventConstants();
    const unknown = iosSupportedEventIdentifiers().filter(
      (n) => !declared.has(n),
    );
    expect(unknown, `unknown identifiers in supportedEvents(): ${unknown.join(', ')}`).toEqual([]);
  });

  for (const event of NEW_EVENTS) {
    it(`supportedEvents() resolves to \`${event}\``, () => {
      const declared = iosEventConstants();
      const resolved = iosSupportedEventIdentifiers().map((n) =>
        declared.get(n),
      );
      expect(resolved).toContain(event);
    });
  }
});

describe('event names stay in lock-step across the three files', () => {
  it('the JS facades, the iOS emitter and the Android module declare the same set', () => {
    // Unfiltered (finding F7): a rename on any one side — companion or the
    // non-companion `everframe.extra.resolveRequested` — must fail this
    // check. Previously the iOS/Android lists were sliced down to the
    // `everframe.companion.` prefix, which is exactly what let
    // `extraResolveRequestedEvent` drift silently: it was verified against
    // NOTHING outside `EverframeEventEmitter.swift` itself.
    const js = [...allFacadeEventNames()].sort();
    const ios = [...iosEventConstants().values()].sort();
    const android = [...allAndroidEventNames()].sort();

    expect(js.length, `no event constants parsed out of ${FACADE} / ${RUNTIME_FACADE}`).toBeGreaterThan(0);
    expect(
      ios,
      `${IOS_EMITTER} drifted from ${FACADE}/${RUNTIME_FACADE} — an event known to only one side is an event that never arrives`,
    ).toEqual(js);
    expect(
      android,
      `${ANDROID_MODULE} drifted from ${FACADE}/${RUNTIME_FACADE} — an event known to only one side is an event that never arrives`,
    ).toEqual(js);
  });

  for (const event of NEW_EVENTS) {
    it(`all three files declare \`${event}\``, () => {
      expect(facadeEventNames()).toContain(event);
      expect([...iosEventConstants().values()]).toContain(event);
      expect(androidEventNames()).toContain(event);
    });
  }

  it('all three files declare `everframe.extra.resolveRequested` (finding F7 — no longer excepted from lock-step)', () => {
    expect(allFacadeEventNames()).toContain('everframe.extra.resolveRequested');
    expect([...iosEventConstants().values()]).toContain('everframe.extra.resolveRequested');
    expect(allAndroidEventNames()).toContain('everframe.extra.resolveRequested');
  });
});

describe('iOS send* methods — every declared event has a matching sender (finding F2)', () => {
  // F1 shipped `extraResolveRequestedEvent` (declared + listed in
  // supportedEvents()) with NO `sendExtraResolveRequested` method backing
  // it — `EverframeBridge.swift` called a method that did not exist, a
  // straight build-breaker for any host that links this pod. The gates
  // above only ever checked the constant/supportedEvents() pair; neither
  // one reads as far as whether a sender exists at all. This closes that
  // gap: every event constant must have a `send*` method IN THE SAME FILE,
  // derived from the constant's name by the convention every existing
  // event already follows (`fooEvent` → `sendFoo`).
  function expectedSendFunctionName(constantName: string): string {
    const stripped = constantName.replace(/Event$/, '');
    return `send${stripped.charAt(0).toUpperCase()}${stripped.slice(1)}`;
  }

  function iosSendFunctionNames(): Set<string> {
    return new Set(
      [...iosEmitterSrc.matchAll(/@objc public static func (send\w+)\s*\(/g)].map(
        (m) => m[1]!,
      ),
    );
  }

  it('every event constant has a `send*` function defined in EverframeEventEmitter.swift', () => {
    const declared = iosEventConstants();
    expect(declared.size).toBeGreaterThan(0);
    const senders = iosSendFunctionNames();
    expect(senders.size).toBeGreaterThan(0);
    const missing = [...declared.keys()].filter(
      (name) => !senders.has(expectedSendFunctionName(name)),
    );
    expect(
      missing,
      `${IOS_EMITTER}: these event constants have no matching send*() method, so ` +
        `sendEvent(withName:) is never called for them — any caller of the expected ` +
        `sender (e.g. EverframeBridge.swift) fails to compile: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('Part A — the SDK key reaches the relay client on both platforms', () => {
  // Both relay clients default `sdkKey` to nil/null, which is exactly why the
  // feature shipped dark on RN: no key means no announcer, no announce, no
  // dashboard presence. These two call sites are the ONLY production
  // constructions of either relay client in the repo.

  // Assert the ARGUMENT VALUE, not just the label. `sdkKey: nil` satisfies
  // /sdkKey:/ perfectly well while shipping the feature dark again — and
  // Swift does not warn on a `private static func` left defined and unused,
  // so `configuredSdkKey()` sitting right there proves nothing on its own.
  it('iOS passes configuredSdkKey() and companionDeviceLabel() to RelayWSClient', () => {
    const args = relayClientConstructionArgs(iosBridgeSrc, IOS_BRIDGE);
    expect(
      args,
      `${IOS_BRIDGE}: RelayWSClient must be built with sdkKey: configuredSdkKey() — a literal nil here ships the feature dark and the device never announces`,
    ).toMatch(/sdkKey:\s*configuredSdkKey\(\)/);
    expect(
      args,
      `${IOS_BRIDGE}: RelayWSClient must be built with deviceLabel: companionDeviceLabel()`,
    ).toMatch(/deviceLabel:\s*companionDeviceLabel\(\)/);
  });

  it('iOS sources the key from the config the host already provided', () => {
    expect(
      iosBridgeSrc,
      `${IOS_BRIDGE}: the key must come from Everframe.shared.currentConfig — never a second place a key can be configured`,
    ).toMatch(/Everframe\.shared\.currentConfig\?\.appId/);
  });

  it('android passes configuredSdkKey() and companionDeviceLabel() to RelayWSClient', () => {
    const args = relayClientConstructionArgs(androidSrc, ANDROID_MODULE);
    expect(
      args,
      `${ANDROID_MODULE}: RelayWSClient must be built with sdkKey = configuredSdkKey() — a literal null here ships the feature dark and the device never announces`,
    ).toMatch(/sdkKey\s*=\s*configuredSdkKey\(\)/);
    expect(
      args,
      `${ANDROID_MODULE}: RelayWSClient must be built with deviceLabel = companionDeviceLabel()`,
    ).toMatch(/deviceLabel\s*=\s*companionDeviceLabel\(\)/);
  });

  it('android sources the key from the config the host already provided', () => {
    expect(
      androidSrc,
      `${ANDROID_MODULE}: the key must come from Everframe.currentConfig — never a second place a key can be configured`,
    ).toMatch(/Everframe\.currentConfig\?\.sdkKey/);
  });

  it('a blank configured key degrades to nil/null rather than announcing with it', () => {
    // Missing/blank key must take the ticketless path: no dashboard presence,
    // but still a socket, still a QR, still reports.
    expect(iosBridgeSrc).toMatch(/trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty/);
    expect(androidSrc).toMatch(/sdkKey\?\.takeIf \{ it\.isNotBlank\(\) \}/);
  });

  // attachPinUi (spec 2026-08-19). A missing/hardcoded value here ships the
  // configured mode dark: the device would always announce/behave as
  // whatever the RelayWSClient default is (`.builtin`/`BUILTIN`), silently
  // ignoring a host's `'custom'`/`'off'` choice.
  it('iOS passes the parsed attachPinUi mode to RelayWSClient', () => {
    const args = relayClientConstructionArgs(iosBridgeSrc, IOS_BRIDGE);
    expect(
      args,
      `${IOS_BRIDGE}: RelayWSClient must be built with attachPinUi: companionAttachPinUi — otherwise the configured mode never reaches the announce call`,
    ).toMatch(/attachPinUi:\s*companionAttachPinUi/);
  });

  it('android passes the parsed attachPinUi mode to RelayWSClient', () => {
    const args = relayClientConstructionArgs(androidSrc, ANDROID_MODULE);
    expect(
      args,
      `${ANDROID_MODULE}: RelayWSClient must be built with attachPinUi = companionAttachPinUi — otherwise the configured mode never reaches the announce call`,
    ).toMatch(/attachPinUi\s*=\s*companionAttachPinUi/);
  });
});

describe('Part B — each value is actually FORWARDED to the emitter', () => {
  // The single most load-bearing line per platform per value: the one that
  // joins the native observable to the emitter. Everything else in this file
  // — the constants, the lock-step set, supportedEvents() — stays perfectly
  // green with these lines deleted, and no value ever reaches JS. Declaring an
  // event and never sending it is indistinguishable from a working bridge
  // until you put a TV in front of it.
  //
  // Comment-stripped: both files name these symbols in prose (EverframeBridge
  // .swift's "posts .everframeCompanionCodeChange" note, EverframeModule.kt's
  // event-list header), so an un-stripped gate would pass on the comment
  // alone — the same trap that bit the deviceLabel gate in the first draft.
  const iosCode = stripLineComments(iosBridgeSrc);
  const androidCode = stripLineComments(androidSrc);

  it('iOS sinks companion.$code into sendCode', () => {
    expect(
      iosCode,
      `${IOS_BRIDGE}: nothing forwards companion.$code to EverframeEventEmitter.sendCode — the code never reaches JS`,
    ).toMatch(/companion\.\$code[\s\S]{0,120}sendCode/);
  });

  it('iOS sinks companion.$attachedUserName into sendAttachedUserName', () => {
    expect(
      iosCode,
      `${IOS_BRIDGE}: nothing forwards companion.$attachedUserName to EverframeEventEmitter.sendAttachedUserName`,
    ).toMatch(/companion\.\$attachedUserName[\s\S]{0,120}sendAttachedUserName/);
  });

  it('android collects companion.code into an emit of COMPANION_CODE_EVENT', () => {
    expect(
      androidCode,
      `${ANDROID_MODULE}: nothing collects Everframe.companion.code into emitter.emit(COMPANION_CODE_EVENT, …) — the code never reaches JS`,
    ).toMatch(
      /Everframe\.companion\.code\.collect[\s\S]{0,300}emit\(\s*COMPANION_CODE_EVENT/,
    );
  });

  it('android collects companion.attachedUserName into an emit of COMPANION_ATTACHED_USER_NAME_EVENT', () => {
    expect(
      androidCode,
      `${ANDROID_MODULE}: nothing collects Everframe.companion.attachedUserName into emitter.emit(COMPANION_ATTACHED_USER_NAME_EVENT, …)`,
    ).toMatch(
      /Everframe\.companion\.attachedUserName\.collect[\s\S]{0,300}emit\(\s*COMPANION_ATTACHED_USER_NAME_EVENT/,
    );
  });

  it('iOS sinks companion.$attachChallenge into sendAttachChallenge', () => {
    expect(
      iosCode,
      `${IOS_BRIDGE}: nothing forwards companion.$attachChallenge to EverframeEventEmitter.sendAttachChallenge — the challenge never reaches JS`,
    ).toMatch(/companion\.\$attachChallenge[\s\S]{0,200}sendAttachChallenge/);
  });

  it('android collects companion.attachChallenge into an emit of COMPANION_ATTACH_CHALLENGE_EVENT', () => {
    expect(
      androidCode,
      `${ANDROID_MODULE}: nothing collects Everframe.companion.attachChallenge into emitter.emit(COMPANION_ATTACH_CHALLENGE_EVENT, …)`,
    ).toMatch(
      /Everframe\.companion\.attachChallenge\.collect[\s\S]{0,400}emit\(\s*COMPANION_ATTACH_CHALLENGE_EVENT/,
    );
  });

  it('iOS sinks companion.$resolvedName into sendResolvedName', () => {
    expect(
      iosCode,
      `${IOS_BRIDGE}: nothing forwards companion.$resolvedName to EverframeEventEmitter.sendResolvedName — the resolved name never reaches JS`,
    ).toMatch(/companion\.\$resolvedName[\s\S]{0,120}sendResolvedName/);
  });

  it('android collects companion.resolvedName into an emit of COMPANION_RESOLVED_NAME_EVENT', () => {
    expect(
      androidCode,
      `${ANDROID_MODULE}: nothing collects Everframe.companion.resolvedName into emitter.emit(COMPANION_RESOLVED_NAME_EVENT, …)`,
    ).toMatch(
      /Everframe\.companion\.resolvedName\.collect[\s\S]{0,300}emit\(\s*COMPANION_RESOLVED_NAME_EVENT/,
    );
  });

  it('the pre-existing state and pairUrl forwards are still in place', () => {
    // Regression guard: widening this method must not disturb what already
    // worked. `pairUrl` in particular is what hosts drive the QR off.
    expect(iosCode).toMatch(/companion\.\$pairUrl[\s\S]{0,120}sendPairUrl/);
    expect(iosCode).toMatch(/companion\.\$state[\s\S]{0,300}sendState/);
    expect(androidCode).toMatch(
      /Everframe\.companion\.pairUrl\.collect[\s\S]{0,300}emit\(\s*COMPANION_PAIR_URL_EVENT/,
    );
    expect(androidCode).toMatch(
      /Everframe\.companion\.state\.collect[\s\S]{0,300}emit\(\s*COMPANION_STATE_EVENT/,
    );
  });
});

describe('Part C — the built-in PIN presenter is suppressed at runtime, not gated at install (spec 2026-08-19 controller ruling)', () => {
  // The ruling: `installResolver()`/`ReporterResolverInstaller` always
  // install `CompanionPinPresenter` so the announce-time capability signal
  // (`__builtinPinUiInstalled` / `__attachPinUiInstalled`) stays honest
  // regardless of the host's chosen mode. Only PRESENTING is silenced, via
  // this seam, at startCompanion() time once the mode is known. A missing
  // write here means a `'custom'`/`'off'` host still gets the native PIN
  // window stacked on top of its own UI.
  const iosCode = stripLineComments(iosBridgeSrc);
  const androidCode = stripLineComments(androidSrc);

  it('iOS sets the suppression seam from the configured mode at startCompanion', () => {
    expect(
      iosCode,
      `${IOS_BRIDGE}: startCompanion must call companion.__setBuiltinPinUiSuppressed(companionAttachPinUi != .builtin) — otherwise a custom/off host still gets the built-in PIN window`,
    ).toMatch(/__setBuiltinPinUiSuppressed\(companionAttachPinUi\s*!=\s*\.builtin\)/);
  });

  it('android sets Everframe.__attachPinUiSuppressed from the configured mode at startCompanion', () => {
    expect(
      androidCode,
      `${ANDROID_MODULE}: startCompanion must set Everframe.__attachPinUiSuppressed = companionAttachPinUi != AttachPinUi.BUILTIN — otherwise a custom/off host still gets the built-in PIN dialog`,
    ).toMatch(/Everframe\.__attachPinUiSuppressed\s*=\s*companionAttachPinUi\s*!=\s*AttachPinUi\.BUILTIN/);
  });
});

describe('deviceLabel is the device MODEL, never a personal device name', () => {
  // `UIDevice.current.name` is commonly "<Person>'s Apple TV". Putting that in
  // a shared dashboard list as a side effect of enabling companion would leak
  // a person's name; the model ("Apple TV") is non-personal, and the display
  // code is the real disambiguator anyway.
  it('iOS uses UIDevice.current.model and not UIDevice.current.name', () => {
    const code = stripLineComments(iosBridgeSrc);
    expect(code).toMatch(/UIDevice\.current\.model/);
    expect(
      code,
      `${IOS_BRIDGE}: UIDevice.current.name is commonly personal — it must not become a device label`,
    ).not.toMatch(/UIDevice\.current\.name/);
  });

  it('android uses Build.MODEL', () => {
    expect(stripLineComments(androidSrc)).toMatch(/android\.os\.Build\.MODEL/);
  });
});

describe('the attribution token never crosses the RN bridge', () => {
  // Hard constraint: attribution stays native, on the submit path. `pairUrl`
  // legitimately embeds a pair token — that IS the facade's job — so the gate
  // is specifically about the attribution token, not about the word "token".

  it('the JS facade declares nothing named after attribution', () => {
    expect(
      stripLineComments(facadeSrc).toLowerCase(),
      `${FACADE} must not carry an attribution value — it stays native, on the submit path`,
    ).not.toContain('attribution');
  });

  it('neither native bridge emits an attribution value to JS', () => {
    for (const [where, src] of [
      [IOS_BRIDGE, iosBridgeSrc],
      [IOS_EMITTER, iosEmitterSrc],
      [ANDROID_MODULE, androidSrc],
    ] as const) {
      const emits = [
        ...src.matchAll(/(?:sendEvent\(withName:|emitter\.emit\(|send[A-Z]\w*\()[^\n]*/g),
      ].map((m) => m[0].toLowerCase());
      for (const line of emits) {
        expect(
          line,
          `${where}: an emit line references attribution — the token must never cross the bridge`,
        ).not.toContain('attribution');
      }
    }
  });
});

describe('a companion report is attributed to whoever asked for THAT report', () => {
  // PR-fix 1. The attribution token must be the one the relay minted for this
  // report's `report.request`, snapshotted there and carried forward. The
  // Android submit provider installed by `EverframeModule` is the last hop: the
  // bridge hands it the snapshot and it must put THAT value into
  // `CompanionSubmissionComposer.Inputs`.
  //
  // Reading the live relay session here instead is the defect. This closure
  // deliberately outlives `stopCompanion()`, and a pair that is released and
  // re-attached by a different dashboard user re-bonds the SAME TV socket with
  // the new user's token — so a late read credits this report to them and,
  // because ingest consumes attribution single-use, burns the token their own
  // next report needed.
  //
  // Source gate for the reason the file header gives: `packages/sdk-react-
  // native/android` has no runnable test host. The Kotlin-side behaviour is
  // covered end-to-end by `CompanionAttributionFlowTest` in :everframe-core.

  /**
   * The body of the INSTALLED submit provider closure. `__submitProvider` is
   * also assigned `null` twice (start/stopCompanion teardown), so anchoring on
   * the first occurrence would slice the capture provider instead — the first
   * draft of this gate did exactly that and reported a false failure.
   */
  const submitProviderBody = (): string => {
    const src = stripLineComments(androidSrc);
    // The trailing \S is load-bearing: without it \s* backtracks to zero
    // width and the (?!null) lookahead passes on the " null" teardown lines.
    const m = /CompanionCaptureBridge\.__submitProvider\s*=\s*(?!null\b)\S/.exec(src);
    expect(
      m,
      `${ANDROID_MODULE} must install a __submitProvider closure`,
    ).not.toBeNull();
    const open = src.indexOf('{', m!.index);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced __submitProvider closure in ${ANDROID_MODULE}`);
  };

  it('the submit provider accepts the per-report attribution the bridge passes', () => {
    expect(
      submitProviderBody(),
      `${ANDROID_MODULE}: the __submitProvider closure does not take the attribution token the bridge hands it — the report cannot be attributed to the user who requested it`,
    ).toMatch(/companionAttribution:\s*String\?/);
  });

  it('that value — and nothing else — becomes Inputs.companionAttribution', () => {
    const inputs = constructionArgs(
      submitProviderBody(),
      'CompanionSubmissionComposer.Inputs',
      ANDROID_MODULE,
    );
    expect(
      inputs,
      `${ANDROID_MODULE}: Inputs is built without companionAttribution = companionAttribution, so the snapshot the bridge took is dropped`,
    ).toMatch(/companionAttribution\s*=\s*companionAttribution\b/);
  });

  it('the module never re-derives attribution from the live relay session', () => {
    // `currentCompanionAttribution()` was the process-global accessor this fix
    // deleted. The gate keeps it deleted: any late read reintroduces the bug.
    expect(
      stripLineComments(androidSrc),
      `${ANDROID_MODULE}: reads the live relay session's attribution token. By submit time that session may belong to a different dashboard user.`,
    ).not.toMatch(/currentCompanionAttribution|getCompanionAttribution/);
  });
});

describe('companionDeviceId (naming spec 2026-08-24) reaches RelayWSClient on both platforms', () => {
  // The explicit device-identity override rides `Everframe(.shared)?.currentConfig`
  // — the SAME config snapshot `configuredSdkKey()`/`configuredSdkKey()`-equivalent
  // already reads, never a second configuration surface. A missing wire here
  // means a host that sets `companionDeviceId` gets silently ignored: the
  // relay client falls all the way through to the SSAID/Keychain-random-UUID
  // fallback instead.

  it('iOS threads companionDeviceId from the host config into RelayWSClient', () => {
    const args = relayClientConstructionArgs(iosBridgeSrc, IOS_BRIDGE);
    expect(
      args,
      `${IOS_BRIDGE}: RelayWSClient must be built with companionDeviceId: Everframe.shared.currentConfig?.companionDeviceId — otherwise a host-configured override never reaches the announce call`,
    ).toMatch(/companionDeviceId:\s*Everframe\.shared\.currentConfig\?\.companionDeviceId/);
  });

  it('android threads companionDeviceId from the host config into RelayWSClient', () => {
    const args = relayClientConstructionArgs(androidSrc, ANDROID_MODULE);
    expect(
      args,
      `${ANDROID_MODULE}: RelayWSClient must be built with a deviceProvider reading Everframe.currentConfig?.companionDeviceId — otherwise a host-configured override never reaches the announce call`,
    ).toMatch(/Everframe\.currentConfig\?\.companionDeviceId/);
  });
});

describe('the JS facade parses companionDeviceId out of ConfigOpts for both native configure() calls', () => {
  // Source gate mirroring the Part A "the key reaches the relay client"
  // style, one level up the chain: `companionDeviceId` must survive
  // `NativeEverframe.ts`'s `ConfigOpts` type and `runtime.ts`'s
  // `extractBridgeConfig`, or a host-set value never leaves JS at all.
  const nativeEverframeSrc = read('src/NativeEverframe.ts');
  const runtimeSrc = read('src/runtime.ts');

  it('ConfigOpts declares an optional companionDeviceId field', () => {
    expect(
      nativeEverframeSrc,
      'src/NativeEverframe.ts: ConfigOpts must declare companionDeviceId?: string — the flat bridge field the host-facing config passes through',
    ).toMatch(/companionDeviceId\?:\s*string/);
  });

  it('extractBridgeConfig forwards companionDeviceId onto the bridge config unchanged', () => {
    expect(
      stripLineComments(runtimeSrc),
      'src/runtime.ts: extractBridgeConfig must copy config.companionDeviceId onto bridge.companionDeviceId — otherwise a host-configured override never crosses the bridge',
    ).toMatch(/bridge\.companionDeviceId\s*=\s*config\.companionDeviceId/);
  });
});

describe('companionBadge (naming spec 2026-08-24, controller ruling / Task 6b) reaches RelayWSClient on both platforms', () => {
  // Task 5/6 gave both native `RelayWSClient`s a `companionBadge:
  // CompanionBadgeOptions` parameter, but neither native `configure()` ever
  // read a JS-supplied option — "a production app that finds it intrusive
  // turns it off in one line" was unimplemented. A missing wire here means
  // `companionBadge: { enabled: false }` from JS is silently ignored: the
  // badge always shows, at the default position, regardless of what the
  // host configured.

  it('iOS threads companionBadge (enabled + position) from the host config into RelayWSClient', () => {
    const args = relayClientConstructionArgs(iosBridgeSrc, IOS_BRIDGE);
    expect(
      args,
      `${IOS_BRIDGE}: RelayWSClient must be built with companionBadge: CompanionBadgeOptions(...) — otherwise a host's badge preference never reaches the badge`,
    ).toMatch(/companionBadge:\s*CompanionBadgeOptions\(/);
    expect(
      args,
      `${IOS_BRIDGE}: the CompanionBadgeOptions passed to RelayWSClient must read enabled off Everframe.shared.currentConfig?.companionBadgeEnabled`,
    ).toMatch(/currentConfig\?\.companionBadgeEnabled/);
    expect(
      args,
      `${IOS_BRIDGE}: the CompanionBadgeOptions passed to RelayWSClient must read position off Everframe.shared.currentConfig?.companionBadgePosition`,
    ).toMatch(/currentConfig\?\.companionBadgePosition/);
  });

  it('android threads companionBadge (enabled + position) from the host config into RelayWSClient', () => {
    const args = relayClientConstructionArgs(androidSrc, ANDROID_MODULE);
    expect(
      args,
      `${ANDROID_MODULE}: RelayWSClient must be built with companionBadge = CompanionBadgeOptions(...) — otherwise a host's badge preference never reaches the badge`,
    ).toMatch(/companionBadge\s*=\s*CompanionBadgeOptions\(/);
    expect(
      args,
      `${ANDROID_MODULE}: the CompanionBadgeOptions passed to RelayWSClient must read enabled off Everframe.currentConfig?.companionBadgeEnabled`,
    ).toMatch(/currentConfig\?\.companionBadgeEnabled/);
    expect(
      args,
      `${ANDROID_MODULE}: the CompanionBadgeOptions passed to RelayWSClient must read position off Everframe.currentConfig?.companionBadgePosition`,
    ).toMatch(/currentConfig\?\.companionBadgePosition/);
  });
});

describe('D1 — a stale teardown must not clear a hook a newer configure() installed', () => {
  // Fix-wave defect D1: RN dispatches `-invalidate` on a module's method
  // queue, so a STALE module instance's `-invalidate` can be delivered AFTER
  // a reloaded bundle's fresh module instance has already run `configure()`
  // and installed a new resolver hook. The old code unconditionally nil'd
  // `Everframe.__pendingExtraResolveHook` and cleared `extraResolverActive`
  // on every `-invalidate`, with no way to tell "mine" from "a successor's" —
  // the stale call would silently disable the feature for the rest of the
  // process. Android already defends against exactly this with an identity
  // check (`EverframeModule.kt:570-574`, `Everframe.__pendingExtraResolveHook
  // === extraResolveHook`). `EverframeBridge` has no per-instance object to
  // compare by reference (every method on it is `static`), so iOS's
  // equivalent is a monotonically increasing "generation" token: bumped on
  // every (re)install, captured by the ObjC caller right after ITS OWN
  // `configure()` call, and handed back at `-invalidate` time so the Swift
  // side can refuse to tear down an installation it does not own.
  //
  // Neither native half has a runnable test host (see file header), so this
  // is a source gate like the rest of this file — it cannot execute the
  // race, but it goes red the moment the identity guard, or the plumbing
  // that feeds it, is deleted or bypassed.

  const iosCode = stripLineComments(iosBridgeSrc);
  const moduleCode = stripLineComments(iosModuleSrc);

  /** The body of `functionName`'s FIRST declaration in `src`, brace-matched. */
  function swiftFunctionBody(src: string, signature: RegExp, where: string): string {
    const m = signature.exec(src);
    expect(m, `${where}: could not find a declaration matching ${signature}`).not.toBeNull();
    const open = src.indexOf('{', m!.index + m![0].length);
    expect(open, `${where}: no opening brace found after ${signature}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced braces reading a function body in ${where}`);
  }

  it('resetExtraResolverForTeardown takes an identity token, not a bare no-arg call', () => {
    expect(
      iosCode,
      `${IOS_BRIDGE}: resetExtraResolverForTeardown must accept a generation/token parameter so a caller's teardown can be checked against the currently live installation`,
    ).toMatch(/@objc public static func resetExtraResolverForTeardown\(_ \w+: Int\)/);
  });

  it('resetExtraResolverForTeardown only clears state when the caller is still the live installation', () => {
    const body = swiftFunctionBody(
      iosCode,
      /@objc public static func resetExtraResolverForTeardown\(_ (\w+): Int\) /,
      IOS_BRIDGE,
    );
    // The comparison must exist...
    expect(
      body,
      `${IOS_BRIDGE}: resetExtraResolverForTeardown must compare its parameter against the currently installed generation before doing anything`,
    ).toMatch(/generation\s*!=\s*0\s*&&\s*generation\s*==\s*extraResolveHookGeneration/);
    // ...and it must actually GATE the mutations, not just compute a value
    // that is never checked: the guard-else-return must appear BEFORE the
    // hook is nil'd, in the same function body.
    const guardIndex = body.search(/guard\s+isCurrentInstallation\s+else\s*\{[\s\S]*?return[\s\S]*?\}/);
    const clearHookIndex = body.indexOf('__pendingExtraResolveHook = nil');
    const clearActiveIndex = body.indexOf('extraResolverActive = false');
    expect(guardIndex, `${IOS_BRIDGE}: expected a guard-else-return gating the teardown`).toBeGreaterThan(-1);
    expect(clearHookIndex, `${IOS_BRIDGE}: resetExtraResolverForTeardown must still nil the hook on the live path`).toBeGreaterThan(-1);
    expect(clearActiveIndex, `${IOS_BRIDGE}: resetExtraResolverForTeardown must still clear extraResolverActive on the live path`).toBeGreaterThan(-1);
    expect(
      guardIndex,
      `${IOS_BRIDGE}: resetExtraResolverForTeardown must check identity BEFORE nil-ing the hook — a stale caller must never reach that line`,
    ).toBeLessThan(clearHookIndex);
    expect(
      guardIndex,
      `${IOS_BRIDGE}: resetExtraResolverForTeardown must check identity BEFORE clearing extraResolverActive — a stale caller must never reach that line`,
    ).toBeLessThan(clearActiveIndex);
  });

  it('installing the hook always bumps the generation — no once-per-process flag left to reintroduce the race', () => {
    // The bug this fixes was a `Bool` "already installed" flag that made a
    // second install a no-op, which is exactly what let a stale teardown's
    // clear go unreinstalled. Pin the flag gone so nobody brings it back.
    expect(
      iosCode,
      `${IOS_BRIDGE}: the once-per-process "extraResolveHookInstalled" Bool flag must not come back — it is what originally let a stale -invalidate clobber a fresh configure()'s hook with nothing left to reinstall it`,
    ).not.toMatch(/extraResolveHookInstalled/);
    const installBody = swiftFunctionBody(
      iosCode,
      /private static func installExtraResolveHook\(\) -> Int /,
      IOS_BRIDGE,
    );
    expect(
      installBody,
      `${IOS_BRIDGE}: installExtraResolveHook must unconditionally bump extraResolveHookGeneration on every call`,
    ).toMatch(/extraResolveHookGeneration\s*\+=\s*1/);
  });

  it('EverframeModule.mm captures the live generation after its own configure() call', () => {
    expect(
      moduleCode,
      `${IOS_MODULE}: -configure: must capture [EverframeBridge currentExtraResolveHookGeneration] onto an instance ivar — otherwise -invalidate has no way to prove which installation it corresponds to`,
    ).toMatch(/_extraResolveHookGeneration\s*=\s*\[EverframeBridge currentExtraResolveHookGeneration\]/);
  });

  it('EverframeModule.mm -invalidate hands that captured generation back, not a bare no-arg call', () => {
    expect(
      moduleCode,
      `${IOS_MODULE}: -invalidate must call [EverframeBridge resetExtraResolverForTeardown:_extraResolveHookGeneration] — a bare no-arg call gives the Swift side nothing to check identity against`,
    ).toMatch(/\[EverframeBridge resetExtraResolverForTeardown:_extraResolveHookGeneration\]/);
    expect(
      moduleCode,
      `${IOS_MODULE}: -invalidate must not call the bare no-arg resetExtraResolverForTeardown selector`,
    ).not.toMatch(/resetExtraResolverForTeardown\s*\]/);
  });
});

describe('the JS facade parses companionBadge out of ConfigOpts for both native configure() calls', () => {
  // Source gate mirroring the companionDeviceId block above, one level up
  // the chain: `companionBadge` must survive `NativeEverframe.ts`'s
  // `ConfigOpts` type and `runtime.ts`'s `extractBridgeConfig`, or a
  // host-set value never leaves JS at all. Flat fields, not a nested
  // object — RN codegen cannot express `{ enabled, position }` in a struct
  // field (see NativeEverframe.ts's file-header D-decision notes for
  // `attachPinUi`/`networkBodiesDisabled`, the same codegen ceiling this
  // rides), so `RuntimeConfig.companionBadge`'s nested host-facing shape is
  // flattened by `extractBridgeConfig` before it crosses.
  const nativeEverframeSrc = read('src/NativeEverframe.ts');
  const runtimeSrc = read('src/runtime.ts');

  it('ConfigOpts declares flat optional companionBadgeEnabled/companionBadgePosition fields', () => {
    expect(
      nativeEverframeSrc,
      'src/NativeEverframe.ts: ConfigOpts must declare companionBadgeEnabled?: boolean — the flat bridge field the host-facing companionBadge.enabled flattens onto',
    ).toMatch(/companionBadgeEnabled\?:\s*boolean/);
    expect(
      nativeEverframeSrc,
      'src/NativeEverframe.ts: ConfigOpts must declare companionBadgePosition?: string — the flat bridge field the host-facing companionBadge.position flattens onto (codegen cannot express the position string-literal union in a struct field)',
    ).toMatch(/companionBadgePosition\?:\s*string/);
  });

  it('RuntimeConfig declares a nested companionBadge option with enabled/position', () => {
    expect(
      stripLineComments(runtimeSrc),
      "src/runtime.ts: RuntimeConfig must declare companionBadge?: { enabled?: boolean; position?: ... } — the host-facing 'turn it off in one line' surface",
    ).toMatch(/companionBadge\?:\s*\{[\s\S]*?enabled\?:\s*boolean;[\s\S]*?position\?:[\s\S]*?\}/);
  });

  it('extractBridgeConfig flattens config.companionBadge.enabled onto bridge.companionBadgeEnabled', () => {
    expect(
      stripLineComments(runtimeSrc),
      'src/runtime.ts: extractBridgeConfig must copy config.companionBadge?.enabled onto bridge.companionBadgeEnabled — otherwise a host-configured override never crosses the bridge',
    ).toMatch(/bridge\.companionBadgeEnabled\s*=\s*config\.companionBadge\?\.enabled/);
  });

  it('extractBridgeConfig flattens config.companionBadge.position onto bridge.companionBadgePosition', () => {
    expect(
      stripLineComments(runtimeSrc),
      'src/runtime.ts: extractBridgeConfig must copy config.companionBadge?.position onto bridge.companionBadgePosition — otherwise a host-configured override never crosses the bridge',
    ).toMatch(/bridge\.companionBadgePosition\s*=\s*config\.companionBadge\?\.position/);
  });

  // External review, finding NN4 — `RuntimeConfig` used to structurally
  // inherit `companionBadgeEnabled`/`companionBadgePosition` from
  // `ConfigOpts` IN ADDITION TO the nested `companionBadge` declared above,
  // so `{ companionBadgeEnabled: false }` type-checked as a valid host
  // config and silently no-opped (extractBridgeConfig never reads the flat
  // keys). The nested shape must be the ONLY surface. A real compile-time
  // guard (a `@ts-expect-error` fixture) lives in
  // `__tests__/companion-badge-config.types.ts`, checked by `pnpm
  // typecheck`; this source-grep test pins the specific mechanism (the
  // `Omit<...>` clause) that guard depends on, matching this file's own
  // established style.
  it("RuntimeConfig's Omit<ConfigOpts, ...> excludes the flat companionBadgeEnabled/companionBadgePosition keys", () => {
    const extendsClause = stripLineComments(runtimeSrc).match(
      /export interface RuntimeConfig\s+extends\s+Omit\s*<\s*ConfigOpts\s*,\s*([^>]+)>/,
    );
    expect(
      extendsClause,
      'src/runtime.ts: RuntimeConfig must extend Omit<ConfigOpts, ...> — could not find the extends clause at all',
    ).not.toBeNull();
    const omittedKeys = extendsClause![1];
    expect(
      omittedKeys,
      "src/runtime.ts: RuntimeConfig's Omit<ConfigOpts, ...> must exclude 'companionBadgeEnabled' — otherwise the flat wire key silently type-checks as a valid (but dead) host config alongside the nested companionBadge",
    ).toMatch(/['"]companionBadgeEnabled['"]/);
    expect(
      omittedKeys,
      "src/runtime.ts: RuntimeConfig's Omit<ConfigOpts, ...> must exclude 'companionBadgePosition' — otherwise the flat wire key silently type-checks as a valid (but dead) host config alongside the nested companionBadge",
    ).toMatch(/['"]companionBadgePosition['"]/);
  });
});
