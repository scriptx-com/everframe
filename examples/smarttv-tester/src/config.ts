// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Baked by vite `define` (see vite.config.ts). The typeof guard keeps the
// module loadable where define didn't run (vitest).
export const SDK_KEY = typeof __EVERFRAME_SDK_KEY__ !== 'undefined' ? __EVERFRAME_SDK_KEY__ : '';
