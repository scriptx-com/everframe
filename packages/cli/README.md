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
ambiguous identities, unsupported headers and invalid segment/section ranges
fail before any upload. Full DWARF validity is checked by the service and can
still reject a later file after an earlier artifact is ready. The command does not
infer coverage for unlisted modules or inspect compressed archives. Current native
support covers little-endian64 arm64/arm64e/x86_64/x86_64h slices, including
universal files. Limits:16 listed binaries,8 selected files,64 candidate bundles,
1024 directory entries and64MiB per DWARF file.

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
