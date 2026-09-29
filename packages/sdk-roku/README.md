<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/roku

Crash and error reporting for Roku channels (BrightScript / SceneGraph).

## What you get

| Tier | Setup | Reports | Requires |
| --- | --- | --- | --- |
| 1. ComponentLibrary | Load the library, call `start()`, and add a few lines to `Main()` | Crashes and runtime errors detected on the **next launch** (exit reason from `GetLastExitInfo`, recorded by your `Main()`), manual `captureException`, breadcrumbs, user | Roku OS **13.0+** for exit detection |
| 2. Build-step instrumentation | Run `everframe-roku instrument` before packaging | Everything in tier 1 (the `Main()` lines are added for you), plus errors from wrapped entry points (recorded, then re-thrown) with a stack, a `try-catch` mechanism, and key-press / scene-init breadcrumbs | Roku OS **9.4+** (try/catch) |

Notes on stack frames:

- With tier 1 alone, frames come from the device's recent console log ("Path B"). Frames are **often missing**: `console_log` holds only 20 lines and is frequently filled with beacon lines, so the exit is still reported (with the exit code as its type) but without a stack.
- Tier 2 captures the exception's backtrace at the point of the throw, so it does not depend on the console log.

## Install

```sh
npm i -D @everframe/roku
```

## Tier 1: ComponentLibrary, bundled

Copy `node_modules/@everframe/roku/dist/everframe-roku-<version>.zip` into your channel's `components/` folder (or let `--bundle-library` do it, see tier 2), then load it from your scene. `<version>` is the installed package version: the exact file name is whatever `ls node_modules/@everframe/roku/dist/*.zip` shows, and `instrument --bundle-library` prints it as `library  components/everframe-roku-<version>.zip`. Update the `uri` when you upgrade the package.

```xml
<!-- MainScene.xml: replace <version> with the installed version -->
<children>
  <ComponentLibrary id="Everframe" uri="pkg:/components/everframe-roku-<version>.zip" />
</children>
```

Then add this at the very top of `Main()`, before you create the `roSGScreen`:

```brightscript
' source/main.brs
sub Main()
    ' Everframe: record why the previous launch ended. Keep this first.
    try
        am = CreateObject("roAppManager")
        info = am.GetLastExitInfo()
        if type(info) = "roAssociativeArray" and info["exit_code"] <> invalid and info["timestamp"] <> invalid then
            ' One section per channel: Roku shares the registry across a developer's channels.
            sec = CreateObject("roRegistrySection", "Everframe_" + CreateObject("roAppInfo").GetID())
            ' Keep the exited session's screen and breadcrumbs with the exit.
            if sec.Exists("screen") then info["efScreen"] = sec.Read("screen")
            if sec.Exists("crumbs") then info["efCrumbs"] = sec.Read("crumbs")
            ' Skip sessions that ran with start({ enabled: false }).
            if not sec.Exists("disabled") then sec.Write("pendingExit", FormatJson(info)) : sec.Flush()
        end if
    catch e
    end try

    screen = CreateObject("roSGScreen")
    ' ... your existing Main() ...
end sub
```

Roku returns the previous launch's exit record (`GetLastExitInfo`, Roku OS 13.0+) only to your channel's own code. Called from inside the Everframe ComponentLibrary it always answers `EXIT_UNKNOWN` with no timestamp, so the library cannot read it itself. These lines store the record in the registry (section `Everframe_<channel ID>`, key `pendingExit`); the library picks it up after `start()` and reports it, together with the screen and breadcrumbs of the session that ended (copied before the new launch writes its own). A crash already reported by `try`/`catch` is matched to its exit by kind, not by clock, because the device clock and the exit timestamp can differ by tens of seconds. Without them, tier 1 still sends `captureException` reports, but crashes that end the channel are not detected. Tier 2 inserts the equivalent call (`Everframe_RecordLastExit()`) into `Main` / `RunUserInterface` for you.

