// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RBRIDGE-01 criterion #2 drift-guard: the JS↔native bridge must gain NO replay
// surface. Session replay is driven NATIVELY (each platform's ReplaySession armed
// at start()) and configured REMOTELY (each native ReplayConfigProvider fetches
// `GET <ingest>/api/config` with a Bearer SDK key). There is therefore no JS-side
// replay config to forward — adding a replay method to the TurboModule or a
// replay/ingest field to ConfigOpts would duplicate remote config and re-break
// Pattern 3 (24-RESEARCH §Anti-Patterns / Pitfall 1).
//
// We assert over the SPEC SOURCE TEXT (mirroring spec-shape.test.ts) because RN
// codegen types are not importable at vitest runtime — the type-only shape can't
// be reflected, so we pin the declared surface against forbidden substrings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const specPath = path.join(__dirname, "..", "src", "NativeTraceItX.ts");
const specSrc = readFileSync(specPath, "utf8");

// Strip line/block comments so doc-comment prose mentioning a token (e.g. an
// explanatory "do NOT add replayEnabled" note) never trips a forbidden-token
// assertion — we only want to catch ACTUAL declarations.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*$/gm, ""); // line comments
}
const specCode = stripComments(specSrc);

// Extract the ConfigOpts type body (between its opening `{` and the matching
// top-level `}`) so field assertions are scoped to ConfigOpts, not the whole file.
function extractConfigOptsBody(code: string): string {
  const decl = code.match(/export\s+type\s+ConfigOpts\s*=\s*\{/);
  expect(
    decl,
    "RBRIDGE-01: ConfigOpts type declaration must exist in NativeTraceItX.ts",
  ).toBeTruthy();
  const start = decl!.index! + decl![0].length;
  let depth = 1;
  let i = start;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") depth--;
  }
  return code.slice(start, i - 1);
}
const configOptsBody = extractConfigOptsBody(specCode);

