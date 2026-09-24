<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Testing the iOS SDK

## Two tiers, and why the split matters

`swift test` runs on host macOS, where **UIKit is unavailable**. Every source and
test file inside `#if canImport(UIKit)` compiles to nothing there. Such a suite
does not fail — it reports **zero tests and passes**, which is worse than
failing, because CI looks green while nothing was verified.

`VTreeProducer`, `ReplaySession` and `ReporterSubmission` are all
UIKit-gated. They can only be verified on a simulator.

## Host tests (fast, non-UIKit)

    swift test --package-path packages/sdk-ios

## Simulator tests (UIKit-gated suites)

A git-ignored `Everframe.xcodeproj` in this directory shadows `Package.swift` for
xcodebuild, so `-scheme Everframe-Package` will not resolve while it exists. Move
it aside for the run, then move it back explicitly afterward and verify:

    cd packages/sdk-ios
    SIM_UDID=$(xcrun simctl list devices available -j \
      | python3 -c 'import json,sys; ds=json.load(sys.stdin)["devices"]; print(next((d["udid"] for rt in sorted(ds) if "iOS" in rt for d in ds[rt] if d.get("isAvailable") and d["name"].startswith("iPhone")), ""))')
    [ -d Everframe.xcodeproj ] && mv Everframe.xcodeproj /tmp/Everframe.xcodeproj.shadow
    xcodebuild test -scheme Everframe-Package -destination "id=$SIM_UDID" \
      -only-testing:EverframeTests/VTreeProducerRoleTests
    mv /tmp/Everframe.xcodeproj.shadow Everframe.xcodeproj
    ls -d Everframe.xcodeproj   # verify it's actually back

A `trap … EXIT` on the `mv` looks tempting but only fires within the shell
invocation that set it — if the `mv` and the `xcodebuild` end up split across
two separate command invocations (a real risk when an agent runs them one
tool-call at a time), the trap never fires and the project stays moved. Run
the whole block as one shell invocation, and always finish with the explicit
`mv` back plus the `ls -d` check above, not a trap alone.

## Adding a UIKit-gated suite

A new suite inside `#if canImport(UIKit)` runs **nowhere** until it is added to
the `-only-testing:` allowlist in the `lifecycle-tests-iOS` job of
`.github/workflows/swift.yml`. Add it there in the same commit, or it silently
never runs.

## Stage 4c image-capture suites

Six suites cover session-replay image capture, and all of them are UIKit-gated,
so **`swift test` verifies none of them** — it compiles them to nothing and
reports green:

    ReplayImageCaptureTests        the draw/encode/budget engine, asserted on the SHIPPED bytes
    ReplayImageBundledTests        the gate that decides whether user content can ship
    VTreeImageRefTests             producer wiring, masked-never-captures, the on-screen clip
    ReplayBufferAssetsTests        the freeze-time asset projection
    ReplaySessionImageGateTests    the gated config, revocation, teardown
    ReplayImageEndToEndTests       two real walks -> a real diff -> the serialized blob

All six are in the `lifecycle-tests-iOS` allowlist, along with
`ImageRasterCostBenchTests` (the rasterisation-cost bench, which also pins the
per-walk budget). `VTreeDiffTests` changed in 4c too but is NOT UIKit-gated, so
the host `swift test` run already covers it.

Several of these tests assert on decoded PIXELS of the encoded asset. If they
start failing after an OS bump, suspect a UIKit rendering change before
suspecting the pipeline — `ReplayImageBundledTests` deliberately asserts its own
preconditions (that `imageAsset` is non-nil even for a photo, that a real symbol
image view has no sublayers) so an OS behaviour change surfaces as a named
failure rather than as a silently vacuous test.

## Known: the allowlist does not currently pass as a single batch

Running the whole `lifecycle-tests-iOS` allowlist in ONE `xcodebuild test`
invocation fails with a handful of Swift-Testing issues in
`CompanionPreviewSessionTests`, `RelayWSClientPreviewRoutingTests` and
`ReplaySessionSupersessionTests`. Those same suites PASS when run on their own.

**This is pre-existing and not stage 4c's.** Verified 2026-08-18 by running the
same batch on a clean `origin/main` worktree, where it reproduces, and by running
the allowlist minus every 4c suite, where it also reproduces. The count of issues
varies run to run, which is the signature of the cross-suite interference
`Helpers/GlobalCaptureStateTestLock.swift` was introduced to fix — its header
already records that the gate covers only the suites that adopted it, and these
companion/preview suites have not.

It went unnoticed because GitHub Actions has been disabled at the repository
level since 2026-08-13, so no job has actually run this list. Worth fixing as its
own change: either widen the global gate to those suites, or split the job.

## Known: SwiftUI drawn-content detection may be stale

`UITreeCaptureTests` used to fail its three SwiftUI `DrawnContent` leaf-count
assertions (Form / List / VStack) — 0 drawn leaves on iOS 18.2. That suite went
away with tap-to-identify, but the finding did not:
`VTreeProducer.walkDrawnSublayers` uses the SAME `"Drawing"`/`"Shape"` CALayer
class-name detection, so if it is stale on modern iOS, SwiftUI drawn content is
likely missing from session replay too. Worth checking.
