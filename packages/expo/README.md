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
npx everframe upload-expo-export --dist dist --staging .everframe --app-id "$EVERFRAME_APP_ID"
```

Set `EVERFRAME_API_TOKEN` to a token scoped to `artifacts:write`. Keep that token
in CI or the upload process, never in Expo public environment variables or the
application bundle. Preserve the matching bytecode, composed source map, staging
manifest and hashes before promoting the update. Keep source maps in private
artifact storage; do not include them among update assets served to clients.

The export command expects one Hermes bytecode bundle and its matching composed
map per selected platform. A missing map, plain JavaScript bundle, missing token
or changed staged artifact is a build failure. Do not share `.everframe` between
concurrent builds or run another Metro configuration between export and upload:
collection selects that platform's latest staged identity.

For a native build, `@everframe/expo` supplies native build-phase setup; for an OTA
export, use `upload-expo-export` after export and before promotion. Artifact upload
and OTA publication are separate operations. Upload readiness confirms artifact
processing, not that a device installed the update.

When troubleshooting, compare the bundle's injected identity, its collected
manifest, and the event's JavaScript bundle metadata. Also record Expo's
`updateId`, `isEmbeddedLaunch`, `runtimeVersion`, and the native version. A cached
offline update and an embedded rollback must retain their own bundle identities.
Never substitute the native version when a bundle identifier is missing.

Expo update behavior is defined by the [Updates SDK](https://docs.expo.dev/versions/latest/sdk/updates/)
and [Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/).
