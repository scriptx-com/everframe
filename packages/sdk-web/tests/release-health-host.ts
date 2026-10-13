// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// A local browser host; the integration harness supplies an ephemeral test key.
import { init } from '../src/index.js';
const params = new URLSearchParams(location.search);
const sdk = init({ sdkKey: params.get('key')!, appVersion: params.get('version') ?? '12.3.5-12-web',
  debugBuild: params.has('debug'), reporter: { disabled: true } });
Object.assign(window, { healthHost: { sdk, ready: true } });
