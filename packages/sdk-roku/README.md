<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/roku

Crash and error reporting for Roku channels (BrightScript / SceneGraph).

## What you get

| Tier | Setup | Reports | Requires |
| --- | --- | --- | --- |
| 1. ComponentLibrary | Load the library and call `start()` | Crashes and runtime errors detected on the **next launch** (exit reason from `GetLastExitInfo`), manual `captureException`, breadcrumbs, user | Roku OS **13.0+** for exit detection |
| 2. Build-step instrumentation | Run `everframe-roku instrument` before packaging | Everything in tier 1, plus **caught-and-rethrown** errors from wrapped entry points with a stack, a `try-catch` mechanism, and key / lifecycle breadcrumbs | Roku OS **9.4+** (try/catch) |

Notes on stack frames:

- With tier 1 alone, frames come from the device's recent console log ("Path B"). Frames are **often missing**: `console_log` holds only 20 lines and is frequently filled with beacon lines, so the exit is still reported (with the exit code as its type) but without a stack.
- Tier 2 captures the exception's backtrace at the point of the throw, so it does not depend on the console log.

## Install

```sh
npm i -D @everframe/roku
```

## Tier 1: ComponentLibrary, bundled

Copy `node_modules/@everframe/roku/dist/everframe-roku-<version>.zip` into your channel's `components/` folder (or let `--bundle-library` do it, see tier 2), then load it from your scene:

```xml
<!-- MainScene.xml -->
<children>
  <ComponentLibrary id="Everframe" uri="pkg:/components/everframe-roku-0.1.0.zip" />
</children>
```

```brightscript
' MainScene.brs
sub init()
    m.efLib = m.top.findNode("Everframe")
    m.efLib.observeField("loadStatus", "onEverframeLoad")
end sub

sub onEverframeLoad()
    if m.efLib.loadStatus <> "ready" then return
    ef = CreateObject("roSGNode", "Everframe:Everframe")
    ef.callFunc("start", { sdkKey: "evf_live_..." })
end sub
```

`start()` publishes the node as `m.global.everframe`. Supported config keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `sdkKey` | required | Your Everframe SDK key |
| `endpoint` | `https://everframe.dev` | Ingest host. For self-testing only |
| `enabled` | `true` | Set `false` to turn the SDK off |
| `maxBreadcrumbs` | SDK default | Breadcrumb ring size |

## Tier 1: ComponentLibrary, remote

Host the same zip and point the library at it:

```xml
<ComponentLibrary id="Everframe" uri="https://<your host>/everframe-roku-0.1.0.zip" />
```

Trade-offs compared with bundling:

- The library is downloaded over the network on every launch.
- A crash that happens before the library has loaded is only reported on the next launch where it does load.
- Your channel depends on a remote host being available.

## Tier 2: build-step instrumentation

Add a build step that rewrites a copy of your channel and packages that copy:

```json
{
  "scripts": {
    "deploy": "everframe-roku instrument ./ --out ./.everframe-build --bundle-library && roku-deploy --rootDir ./.everframe-build"
  }
}
```

Add `.everframe-build/` to `.gitignore`. `--out` is required unless you pass `--dry-run`, and must not be inside the channel directory being instrumented. Your sources are never modified; the instrumented copy is written to `--out`.

You still load the library and call `start()` as in tier 1 (`--bundle-library` copies `everframe-roku-<version>.zip` into `<out>/components/`). The instrumented functions report through it.

### What gets wrapped

Each targeted function body is wrapped in `try ... catch e ... end try` **on the same source line**, so line numbers in stack traces still match your original files. The catch records the error and then re-throws the original exception, so your channel's behavior is unchanged. These entry points are wrapped:

- `Main` / `RunUserInterface` in `source/`
- `init` of every component (also leaves a lifecycle breadcrumb)
- `onKeyEvent` (also leaves a key breadcrumb)
- `onChange` handlers declared on interface fields
- functions declared in a component `<interface>`
- callbacks registered with `observeField` / `observeFieldScoped`
- Task `functionName` targets

Functions that cannot be wrapped safely are skipped and listed in the output.

### Options

```sh
everframe-roku instrument <channelDir> --out <dir> \
  [--exclude <glob>]... \
  [--mechanisms main,init,key,observer,task,callfunc] \
  [--bundle-library] [--dry-run]
```

- `--exclude <glob>`: skip files whose channel-relative path matches the glob. Repeatable, for example `--exclude "components/vendor/**"`.
- `--mechanisms`: comma-separated subset of `main`, `init`, `key`, `observer`, `task`, `callfunc`. Default is all of them.
- `--bundle-library`: copy the library zip into `<out>/components/`.
- `--dry-run`: print what would be wrapped without writing anything (`--out` is not needed).

## Manual API

Once started, the node is available as `m.global.everframe` from any scope:

```brightscript
' Report a caught exception
try
    doRiskyThing()
catch e
    m.global.everframe.callFunc("captureException", e)
end try

' Leave a breadcrumb: kind is one of navigation, tap, console, network,
' lifecycle, error, custom (default custom)
m.global.everframe.callFunc("addBreadcrumb", { kind: "navigation", message: "opened details", data: { id: "42" } })

' Attach a user (id, email, displayName); call with invalid to clear
m.global.everframe.callFunc("setUser", { id: "user-123", email: "viewer@example.com" })
```

## Endpoint

Reports go to `https://everframe.dev` by default. The `endpoint` option in `start()` exists for self-testing only.

## License

MIT
