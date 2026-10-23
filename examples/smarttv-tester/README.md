<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe — Smart-TV Tester

A Tizen/webOS tester app with a minimal spatial focus manager. Use it to
exercise remote-control input (arrows / OK / Back with the platform key
codes), confirm which Chromium milestone a TV engine reports, and run the
Everframe Web SDK — on a device, in a browser, or in a downloaded desktop
Chromium matching a TV's engine version.

## What's inside

- `src/focus/` — the focus manager. `spatial.ts` is the pure geometry
  (nearest neighbour in the pressed direction, off-axis penalty; unit-tested
  in `__tests__/spatial.spec.ts`); `FocusManager.tsx` is the React layer
  (`FocusProvider` + `useFocusable`). Back is Tizen `10009`, webOS `461`,
  Escape on desktop.
- `src/components/` — focus grid, raw keydown log and device/engine info.
- `platforms/tizen`, `platforms/webos` — `config.xml` / `appinfo.json` and
  icons merged into the staged package.
- Builds go through `@vitejs/plugin-legacy` (`chrome>=38`), so the packaged
  bundle runs on old TV engines; the dev server serves modern ESM only.

## Run it

All commands from this directory (or `pnpm --filter
@everframe/example-smarttv-tester <script>` from the repo root).

### Hosted on the web

```sh
pnpm dev          # dev server, http://<lan-ip>:4174 — modern engines only
pnpm run:hosted   # vite build + preview on 0.0.0.0:4174 — incl. legacy chunks
```

Open the printed LAN URL in a TV browser, or point a hosted shell package at
it (below).

### On a device

Tizen (needs Tizen Studio + a certificate profile, TV in developer mode):

```sh
TIZEN_CERT_NAME=<profile> pnpm build:tizen                 # package only
TIZEN_CERT_NAME=<profile> DEVICE=<sdb serial> pnpm run:tizen   # + install & launch
```

webOS (needs the ares CLI, device registered via `ares-setup-device`):

```sh
pnpm build:webos                     # package only
DEVICE=<name> pnpm run:webos         # + ares-install & ares-launch
```

Hosted-shell variant — package a stub that redirects to a URL, install once,
then iterate on the web build alone:

```sh
HOSTED_URL=http://<lan-ip>:4174 TIZEN_CERT_NAME=<profile> DEVICE=<serial> pnpm run:tizen
HOSTED_URL=http://<lan-ip>:4174 DEVICE=<name> pnpm run:webos
```

### In a selected Chromium milestone

Approximate a TV engine on your desk (macOS; snapshots cached under
`~/.everframe/chromium/`):

```sh
pnpm run:chromium 69                  # build + preview + launch Chromium 69
pnpm run:chromium 94 --dev            # dev server instead (needs >= 63)
pnpm run:chromium 47 http://host:1234 # against any URL
pnpm run:chromium 87 --download-only  # just warm the cache
```

Known milestones: 38 47 53 56 63 68 69 76 79 85 87 94 108 120 130 132.
Rough engine map: webOS 3/4/5/6 ≈ 38/53/68/79 · Tizen 3/4/5/6 ≈ 47/56/63/76 ·
recent models 85–94+.

## Everframe SDK

`main.tsx` mounts `EverframeProvider`, so the tester reports crashes, errors,
breadcrumbs and session replay from the TV browser. One build-time input, read
from the repo-root `.env` (a real env var overrides):

- `EVERFRAME_KEY_WEB` — the Web app's SDK key (`evf_live_…` from the
  dashboard).
