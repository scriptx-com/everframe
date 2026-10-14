<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe with Expo Updates

Use a separate identity for each JavaScript bundle. Native app version and Expo
`runtimeVersion` describe the installed native runtime; an Expo update UUID
identifies an update; Everframe's `buildId` identifies the bundle and its private
source map. They are not interchangeable.

Wrap Metro so the running bundle carries its own identity:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withEverframe } = require('@everframe/metro');

module.exports = withEverframe(getDefaultConfig(__dirname), {
  projectRoot: __dirname,
  dev: false,
});
```

Configure `EverframeProvider` normally and omit an explicit `jsBundle` override.
The React Native SDK reads the injected identity when its runtime mounts. Loading
an update or rolling back creates a runtime with the identity of the evaluated
bundle. Downloading an update without loading it does not change the current
bundle's identity.

Export and upload from the same isolated build workspace:

```sh
npx expo export --platform android --source-maps --output-dir dist
npx @everframe/cli upload-expo-export --dist dist --staging .everframe --app-id "$EVERFRAME_APP_ID"
```

Set `EVERFRAME_API_TOKEN` to a token scoped to `artifacts:write`. Keep that token
in CI or the upload process, never in Expo public environment variables or the
application bundle. Preserve the matching bytecode, composed source map, staging
manifest and hashes before promoting the update. Keep source maps in private
artifact storage; do not include them among update assets served to clients.

Publish exactly the export you uploaded. Every bundling run generates new build
IDs, so a re-export ships bundles whose artifacts were never uploaded, and events
from that update report a missing build. Plain `eas update` bundles again by
default: pass `--skip-bundler --input-dir dist` so it publishes the uploaded
directory unchanged. If `eas update` must bundle, run `upload-expo-export` on the
directory it published right after it, from the same workspace. If your own
update server serves the export directory, move the `.map` files out of it after
upload.

The export command expects one Hermes bytecode bundle and its matching composed
map per selected platform. A missing map, plain JavaScript bundle, missing token
or changed staged artifact is a build failure. Collection selects the generated
identity from the composed map and checks it against the staged partial and
compiled bundle. This remains valid when Expo loads Metro configuration again
after bundling. Maps that omit source contents are supported.

Do not share `.everframe` between concurrent builds or run another Metro
configuration between collection and upload. Collection promotes its completed
identity to the platform pointer; a subsequent configuration can replace it.

For a native build, apply the config plugin with your App ID and install
`@everframe/cli` in the app:

```js
// app.config.js
const { withEverframe } = require('@everframe/expo');

module.exports = ({ config }) => withEverframe(config, { appId: '00000000-0000-4000-8000-000000000001' });
```

`expo prebuild` then adds a few lines and no upload logic:

- `android/build.gradle`: `classpath("dev.everframe:gradle-plugin:<version>")`.
- `android/app/build.gradle`: `apply plugin: "dev.everframe"` and
  `everframe { appId = "…" }`. The Gradle plugin uploads the Hermes map after
  each release bundle, and R8 mappings and native libraries after
  `assembleRelease` and `bundleRelease`.
- Xcode: an "Upload Everframe Build Artifacts" Run Script phase of one line,
  `/bin/bash "${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh" --app-id "…"`,
  with the app's dSYM as its input, plus `SOURCEMAP_FILE` when the target does
  not set it and `ENABLE_USER_SCRIPT_SANDBOXING = NO`. The script ships in
  `@everframe/cli` and runs `everframe xcode build-phase`. Release builds
  upload the Hermes map and the iOS dSYMs: the app's, and those of pod
  frameworks that build or ship one, including the Everframe SDK's.

`expo prebuild` finds `@everframe/cli` from the app root the way Node does, so
in a monorepo that hoists it to the workspace root the path starts with
`${SRCROOT}/../../../node_modules`, for example. `@everframe/cli` must be installed:
without it the script does not exist and every iOS build fails with the shell's
`No such file or directory`, as with Sentry's and Bugsnag's phases. With pnpm, add `@everframe/cli` to the app's own dependencies.

A missing `EVERFRAME_API_TOKEN` or a failed upload warns and the build
continues, unless `EVERFRAME_SYMBOLS_STRICT=1`. For an OTA
export, use `upload-expo-export` after export and before promotion. Artifact
upload and OTA publication are separate operations. Upload readiness confirms
artifact processing, not that a device installed the update.

When troubleshooting, compare the bundle's injected identity, its collected
manifest, and the event's JavaScript bundle metadata. Also record Expo's
`updateId`, `isEmbeddedLaunch`, `runtimeVersion`, and the native version. A cached
offline update and an embedded rollback must retain their own bundle identities.
Never substitute the native version when a bundle identifier is missing.

Expo update behavior is defined by the [Updates SDK](https://docs.expo.dev/versions/latest/sdk/updates/)
and [Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).

## Source commit provenance

React Native iOS/Android builds record an optional Git commit, branch, and dirty
status. Metro captures these before writing staging files; collection and upload
preserve that snapshot, including Expo exports and OTA updates. Keep `.everframe/`
in your Git ignore rules. A missing Git checkout does not stop builds or uploads.

Explicit `withEverframe(config, { commit: '<full-sha>' })` takes precedence over
local HEAD, then CI fallback (`GITHUB_SHA`, `CI_COMMIT_SHA`, `BITBUCKET_COMMIT`,
`BUILD_SOURCEVERSION`). Use a full 40- or 64-character hexadecimal commit.
Detached checkouts omit the branch; unavailable status is unknown, not clean.

`everframe sourcemaps upload-hermes`, `upload-expo-export`, and native `dsym`,
`elf`, and `r8` upload commands accept `--commit <full-sha>`. An override with a
different commit drops recorded branch/dirty facts. Legacy staged records without
provenance stay unknown; delayed staged uploads never read the uploader's HEAD.
Direct single-artifact uploads detect Git at invocation from the working directory,
so use `--commit` when uploading older files. Aggregate native `dsym upload-build`
and `elf upload-build` commands (including Xcode/Gradle integration) leave source
provenance unknown by default: their symbols may include reused or vendor binaries.
Use `--commit` only when every selected artifact belongs to that source commit;
otherwise upload each known artifact with its own explicit commit. Automatic
per-artifact native source attribution remains follow-up work.

The service must support the additive `vcs` manifest field before using these
tooling versions. Older clients remain supported by the updated service. Deploy
server support before publishing the new tooling; do not strip provenance in
response to an arbitrary upload failure.
