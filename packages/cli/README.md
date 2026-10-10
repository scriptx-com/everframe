<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe build artifact CLI

Run `everframe --help` for source-map, Hermes, R8, native symbols and build-staging commands.

## Apple dSYM upload

Upload the raw DWARF file inside the dSYM produced by the same build as the crash:

```sh
everframe dsym upload --app-id "$EVERFRAME_APP_ID" --dwarf "App.app.dSYM/Contents/Resources/DWARF/App"
```

Set `EVERFRAME_API_TOKEN` to a token with `artifacts:write` access to the app.
`EVERFRAME_API_URL` optionally selects the API endpoint. Uploads accept one raw
file up to 512 MiB, including universal files; archives and dSYM directories are not
accepted. The upload identity is derived from the exact file bytes. The service
verifies the file and indexes its image UUID/CPU identities; a release label cannot
substitute for matching symbols. Uploads use a private snapshot in the system
temporary directory (`TMPDIR`) and stream it with bounded memory; allow free space
there for one copy of the file. Retries send that same snapshot. The snapshot is
removed when the command ends, including after SIGINT, SIGTERM or SIGHUP; a process
killed with SIGKILL can leave it behind. The service must support the 512 MiB Apple
limit; older services may reject files above 64 MiB. Each upload attempt must be
received and verified by the service within five minutes, so a 512 MiB dSYM needs
about 15 Mbit/s of sustained upload bandwidth (about 11 Mbit/s for 400 MiB); slower
links fail the attempt and its retries. Files remain on disk after upload. To upload
every dSYM of a build automatically, use `dsym upload-build` below.

## Upload Apple symbols automatically

Install the Xcode build phase once (see "Xcode build phase" below), or run one
command after an archive:

```sh
everframe dsym upload-build --archive "App.xcarchive"          # CI, fastlane, Xcode Cloud
everframe dsym upload-build --xcode                            # inside an Xcode Run Script phase
everframe dsym upload-build --app App.app --dsym-dir dSYMs     # any other layout
everframe dsym upload-build --binary App.app/App --dsym-dir dSYMs   # explicit list, all required
```

The command finds the app executable and the app extensions (`PlugIns/`,
`Extensions/`, including a tvOS Top Shelf extension). These are required. It
also finds embedded frameworks and dylibs, which are optional. With `--xcode`
it also follows the app's run-path links to frameworks that are built but not
embedded yet, such as CocoaPods frameworks under `use_frameworks!`, whose
"[CP] Embed Pods Frameworks" phase runs after the upload phase. `libswift*` and
watchOS content are skipped. dSYM folders are searched recursively, up to four
levels deep, without entering bundles. A missing dSYM for an optional binary
prints `warning: no dSYM for …` (an Xcode build warning). With `--xcode`,
`--archive` or `--app`, a missing dSYM for a required binary, a missing or
unreadable `--dsym-dir` folder (the other folders are still searched), an
unreadable folder or bundle, or a file the service rejects also becomes a
warning after everything else has uploaded; with `--strict` and `--binary` it
fails with `missing_matching_dsym` (or the rejection) instead. When `--xcode`
cannot search part of the build products for run-path frameworks (a symlink
loop, a folder it may not read) or stops at the 16384-entry limit, it warns
and still uploads the app's own dSYMs and every framework it did find. `--xcode` skips Debug builds (set
`EVERFRAME_UPLOAD_DEBUG=1` to upload them) and builds without
`DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`.

`--app-id` defaults to `EVERFRAME_APP_ID`.

**Symbols never break your build by default.** With `--xcode`, `--archive` or
`--app`, a missing `EVERFRAME_API_TOKEN` or a failed upload prints a `warning:`
line (an Xcode build warning, or a line in your CI log) and the command exits 0,
locally and in CI. Crashes from that build show raw addresses until its symbols
are uploaded, and the dashboard names what is missing. To gate a release on its
symbols, pass `--strict` or set `EVERFRAME_SYMBOLS_STRICT=1`: a missing token or
a failed upload then fails the build, and every binary needs a dSYM. The
explicit `--binary` list is always strict.

fastlane:

```ruby
build_app(scheme: "App")
sh("npx", "--yes", "@everframe/cli", "dsym", "upload-build", "--archive", lane_context[SharedValues::XCODEBUILD_ARCHIVE])
```

Xcode Cloud (`ci_scripts/ci_post_xcodebuild.sh`; install Node in `ci_post_clone.sh`):

```sh
if [ -n "${CI_ARCHIVE_PATH:-}" ]; then npx --yes @everframe/cli dsym upload-build --archive "$CI_ARCHIVE_PATH"; fi
```

The `npx` commands need `@everframe/cli` published on npm. From a source
checkout, build the CLI and run `node packages/cli/dist/index.js` instead.

[The CI shell example](examples/upload-apple-symbols.sh) uploads an archive.
It uses `EVERFRAME_CLI_JS` (a built `dist/index.js`) when set, and
`npx --yes @everframe/cli` otherwise.

