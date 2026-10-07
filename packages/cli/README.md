# Everframe build artifact CLI

Run `everframe --help` for source-map, Hermes, R8 and build-staging commands.

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