describe("RBRIDGE-01: no new JS replay/config/ingest surface on the bridge", () => {
  describe("Test A — TurboModule declares no replay method", () => {
    const FORBIDDEN_METHODS = [
      "configureReplay",
      "setReplayConfig",
      "enableReplay",
      "startReplay",
      "replayLifecycle",
    ];

    for (const name of FORBIDDEN_METHODS) {
      it(`does not declare a \`${name}\` method`, () => {
        // A method declaration looks like `name(` in the Spec interface body.
        const methodDecl = new RegExp(`\\b${name}\\s*\\(`);
        expect(
          specCode,
          `RBRIDGE-01: replay must stay native + remote — the TurboModule must NOT gain a \`${name}\` method (24-RESEARCH §Anti-Patterns; the 5-method report surface is D-locked).`,
        ).not.toMatch(methodDecl);
      });
    }

    it("declares exactly the 17 locked report methods and no other non-companion report method", () => {
      const REPORT_METHODS = [
        "configure",
        "openReporter",
        "registerSensitiveRect",
        "setExtra",
        // Spec 2026-09-17 setExtra-resolver — the 11th D-decision, and this
        // test's whole reason to exist: two NEW report methods added
        // DELIBERATELY, not a quiet widening of `setExtra` itself. Native
        // asks JS for a fresh resolver value (bounded, fail-open) right
        // before draining pending attachments — mirrors the companion
        // `reportRequested`/`signalCompanionReportRequestReady` handshake
        // below. See both methods' doc comments on NativeTraceItX.ts.
        "setExtraResolverActive",
        "signalExtraResolverReady",
        // Plan 4 / Task 14 — the 6th report method, a deliberate D-decision:
        // a manual breadcrumb escape hatch that forwards to the native
        // singleton's existing coercion path (Tasks 5/9). See its doc
        // comment on NativeTraceItX.ts's `Spec.addBreadcrumb`.
        "addBreadcrumb",
        // Spec 2026-07-14 — the 7th report method, the navigation screen marker:
        // records "this screen is now visible". See its doc comment on
        // NativeTraceItX.ts's `Spec.recordScreen`.
        "recordScreen",
        // Spec 2026-07-18 — the 8th report method and Task 11's own
        // D-decision: the ONLY sync method on this spec (non-void return
        // forces sync codegen), fed by the default-on ErrorUtils handler in
        // `src/errors.ts`. See its doc comment on `Spec.reportCrash`.
        "reportCrash",
        // Explicit-capture spec 2026-09-14: distinct sync storage acknowledgement.
        "captureHandledException",
        // Additive sync startup path. The legacy void configure stays for
        // already-compiled callers, while the runtime uses configureSync so
        // an immediate blocking capture cannot overtake native startup.
        "configureSync",
        // Spec 2026-08-12 — the 9th report method and Task 10's own
        // D-decision: the self-declared identity surface. Bridge parameter
        // is `UnsafeObject` (NOT the named `TXUserSpec` alias — codegen
        // ignores `?` optionality on named struct aliases, only honouring it
        // for UnsafeObject; see NativeTraceItX.ts's file header). No
        // replay/ingest/remote-config surface — it's a pass-through to the
        // native singleton's `setUser`. See its doc comment on
        // NativeTraceItX.ts's `Spec.setUser`.
        "setUser",
        // Spec 2026-09-06 — Session Vitals RN bridge, five D-decisions in
        // one: the library-agnostic player bridge (trackPlayer / detachPlayer /
        // recordPlayerEvent / updatePlayerStats) and the custom log line
        // (trackVitals). All void, fire-and-forget; see NativeTraceItX.ts.
        "trackPlayer",
        "detachPlayer",
        "recordPlayerEvent",
        "updatePlayerStats",
        "trackVitals",
      ];
      // Each locked report method is present.
      for (const m of REPORT_METHODS) {
        expect(
          specCode,
          `RBRIDGE-01: locked report method \`${m}\` must remain on the Spec.`,
        ).toMatch(new RegExp(`\\b${m}\\s*\\(`));
      }

      // Known companion methods (Phase 06.2 — pre-existing, NOT this phase, OUT OF SCOPE).
      const COMPANION_METHODS = [
        "startCompanion",
        "stopCompanion",
        "signalCompanionReportRequestReady",
        "addListener",
        "removeListeners",
      ];

      // Collect every method-like declaration inside the `interface Spec` body.
      const specBodyMatch = specCode.match(
        /interface\s+Spec\s+extends\s+TurboModule\s*\{([\s\S]*?)\n\}/,
      );
      expect(
        specBodyMatch,
        "RBRIDGE-01: the Spec interface body must be parseable.",
      ).toBeTruthy();
      const specBody = specBodyMatch![1];
      const declared = [
        ...specBody.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm),
      ].map((m) => m[1]);

      const known = new Set([...REPORT_METHODS, ...COMPANION_METHODS]);
      const unexpected = declared.filter((m) => !known.has(m));
      expect(
        unexpected,
        `RBRIDGE-01: no NEW (non-companion) report method may be added to the TurboModule — adding another report method requires a phase D-decision. Unexpected: ${unexpected.join(", ")}`,
      ).toEqual([]);
    });
  });

  describe("Test B — ConfigOpts carries no replay/ingest field", () => {
    const FORBIDDEN_FIELDS: Array<[token: string, why: string]> = [
      [
        "replayEnabled",
        "replay config is native + remote only (24-RESEARCH Pattern 3)",
      ],
      [
        "replayDurationSec",
        "replay window is driven by the native ReplayConfigProvider, not host JS",
      ],
      [
        "samplingRate",
        "the sampling gate is evaluated natively from remote /api/config (CONFIG-04)",
      ],
      [
        "ingestUrl",
        "the ingest URL is build-time-baked into each native (IngestEndpoint.url)",
      ],
      [
        "apiBase",
        "apiBase is historically removed — its reappearance would re-break Pattern 3",
      ],
      ["replay", "no replay knob of any shape belongs on the bridge config"],
    ];

    for (const [token, why] of FORBIDDEN_FIELDS) {
      it(`ConfigOpts has no \`${token}\` field`, () => {
        expect(
          configOptsBody,
          `RBRIDGE-01: ConfigOpts must NOT gain \`${token}\` — ${why}.`,
        ).not.toMatch(new RegExp(token));
      });
    }
  });

  describe("Test C — no JS-side /api/config fetch in the package src", () => {
    const SRC_FILES = [
      "NativeTraceItX.ts",
      "runtime.ts",
      "index.ts",
      "companion.ts",
      "contextSeam.ts",
    ];

    for (const file of SRC_FILES) {
      it(`src/${file} contains no \`api/config\` reference`, () => {
        let contents: string;
        try {
          contents = readFileSync(
            path.join(__dirname, "..", "src", file),
            "utf8",
          );
        } catch {
          // File absent in this build — nothing to guard; treat as clean.
          contents = "";
        }
        expect(
          contents,
          `RBRIDGE-01: config is native + remote only — src/${file} must NOT fetch \`/api/config\` from JS (each native ReplayConfigProvider owns that).`,
        ).not.toContain("api/config");
      });
    }
  });
});