Limits: 256 binaries, 128 selected DWARF files, 256 matching `.dSYM` bundles,
16384 directory entries and 512 MiB per DWARF file. Supported slices:
little-endian 64-bit arm64/arm64e/x86_64/x86_64h for iOS, tvOS and their
simulators. Each selected file is its own immutable upload. Re-run the
command to resume after a failure.

A failed check prints its code first:

| Code | What to check |
| --- | --- |
| `missing_matching_dsym` | Each listed image without a match is printed as architecture, UUID and binary path. Build that target with `DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`, pass the directory that holds its `.dSYM` bundle, and compare `dwarfdump --uuid` for the binary and the dSYM. Skipped files and the reason for each follow the list. |
| `ambiguous_dsym_identity` | Two different DWARF files hold the printed identity. Remove the stale copy from the directory. |
| `invalid_apple_binary`, `unsupported_apple_architecture` | The printed file is not a supported 64-bit little-endian Mach-O. Do not list watchOS arm64_32 or other 32-bit binaries. |
| `invalid_input_file` | The printed path is not a regular file. List the executable inside a bundle, such as `App.app/App`, not the bundle directory. |
| `dsym_too_large` | The printed matching DWARF file exceeds 512 MiB. |
| `apple_build_limit` | The message names the limit. Pass a directory that holds only this build's dSYMs, or split the binaries across runs. |
| `source_map_changed` | The printed file changed during the run. Run the command after the build has finished writing its outputs. |
| `symlink_escapes_root` | The printed path resolves outside `--dsym-dir` or, for a listed binary, outside its own directory. Pass real paths instead of symlinks. |

## Xcode build phase

Install the phase once per project:

```sh
npx @everframe/cli setup xcode --project App.xcodeproj --app-id "$EVERFRAME_APP_ID"
```

`--app-id` is the App ID: the UUID of the Everframe app the target reports to,
shown on the app's Setup tab in the dashboard. It is not the `evf_live_…` SDK
key that the app passes to `EverframeConfig(sdkKey:)`. The installer writes it
into the phase; without `--app-id`, the upload reads `EVERFRAME_APP_ID` from
the build environment, which includes every build setting of the target.

It adds an "Upload Everframe Symbols" Run Script phase as the last phase of
every application target (narrow it with `--target <name>`, repeatable). The
phase runs `everframe dsym upload-build --xcode` on every build, after Xcode
has written the dSYMs and `Info.plist`, so archives, `xcodebuild`, fastlane and
Xcode Cloud upload without extra steps. Running the command again is safe.

- Debug builds skip (set `EVERFRAME_UPLOAD_DEBUG=1` to upload them).
- Without `EVERFRAME_API_TOKEN`, or when the upload fails, the phase prints a
  `warning:` line and the build succeeds. Set `EVERFRAME_SYMBOLS_STRICT=1` to
  fail the build instead.
- The installer sets `ENABLE_USER_SCRIPT_SANDBOXING = NO` on those targets,
  because the phase reads embedded frameworks, dSYM folders and
  `node_modules`, which a sandboxed script cannot list. A phase that still runs
  sandboxed reports `xcode_script_sandboxed` with this fix.
- The phase declares the dSYM as an input only for `dwarf-with-dsym` builds,
  which orders it after dSYM generation. Debug (`dwarf`) builds declare
  `Info.plist` instead, so a missing dSYM can never fail the build. The
  installer writes the `EVERFRAME_DSYM_INPUT*` build settings that do this.
- The phase finds the CLI in this order: `EVERFRAME_CLI_JS` (a built
  `dist/index.js`), then `@everframe/cli` in the project's `node_modules`, then
  `npx --yes --prefer-offline @everframe/cli@<version that installed the phase>`
  with short registry timeouts. The `npx` fallback needs the CLI to be published
  on npm. The phase needs Node (`NODE_BINARY` from `.xcode.env` is honoured);
  without it, it warns and the build continues.
- Uploads stop after `EVERFRAME_UPLOAD_TIMEOUT_SECONDS` (600 by default for
  build integrations): the phase warns and the build continues. Files uploaded
  before then are kept.

XcodeGen regenerates the project, so add the phase to `project.yml` instead.
`everframe setup xcode --print-script > scripts/upload-everframe-symbols.sh`
writes the script:

```yaml
targets:
  App:
    settings:
      base:
        ENABLE_USER_SCRIPT_SANDBOXING: NO
        EVERFRAME_DSYM_INPUT: $(EVERFRAME_DSYM_INPUT_$(DEBUG_INFORMATION_FORMAT:c99extidentifier))
        EVERFRAME_DSYM_INPUT_dwarf_with_dsym: $(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(EXECUTABLE_NAME)
        EVERFRAME_DSYM_INPUT_dwarf: $(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)
        EVERFRAME_DSYM_INPUT_: $(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)
    postBuildScripts:
      - name: Upload Everframe Symbols
        path: scripts/upload-everframe-symbols.sh
        shell: /bin/bash
        basedOnDependencyAnalysis: false
        inputFiles:
          - $(EVERFRAME_DSYM_INPUT)
          - $(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)
```

The native sample app (`examples/ios-native/project.yml` in the repository) is wired this way.