> **Warning:** calling `GetLastExitInfo()` in your own code as well is fine: reading it does not consume the record. Call it from `Main()` or a Task only, never from the render thread (a component's `init`, observers, or `onKeyEvent`): `roAppManager` cannot be created there.

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
| `enabled` | `true` | Set `false` to turn the SDK off. This is remembered on the device: queued reports are discarded, and instrumented code records nothing until a later `start()` without it. |
| `maxBreadcrumbs` | `50` | Breadcrumb ring size. An integer, clamped to 1–50; other values are ignored |

## Tier 1: ComponentLibrary, remote

Host the same zip and point the library at it:

```xml
<ComponentLibrary id="Everframe" uri="https://<your host>/everframe-roku-<version>.zip" />
```

Trade-offs compared with bundling:

- The library is downloaded over the network on every launch.
- A crash that happens before the library has loaded is only reported on the next launch where it does load.
- Your channel depends on a remote host being available.

## Tier 2: build-step instrumentation

Add one Everframe build step that writes an instrumented copy of your channel to `.everframe-build`, then point whatever tool you use at that folder. Instrument release and beta builds, and keep day-to-day development builds uninstrumented (see [Effect on debugging](#effect-on-debugging)):

```json
{
  "scripts": {
    "everframe:build": "everframe-roku instrument ./ --out ./.everframe-build --bundle-library",
    "deploy:dev": "roku-deploy",
    "deploy:release": "npm run everframe:build && cd .everframe-build && roku-deploy"
  }
}
```

`.everframe-build` is a complete channel folder: the instrument step copies the whole channel, including `rokudeploy.json`. That is why `deploy:release` runs `roku-deploy` from inside it, where its default `rootDir: "./"` is the instrumented copy. `roku-deploy` 3.x ignores command-line arguments and reads its options only from `rokudeploy.json` / `bsconfig.json` in the current directory, so `roku-deploy --rootDir ./.everframe-build` would silently deploy your uninstrumented channel. Keep the `cd` in the same script as the deploy tool: a `cd` in one npm script does not carry over to the next.

### Using the build with your tools

- **roku-deploy:** the `deploy:release` script above.
- **VS Code BrightScript extension:** add a task that runs the build, and point the launch configuration at the output folder.

  `.vscode/tasks.json`:

  ```json
  {
    "version": "2.0.0",
    "tasks": [
      { "label": "everframe:build", "type": "npm", "script": "everframe:build" }
    ]
  }
  ```

  `.vscode/launch.json` (add to your existing BrightScript configuration):

  ```json
  {
    "type": "brightscript",
    "request": "launch",
    "name": "Everframe release build",
    "rootDir": "${workspaceFolder}/.everframe-build",
    "preLaunchTask": "everframe:build"
  }
  ```

  Keep your normal launch configuration (with `"rootDir": "${workspaceFolder}"`) for debugging; the debugger stops in different places in the instrumented copy.
- **Any other tool, CI or signed packaging:** run `everframe:build`, then zip or deploy the contents of `.everframe-build` with your own tooling.

If your scene loads the bundled zip, keep a copy of it in `components/` so uninstrumented dev builds can load the library too (with the tier 1 `Main()` lines, uninstrumented builds still report crashes on the next launch; the instrumented `Main` records the exit itself, so the two do not conflict).

Add `.everframe-build/` to `.gitignore`. `--out` is required unless you pass `--dry-run`. It may be a subdirectory of the channel, as above: it is skipped when the channel is scanned and copied. It must not be the channel directory itself or a parent of it. Your sources are never modified; the instrumented copy is written to `--out`.

`--out` is emptied on every run so files deleted from your channel do not linger in the build. To make that safe, each run writes a `.everframe-build` marker file into `--out`, and the CLI only empties a directory that has this marker. If `--out` exists, is not empty and has no marker, the command fails with `refusing to overwrite a directory everframe-roku did not create`. Pick an empty or new directory in that case.

You still load the library and call `start()` as in tier 1 (`--bundle-library` copies `everframe-roku-<version>.zip` into `<out>/components/`). The instrumented functions report through it.

### What gets wrapped

Each targeted function body is wrapped in `try ... catch e ... end try` **on the same source line**, so line numbers in stack traces still match your original files. The catch records the error and then re-throws the original exception, so an error that would have crashed your channel still crashes it, and an error your own code catches further up is still caught there. These entry points are wrapped:

- `Main` / `RunUserInterface` in `source/` (these also call `Everframe_RecordLastExit()` first, before any of your code, so the next-launch exit check works without the tier 1 `Main()` lines)
- `init` of every component (the component that extends `Scene` also leaves a lifecycle breadcrumb, and components matching `--screens` also set the current screen)
- `onKeyEvent` (also leaves a key breadcrumb)
- `onChange` handlers declared on interface fields
- functions declared in a component `<interface>`
- callbacks registered with `observeField` / `observeFieldScoped`
- Task `functionName` targets

Functions that cannot be wrapped safely are skipped and listed in the output. This includes any function that contains a label (a `goto` target such as `done:`), because BrightScript does not allow labels inside a `try` block.

### Automatic breadcrumbs

Instrumentation records two kinds of breadcrumb on its own: key presses (from `onKeyEvent`, kind `tap`) and the scene's `init` (kind `lifecycle`). Screen changes from `--screens` (below) add `navigation` breadcrumbs. Anything else, such as network activity, comes from your own `addBreadcrumb` calls.

### Automatic screens

The `init()` of every component whose **name, or any ancestor's name** (via `extends`), matches `--screens` (default `*Screen,*View,*Page`, case-insensitive, whole name) also calls `Everframe_Screen(m.top.subtype())` on the same line, which calls [`setScreen`](#screens) with the component's concrete type. `m.top.subtype()` is the type of the node actually created, even while a base component's `init()` runs, so a subclass without its own `init()` is tracked through its base. If that base does not match `--screens` itself (for example `DetailsScreen extends Base`, and only `Base` defines `init()`), the base's `init()` gets `Everframe_ScreenIf(m.top.subtype(), "DetailsScreen")` instead. The call lists every screen that inherits that `init()`, so other subclasses of `Base` that are not screens are not tracked.

`--screens` matches a component or any of its ancestors by name; if your screens share a base component (e.g. `Page`), matching the base covers all of them. If a subclass and its base both define `init()`, both call `Everframe_Screen` with the same name and the repeat is ignored. So creating a `DetailsScreen` makes `DetailsScreen` the current screen, and every report sent after that carries `context.route: "DetailsScreen"`.

This tracks when a screen component is **created**, not when it is shown or hidden. If your app creates screens ahead of time, keeps them in a stack, or returns to a screen without creating it again, call `setScreen` yourself where the screen becomes visible; a manual call always overrides the automatic one. Use `--screens none` to turn automatic screens off, or pass your own patterns (for example `--screens "*Screen,Home*"`). A script shared by a screen and a non-screen component gets no automatic screen (the CLI lists it as skipped). `--dry-run` prints every tracked component as a `screen` line with the name it matched through (`via`) and the script whose `init()` sets it, which may be an ancestor's.

### Effect on debugging

Instrumentation changes how a crash looks in the BrightScript debugger. The original exception is caught and re-thrown from the end of the wrapped function, so:

- the debugger stops on the wrapped function's `end sub` / `end function` line, not on the line that failed;
- the stack has already unwound to that function, so the local variables of the failing line (and of any functions it called) are gone.

The report sent to Everframe still carries the original error, message and backtrace. Because of the debugger change, instrument release and beta builds and deploy unmodified sources while you develop, as in the `deploy:dev` / `deploy:release` scripts above.

### Options

```sh
everframe-roku instrument <channelDir> --out <dir> \
  [--exclude <glob>]... \
  [--mechanisms main,init,key,observer,task,callfunc] \
  [--screens <globs>|none] \
  [--bundle-library] [--dry-run]
```

- `--exclude <glob>`: skip files whose channel-relative path matches the glob. Repeatable, for example `--exclude "components/vendor/**"`.
- `--mechanisms`: comma-separated subset of `main`, `init`, `key`, `observer`, `task`, `callfunc`. Default is all of them.
- `--screens`: comma-separated globs (`*` and `?`) matched case-insensitively against component names and their ancestors (`extends` chain); matching components set the current screen in `init()` (see [Automatic screens](#automatic-screens)). Default `*Screen,*View,*Page`; `none` turns it off. Needs the `init` mechanism.
- `--bundle-library`: copy the library zip into `<out>/components/`.
- `--dry-run`: print what would be wrapped and which components are tracked as screens, without writing anything (`--out` is not needed).

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
' lifecycle, error, custom (default custom); level, if given, is one of
' debug, info, warn, error (other values are dropped)
m.global.everframe.callFunc("addBreadcrumb", { kind: "navigation", level: "info", message: "opened details", data: { id: "42" } })

' Attach a user (id, email, displayName); numbers and booleans are converted
' to strings, other non-string values are dropped. Call with invalid to clear
m.global.everframe.callFunc("setUser", { id: "user-123", email: "viewer@example.com" })

' Set the current screen (see Screens below)
m.global.everframe.callFunc("setScreen", "Details")
```

### Screens

`setScreen(name)` records the screen the viewer is on. Every report sent after that carries it as `context.route`, and each change leaves a `navigation` breadcrumb `screen: <name>` with `data: { from, to }` (`from` is left out for the first screen). The name is trimmed and cut to 128 characters; numbers and booleans become strings; blank, `invalid` or non-scalar names and a repeat of the current screen are ignored. It returns `true` when the screen changed. `getScreen(invalid)` returns the current screen, or `invalid` before the first call.

The current screen is also written to the registry (section `Everframe_<channel ID>`, key `screen`) on every change. A crash that only the next launch can detect (the exit reason from `GetLastExitInfo`) carries the screen from the session that exited, and a crash caught in-process carries the screen current at the time. Calls made before `start()` are kept in memory and written when `start()` runs.

With tier 2 you usually do not need to call it: see [Automatic screens](#automatic-screens).

## Breadcrumbs across crashes and memory pressure

Both tiers keep the latest 20 breadcrumbs in the registry (section `Everframe_<channel ID>`, key `crumbs`, at most 2000 characters), written at most once every 2 seconds. On the next `start()` they move to `prevCrumbs`, and a crash detected on that launch from the exit reason carries them, so a report reconstructed from `GetLastExitInfo` still shows what happened before it. Reports caught in-process use the live breadcrumbs.

Where `roAppMemoryMonitor` is available, the SDK's reporter Task checks memory use every 5 seconds. It leaves a `custom` breadcrumb at level `warn` the first time use crosses 75, 90 and 95 % of the channel's limit (for example `memory 90% of 286 MB`), and one for the OS memory warning event. Every report carries the latest reading in `details.metadata.memory` as `{ percent, limitMb }`; a crash found on the next launch carries the last reading taken before it.

The registry holds up to 6 queued reports of 2000 characters each plus the breadcrumbs and the current screen (at most 128 characters), about 14 KB of Roku's 16 KB registry. Leave room for your own registry data accordingly. The section name includes the channel ID (`roAppInfo.GetID()`, `dev` when sideloaded) because Roku shares the registry between channels signed with the same developer key.

## Endpoint

Reports go to `https://everframe.dev` by default. The `endpoint` option in `start()` exists for self-testing only.

## License

MIT
