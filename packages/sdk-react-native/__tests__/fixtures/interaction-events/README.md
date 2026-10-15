<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed interaction evidence fixture

Build the public React Native example in development with
`EXPO_PUBLIC_EVERFRAME_INTERACTION_FIXTURE=1`, a dedicated local SDK key and the
matching native SDK artifacts. The fixture has no embedded key or destination.
`EXPO_PUBLIC_EVERFRAME_INTERACTION_HELPERS=0` starts with metadata refs detached;
all native testIDs and screen tracking remain. Repeat on iOS, Android, tvOS and
Android TV after rebuilding native code, not only reloading Metro.

1. Edit `search-input`, pause at least 750 ms, then finish/submit. Only this exact
   native ID permits a bounded redacted value. Repeat with paste and an IME;
   composing text must not produce an intermediate value or a false completed edit.
2. Edit `private-input`, `secure-input` and `masked-input` using distinct sentinel
   strings. Private input may report length but no value. Secure/masked hosts must
   report neither text events nor lengths. Scan the entire captured envelope for
   sentinels, not just its breadcrumbs.
3. Change the native switch on phones. Use the custom checkbox and sort picker
   on each runtime: those JS-only controls have no supported native observation
   point. Captures may show taps but must not invent their control state in either
   metadata mode.
4. Scroll the horizontal title rail with touch/momentum or TV remote movement.
   One settled gesture produces at most one summary, subject to admission limits.
   Focus movement without an offset change must not produce a scroll event.
5. Open the fixture link. Its private path, query and fragment must be absent;
   only the declared `/:id` template and allowlisted campaign survive. Open the
   same URL again: a distinct subsequent native delivery is a distinct observation.
6. Begin the **synthetic permission** request and resolve it. These buttons test
   result mapping; they do not display an OS dialog. On Android phones, the separate
   camera button invokes `PermissionsAndroid.request`. Its CAMERA declaration is
   added only to development fixture prebuilds, never to ordinary sample/TV builds
   or Nocturne. Inspect the actual prompt/result separately; cached grants are not
   prompt evidence. iOS/TV synthetic results are not proof of an OS permission API.
7. Background and foreground. The fixture supplies explicit **simulated** notification
   context from its AppState callback. Native classification must remain warm, and
   late context must not alter an emitted launch or create a second one. This is
   app-attribution evidence, not a delivered push notification.
8. Begin a synthetic request and pending text/scroll, then invoke the native SDK's
   `setIdentityToken(nil)` (Apple) or `setIdentityToken(null)` (Android) through the
   host integration or a development debugger before they settle. React Native
   does not expose that identity API. **Clear user metadata** calls `setUser()`;
   it is not identity sign-out and does not revoke pending work. After native
   sign-out, resolve the old request: no old-owner result may reappear. Unchanged
   metadata refs stay revoked. **Remount hosts** to recover, edit again, and capture
   fresh evidence. Label debugger-driven identity changes in the evidence.
9. **Capture evidence** submits a handled fixture error through the real SDK.
   Record exact SDK/app commits, runtime, helper mode and actual stored envelopes.
   Run the interaction JSON schema over stored events and scan all payload fields.

The form keeps existing app callbacks and uses refs only for target metadata.
The legacy JS text, control and scroll methods are compatibility no-ops. Native
observation owns all supported fields and controls in both modes, preserving IME,
structural summaries and explicitly permitted values. The title rail keeps
automatic native scroll observation in both modes. Synthetic
permission/attribution cases and unsupported controls must remain labelled in any
validation report. Never label a local collector envelope as a production report.

The runnable source is `examples/react-native/src/fixtures/InteractionEvents.tsx`.
The adjacent `App.tsx` re-exports it for tooling; Metro excludes `__tests__` by default.