An iPhone target and an Apple TV target that report to two Everframe apps need
one App ID each. Run the installer once per target; each run changes only the
target it names:

```sh
npx @everframe/cli setup xcode --project App.xcodeproj --target App --app-id "$PHONE_APP_ID"
npx @everframe/cli setup xcode --project App.xcodeproj --target AppTV --app-id "$TV_APP_ID"
```

With XcodeGen, print the script once without `--app-id` and set
`EVERFRAME_APP_ID` in each target's settings:

```yaml
targets:
  App:
    settings:
      base:
        EVERFRAME_APP_ID: 00000000-0000-4000-8000-000000000001 # the phone app's App ID
  AppTV:
    settings:
      base:
        EVERFRAME_APP_ID: 00000000-0000-4000-8000-000000000002 # the TV app's App ID
```

## Android ELF upload

Keep the unstripped shared library produced by each Android build and ABI:

```sh
everframe elf upload --app-id "$EVERFRAME_APP_ID" \
  --library "symbols/arm64-v8a/libapp.so"
```

Set `EVERFRAME_API_TOKEN` to a token with `artifacts:write` access to the app.
`EVERFRAME_API_URL` optionally selects the endpoint. Each invocation uploads one
raw ELF file up to 64 MiB and retains the local file. Archives, symbol directories,
separate debug files and compressed DWARF sections are unsupported. The service
requires embedded DWARF line/debug information and a GNU build ID, then matches
frames by that exact build ID and ABI within the app. A release label or library
filename cannot substitute for that identity. Keep the build ID in the shipped
library; stripping runtime debug information must preserve it.

Run once for every library and ABI whose frames need symbols. Upload after the
native build and before promoting the app; a nonzero exit means the artifact is
not ready. Retrying the same file resumes its content-addressed upload. This
command does not install a Gradle task or discover build outputs. A ready artifact
establishes symbol availability; readable crashes still require device testing.

### Upload a native Android build

Point the command at the stripped libraries the build ships and at the
unstripped libraries Gradle keeps beside them. With the Android Gradle plugin
these are the `strip<Variant>DebugSymbols` and `merge<Variant>NativeLibs`
outputs, laid out as `lib/<abi>/*.so`:

```sh
export EVERFRAME_APP_ID='your-app-id'
# Set EVERFRAME_API_TOKEN from your CI secret store (artifacts:write scope).
everframe elf upload-build \
  --binaries-dir app/build/intermediates/stripped_native_libs/release/stripReleaseDebugSymbols/out/lib \
  --symbols-dir app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib
```

`--binaries-dir` uploads every shipped `.so` that has a matching unstripped
library (same GNU build ID and ABI); `--abi arm64-v8a` (repeatable) limits it to
the ABIs you ship. Prebuilt libraries from AARs, such as `libhermes.so` or
`libc++_shared.so`, usually ship without debug info: one line names them, and
their frames stay raw. Your own libraries without a matching unstripped copy
print `warning: no symbols for <path>: …`; the command still succeeds.
`--summary` prints one `detail:` line per library instead, for build
integrations to summarize. A directory without libraries does nothing.

**It never fails your build by default.** In `--binaries-dir` mode a missing
`EVERFRAME_API_TOKEN` or a failed upload prints `warning:` lines and exits 0.
A library the service rejects does not stop the others: every library is
uploaded first, then each rejection prints `warning: everframe: upload failed
for <path>: …`.
Pass `--strict` or set `EVERFRAME_SYMBOLS_STRICT=1` to fail instead and to
require symbols for every shipped library; a required library without them
fails with `missing_matching_elf`, naming its ABI, build ID and path.

To check an explicit list instead, pass `--binary` once per shipped library.
Every listed library is required, and failures exit nonzero:

```sh
everframe elf upload-build --app-id "$EVERFRAME_APP_ID" \
  --binary shipped/arm64-v8a/libapp.so \
  --binary shipped/armeabi-v7a/libapp.so \
  --symbols-dir symbols/release
```

The command checks complete binary and symbol hashes before and after uploading.
Wrong-ABI, stripped-only or ambiguous symbol coverage is never uploaded. Artifacts
already accepted remain reusable on retry; no source files are deleted.

Use [the Bash wrapper](examples/upload-android-symbols.sh) or adapt the explicit
[Gradle Kotlin task](examples/upload-android-symbols.gradle.kts) to your variant.
Copy the wrapper into `ci/` for that Gradle example. `EVERFRAME_CLI_JS`
optionally points the wrapper to a locally built CLI entry. Tokens stay in
inherited environment variables, not command-line arguments.

Limits: 256 libraries, 128 selected artifacts, 16384 traversed directory
entries, 8 nested directory levels, 64 MiB per file and 4 GiB inspected per run.
Only `.so` candidates are inspected, including nested directories. Exact duplicate
bytes deduplicate; different unstripped bytes claiming the same build ID and ABI
are rejected. Use embedded, uncompressed `.debug_info` and `.debug_line`; split,
separate and compressed core DWARF are unsupported. The service performs full
DWARF validation. Android ARM32/ARM64/x86/x86_64 are supported; RISC-V64 identity
parsing has synthetic coverage only.
