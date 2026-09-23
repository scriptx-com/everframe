<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe tvOS replay sample

A deterministic UIKit tvOS host used to demonstrate and smoke-test Everframe
session replay, focus navigation, masking, SwiftUI embedding, and opaque player
surfaces. It uses procedural artwork and does not require external media.

The checked-in UI smoke test is credential-free. It builds the SDK through the
local Swift package, launches the sample on a tvOS simulator, and drives a
remote-control focus pattern. No dashboard account or backend is required.

## Generate and test

Requirements: Xcode, a tvOS simulator, and XcodeGen.

```sh
cd examples/tvos-replay
xcodegen generate
xcodebuild test \
  -project ReplayTV.xcodeproj \
  -scheme ReplayTV \
  -configuration Release \
  -destination 'platform=tvOS Simulator,name=Apple TV' \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEBUG' \
  -test-timeouts-enabled YES \
  -maximum-test-execution-time-allowance 90
```

Without a key, the host still launches and the focus smoke test runs; the
Everframe client remains stopped. To exercise replay capture against a backend
you control, pass these launch environment values:

- `EVERFRAME_E2E_SDK_KEY`: a non-production SDK key.
- `EVERFRAME_DEV_INGEST_URL`: a loopback development ingest origin.
- `REPLAY_TV_AUTOSCROLL=1`: optional deterministic automatic navigation.
- `REPLAY_TV_SWIFTUI=1`: optional SwiftUI header coverage.

Do not put keys in the Xcode project, generated `.xctestrun` files, or source.
Operational benchmarks and dashboard verification are intentionally outside
this public sample.
