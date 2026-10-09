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
file up to 64 MiB, including universal files; archives and dSYM directories are not
accepted. The upload identity is derived from the exact file bytes. The service
verifies the file and indexes its image UUID/CPU identities; a release label cannot
substitute for matching symbols. Files remain on disk after upload. Configure this
command in your build pipeline after dSYM generation; automatic native build-hook
installation is not included.

## Verify and upload a native Apple build

After a successful Xcode build or archive, explicitly list the app and frameworks
whose crash frames you promise to support:

```sh
everframe dsym upload-build --app-id "$EVERFRAME_APP_ID" \
  --binary "App.xcarchive/Products/Applications/App.app/App" \
  --binary "App.xcarchive/Products/Applications/App.app/Frameworks/Feature.framework/Feature" \
  --dsym-dir "App.xcarchive/dSYMs"
```

The command checks every listed Mach-O UUID/CPU identity against the raw DWARF
files in the directory's `.dSYM/Contents/Resources/DWARF` layout. Missing or
ambiguous identities, unsupported listed binaries and oversized matching files
fail before any upload. Other dSYMs in the directory, such as a watchOS companion
or unlisted frameworks, are inspected but not selected. A DWARF file with an
unsupported or malformed header, including invalid segment/section ranges, is
never uploaded: it is skipped, and the failure for a listed identity without a
match names the skipped files. Full DWARF validity is checked by the service and can
still reject a later file after an earlier artifact is ready. The command does not
infer coverage for unlisted modules or inspect compressed archives. Current native
support covers little-endian64 arm64/arm64e/x86_64/x86_64h slices, including
universal files. Limits: 16 listed binaries, 8 selected files, 64 bundles that
hold a listed identity, 1024 directory entries and 64 MiB per selected DWARF file.

A failed local check prints its code first, then the paths and image identities
involved:

| Code | What to check |
| --- | --- |
| `missing_matching_dsym` | Each listed image without a match is printed as architecture, UUID and binary path. Build that target with `DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`, pass the directory that holds its `.dSYM` bundle, and compare `dwarfdump --uuid` for the binary and the dSYM. Skipped files and the reason for each follow the list. |
| `ambiguous_dsym_identity` | Two different DWARF files hold the printed identity. Remove the stale copy from the directory. |
| `invalid_apple_binary`, `unsupported_apple_architecture` | The printed file is not a supported 64-bit little-endian Mach-O. Do not list watchOS arm64_32 or other 32-bit binaries. |
| `invalid_input_file` | The printed path is not a regular file. List the executable inside a bundle, such as `App.app/App`, not the bundle directory. |
| `dsym_too_large` | The printed matching DWARF file exceeds 64 MiB. |
| `apple_build_limit` | The message names the limit. Pass a directory that holds only this build's dSYMs, or split the binaries across runs. |
| `source_map_changed` | The printed file changed during the run. Run the command after the build has finished writing its outputs. |
| `symlink_escapes_root` | The printed path resolves outside `--dsym-dir` or, for a listed binary, outside its own directory. Pass real paths instead of symlinks. |

Each selected file uses its own immutable artifact upload. Success means all are
ready; a later failure leaves earlier ready artifacts available and returns a
nonzero exit status. Re-run the same command to resume. Original binaries and
dSYMs are retained; changing selected symbol bytes or listed image identities
during upload prevents success. Executable bodies are not hashed.
Gate app promotion on this command's exit status. A ready upload establishes
artifact availability; device compatibility and readable frames still require
crash acceptance testing.

[The CI shell example](examples/upload-apple-symbols.sh) accepts the symbol
directory followed by the exact binaries. Set `EVERFRAME_APP_ID` and inject
`EVERFRAME_API_TOKEN` from a scoped CI secret. It propagates failures and does not
install an Xcode build phase:

```sh
bash packages/cli/examples/upload-apple-symbols.sh \
  "App.xcarchive/dSYMs" "App.xcarchive/Products/Applications/App.app/App"
```

For an unreleased checkout, build the CLI and use its local entry directly:

```sh
pnpm --dir packages/cli build
node packages/cli/dist/index.js dsym upload-build --app-id "$EVERFRAME_APP_ID" \
  --binary "/absolute/build/App.app/App" --dsym-dir "/absolute/build/dSYMs"
```

The shell example also accepts `EVERFRAME_CLI_JS` pointing to that built
`dist/index.js`. This workflow does not require publishing a package first.

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

### Gate Android native builds on exact symbols

After a successful native build, list the **actual shipped libraries** and an
unstripped symbol directory. GNU build ID and ABI must match for every listed
image; file names and release labels are not used for matching.

```sh
export EVERFRAME_APP_ID='your-app-id'
# Set EVERFRAME_API_TOKEN from your CI secret store (artifacts:write scope).
everframe elf upload-build --app-id "$EVERFRAME_APP_ID" \
  --binary shipped/arm64-v8a/libapp.so \
  --binary shipped/armeabi-v7a/libapp.so \
  --symbols-dir symbols/release
```

The gate checks complete binary and symbol hashes before and after uploading.
Missing, wrong-ABI, stripped-only or ambiguous symbol coverage fails before any
request. A late local change or service rejection fails the command. Artifacts
already accepted remain reusable on retry; no source files are deleted. Preserve
these outputs unchanged through the gate and promote those exact build outputs.
The command does not enumerate an APK or prove coverage for unlisted libraries.

Use [the Bash wrapper](examples/upload-android-symbols.sh) or adapt the explicit
[Gradle Kotlin task](examples/upload-android-symbols.gradle.kts) to your variant.
Copy the wrapper into `ci/` for that Gradle example. Invoke the symbol task in CI
before promotion; ordinary `assembleRelease` does not upload automatically.
`EVERFRAME_CLI_JS` optionally points the wrapper to a locally built CLI entry.
Tokens stay in inherited environment variables, not command-line arguments.

Limits: 1–16 binaries, 16 selected artifacts, 1024 traversed directory entries,
8 nested directory levels, 64 MiB per file and 512 MiB inspected per pass.
Only `.so` candidates are inspected, including nested directories. Exact duplicate
bytes deduplicate; different unstripped bytes claiming the same build ID and ABI
are rejected. Use embedded, uncompressed `.debug_info` and `.debug_line`; split,
separate and compressed core DWARF are unsupported. The service performs full
DWARF validation. Android ARM32/ARM64/x86/x86_64 are supported; RISC-V64 identity
parsing has synthetic coverage only.
