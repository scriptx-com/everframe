<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe Sample App

A standalone Xcode project that dogfoods every public Everframe SDK API across
all three locked-decision form factors:

| Scheme              | Platform | Recommended destination          |
| ------------------- | -------- | -------------------------------- |
| `SampleApp-iPhone`  | iOS      | iPhone 15 Pro Simulator          |
| `SampleApp-iPad`    | iOS      | iPad Pro (12.9-inch) Simulator   |
| `SampleAppTV`       | tvOS     | Apple TV 4K Simulator            |

The two underlying targets (`SampleApp`, `SampleAppTV`) consume
`packages/sdk-ios/` as a **Local Package** dependency via the relative path
`../../packages/sdk-ios`, so any change to the SDK source is picked up the
next time you build the sample.

## Generating the Xcode project

The project is checked in (so it opens cleanly without installing extra
tooling), but it is generated from `project.yml` with
[XcodeGen](https://github.com/yonaskolb/XcodeGen). To regenerate after
editing the spec:

```bash
brew install xcodegen      # one-time
xcodegen generate --spec examples/ios-native/project.yml --project examples/ios-native
```

CI runs `xcodegen generate` on every PR and fails on drift between
`project.yml` and the committed `project.pbxproj`.

## What the sample exercises

| Feature                                     | Where (iOS)                         | Where (tvOS)                              |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| `TraceItX.shared.start(config:)`            | `SampleApp.swift`                   | `SampleAppTV.swift`                       |
| `setUser(_:)`, `setMetadata(_:)`            | `SampleApp.swift`                   | `SampleAppTV.swift`                       |
| `TXSensitiveView` wrapper                   | `Screens/LoginScreen.swift`         | n/a (UI-SPEC tvOS branch)                 |
| `UITextField.isSecureTextEntry` auto-detect | `Screens/LoginScreen.swift`         | `TVLoginScreen` in `ContentView.swift`    |
| `TraceItX.shared.markSensitive(_:)`         | `Screens/PaymentScreen.swift`       | n/a                                       |
| Network capture                             | `Screens/DetailScreen.swift`        | `TVDetailScreen` in `ContentView.swift`   |
| Log capture (os_log)                        | `Screens/DetailScreen.swift`        | n/a                                       |
| Reporter overlay (SwiftUI modifier)         | `ContentView.swift`                 | invoked via Play/Pause × 3 (LOCKED)       |
| Bubble trigger                              | bottom-right (default ON)           | n/a                                       |
| TV press combo trigger                      | n/a                                 | `playPauseTriple` (default)               |
| `trackPlayer(_:name:)`                      | `Screens/PlaybackScreen.swift`      | `TVPlaybackScreen.swift`                  |
| `trackVitals(_:data:)`                      | `Screens/PlaybackScreen.swift`      | `TVPlaybackScreen.swift`                  |

## How to run

1. Open `examples/ios-native/SampleApp.xcodeproj` in Xcode 26 or later.
2. Pick a scheme:
   - **`SampleApp-iPhone`** → iPhone 15 Pro Simulator. Verify the bubble trigger
     bottom-right and tap it to open the reporter modal.
   - **`SampleApp-iPad`** → iPad Pro Simulator. The bubble keeps a 56pt edge
     inset and the reporter is presented as a centered sheet with 720pt max
     width (UI-SPEC iPad branch).
   - **`SampleAppTV`** → Apple TV 4K Simulator. With the Simulator focused,
     press **Play/Pause × 3 within 1.5s** on the simulated remote
     (Hardware → Apple TV Remote, then `P P P`) to open the full-screen
     reporter (UI-SPEC tvOS branch).
3. SampleApp / SampleAppTV read their ingest URL + SDK key from the
   repo-root `.env` via the xcconfig pipeline (see "One-time setup" below).
   First-time setup is required before the app can submit reports.

## One-time setup

The SampleApp talks to a local ingest service so reports show up in the admin
dashboard's Events panel. Setup is once per clone:

1. **Repo-root `.env`.** From the repo root:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and update the secrets you want different from defaults
   (`SDK_KEY_PEPPER`, `SESSION_SECRET`, `WEBHOOK_SECRET_ENC_KEY` — generate
   with `openssl rand -hex 16` / `openssl rand -hex 32` / `openssl rand -hex 32`).

2. **Boot the ingest service.** From the repo root:
   ```bash
   pnpm install
   pnpm dev:api
   ```
   The admin UI is now at `http://localhost:8787/admin` (or run
   `pnpm dev:admin` separately for the standalone Vite dev server).

3. **Create the iOS app's SDK key.** In the admin UI:
   - Sign up → create org → create an app named e.g. `iOS` → SDK Keys panel → "Generate".
   - Copy the raw `txx_live_…` key (reveal-once UI; you only see it now).
   - Paste it into the repo-root `.env` as `TRACEITX_KEY_IOS=txx_live_…`.
     (Each probe has its own app/key — see the table in `docs/sample-apps.md`.)
   - Confirm `INGEST_URL=http://localhost:8787` is also present in `.env`.

4. **Run.** With ingest still running, from the repo root:
   ```bash
   pnpm gen-ios-config
   open examples/ios-native/SampleApp.xcodeproj
   ```
   `pnpm gen-ios-config` materializes `Config/Local.xcconfig` from `.env`.
   Select an iPhone, iPad, or Apple TV scheme and simulator in Xcode.

   Once launched, install the trigger of your choice (`Open reporter`
   button on the list / Login / Payment / Detail screens) and submit a
   test report.

   <details>
   <summary><strong>Run from Xcode directly (alternative)</strong></summary>

   ```bash
   pnpm gen-ios-config         # materialize Config/Local.xcconfig from .env
   cd examples/ios-native
   xcodegen generate --spec project.yml --project .  # only if you edited project.yml
   open SampleApp.xcodeproj
   ```
   In Xcode: pick scheme `SampleApp-iPhone`, destination `iPhone 16` Simulator,
   Run. The xcconfig pipeline runs at build time; you do not need to re-run
   `gen-ios-config` unless `.env` changed.
   </details>

5. **Verify in admin UI.** Refresh `http://localhost:8787/admin` →
   open your app → Events panel. The report should appear within ~5s.
   Open the report → the **Report** tab shows your annotated screenshot,
   and the **Timeline** tab lists the breadcrumbs leading up to it.

## What changed in Phase 04.2
- Walker descends past `_UIHostingView`; emitted `componentType` strings
  are sanitized via family detection (no private API leaks).
- `TraceItXConfig.appId` is hard-validated at `start()` —
  `txx_live_…` prefix + 41 chars required (D-03). Misconfiguration fails
  loudly at launch with an actionable console message.
- Repo-wide dev secrets now live in a single root `.env`. Per-package
  `.env` / `.env.local` files are gone. iOS reads via xcconfig → Info.plist
  → `Bundle.main` (no generated `.swift`).
- Plain-HTTP ingest URL (`http://localhost:8787`) works on the Simulator
  via an `NSAllowsLocalNetworking` ATS exception scoped to localhost only.

## Sensitive-content idioms

The Login and Payment screens demonstrate all three locked sensitive-content
idioms (PRIV-01..03):

1. **`UITextField.isSecureTextEntry`** — `SwiftUI.SecureField` lowers to a
   secure UIKit text field, which `SensitiveRectRegistry` walks at capture
   time. No code change in the host app.
2. **`TXSensitiveView`** — wrap a subtree of arbitrary content in
   `TXSensitiveView` (the SwiftUI bridge is `TXSensitiveBox` in
   `LoginScreen.swift`). Any subview emits a sensitive rect.
3. **`TraceItX.shared.markSensitive(_:)`** — call this for views you don't
   own, including views you can't subclass (third-party SDKs, dynamically
   created UIViews). See `PaymentScreen.swift`.

In all three cases, the matching rect is **blacked out in the screenshot
bytes BEFORE upload** (PRIV-03), so sensitive content never leaves the device
in plaintext.

## CI

CI builds both targets on every PR via `.github/workflows/swift.yml`. The
xcodegen drift gate ensures `project.yml` and the committed `project.pbxproj`
stay in sync, and the `privacy-manifest-archive` job archives the iOS app
and asserts the bundled `PrivacyInfo.xcprivacy` declares all three
required-reason API categories (App Store reject defense — Pitfall 1).
