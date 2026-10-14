<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed Fabric target fixture

Mount `App.tsx` beneath the public example's existing EverframeProvider in a
local development build using the matching native SDK artifacts. This fixture
contains no SDK key. Its **Capture evidence** control submits a handled test
error through the configured SDK; use a dedicated local collector/test project.
Capture once after the full sequence below, since identical call-site error
fingerprints may suppress subsequent captures in the same app session.

1. Press **Low Orbit**, then **Update metadata without layout**, then Low Orbit.
   Report breadcrumbs must change container from Originals/index 0/count 12 to
   Continue/index 1/count 3, with exactly one crumb per press.
2. **Replace host**, then press. The current container must remain Continue;
   queued work from the old host must not restore Originals.
3. Toggle annotations off and press. Automatic label `Automatic Low Orbit`,
   native testID `target-fixture-card`, and role button remain; explicit
   container metadata disappears.
4. Toggle on, rapidly update/replace, then press. Accept current metadata or
   automatic fallback during an unresolved mount; never stale metadata.
5. Repeat with phone taps and TV Select. Rebuild after native source changes;
   a Metro reload cannot update Swift/Kotlin code.

6. Press **Masked control**, then **Capture evidence**. Inspect the actual envelope:
   the masked breadcrumb must contain no `SECRET-FIXTURE`, test ID, container,
   screen, or native class. The target is only `{ masked: true, role? }`.

The wrapper must remain a native host on Fabric (`collapsable: false`). Refs can
precede native mount: Android retries live unresolved owners after mount; Apple
uses bounded native retries. Cleanup cancels either path before a recycled host
can inherit the old annotation. Layout-only clipping preserves mounted ref
ownership; it does not change a logical index/count.
