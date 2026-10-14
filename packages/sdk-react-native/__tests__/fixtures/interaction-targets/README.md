<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed Fabric target fixture

Mount `App.tsx` beneath the public example's existing EverframeProvider in a
local development build using the matching native SDK artifacts. This fixture
contains no SDK key and does not upload by itself.

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
