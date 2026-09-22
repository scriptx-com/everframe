<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/example-react-tv

Tizen / WebOS smart-TV companion-mode sample. Demonstrates the React-TV
runtime from Phase 06.2 Plan 09 — host-rendered QR while unpaired, state-driven
indicator once a phone bonds and during report capture.

## Run locally (any modern browser)

```bash
pnpm --filter @traceitx/example-react-tv dev
```

The dev server listens on `0.0.0.0:4173` so a Tizen / WebOS emulator on the
same LAN can hit it. Override the relay endpoint via:

```bash
VITE_RELAY_ENDPOINT=https://relay.example.com pnpm --filter @traceitx/example-react-tv dev
```

## Load into the Tizen TV emulator

1. Install Tizen Studio + the smart-TV extensions (`tizen-studio` package).
2. `pnpm --filter @traceitx/example-react-tv build` → produces `dist/`.
3. In Tizen Studio: **New Project → TV → Web Application → Empty**, replace
   the scaffold's `index.html` + `src/` with the contents of `dist/`.
4. Run on the **TV Simulator** (Tizen 5.5 or later) — the QR appears once the
   WebSocket bonds to the relay.

If screenshot capture fails on the Tizen target, reproduce it with this sample
on the oldest supported emulator before changing the SDK capture path.

## Load into the WebOS TV emulator

1. Install the **WebOS TV CLI** (`@webos-tv/cli`).
2. `pnpm --filter @traceitx/example-react-tv build` → produces `dist/`.
3. `ares-package dist/` → `.ipk` file.
4. `ares-install --device emulator <file>.ipk` → installs into the emulator.
5. `ares-launch --device emulator com.traceitx.example.reacttv` → launches.

## QR library — host choice, not SDK

This sample uses [`qrcode.react`](https://github.com/zpao/qrcode.react). The
TraceItX SDK ships **zero** QR chrome (mirrors the Phase 05.1 trigger-machinery
lock — "Triggers are host-app concern, not SDK"). Hosts may use any QR library
they prefer; the SDK only exposes `companion.pairUrl: string | null`.

## File listing

| File                | Role                                                  |
| ------------------- | ----------------------------------------------------- |
| `index.html`        | 1280×720 viewport hint for smart-TV targets           |
| `src/main.tsx`      | React 19 entry point                                  |
| `src/App.tsx`       | Subscribes to `companion.state` + `companion.pairUrl` |
| `vite.config.ts`    | `base: '/'` for Tizen/WebOS packaged-app deployment   |
